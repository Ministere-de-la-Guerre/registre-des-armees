// Text and ratios the planner derives from PlanStats: the share bar, the
// speed-tag mixes and the warning text.

import type { CorpsEntry } from "../domain/types";
import type { PlanSlot } from "./plan";
import type { PlanStats, PlanWarning } from "./planStats";

/** "C3 ×2 · C4 ×2": a row's speed tags by letter, then number (the game's own tags, e.g. L1, F3). */
export function speedMix(bySpeed: Readonly<Record<string, number>>): string {
  const num = (tag: string) => Number(tag.replace(/\D+/g, "")) || 0;
  return Object.entries(bySpeed)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.replace(/\d+/g, "").localeCompare(b.replace(/\d+/g, "")) || num(a) - num(b) || a.localeCompare(b))
    .map(([tag, n]) => `${tag} ×${n}`)
    .join(" · ");
}

// Staff is left out on purpose: every army has exactly one staff general, so that
// slice says nothing and would only skew the percentages of the arms that matter.
export const SHARE_ARMS = ["infantry", "cavalry", "artillery"] as const;
export type ShareArm = (typeof SHARE_ARMS)[number];
export const SHARE_LABELS: Record<ShareArm, string> = {
  infantry: "Infantry",
  cavalry: "Cavalry",
  artillery: "Artillery",
};

export interface ShareSegment {
  arm: ShareArm;
  cards: number;
  men: number;
  gold: number;
  /** Whole-number percent of all counted cards / men / gold (0 when nothing is counted). */
  cardsPct: number;
  menPct: number;
  goldPct: number;
}

const pct = (n: number, total: number) => (total > 0 ? Math.round((100 * n) / total) : 0);

export function shareSegments(share: PlanStats["share"]): ShareSegment[] {
  const cards = SHARE_ARMS.reduce((t, a) => t + share[a].cards, 0);
  const men = SHARE_ARMS.reduce((t, a) => t + share[a].men, 0);
  const gold = SHARE_ARMS.reduce((t, a) => t + share[a].gold, 0);
  return SHARE_ARMS.map((arm) => ({
    arm,
    cards: share[arm].cards,
    men: share[arm].men,
    gold: share[arm].gold,
    cardsPct: pct(share[arm].cards, cards),
    menPct: pct(share[arm].men, men),
    goldPct: pct(share[arm].gold, gold),
  }));
}

/** "1 card", "2 cards"; pass `many` for irregular plurals ("battery" → "batteries"). */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Army 2: 340 over budget" — the UI form of a warning. */
export function warningText(w: PlanWarning): string {
  return `Army ${w.slotIndex + 1}: ${w.message}`;
}

export interface PlanPoints {
  total: number;
  /** Points per slot; null for an empty slot or a corps without a numeric rating. */
  byArmy: (number | null)[];
  /** Names of chosen corps that have no rating (custom armies like Lordz), left out of the total. */
  unrated: string[];
}

/** The army's points are its corps rating; the index stores it as a string or a number. */
function ratingOf(entry: CorpsEntry | undefined): number | null {
  const r = entry?.displayRating;
  if (typeof r === "number") return Number.isFinite(r) ? r : null;
  if (typeof r === "string" && r.trim() !== "" && Number.isFinite(Number(r))) return Number(r);
  return null;
}

/** Team points: the sum of the corps ratings of the slots that have a corps chosen. */
export function planPoints(
  slots: readonly Pick<PlanSlot, "build">[],
  entryByKey: ReadonlyMap<string, CorpsEntry>,
): PlanPoints {
  const byArmy: (number | null)[] = [];
  const unrated: string[] = [];
  let total = 0;
  for (const slot of slots) {
    if (!slot.build) {
      byArmy.push(null);
      continue;
    }
    const entry = entryByKey.get(slot.build.factionKey);
    const points = ratingOf(entry);
    byArmy.push(points);
    if (points === null) unrated.push(entry?.name || slot.build.armyCorpsName || slot.build.factionKey);
    else total += points;
  }
  return { total, byArmy, unrated };
}

/** "Army 1: 10 · Army 2: 10 · Army 3: 8": the tooltip's per-army breakdown. Empty slots
 *  are skipped; a corps with no rating shows an en dash. */
export function pointsBreakdown(points: PlanPoints, slots: readonly Pick<PlanSlot, "build">[]): string {
  return points.byArmy
    .map((p, i) => (slots[i]?.build ? `Army ${i + 1}: ${p ?? "–"}` : ""))
    .filter(Boolean)
    .join(" · ");
}

/** The toolbar chip's tooltip: the breakdown, plus a note for corps that have no rating. */
export function pointsTooltip(points: PlanPoints, slots: readonly Pick<PlanSlot, "build">[]): string {
  const { unrated } = points;
  if (unrated.length === 0) return pointsBreakdown(points, slots);
  const note = `${unrated.join(", ")} ${unrated.length === 1 ? "has no rating and isn't" : "have no rating and aren't"} counted.`;
  return `${pointsBreakdown(points, slots)}\n${note}`;
}
