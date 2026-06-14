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
  MAX_HORSE_ARTILLERY,
  MAX_TOTAL_UNIT_CARDS,
  calculateArmyCost,
  checkKnownLimits,
  generalCaps,
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

  const classCount = (cls: string) => cards.filter((c) => c.unitClass === cls).length;
  if (card.unitClass === "artillery_foot" && classCount("artillery_foot") >= MAX_FOOT_ARTILLERY) {
    return { reason: `Foot-artillery limit (${MAX_FOOT_ARTILLERY}) reached.` };
  }
  if (card.unitClass === "artillery_horse" && classCount("artillery_horse") >= MAX_HORSE_ARTILLERY) {
    return { reason: `Horse-artillery limit (${MAX_HORSE_ARTILLERY}) reached.` };
  }
  if (card.unitClass === "cavalry_heavy" && classCount("cavalry_heavy") >= MAX_HEAVY_CAVALRY) {
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

  const next = [...cards, card];
  const price = calculateArmyCost(next, index.roster.cards, index.roster.factionKey);
  if (price.finalCost > MAX_BUILD_COST) {
    return { reason: `Would exceed ${MAX_BUILD_COST.toLocaleString()} cost limit.` };
  }

  return null;
}

export interface BuildSummary {
  expanded: ExpandedBuild;
  price: PriceResult;
  limits: LimitCheck;
  totalCards: number;
  totalMen: number;
  /** Number of selected cards that can form square. */
  totalSquares: number;
  violationMessages: string[];
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
  const price = calculateArmyCost(expanded.cards, index.roster.cards, faction);
  let limits: LimitCheck;
  try {
    limits = checkKnownLimits(expanded.cards, faction, {
      staffSlotIndex: expanded.staffSlotIndex,
    });
  } catch {
    limits = { counts: {}, violations: [], valid: true };
  }
  const totalMen = expanded.cards.reduce((sum, c) => sum + (c.finalMen ?? 0), 0);
  const totalSquares = expanded.cards.reduce((sum, c) => sum + (c.abilities.canFormSquare ? 1 : 0), 0);
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
    violationMessages,
  };
}
