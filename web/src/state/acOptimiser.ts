// Army Corps extension of the build optimiser (state/optimiser.ts): formation rebates and
// the recruit-order rule. The same integer programme as analysis/ac_builds.py
// solve_corps(), checked against it by optimiser.parity.test.ts.
//
// An Army Corps earns a rebate for every brigade or division it completes: (n − 1)% of the
// group's full roster price, n = Σ cap over its roster units (ntw3.lua
// AC_DivisionBrigade_Bonus; rules/rules.ts groupDiscount). A full division replaces its
// brigades' rebates; combat generals count towards completion (calculateArmyCost). So the
// programme gets, per group the build may still complete, a 0/1 column g ("completed")
// with Σ x over its cards + kept ≥ n·g, g_brigade + g_division ≤ 1, and the budget row
// credits Σ rebate·g.
//
// The app credits a rebate only for groups completed by cards that were each affordable at
// list price when taken (state/build.ts priceBuild / affordableSubset: a card must fit on
// top of the total so far, crediting only rebates already earned). That rule is in the
// programme too, so its builds can always be ordered:
//   - completed groups are recruited in a fixed order ≺ (compareRebateGroups), a division
//     brigade by brigade (largest brigade rebate first), then the loose cards;
//   - a continuous q per group is the list cost of its new cards when completed:
//     q ≥ Σ cost·x − M(1 − g);
//   - at each group's completing card: staff + Σ_{h≺k}(q_h − rebate_h·g_h) + q_k − credit_k·g_k
//     ≤ funds, where credit_d is what a division's own brigades have earned by its last card
//     (Σ brigade rebates − the smallest). Cards inside a group cost less than that step, and
//     loose cards always fit once the final cost is ≤ 10 000.
// ≺ sorts by rebate − credit, descending: swapping two neighbours a, b with r_a − c_a ≤
// r_b − c_b never raises the higher of their completion steps, because a group's list cost
// is at least its rebate (an exchange argument) — so ≺ is the best order for any set of
// completed groups. analysis/ac_builds.py group_order_key sorts identically; keep them in step.
//
// The one step the rows don't see is a division's inner brigade step when a brigade's rebate
// exceeds the next brigade's list cost. optimiseBuild therefore re-prices every build with
// priceBuild and, if a rebate was not earned, cuts that set of completed groups and solves
// again (analysis/ac_builds.py does the same) — a safety net that should not fire.

import type { UnitCard } from "../domain/types";
import { buildRosterTotals, calculateArmyCost, groupDiscount, MAX_BUILD_COST } from "../rules/rules";
import { type BuildState, type RosterIndex, expandBuild, priceBuild } from "./build";

/** Army Corps factions are the only ones the game gives formation rebates (and the only
 *  `_ac_` keys; CLAUDE.md §4). */
export function isArmyCorpsKey(factionKey: string): boolean {
  return factionKey.includes("_ac_");
}

/** German Campaign 1813 (both sides) is still being built in the mod and holds only
 *  work-in-progress corps (the user, 2026-10-10); it ships no optimiser data
 *  (analysis/ac_builds.py WIP_THEATRES). */
const WIP_AC_THEATRES = new Set(["a16", "b16"]);

export function isWorkInProgressCorps(factionKey: string): boolean {
  return isArmyCorpsKey(factionKey) && WIP_AC_THEATRES.has(factionKey.split("_")[2] ?? "");
}

export interface RebateGroup {
  kind: "division" | "brigade";
  division: number;
  /** Null for a division. */
  brigade: number | null;
  /** Gold the group takes off when it completes — for a division, net of the brigade rebates
   *  the kept build already earns inside it (completing the division replaces them). */
  rebate: number;
  /** Cards the group needs: Σ cap over its roster units. */
  required: number;
  /** Kept cards (remainder mode) already counting towards it. */
  kept: number;
  /** Rebate a division's own brigades have earned when its last card is taken (0 for a brigade). */
  credit: number;
}

/** Whether a card counts towards a group: placed in its division (and brigade, for a brigade).
 *  Combat generals carry their unit's placement and count, as in the Lua. */
export function inGroup(card: UnitCard, group: Pick<RebateGroup, "kind" | "division" | "brigade">): boolean {
  return card.placement !== null && card.placement.division === group.division
    && (group.kind === "division" || card.placement.brigade === group.brigade);
}

/** ≺, the recruit order of completed groups (see the header): rebate − credit descending,
 *  then division before brigade, division id, brigade id. */
export function compareRebateGroups(a: RebateGroup, b: RebateGroup): number {
  return (b.rebate - b.credit) - (a.rebate - a.credit)
    || (a.kind === b.kind ? 0 : a.kind === "division" ? -1 : 1)
    || a.division - b.division
    || (a.brigade ?? 0) - (b.brigade ?? 0);
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** Rebate (> 0) of every brigade, by "division:brigade". */
export function brigadeRebates(roster: readonly UnitCard[], factionKey: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, total] of buildRosterTotals(roster, factionKey).brigades) {
    const rebate = groupDiscount(total);
    if (rebate > 0) out.set(key, rebate);
  }
  return out;
}

/** Every group the optimiser may still complete, in ≺ order. `kept` are the kept build's cards
 *  (staff slot included); `room(card)` is how many more copies of a card the programme may add
 *  (its column's upper bound, 0 without one). Groups the kept build already completes are left
 *  out (their rebate is in its price), and so are groups the remaining room cannot complete. */
export function rebateGroups(roster: readonly UnitCard[], factionKey: string, kept: readonly UnitCard[],
                             room: (card: UnitCard) => number): RebateGroup[] {
  const { divisions, brigades } = buildRosterTotals(roster, factionKey);
  const keptIn = (g: Pick<RebateGroup, "kind" | "division" | "brigade">) => kept.filter((c) => inGroup(c, g)).length;
  const brigadeGroups: RebateGroup[] = [...brigades].map(([key, total]): RebateGroup => {
    const [division, brigade] = key.split(":").map(Number);
    const g: RebateGroup = { kind: "brigade", division, brigade, rebate: groupDiscount(total),
                             required: total.requiredCount, kept: 0, credit: 0 };
    g.kept = keptIn(g);
    return g;
  }).filter((g) => g.rebate > 0);
  const groups: RebateGroup[] = [];
  for (const [division, total] of divisions) {
    const rebate = groupDiscount(total);
    if (rebate <= 0) continue;
    const inside = brigadeGroups.filter((b) => b.division === division);
    const done = inside.filter((b) => b.kept >= b.required);
    const open = inside.filter((b) => b.kept < b.required).map((b) => b.rebate);
    const g: RebateGroup = { kind: "division", division, brigade: null, rebate: rebate - sum(done.map((b) => b.rebate)),
                             required: total.requiredCount, kept: 0,
                             credit: open.length ? sum(open) - Math.min(...open) : 0 };
    g.kept = keptIn(g);
    groups.push(g);
  }
  groups.push(...brigadeGroups);
  return groups
    .filter((g) => g.kept < g.required && g.rebate > 0
      && g.kept + sum(roster.filter((c) => inGroup(c, g)).map(room)) >= g.required)
    .sort(compareRebateGroups);
}

/** The new cards in recruit order: each completed group in ≺ order — a division brigade by
 *  brigade: its cards outside rebate brigades first, then its rebate brigades largest rebate
 *  first — members by descending price; then the loose cards in `looseOrder`. The kept
 *  instances (remainder mode) go before all of these, in the player's order. */
export function orderAcCards(cards: readonly UnitCard[], completed: readonly RebateGroup[],
                             brigadeRebate: ReadonlyMap<string, number>,
                             looseOrder: (a: UnitCard, b: UnitCard) => number): UnitCard[] {
  let pool = [...cards];
  const ordered: UnitCard[] = [];
  for (const g of [...completed].sort(compareRebateGroups)) {
    const members = pool.filter((c) => inGroup(c, g));
    pool = pool.filter((c) => !inGroup(c, g));
    const segment = (c: UnitCard): [number, number, number] => {
      if (g.kind === "brigade" || !c.placement) return [0, 0, 0];
      const rebate = brigadeRebate.get(`${c.placement.division}:${c.placement.brigade}`);
      return rebate ? [1, -rebate, c.placement.brigade] : [0, 0, 0];
    };
    members.sort((a, b) => {
      const sa = segment(a);
      const sb = segment(b);
      return sa[0] - sb[0] || sa[1] - sb[1] || sa[2] - sb[2] || b.cost - a.cost;
    });
    ordered.push(...members);
  }
  return [...ordered, ...pool.sort(looseOrder)];
}

/** Whether the app prices a build as the optimiser claimed: within the funds, and every
 *  rebate of a completed group earned in recruit order (priceBuild = calculateArmyCost). */
export function acBuildEarnsItsRebates(index: RosterIndex, build: BuildState): boolean {
  const price = priceBuild(index, build);
  const full = calculateArmyCost(expandBuild(index, build).cards, index.roster.cards, index.roster.factionKey);
  return price.finalCost <= MAX_BUILD_COST && price.finalCost === full.finalCost;
}
