// Napoleon: Total War (.replay) battle-setup reader.
//
// A replay stores every string as `0x0E <uint16 LE char count> <UTF-16LE chars>`.
// Near the end of the file sits a plain battle-setup block that lists each army
// corps twice: first as ordered unit *keys*, then again as localised display
// *names* in the same order. Those keys are byte-identical to the `unitKey`s in
// the generated faction rosters, so a parsed army maps straight onto a build.
//
// Pure + DOM-free (TextDecoder only) so it runs in the browser, in Electron and
// under vitest. Nothing here trusts the input: a truncated or unrelated file
// yields an empty army list rather than throwing.

const STRING_TAG = 0x0e;

const ARMY_KEY_RE = /^ntw3_(?:ac|tow)_[a-z]\d{2}_x\d+_(\d+)$/;
const FLAG_RE = /^data\\ui\\flags\\/i;
const STAFF_PREFIX = "ntw3_gen_staff_";
const UNIT_PREFIXES = ["ntw3_inf_", "ntw3_cav_", "ntw3_art_", "ntw3_nav_", "ntw3_gen_"];
const CORPS_NAME_RE = /^\d+\.\s/;
/** `Officer Name (Regiment) [C4]` | `Regiment [L4]` — tier tag is always last. */
const DISPLAY_NAME_RE = /^(?:([^()]+?)\s*\((.+)\)|(.+?))\s*\[([A-Z]\d)\]$/;
/** The 3-digit regiment number embedded in a unit key, e.g. …_163_**043**_1366. */
const REGIMENT_NO_RE = /^ntw3_\w+?_\d+_(\d{3})_/;

/** Typographic punctuation that legitimately appears in localised unit names. */
const QUOTES = new Set([0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d]);

export interface ReplayUnit {
  /** Roster unit key — joins directly onto FactionRoster.cards[].unitKey. */
  key: string;
  /** Localised name straight from the replay (blank if it failed the self-check). */
  name: string;
  /** Regiment part of the display name, officer stripped. */
  regiment: string;
  /** Attached combat general, when this copy is a `_com_` variant. */
  officer: string;
  /** Class+tier tag, e.g. L4 / S3 / C4 / F5 / H1 / G2. */
  tier: string;
}

export interface ReplayArmy {
  /** Army-corps key; doubles as the app's factionKey. */
  factionKey: string;
  corpsId: string;
  side: string;
  player: string;
  corpsName: string;
  flag: string;
  staffKey: string | null;
  general: string;
  units: ReplayUnit[];
}

export interface ReplayBattle {
  gameBuild: string;
  map: string;
  victoryCondition: string;
  wind: string;
  armies: ReplayArmy[];
  /** Non-fatal integrity notes (e.g. an army whose names failed the self-check). */
  warnings: string[];
}

/** Reject candidates that decoded as text but are really binary.
 *
 *  A uint32 field (tag 0x03) can contain a 0x0E byte, which looks like a string
 *  tag and starts a UTF-16 read on the wrong byte. Such reads pair a data byte
 *  with an ASCII byte and land in CJK/Hangul/PUA; genuine strings are Latin
 *  (plus Cyrillic/Greek headroom for eastern factions) and mostly plain ASCII. */
function plausible(text: string): boolean {
  let ascii = 0;
  for (let i = 0; i < text.length; i += 1) {
    const o = text.charCodeAt(i);
    if (o >= 0x20 && o <= 0x7e) ascii += 1;
    else if ((o >= 0xa0 && o <= 0x4ff) || QUOTES.has(o)) continue;
    else return false;
  }
  return ascii * 2 >= text.length;
}

/** Every well-formed tagged string in the file, in order. */
export function readStrings(blob: Uint8Array): string[] {
  const decoder = new TextDecoder("utf-16le");
  const out: string[] = [];
  const n = blob.length;
  let i = 0;
  while (i + 3 <= n) {
    if (blob[i] !== STRING_TAG) {
      i += 1;
      continue;
    }
    const count = blob[i + 1] | (blob[i + 2] << 8);
    const end = i + 3 + count * 2;
    if (count === 0 || end > n) {
      i += 1;
      continue;
    }
    const text = decoder.decode(blob.subarray(i + 3, end));
    if (!plausible(text)) {
      i += 1; // step one byte: the real record may start just after a false tag
      continue;
    }
    out.push(text);
    i = end;
  }
  return out;
}

/** `Samuel Hawker (14th Light Dragoons) [C4]` → officer / regiment / tier. */
export function splitDisplayName(name: string): { officer: string; regiment: string; tier: string } {
  const m = DISPLAY_NAME_RE.exec(name.trim());
  if (!m) return { officer: "", regiment: name.trim(), tier: "" };
  const [, officer, inner, plain, tier] = m;
  if (plain !== undefined) return { officer: "", regiment: plain.trim(), tier };
  return { officer: officer.trim(), regiment: inner.trim(), tier };
}

const isUnitKey = (s: string) => UNIT_PREFIXES.some((p) => s.startsWith(p));

/** Split the string stream into (armyKey, block) runs at each army-key marker, so
 *  trailing footer strings can never bleed from one army into the next. */
function blocks(strings: string[]): { key: string; body: string[] }[] {
  const starts: number[] = [];
  strings.forEach((s, i) => {
    if (ARMY_KEY_RE.test(s)) starts.push(i);
  });
  return starts.map((start, n) => ({
    key: strings[start],
    body: strings.slice(start + 1, n + 1 < starts.length ? starts[n + 1] : strings.length),
  }));
}

/** Self-check: the 3-digit regiment number in a unit key must appear in that
 *  unit's display name. Catches any off-by-one in the key↔name pairing. */
export function alignmentErrors(army: ReplayArmy): string[] {
  const bad: string[] = [];
  army.units.forEach((u, i) => {
    const m = REGIMENT_NO_RE.exec(u.key);
    if (!m || m[1] === "999" || !u.name) return; // 999 = un-numbered formation
    const n = m[1].replace(/^0+/, "") || "0";
    if (!new RegExp(`(?<!\\d)${n}(?!\\d)`).test(u.regiment)) {
      bad.push(`#${i + 1} ${u.key} → ${u.regiment}`);
    }
  });
  return bad;
}

export function parseReplay(blob: Uint8Array): ReplayBattle {
  const strings = readStrings(blob);
  const battle: ReplayBattle = {
    gameBuild: "",
    map: "",
    victoryCondition: "",
    wind: "",
    armies: [],
    warnings: [],
  };

  for (const s of strings) {
    if (!battle.gameBuild && s.startsWith("Napoleon: Total War")) battle.gameBuild = s;
    else if (!battle.map && s.startsWith("BattleTerrain/Presets/")) {
      const parts = s.split("/").filter(Boolean);
      battle.map = parts[parts.length - 1] ?? "";
    } else if (!battle.victoryCondition && s.startsWith("BATTLE_SETUP_VICTORY_CONDITION_")) {
      battle.victoryCondition = s;
    } else if (!battle.wind && s.startsWith("wind_level_")) battle.wind = s;
  }

  const byKey = new Map<string, ReplayArmy>();
  for (const { key, body } of blocks(strings)) {
    let army = byKey.get(key);
    if (!army) {
      // --- key block: [staff][player][unit keys…][player][corps name][flag]
      const m = ARMY_KEY_RE.exec(key);
      army = {
        factionKey: key,
        corpsId: m?.[1] ?? "",
        side: key.split("_")[2] ?? "",
        player: "",
        corpsName: "",
        flag: "",
        staffKey: null,
        general: "",
        units: [],
      };
      byKey.set(key, army);
      battle.armies.push(army);
      for (const s of body) {
        if (FLAG_RE.test(s)) {
          army.flag = s;
          break;
        }
        if (s.startsWith(STAFF_PREFIX)) army.staffKey = s;
        else if (isUnitKey(s)) army.units.push({ key: s, name: "", regiment: "", officer: "", tier: "" });
        else if (CORPS_NAME_RE.test(s)) army.corpsName = s;
        else if (!army.player) army.player = s;
      }
      continue;
    }

    // --- name block: [player][flag][general][unit display names…]
    const start = body.findIndex((s) => FLAG_RE.test(s));
    if (start < 0 || start + 1 >= body.length) continue;
    army.general = body[start + 1];
    const names = body.slice(start + 2);
    for (let i = 0; i < army.units.length && i < names.length; i += 1) {
      const parsed = splitDisplayName(names[i]);
      army.units[i] = { key: army.units[i].key, name: names[i], ...parsed };
    }
    // If the pairing failed its self-check, drop the names rather than show a
    // regiment (or worse, an officer) against the wrong unit. Keys stay valid.
    const bad = alignmentErrors(army);
    if (bad.length) {
      battle.warnings.push(
        `${army.corpsName || army.factionKey}: display names discarded (${bad.length} misaligned, e.g. ${bad[0]}).`,
      );
      army.units = army.units.map((u) => ({ key: u.key, name: "", regiment: "", officer: "", tier: "" }));
    }
  }

  return battle;
}
