import type { UnitCard } from "../domain/types";
import { towSourceCorpsIdOf } from "../domain/tow";
import type { BuildState, RosterIndex } from "./build";
import { nextWindowStart, prevWindowStart, recruitOrder, seedForDate, shuffleByDate, windowStart } from "./rotation";

export const LEGACY_TOW_MAX_SOURCE_CORPS = 4;
export const LEGACY_TOW_MAX_COMBAT_GENERALS = 4;

// Verified from nine ordered in-game windows. The primary source-corps ordering
// is still `recruitOrder` (FrontEnd.RecruitableUnits: category, cost), but the
// engine's equal-cost tie-break is not exposed in Lua or the exported DB tables.
// Keep this scoped to source-corps pools with direct calibration data; do not use
// it for AC rotation or as a replacement for the generic recruit order.
const TOW_SOURCE_CORPS_POOL_CALIBRATIONS: Record<string, readonly string[]> = {
  ntw3_tow_a05_x8_001: ["097", "096", "093", "092", "094"],
  ntw3_tow_a06_x8_002: ["099", "106", "246", "105", "104", "102", "100", "103", "101"],
  ntw3_tow_a08_x8_047: ["112", "114", "248", "110", "111", "109", "108"],
  ntw3_tow_a09_x8_021: ["142", "143", "147", "145", "146", "140", "144", "141", "148"],
  ntw3_tow_a12_x8_003: ["138", "135", "136", "133", "137", "132", "134", "139"],
  ntw3_tow_a13_x8_022: ["153", "149", "151", "247", "154", "152", "150"],
  ntw3_tow_a17_x8_054: ["294", "290", "293", "283", "289", "282"],
  ntw3_tow_b04_x8_016: ["072", "073", "070", "074", "069", "071"],
  ntw3_tow_b06_x8_008: ["041", "042", "045", "043", "040"],
  ntw3_tow_b06_x8_009: ["034", "039", "035", "038", "037", "036"],
  ntw3_tow_b08_x8_044: ["049", "050", "047", "051", "046", "048", "053"],
  ntw3_tow_b11_x8_013: ["263", "262", "192", "188", "184", "190", "185", "186", "183", "249"],
  ntw3_tow_b13_x8_050: ["176", "174", "178", "175", "177"],
};

// The shuffle seed ignores year, so one year plus a small cushion covers the
// full repeating schedule. There are 9 windows per local day.
const MAX_TOW_ROLL_SEARCH_WINDOWS = 9 * 367;

function sourceCorpsIdOf(card: Pick<UnitCard, "unitKey" | "towSourceCorpsId">): string | null {
  return card.towSourceCorpsId ?? towSourceCorpsIdOf(card.unitKey);
}

/** Legacy staff-general test from `ntw3ac.lua`: `Men / 2 == 16 or Men / 2 == 61`.
 *  Prefer `generalKind === "staff"` when the normalized domain model has it, but
 *  keep the raw-men fallback so this mirrors source data as closely as possible. */
export function isLegacyTowStaffGeneral(card: Pick<UnitCard, "isGeneral" | "generalKind" | "menRaw">): boolean {
  if (!card.isGeneral) return false;
  if (card.generalKind === "staff") return true;
  return card.menRaw === 32 || card.menRaw === 122;
}

export function isLegacyTowCombatGeneral(card: Pick<UnitCard, "isGeneral" | "generalKind" | "menRaw">): boolean {
  return card.isGeneral && !isLegacyTowStaffGeneral(card);
}

/** Unique source-corps ids, in first-seen order, derived from staff generals.
 *  This is the pre-shuffle pool used by `NTW3AC.ToWFarmycorps`. The game builds it
 *  by walking `FrontEnd.RecruitableUnits` — NOT raw roster order — so the staff
 *  generals must be visited in `recruitOrder` (arm category → ascending cost,
 *  with scoped calibration where the engine tie-break is known only from game
 *  rolls) before deduplicating source ids. Verified against 9 in-game windows
 *  each for Russie-Centre and Espagne; see towRoll.test.ts. */
export function towSourceCorpsPool(cards: readonly UnitCard[]): string[] {
  const ids: string[] = [];
  const staff = cards.filter((card) => isLegacyTowStaffGeneral(card)).sort(recruitOrder);
  for (const card of staff) {
    const id = sourceCorpsIdOf(card);
    if (id && !ids.includes(id)) ids.push(id);
  }
  const factionKey = staff.find((card) => card.factionKey)?.factionKey;
  const calibrated = factionKey ? TOW_SOURCE_CORPS_POOL_CALIBRATIONS[factionKey] : undefined;
  if (calibrated && calibrated.length === ids.length && calibrated.every((id) => ids.includes(id))) {
    return [...calibrated];
  }
  return ids;
}

/** Legacy `NTW3AC.ToWFarmycorps`: if more than four source corps are available,
 *  shuffle with `NTW3.Shuffle` for the current local-time bucket and keep the
 *  first four; otherwise return the full pool unchanged. */
export function rollTowSourceCorpsIds(
  cards: readonly UnitCard[],
  at: Date,
  maxSourceCorps = LEGACY_TOW_MAX_SOURCE_CORPS,
): string[] {
  const ids = towSourceCorpsPool(cards);
  if (ids.length <= maxSourceCorps) return ids;
  return shuffleByDate(ids, at).slice(0, maxSourceCorps);
}

export interface TowGeneralRoll {
  staffKeys: string[];
  combatKeys: string[];
  allKeys: string[];
}

/** Legacy `NTW3AC.ToWFgenerals`: all staff generals are eligible, while combat
 *  generals are eligible only when their key's source-corps id is in the rolled
 *  source-corps list. Staff and combat pools are shuffled independently because
 *  `NTW3.Shuffle` reseeds on every call. */
export function rollTowGeneralKeys(
  cards: readonly UnitCard[],
  sourceCorpsIds: readonly string[],
  at: Date,
  maxCombatGenerals = LEGACY_TOW_MAX_COMBAT_GENERALS,
): TowGeneralRoll {
  const sourceCorps = new Set(sourceCorpsIds);
  const staffPool: UnitCard[] = [];
  const combatPool: UnitCard[] = [];
  for (const card of cards) {
    if (!card.isGeneral) continue;
    if (isLegacyTowStaffGeneral(card)) {
      staffPool.push(card);
      continue;
    }
    const id = sourceCorpsIdOf(card);
    if (id && sourceCorps.has(id)) combatPool.push(card);
  }

  // Shuffle input order is `FrontEnd.RecruitableUnits` order (recruitOrder), not
  // raw roster order — Fisher-Yates output depends on it. Mirrors rotation.ts.
  staffPool.sort(recruitOrder);
  combatPool.sort(recruitOrder);

  const staffKeys = shuffleByDate(staffPool, at).map((card) => card.unitKey);
  const combatKeys = shuffleByDate(combatPool, at)
    .slice(0, Math.min(maxCombatGenerals, combatPool.length))
    .map((card) => card.unitKey);
  return { staffKeys, combatKeys, allKeys: [...staffKeys, ...combatKeys] };
}

export interface TowArmyRoll {
  sourceCorpsIds: string[];
  generalKeys: TowGeneralRoll;
  cards: UnitCard[];
}

/** Convenience wrapper for the full legacy ToW background roll. Non-general
 *  cards are kept when their source-corps id was rolled. General cards are kept
 *  only when `ToWFgenerals` selected them. */
export function rollTowArmy(cards: readonly UnitCard[], at: Date): TowArmyRoll {
  const sourceCorpsIds = rollTowSourceCorpsIds(cards, at);
  const generalKeys = rollTowGeneralKeys(cards, sourceCorpsIds, at);
  const selectedGeneralKeys = new Set(generalKeys.allKeys);
  const selectedSourceCorps = new Set(sourceCorpsIds);
  return {
    sourceCorpsIds,
    generalKeys,
    cards: cards.filter((card) => {
      if (card.isGeneral) return selectedGeneralKeys.has(card.unitKey);
      const id = sourceCorpsIdOf(card);
      return id !== null && selectedSourceCorps.has(id);
    }),
  };
}

export type TowCorpsCombinationMatchMode = "exact" | "contains";

export interface TowCorpsCombinationResult {
  /** True when the current local-time window matches the requested corps combination. */
  activeNow: boolean;
  /** Rolled source-corps ids in the current local-time window. */
  currentSourceCorpsIds: string[];
  /** Deduplicated requested source-corps ids, preserving caller order. */
  targetSourceCorpsIds: string[];
  /** Matching rule used for this search. */
  matchMode: TowCorpsCombinationMatchMode;
  /** Start of the nearest current/future matching window. */
  next: Date | null;
  /** Start of the nearest strictly-past matching window. */
  prev: Date | null;
  /** Whichever of now/next/prev is closest in absolute time. */
  closest: Date | null;
  closestDirection: "now" | "future" | "past" | null;
  /** Rolled source-corps ids at `closest`, or null when no matching window exists. */
  closestSourceCorpsIds: string[] | null;
}

function uniqueIds(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function sourceCorpsCombinationMatches(
  rolledIds: readonly string[],
  targetIds: readonly string[],
  mode: TowCorpsCombinationMatchMode,
): boolean {
  if (targetIds.length === 0) return false;
  const rolled = new Set(rolledIds);
  if (mode === "contains") return targetIds.every((id) => rolled.has(id));
  return rolledIds.length === targetIds.length && targetIds.every((id) => rolled.has(id));
}

interface WindowScan {
  activeNow: boolean;
  next: Date | null;
  prev: Date | null;
  closest: Date | null;
  closestDirection: "now" | "future" | "past" | null;
}

/** Nearest local-time window (past or future) satisfying `matchesAt`, scanning
 *  out from `now`. Shared by every TOW roll finder so the now/next/prev/closest
 *  tie-breaking stays identical to the combat-general rotation predictor. */
function scanNearestWindow(now: Date, matchesAt: (d: Date) => boolean): WindowScan {
  const cur = windowStart(now);
  const activeNow = matchesAt(cur);

  let next: Date | null = null;
  {
    let ws = activeNow ? nextWindowStart(cur) : cur;
    for (let i = 0; i < MAX_TOW_ROLL_SEARCH_WINDOWS; i++) {
      if (matchesAt(ws)) {
        next = ws;
        break;
      }
      ws = nextWindowStart(ws);
    }
  }

  let prev: Date | null = null;
  {
    let ws = prevWindowStart(cur);
    for (let i = 0; i < MAX_TOW_ROLL_SEARCH_WINDOWS; i++) {
      if (matchesAt(ws)) {
        prev = ws;
        break;
      }
      ws = prevWindowStart(ws);
    }
  }

  let closest: Date | null = null;
  let closestDirection: WindowScan["closestDirection"] = null;
  if (activeNow) {
    closest = cur;
    closestDirection = "now";
  } else if (next && prev) {
    const toNext = next.getTime() - now.getTime();
    const fromPrev = now.getTime() - prev.getTime();
    if (toNext <= fromPrev) {
      closest = next;
      closestDirection = "future";
    } else {
      closest = prev;
      closestDirection = "past";
    }
  } else if (next) {
    closest = next;
    closestDirection = "future";
  } else if (prev) {
    closest = prev;
    closestDirection = "past";
  }

  return { activeNow, next, prev, closest, closestDirection };
}

/** Nearest local-time window where the TOW source-corps roll matches a requested
 *  combination. `exact` means the rolled set must equal the requested set
 *  ignoring order; `contains` means every requested id must be present in the
 *  roll, allowing extra rolled corps. */
export function findTowCorpsCombinationTime(
  cards: readonly UnitCard[],
  targetSourceCorpsIds: readonly string[],
  now: Date,
  matchMode: TowCorpsCombinationMatchMode = "exact",
): TowCorpsCombinationResult {
  const target = uniqueIds(targetSourceCorpsIds);
  const memo = new Map<number, string[]>();
  const rolledAt = (d: Date): string[] => {
    const seed = seedForDate(d);
    let rolled = memo.get(seed);
    if (!rolled) {
      rolled = rollTowSourceCorpsIds(cards, d);
      memo.set(seed, rolled);
    }
    return rolled;
  };
  const matchesAt = (d: Date): boolean => sourceCorpsCombinationMatches(rolledAt(d), target, matchMode);

  const scan = scanNearestWindow(now, matchesAt);
  return {
    ...scan,
    currentSourceCorpsIds: rolledAt(windowStart(now)),
    targetSourceCorpsIds: target,
    matchMode,
    closestSourceCorpsIds: scan.closest ? rolledAt(scan.closest) : null,
  };
}

/** Distinct source-corps ids the build's units actually draw from, in first-seen
 *  order. This is the roll a player must land to field the current selection —
 *  independent of whatever is toggled in the Corps roll menu. */
export function towSourceCorpsIdsInBuild(build: BuildState, index: RosterIndex): string[] {
  const ids: string[] = [];
  const add = (key: string | undefined) => {
    const id = key ? index.byKey.get(key)?.towSourceCorpsId ?? null : null;
    if (id && !ids.includes(id)) ids.push(id);
  };
  for (const inst of build.instances) add(inst.unitKey);
  add(build.staffSlotUnitKey ?? undefined);
  return ids;
}

export interface TowCorpsCeiling {
  /** Distinct source-corps ids the build draws from, in first-seen order. */
  order: string[];
  /** Selected copies per source-corps id (staff slot included). */
  counts: Map<string, number>;
  /** The first ≤4 corps — the still-rollable "kept" set. */
  kept: Set<string>;
  /** Number of distinct source corps the selection spans. */
  count: number;
  /** True when the build spans more corps than the game rolls together. */
  over: boolean;
}

/** How the current build sits against the 4-corps roll limit: which corps it draws
 *  from, how many copies from each, and which are within vs. beyond a single roll.
 *  The first four corps seen are the "kept" roll; anything after is over the soft
 *  ceiling. Non-TOW builds simply come back empty (count 0, never over). */
export function towCorpsCeiling(build: BuildState, index: RosterIndex): TowCorpsCeiling {
  const order = towSourceCorpsIdsInBuild(build, index);
  const counts = new Map<string, number>();
  const tally = (key: string | null | undefined) => {
    const id = key ? index.byKey.get(key)?.towSourceCorpsId ?? null : null;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  for (const inst of build.instances) tally(inst.unitKey);
  tally(build.staffSlotUnitKey);
  const kept = new Set(order.slice(0, LEGACY_TOW_MAX_SOURCE_CORPS));
  return { order, counts, kept, count: order.length, over: order.length > LEGACY_TOW_MAX_SOURCE_CORPS };
}

/** True when `card` falls beyond the 4-corps roll: it is already selected in a corps
 *  past the kept four, or it belongs to a new corps that would open a fifth. Cards
 *  with no source corps (non-TOW) are never over. */
export function isCardOverCorpsCeiling(card: UnitCard, ceiling: TowCorpsCeiling): boolean {
  const id = card.towSourceCorpsId;
  if (!id) return false;
  if (ceiling.counts.has(id)) return !ceiling.kept.has(id);
  return ceiling.count >= LEGACY_TOW_MAX_SOURCE_CORPS;
}

/** Distinct combat-general unitKeys the build actually uses, in first-seen order.
 *  Staff generals are excluded: the legacy TOW roll offers every staff general in
 *  every window, so only combat generals constrain which window works. */
export function towCombatGeneralKeysInBuild(build: BuildState, index: RosterIndex): string[] {
  const keys: string[] = [];
  for (const inst of build.instances) {
    const card = index.byKey.get(inst.unitKey);
    if (card && isLegacyTowCombatGeneral(card) && !keys.includes(card.unitKey)) keys.push(card.unitKey);
  }
  return keys;
}

export interface TowBuildRollResult {
  /** True when the current window already offers the whole build (corps + generals). */
  activeNow: boolean;
  /** Deduplicated source-corps ids the build draws from. */
  targetSourceCorpsIds: string[];
  /** Combat-general keys the build uses that must be offered together with the roll. */
  targetCombatGeneralKeys: string[];
  next: Date | null;
  prev: Date | null;
  closest: Date | null;
  closestDirection: "now" | "future" | "past" | null;
  /** Full source-corps roll at `closest` (target corps plus any filler), or null. */
  closestSourceCorpsIds: string[] | null;
  /** Combat generals offered at `closest`, or null when no matching window exists. */
  closestCombatGeneralKeys: string[] | null;
}

/** Nearest local-time window (past or future) whose in-game roll can field the
 *  current build: every source corps the build draws from is rolled (filler
 *  allowed), AND every combat general in the build is among the window's combat
 *  offers. This is what the TOW "Generate times" button reports — it times the
 *  roll and combat general the player actually used, not the Corps roll menu. */
export function findTowBuildRollTime(
  cards: readonly UnitCard[],
  targetSourceCorpsIds: readonly string[],
  targetCombatGeneralKeys: readonly string[],
  now: Date,
): TowBuildRollResult {
  const targetCorps = uniqueIds(targetSourceCorpsIds);
  const targetGenerals = [...new Set(targetCombatGeneralKeys)];
  const rollMemo = new Map<number, string[]>();
  const rolledAt = (d: Date): string[] => {
    const seed = seedForDate(d);
    let rolled = rollMemo.get(seed);
    if (!rolled) {
      rolled = rollTowSourceCorpsIds(cards, d);
      rollMemo.set(seed, rolled);
    }
    return rolled;
  };
  const combatOffersAt = (d: Date): string[] => rollTowGeneralKeys(cards, rolledAt(d), d).combatKeys;
  const matchesAt = (d: Date): boolean => {
    if (!sourceCorpsCombinationMatches(rolledAt(d), targetCorps, "contains")) return false;
    if (targetGenerals.length === 0) return true;
    const offered = new Set(combatOffersAt(d));
    return targetGenerals.every((key) => offered.has(key));
  };

  const scan = scanNearestWindow(now, matchesAt);
  return {
    ...scan,
    targetSourceCorpsIds: targetCorps,
    targetCombatGeneralKeys: targetGenerals,
    closestSourceCorpsIds: scan.closest ? rolledAt(scan.closest) : null,
    closestCombatGeneralKeys: scan.closest ? combatOffersAt(scan.closest) : null,
  };
}
