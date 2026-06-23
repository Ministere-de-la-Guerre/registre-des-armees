// Combat-general rotation predictor.
//
// In game the pool of combat generals a corps may recruit is reshuffled on a
// clock-derived seed (NTW3.Shuffle in ntw3.lua), so the offered set changes
// roughly every three hours. The seed depends only on the *local* calendar day,
// month, and an hour bucket — never the year — so the rotation is deterministic
// and annually periodic. This module reproduces that exactly so we can tell the
// player the nearest local time (past or future) at which a chosen combat
// general is offered.
//
// Replicated pieces (must stay byte-faithful to the game):
//   • seed   = floor(localHour / 2.8) * 10000 + (day * 100 + month)   [os.date %d%m]
//   • PRNG   = Windows CRT rand()/srand() LCG (the game is a Win32 build, so Lua
//              5.1's math.random falls through to MSVC rand, RAND_MAX = 32767)
//   • shuffle= re-seed, 5 warm-up draws, then Fisher-Yates (Lua 1-indexed)
//   • select = split generals into staff (Men/2 ∈ {16,61}, i.e. generalKind
//              "staff") and combat pools, shuffle each independently (Shuffle
//              re-seeds every call), take the first N. For combat that is
//              acSelectionGeneralMaxima(faction).combat.
//
// VERIFIED against 7 distinct in-game windows (corps ntw3_ac_a04_x5_076, 2026-06):
// the engine (MSVC PRNG, ddmm seed, 5 warm-ups, Fisher-Yates, count) was already
// exact; the pool ORDER fed to the shuffle is FrontEnd.RecruitableUnits order =
// sort by arm category (artillery → cavalry → infantry) then ascending cost — see
// `recruitOrder` below and the calibration fixture in rotation.test.ts.

import type { UnitCard } from "../domain/types";
import { acSelectionGeneralMaxima } from "../rules/rules";

const RAND_MAX = 32767;

/** Windows CRT rand()/srand() — the LCG `state = state*214013 + 2531011`,
 *  returning bits 30..16. This is the sequence the game's Lua sees on Win32. */
class MsvcRng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  /** C rand(): integer in [0, 32767]. */
  rand(): number {
    this.state = (Math.imul(this.state, 214013) + 2531011) >>> 0;
    return (this.state >>> 16) & 0x7fff;
  }
  /** Lua 5.1 `math.random(l, u)` over C rand():
   *  r = (rand() % RAND_MAX) / RAND_MAX; floor(r*(u-l+1)) + l. */
  range(l: number, u: number): number {
    const r = (this.rand() % RAND_MAX) / RAND_MAX;
    return Math.floor(r * (u - l + 1)) + l;
  }
}

/** The shuffle seed for a moment in (local) time — mirrors NTW3.Shuffle. */
export function seedForDate(d: Date): number {
  const seed1 = d.getDate() * 100 + (d.getMonth() + 1); // os.date("%d%m")
  const seed2 = Math.floor(d.getHours() / 2.8); // hour bucket
  return seed2 * 10000 + seed1;
}

/** Fisher-Yates exactly as NTW3.Shuffle does it: re-seed from the date, discard
 *  5 warm-up draws, then walk Lua indices #tbl..2 swapping with random(1, i).
 *  Returns a new array; the input is not mutated. */
export function shuffleByDate<T>(arr: readonly T[], d: Date): T[] {
  const out = arr.slice();
  const rng = new MsvcRng(seedForDate(d));
  for (let i = 0; i < 5; i++) rng.range(1, 100);
  for (let i = out.length; i >= 2; i--) {
    const j = rng.range(1, i); // 1..i (Lua 1-indexed)
    const tmp = out[i - 1];
    out[i - 1] = out[j - 1];
    out[j - 1] = tmp;
  }
  return out;
}

/** Broad arm category the engine groups the recruit list by — the part of the
 *  unit class before the first underscore: "artillery" | "cavalry" | "infantry".
 *  Combat generals report their led unit's class via underlyingUnitClass. */
function armCategory(c: UnitCard): string {
  return (c.underlyingUnitClass || c.unitClass || "").split("_")[0];
}

/** The shuffle-input order the game's FrontEnd.RecruitableUnits produces: the
 *  general pool sorted by arm category (artillery → cavalry → infantry, which is
 *  also alphabetical) then by ascending cost. Verified to reproduce 7 distinct
 *  in-game windows for corps ntw3_ac_a04_x5_076 (see rotation.test.ts). rosterIndex
 *  is only a stable tiebreaker for the rare same-category, same-cost pair. */
function recruitOrder(a: UnitCard, b: UnitCard): number {
  const ca = armCategory(a);
  const cb = armCategory(b);
  if (ca !== cb) return ca < cb ? -1 : 1;
  if (a.cost !== b.cost) return a.cost - b.cost;
  return a.rosterIndex - b.rosterIndex;
}

/** Combat generals only, in the game's shuffle-input order. */
export function combatPool(cards: readonly UnitCard[]): UnitCard[] {
  return cards.filter((c) => c.isGeneral && c.generalKind === "combat").sort(recruitOrder);
}

/** Staff generals only, in the game's shuffle-input order (the staff slot's pool). */
export function staffPool(cards: readonly UnitCard[]): UnitCard[] {
  return cards.filter((c) => c.isGeneral && c.generalKind === "staff").sort(recruitOrder);
}

/** Whether a faction uses the rotating army-corps general pool. Only "_ac_"
 *  corps recruit via NTW3AC.ACgenerals; regular factions have a fixed roster. */
export function rotationApplies(factionKey: string): boolean {
  return factionKey.includes("_ac_");
}

/** How many combat generals the corps offers per window (max_gens[2] in the Lua:
 *  combat cap + 2). */
export function combatSelectCount(factionKey: string): number {
  return acSelectionGeneralMaxima(factionKey).combat;
}

/** The unitKeys offered from a pool in the window containing `d`: shuffle the
 *  pool for that window and take the first `count`. The staff and combat pools are
 *  shuffled independently (NTW3.Shuffle re-seeds every call with the same seed). */
export function offeredFrom(pool: readonly UnitCard[], count: number, d: Date): string[] {
  const n = Math.min(count, pool.length);
  return shuffleByDate(pool, d)
    .slice(0, n)
    .map((c) => c.unitKey);
}

/** The combat-general unitKeys offered in the window containing `d`. */
export function offeredCombatKeys(factionKey: string, pool: readonly UnitCard[], d: Date): string[] {
  return offeredFrom(pool, combatSelectCount(factionKey), d);
}

/** The corps's permanent commander — always available regardless of the roll. It
 *  is the corps's namesake: the staff general whose name contains the leader in
 *  the corps title (the part before "/", e.g. "Dokhtourov", "Osterman-Tolstoi",
 *  "Barclay de Tolly"). The dearer generals in those corps (Koutouzov,
 *  Miloradovitch) are the *rotating* picks, so cost must NOT decide this. Corps
 *  named for a formation rather than a person (e.g. "Garde impériale") have no
 *  namesake staff, so fall back to the highest-cost staff (the Emperor). */
export function staffCommanderKey(pool: readonly UnitCard[], corpsName: string): string | null {
  if (pool.length === 0) return null;
  const leader = corpsName.replace(/^\s*\d+\.\s*/, "").split("/")[0].trim();
  if (leader) {
    const named = pool.find((c) => c.name.includes(leader));
    if (named) return named.unitKey;
  }
  let best = pool[0];
  for (const c of pool) {
    if (c.cost > best.cost || (c.cost === best.cost && c.rosterIndex < best.rosterIndex)) best = c;
  }
  return best.unitKey;
}

/** The staff generals offered in the window containing `d`: the permanent
 *  commander (always available) plus one rotating pick from the staff pool
 *  (NTW3 offers staffgen_max = 1 from the shuffle). When the roll picks the
 *  commander himself, only he is shown. Verified against 7 in-game windows for
 *  the Garde impériale (ntw3_ac_a11_x5_130); the namesake-commander rule matches
 *  the Russian corps (Dokhtourov, Osterman-Tolstoi) the user reported. */
export function offeredStaffKeys(pool: readonly UnitCard[], corpsName: string, d: Date): string[] {
  const commander = staffCommanderKey(pool, corpsName);
  if (!commander) return [];
  const picked = offeredFrom(pool, 1, d)[0];
  return picked && picked !== commander ? [commander, picked] : [commander];
}

// --- Window arithmetic --------------------------------------------------------
// A "window" is a maximal run of consecutive local hours that share an hour
// bucket (floor(h/2.8)). Because of the /2.8 the windows are not a clean 3 hours:
// they start at local hours [0, 3, 6, 9, 12, 14, 17, 20, 23].

export const WINDOW_START_HOURS: readonly number[] = (() => {
  const starts: number[] = [];
  let prev = -1;
  for (let h = 0; h < 24; h++) {
    const b = Math.floor(h / 2.8);
    if (b !== prev) {
      starts.push(h);
      prev = b;
    }
  }
  return starts;
})();

/** The window-start hour for a clock hour. */
export function windowStartHour(hour: number): number {
  let s = WINDOW_START_HOURS[0];
  for (const h of WINDOW_START_HOURS) if (h <= hour) s = h;
  return s;
}

/** Start of the window containing `d` (minutes/seconds cleared). */
export function windowStart(d: Date): Date {
  const r = new Date(d);
  r.setHours(windowStartHour(d.getHours()), 0, 0, 0);
  return r;
}

/** Start of the window immediately after `ws` (a window start), rolling the day. */
export function nextWindowStart(ws: Date): Date {
  const idx = WINDOW_START_HOURS.indexOf(ws.getHours());
  const r = new Date(ws);
  if (idx === WINDOW_START_HOURS.length - 1) {
    r.setDate(r.getDate() + 1);
    r.setHours(WINDOW_START_HOURS[0], 0, 0, 0);
  } else {
    r.setHours(WINDOW_START_HOURS[idx + 1], 0, 0, 0);
  }
  return r;
}

/** Start of the window immediately before `ws` (a window start), rolling the day. */
export function prevWindowStart(ws: Date): Date {
  const idx = WINDOW_START_HOURS.indexOf(ws.getHours());
  const r = new Date(ws);
  if (idx <= 0) {
    r.setDate(r.getDate() - 1);
    r.setHours(WINDOW_START_HOURS[WINDOW_START_HOURS.length - 1], 0, 0, 0);
  } else {
    r.setHours(WINDOW_START_HOURS[idx - 1], 0, 0, 0);
  }
  return r;
}

export interface RotationResult {
  /** True when the general is in the build's faction window right now. */
  activeNow: boolean;
  /** Start of the nearest current/future window offering the general. */
  next: Date | null;
  /** Start of the nearest strictly-past window offering the general. */
  prev: Date | null;
  /** Whichever of now/next/prev is closest in absolute time. */
  closest: Date | null;
  closestDirection: "now" | "future" | "past" | null;
}

// Just over a year of windows — the rotation is annually periodic, so a general
// that ever appears appears within this span (and one that never appears is
// correctly reported as unavailable).
const MAX_WINDOWS = 9 * 367;

/** Core scan: nearest window (past or future) in which `targetKey` is in the set
 *  returned by `offered(window)`, searching out from `now`. */
function findRotationWith(
  targetKey: string,
  now: Date,
  offered: (d: Date) => readonly string[],
): RotationResult {
  const memo = new Map<number, Set<string>>();
  const offeredAt = (d: Date): Set<string> => {
    const seed = seedForDate(d);
    let s = memo.get(seed);
    if (!s) {
      s = new Set(offered(d));
      memo.set(seed, s);
    }
    return s;
  };

  const cur = windowStart(now);
  const activeNow = offeredAt(cur).has(targetKey);

  let next: Date | null = null;
  {
    let ws = activeNow ? nextWindowStart(cur) : cur;
    for (let i = 0; i < MAX_WINDOWS; i++) {
      if (offeredAt(ws).has(targetKey)) {
        next = ws;
        break;
      }
      ws = nextWindowStart(ws);
    }
  }

  let prev: Date | null = null;
  {
    let ws = prevWindowStart(cur);
    for (let i = 0; i < MAX_WINDOWS; i++) {
      if (offeredAt(ws).has(targetKey)) {
        prev = ws;
        break;
      }
      ws = prevWindowStart(ws);
    }
  }

  let closest: Date | null = null;
  let closestDirection: RotationResult["closestDirection"] = null;
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

/** Nearest window in which `targetKey` is among the combat generals offered from
 *  `pool` (count = combatSelectCount). */
export function findRotation(
  pool: readonly UnitCard[],
  selectCount: number,
  targetKey: string,
  now: Date,
): RotationResult {
  return findRotationWith(targetKey, now, (d) => offeredFrom(pool, selectCount, d));
}

/** Nearest window in which `targetKey` is among the staff generals offered from
 *  `pool` — the permanent commander (always available) or one rotating pick. */
export function findStaffRotation(
  pool: readonly UnitCard[],
  corpsName: string,
  targetKey: string,
  now: Date,
): RotationResult {
  return findRotationWith(targetKey, now, (d) => offeredStaffKeys(pool, corpsName, d));
}
