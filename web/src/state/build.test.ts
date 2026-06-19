import { describe, expect, it } from "vitest";
import { calculateArmyCost } from "../rules/rules";
import { makeRoster, makeUnit } from "../test/factories";
import {
  type BuildState,
  addWouldExceedBudget,
  autoPickCombatGenerals,
  evaluateAdd,
  indexRoster,
  priceBuild,
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

  it("flags a copy whose running cost would exceed 10,000 even before its own discount", () => {
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
  // (no formation discounts), making the cheapest swap the smallest cost increase.
  const FK = "ntw3_zz_test_001";
  const base = (unitKey: string, cost: number) =>
    makeUnit({ unitKey, factionKey: FK, cost, cap: 2, groupCap: 2, capGroupKey: unitKey, baseUnitKey: unitKey });
  const general = (unitKey: string, group: string, cost: number, partial = {}) =>
    makeUnit({
      unitKey, factionKey: FK, cost, cap: 2, groupCap: 2, capGroupKey: group, baseUnitKey: group,
      isGeneral: true, isCommanderVariant: true, generalKind: "combat", unitClass: "general", ...partial,
    });
  const roster = () =>
    indexRoster(makeRoster([base("a", 500), base("bb", 500), general("a_com", "a", 800), general("bb_com", "bb", 300)], FK));

  it("replaces a selected unit with its combat general (never adds new units)", () => {
    // Cap of 1 -> swap the unit whose upgrade costs the least (bb: +300 vs a: +800).
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
