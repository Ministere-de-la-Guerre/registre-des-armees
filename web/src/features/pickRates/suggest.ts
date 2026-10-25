/** "Suggest units": what the recorded builds closest to yours also took.
 *
 *  Pure and deterministic, no React. Pricing, limits and swap rules all come from
 *  state/build.ts — nothing here re-implements them. Recomputed on every build change
 *  because a card's cost depends on the whole build (a formation discount can turn a
 *  +600 add into a -803 one), see docs/PICK_RATES.md.
 *
 *  Tie-breaking, in one place:
 *   - Neighbours: Jaccard similarity desc, ties by ORIGINAL BUILD ORDER (file order).
 *   - Units: k desc, then corps-wide regiment build count desc, then roster order.
 *   - Generals: actionable (not have, not blocked) first, then `have`, then blocked;
 *     inside each tier k desc, then roster order.
 */
import type { UnitCard } from "../../domain/types";
import { MAX_BUILD_COST } from "../../rules/rules";
import {
  type BuildState,
  type RosterIndex,
  combatGeneralsAgainstCap,
  evaluateAdd,
  generalSwapFor,
  priceBuild,
} from "../../state/build";
import type { CorpsPickRates } from "./types";

export const MIN_BUILDS_FOR_SUGGEST = 15;
export const NEIGHBOURS = 15;
export const MAX_SUGGESTIONS = 8;
/** A candidate must appear in at least this many neighbours. */
const MIN_NEIGHBOURS_WITH = 2;

export type SuggestUnavailable =
  | { kind: "off" }
  | { kind: "out-of-scope" }
  | { kind: "unplayed" }
  | { kind: "thin"; n: number }
  | { kind: "roster-changed" }
  | { kind: "no-builds" };

export interface UnitSuggestion {
  card: UnitCard;
  k: number;
  costDelta: number;
  finalCost: number;
  overBudget: boolean;
  blockedReason: string | null;
  /** costDelta < 0: the add completes a formation and earns more than it costs. */
  completesDiscount: boolean;
}

export type GeneralStatus = "have" | "swap" | "add";

export interface GeneralSuggestion {
  card: UnitCard;
  k: number;
  status: GeneralStatus;
  /** The plain card it leads (for labels). */
  regiment: UnitCard;
  /** Set when status === "swap": the plain copy to swap. */
  swapInstanceId: string | null;
  costDelta: number;
  finalCost: number;
  overBudget: boolean;
  blockedReason: string | null;
}

export interface Suggestions {
  kind: "ok";
  K: number;
  n: number;
  emptyBuild: boolean;
  /** Null on an empty build. */
  sharedPct: number | null;
  units: UnitSuggestion[];
  generals: GeneralSuggestion[];
  combatUsed: number;
  combatCap: number;
  /** The chosen neighbour builds as index arrays into corps.builds.keys. */
  neighbours: number[][];
}

const isCombatGeneral = (c: UnitCard) => c.isGeneral && c.generalKind === "combat";
const isStaffGeneral = (c: UnitCard) => c.isGeneral && c.generalKind === "staff";

/** Stable id for the hypothetical copy we price; never reaches the real build. */
const PROBE_ID = "__suggest_probe__";

export function suggestFor(args: {
  corps: CorpsPickRates | null;
  rosterMatches: boolean;
  index: RosterIndex;
  build: BuildState;
  combatCap: number;
}): Suggestions | SuggestUnavailable {
  const { corps, index, build, combatCap } = args;
  if (!corps) return { kind: "off" };
  if (corps.kind === "out-of-scope") return { kind: "out-of-scope" };
  if (corps.kind === "unplayed") return { kind: "unplayed" };
  if (corps.n < MIN_BUILDS_FOR_SUGGEST) return { kind: "thin", n: corps.n };
  if (!args.rosterMatches) return { kind: "roster-changed" };
  if (!corps.builds || corps.builds.builds.length === 0) return { kind: "no-builds" };

  const { keys, builds } = corps.builds;

  // Regiment set and exact-card set per recorded build. Keys not in the roster are
  // ignored (the roster check above makes that rare, but a key can still be missing).
  const regimentSets: Set<string>[] = [];
  const cardSets: Set<string>[] = [];
  for (const b of builds) {
    const regs = new Set<string>();
    const cards = new Set<string>();
    for (const i of b) {
      const card = index.byKey.get(keys[i]);
      if (!card) continue;
      regs.add(card.capGroupKey);
      cards.add(card.unitKey);
    }
    regimentSets.push(regs);
    cardSets.push(cards);
  }

  // The user's regiment set: instances only (the staff slot is excluded in the data).
  const user = new Set<string>();
  for (const inst of build.instances) {
    const card = index.byKey.get(inst.unitKey);
    if (card) user.add(card.capGroupKey);
  }
  const emptyBuild = user.size === 0;

  const inter = (r: Set<string>) => {
    let c = 0;
    for (const k of user) if (r.has(k)) c++;
    return c;
  };

  // Neighbours: empty build -> every build (corps-wide counts). Otherwise the top K by
  // Jaccard; Array.sort is stable, so equal similarity keeps original build order.
  const order = builds.map((_, i) => i);
  if (!emptyBuild) {
    const sim = regimentSets.map((r) => {
      const x = inter(r);
      const union = user.size + r.size - x;
      return union === 0 ? 0 : x / union;
    });
    order.sort((a, b) => sim[b] - sim[a] || a - b);
  }
  const chosen = emptyBuild ? order : order.slice(0, Math.min(NEIGHBOURS, order.length));
  const K = chosen.length;

  const sharedPct = emptyBuild
    ? null
    : Math.round((100 * chosen.reduce((s, i) => s + inter(regimentSets[i]) / user.size, 0)) / K);

  // k per regiment and per exact card, over the neighbours only.
  const regK = new Map<string, number>();
  const cardK = new Map<string, number>();
  for (const i of chosen) {
    for (const r of regimentSets[i]) regK.set(r, (regK.get(r) ?? 0) + 1);
    for (const c of cardSets[i]) cardK.set(c, (cardK.get(c) ?? 0) + 1);
  }

  const basePrice = priceBuild(index, build).finalCost;
  const priced = (next: BuildState) => {
    const finalCost = priceBuild(index, next).finalCost;
    return { finalCost, costDelta: finalCost - basePrice, overBudget: finalCost > MAX_BUILD_COST };
  };
  const withAdded = (card: UnitCard): BuildState => ({
    ...build,
    instances: [...build.instances, { id: PROBE_ID, unitKey: card.unitKey }],
  });
  const regimentB = (key: string) => (corps.kind === "data" ? corps.regiments[key]?.b ?? 0 : 0);

  // --- Units row -----------------------------------------------------------------
  const units: UnitSuggestion[] = [];
  for (const [regiment, k] of regK) {
    if (k < MIN_NEIGHBOURS_WITH || user.has(regiment)) continue;
    const card = index.byKey.get(regiment);
    if (!card || card.unitKey !== card.capGroupKey || isStaffGeneral(card)) continue;
    const block = evaluateAdd(index, build, card, combatCap);
    const p = priced(withAdded(card));
    units.push({
      card,
      k,
      ...p,
      blockedReason: block?.reason ?? null,
      completesDiscount: p.costDelta < 0,
    });
  }
  units.sort(
    (a, b) =>
      b.k - a.k ||
      regimentB(b.card.capGroupKey) - regimentB(a.card.capGroupKey) ||
      a.card.rosterIndex - b.card.rosterIndex,
  );

  // --- Combat generals row -------------------------------------------------------
  const generals: GeneralSuggestion[] = [];
  for (const [unitKey, k] of cardK) {
    if (k < MIN_NEIGHBOURS_WITH) continue;
    const card = index.byKey.get(unitKey);
    if (!card || !isCombatGeneral(card)) continue;
    const regiment = index.byKey.get(card.capGroupKey) ?? card;

    const held = build.instances.some((i) => i.unitKey === unitKey) || build.staffSlotUnitKey === unitKey;
    if (held) {
      generals.push({
        card, k, status: "have", regiment, swapInstanceId: null,
        costDelta: 0, finalCost: basePrice, overBudget: basePrice > MAX_BUILD_COST, blockedReason: null,
      });
      continue;
    }

    // First plain copy of the regiment, in tray order.
    const plain = build.instances.find((i) => i.unitKey === card.capGroupKey);
    if (plain) {
      const option = generalSwapFor(index, build, plain.id, combatCap)?.generals.find(
        (o) => o.card.unitKey === unitKey,
      );
      // Delta against the current PRICE (discounts included), not option.costDelta,
      // which is face value.
      const finalCost = option?.finalCost ?? basePrice;
      generals.push({
        card, k, status: "swap", regiment, swapInstanceId: plain.id,
        costDelta: finalCost - basePrice, finalCost, overBudget: finalCost > MAX_BUILD_COST,
        blockedReason: option ? option.blockedReason : "This copy can't be swapped to this general.",
      });
      continue;
    }

    const block = evaluateAdd(index, build, card, combatCap);
    generals.push({
      card, k, status: "add", regiment, swapInstanceId: null,
      ...priced(withAdded(card)),
      blockedReason: block?.reason ?? null,
    });
  }
  const tier = (g: GeneralSuggestion) => (g.blockedReason ? 2 : g.status === "have" ? 1 : 0);
  generals.sort((a, b) => tier(a) - tier(b) || b.k - a.k || a.card.rosterIndex - b.card.rosterIndex);

  return {
    kind: "ok",
    K,
    n: corps.n,
    emptyBuild,
    sharedPct,
    units: units.slice(0, MAX_SUGGESTIONS),
    generals: generals.slice(0, MAX_SUGGESTIONS),
    combatUsed: combatGeneralsAgainstCap(index, build),
    combatCap,
    neighbours: chosen.map((i) => builds[i]),
  };
}

export interface ChooserRateRow {
  all: number;
  like: number | null;
}

export interface ChooserRates {
  regB: number;
  /** Neighbours containing the regiment; null when builds aren't available. */
  M: number | null;
  plain: ChooserRateRow;
  generals: Record<string, ChooserRateRow>;
}

/** Per-row numbers for the general chooser of one regiment. Null when there is
 *  nothing honest to say (no data, or the regiment's sample is below `minSample`). */
export function chooserRatesFor(args: {
  corps: CorpsPickRates | null;
  suggestions: Suggestions | SuggestUnavailable;
  index: RosterIndex;
  regimentKey: string;
  minSample: number;
}): ChooserRates | null {
  const { corps, suggestions, index, regimentKey } = args;
  if (!corps || corps.kind !== "data") return null;
  const reg = corps.regiments[regimentKey];
  if (!reg || reg.b < args.minSample) return null;

  const generalKeys = index.roster.cards
    .filter((c) => isCombatGeneral(c) && c.capGroupKey === regimentKey)
    .map((c) => c.unitKey);

  // "All builds": plain = builds with the regiment and no general (b - c).
  const generals: Record<string, ChooserRateRow> = {};
  for (const key of generalKeys) generals[key] = { all: corps.units[key]?.b ?? 0, like: null };
  const rates: ChooserRates = {
    regB: reg.b,
    M: null,
    plain: { all: reg.b - reg.c, like: null },
    generals,
  };

  // "Like yours": over the neighbours that contain the regiment.
  if (suggestions.kind !== "ok" || !corps.builds) return rates;
  const { keys } = corps.builds;
  const generalSet = new Set(generalKeys);
  let M = 0;
  let plainCount = 0;
  const counts: Record<string, number> = Object.fromEntries(generalKeys.map((k) => [k, 0]));
  for (const b of suggestions.neighbours) {
    let has = false;
    let hasGeneral = false;
    for (const i of b) {
      const key = keys[i];
      if (generalSet.has(key)) {
        has = hasGeneral = true;
      } else if (index.byKey.get(key)?.capGroupKey === regimentKey) has = true;
    }
    if (!has) continue;
    M++;
    if (!hasGeneral) plainCount++;
    for (const key of generalKeys) if (b.some((i) => keys[i] === key)) counts[key]++;
  }
  rates.M = M;
  if (M > 0) {
    rates.plain.like = plainCount;
    for (const key of generalKeys) rates.generals[key].like = counts[key];
  }
  return rates;
}
