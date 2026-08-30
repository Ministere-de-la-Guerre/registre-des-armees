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

/** `ntw3_ac_a11_x5_117` / `ntw3_ac_a11_r5_131` — the letter before the slot count
 *  is the corps *type* (`x` line, `r` reserve cavalry), so it must not be pinned.
 *  Matches army-corps and TOW corps only: a *custom army* is keyed by its bare
 *  faction key (`denmark`, `britain`, `aaa_lordz`…), which no pattern can pick
 *  out of a stream of localised text — see `armyKeys`. */
const ARMY_KEY_RE = /^ntw3_(?:ac|tow)_[a-z]\d{2}_[a-z]\d+_(\d+)$/;
const FLAG_RE = /^data\\ui\\flags\\/i;
const UNIT_PREFIXES = ["ntw3_inf_", "ntw3_cav_", "ntw3_art_", "ntw3_nav_", "ntw3_gen_"];
const CORPS_NAME_RE = /^\d+\.\s/;
/** `Officer Name (Regiment) [C4]` | `Regiment [L4]` — tier tag is always last. */
const DISPLAY_NAME_RE = /^(?:([^()]+?)\s*\((.+)\)|(.+?))\s*\[([A-Z]\d)\]$/;
/** The 3-digit regiment number embedded in a unit key, e.g. …_163_**043**_1366. */
const REGIMENT_NO_RE = /^ntw3_\w+?_\d+_(\d{3})_/;
/** Numbers the key writes as one run but the name splits apart, so the name's
 *  own digit runs never spell the key's number. Two kinds occur:
 *    - formations raised from several parents — `1./4.`, `3e/4e`, `1er/2e`,
 *      `9-ya/10ya`, `No. 2/2` — keyed by concatenation (1 and 4 → `014`);
 *    - Ottoman calibres — `1.5 okka` keyed `015`.
 *  Both are digit groups joined by a tight separator: an optional ordinal
 *  suffix or hyphen, then a `.` or `/`. The separator admits no whitespace, so
 *  two merely adjacent numbers ("6-Pfünder 'Berchem/Roys'") never pair up. */
const COMPOSITE_NO_RE = /\d+(?:[a-zA-Z-]{0,3}[./]{1,2}\d+)+/g;

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

/** Every string this file uses as an army marker.
 *
 *  Army-corps and TOW corps announce themselves with a recognisable key, but a
 *  custom army's marker is its bare faction key — `denmark`, `aaa_lordz` — an
 *  ordinary word, so it has to be found by *position* instead: in a key block
 *  the army key is the string immediately before the commander slot. The only
 *  other string a unit key follows is the player name, and that one is itself
 *  preceded by a unit key (the commander), which tells the two apart.
 *
 *  Name blocks hold no unit keys at all, so they are never found this way; they
 *  are picked up by string equality against the keys the key blocks yielded. */
function armyKeys(strings: string[]): Set<string> {
  const keys = new Set<string>();
  strings.forEach((s, i) => {
    if (ARMY_KEY_RE.test(s)) keys.add(s);
    else if (isUnitKey(s) || FLAG_RE.test(s)) return;
    else if (isUnitKey(strings[i + 1] ?? "") && !isUnitKey(strings[i - 1] ?? "")) keys.add(s);
  });
  return keys;
}

/** Split the string stream into (armyKey, block) runs at each army-key marker, so
 *  trailing footer strings can never bleed from one army into the next. */
function blocks(strings: string[]): { key: string; body: string[] }[] {
  const keys = armyKeys(strings);
  const starts: number[] = [];
  strings.forEach((s, i) => {
    if (keys.has(s)) starts.push(i);
  });
  return starts.map((start, n) => ({
    key: strings[start],
    body: strings.slice(start + 1, n + 1 < starts.length ? starts[n + 1] : strings.length),
  }));
}

const unpad = (n: string) => n.replace(/^0+/, "") || "0";

/** The regiment number a unit key claims, or null when it carries none
 *  (999 marks an un-numbered formation). */
function keyRegimentNo(key: string): string | null {
  const m = REGIMENT_NO_RE.exec(key);
  return !m || m[1] === "999" ? null : unpad(m[1]);
}

/** Every regiment number a display name can legitimately be claiming: each of
 *  its digit runs, plus the concatenation behind any `1./4.`-style composite. */
function nameRegimentNos(regiment: string): Set<string> {
  const out = new Set((regiment.match(/\d+/g) ?? []).map(unpad));
  for (const composite of regiment.match(COMPOSITE_NO_RE) ?? []) {
    out.add(unpad((composite.match(/\d+/g) ?? []).join("")));
  }
  return out;
}

/** Self-check: the regiment number in a unit key must appear in that unit's
 *  display name. Catches any off-by-one in the key↔name pairing. */
export function alignmentErrors(army: ReplayArmy): string[] {
  const bad: string[] = [];
  army.units.forEach((u, i) => {
    const n = keyRegimentNo(u.key);
    if (n === null || !u.name) return;
    if (!nameRegimentNos(u.regiment).has(n)) bad.push(`#${i + 1} ${u.key} → ${u.regiment}`);
  });
  return bad;
}

/** Whether the mismatches add up to a genuine shift, which is the only thing
 *  worth throwing a whole corps' names away for. An off-by-one lands *every*
 *  later name on the wrong unit, so it trips many units at once; a single
 *  mismatch is nearly always one name the self-check cannot read rather than a
 *  pairing bug — unless it is the corps' only checkable unit, which leaves
 *  nothing to corroborate it either way. */
export function namesMisaligned(army: ReplayArmy): boolean {
  const bad = alignmentErrors(army);
  if (!bad.length) return false;
  const checkable = army.units.filter((u) => u.name && keyRegimentNo(u.key) !== null).length;
  return bad.length >= 2 || bad.length === checkable;
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

  // A battle may contain the same corps more than once. The setup writes every
  // army's key block first, followed by the matching name blocks, so match each
  // name block to the next unresolved occurrence of its corps key rather than
  // treating factionKey as an army identity.
  const awaitingNames = new Map<string, ReplayArmy[]>();
  for (const { key, body } of blocks(strings)) {
    if (body.some(isUnitKey)) {
      // --- key block: [staff][player][unit keys…][player][corps name][flag]
      const m = ARMY_KEY_RE.exec(key);
      const army: ReplayArmy = {
        factionKey: key,
        corpsId: m?.[1] ?? "",
        // Side and corps id live in the key pattern; a custom army has neither.
        side: m ? (key.split("_")[2] ?? "") : "",
        player: "",
        corpsName: "",
        flag: "",
        staffKey: null,
        general: "",
        units: [],
      };
      battle.armies.push(army);
      const queued = awaitingNames.get(key);
      if (queued) queued.push(army);
      else awaitingNames.set(key, [army]);
      // The FIRST key in the block is the commander slot, whatever key sits in it.
      // The role is positional, not a property of the key: the game lets a player put
      // a *combat* general in command (and then field the corps' own staff general as
      // an ordinary unit), which reading the `ntw3_gen_staff_` prefix would get exactly
      // backwards — reporting the wrong general, or none at all. Both readings agree
      // for the overwhelming majority of armies; only the positional one is correct.
      let commanderTaken = false;
      for (const s of body) {
        if (FLAG_RE.test(s)) {
          army.flag = s;
          break;
        }
        if (isUnitKey(s)) {
          if (!commanderTaken) {
            commanderTaken = true;
            army.staffKey = s;
          } else {
            army.units.push({ key: s, name: "", regiment: "", officer: "", tier: "" });
          }
        } else if (CORPS_NAME_RE.test(s)) army.corpsName = s;
        else if (!army.player) army.player = s;
      }
      continue;
    }

    // --- name block: [player][flag][general][unit display names…]
    const army = awaitingNames.get(key)?.shift();
    if (!army) continue;
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
    if (namesMisaligned(army)) {
      const bad = alignmentErrors(army);
      battle.warnings.push(
        `${army.corpsName || army.factionKey}: display names discarded (${bad.length} misaligned, e.g. ${bad[0]}).`,
      );
      army.units = army.units.map((u) => ({ key: u.key, name: "", regiment: "", officer: "", tier: "" }));
    }
  }

  return battle;
}
