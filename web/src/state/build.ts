// Build state derivation. The build is an ordered list of *explicit instances*
// (one entry per selected copy) so the tray can show and remove each copy
// independently, plus a single staff slot. Pure helpers here turn that into the
// expanded rules-engine card list, pricing, limit results, and add-blocking.

import type { FactionRoster, UnitCard } from "../domain/types";
import {
  type LimitCheck,
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
 *  this to colour the unit's cost (and portrait) red as a warning. Uses the same
 *  face-value recruitment basis as the affordability replay: the new unit's full
 *  price on top of the current discounted total (a discount the card itself would
 *  trigger does not count toward affording it — matching the game). */
export function addWouldExceedBudget(index: RosterIndex, build: BuildState, card: UnitCard): boolean {
  return priceBuild(index, build).finalCost + card.cost > MAX_BUILD_COST;
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
  const next: BuildState = {
    ...build,
    instances: build.instances.filter((i) => i.unitKey !== card.unitKey),
    staffSlotUnitKey: card.unitKey,
  };
  return priceBuild(index, next).finalCost > MAX_BUILD_COST;
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
 *  selected plain copy with the combat-general variant of the same unit — it never
 *  adds new units. Existing combat generals are left untouched.
 *
 *  A swap is rules-safe by construction: the general shares the unit's cap group and
 *  underlying class and replaces one copy, so the card count, shared cap, and
 *  artillery/cavalry class caps are all unchanged; it only spends one combat-general
 *  slot. A combat general may cost *less or more* than the plain copy it replaces, and
 *  a cheaper one lowers the running total — which can pull a formation-completing copy
 *  back within face-value budget and so unlock that formation's (often large) discount.
 *
 *  The goal is therefore the *cheapest* build: we greedily commit, one slot at a time,
 *  the swap that most lowers the final priced cost, and we stop as soon as no remaining
 *  swap lowers it (a swap that would only make the build dearer — including one that
 *  forfeits a discount — is never taken). This naturally takes the cost-reducing
 *  generals (up to the cap), skips cost-increasing ones, and may take fewer combat
 *  generals than the cap allows. Units that already carry a combat general are skipped
 *  (a unit may have only one). */
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

  // Cheapest combat-general variant available for each unit (cap group).
  const cheapestGeneral = new Map<string, UnitCard>();
  for (const c of index.roster.cards) {
    if (!(c.isGeneral && c.generalKind === "combat")) continue;
    const cur = cheapestGeneral.get(c.capGroupKey);
    if (!cur || c.cost < cur.cost) cheapestGeneral.set(c.capGroupKey, c);
  }

  // One replaceable plain copy per eligible group: the first selected instance of a
  // non-general unit whose group has a general variant and no general yet.
  interface Candidate {
    instanceId: string;
    general: UnitCard;
    delta: number;
  }
  const pool: Candidate[] = [];
  const seenGroups = new Set<string>();
  for (const inst of build.instances) {
    const base = index.byKey.get(inst.unitKey);
    if (!base || base.isGeneral) continue;
    const group = base.capGroupKey;
    if (groupsWithGeneral.has(group) || seenGroups.has(group)) continue;
    const general = cheapestGeneral.get(group);
    if (!general) continue;
    seenGroups.add(group);
    pool.push({ instanceId: inst.id, general, delta: general.cost - base.cost });
  }

  const applySwap = (b: BuildState, c: Candidate): BuildState => ({
    ...b,
    instances: b.instances.map((i) => (i.id === c.instanceId ? { id: i.id, unitKey: c.general.unitKey } : i)),
  });

  const chosen: AutoGeneralReplacement[] = [];
  let working = build;
  let workingFinal = priceBuild(index, working).finalCost;
  for (let slot = 0; slot < remaining && pool.length > 0; slot++) {
    let best: { idx: number; final: number; delta: number; key: string } | null = null;
    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i];
      const final = priceBuild(index, applySwap(working, cand)).finalCost;
      if (final > workingFinal) continue; // never make the build dearer
      const better =
        !best ||
        final < best.final ||
        (final === best.final && cand.delta < best.delta) ||
        (final === best.final && cand.delta === best.delta && cand.general.unitKey.localeCompare(best.key) < 0);
      if (better) best = { idx: i, final, delta: cand.delta, key: cand.general.unitKey };
    }
    if (!best) break; // no remaining swap lowers (or holds) the cost; stop short of the cap
    const cand = pool.splice(best.idx, 1)[0];
    chosen.push({ instanceId: cand.instanceId, generalUnitKey: cand.general.unitKey });
    working = applySwap(working, cand);
    workingFinal = best.final;
  }
  return { replacements: chosen };
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
  try {
    limits = checkKnownLimits(expanded.cards, faction, {
      staffSlotIndex: expanded.staffSlotIndex,
      recruitable: index.roster.cards,
    });
  } catch {
    limits = { counts: {}, violations: [], valid: true };
  }
  const totalMen = expanded.cards.reduce((sum, c) => sum + (c.finalMen ?? 0), 0);
  const totalSquares = expanded.cards.reduce((sum, c) => sum + (c.abilities.canFormSquare ? 1 : 0), 0);
  const totalInfantry = expanded.cards.reduce((sum, c) => sum + (isCountedInfantry(c) ? 1 : 0), 0);
  const violationMessages = limits.violations.map((v) =>
    describeViolation(v.rule, v.actual, v.maximum, index),
  );
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
