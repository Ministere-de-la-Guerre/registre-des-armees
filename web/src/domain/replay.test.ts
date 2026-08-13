import { describe, expect, it } from "vitest";
import { alignmentErrors, parseReplay, readStrings, splitDisplayName } from "./replay";

// --- synthetic replay builder -------------------------------------------------
// Mirrors the real container: every string is `0x0E <uint16 LE chars> <UTF-16LE>`.
// Names below are invented; the *shapes* (key layout, block order, the binary
// traps) are taken from a real Napoleon: Total War replay.

function str(s: string): number[] {
  const out = [0x0e, s.length & 0xff, (s.length >> 8) & 0xff];
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    out.push(c & 0xff, (c >> 8) & 0xff);
  }
  return out;
}

/** A uint32 record (tag 0x03) whose *value* contains a 0x0E byte — the exact
 *  shape that fools a naive scanner into a misaligned UTF-16 read. */
function u32WithFalseTag(): number[] {
  return [0x03, 0x66, 0x0e, 0x12, 0x00];
}

function file(...parts: number[][]): Uint8Array {
  return Uint8Array.from(parts.flat());
}

const HEADER = str("Napoleon: Total War 1.3.0 (Final Release; Build 2081 (Curator))");
const MAP = str("BattleTerrain/Presets/ntw3_spain_01_b/");

/** One army, written the way the game does: keys first, names later. */
function keyBlock(opts: {
  key: string;
  staff: string;
  player?: string;
  units: string[];
  corpsName: string;
  flag: string;
}): number[] {
  return [
    str(opts.key),
    str(opts.staff),
    opts.player ? str(opts.player) : [],
    ...opts.units.map(str),
    opts.player ? str(opts.player) : [],
    str(opts.corpsName),
    str(opts.flag),
  ].flat();
}

function nameBlock(opts: { key: string; player?: string; flag: string; general: string; names: string[] }): number[] {
  return [
    str(opts.key),
    opts.player ? str(opts.player) : [],
    str(opts.flag),
    str(opts.general),
    ...opts.names.map(str),
  ].flat();
}

const ARMY_A = {
  key: "ntw3_ac_b09_x4_163",
  staff: "ntw3_gen_staff_163_8_0195",
  player: "Tac",
  units: [
    "ntw3_inf_light_163_043_1366",
    "ntw3_inf_line_163_048_3031",
    "ntw3_inf_line_163_048_3031", // duplicate copy: must round-trip twice
    "ntw3_cav_light_163_014_1134_com_0585",
  ],
  corpsName: "13. Wellesley / Peninsular",
  flag: "data\\ui\\flags\\f_09b_ac163",
};
const ARMY_A_NAMES = [
  "¤ 43rd (Monmouthshire) Light Foot 'Wolfe's Own' [L6]",
  "¤ 48th (Northamptonshire) Foot 'the Black Cuffs' [L4]",
  "¤ 48th (Northamptonshire) Foot 'the Black Cuffs' [L4]",
  "Samuel Hawker (14th (the King's) Light Dragoons) [C4]",
];

const ARMY_B = {
  key: "ntw3_ac_a09_x6_147",
  staff: "ntw3_gen_staff_147_4_0191",
  player: "Ziwon",
  units: ["ntw3_cav_stand_147_014_1733_com_0825", "ntw3_cav_stand_147_002_1739"],
  corpsName: "7. Joseph / CR",
  flag: "data\\ui\\flags\\f_09a_ac147",
};
const ARMY_B_NAMES = [
  "Joseph Bouvier des Éclaz (14e dragons 'les Sarrasins') [C3]",
  "2e dragons 'le Condé-Dragons' [C3]",
];

/** The whole setup section, including the footer that follows the last army —
 *  the footer must not bleed into that army's unit names. */
function fullReplay(): Uint8Array {
  return file(
    HEADER,
    MAP,
    keyBlock(ARMY_A),
    u32WithFalseTag(),
    keyBlock(ARMY_B),
    str("BATTLE_SETUP_VICTORY_CONDITION_KILL_OR_ROUT_ENEMY"),
    str("wind_level_2"),
    str("ntw3_spain_01_b"),
    str("Tac"),
    str("Ziwon"),
    nameBlock({ ...ARMY_A, general: "Arthur Wellesley 'Wellington'", names: ARMY_A_NAMES }),
    u32WithFalseTag(),
    nameBlock({ ...ARMY_B, general: "Jean-Baptiste Jourdan", names: ARMY_B_NAMES }),
    str("BATTLE_SETUP_VICTORY_CONDITION_KILL_OR_ROUT_ENEMY"),
  );
}

describe("readStrings", () => {
  it("reads length-prefixed UTF-16LE records", () => {
    expect(readStrings(file(str("hello"), str("world")))).toEqual(["hello", "world"]);
  });

  it("keeps Latin-1 accents and the ¤ name glyph intact", () => {
    expect(readStrings(file(str("¤ Caçadores N.° 1")))).toEqual(["¤ Caçadores N.° 1"]);
  });

  it("does not mistake a 0x0E byte inside a uint32 for a string tag", () => {
    // The false tag sits immediately before a real record; a naive scanner reads
    // from the wrong byte and swallows the real one.
    expect(readStrings(file(u32WithFalseTag(), str("50e de ligne 'Vendôme' [L3]")))).toEqual([
      "50e de ligne 'Vendôme' [L3]",
    ]);
  });

  it("ignores a truncated trailing record", () => {
    expect(readStrings(file(str("ok"), [0x0e, 0xff, 0xff, 0x41]))).toEqual(["ok"]);
  });
});

describe("splitDisplayName", () => {
  it("splits an attached officer from the regiment", () => {
    expect(splitDisplayName("Samuel Hawker (14th (the King's) Light Dragoons) [C4]")).toEqual({
      officer: "Samuel Hawker",
      regiment: "14th (the King's) Light Dragoons",
      tier: "C4",
    });
  });

  it("reads a plain regiment with no officer", () => {
    expect(splitDisplayName("1st Detachments [L4]")).toEqual({
      officer: "",
      regiment: "1st Detachments",
      tier: "L4",
    });
  });

  it("passes through a name with no tier tag", () => {
    expect(splitDisplayName("Arthur Wellesley 'Wellington'")).toEqual({
      officer: "",
      regiment: "Arthur Wellesley 'Wellington'",
      tier: "",
    });
  });
});

describe("parseReplay", () => {
  const battle = parseReplay(fullReplay());

  it("reads the battle header", () => {
    expect(battle.gameBuild).toContain("Napoleon: Total War 1.3.0");
    expect(battle.map).toBe("ntw3_spain_01_b");
    expect(battle.victoryCondition).toBe("BATTLE_SETUP_VICTORY_CONDITION_KILL_OR_ROUT_ENEMY");
    expect(battle.wind).toBe("wind_level_2");
  });

  it("finds every army once, in file order", () => {
    expect(battle.armies.map((a) => a.factionKey)).toEqual([ARMY_A.key, ARMY_B.key]);
    expect(battle.warnings).toEqual([]);
  });

  it("keeps the ordered unit keys including duplicate copies", () => {
    expect(battle.armies[0].units.map((u) => u.key)).toEqual(ARMY_A.units);
  });

  it("captures player, corps, staff general and flag", () => {
    const a = battle.armies[0];
    expect(a.player).toBe("Tac");
    expect(a.corpsName).toBe("13. Wellesley / Peninsular");
    expect(a.staffKey).toBe(ARMY_A.staff);
    expect(a.general).toBe("Arthur Wellesley 'Wellington'");
    expect(a.side).toBe("b09");
    expect(a.corpsId).toBe("163");
  });

  it("pairs display names with the right unit and pulls out the officer", () => {
    const cav = battle.armies[0].units[3];
    expect(cav.officer).toBe("Samuel Hawker");
    expect(cav.regiment).toBe("14th (the King's) Light Dragoons");
    expect(cav.tier).toBe("C4");
  });

  it("does not let the footer bleed into the last army's names", () => {
    // ARMY_B is last: without block delimiting, the victory-condition string that
    // follows it lands on a unit and shifts every later name by one.
    const b = battle.armies[1];
    expect(b.general).toBe("Jean-Baptiste Jourdan");
    expect(b.units[0].regiment).toBe("14e dragons 'les Sarrasins'");
    expect(b.units[0].officer).toBe("Joseph Bouvier des Éclaz");
    expect(b.units[1].regiment).toBe("2e dragons 'le Condé-Dragons'");
  });

  it("returns an empty battle for a file that is not a replay", () => {
    const battleOfNothing = parseReplay(Uint8Array.from([1, 2, 3, 4, 5]));
    expect(battleOfNothing.armies).toEqual([]);
  });
});

describe("alignment self-check", () => {
  it("accepts names whose regiment number matches the key", () => {
    expect(alignmentErrors(parseReplay(fullReplay()).armies[0])).toEqual([]);
  });

  it("discards names and warns when the pairing is shifted", () => {
    // Drop the general string from the name block so every name shifts up one.
    const shifted = file(
      HEADER,
      keyBlock(ARMY_A),
      nameBlock({ ...ARMY_A, general: ARMY_A_NAMES[0], names: ARMY_A_NAMES.slice(1) }),
    );
    const parsed = parseReplay(shifted);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain("display names discarded");
    // Keys survive — only the untrustworthy names are dropped.
    expect(parsed.armies[0].units.map((u) => u.key)).toEqual(ARMY_A.units);
    expect(parsed.armies[0].units.every((u) => u.name === "")).toBe(true);
  });

  it("skips the check for un-numbered (999) formations", () => {
    const army = {
      key: "ntw3_ac_b09_x6_170",
      staff: "ntw3_gen_staff_170_1_0203",
      units: ["ntw3_inf_light_170_999_0175"],
      corpsName: "4. Teixeira / Norte",
      flag: "data\\ui\\flags\\f_09b_ac170",
    };
    const parsed = parseReplay(
      file(keyBlock(army), nameBlock({ ...army, general: "Teixeira", names: ["Leal legião Lusitana [L5]"] })),
    );
    expect(parsed.warnings).toEqual([]);
    expect(parsed.armies[0].units[0].regiment).toBe("Leal legião Lusitana");
  });
});
