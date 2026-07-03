// Source-backed NTW3 army-builder pricing and roster limits.
//
// This is a faithful TypeScript port of tools/army_builder_rules.py. Behavior
// (integer floor arithmetic, discount selection, general classification, caps)
// must stay in parity with the Python implementation — see rules.test.ts.

const TRAILING_DIGITS_RE = /(\d+)$/;
const COMMANDER_SUFFIX_RE = /_com_\d+$/;

// Sapper / marine name detection — these are support specialists even though the
// game classes them as line/grenadier infantry. Keep in parity with SAPPER_RE /
// MARINE_RE in tools/build_ntw3_army_builder_database.py and army_builder_rules.py.
const SAPPER_RE =
  /sappers?|sapeurs?|sappeurs?|sap[eé]ri|saper|pioniere|pionier|pioneers?|engineers?|ingenj[oö]r|artificers?|artífices|zapadores|gastadores/i;
const MARINE_RE = /marins?|marines?/i;

// Placement provenance values that mark a card as belonging to the final support /
// reserve division (set by infer_final_division_placements in the builder). A
// division holding any such card is a support division regardless of its unit mix.
const SUPPORT_PLACEMENT_SOURCES = new Set([
  "inferred_new_support_division",
  "inferred_existing_support_division",
  "reserve_support_division",
]);

export const MAX_TOTAL_UNIT_CARDS = 31;
export const MAX_BUILD_COST = 10000;
export const MAX_FOOT_ARTILLERY = 2;
export const MAX_HORSE_ARTILLERY = 1;
export const MAX_HEAVY_CAVALRY = 10;
export const MAX_BRIGADE_SLOTS_PER_DIVISION = 7;

export class RuleDataError extends Error {}

export interface Placement {
  division: number;
  brigade: number;
}

/** Minimal card shape the rules engine needs. The domain UnitCard satisfies it. */
export interface RulesUnit {
  unitKey: string;
  factionKey: string;
  unitClass: string;
  menRaw: number | null;
  placement: Placement | null;
  cost: number;
  cap: number;
  /** Shared cap-group cap (the underlying unit's cap). Falls back to `cap`. */
  groupCap?: number;
  isGeneral: boolean;
  /** Combat generals report their base unit's class (from the web data layer); used
   *  so they count against the class caps of the unit they lead. */
  underlyingUnitClass?: string;
  /** Display name — used to detect sapper/marine support specialists by name. */
  name?: string;
  /** Builder provenance for the division/brigade placement; flags the final
   *  support/reserve division (see SUPPORT_PLACEMENT_SOURCES). */
  placementSource?: string | null;
}

/** Support arms (artillery / skirmisher / sapper / marine) that do NOT make a
 *  division a combat division. Sappers and marines are support specialists even
 *  though the game classes them as line/grenadier infantry, so they are matched
 *  by name. Mirrors final_division_category in
 *  tools/build_ntw3_army_builder_database.py — keep in parity. */
function isSupportUnit(card: RulesUnit): boolean {
  const { unitKey, unitClass } = card;
  if (
    unitKey.startsWith("ntw3_art_foot_") ||
    unitKey.startsWith("ntw3_art_fixed_") ||
    unitClass === "artillery_foot" ||
    unitClass === "artillery_fixed"
  ) {
    return true;
  }
  if (unitKey.startsWith("ntw3_art_horse_") || unitClass === "artillery_horse") return true;
  const name = card.name ?? "";
  return (
    unitKey.startsWith("ntw3_inf_skirm_") ||
    unitClass === "infantry_skirmishers" ||
    SAPPER_RE.test(name) ||
    MARINE_RE.test(name)
  );
}

/** Combat arms make a division a real combat division rather than a support
 *  (artillery / sapper / skirmisher / marine) division. */
function isCombatArm(card: RulesUnit): boolean {
  return !isSupportUnit(card);
}

function isArtillery(card: RulesUnit): boolean {
  const { unitKey, unitClass } = card;
  return (
    unitKey.startsWith("ntw3_art_foot_") ||
    unitKey.startsWith("ntw3_art_fixed_") ||
    unitKey.startsWith("ntw3_art_horse_") ||
    unitClass === "artillery_foot" ||
    unitClass === "artillery_fixed" ||
    unitClass === "artillery_horse"
  );
}

/** Divisions that earn no brigade/division cost discount: the final artillery
 *  support / reserve division. A division qualifies when either (a) every unit is
 *  a support arm AND it holds artillery (a real artillery reserve), or (b) the
 *  builder designated it the support division via placementSource. Both are
 *  needed: (a) catches fully source-tagged artillery reserves the builder never
 *  had to infer; (b) catches builder-inferred reserves of loose specialists
 *  (skirmishers/sappers) that hold no artillery. A combat division of pure
 *  skirmishers (e.g. native warriors) matches neither, so it keeps its discount.
 *  Mirrors support_divisions in tools/army_builder_rules.py — keep in parity. */
export function supportDivisions(recruitable: readonly RulesUnit[], factionKey: string): Set<number> {
  const divisions = new Set<number>();
  const combatDivisions = new Set<number>();
  const artilleryDivisions = new Set<number>();
  const designatedSupport = new Set<number>();
  for (const card of recruitable) {
    if (card.factionKey !== factionKey || card.isGeneral || card.placement === null) continue;
    const { division } = card.placement;
    divisions.add(division);
    if (isCombatArm(card)) combatDivisions.add(division);
    if (isArtillery(card)) artilleryDivisions.add(division);
    if (card.placementSource && SUPPORT_PLACEMENT_SOURCES.has(card.placementSource)) {
      designatedSupport.add(division);
    }
  }
  const support = new Set<number>(designatedSupport);
  for (const division of divisions) {
    if (!combatDivisions.has(division) && artilleryDivisions.has(division)) support.add(division);
  }
  return support;
}

/** Class used for the artillery/heavy-cavalry caps: combat generals occupy a slot
 *  of the unit they lead, so they count by their underlying class. */
function cappedClassOf(card: RulesUnit): string {
  if (card.isGeneral && card.underlyingUnitClass && classifyGeneral(card) === "combat") {
    return card.underlyingUnitClass;
  }
  return card.unitClass;
}

export interface GroupTotal {
  rosterCost: number;
  requiredCount: number;
}

export interface CompletedGroup {
  groupType: "division" | "brigade";
  divisionId: number;
  brigadeId: number | null;
  rosterCost: number;
  requiredCount: number;
  selectedCount: number;
  discount: number;
}

export interface PriceResult {
  factionKey: string;
  baseCost: number;
  normalDiscount: number;
  appliedDiscount: number;
  finalCost: number;
  germanStates: boolean;
  completedGroups: CompletedGroup[];
}

export interface GeneralCaps {
  staff: number;
  combat: number;
}

export interface LimitViolation {
  rule: string;
  actual: number;
  maximum: number;
}

export interface LimitCheck {
  counts: Record<string, number>;
  violations: LimitViolation[];
  valid: boolean;
}

/** Underlying unit key used for shared unit-cap accounting (strip _com_<digits>). */
export function capGroupKey(unitKey: string): string {
  return unitKey.replace(COMMANDER_SUFFIX_RE, "");
}

function addToGroup(total: GroupTotal | undefined, card: RulesUnit): GroupTotal {
  const base = total ?? { rosterCost: 0, requiredCount: 0 };
  return {
    rosterCost: base.rosterCost + card.cap * card.cost,
    requiredCount: base.requiredCount + card.cap,
  };
}

export function groupDiscount(total: GroupTotal): number {
  if (total.requiredCount <= 0) return 0;
  return Math.floor((total.rosterCost * (total.requiredCount - 1)) / 100);
}

export function isGermanStates(factionKey: string): boolean {
  const parts = factionKey.split("_");
  return parts.length >= 4 && parts[3].includes("g");
}

export function buildRosterTotals(
  recruitable: readonly RulesUnit[],
  factionKey: string,
): { divisions: Map<number, GroupTotal>; brigades: Map<string, GroupTotal> } {
  const divisions = new Map<number, GroupTotal>();
  const brigades = new Map<string, GroupTotal>();
  const support = supportDivisions(recruitable, factionKey);
  for (const card of recruitable) {
    if (card.factionKey !== factionKey || card.isGeneral || card.placement === null) continue;
    const { division, brigade } = card.placement;
    if (support.has(division)) continue; // support divisions earn no discount
    divisions.set(division, addToGroup(divisions.get(division), card));
    const bkey = `${division}:${brigade}`;
    brigades.set(bkey, addToGroup(brigades.get(bkey), card));
  }
  return { divisions, brigades };
}

export function calculateArmyCost(
  selected: readonly RulesUnit[],
  recruitable: readonly RulesUnit[],
  factionKey: string,
): PriceResult {
  for (const card of selected) {
    if (card.factionKey !== factionKey) {
      throw new RuleDataError(
        `Selected card ${card.unitKey} belongs to ${card.factionKey}, not ${factionKey}.`,
      );
    }
  }

  const baseCost = selected.reduce((sum, c) => sum + c.cost, 0);
  if (!factionKey.includes("_ac_")) {
    return {
      factionKey,
      baseCost,
      normalDiscount: 0,
      appliedDiscount: 0,
      finalCost: baseCost,
      germanStates: false,
      completedGroups: [],
    };
  }

  const { divisions, brigades } = buildRosterTotals(recruitable, factionKey);
  const selectedDivisions = new Map<number, number>();
  const selectedBrigades = new Map<string, number>();
  for (const card of selected) {
    if (card.placement === null) continue;
    const { division, brigade } = card.placement;
    selectedDivisions.set(division, (selectedDivisions.get(division) ?? 0) + 1);
    const bkey = `${division}:${brigade}`;
    selectedBrigades.set(bkey, (selectedBrigades.get(bkey) ?? 0) + 1);
  }

  const completed: CompletedGroup[] = [];
  const divisionIds = [...divisions.keys()].sort((a, b) => a - b);
  // Brigade keys sorted by (division, brigade) to match Python's tuple sort.
  const brigadeKeys = [...brigades.keys()].sort((a, b) => {
    const [da, ba] = a.split(":").map(Number);
    const [db, bb] = b.split(":").map(Number);
    return da - db || ba - bb;
  });

  for (const divisionId of divisionIds) {
    const divisionTotal = divisions.get(divisionId)!;
    const divisionSelected = selectedDivisions.get(divisionId) ?? 0;
    if (divisionSelected >= divisionTotal.requiredCount) {
      completed.push({
        groupType: "division",
        divisionId,
        brigadeId: null,
        rosterCost: divisionTotal.rosterCost,
        requiredCount: divisionTotal.requiredCount,
        selectedCount: divisionSelected,
        discount: groupDiscount(divisionTotal),
      });
      continue;
    }
    for (const bkey of brigadeKeys) {
      const [bdiv, bid] = bkey.split(":").map(Number);
      if (bdiv !== divisionId) continue;
      const brigadeTotal = brigades.get(bkey)!;
      const brigadeSelected = selectedBrigades.get(bkey) ?? 0;
      if (brigadeSelected >= brigadeTotal.requiredCount) {
        completed.push({
          groupType: "brigade",
          divisionId,
          brigadeId: bid,
          rosterCost: brigadeTotal.rosterCost,
          requiredCount: brigadeTotal.requiredCount,
          selectedCount: brigadeSelected,
          discount: groupDiscount(brigadeTotal),
        });
      }
    }
  }

  const normalDiscount = completed.reduce((sum, g) => sum + g.discount, 0);
  const germanStates = isGermanStates(factionKey);
  const appliedDiscount = germanStates
    ? Math.floor((normalDiscount * 3) / 2)
    : normalDiscount;
  return {
    factionKey,
    baseCost,
    normalDiscount,
    appliedDiscount,
    finalCost: baseCost - appliedDiscount,
    germanStates,
    completedGroups: completed,
  };
}

export function classifyGeneral(card: RulesUnit): "staff" | "combat" | null {
  if (!card.isGeneral) return null;
  if (card.menRaw === null || card.menRaw === undefined) {
    throw new RuleDataError(`${card.unitKey}: general classification requires raw Men.`);
  }
  return card.menRaw === 32 || card.menRaw === 122 ? "staff" : "combat";
}

export function generalCaps(factionKey: string): GeneralCaps {
  // Theatres-of-War corps are hard-capped at a single combat general total,
  // regardless of the corps rating (the 9 − N formula below would otherwise apply).
  // See docs/TOW_ARMY_BUILDS.md §2 / §4.
  if (factionKey.includes("_tow_")) {
    return { staff: 1, combat: 1 };
  }
  if (!factionKey.includes("_ac_")) {
    return { staff: 1, combat: 1 };
  }
  const parts = factionKey.split("_");
  if (parts.length < 4) {
    throw new RuleDataError(`Faction key ${factionKey} has no fourth component.`);
  }
  const match = TRAILING_DIGITS_RE.exec(parts[3]);
  if (!match) {
    throw new RuleDataError(`Faction key ${factionKey} fourth component has no trailing digits.`);
  }
  const combat = 9 - parseInt(match[1], 10);
  if (combat < 0) {
    throw new RuleDataError(`Faction key ${factionKey} produces a negative combat cap.`);
  }
  return { staff: 1, combat };
}

export function acSelectionGeneralMaxima(factionKey: string): GeneralCaps {
  if (!factionKey.includes("_ac_")) {
    throw new RuleDataError("AC selection maxima apply only to faction keys containing '_ac_'.");
  }
  const caps = generalCaps(factionKey);
  return { staff: caps.staff, combat: caps.combat + 2 };
}

export interface CheckOptions {
  acSelectionBehavior?: boolean;
  staffSlotIndex?: number | null;
}

export function checkKnownLimits(
  selected: readonly RulesUnit[],
  factionKey: string,
  options: CheckOptions = {},
): LimitCheck {
  const { acSelectionBehavior = false, staffSlotIndex = null } = options;
  const counts: Record<string, number> = {};
  for (const card of selected) {
    counts[card.unitClass] = (counts[card.unitClass] ?? 0) + 1;
  }
  // The capped classes count combat generals against the slot of the unit they
  // lead (an artillery-led combat general consumes an artillery slot), so recount
  // them by underlying class on top of the raw per-class tallies above.
  for (const cls of ["artillery_foot", "artillery_horse", "cavalry_heavy"]) {
    counts[cls] = selected.filter((c) => cappedClassOf(c) === cls).length;
  }
  counts.total_cards = selected.length;
  counts.staff_generals = 0;
  counts.combat_generals = 0;
  counts.combat_generals_against_cap = 0;
  counts.staff_slot_occupants = 0;

  if (staffSlotIndex !== null && staffSlotIndex !== undefined) {
    if (!(staffSlotIndex >= 0 && staffSlotIndex < selected.length)) {
      throw new RuleDataError("staff_slot_index is outside the selected-card list.");
    }
    const slotCard = selected[staffSlotIndex];
    if (slotCard.factionKey !== factionKey) {
      throw new RuleDataError("The staff-slot card must belong to the selected faction.");
    }
    if (!slotCard.isGeneral) {
      throw new RuleDataError("Only a General-class card can occupy the staff slot.");
    }
  }

  selected.forEach((card, index) => {
    const classification = classifyGeneral(card);
    if (classification === "staff") {
      counts.staff_generals += 1;
      counts.staff_slot_occupants += 1;
    } else if (classification === "combat") {
      counts.combat_generals += 1;
      if (index === staffSlotIndex) {
        counts.staff_slot_occupants += 1;
      } else {
        counts.combat_generals_against_cap += 1;
      }
    }
  });

  const caps = acSelectionBehavior
    ? acSelectionGeneralMaxima(factionKey)
    : generalCaps(factionKey);
  const maxima: Record<string, number> = {
    total_cards: MAX_TOTAL_UNIT_CARDS,
    artillery_foot: MAX_FOOT_ARTILLERY,
    artillery_horse: MAX_HORSE_ARTILLERY,
    cavalry_heavy: MAX_HEAVY_CAVALRY,
    staff_slot_occupants: caps.staff,
    combat_generals_against_cap: caps.combat,
  };
  const violations: LimitViolation[] = [];
  for (const [rule, maximum] of Object.entries(maxima)) {
    const actual = counts[rule] ?? 0;
    if (actual > maximum) violations.push({ rule, actual, maximum });
  }

  // Shared unit-cap accounting between commander variants and base units.
  const capGroups = new Map<string, RulesUnit[]>();
  for (const card of selected) {
    const key = `${card.factionKey} ${capGroupKey(card.unitKey)}`;
    const list = capGroups.get(key);
    if (list) list.push(card);
    else capGroups.set(key, [card]);
  }
  for (const key of [...capGroups.keys()].sort()) {
    const cards = capGroups.get(key)!;
    // The group cap is the underlying unit's cap (README: a commander variant
    // counts against the cap of its underlying unit). All members share it.
    const positiveCaps = cards.map((c) => c.groupCap ?? c.cap).filter((c) => c > 0);
    if (positiveCaps.length === 0) continue;
    const maximum = Math.min(...positiveCaps);
    const count = cards.length;
    const [cardFaction, groupKey] = key.split(" ");
    const rule = `unit_cap:${cardFaction}:${groupKey}`;
    counts[rule] = count;
    if (count > maximum) violations.push({ rule, actual: count, maximum });
  }

  // A unit may be led by at most one combat general — including across different
  // commander variants of the same base unit (its shared cap group).
  const combatGeneralCounts = new Map<string, number>();
  for (const card of selected) {
    if (card.isGeneral && classifyGeneral(card) === "combat") {
      const k = `${card.factionKey} ${capGroupKey(card.unitKey)}`;
      combatGeneralCounts.set(k, (combatGeneralCounts.get(k) ?? 0) + 1);
    }
  }
  for (const [k, count] of combatGeneralCounts) {
    if (count > 1) {
      const [cardFaction, groupKey] = k.split(" ");
      violations.push({
        rule: `combat_general_max:${cardFaction}:${groupKey}`,
        actual: count,
        maximum: 1,
      });
    }
  }

  return { counts, violations, valid: violations.length === 0 };
}
