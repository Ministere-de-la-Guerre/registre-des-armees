// "Suggest a team" for the Ordre de Bataille planner: the best armies for a team points
// total. analysis/team_search.py does this offline (analysis/TEAM_BUILDS_REPORT.md); this
// is the same enumeration, pure, so the planner can run it instantly.
//
// A team's points are the sum of its armies' corps numbers N (ntw3.lua Faction_Points /
// Factions_Points_Sums; planSummary.ts corpsPoints). Players agree a total T, so the
// question is which armies make the most value at T. Teams must be legal
// (domain/teamRule.ts): Army Corps from one theatre and side, all distinct; or Theatres of
// War + Custom armies of one side — the Lua does not forbid the same ToW army twice, so
// repeats are an option there.
//
// Each army is worth its best build's value: precomputed per mode at the default
// optimiser settings (CorpsEntry.bestBuildValue, from team_search.py — instant and
// offline), or computed live by the optimiser when the suggestion's settings or the kept
// armies' units constrain the builds (state/teamBuild.ts; the user's choice, 2026-10-10).
// Teams are ranked by total value or by their weakest army, ties broken by the other.
// Values are corps-8 normative gold, comparable within a pool — never across pools,
// which can't meet on one team anyway. The study found an AC corps' value almost
// proportional to N, so at a fixed T the choice of corps matters far more than the split.

import type { CorpsIndex, CorpsEntry, OptimiserMode, ValueMode } from "../domain/types";
import { type TeamKey, type TeamSide, TOW_POOL } from "../domain/teamRule";
import { DEFAULT_OPTIMISE_SETTINGS, type OptimiseSettings } from "./optimiser";
import { corpsPoints } from "./planSummary";
import { isWorkInProgressCorps } from "./acOptimiser";

/** Teams are four armies; three is legal too and is a planned extension (the code takes k). */
export const TEAM_SIZE = 4;

export type TeamCriterion = "total" | "weakest";

/** A pool a team is drawn from: one AC theatre and side, or one side of ToW + Custom. */
export interface TeamPool {
  id: string;
  kind: "ac" | "tow";
  /** TeamKey.pool ("tow" or "campaign:<theatre>"). */
  pool: string;
  side: TeamSide;
  label: string;
  members: CorpsEntry[];
}

/** One army as the enumeration sees it. */
export interface TeamCandidate {
  factionKey: string;
  name: string;
  points: number;
  value: number;
}

export interface SuggestedTeam {
  armies: { candidate: TeamCandidate; fixed: boolean }[];
  points: number;
  total: number;
  weakest: number;
}

/** The value modes a pool's teams can be ranked in: its optimiser value modes ("Formation
 *  discount only" values a build at list price, which isn't comparable across corps). */
export function teamModes(kind: TeamPool["kind"]): ValueMode[] {
  return kind === "ac" ? ["quantity", "sizeBands"] : ["quantity", "quality"];
}

/** Every pool with at least `k` armies that have a precomputed value and a numeric rating
 *  (which leaves out unrated Custom armies and the work-in-progress German Campaign 1813).
 *  ToW + Custom armies of no known side join both sides' pools. */
export function teamPools(index: CorpsIndex | null, keys: ReadonlyMap<string, TeamKey>, k = TEAM_SIZE): TeamPool[] {
  const pools = new Map<string, TeamPool>();
  const add = (key: TeamKey, side: TeamSide, entry: CorpsEntry) => {
    const id = `${key.pool}|${side}`;
    let pool = pools.get(id);
    if (!pool) {
      const sideName = side === "imperial" ? "Imperial" : "Coalition";
      const label = key.pool === TOW_POOL ? `${sideName} · Theatres of War + Custom` : `${sideName} · ${key.pool.slice("campaign:".length)}`;
      pool = { id, kind: key.pool === TOW_POOL ? "tow" : "ac", pool: key.pool, side, label, members: [] };
      pools.set(id, pool);
    }
    pool.members.push(entry);
  };
  for (const side of index?.sides ?? []) {
    for (const theatre of side.theatres) {
      for (const entry of theatre.corps) {
        const key = keys.get(entry.factionKey);
        if (!key || !entry.bestBuildValue || corpsPoints(entry) === null || isWorkInProgressCorps(entry.factionKey)) continue;
        if (key.side) add(key, key.side, entry);
        else (["imperial", "coalition"] as const).forEach((s) => add(key, s, entry));
      }
    }
  }
  return [...pools.values()].filter((p) => p.members.length >= k);
}

/** The pools a team anchored on `anchor` (teamRule.ts teamAnchor of the kept armies) may use. */
export function poolsFor(pools: readonly TeamPool[], anchor: TeamKey | null): TeamPool[] {
  if (!anchor) return [...pools];
  return pools.filter((p) => p.pool === anchor.pool && (anchor.side === null || p.side === anchor.side));
}

/** An army's precomputed value in `mode`, or null. */
export function precomputedValue(entry: CorpsEntry, mode: ValueMode): number | null {
  return entry.bestBuildValue?.[mode] ?? null;
}

/** Whether the precomputed values answer the question, or the builds must be optimised live:
 *  live when the settings differ from those the values were computed with (31 cards, a staff
 *  general, one roll for ToW) or a kept army keeps units of its own (optimise remainder). */
export function needsLiveValues(settings: Pick<OptimiseSettings, "maxCards" | "allowNoStaff" | "singleRoll">,
                                keptArmiesWithUnits: number): boolean {
  return settings.maxCards !== DEFAULT_OPTIMISE_SETTINGS.maxCards
    || settings.allowNoStaff !== DEFAULT_OPTIMISE_SETTINGS.allowNoStaff
    || settings.singleRoll !== DEFAULT_OPTIMISE_SETTINGS.singleRoll
    || keptArmiesWithUnits > 0;
}

export interface SuggestOptions {
  /** Team points total T. */
  total: number;
  k?: number;
  criterion: TeamCriterion;
  /** Armies kept in the team (optimise remainder): they count towards T and the values. */
  fixed?: readonly TeamCandidate[];
  /** Allow the same army more than once (ToW + Custom only; AC armies are always distinct). */
  repeats?: boolean;
  limit?: number;
}

/** Each way to fill the free places with `candidates`, as indices (combinations, or with
 *  repetition), restricted to point sums in `wanted` when given. */
function* combinations(candidates: readonly TeamCandidate[], size: number, repeats: boolean,
                       wanted?: number): Generator<number[]> {
  const pick: number[] = [];
  function* step(start: number, left: number, points: number): Generator<number[]> {
    if (left === 0) {
      if (wanted === undefined || points === wanted) yield [...pick];
      return;
    }
    for (let i = start; i < candidates.length; i++) {
      pick.push(i);
      yield* step(repeats ? i : i + 1, left - 1, points + candidates[i].points);
      pick.pop();
    }
  }
  yield* step(0, size, 0);
}

/** The point totals a team can reach (kept armies included), with how many teams reach each. */
export function reachableTotals(candidates: readonly TeamCandidate[], options: Omit<SuggestOptions, "total" | "criterion">)
  : Map<number, number> {
  const k = options.k ?? TEAM_SIZE;
  const fixed = options.fixed ?? [];
  const free = available(candidates, fixed, !!options.repeats);
  const base = fixed.reduce((s, a) => s + a.points, 0);
  const out = new Map<number, number>();
  if (k - fixed.length < 0) return out;
  for (const pick of combinations(free, k - fixed.length, !!options.repeats)) {
    const t = base + pick.reduce((s, i) => s + free[i].points, 0);
    out.set(t, (out.get(t) ?? 0) + 1);
  }
  return out;
}

/** Candidates still available next to the kept armies: without repeats, a kept army is not offered again. */
function available(candidates: readonly TeamCandidate[], fixed: readonly TeamCandidate[], repeats: boolean): TeamCandidate[] {
  const kept = new Set(fixed.map((a) => a.factionKey));
  return candidates.filter((c) => repeats || !kept.has(c.factionKey));
}

/** The best teams at `total`, best first, plus the reachable totals nearest to it when none
 *  reaches it exactly. */
export function suggestTeams(candidates: readonly TeamCandidate[], options: SuggestOptions)
  : { teams: SuggestedTeam[]; nearestTotals: number[] } {
  const k = options.k ?? TEAM_SIZE;
  const fixed = options.fixed ?? [];
  const repeats = !!options.repeats;
  const free = available(candidates, fixed, repeats);
  const fixedPoints = fixed.reduce((s, a) => s + a.points, 0);
  const teams: SuggestedTeam[] = [];
  if (k - fixed.length >= 0) {
    for (const pick of combinations(free, k - fixed.length, repeats, options.total - fixedPoints)) {
      const armies = [...fixed.map((candidate) => ({ candidate, fixed: true })),
                      ...pick.map((i) => ({ candidate: free[i], fixed: false }))];
      const values = armies.map((a) => a.candidate.value);
      teams.push({ armies, points: options.total, total: values.reduce((s, v) => s + v, 0), weakest: Math.min(...values) });
    }
  }
  const [first, second]: (keyof SuggestedTeam)[] = options.criterion === "total" ? ["total", "weakest"] : ["weakest", "total"];
  teams.sort((a, b) => (b[first] as number) - (a[first] as number) || (b[second] as number) - (a[second] as number)
    || a.armies.map((x) => x.candidate.name).join().localeCompare(b.armies.map((x) => x.candidate.name).join()));
  let nearestTotals: number[] = [];
  if (!teams.length) {
    const reachable = [...reachableTotals(candidates, { k, fixed, repeats }).keys()];
    const below = reachable.filter((t) => t < options.total).sort((a, b) => b - a).slice(0, 1);
    const above = reachable.filter((t) => t > options.total).sort((a, b) => a - b).slice(0, 1);
    nearestTotals = [...below, ...above].sort((a, b) => a - b);
  }
  return { teams: teams.slice(0, options.limit ?? 5), nearestTotals };
}

/** A pool's armies as candidates in `mode`, valued by `valueOf` (precomputed or live); armies
 *  without a value are left out. */
export function candidatesOf(members: readonly CorpsEntry[], valueOf: (entry: CorpsEntry) => number | null): TeamCandidate[] {
  return members.flatMap((entry) => {
    const points = corpsPoints(entry);
    const value = valueOf(entry);
    return points === null || value === null ? [] : [{ factionKey: entry.factionKey, name: entry.name, points, value }];
  });
}

/** The settings a suggested army is built with: the suggestion's, with its value mode. */
export function teamOptimiseSettings(base: Pick<OptimiseSettings, "maxCards" | "allowNoStaff" | "singleRoll">,
                                     mode: OptimiserMode, remainder: boolean): OptimiseSettings {
  return { ...DEFAULT_OPTIMISE_SETTINGS, ...base, mode, remainder, useFilters: false };
}
