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
  isCavalryOnlyCorps,
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

  it("13. Davout (a11_x5_117): sapper/skirmisher brigades of the support division earn a brigade discount", () => {
    const faction = "ntw3_ac_a11_x5_117";
    const inf = card("inf", { faction, division: 1, brigade: 1, cost: 500, cap: 2 });
    // Division 7 = the final artillery-support division: artillery reserve brigades
    // plus a sapper brigade and a skirmisher brigade.
    const art = card("art", { faction, unitClass: "artillery_foot", division: 7, brigade: 1, cost: 100, cap: 2 });
    const sapper = card("ntw3_inf_grena_117_999_0523", {
      faction,
      unitClass: "infantry_grenadiers",
      division: 7,
      brigade: 5,
      cost: 276,
      cap: 2,
      name: "Sapeurs [G4]",
    });
    const skirm = card("ntw3_inf_skirm_117_999_4780", {
      faction,
      unitClass: "infantry_skirmishers",
      division: 7,
      brigade: 6,
      cost: 185,
      cap: 6,
      name: "Tirailleurs [S2]",
    });
    const roster = [inf, art, sapper, skirm];
    const selected = [
      inf,
      inf,
      art,
      art, // completing the artillery brigade grants nothing
      sapper,
      sapper,
      ...Array<RulesUnit>(6).fill(skirm),
    ];
    const result = calculateArmyCost(selected, roster, faction);
    const byGroup = result.completedGroups.map((g) => `${g.groupType}:${g.divisionId}:${g.brigadeId}`);
    // Combat division 1 discounts as usual; the sapper (7:5) and skirmisher (7:6)
    // brigades each earn a brigade discount; the artillery reserve brigade (7:1) does not.
    expect(byGroup).toContain("division:1:null");
    expect(byGroup).toContain("brigade:7:5");
    expect(byGroup).toContain("brigade:7:6");
    expect(byGroup).not.toContain("brigade:7:1");
    // 10 (div 1) + floor(552*1/100)=5 (sappers) + floor(1110*5/100)=55 (skirmishers).
    expect(result.normalDiscount).toBe(10 + 5 + 55);
  });

  it("13. Davout: the support division's sapper/skirmisher brigades discount independently", () => {
    const faction = "ntw3_ac_a11_x5_117";
    const art = card("art", { faction, unitClass: "artillery_foot", division: 7, brigade: 1, cost: 100, cap: 2 });
    const sapper = card("ntw3_inf_grena_117_999_0523", {
      faction,
      unitClass: "infantry_grenadiers",
      division: 7,
      brigade: 5,
      cost: 276,
      cap: 2,
      name: "Sapeurs [G4]",
    });
    const skirm = card("ntw3_inf_skirm_117_999_4780", {
      faction,
      unitClass: "infantry_skirmishers",
      division: 7,
      brigade: 6,
      cost: 185,
      cap: 6,
      name: "Tirailleurs [S2]",
    });
    const roster = [art, sapper, skirm];
    // Every skirmisher but no sapper -> the skirmisher brigade alone credits.
    const skirmishersOnly = calculateArmyCost(Array<RulesUnit>(6).fill(skirm), roster, faction);
    expect(skirmishersOnly.completedGroups.map((g) => `${g.groupType}:${g.divisionId}:${g.brigadeId}`)).toEqual([
      "brigade:7:6",
    ]);
    expect(skirmishersOnly.normalDiscount).toBe(55);
    expect(skirmishersOnly.finalCost).toBe(1110 - 55);
    // Every sapper but no skirmisher -> the sapper brigade alone credits.
    const sappersOnly = calculateArmyCost([sapper, sapper], roster, faction);
    expect(sappersOnly.completedGroups.map((g) => `${g.groupType}:${g.divisionId}:${g.brigadeId}`)).toEqual([
      "brigade:7:5",
    ]);
    expect(sappersOnly.normalDiscount).toBe(5);
    expect(sappersOnly.finalCost).toBe(552 - 5);
    // A partially filled brigade still credits nothing.
    const partial = calculateArmyCost([sapper], roster, faction);
    expect(partial.completedGroups).toHaveLength(0);
    expect(partial.finalCost).toBe(276);
    // Both brigades filled -> each credits its own brigade discount.
    const both = calculateArmyCost([sapper, sapper, ...Array<RulesUnit>(6).fill(skirm)], roster, faction);
    expect(both.normalDiscount).toBe(5 + 55);
    expect(both.finalCost).toBe(552 + 1110 - 60);
  });

  it("the sapper/skirmisher support-division discount is scoped to the exception corps only", () => {
    const faction = "ntw3_ac_test_x5_001"; // not in the exception set
    const inf = card("inf", { faction, division: 1, brigade: 1, cost: 500, cap: 2 });
    const art = card("art", { faction, unitClass: "artillery_foot", division: 7, brigade: 1, cost: 100, cap: 2 });
    const sapper = card("ntw3_inf_grena_sap", {
      faction,
      unitClass: "infantry_grenadiers",
      division: 7,
      brigade: 5,
      cost: 276,
      cap: 2,
      name: "Sapeurs [G4]",
    });
    const result = calculateArmyCost([inf, inf, art, art, sapper, sapper], [inf, art, sapper], faction);
    // Only the combat division discounts; the support division earns nothing here.
    expect(result.completedGroups.map((g) => g.divisionId)).toEqual([1]);
    expect(result.normalDiscount).toBe(10);
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

  it("a cavalry-only corps takes two horse batteries instead of one", () => {
    const faction = "ntw3_ac_test_x5_001";
    // Reserve-cavalry corps roster: cavalry + horse artillery, no infantry.
    const roster = [
      card("staff", { faction, unitClass: "general", menRaw: 16 }),
      card("cav_0", { faction, unitClass: "cavalry_heavy" }),
      card("cav_1", { faction, unitClass: "cavalry_light" }),
      card("horse_0", { faction, unitClass: "artillery_horse" }),
      card("horse_1", { faction, unitClass: "artillery_horse" }),
      card("horse_2", { faction, unitClass: "artillery_horse" }),
    ];
    expect(isCavalryOnlyCorps(roster, faction)).toBe(true);

    const two = [card("horse_0", { faction, unitClass: "artillery_horse" }), card("horse_1", { faction, unitClass: "artillery_horse" })];
    expect(checkKnownLimits(two, faction, { recruitable: roster }).valid).toBe(true);
    // Without the roster the cap falls back to the standard 1.
    expect(checkKnownLimits(two, faction).violations.map((v) => v.rule)).toEqual(["artillery_horse"]);

    const three = [...two, card("horse_2", { faction, unitClass: "artillery_horse" })];
    const over = checkKnownLimits(three, faction, { recruitable: roster });
    expect(over.violations).toEqual([{ rule: "artillery_horse", actual: 3, maximum: 2 }]);
  });

  it("a corps with any infantry keeps the single horse-artillery cap", () => {
    const faction = "ntw3_ac_test_x5_001";
    const roster = [
      card("cav_0", { faction, unitClass: "cavalry_heavy" }),
      card("inf_0", { faction, unitClass: "infantry_line" }),
      card("horse_0", { faction, unitClass: "artillery_horse" }),
      card("horse_1", { faction, unitClass: "artillery_horse" }),
    ];
    expect(isCavalryOnlyCorps(roster, faction)).toBe(false);
    const two = [card("horse_0", { faction, unitClass: "artillery_horse" }), card("horse_1", { faction, unitClass: "artillery_horse" })];
    expect(checkKnownLimits(two, faction, { recruitable: roster }).violations.map((v) => v.rule)).toEqual([
      "artillery_horse",
    ]);
  });

  it("a cavalry corps is judged by the units its generals lead, and foot artillery does not disqualify it", () => {
    const faction = "ntw3_ac_test_x5_001";
    // A cavalry corps may still hold a foot battery (12. Murat / RC does) — only
    // infantry disqualifies it. A combat general counts as the unit it leads.
    const cavalryCorps = [
      card("cav_0", { faction, unitClass: "cavalry_heavy" }),
      card("cav_0_com_1", { faction, unitClass: "general", underlyingUnitClass: "cavalry_heavy", menRaw: 80 }),
      card("foot_0", { faction, unitClass: "artillery_foot" }),
      card("horse_0", { faction, unitClass: "artillery_horse" }),
    ];
    expect(isCavalryOnlyCorps(cavalryCorps, faction)).toBe(true);

    // An infantry-leading combat general does disqualify it.
    const withInfantryGeneral = [
      ...cavalryCorps,
      card("inf_0_com_1", { faction, unitClass: "general", underlyingUnitClass: "infantry_line", menRaw: 80 }),
    ];
    expect(isCavalryOnlyCorps(withInfantryGeneral, faction)).toBe(false);

    // Another corps' cards are ignored.
    const other = [...cavalryCorps, card("inf_x", { faction: "ntw3_ac_test_x5_002", unitClass: "infantry_line" })];
    expect(isCavalryOnlyCorps(other, faction)).toBe(true);
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
    expect(new Set(result.violations.map((v) => v.rule))).toEqual(new Set(["staff_generals"]));
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

  // The game allows this and real replays contain it: a corps commanded by a combat
  // general that also fields its own staff general as an ordinary unit. Only the card
  // actually in the slot occupies it.
  it("a staff general recruited as a unit does not occupy the staff slot", () => {
    const faction = "ntw3_ac_test_x7_001";
    const result = checkKnownLimits(
      [
        card("combat", { faction, unitClass: "general", menRaw: 80 }),
        card("staff", { faction, unitClass: "general", menRaw: 32 }),
      ],
      faction,
      { staffSlotIndex: 0 },
    );
    expect(result.violations).toHaveLength(0);
    expect(result.counts.staff_slot_occupants).toBe(1);
    expect(result.counts.staff_generals).toBe(1);
    // ...and it is not a free combat general either — it is simply a unit.
    expect(result.counts.combat_generals_against_cap).toBe(0);
  });

  it("the ordinary case is unchanged: staff general in the slot, combat generals beside it", () => {
    const faction = "ntw3_ac_test_x7_001";
    const result = checkKnownLimits(
      [
        card("staff", { faction, unitClass: "general", menRaw: 32 }),
        card("combat", { faction, unitClass: "general", menRaw: 80 }),
      ],
      faction,
      { staffSlotIndex: 0 },
    );
    expect(result.violations).toHaveLength(0);
    expect(result.counts.staff_slot_occupants).toBe(1);
    expect(result.counts.combat_generals_against_cap).toBe(1);
  });

  // Never two staff generals, however they are placed: one commanding and one
  // recruited as a unit is still two.
  it("rejects a second staff general whether or not one holds the slot", () => {
    const faction = "ntw3_ac_test_x7_001";
    const pair = [
      card("staff_a", { faction, unitClass: "general", menRaw: 32 }),
      card("staff_b", { faction, unitClass: "general", menRaw: 122 }),
    ];
    for (const opts of [{}, { staffSlotIndex: 0 }]) {
      const result = checkKnownLimits(pair, faction, opts);
      expect(result.counts.staff_generals).toBe(2);
      expect(result.violations.map((v) => v.rule)).toContain("staff_generals");
    }
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
