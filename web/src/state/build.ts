// Build state derivation. The build is an ordered list of *explicit instances*
// (one entry per selected copy) so the tray can show and remove each copy
// independently, plus a single staff slot. Pure helpers here turn that into the
// expanded rules-engine card list, pricing, limit results, and add-blocking.

import type { FactionRoster, UnitCard } from "../domain/types";
import {
  type LimitCheck,
  type LimitViolation,
  type PriceResult,
  MAX_BUILD_COST,
  MAX_FOOT_ARTILLERY,
  MAX_HEAVY_CAVALRY,
  MAX_TOTAL_UNIT_CARDS,
  calculateArmyCost,
  checkKnownLimits,
  generalCaps,
  horseArtilleryMax,
} from "../rules/rules";
import { orderBrigadeCards } from "./ordering";

export interface SelectedInstance {
  /** Stable id for this specific selected copy. */
  id: string;
  unitKey: string;
}

export interface BuildState {
  instances: SelectedInstance[];
  /** Unit key of the general assigned to the single staff slot, if any. */
  staffSlotUnitKey: string | null;
}

export const emptyBuild = (): BuildState => ({ instances: [], staffSlotUnitKey: null });

let instanceCounter = 0;
export function makeInstanceId(): string {
  instanceCounter += 1;
  return `i_${Date.now().toString(36)}_${instanceCounter.toString(36)}`;
}

export interface RosterIndex {
  roster: FactionRoster;
  byKey: Map<string, UnitCard>;
}

export function indexRoster(roster: FactionRoster): RosterIndex {
  const byKey = new Map<string, UnitCard>();
  for (const card of roster.cards) byKey.set(card.unitKey, card);
  return { roster, byKey };
}

/** Maximum selectable for a card = its shared cap-group cap (the underlying
 *  unit's cap). 0 means uncapped. */
export function effectiveCap(_index: RosterIndex, card: UnitCard): number {
  return card.groupCap > 0 ? card.groupCap : 0;
}

export function qtyOf(build: BuildState, unitKey: string): number {
  return build.instances.reduce((n, i) => (i.unitKey === unitKey ? n + 1 : n), 0);
}

/** Selected copies sharing a card's cap group (base unit + its combat-general
 *  variants). Used for the shared-cap badge so every member shows the group's
 *  usage, e.g. one base + one combat general both read 2/2. */
export function groupQtyOf(index: RosterIndex, build: BuildState, capGroupKey: string): number {
  return build.instances.reduce((n, i) => {
    const c = index.byKey.get(i.unitKey);
    return c && c.capGroupKey === capGroupKey ? n + 1 : n;
  }, 0);
}

export interface ExpandedBuild {
  cards: UnitCard[];
  staffSlotIndex: number | null;
}

/** Expand the instances (and staff-slot general) into the rules-engine list. */
export function expandBuild(index: RosterIndex, build: BuildState): ExpandedBuild {
  const cards: UnitCard[] = [];
  for (const inst of build.instances) {
    const card = index.byKey.get(inst.unitKey);
    if (card) cards.push(card);
  }
  let staffSlotIndex: number | null = null;
  if (build.staffSlotUnitKey) {
    const card = index.byKey.get(build.staffSlotUnitKey);
    if (card) {
      staffSlotIndex = cards.length;
      cards.push(card);
    }
  }
  return { cards, staffSlotIndex };
}

export function combatCapOf(faction: string): number {
  try {
    return generalCaps(faction).combat;
  } catch {
    return 1;
  }
}

export interface AddBlock {
  reason: string;
}

/** Returns a blocking reason if adding one copy of `card` would break a hard
 *  limit (31 cards, individual/shared caps, category limits, 10,000 cost), or
 *  null when the card may be added. Cost accounts for discount transitions. */
export function evaluateAdd(
  index: RosterIndex,
  build: BuildState,
  card: UnitCard,
  combatCap: number,
): AddBlock | null {
  const { cards, staffSlotIndex } = expandBuild(index, build);

  if (cards.length >= MAX_TOTAL_UNIT_CARDS) {
    return { reason: `Build is full (${MAX_TOTAL_UNIT_CARDS} cards).` };
  }

  const isCombatGeneral = card.isGeneral && card.generalKind === "combat";

  // A build holds at most one staff general, wherever it sits — in the staff slot or
  // recruited as an ordinary unit. (Being commanded by a combat general does not buy a
  // second one.) `cards` includes the staff-slot card, so this covers both placements.
  if (
    card.isGeneral &&
    card.generalKind === "staff" &&
    cards.some((c) => c.isGeneral && c.generalKind === "staff")
  ) {
    return { reason: "Only one staff general allowed in a build." };
  }

  if (
    isCombatGeneral &&
    cards.some((c) => c.isGeneral && c.generalKind === "combat" && c.capGroupKey === card.capGroupKey)
  ) {
    // In game a unit can be led by at most one combat general, even when the
    // unit's own cap (and thus its shared cap group) allows multiple copies.
    return { reason: "Only one combat general allowed for this unit." };
  }

  if (card.groupCap > 0) {
    const inGroup = cards.filter((c) => c.capGroupKey === card.capGroupKey).length;
    if (inGroup >= card.groupCap) {
      return {
        reason: card.isGeneral
          ? "Another variant of this unit is already selected (shared cap)."
          : `Unit cap reached (max ${card.groupCap}).`,
      };
    }
  }

  // Combat generals count against the cap of the unit they lead (e.g. an
  // artillery-led combat general uses an artillery slot), so count by effective class.
  const effectiveClass = (c: UnitCard) =>
    c.isGeneral && c.generalKind === "combat" && c.underlyingUnitClass ? c.underlyingUnitClass : c.unitClass;
  const addedClass = effectiveClass(card);
  const classCount = (cls: string) => cards.filter((c) => effectiveClass(c) === cls).length;
  if (addedClass === "artillery_foot" && classCount("artillery_foot") >= MAX_FOOT_ARTILLERY) {
    return { reason: `Foot-artillery limit (${MAX_FOOT_ARTILLERY}) reached.` };
  }
  if (addedClass === "artillery_horse") {
    // Cavalry-only corps may take two horse batteries instead of one.
    const horseMax = horseArtilleryMax(index.roster.cards, index.roster.factionKey);
    if (classCount("artillery_horse") >= horseMax) {
      return { reason: `Horse-artillery limit (${horseMax}) reached.` };
    }
  }
  if (addedClass === "cavalry_heavy" && classCount("cavalry_heavy") >= MAX_HEAVY_CAVALRY) {
    return { reason: `Heavy-cavalry limit (${MAX_HEAVY_CAVALRY}) reached.` };
  }

  if (isCombatGeneral) {
    const againstCap = cards.filter(
      (c, i) => i !== staffSlotIndex && c.isGeneral && c.generalKind === "combat",
    ).length;
    if (againstCap >= combatCap) {
      return { reason: `Combat-general limit (${combatCap}) reached.` };
    }
  }

  // The 10,000 cost ceiling is intentionally NOT a hard block: a build may exceed
  // it. The grid instead warns by colouring a unit's cost red when adding it would
  // push the total past the ceiling (see addWouldExceedBudget).
  return null;
}

/** True when adding one copy of `card` would push the build's final cost past the
 *  10,000 ceiling. Selection is still allowed (the ceiling is soft); the grid uses
 *  this to colour the unit's cost (and portrait) red as a warning. It asks exactly
 *  the question the affordability replay (see priceBuild) will ask of the new copy,
 *  which joins the end of the recruit order: its full face-value price on top of the
 *  discounted total of the cards that were themselves affordable. So a card is red
 *  precisely when it would be excluded from earning a discount — never red yet
 *  credited, nor clear yet refused. */
export function addWouldExceedBudget(index: RosterIndex, build: BuildState, card: UnitCard): boolean {
  return affordableRunningCost(index, build) + card.cost > MAX_BUILD_COST;
}

/** The build with `unitKey` in the staff slot. Copies of the same card recruited as
 *  units are folded into the slot (a card can't both command and fight in the line);
 *  whoever held the slot before leaves the build. */
export function withCommander(build: BuildState, unitKey: string): BuildState {
  return {
    ...build,
    instances: build.instances.filter((i) => i.unitKey !== unitKey),
    staffSlotUnitKey: unitKey,
  };
}

/** Limit check for a build, or the data error that prevented one. */
function checkBuildLimits(index: RosterIndex, build: BuildState): LimitCheck {
  const { cards, staffSlotIndex } = expandBuild(index, build);
  return checkKnownLimits(cards, index.roster.factionKey, {
    staffSlotIndex,
    recruitable: index.roster.cards,
  });
}

/** A one-line blocking reason for a limit a change would break, phrased like the
 *  evaluateAdd reasons so both routes read the same. */
function limitReason(v: LimitViolation, index: RosterIndex): string {
  switch (v.rule) {
    case "total_cards":
      return `Build is full (${v.maximum} cards).`;
    case "staff_generals":
      return "Only one staff general allowed in a build.";
    case "artillery_foot":
      return `Foot-artillery limit (${v.maximum}) reached.`;
    case "artillery_horse":
      return `Horse-artillery limit (${v.maximum}) reached.`;
    case "cavalry_heavy":
      return `Heavy-cavalry limit (${v.maximum}) reached.`;
    case "combat_generals_against_cap":
      return `Combat-general limit (${v.maximum}) reached.`;
  }
  if (v.rule.startsWith("unit_cap:")) return "Another variant of this unit is already selected (shared cap).";
  if (v.rule.startsWith("combat_general_max:")) return "Only one combat general allowed for this unit.";
  return describeViolation(v.rule, v.actual, v.maximum, index);
}

/** Returns a blocking reason if putting `card` in the staff slot would break a hard
 *  limit, or null when it may command. The counterpart of {@link evaluateAdd} for the
 *  "Set commander" route, judged on the build that would result (see withCommander):
 *  the commander is a card like any other — it counts toward the 31, its unit's
 *  shared cap, the one-general-per-unit rule and the artillery/cavalry class caps (a
 *  combat general by the unit it leads), and there is never a second staff general.
 *  Only the combat-general cap exempts it. Clearing the slot is always allowed.
 *
 *  Only limits the change newly breaks (or worsens) block it, so an imported build
 *  that is already over some other limit can still change its commander. */
export function evaluateSetCommander(index: RosterIndex, build: BuildState, card: UnitCard): AddBlock | null {
  if (build.staffSlotUnitKey === card.unitKey) return null;
  if (!card.isGeneral) return { reason: "Only a general can command the corps." };
  let after: LimitCheck;
  try {
    after = checkBuildLimits(index, withCommander(build, card.unitKey));
  } catch (e) {
    return { reason: e instanceof Error ? e.message : String(e) };
  }
  let before: LimitViolation[] = [];
  try {
    before = checkBuildLimits(index, build).violations;
  } catch {
    // The current build can't be checked at all; judge the result on its own.
  }
  const worsened = after.violations.find((v) => {
    const prior = before.find((p) => p.rule === v.rule);
    return !prior || v.actual > prior.actual;
  });
  return worsened ? { reason: limitReason(worsened, index) } : null;
}

export type StaffGeneralAction = "set-commander" | "recruit";

/** What a left-click on a staff general in the grid actually does, given who holds the
 *  staff slot right now:
 *
 *    - slot empty, or holding this same card -> set / unset the commander;
 *    - another STAFF general commands        -> swap the commander;
 *    - a COMBAT general commands             -> recruit this staff general as a unit
 *      (the game allows one staff general anywhere in the build).
 *
 *  Exported so the click handler and the affordability warning cannot answer different
 *  questions about the same click — colouring a card red for "you could not afford to
 *  make him commander" while the click would merely recruit him is exactly that bug.
 */
export function staffGeneralAction(
  index: RosterIndex,
  build: BuildState,
  card: UnitCard,
): StaffGeneralAction {
  const slotKey = build.staffSlotUnitKey;
  if (!slotKey || slotKey === card.unitKey) return "set-commander";
  const occupant = index.byKey.get(slotKey);
  if (occupant?.isGeneral && occupant.generalKind === "staff") return "set-commander";
  return "recruit";
}

/** True when assigning `card` to the staff slot would push the final cost past the
 *  ceiling (soft — used only to colour the cost red, never to block). */
export function staffSetWouldExceedBudget(index: RosterIndex, build: BuildState, card: UnitCard): boolean {
  if (build.staffSlotUnitKey === card.unitKey) return false;
  return priceBuild(index, withCommander(build, card.unitKey)).finalCost > MAX_BUILD_COST;
}

/** The selected cards (in selection order) that are *affordable* — i.e. each one
 *  did not push the running discounted total past the 10,000 ceiling when it was
 *  added. Over-budget units (now selectable, since the ceiling is soft) are paid
 *  for but excluded here so they cannot complete a brigade/division for a discount.
 *
 *  The check credits discounts already earned from groups completed *before* the
 *  current card, but NOT a discount the card itself would trigger — exactly the
 *  recruitment rule of the game: you must be able to afford a unit at its face-value
 *  price on top of your current discounted total when you take it. It is therefore
 *  order-sensitive, so the replay walks the cards in the order they were committed:
 *  the commander first (it anchors the army), then each unit in the order it was added. */
function affordableSubset(index: RosterIndex, cards: readonly UnitCard[]): UnitCard[] {
  const affordable: UnitCard[] = [];
  for (const card of cards) {
    const currentFinal = calculateArmyCost(affordable, index.roster.cards, index.roster.factionKey).finalCost;
    if (currentFinal + card.cost <= MAX_BUILD_COST) affordable.push(card);
  }
  return affordable;
}

/** Selected cards in recruit order for the affordability replay: commander first,
 *  then each unit instance in the order it was added. */
function recruitOrder(index: RosterIndex, build: BuildState): UnitCard[] {
  const order: UnitCard[] = [];
  if (build.staffSlotUnitKey) {
    const staff = index.byKey.get(build.staffSlotUnitKey);
    if (staff) order.push(staff);
  }
  for (const inst of build.instances) {
    const card = index.byKey.get(inst.unitKey);
    if (card) order.push(card);
  }
  return order;
}

/** Discounted total of just the affordable cards — the running total the next
 *  recruit is judged against in the affordability replay. */
function affordableRunningCost(index: RosterIndex, build: BuildState): number {
  const affordable = affordableSubset(index, recruitOrder(index, build));
  return calculateArmyCost(affordable, index.roster.cards, index.roster.factionKey).finalCost;
}

/** Price a build with the soft-ceiling rule: you pay the full base cost of every
 *  selected card, but brigade/division discounts are only credited for groups that
 *  the *affordable* cards complete. A group you only finished by force-adding
 *  over-budget units earns no discount. With nothing over budget this is identical
 *  to {@link calculateArmyCost}. */
export function priceBuild(index: RosterIndex, build: BuildState): PriceResult {
  const { cards } = expandBuild(index, build);
  const faction = index.roster.factionKey;
  const full = calculateArmyCost(cards, index.roster.cards, faction);
  const affordable = affordableSubset(index, recruitOrder(index, build));
  if (affordable.length === cards.length) return full;
  const earned = calculateArmyCost(affordable, index.roster.cards, faction);
  return {
    ...full,
    normalDiscount: earned.normalDiscount,
    appliedDiscount: earned.appliedDiscount,
    finalCost: full.baseCost - earned.appliedDiscount,
    completedGroups: earned.completedGroups,
  };
}

/** Combat generals already counted against the cap (i.e. not the staff-slot one). */
export function combatGeneralsAgainstCap(index: RosterIndex, build: BuildState): number {
  const { cards, staffSlotIndex } = expandBuild(index, build);
  return cards.filter(
    (c, i) => i !== staffSlotIndex && c.isGeneral && c.generalKind === "combat",
  ).length;
}

export interface AutoGeneralReplacement {
  /** Selected instance (a plain unit copy) to swap out. */
  instanceId: string;
  /** Combat-general variant of that same unit to put in its place. */
  generalUnitKey: string;
}

export interface AutoGeneralsResult {
  replacements: AutoGeneralReplacement[];
}

/** Auto-assign combat generals to units already in the build by *replacing* a
 *  selected plain copy with a combat-general variant of the same unit — it never
 *  adds new units. Existing combat generals are left untouched.
 *
 *  A swap is rules-safe by construction: the general shares the unit's cap group and
 *  underlying class and replaces one copy, so the card count, shared cap, and
 *  artillery/cavalry class caps are all unchanged; it only spends one combat-general
 *  slot. A combat general may cost *less or more* than the plain copy it replaces, and
 *  a cheaper one lowers the running total — which can pull a formation-completing copy
 *  back within face-value budget and so unlock that formation's (often large) discount.
 *
 *  The goal is therefore the *cheapest* build. Because the affordability replay is
 *  order-sensitive (and not monotonic — a copy made affordable adds to the running
 *  total a later, bigger formation needed), *which* copy of a unit takes the general
 *  and *which* of its generals matter, and slot-by-slot greedy choices can be hundreds
 *  of gold off. So every copy of every eligible unit is a candidate, with every general
 *  that leads it, and when the combinations fit {@link AUTO_GENERALS_EXACT_LIMIT} they
 *  are all priced and the cheapest taken; only beyond that does it fall back to greedy
 *  (commit the swap that most lowers the cost, one slot at a time). Either way a swap
 *  set must *strictly* lower the final cost, ties go to fewer generals, and it may take
 *  fewer than the cap allows — spending a slot for no gain is never done. Units that
 *  already carry a combat general are skipped (a unit may have only one). */
export function autoPickCombatGenerals(
  index: RosterIndex,
  build: BuildState,
  combatCap: number,
): AutoGeneralsResult {
  const remaining = combatCap - combatGeneralsAgainstCap(index, build);
  if (remaining <= 0) return { replacements: [] };

  // Cap groups that already carry a combat general (including the staff-slot one).
  const groupsWithGeneral = new Set<string>();
  for (const c of expandBuild(index, build).cards) {
    if (c.isGeneral && c.generalKind === "combat") groupsWithGeneral.add(c.capGroupKey);
  }

  // Every combat-general variant of each unit (cap group), cheapest first.
  const generalsOf = new Map<string, UnitCard[]>();
  for (const c of index.roster.cards) {
    if (!(c.isGeneral && c.generalKind === "combat")) continue;
    const list = generalsOf.get(c.capGroupKey);
    if (list) list.push(c);
    else generalsOf.set(c.capGroupKey, [c]);
  }
  for (const list of generalsOf.values()) {
    list.sort((a, b) => a.cost - b.cost || a.unitKey.localeCompare(b.unitKey));
  }

  // Candidate swaps, bucketed by unit (a unit takes at most one general): every
  // selected plain copy of an eligible unit, paired with each general leading it.
  interface Candidate {
    instanceId: string;
    general: UnitCard;
    delta: number;
  }
  const buckets = new Map<string, Candidate[]>();
  for (const inst of build.instances) {
    const base = index.byKey.get(inst.unitKey);
    if (!base || base.isGeneral || groupsWithGeneral.has(base.capGroupKey)) continue;
    const generals = generalsOf.get(base.capGroupKey);
    if (!generals) continue;
    const bucket = buckets.get(base.capGroupKey) ?? [];
    for (const general of generals) {
      bucket.push({ instanceId: inst.id, general, delta: general.cost - base.cost });
    }
    buckets.set(base.capGroupKey, bucket);
  }
  const groups = [...buckets.values()];

  const applySwaps = (swaps: readonly Candidate[]): BuildState => {
    const to = new Map(swaps.map((c) => [c.instanceId, c.general.unitKey]));
    return {
      ...build,
      instances: build.instances.map((i) => (to.has(i.id) ? { id: i.id, unitKey: to.get(i.id)! } : i)),
    };
  };
  const finalOf = (swaps: readonly Candidate[]) => priceBuild(index, applySwaps(swaps)).finalCost;
  const toResult = (swaps: readonly Candidate[]): AutoGeneralsResult => ({
    replacements: swaps.map((c) => ({ instanceId: c.instanceId, generalUnitKey: c.general.unitKey })),
  });

  const baseFinal = priceBuild(index, build).finalCost;
  const maxSwaps = Math.min(remaining, groups.length);

  if (countSwapSets(groups.map((g) => g.length), maxSwaps, AUTO_GENERALS_EXACT_LIMIT) <= AUTO_GENERALS_EXACT_LIMIT) {
    // Exact: price every set of at most `maxSwaps` swaps (one per unit). Enumeration
    // runs in build order, cheapest general first, so among equally cheap sets with
    // the same number of generals the first found — the earliest copies, the cheapest
    // generals — is kept.
    let best: { final: number; swaps: Candidate[] } = { final: baseFinal, swaps: [] };
    const picked: Candidate[] = [];
    const search = (from: number) => {
      if (picked.length === maxSwaps) return;
      for (let g = from; g < groups.length; g++) {
        for (const cand of groups[g]) {
          picked.push(cand);
          const final = finalOf(picked);
          if (final < best.final || (final === best.final && picked.length < best.swaps.length)) {
            best = { final, swaps: [...picked] };
          }
          search(g + 1);
          picked.pop();
        }
      }
    };
    search(0);
    return toResult(best.swaps);
  }

  // Greedy fallback: commit, one slot at a time, the swap that most lowers the cost.
  const chosen: Candidate[] = [];
  let workingFinal = baseFinal;
  const open = [...groups];
  for (let slot = 0; slot < remaining && open.length > 0; slot++) {
    let best: { group: number; cand: Candidate; final: number } | null = null;
    for (let g = 0; g < open.length; g++) {
      for (const cand of open[g]) {
        const final = finalOf([...chosen, cand]);
        if (final >= workingFinal) continue; // only a strict saving earns a slot
        const better =
          !best ||
          final < best.final ||
          (final === best.final && cand.delta < best.cand.delta) ||
          (final === best.final &&
            cand.delta === best.cand.delta &&
            cand.general.unitKey.localeCompare(best.cand.general.unitKey) < 0);
        if (better) best = { group: g, cand, final };
      }
    }
    if (!best) break; // no remaining swap lowers the cost; stop short of the cap
    chosen.push(best.cand);
    open.splice(best.group, 1);
    workingFinal = best.final;
  }
  return toResult(chosen);
}

/** Largest number of swap sets autoPickCombatGenerals prices exhaustively. Each set
 *  is one priceBuild; beyond this it falls back to greedy. */
export const AUTO_GENERALS_EXACT_LIMIT = 2500;

/** How many ways to pick at most `maxPicks` of the groups and one of each picked
 *  group's options (the empty pick excluded), stopping early once past `limit`. */
function countSwapSets(sizes: readonly number[], maxPicks: number, limit: number): number {
  // ways[k] = sets of exactly k picks among the groups seen so far.
  const ways = new Array<number>(maxPicks + 1).fill(0);
  ways[0] = 1;
  for (const size of sizes) {
    for (let k = maxPicks; k >= 1; k--) ways[k] = Math.min(limit + 1, ways[k] + ways[k - 1] * size);
  }
  return ways.slice(1).reduce((sum, n) => Math.min(limit + 1, sum + n), 0);
}

/** Replace the unit held by one selected copy, keeping its slot (and id) in place.
 *  Used by the per-unit combat-general swap: a plain copy becomes the combat-general
 *  variant of the same unit, or a general reverts to the plain unit it leads. */
export function swapInstanceUnit(build: BuildState, instanceId: string, unitKey: string): BuildState {
  return {
    ...build,
    instances: build.instances.map((i) => (i.id === instanceId ? { id: i.id, unitKey } : i)),
  };
}

/** The cap groups (unit keys) the roster offers at least one combat general for.
 *  A selected copy of such a unit can be swapped for the general that leads it. */
export function unitsWithCombatGenerals(index: RosterIndex): Set<string> {
  const groups = new Set<string>();
  for (const c of index.roster.cards) {
    if (c.isGeneral && c.generalKind === "combat") groups.add(c.capGroupKey);
  }
  return groups;
}

export interface SwapOption {
  card: UnitCard;
  /** This option is the unit the copy currently holds. */
  current: boolean;
  /** Cost change against the copy's current card. */
  costDelta: number;
  /** The build's final cost once swapped. */
  finalCost: number;
  /** Swapping would push the build past the 10,000 ceiling (soft — never blocks). */
  overBudget: boolean;
  /** Why the swap is not allowed, or null when it is. */
  blockedReason: string | null;
}

export interface GeneralSwap {
  instanceId: string;
  /** The card the copy currently holds (plain unit or one of its combat generals). */
  current: UnitCard;
  /** The plain unit option (revert). Null when the roster has no base card for it. */
  plain: SwapOption | null;
  /** Every combat general that leads this unit, cheapest first. */
  generals: SwapOption[];
}

/** Score one candidate card for a copy's slot. A swap inside a cap group never
 *  changes the card count, the shared cap, or the artillery/cavalry class caps (the
 *  general reports its led unit's class), so only the two general rules can block it:
 *  a unit may be led by one combat general, and the corps has a combat-general cap. */
function swapOption(
  index: RosterIndex,
  build: BuildState,
  instanceId: string,
  from: UnitCard,
  to: UnitCard,
  combatCap: number,
): SwapOption {
  const next = swapInstanceUnit(build, instanceId, to.unitKey);
  const { cards, staffSlotIndex } = expandBuild(index, next);
  const isCombat = (c: UnitCard) => c.isGeneral && c.generalKind === "combat";
  const inGroup = cards.filter((c) => isCombat(c) && c.capGroupKey === to.capGroupKey).length;
  const againstCap = cards.filter((c, i) => i !== staffSlotIndex && isCombat(c)).length;
  let blockedReason: string | null = null;
  if (inGroup > 1) blockedReason = "Another copy of this unit already has a combat general.";
  else if (againstCap > combatCap) blockedReason = `Combat-general limit (${combatCap}) reached.`;
  const finalCost = priceBuild(index, next).finalCost;
  return {
    card: to,
    current: to.unitKey === from.unitKey,
    costDelta: to.cost - from.cost,
    finalCost,
    overBudget: finalCost > MAX_BUILD_COST,
    blockedReason,
  };
}

/** The combat generals a selected copy can be swapped to (plus the plain unit it can
 *  revert to), each priced and rule-checked against the current build. Null when the
 *  copy isn't in the build or its unit has no combat general in the roster — i.e.
 *  exactly when the tray should offer no swap control. */
export function generalSwapFor(
  index: RosterIndex,
  build: BuildState,
  instanceId: string,
  combatCap: number,
): GeneralSwap | null {
  const inst = build.instances.find((i) => i.id === instanceId);
  const current = inst ? index.byKey.get(inst.unitKey) : undefined;
  if (!current) return null;

  const generals = index.roster.cards
    .filter((c) => c.isGeneral && c.generalKind === "combat" && c.capGroupKey === current.capGroupKey)
    .sort((a, b) => a.cost - b.cost || a.rosterIndex - b.rosterIndex)
    .map((g) => swapOption(index, build, instanceId, current, g, combatCap));
  if (generals.length === 0) return null;

  const base = index.byKey.get(current.capGroupKey);
  return {
    instanceId,
    current,
    plain: base ? swapOption(index, build, instanceId, current, base, combatCap) : null,
    generals,
  };
}

/** True when the build has at least one combat general occupying a unit slot (an
 *  instance, not the commander). Drives the "reset generals" control. */
export function hasCombatGeneralInstances(index: RosterIndex, build: BuildState): boolean {
  return build.instances.some((inst) => {
    const c = index.byKey.get(inst.unitKey);
    return !!c && c.isGeneral && c.generalKind === "combat";
  });
}

/** Replace every combat-general instance with the plain base unit it leads, undoing
 *  auto-/manual combat-general assignments. The commander (staff slot) is untouched.
 *  Always rules-safe: a base unit shares the general's cap group and class, so caps
 *  and card count are unchanged, and it only frees combat-general slots. */
export function resetCombatGenerals(index: RosterIndex, build: BuildState): BuildState {
  return {
    ...build,
    instances: build.instances.map((inst) => {
      const card = index.byKey.get(inst.unitKey);
      if (card && card.isGeneral && card.generalKind === "combat") {
        const base = index.byKey.get(card.baseUnitKey);
        if (base) return { id: inst.id, unitKey: base.unitKey };
      }
      return inst;
    }),
  };
}

/** The copies "take the whole division" adds, in grid order (brigade by brigade, each
 *  brigade ordered as the grid draws it): every plain unit placed in `division`,
 *  topped up to its cap. That is exactly what the division discount counts toward
 *  completion — each unit contributes `cap` copies (see buildRosterTotals) — and
 *  copies already selected in a unit's cap group (its combat-general variants
 *  included, as they share the unit's placement) count as taken, so a partial
 *  division is only topped up. A combat general commanding from the staff slot counts
 *  too, as pricing and the cap check both count him. Staff and combat generals are
 *  never added. A support division (which earns no discount) lists its units the
 *  same way. */
export function divisionFillPlan(index: RosterIndex, build: BuildState, division: number): UnitCard[] {
  const commanderGroup = build.staffSlotUnitKey ? index.byKey.get(build.staffSlotUnitKey)?.capGroupKey : undefined;
  const byBrigade = new Map<number, UnitCard[]>();
  for (const c of index.roster.cards) {
    if (c.factionKey !== index.roster.factionKey || c.isGeneral || c.placement?.division !== division) continue;
    const list = byBrigade.get(c.placement.brigade);
    if (list) list.push(c);
    else byBrigade.set(c.placement.brigade, [c]);
  }
  const plan: UnitCard[] = [];
  for (const brigade of [...byBrigade.keys()].sort((a, b) => a - b)) {
    for (const card of orderBrigadeCards(byBrigade.get(brigade)!)) {
      const held = groupQtyOf(index, build, card.capGroupKey) + (card.capGroupKey === commanderGroup ? 1 : 0);
      const missing = card.cap - held;
      for (let i = 0; i < missing; i++) plan.push(card);
    }
  }
  return plan;
}

export interface DivisionFill {
  build: BuildState;
  /** Copies actually added, in order. */
  added: UnitCard[];
  /** Copies the division still needed (the plan's length). */
  wanted: number;
  /** Distinct reasons some planned copies could not be added, in first-hit order. */
  blockedReasons: string[];
}

/** Add a division's missing copies (see {@link divisionFillPlan}) one at a time
 *  through the same hard-limit checks as a single add (evaluateAdd), skipping any
 *  copy a limit refuses and carrying on with the rest. The cost ceiling is soft, so
 *  an over-budget copy is still taken, exactly as a single click would. */
export function fillDivision(
  index: RosterIndex,
  build: BuildState,
  division: number,
  combatCap: number,
): DivisionFill {
  const plan = divisionFillPlan(index, build, division);
  let working = build;
  const added: UnitCard[] = [];
  const blockedReasons: string[] = [];
  for (const card of plan) {
    const block = evaluateAdd(index, working, card, combatCap);
    if (block) {
      if (!blockedReasons.includes(block.reason)) blockedReasons.push(block.reason);
      continue;
    }
    working = { ...working, instances: [...working.instances, { id: makeInstanceId(), unitKey: card.unitKey }] };
    added.push(card);
  }
  return { build: working, added, wanted: plan.length, blockedReasons };
}

export interface BuildSummary {
  expanded: ExpandedBuild;
  price: PriceResult;
  limits: LimitCheck;
  totalCards: number;
  totalMen: number;
  /** Number of selected cards that can form square. */
  totalSquares: number;
  /** Selected infantry — every infantry class except skirmishers (so line, light,
   *  grenadiers, militia and irregulars all count), including combat generals whose
   *  led unit is such infantry. Cavalry, artillery and staff generals are excluded.
   *  This is the denominator of the Squares stat. */
  totalInfantry: number;
  violationMessages: string[];
}

/** True when a selected card counts as infantry for the Squares denominator:
 *  any infantry class other than skirmishers. A combat general is classed by the
 *  unit it leads (underlyingUnitClass); a staff general uses unitClass "general"
 *  and so is excluded. */
function isCountedInfantry(c: UnitCard): boolean {
  const cls = c.isGeneral && c.generalKind === "combat" ? c.underlyingUnitClass || c.unitClass : c.unitClass;
  return cls.startsWith("infantry") && cls !== "infantry_skirmishers";
}

const RULE_LABELS: Record<string, string> = {
  total_cards: "Total unit cards",
  staff_generals: "Staff generals",
  artillery_foot: "Foot artillery",
  artillery_horse: "Horse artillery",
  cavalry_heavy: "Heavy cavalry",
  staff_slot_occupants: "Staff slot",
  combat_generals_against_cap: "Combat generals",
};

export function describeViolation(
  rule: string,
  actual: number,
  maximum: number,
  index: RosterIndex,
): string {
  if (rule.startsWith("unit_cap:") || rule.startsWith("combat_general_max:")) {
    const groupKey = rule.split(":").slice(2).join(":");
    const card = index.byKey.get(groupKey);
    const name = card?.name ?? groupKey;
    return `Too many of “${name}”: ${actual} selected, cap is ${maximum}.`;
  }
  const label = RULE_LABELS[rule] ?? rule;
  return `${label}: ${actual} selected, maximum is ${maximum}.`;
}

export function summarize(index: RosterIndex, build: BuildState): BuildSummary {
  const expanded = expandBuild(index, build);
  const faction = index.roster.factionKey;
  const price = priceBuild(index, build);
  let limits: LimitCheck;
  // A build the rules engine can't even check (e.g. an imported save whose staff slot
  // names a non-general) is not a valid one: report the data error as a violation
  // rather than passing it off as legal, and keep the combat-general tally the header
  // shows (counted from the cards themselves) meaningful.
  const dataErrors: string[] = [];
  try {
    limits = checkKnownLimits(expanded.cards, faction, {
      staffSlotIndex: expanded.staffSlotIndex,
      recruitable: index.roster.cards,
    });
  } catch (e) {
    dataErrors.push(`This build can't be checked: ${e instanceof Error ? e.message : String(e)}`);
    limits = {
      counts: {
        total_cards: expanded.cards.length,
        combat_generals_against_cap: combatGeneralsAgainstCap(index, build),
      },
      violations: [],
      valid: false,
    };
  }
  const totalMen = expanded.cards.reduce((sum, c) => sum + (c.finalMen ?? 0), 0);
  const totalSquares = expanded.cards.reduce((sum, c) => sum + (c.abilities.canFormSquare ? 1 : 0), 0);
  const totalInfantry = expanded.cards.reduce((sum, c) => sum + (isCountedInfantry(c) ? 1 : 0), 0);
  const violationMessages = [
    ...dataErrors,
    ...limits.violations.map((v) => describeViolation(v.rule, v.actual, v.maximum, index)),
  ];
  return {
    expanded,
    price,
    limits,
    totalCards: expanded.cards.length,
    totalMen,
    totalSquares,
    totalInfantry,
    violationMessages,
  };
}
