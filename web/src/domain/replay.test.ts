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

  it("keeps separate armies when multiple players choose the same corps", () => {
    const duplicate = {
      ...ARMY_A,
      player: "Wolfe",
      units: ["ntw3_inf_line_163_048_3031"],
    };
    const parsed = parseReplay(
      file(
        keyBlock(ARMY_A),
        keyBlock(duplicate),
        nameBlock({ ...ARMY_A, general: "Arthur Wellesley 'Wellington'", names: ARMY_A_NAMES }),
        nameBlock({ ...duplicate, general: "William Wolfe", names: ["¤ 48th (Northamptonshire) Foot [L4]"] }),
      ),
    );

    expect(parsed.armies).toHaveLength(2);
    expect(parsed.armies.map((army) => army.factionKey)).toEqual([ARMY_A.key, ARMY_A.key]);
    expect(parsed.armies.map((army) => army.player)).toEqual(["Tac", "Wolfe"]);
    expect(parsed.armies.map((army) => army.general)).toEqual(["Arthur Wellesley 'Wellington'", "William Wolfe"]);
    expect(parsed.armies.map((army) => army.units.map((unit) => unit.key))).toEqual([ARMY_A.units, duplicate.units]);
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

  it("finds a reserve-cavalry corps, whose key carries an `r` slot instead of `x`", () => {
    // The letter before the slot count is the corps *type*; pinning it to `x`
    // drops every reserve-cavalry corps in the game on the floor.
    const reserve = {
      key: "ntw3_ac_a11_r5_131",
      staff: "ntw3_gen_staff_131_2_0170",
      player: "Djokodal",
      units: ["ntw3_cav_stand_131_023_1703", "ntw3_cav_heavy_131_999_0177"],
      corpsName: "10. Murat / RC",
      flag: "data\\ui\\flags\\f_11a_ac131",
    };
    const parsed = parseReplay(
      file(
        keyBlock(reserve),
        nameBlock({
          ...reserve,
          general: "Joachim Murat 'le Roi Franconi' [C4]",
          names: ["23e dragons 'le Royal-Piémont' [C3]", "Cuirassiers saxons 'von Zastrow' [C1]"],
        }),
      ),
    );
    expect(parsed.armies.map((a) => a.factionKey)).toEqual([reserve.key]);
    expect(parsed.armies[0].corpsName).toBe("10. Murat / RC");
    expect(parsed.armies[0].player).toBe("Djokodal");
    expect(parsed.armies[0].units.map((u) => u.key)).toEqual(reserve.units);
    expect(parsed.warnings).toEqual([]);
  });

  it("finds a custom army, whose key is a bare faction key and matches no pattern", () => {
    // Custom armies (`denmark`, `britain`, `aaa_lordz`…) are keyed by the faction
    // key straight out of the factions table, so a key *pattern* cannot see them
    // and the whole army silently vanishes from the battle.
    const danish = {
      key: "denmark",
      staff: "ntw3_gen_staff_005_1_0539",
      player: "Frederik",
      units: ["ntw3_art_foot_005_003_0450", "ntw3_cav_heavy_005_999_0228"],
      corpsName: "7. Danmark",
      flag: "data\\ui\\flags\\f_cu_denmark",
    };
    const parsed = parseReplay(
      file(
        keyBlock(ARMY_A),
        keyBlock(danish),
        nameBlock({ ...ARMY_A, general: "Arthur Wellesley 'Wellington'", names: ARMY_A_NAMES }),
        nameBlock({
          ...danish,
          general: "Christian von Augustenbrog",
          names: ["3-pund artilleri til fods [F6]", "Holstenske Ryttere 'Dorrien' [C2]"],
        }),
      ),
    );

    expect(parsed.armies.map((a) => a.factionKey)).toEqual([ARMY_A.key, danish.key]);
    const dk = parsed.armies[1];
    expect(dk.player).toBe("Frederik");
    expect(dk.corpsName).toBe("7. Danmark");
    expect(dk.staffKey).toBe(danish.staff);
    expect(dk.general).toBe("Christian von Augustenbrog");
    expect(dk.units.map((u) => u.key)).toEqual(danish.units);
    expect(dk.units[0].regiment).toBe("3-pund artilleri til fods");
    // Neither field is encoded in a custom army's key, so both stay blank rather
    // than being carved out of an arbitrary word.
    expect(dk.side).toBe("");
    expect(dk.corpsId).toBe("");
    expect(parsed.warnings).toEqual([]);
  });

  it("does not mistake the player name for an army key", () => {
    // The player name is the *other* string a unit key follows; what separates it
    // is that a unit key (the commander) comes right before it. Read as a marker,
    // it would split the corps in two and strand its units in a phantom army.
    const parsed = parseReplay(file(keyBlock(ARMY_A)));
    expect(parsed.armies.map((a) => a.factionKey)).toEqual([ARMY_A.key]);
    expect(parsed.armies[0].units.map((u) => u.key)).toEqual(ARMY_A.units);
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

  // Every shape in the game where the key writes as one number what the name
  // splits apart. Swept out of the full roster set, not just one replay:
  // formations raised from several parents, plus Ottoman calibres.
  const COMPOSITES: [key: string, name: string][] = [
    ["ntw3_art_foot_126_014_0310", "1./4. Fußbatterien, 6-Pfünder 'Huet/Ludwig' [F3]"],
    ["ntw3_inf_grena_124_037_0555", "¤ Grenadiere der 3./7. [G3]"],
    ["ntw3_art_horse_131_034_15947", "3e/4e d'artillerie à cheval polonaise de 6 livres [H3]"],
    ["ntw3_inf_grena_118_012_6545", "¤ Grenadiers suisses du 1er/2e [G4]"],
    ["ntw3_inf_grena_119_418_0529", "¤ Grenadiers du 4e/18e [G4]"],
    ["ntw3_art_foot_249_910_15879", "9-ya/10ya peshaya artilleriya, 6-funtov [F3]"],
    ["ntw3_inf_line_057_022_2309", "Lijn infanterie No. 2/2 uit Nassau 'von Normann' [L3]"],
    ["ntw3_art_foot_069_015_0188", "1.5 okka abüs [F2]"], // calibre, not a regiment
  ];

  it.each(COMPOSITES)("accepts the split-number name %s", (key, name) => {
    const army = {
      key: "ntw3_ac_a11_x7_126",
      staff: "ntw3_gen_staff_126_2_0162",
      units: [key],
      corpsName: "5. Macdonald / X.C",
      flag: "data\\ui\\flags\\f_11a_ac126",
    };
    const parsed = parseReplay(
      file(keyBlock(army), nameBlock({ ...army, general: "Jacques MacDonald", names: [name] })),
    );
    expect(alignmentErrors(parsed.armies[0])).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it("does not join two numbers that are merely near each other", () => {
    // The separator admits no whitespace, so "4. Batterie … 6-Pfünder" must not
    // be read as regiment 46 — otherwise the check would accept anything.
    const army = {
      key: "ntw3_ac_a11_x7_122",
      staff: "ntw3_gen_staff_122_2_0162",
      units: ["ntw3_art_foot_122_046_0294", "ntw3_art_foot_122_003_0311"],
      corpsName: "6. Wrede / VI.C",
      flag: "data\\ui\\flags\\f_11a_ac122",
    };
    const parsed = parseReplay(
      file(
        keyBlock(army),
        nameBlock({
          ...army,
          general: "Carl Philipp von Wrede",
          names: ["4. Linien-Batterie, 6-Pfünder 'Berchem/Roys' [F3]", "3. Fußbatterie 'Ziegler' [F4]"],
        }),
      ),
    );
    expect(alignmentErrors(parsed.armies[0])).toHaveLength(1);
  });

  it("keeps the corps' names when a lone name is the only thing it cannot read", () => {
    // One unreadable name is not evidence of a shift — a shift lands *every*
    // later name on the wrong unit — so it must not cost the corps the rest.
    const army = {
      key: "ntw3_ac_b09_x4_163",
      staff: "ntw3_gen_staff_163_8_0195",
      units: ["ntw3_inf_light_163_043_1366", "ntw3_inf_line_163_048_3031", "ntw3_cav_light_163_014_1134"],
      corpsName: "13. Wellesley / Peninsular",
      flag: "data\\ui\\flags\\f_09b_ac163",
    };
    const parsed = parseReplay(
      file(
        keyBlock(army),
        nameBlock({
          ...army,
          general: "Arthur Wellesley 'Wellington'",
          names: [
            "¤ the Monmouthshire Light Foot [L6]", // no "43" anywhere
            "¤ 48th (Northamptonshire) Foot [L4]",
            "14th (the King's) Light Dragoons [C4]",
          ],
        }),
      ),
    );
    expect(alignmentErrors(parsed.armies[0])).toHaveLength(1);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.armies[0].units[1].regiment).toBe("¤ 48th (Northamptonshire) Foot");
  });

  it("still discards when the corps' only checkable unit is the one that mismatches", () => {
    // Nothing left to corroborate against, so the lone mismatch has to be taken
    // at face value.
    const army = {
      key: "ntw3_ac_b09_x4_163",
      staff: "ntw3_gen_staff_163_8_0195",
      units: ["ntw3_inf_light_163_043_1366", "ntw3_inf_line_163_999_3031"],
      corpsName: "13. Wellesley / Peninsular",
      flag: "data\\ui\\flags\\f_09b_ac163",
    };
    const parsed = parseReplay(
      file(
        keyBlock(army),
        nameBlock({
          ...army,
          general: "Arthur Wellesley 'Wellington'",
          names: ["¤ 48th (Northamptonshire) Foot [L4]", "1st Detachments [L4]"],
        }),
      ),
    );
    expect(parsed.warnings).toHaveLength(1);
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
