import { describe, expect, it } from "vitest";
import { calculateArmyCost } from "../rules/rules";
import { makeRoster, makeUnit } from "../test/factories";
import {
  type BuildState,
  addWouldExceedBudget,
  autoPickCombatGenerals,
  evaluateAdd,
  hasCombatGeneralInstances,
  indexRoster,
  priceBuild,
  resetCombatGenerals,
} from "./build";

const b = (instances: string[], staff: string | null = null): BuildState => ({
  instances: instances.map((unitKey, i) => ({ id: `i${i}`, unitKey })),
  staffSlotUnitKey: staff,
});

describe("evaluateAdd blocking", () => {
  it("blocks once 31 cards are selected", () => {
    const roster = makeRoster([makeUnit({ unitKey: "a", cost: 10, cap: 99, groupCap: 99 })]);
    const idx = indexRoster(roster);
    const full = b(Array.from({ length: 31 }, () => "a"));
    expect(evaluateAdd(idx, full, idx.byKey.get("a")!, 5)?.reason).toMatch(/full/i);
  });

  it("allows a copy whose base cost reaches exactly 10,000", () => {
    const a = makeUnit({ unitKey: "a", cost: 5000, cap: 2, groupCap: 2 });
    const idx = indexRoster(makeRoster([a]));
    // One selected (5000); adding the 2nd reaches 10,000 base — exactly at the cap.
    expect(evaluateAdd(idx, b(["a"]), a, 5)).toBeNull();
  });

  it("no longer blocks a card that pushes the cost over 10,000, but flags it as over budget", () => {
    // The 10,000 ceiling is soft: the unit may be selected, and addWouldExceedBudget
    // reports it so the grid can colour its cost red.
    const a = makeUnit({ unitKey: "a", cost: 5000, cap: 2, groupCap: 2, placement: { division: 1, brigade: 1 } });
    const bcard = makeUnit({ unitKey: "bb", cost: 6000, cap: 1, groupCap: 1, placement: { division: 1, brigade: 2 } });
    const idx = indexRoster(makeRoster([a, bcard]));
    expect(evaluateAdd(idx, b(["a"]), bcard, 5)).toBeNull();
    expect(addWouldExceedBudget(idx, b(["a"]), bcard)).toBe(true);
  });

  it("flags a copy whose face-value running cost would exceed 10,000 even before its own discount", () => {
    // Recruitment is face-value: a copy must fit at full price on top of the current
    // discounted total, *not* counting the discount completing its formation would
    // earn. a (9,500) is in; sol (600) would complete the brigade for a 101 rebate
    // (net 9,999), but you cannot take it because 9,500 + 600 = 10,100 at face value.
    const a = makeUnit({ unitKey: "a", cost: 9500, cap: 1, groupCap: 1, placement: { division: 1, brigade: 1 } });
    const sol = makeUnit({ unitKey: "sol", cost: 600, cap: 1, groupCap: 1, placement: { division: 1, brigade: 1 } });
    const idx = indexRoster(makeRoster([a, sol]));
    expect(evaluateAdd(idx, b(["a"]), sol, 5)).toBeNull();
    expect(addWouldExceedBudget(idx, b(["a"]), sol)).toBe(true);
  });

  it("allows a copy that fits once already-earned formation discounts are applied", () => {
    // Two completed brigades earn discounts that pull the running cost under 10,000,
    // so a unit whose *base* total would be 10,100 is still affordable (current
    // discounted cost 8,820 + 1,100 = 9,920). Mirrors the Toutchkov / Soulima case.
    const p = makeUnit({ unitKey: "p", cost: 1500, cap: 3, groupCap: 3, placement: { division: 1, brigade: 1 } });
    const q = makeUnit({ unitKey: "q", cost: 1500, cap: 3, groupCap: 3, placement: { division: 1, brigade: 2 } });
    const z = makeUnit({ unitKey: "z", cost: 1100, cap: 1, groupCap: 1, placement: { division: 1, brigade: 3 } });
    const idx = indexRoster(makeRoster([p, q, z]));
    expect(evaluateAdd(idx, b(["p", "p", "p", "q", "q", "q"]), z, 5)).toBeNull();
  });

  it("blocks the same combat general twice (one general per unit)", () => {
    const g = makeUnit({
      unitKey: "g", cost: 100, cap: 1, groupCap: 1, isGeneral: true, generalKind: "combat", unitClass: "general",
    });
    const idx = indexRoster(makeRoster([g]));
    expect(evaluateAdd(idx, b(["g"]), g, 5)?.reason).toMatch(/only one combat general/i);
  });

  it("blocks a second combat general for the same base unit even when its cap allows two copies", () => {
    // Base unit cap 2: two plain copies are fine, but only one may carry a general.
    const base = makeUnit({ unitKey: "u", cost: 500, cap: 2, groupCap: 2, capGroupKey: "u", baseUnitKey: "u" });
    const c1 = makeUnit({
      unitKey: "u_com_1", cost: 800, cap: 2, groupCap: 2, capGroupKey: "u", baseUnitKey: "u",
      isGeneral: true, generalKind: "combat", unitClass: "general",
    });
    const c2 = makeUnit({
      unitKey: "u_com_2", cost: 700, cap: 2, groupCap: 2, capGroupKey: "u", baseUnitKey: "u",
      isGeneral: true, generalKind: "combat", unitClass: "general",
    });
    const idx = indexRoster(makeRoster([base, c1, c2]));
    // One general already on the unit -> a different general for the same unit is blocked.
    expect(evaluateAdd(idx, b(["u_com_1"]), c2, 5)?.reason).toMatch(/only one combat general/i);
    // But a plain second copy (no general) is still allowed by the cap of 2.
    expect(evaluateAdd(idx, b(["u_com_1"]), base, 5)).toBeNull();
  });

  it("enforces foot-artillery limit of 2", () => {
    const art = makeUnit({ unitKey: "f", unitClass: "artillery_foot", underlyingUnitClass: "artillery_foot", cap: 9, groupCap: 9, cost: 100 });
    const idx = indexRoster(makeRoster([art]));
    expect(evaluateAdd(idx, b(["f", "f"]), art, 5)?.reason).toMatch(/foot-artillery/i);
  });
});

describe("autoPickCombatGenerals", () => {
  // A faction key without "_ac_" so calculateArmyCost returns the plain base cost
  // (no formation discounts). Both combat generals here cost *less* than the plain
  // copy, so each swap lowers the build cost (a real combat general can be cheaper or
  // dearer than the unit it leads); auto-general prefers the largest cost reduction.
  const FK = "ntw3_zz_test_001";
  const base = (unitKey: string, cost: number) =>
    makeUnit({ unitKey, factionKey: FK, cost, cap: 2, groupCap: 2, capGroupKey: unitKey, baseUnitKey: unitKey });
  const general = (unitKey: string, group: string, cost: number, partial = {}) =>
    makeUnit({
      unitKey, factionKey: FK, cost, cap: 2, groupCap: 2, capGroupKey: group, baseUnitKey: group,
      isGeneral: true, isCommanderVariant: true, generalKind: "combat", unitClass: "general", ...partial,
    });
  const roster = () =>
    indexRoster(makeRoster([base("a", 500), base("bb", 500), general("a_com", "a", 400), general("bb_com", "bb", 300)], FK));

  it("replaces a selected unit with its combat general (never adds new units)", () => {
    // Cap of 1 -> swap the unit whose upgrade lowers the cost most (bb: -200 vs a: -100).
    const idx = roster();
    const { replacements } = autoPickCombatGenerals(idx, b(["a", "bb"]), 1);
    expect(replacements).toEqual([{ instanceId: "i1", generalUnitKey: "bb_com" }]);
  });

  it("upgrades every eligible unit when the cap allows", () => {
    const idx = roster();
    const { replacements } = autoPickCombatGenerals(idx, b(["a", "bb"]), 4);
    expect(replacements).toEqual([
      { instanceId: "i1", generalUnitKey: "bb_com" },
      { instanceId: "i0", generalUnitKey: "a_com" },
    ]);
  });

  it("leaves existing combat generals untouched and uses only the remaining cap", () => {
    // "a" already carries a_com; only bb can still be upgraded.
    const idx = roster();
    const { replacements } = autoPickCombatGenerals(idx, b(["a", "bb", "a_com"]), 2);
    expect(replacements).toEqual([{ instanceId: "i1", generalUnitKey: "bb_com" }]);
  });

  it("only upgrades units that are already selected", () => {
    const idx = roster();
    const { replacements } = autoPickCombatGenerals(idx, b(["a"]), 4);
    expect(replacements).toEqual([{ instanceId: "i0", generalUnitKey: "a_com" }]);
  });

  it("does nothing when the remaining cap is already used", () => {
    const idx = roster();
    const { replacements } = autoPickCombatGenerals(idx, b(["a", "bb", "a_com"]), 1);
    expect(replacements).toEqual([]);
  });

  // Four single-copy units in division 1, each costing 2,600 (division roster cost
  // 10,400 → division discount 312). At face value the build is over budget — the
  // division completes only on the last unit, but 7,800 + 2,600 = 10,400 > 10,000, so
  // you cannot take it and the 312 discount is never credited. Cheaper combat generals
  // (per-unit costs) lower the running total enough to make the last unit affordable,
  // completing the division. Mirrors Eugène's 1st division + staff commander.
  const ACFK = "ntw3_ac_test_x5_001";
  const divUnit = (key: string, brigade: number, cost: number) =>
    makeUnit({ unitKey: key, factionKey: ACFK, cost, cap: 1, groupCap: 1, capGroupKey: key, baseUnitKey: key, placement: { division: 1, brigade } });
  const divGeneral = (key: string, group: string, brigade: number, cost: number) =>
    makeUnit({
      unitKey: key, factionKey: ACFK, cost, cap: 1, groupCap: 1, capGroupKey: group, baseUnitKey: group,
      isGeneral: true, isCommanderVariant: true, generalKind: "combat", unitClass: "general",
      placement: { division: 1, brigade },
    });
  const divRoster = (g: [number, number, number, number]) =>
    indexRoster(makeRoster([
      divUnit("a", 1, 2600), divUnit("c", 2, 2600), divUnit("d", 3, 2600), divUnit("e", 4, 2600),
      divGeneral("a_com", "a", 1, g[0]), divGeneral("c_com", "c", 2, g[1]),
      divGeneral("d_com", "d", 3, g[2]), divGeneral("e_com", "e", 4, g[3]),
    ], ACFK));

  it("uses cost-reducing combat generals to make an over-budget division affordable", () => {
    // Without generals the division is over budget and earns no discount (final 10,400).
    // Each general is 2,400 (−200); taking all four drops the base to 9,600, the last
    // unit becomes affordable, the division completes and the 312 discount applies.
    const idx = divRoster([2400, 2400, 2400, 2400]);
    const build = b(["a", "c", "d", "e"]);
    expect(priceBuild(idx, build).appliedDiscount).toBe(0);
    expect(priceBuild(idx, build).finalCost).toBe(10400);
    const { replacements } = autoPickCombatGenerals(idx, build, 4);
    expect(replacements).toHaveLength(4);
    const swap = new Map(replacements.map((r) => [r.instanceId, r.generalUnitKey]));
    const after: BuildState = { ...build, instances: build.instances.map((i) => (swap.has(i.id) ? { id: i.id, unitKey: swap.get(i.id)! } : i)) };
    const price = priceBuild(idx, after);
    expect(price.appliedDiscount).toBe(312); // division now completes
    expect(price.finalCost).toBe(9288); // 9,600 base - 312
  });

  it("skips cost-increasing combat generals, taking fewer than the cap", () => {
    // Two cheaper generals (a, c: −400 each) complete the division (9,600 base → 9,288);
    // the other two are dearer (+100, +200), so taking them would only raise the cost.
    // Auto-general takes just the two cost reducers, well under the combat cap of four.
    const idx = divRoster([2200, 2200, 2700, 2800]);
    const build = b(["a", "c", "d", "e"]);
    const { replacements } = autoPickCombatGenerals(idx, build, 4);
    expect(replacements.map((r) => r.generalUnitKey).sort()).toEqual(["a_com", "c_com"]);
    const swap = new Map(replacements.map((r) => [r.instanceId, r.generalUnitKey]));
    const after: BuildState = { ...build, instances: build.instances.map((i) => (swap.has(i.id) ? { id: i.id, unitKey: swap.get(i.id)! } : i)) };
    const price = priceBuild(idx, after);
    expect(price.appliedDiscount).toBe(312);
    expect(price.finalCost).toBe(9288);
  });

  it("upgrades artillery units without tripping the class cap (a swap is class-neutral)", () => {
    // Two foot-artillery units fill the foot-artillery cap of 2; replacing each with
    // its combat general keeps the foot-artillery count unchanged, so both upgrade.
    const af = (unitKey: string, group: string, isGen = false) =>
      makeUnit({
        unitKey, factionKey: FK, cost: 400, cap: 9, groupCap: 9, capGroupKey: group, baseUnitKey: group,
        unitClass: isGen ? "general" : "artillery_foot", underlyingUnitClass: "artillery_foot",
        isGeneral: isGen, generalKind: isGen ? "combat" : null,
      });
    const idx = indexRoster(makeRoster([af("f1", "f1"), af("f2", "f2"), af("f1_com", "f1", true), af("f2_com", "f2", true)], FK));
    const { replacements } = autoPickCombatGenerals(idx, b(["f1", "f2"]), 4);
    expect(replacements.map((r) => r.generalUnitKey).sort()).toEqual(["f1_com", "f2_com"]);
  });
});

describe("resetCombatGenerals", () => {
  const FK = "ntw3_zz_test_001";
  const base = (unitKey: string) =>
    makeUnit({ unitKey, factionKey: FK, cost: 500, cap: 2, groupCap: 2, capGroupKey: unitKey, baseUnitKey: unitKey });
  const general = (unitKey: string, group: string) =>
    makeUnit({
      unitKey, factionKey: FK, cost: 800, cap: 2, groupCap: 2, capGroupKey: group, baseUnitKey: group,
      isGeneral: true, isCommanderVariant: true, generalKind: "combat", unitClass: "general",
    });
  const idx = () => indexRoster(makeRoster([base("a"), base("bb"), general("a_com", "a"), general("bb_com", "bb")], FK));

  it("swaps every combat general instance back to its base unit, preserving ids and order", () => {
    const i = idx();
    const build = b(["a_com", "bb", "bb_com"]);
    const reset = resetCombatGenerals(i, build);
    expect(reset.instances).toEqual([
      { id: "i0", unitKey: "a" },
      { id: "i1", unitKey: "bb" },
      { id: "i2", unitKey: "bb" },
    ]);
  });

  it("leaves the commander (staff slot) untouched", () => {
    const i = idx();
    const build = b(["a_com"], "bb_com");
    expect(resetCombatGenerals(i, build).staffSlotUnitKey).toBe("bb_com");
  });

  it("hasCombatGeneralInstances reflects whether any unit slot holds a combat general", () => {
    const i = idx();
    expect(hasCombatGeneralInstances(i, b(["a", "bb"]))).toBe(false);
    expect(hasCombatGeneralInstances(i, b(["a", "bb_com"]))).toBe(true);
  });
});

describe("priceBuild soft cost ceiling", () => {
  // "_ac_" faction so formation discounts apply.
  const FK = "ntw3_ac_test_x5_001";
  const u = (unitKey: string, cost: number, brigade: number, cap = 1) =>
    makeUnit({ unitKey, factionKey: FK, cost, cap, groupCap: cap, capGroupKey: unitKey, baseUnitKey: unitKey, placement: { division: 1, brigade } });

  it("matches calculateArmyCost when nothing is over budget", () => {
    const idx = indexRoster(makeRoster([u("x", 1000, 1, 2)], FK));
    const build = b(["x", "x"]);
    const expected = calculateArmyCost([idx.byKey.get("x")!, idx.byKey.get("x")!], idx.roster.cards, FK);
    expect(priceBuild(idx, build).finalCost).toBe(expected.finalCost);
  });

  it("withholds the discount from a group completed only by an over-budget unit", () => {
    // e (9,000) then x (→10,000, the last affordable card) then a 2nd x (→11,000,
    // over budget). The 2nd x is what completes the x-brigade/division, so the build
    // pays full price (11,000) with no discount, even though the unaffordable-blind
    // calculateArmyCost would rebate it.
    const idx = indexRoster(makeRoster([u("e", 9000, 9), u("x", 1000, 1, 2)], FK));
    const build = b(["e", "x", "x"]);
    const full = calculateArmyCost(
      [idx.byKey.get("e")!, idx.byKey.get("x")!, idx.byKey.get("x")!],
      idx.roster.cards,
      FK,
    );
    expect(full.finalCost).toBeLessThan(11000); // discount applies when affordability is ignored
    expect(priceBuild(idx, build).finalCost).toBe(11000); // suppressed: completion needed the over-budget copy
  });

  it("counts the commander first, so its cost can make a division-completing unit unaffordable", () => {
    // One brigade/division of 4 copies (4×2,500 = 10,000 base, 300 discount).
    const gen = makeUnit({
      unitKey: "gen", factionKey: FK, cost: 600, isGeneral: true, generalKind: "staff",
      unitClass: "general", placement: null, capGroupKey: "gen", baseUnitKey: "gen",
    });
    const idx = indexRoster(makeRoster([gen, u("u", 2500, 1, 4)], FK));
    // Without a commander the four copies complete the division within budget (10,000 → 9,700).
    expect(priceBuild(idx, b(["u", "u", "u", "u"])).finalCost).toBe(9700);
    // Taking the commander first spends 600, so the 4th copy hits 10,600 and is over
    // budget: the division never legitimately completes, so no discount is credited.
    expect(priceBuild(idx, b(["u", "u", "u", "u"], "gen")).finalCost).toBe(10600);
  });
});
