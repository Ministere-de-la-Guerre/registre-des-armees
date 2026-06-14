// Filter model + matching. Ordinary filters never remove units — callers use
// `matchesCard` to *dim* non-matching cards. The combat-general visibility
// switch is the one exception and is handled by `isHiddenByGeneralSwitch`.
//
// Combat stats (range, accuracy, reload, morale, melee, charge) are filtered
// *per class* (infantry/cavalry/artillery) so unrelated classes are not affected
// by one global range. Combat generals are classified by their underlying unit
// class. Cost/men/cap/stars stay global.

import { ABILITY_KEYS, type UnitAbilities, type UnitCard } from "../domain/types";

export type Tri = "any" | "yes" | "no";

export interface NumericRange {
  min: number | null;
  max: number | null;
}

export type StatClass = "infantry" | "cavalry" | "artillery";
export const STAT_CLASSES: StatClass[] = ["infantry", "cavalry", "artillery"];
export const STAT_CLASS_LABELS: Record<StatClass, string> = {
  infantry: "Infantry",
  cavalry: "Cavalry",
  artillery: "Artillery",
};

export type GlobalFieldId = "cost" | "men" | "commandStars" | "cap";
export type ClassFieldId =
  | "range"
  | "accuracy"
  | "reloadSkill"
  | "morale"
  | "meleeAttack"
  | "meleeDefense"
  | "chargeBonus";

export interface FilterState {
  search: string;
  numeric: Record<GlobalFieldId, NumericRange>;
  classStats: Record<StatClass, Record<ClassFieldId, NumericRange>>;
  classes: string[]; // unit_class values to require (empty = all)
  categories: BroadCategory[]; // empty = all
  speeds: string[]; // exact speed codes (empty = all)
  divisions: number[]; // empty = all
  brigades: number[]; // empty = all
  abilities: Record<keyof UnitAbilities, Tri>;
  showCombatGenerals: boolean;
}

export type BroadCategory = "infantry" | "cavalry" | "artillery" | "generals" | "other";

export const BROAD_CATEGORY_LABELS: Record<BroadCategory, string> = {
  infantry: "Infantry",
  cavalry: "Cavalry",
  artillery: "Artillery",
  generals: "Generals",
  other: "Other",
};

export interface NumericFieldDef<T extends string> {
  id: T;
  label: string;
  get: (c: UnitCard) => number | null;
}

export const GLOBAL_FIELDS: NumericFieldDef<GlobalFieldId>[] = [
  { id: "cost", label: "Cost", get: (c) => c.cost },
  { id: "men", label: "Men", get: (c) => c.finalMen },
  { id: "commandStars", label: "Command stars", get: (c) => c.commandStars },
  { id: "cap", label: "Unit cap", get: (c) => c.groupCap },
];

export const CLASS_FIELDS: NumericFieldDef<ClassFieldId>[] = [
  { id: "range", label: "Range", get: (c) => c.range },
  { id: "accuracy", label: "Accuracy", get: (c) => c.stats.accuracy },
  { id: "reloadSkill", label: "Reload skill", get: (c) => c.stats.reloadSkill },
  { id: "morale", label: "Morale", get: (c) => c.stats.morale },
  { id: "meleeAttack", label: "Melee attack", get: (c) => c.stats.meleeAttack },
  { id: "meleeDefense", label: "Melee defence", get: (c) => c.stats.meleeDefense },
  { id: "chargeBonus", label: "Charge bonus", get: (c) => c.stats.chargeBonus },
];

export function broadCategory(card: UnitCard): BroadCategory {
  if (card.isGeneral) return "generals";
  if (card.unitClass.startsWith("infantry")) return "infantry";
  if (card.unitClass.startsWith("cavalry")) return "cavalry";
  if (card.unitClass.startsWith("artillery")) return "artillery";
  return "other";
}

function classCategory(cls: string): BroadCategory | null {
  if (cls.startsWith("infantry")) return "infantry";
  if (cls.startsWith("cavalry")) return "cavalry";
  if (cls.startsWith("artillery")) return "artillery";
  return null;
}

/** Every broad category a card belongs to. Combat generals belong to "generals"
 *  *and* to their base unit's category, so the Infantry/Cavalry/Artillery filters
 *  include the combat general that leads such a unit. */
export function broadCategoriesOf(card: UnitCard): BroadCategory[] {
  if (card.isGeneral) {
    const cats: BroadCategory[] = ["generals"];
    if (card.generalKind === "combat") {
      const base = classCategory(card.underlyingUnitClass || "");
      if (base) cats.push(base);
    }
    return cats;
  }
  return [broadCategory(card)];
}

/** Stat-class of a card (using underlying class so combat generals filter like
 *  their base unit). Null for cards with no combat-stat class (e.g. staff). */
export function statClassOf(card: UnitCard): StatClass | null {
  const cls = card.underlyingUnitClass || card.unitClass;
  if (cls.startsWith("infantry")) return "infantry";
  if (cls.startsWith("cavalry")) return "cavalry";
  if (cls.startsWith("artillery")) return "artillery";
  return null;
}

// Canonical speed-code ordering for the filter chips.
export const SPEED_ORDER: string[] = [
  "L1", "L2", "L3", "L4", "L5", "L6",
  "G1", "G2", "G3", "G4", "G5", "G6",
  "S1", "S2", "S3",
  "GS1", "GS2", "GS3",
  "C1", "C2", "C3", "C4", "C5",
  "F1", "F2", "F3", "F4", "F5", "F6",
  "H1", "H2", "H3",
];

export function speedOrderIndex(code: string): number {
  const i = SPEED_ORDER.indexOf(code);
  return i === -1 ? 999 : i;
}

// Speed chips are laid out one family per row, in this fixed order. Families with
// no present codes for the current army are skipped so rows below shift up.
export const SPEED_FAMILIES: string[][] = [
  ["L1", "L2", "L3", "L4", "L5", "L6"],
  ["G1", "G2", "G3", "G4", "G5", "G6"],
  ["S1", "S2", "S3", "GS1", "GS2", "GS3"],
  ["C1", "C2", "C3", "C4", "C5"],
  ["F1", "F2", "F3", "F4", "F5", "F6"],
  ["H1", "H2", "H3"],
];

const emptyRange = (): NumericRange => ({ min: null, max: null });

export function defaultFilters(): FilterState {
  const numeric = {} as Record<GlobalFieldId, NumericRange>;
  for (const f of GLOBAL_FIELDS) numeric[f.id] = emptyRange();
  const classStats = {} as Record<StatClass, Record<ClassFieldId, NumericRange>>;
  for (const sc of STAT_CLASSES) {
    const m = {} as Record<ClassFieldId, NumericRange>;
    for (const f of CLASS_FIELDS) m[f.id] = emptyRange();
    classStats[sc] = m;
  }
  const abilities = {} as Record<keyof UnitAbilities, Tri>;
  for (const k of ABILITY_KEYS) abilities[k] = "any";
  return {
    search: "",
    numeric,
    classStats,
    classes: [],
    categories: [],
    speeds: [],
    divisions: [],
    brigades: [],
    abilities,
    showCombatGenerals: true,
  };
}

function inRange(value: number | null, range: NumericRange): boolean {
  if (range.min === null && range.max === null) return true;
  if (value === null) return false; // an active numeric filter excludes blanks
  if (range.min !== null && value < range.min) return false;
  if (range.max !== null && value > range.max) return false;
  return true;
}

function rangeActive(r: NumericRange): boolean {
  return r.min !== null || r.max !== null;
}

/** True when a card matches the ordinary (dimming) filters. */
export function matchesCard(card: UnitCard, f: FilterState): boolean {
  if (f.search.trim()) {
    const q = f.search.trim().toLowerCase();
    if (!card.name.toLowerCase().includes(q) && !card.unitKey.toLowerCase().includes(q)) return false;
  }
  for (const def of GLOBAL_FIELDS) {
    if (!inRange(def.get(card), f.numeric[def.id])) return false;
  }
  // Class-specific combat-stat ranges apply only to cards of that class.
  const sc = statClassOf(card);
  if (sc) {
    for (const def of CLASS_FIELDS) {
      if (!inRange(def.get(card), f.classStats[sc][def.id])) return false;
    }
  }
  if (f.classes.length && !f.classes.includes(card.unitClass)) return false;
  if (f.categories.length && !broadCategoriesOf(card).some((c) => f.categories.includes(c))) return false;
  if (f.speeds.length && (!card.speedCode || !f.speeds.includes(card.speedCode))) return false;
  if (f.divisions.length && (card.placement === null || !f.divisions.includes(card.placement.division))) return false;
  if (f.brigades.length && (card.placement === null || !f.brigades.includes(card.placement.brigade))) return false;
  for (const key of ABILITY_KEYS) {
    const tri = f.abilities[key];
    if (tri === "yes" && !card.abilities[key]) return false;
    if (tri === "no" && card.abilities[key]) return false;
  }
  return true;
}

/** Combat generals are *removed* (not dimmed) when the switch is off. */
export function isHiddenByGeneralSwitch(card: UnitCard, f: FilterState): boolean {
  return !f.showCombatGenerals && card.isGeneral && card.generalKind === "combat";
}

export function isFilterActive(f: FilterState): boolean {
  if (f.search.trim()) return true;
  if (f.classes.length || f.categories.length || f.speeds.length || f.divisions.length || f.brigades.length) return true;
  for (const def of GLOBAL_FIELDS) if (rangeActive(f.numeric[def.id])) return true;
  for (const sc of STAT_CLASSES) for (const def of CLASS_FIELDS) if (rangeActive(f.classStats[sc][def.id])) return true;
  for (const k of ABILITY_KEYS) if (f.abilities[k] !== "any") return true;
  return false;
}
