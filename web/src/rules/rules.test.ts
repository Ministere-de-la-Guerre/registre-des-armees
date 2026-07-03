import { describe, expect, it } from "vitest";
import {
  MAX_BRIGADE_SLOTS_PER_DIVISION,
  RuleDataError,
  type RulesUnit,
  acSelectionGeneralMaxima,
  calculateArmyCost,
  capGroupKey,
  checkKnownLimits,
  generalCaps,
} from "./rules";

interface CardOpts {
  faction?: string;
  unitClass?: string;
  underlyingUnitClass?: string;
  menRaw?: number | null;
  division?: number | null;
  brigade?: number | null;
  cost?: number;
  cap?: number;
  groupCap?: number;
  name?: string;
  placementSource?: string;
}

// Mirror of the `card(...)` helper in tools/tests/test_army_builder_rules.py.
function card(key: string, opts: CardOpts = {}): RulesUnit {
  const {
    faction = "ntw3_ac_test_x5_001",
    unitClass = "infantry_line",
    underlyingUnitClass,
    menRaw = 100,
    division = 1,
    brigade = 1,
    cost = 100,
    cap = 1,
    groupCap,
    name,
    placementSource,
  } = opts;
  return {
    unitKey: key,
    factionKey: faction,
    unitClass,
    menRaw,
    placement: division !== null && brigade !== null ? { division, brigade } : null,
    cost,
    cap,
    groupCap: groupCap ?? cap,
    isGeneral: unitClass === "general",
    underlyingUnitClass: underlyingUnitClass ?? unitClass,
    name,
    placementSource,
  };
}

describe("pricing", () => {
  it("normal brigade discount", () => {
    const faction = "ntw3_ac_test_x5_001";
    const unit = card("line", { faction, cost: 500, cap: 2 });
    const sibling = card("sibling", { faction, brigade: 2, cost: 100, cap: 1 });
    const result = calculateArmyCost([unit, unit], [unit, sibling], faction);
    expect(result.baseCost).toBe(1000);
    expect(result.normalDiscount).toBe(10);
    expect(result.finalCost).toBe(990);
    expect(result.completedGroups[0].groupType).toBe("brigade");
  });

  it("full division replaces brigade discounts", () => {
    const faction = "ntw3_ac_test_x5_001";
    const first = card("first", { faction, brigade: 1, cost: 100, cap: 2 });
    const second = card("second", { faction, brigade: 2, cost: 100, cap: 2 });
    const result = calculateArmyCost([first, first, second, second], [first, second], faction);
    expect(result.normalDiscount).toBe(12);
    expect(result.completedGroups).toHaveLength(1);
    expect(result.completedGroups[0].groupType).toBe("division");
  });

  it("german states multiplies total normal discount", () => {
    const faction = "ntw3_ac_test_g5_001";
    const unit = card("line", { faction, cost: 500, cap: 2 });
    const sibling = card("sibling", { faction, brigade: 2, cost: 100, cap: 1 });
    const result = calculateArmyCost([unit, unit], [unit, sibling], faction);
    expect(result.normalDiscount).toBe(10);
    expect(result.appliedDiscount).toBe(15);
    expect(result.finalCost).toBe(985);
    expect(result.germanStates).toBe(true);
  });

  it("tagged general can complete a brigade but is not in roster", () => {
    const faction = "ntw3_ac_test_x5_001";
    const unit = card("line", { faction, cost: 500, cap: 2 });
    const general = card("general", { faction, unitClass: "general", menRaw: 80, cost: 845, cap: 1 });
    const sibling = card("sibling", { faction, brigade: 2, cost: 100, cap: 1 });
    const result = calculateArmyCost([unit, general], [unit, general, sibling], faction);
    expect(result.baseCost).toBe(1345);
    expect(result.completedGroups[0].rosterCost).toBe(1000);
    expect(result.completedGroups[0].requiredCount).toBe(2);
    expect(result.completedGroups[0].selectedCount).toBe(2);
    expect(result.normalDiscount).toBe(10);
  });

  it("verified 5645 example", () => {
    const faction = "ntw3_ac_test_x5_001";
    const roster = [
      card("roster_a", { faction, cost: 1003, cap: 2 }),
      card("roster_b", { faction, cost: 807, cap: 2 }),
      card("roster_c", { faction, cost: 384, cap: 4 }),
      card("other_brigade", { faction, brigade: 2, cost: 100, cap: 1 }),
    ];
    const costs = [1003, 1003, 807, 807, 384, 384, 772];
    const selected = costs.map((cost, i) => card(`selected_${i}`, { faction, cost }));
    selected.push(card("tagged_general", { faction, unitClass: "general", menRaw: 80, cost: 845 }));
    const result = calculateArmyCost(selected, roster, faction);
    expect(result.baseCost).toBe(6005);
    expect(result.completedGroups[0].rosterCost).toBe(5156);
    expect(result.completedGroups[0].requiredCount).toBe(8);
    expect(result.completedGroups[0].selectedCount).toBe(8);
    expect(result.normalDiscount).toBe(360);
    expect(result.finalCost).toBe(5645);
    expect(result.completedGroups[0].groupType).toBe("brigade");
  });

  it("non-ac faction receives no discount", () => {
    const unit = card("line", { faction: "france", cost: 500, cap: 2 });
    const result = calculateArmyCost([unit, unit], [unit], "france");
    expect(result.finalCost).toBe(1000);
    expect(result.normalDiscount).toBe(0);
  });

  it("the support division (all artillery/skirmisher) earns no discount", () => {
    const faction = "ntw3_ac_test_x5_001";
    const inf = card("inf", { faction, division: 1, brigade: 1, cost: 500, cap: 2 });
    // Division 2 is a pure support division (foot artillery only).
    const art = card("art", { faction, unitClass: "artillery_foot", division: 2, brigade: 1, cost: 100, cap: 2 });
    const result = calculateArmyCost([inf, inf, art, art], [inf, art], faction);
    // Only the combat division discounts; the support division contributes nothing.
    expect(result.completedGroups).toHaveLength(1);
    expect(result.completedGroups[0].divisionId).toBe(1);
    expect(result.normalDiscount).toBe(10);
  });

  it("a support division with a sapper (line-classed) earns no discount", () => {
    const faction = "ntw3_ac_test_x5_001";
    const inf = card("inf", { faction, division: 1, brigade: 1, cost: 500, cap: 2 });
    // Division 2 = support division: artillery + a sapper classed as grenadier infantry.
    const art = card("art", { faction, unitClass: "artillery_foot", division: 2, brigade: 1, cost: 100, cap: 2 });
    const sapper = card("ntw3_inf_line_test_sap", {
      faction,
      unitClass: "infantry_grenadiers",
      division: 2,
      brigade: 2,
      cost: 100,
      cap: 2,
      name: "Sapeurs [G4]",
    });
    const result = calculateArmyCost([inf, inf, art, art, sapper, sapper], [inf, art, sapper], faction);
    // Only the combat division discounts; the support division contributes nothing.
    expect(result.completedGroups.map((g) => g.divisionId)).toEqual([1]);
    expect(result.normalDiscount).toBe(10);
  });

  it("a skirmisher-only combat division keeps its discount (native warriors)", () => {
    const faction = "ntw3_ac_test_x5_001";
    // Pure-skirmisher division with no artillery -> a real combat division.
    const warriors = card("warriors", {
      faction,
      unitClass: "infantry_skirmishers",
      division: 1,
      brigade: 1,
      cost: 300,
      cap: 2,
      name: "Mohawk [GS3]",
    });
    const result = calculateArmyCost([warriors, warriors], [warriors], faction);
    expect(result.normalDiscount).toBe(6);
    expect(result.completedGroups[0].divisionId).toBe(1);
  });

  it("a builder-designated specialist reserve earns no discount", () => {
    const faction = "ntw3_ac_test_x5_001";
    // Inferred support reserve of loose skirmishers with no artillery.
    const skirm = card("skirm", {
      faction,
      unitClass: "infantry_skirmishers",
      division: 2,
      brigade: 1,
      cost: 300,
      cap: 2,
      name: "Voltigeurs [S2]",
      placementSource: "inferred_new_support_division",
    });
    const result = calculateArmyCost([skirm, skirm], [skirm], faction);
    expect(result.normalDiscount).toBe(0);
    expect(result.completedGroups).toHaveLength(0);
  });

  it("a combat division keeps its discount even with organic divisional artillery", () => {
    const faction = "ntw3_ac_test_x5_001";
    // Division 1 mixes infantry and a divisional battery -> still a combat division.
    const inf = card("inf", { faction, division: 1, brigade: 1, cost: 500, cap: 1 });
    const battery = card("bat", { faction, unitClass: "artillery_foot", division: 1, brigade: 2, cost: 100, cap: 1 });
    const result = calculateArmyCost([inf, battery], [inf, battery], faction);
    expect(result.completedGroups.some((g) => g.divisionId === 1)).toBe(true);
    expect(result.normalDiscount).toBeGreaterThan(0);
  });
});

describe("limits", () => {
  it("general caps and separate ac selection maximum", () => {
    expect(generalCaps("france").combat).toBe(1);
    expect(generalCaps("ntw3_tow_test_x8_001").combat).toBe(1);
    // TOW is hard-capped at 1 regardless of rating — the 9 − N formula (which
    // would give 6 here) is overridden for _tow_ keys.
    expect(generalCaps("ntw3_tow_test_x3_001").combat).toBe(1);
    expect(generalCaps("ntw3_ac_test_x5_001").combat).toBe(4);
    expect(acSelectionGeneralMaxima("ntw3_ac_test_x5_001").combat).toBe(6);
  });

  it("known card and type limits", () => {
    const faction = "france";
    const selected = [
      ...[0, 1, 2].map((i) => card(`foot_${i}`, { faction, unitClass: "artillery_foot" })),
      ...[0, 1].map((i) => card(`horse_${i}`, { faction, unitClass: "artillery_horse" })),
    ];
    const result = checkKnownLimits(selected, faction);
    const rules = new Set(result.violations.map((v) => v.rule));
    expect(rules).toEqual(new Set(["artillery_foot", "artillery_horse"]));
    expect(MAX_BRIGADE_SLOTS_PER_DIVISION).toBe(7);
  });

  it("combat generals count against the artillery caps of the unit they lead", () => {
    const faction = "france";
    // Two foot batteries (at the cap) + a combat general leading a foot battery = 3 > 2.
    const selected = [
      card("foot_0", { faction, unitClass: "artillery_foot" }),
      card("foot_1", { faction, unitClass: "artillery_foot" }),
      card("foot_gen", { faction, unitClass: "general", underlyingUnitClass: "artillery_foot", menRaw: 80 }),
    ];
    const result = checkKnownLimits(selected, faction);
    expect(result.counts.artillery_foot).toBe(3);
    expect(result.violations.some((v) => v.rule === "artillery_foot")).toBe(true);
  });

  it("staff general is based only on exact raw men", () => {
    const faction = "france";
    const result = checkKnownLimits(
      [
        card("staff16", { faction, unitClass: "general", menRaw: 32 }),
        card("staff61", { faction, unitClass: "general", menRaw: 122 }),
        card("combat", { faction, unitClass: "general", menRaw: 33 }),
      ],
      faction,
    );
    expect(result.counts.staff_generals).toBe(2);
    expect(result.counts.combat_generals).toBe(1);
    expect(new Set(result.violations.map((v) => v.rule))).toEqual(new Set(["staff_slot_occupants"]));
  });

  it("missing general men is not guessed", () => {
    const unknown = card("unknown", { faction: "france", unitClass: "general", menRaw: null });
    expect(() => checkKnownLimits([unknown], "france")).toThrow(RuleDataError);
  });

  it("staff and combat general caps are independent", () => {
    const faction = "ntw3_ac_test_x7_001";
    const result = checkKnownLimits(
      [
        card("staff", { faction, unitClass: "general", menRaw: 32 }),
        card("combat_a", { faction, unitClass: "general", menRaw: 80 }),
        card("combat_b", { faction, unitClass: "general", menRaw: 80 }),
      ],
      faction,
    );
    expect(result.violations).toHaveLength(0);
  });

  it("combat general can fill staff slot without using combat cap", () => {
    const faction = "ntw3_ac_test_x7_001";
    const combat = [0, 1, 2].map((i) =>
      card(`combat_${i}`, { faction, unitClass: "general", menRaw: 80 }),
    );
    const withoutSlot = checkKnownLimits(combat, faction);
    expect(new Set(withoutSlot.violations.map((v) => v.rule))).toEqual(
      new Set(["combat_generals_against_cap"]),
    );
    const withSlot = checkKnownLimits(combat, faction, { staffSlotIndex: 0 });
    expect(withSlot.violations).toHaveLength(0);
    expect(withSlot.counts.combat_generals).toBe(3);
    expect(withSlot.counts.combat_generals_against_cap).toBe(2);
    expect(withSlot.counts.staff_slot_occupants).toBe(1);
  });

  it("combat general cannot share staff slot with staff general", () => {
    const faction = "ntw3_ac_test_x7_001";
    const result = checkKnownLimits(
      [
        card("combat", { faction, unitClass: "general", menRaw: 80 }),
        card("staff", { faction, unitClass: "general", menRaw: 32 }),
      ],
      faction,
      { staffSlotIndex: 0 },
    );
    expect(new Set(result.violations.map((v) => v.rule))).toEqual(new Set(["staff_slot_occupants"]));
  });

  it("commander variant uses its underlying unit cap", () => {
    const faction = "france";
    const base = card("ntw3_cav_light_214_018_1397", { faction, unitClass: "cavalry_light", cap: 1 });
    const commander = card("ntw3_cav_light_214_018_1397_com_1463", {
      faction,
      unitClass: "general",
      menRaw: 80,
      cap: 1,
    });
    const result = checkKnownLimits([base, commander], faction);
    const rule = `unit_cap:${faction}:${base.unitKey}`;
    const violation = result.violations.find((v) => v.rule === rule);
    expect(violation).toBeDefined();
    expect(violation!.actual).toBe(2);
    expect(violation!.maximum).toBe(1);
    expect(capGroupKey(commander.unitKey)).toBe(base.unitKey);
  });

  it("multi-cap base unit may be taken up to its cap, and the commander shares it", () => {
    const faction = "france";
    // Base infantry cap 2; commander variant cap 1 but shares the base cap (2).
    const base = card("ntw3_inf_line_005_999_3237", { faction, cap: 2, groupCap: 2 });
    const commander = card("ntw3_inf_line_005_999_3237_com_2400", {
      faction,
      unitClass: "general",
      menRaw: 80,
      cap: 1,
      groupCap: 2,
    });
    const rule = `unit_cap:${faction}:${base.unitKey}`;
    // Two of the base unit is allowed (cap 2), not capped at 1.
    expect(checkKnownLimits([base, base], faction).violations.find((v) => v.rule === rule)).toBeUndefined();
    // Base + base + commander = 3 against a shared cap of 2 -> violation.
    const over = checkKnownLimits([base, base, commander], faction);
    const violation = over.violations.find((v) => v.rule === rule);
    expect(violation).toBeDefined();
    expect(violation!.maximum).toBe(2);
    expect(violation!.actual).toBe(3);
  });
});
