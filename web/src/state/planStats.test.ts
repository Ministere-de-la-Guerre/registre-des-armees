import { describe, expect, it } from "vitest";
import { MAX_BUILD_COST } from "../rules/rules";
import { makeRoster, makeUnit } from "../test/factories";
import { type BuildState, indexRoster } from "./build";
import { type PlanArmyInput, planStats } from "./planStats";

const cap = { cap: 99, groupCap: 99 };
const roster = indexRoster(
  makeRoster([
    makeUnit({ unitKey: "line", cost: 400, finalMen: 100, abilities: { canFormSquare: true, hasStamina: true, isShockResistant: false, canInspire: false, hasGuerrillaDeployment: false, canPlaceStakes: false, canPlaceMines: false, scaresEnemies: false, canBuildBarricades: false }, ...cap }),
    makeUnit({ unitKey: "skirm", unitClass: "infantry_skirmishers", underlyingUnitClass: "infantry_skirmishers", cost: 300, finalMen: 50, ...cap }),
    makeUnit({ unitKey: "hus", speedCode: "C3", unitClass: "cavalry_light", underlyingUnitClass: "cavalry_light", cost: 500, finalMen: 60, ...cap }),
    makeUnit({ unitKey: "drag", speedCode: "C2", unitClass: "cavalry_standard", underlyingUnitClass: "cavalry_standard", cost: 500, finalMen: 60, ...cap }),
    makeUnit({ unitKey: "foot6", speedCode: "F3", unitClass: "artillery_foot", underlyingUnitClass: "artillery_foot", cost: 600, finalMen: 40, guns: 4, gunType: "cannon_6_pounder_France", ...cap }),
    makeUnit({ unitKey: "foot12", speedCode: "F3", unitClass: "artillery_foot", underlyingUnitClass: "artillery_foot", cost: 600, finalMen: 40, guns: 6, gunType: "cannon_12_pounder_France", ...cap }),
    makeUnit({ unitKey: "horse6", speedCode: "H2", unitClass: "artillery_horse", underlyingUnitClass: "artillery_horse", cost: 600, finalMen: 30, guns: 4, gunType: "cannon_6_pounder_horse_France", ...cap }),
    makeUnit({
      unitKey: "horse6_com_x",
      speedCode: "H3",
      unitClass: "general",
      isGeneral: true,
      generalKind: "combat",
      underlyingUnitClass: "artillery_horse",
      cost: 700,
      finalMen: 31,
      guns: 4,
      gunType: "cannon_6_pounder_horse_France",
      cap: 1,
      groupCap: 1,
    }),
    makeUnit({
      unitKey: "hus_com_x",
      speedCode: "C4",
      unitClass: "general",
      isGeneral: true,
      generalKind: "combat",
      underlyingUnitClass: "cavalry_light",
      cost: 700,
      finalMen: 61,
      cap: 1,
      groupCap: 1,
    }),
    makeUnit({ unitKey: "staff", unitClass: "general", underlyingUnitClass: "general", isGeneral: true, generalKind: "staff", cost: 200, finalMen: 16, cap: 1, groupCap: 1 }),
  ]),
);

const army = (instances: string[], staff: string | null = null): PlanArmyInput => ({
  index: roster,
  build: { instances: instances.map((unitKey, i) => ({ id: `i${i}`, unitKey })), staffSlotUnitKey: staff } as BuildState,
});

describe("planStats", () => {
  it("ignores empty slots and scales the budget with armies present", () => {
    const s = planStats([army(["line"]), null, army(["line", "line"]), null]);
    expect(s.perArmy.map((a) => a !== null)).toEqual([true, false, true, false]);
    expect(s.armies).toBe(2);
    expect(s.budget).toBe(2 * MAX_BUILD_COST);
    expect(s.cards).toBe(3);
    expect(s.men).toBe(300);
    expect(s.cost).toBe(1200);
    expect(planStats([null, null]).budget).toBe(0);
  });

  it("counts a combat general by the cavalry he leads, and the commander too", () => {
    const s = planStats([army(["hus", "hus_com_x", "drag"], "staff")]);
    expect(s.cavalry.byClass.light).toMatchObject({ cards: 2, men: 121, byArmy: [2] });
    // The general counts under the unit he leads but keeps his own speed tag.
    expect(s.cavalry.byClass.light.bySpeed).toEqual({ C3: 1, C4: 1 });
    expect(s.cavalry.byClass.line.bySpeed).toEqual({ C2: 1 });
    expect(s.cavalry.byClass.line.cards).toBe(1);
    expect(s.cavalry.totalCards).toBe(3);
    expect(s.cavalry.totalMen).toBe(181);
    expect(s.combatGens).toBe(1);
    expect(s.share.staff).toEqual({ cards: 1, men: 16, gold: 200 });
    // Listed prices; the combat general counts under the cavalry he leads.
    expect(s.share.cavalry.gold).toBe(1700);
    expect(s.share.cavalry.cards).toBe(3);
  });

  it("tallies infantry classes and squares", () => {
    const s = planStats([army(["line", "line", "skirm"])]);
    expect(s.infantry.byClass.line.cards).toBe(2);
    expect(s.infantry.byClass.skirmishers.cards).toBe(1);
    expect(s.infantry.totalCards).toBe(3);
    expect(s.squares).toBe(3);
    expect(s.infantryForSquares).toBe(2); // skirmishers are not in the denominator
    expect(s.abilities.stamina).toEqual({ cards: 2, byArmy: [2] });
    expect(s.infantry.byClass.skirmishers.bySpeed).toEqual({ L3: 1 });
  });

  it("sums guns by arm and by type, including an artillery general's guns", () => {
    const s = planStats([army(["foot6", "foot12", "horse6"]), army(["foot6", "horse6_com_x"])]);
    expect(s.guns.total).toBe(4 + 6 + 4 + 4 + 4);
    expect(s.guns.byArm.foot).toEqual({ guns: 14, batteries: 3, byArmy: [10, 4], bySpeed: { F3: 3 } });
    expect(s.guns.byArm.horse).toEqual({ guns: 8, batteries: 2, byArmy: [4, 4], bySpeed: { H2: 1, H3: 1 } });
    expect(s.guns.byArm.fixed.guns).toBe(0);
    expect(s.guns.byType.map((r) => [r.arm, r.label, r.guns, r.batteries])).toEqual([
      ["foot", "6-pdr cannon", 8, 2],
      ["foot", "12-pdr cannon", 6, 1],
      ["horse", "6-pdr cannon", 8, 2],
    ]);
    expect(s.guns.byType[0].byArmy).toEqual([4, 4]);
    expect(s.guns.byType[0].bySpeed).toEqual({ F3: 2 });
    expect(s.guns.byType[2].bySpeed).toEqual({ H2: 1, H3: 1 });
    expect(s.share.artillery.cards).toBe(5);
    expect(s.share.artillery.gold).toBe(3100);
  });

  it("warns per army about budget overruns and rule violations", () => {
    const s = planStats([army(["foot6", "foot6", "foot6", "foot6", "foot6", "foot6", "foot6", "foot6", "foot6", "foot6", "foot6", "foot6", "foot6", "foot6", "foot6", "foot6", "foot6"]), army(["line"])]);
    const w0 = s.warnings.filter((w) => w.slotIndex === 0).map((w) => w.message);
    expect(w0).toEqual(["200 over budget", "Foot artillery: 17 selected, maximum is 2."]);
    expect(s.warnings.some((w) => w.slotIndex === 1)).toBe(false);
  });

  it("reports ToW corps only for ToW rosters", () => {
    const s = planStats([army(["line"])]);
    expect(s.perArmy[0]?.towCorps).toBeNull();
    expect(s.perArmy[0]?.combatCap).toBeGreaterThanOrEqual(1);
  });

  it("reports ToW corps count and the over-four flag", () => {
    const towCards = ["a", "b", "c", "d", "e"].map((id) => makeUnit({ unitKey: `tow_${id}`, factionKey: "ntw3_tow_test_x5_001", towSourceCorpsId: id, cost: 100, finalMen: 10, ...cap }));
    const tow = indexRoster(makeRoster(towCards, "ntw3_tow_test_x5_001"));
    const towArmy = (keys: string[]): PlanArmyInput => ({
      index: tow,
      build: { instances: keys.map((unitKey, i) => ({ id: `i${i}`, unitKey })), staffSlotUnitKey: null } as BuildState,
    });
    const four = planStats([towArmy(["tow_a", "tow_a", "tow_b", "tow_c", "tow_d"])]);
    expect(four.perArmy[0]?.towCorps).toEqual({ count: 4, max: 4, over: false });
    const five = planStats([towArmy(["tow_a", "tow_b", "tow_c", "tow_d", "tow_e"])]);
    expect(five.perArmy[0]?.towCorps).toEqual({ count: 5, max: 4, over: true });
  });

  it("groups artillery with no gun type under \"Unknown guns\", last in its arm", () => {
    const withUnknown = indexRoster(
      makeRoster([
        makeUnit({ unitKey: "mystery", speedCode: "F3", unitClass: "artillery_foot", underlyingUnitClass: "artillery_foot", cost: 500, finalMen: 30, guns: 3, gunType: null, ...cap }),
        makeUnit({ unitKey: "foot6", speedCode: "F3", unitClass: "artillery_foot", underlyingUnitClass: "artillery_foot", cost: 600, finalMen: 40, guns: 4, gunType: "cannon_6_pounder_France", ...cap }),
      ]),
    );
    const input: PlanArmyInput = {
      index: withUnknown,
      build: { instances: ["mystery", "foot6", "mystery"].map((unitKey, i) => ({ id: `i${i}`, unitKey })), staffSlotUnitKey: null } as BuildState,
    };
    const s = planStats([input]);
    expect(s.guns.total).toBe(10);
    expect(s.guns.byType.map((r) => [r.arm, r.label, r.guns, r.batteries])).toEqual([
      ["foot", "6-pdr cannon", 4, 1],
      ["foot", "Unknown guns", 6, 2],
    ]);
  });

  it("does not count an artillery card with no guns as a battery", () => {
    const gunless = indexRoster(
      makeRoster([makeUnit({ unitKey: "empty_gun", speedCode: "F3", unitClass: "artillery_foot", underlyingUnitClass: "artillery_foot", cost: 500, finalMen: 30, guns: 0, gunType: null, ...cap })]),
    );
    const input: PlanArmyInput = {
      index: gunless,
      build: { instances: [{ id: "i0", unitKey: "empty_gun" }], staffSlotUnitKey: null } as BuildState,
    };
    const s = planStats([input]);
    expect(s.guns.total).toBe(0);
    expect(s.guns.byArm.foot.batteries).toBe(0);
    expect(s.guns.byType).toEqual([]);
    // It is still a card of the army and part of the artillery share.
    expect(s.cards).toBe(1);
    expect(s.share.artillery.cards).toBe(1);
  });

});
