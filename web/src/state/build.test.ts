import { describe, expect, it } from "vitest";
import { calculateArmyCost } from "../rules/rules";
import type { UnitCard } from "../domain/types";
import { makeRoster, makeUnit } from "../test/factories";
import {
  type BuildState,
  addWouldExceedBudget,
  staffGeneralAction,
  autoPickCombatGenerals,
  divisionFillPlan,
  evaluateAdd,
  evaluateSetCommander,
  fillDivision,
  generalSwapFor,
  hasCombatGeneralInstances,
  indexRoster,
  priceBuild,
  resetCombatGenerals,
  summarize,
  swapInstanceUnit,
  unitsWithCombatGenerals,
} from "./build";

const b = (instances: string[], staff: string | null = null): BuildState => ({
  instances: instances.map((unitKey, i) => ({ id: `i${i}`, unitKey })),
  staffSlotUnitKey: staff,
});

describe("evaluateAdd blocking", () => {
  // A build holds at most one staff general, wherever it sits. Being commanded by a
  // combat general does not buy a second one — but it does leave the staff general
  // free to be recruited as an ordinary unit, which the game allows.
  describe("staff generals", () => {
    const gen = (unitKey: string, kind: "staff" | "combat") =>
      makeUnit({
        unitKey,
        unitClass: "general",
        isGeneral: true,
        generalKind: kind,
        menRaw: kind === "staff" ? 32 : 80,
        cap: 1,
        groupCap: 1,
      });
    const roster = () => makeRoster([gen("staff_a", "staff"), gen("staff_b", "staff"), gen("combat", "combat")]);

    it("blocks a second staff general when one already holds the slot", () => {
      const idx = indexRoster(roster());
      const reason = evaluateAdd(idx, b([], "staff_a"), idx.byKey.get("staff_b")!, 5)?.reason;
      expect(reason).toMatch(/one staff general/i);
    });

    it("blocks a second staff general when one is already a recruited unit", () => {
      const idx = indexRoster(roster());
      const reason = evaluateAdd(idx, b(["staff_a"]), idx.byKey.get("staff_b")!, 5)?.reason;
      expect(reason).toMatch(/one staff general/i);
    });

    it("allows the staff general as a unit while a combat general commands", () => {
      const idx = indexRoster(roster());
      expect(evaluateAdd(idx, b([], "combat"), idx.byKey.get("staff_a")!, 5)).toBeNull();
    });
  });

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

  it("lets a cavalry-only corps add a second horse battery, but not a third", () => {
    // Reserve-cavalry corps (Murat / Uxbridge / Platov …): no infantry on the
    // roster, so the horse-artillery cap is 2 rather than 1.
    const cav = makeUnit({ unitKey: "cav", unitClass: "cavalry_heavy", underlyingUnitClass: "cavalry_heavy", cost: 500 });
    const horse = (key: string) =>
      makeUnit({
        unitKey: key, unitClass: "artillery_horse", underlyingUnitClass: "artillery_horse",
        cost: 300, capGroupKey: key, baseUnitKey: key, placement: { division: 5, brigade: 2 },
      });
    const [h0, h1, h2] = [horse("h0"), horse("h1"), horse("h2")];
    const idx = indexRoster(makeRoster([cav, h0, h1, h2]));
    expect(evaluateAdd(idx, b(["h0"]), h1, 5)).toBeNull();
    expect(evaluateAdd(idx, b(["h0", "h1"]), h2, 5)?.reason).toMatch(/horse-artillery limit \(2\)/i);
  });

  it("blocks a second horse battery once the corps has infantry", () => {
    const inf = makeUnit({ unitKey: "inf", cost: 500 });
    const horse = (key: string) =>
      makeUnit({
        unitKey: key, unitClass: "artillery_horse", underlyingUnitClass: "artillery_horse",
        cost: 300, capGroupKey: key, baseUnitKey: key, placement: { division: 5, brigade: 2 },
      });
    const [h0, h1] = [horse("h0"), horse("h1")];
    const idx = indexRoster(makeRoster([inf, h0, h1]));
    expect(evaluateAdd(idx, b(["h0"]), h1, 5)?.reason).toMatch(/horse-artillery limit \(1\)/i);
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
      { instanceId: "i0", generalUnitKey: "a_com" },
      { instanceId: "i1", generalUnitKey: "bb_com" },
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
    // its (cheaper) combat general keeps the foot-artillery count unchanged, so both upgrade.
    const af = (unitKey: string, group: string, isGen = false) =>
      makeUnit({
        unitKey, factionKey: FK, cost: isGen ? 350 : 400, cap: 9, groupCap: 9, capGroupKey: group, baseUnitKey: group,
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

describe("generalSwapFor", () => {
  // A selected copy can be swapped for a combat general of the same unit at any time
  // (and back). "a" has two generals (cheaper a_com1, dearer a_com2), "bb" has one,
  // "c" has none, so it offers no swap at all.
  const FK = "ntw3_zz_test_001";
  const base = (unitKey: string, cost = 500) =>
    makeUnit({ unitKey, factionKey: FK, cost, cap: 2, groupCap: 2, capGroupKey: unitKey, baseUnitKey: unitKey });
  const general = (unitKey: string, group: string, cost: number, rosterIndex = 0) =>
    makeUnit({
      unitKey, factionKey: FK, cost, cap: 2, groupCap: 2, capGroupKey: group, baseUnitKey: group, rosterIndex,
      isGeneral: true, isCommanderVariant: true, generalKind: "combat", unitClass: "general",
    });
  const idx = () =>
    indexRoster(
      makeRoster(
        [
          base("a"), base("bb"), base("c"),
          general("a_com2", "a", 900, 2), general("a_com1", "a", 400, 1), general("bb_com", "bb", 600),
        ],
        FK,
      ),
    );

  it("offers every combat general of the selected unit, cheapest first, plus the plain unit", () => {
    const swap = generalSwapFor(idx(), b(["a"]), "i0", 2)!;
    expect(swap.current.unitKey).toBe("a");
    expect(swap.plain!.card.unitKey).toBe("a");
    expect(swap.plain!.current).toBe(true); // the copy holds the plain unit right now
    expect(swap.generals.map((o) => o.card.unitKey)).toEqual(["a_com1", "a_com2"]);
    expect(swap.generals.map((o) => o.costDelta)).toEqual([-100, 400]);
    expect(swap.generals.every((o) => o.blockedReason === null)).toBe(true);
  });

  it("offers nothing for a unit with no combat general, or for an unknown copy", () => {
    expect(generalSwapFor(idx(), b(["c"]), "i0", 2)).toBeNull();
    expect(generalSwapFor(idx(), b(["a"]), "nope", 2)).toBeNull();
  });

  it("lets a copy already led by a general switch general or revert to the plain unit", () => {
    const swap = generalSwapFor(idx(), b(["a_com1"]), "i0", 2)!;
    expect(swap.current.unitKey).toBe("a_com1");
    expect(swap.plain!.current).toBe(false);
    expect(swap.plain!.blockedReason).toBeNull(); // reverting is always allowed
    expect(swap.plain!.costDelta).toBe(100); // back to the 500 unit from the 400 general
    expect(swap.generals.find((o) => o.card.unitKey === "a_com1")!.current).toBe(true);
    // Switching to the other general of the same unit stays within the cap: this copy's
    // general is replaced, not added to.
    expect(swap.generals.find((o) => o.card.unitKey === "a_com2")!.blockedReason).toBeNull();
  });

  it("blocks a general once the corps' combat-general cap is spent elsewhere", () => {
    // Cap 1, already spent by bb_com; "a" cannot take one, but may still be swapped
    // to itself-as-plain (a no-op) — and bb_com's own copy can still swap freely.
    const swap = generalSwapFor(idx(), b(["a", "bb_com"]), "i0", 1)!;
    expect(swap.generals.map((o) => o.blockedReason)).toEqual([
      "Combat-general limit (1) reached.",
      "Combat-general limit (1) reached.",
    ]);
    const other = generalSwapFor(idx(), b(["a", "bb_com"]), "i1", 1)!;
    expect(other.plain!.blockedReason).toBeNull();
  });

  it("counts a combat general in the staff slot against the cap, not against the unit's copies", () => {
    // The commander is a combat general of "a": the corps cap (1) is untouched by it
    // (it sits in the staff slot), but "a" is already led, so a second copy of "a"
    // cannot take a general of its own.
    const swap = generalSwapFor(idx(), b(["a"], "a_com1"), "i0", 1)!;
    expect(swap.generals.find((o) => o.card.unitKey === "a_com1")!.blockedReason).toMatch(/already has a combat general/i);
    expect(swap.generals.find((o) => o.card.unitKey === "a_com2")!.blockedReason).toMatch(/already has a combat general/i);
  });

  it("blocks a second general for a unit whose other selected copy already has one", () => {
    const swap = generalSwapFor(idx(), b(["a", "a_com1"]), "i0", 4)!;
    expect(swap.generals.map((o) => o.blockedReason)).toEqual([
      "Another copy of this unit already has a combat general.",
      "Another copy of this unit already has a combat general.",
    ]);
  });

  it("prices each option against the build and flags one that breaks the cost ceiling", () => {
    const rich = makeUnit({
      unitKey: "big", factionKey: FK, cost: 9800, cap: 1, groupCap: 1, capGroupKey: "big", baseUnitKey: "big",
    });
    const i = indexRoster(makeRoster([...idx().roster.cards, rich], FK));
    const swap = generalSwapFor(i, b(["a", "big"]), "i0", 2)!;
    const cheap = swap.generals.find((o) => o.card.unitKey === "a_com1")!;
    const dear = swap.generals.find((o) => o.card.unitKey === "a_com2")!;
    expect(cheap.finalCost).toBe(10200); // 9,800 + 400
    expect(cheap.overBudget).toBe(true); // still over, but far less so
    expect(dear.finalCost).toBe(10700); // 9,800 + 900
    expect(dear.overBudget).toBe(true);
    expect(cheap.blockedReason).toBeNull(); // the ceiling is soft — it warns, never blocks
  });
});

describe("swapInstanceUnit", () => {
  it("replaces only the named copy, keeping its id and its place in the line", () => {
    const build = b(["a", "bb", "a"]);
    expect(swapInstanceUnit(build, "i1", "bb_com").instances).toEqual([
      { id: "i0", unitKey: "a" },
      { id: "i1", unitKey: "bb_com" },
      { id: "i2", unitKey: "a" },
    ]);
  });

  it("leaves the build untouched when the copy is gone", () => {
    const build = b(["a"]);
    expect(swapInstanceUnit(build, "nope", "a_com1").instances).toEqual(build.instances);
  });
});

describe("unitsWithCombatGenerals", () => {
  it("lists the units the roster has a combat general for", () => {
    const FK = "ntw3_zz_test_001";
    const idx = indexRoster(
      makeRoster(
        [
          makeUnit({ unitKey: "a", factionKey: FK, capGroupKey: "a", baseUnitKey: "a" }),
          makeUnit({ unitKey: "c", factionKey: FK, capGroupKey: "c", baseUnitKey: "c" }),
          makeUnit({
            unitKey: "a_com", factionKey: FK, capGroupKey: "a", baseUnitKey: "a",
            isGeneral: true, generalKind: "combat", unitClass: "general",
          }),
          // A staff general is not a combat general: it never leads a unit.
          makeUnit({
            unitKey: "staff", factionKey: FK, capGroupKey: "staff", baseUnitKey: "staff",
            isGeneral: true, generalKind: "staff", unitClass: "general",
          }),
        ],
        FK,
      ),
    );
    expect([...unitsWithCombatGenerals(idx)]).toEqual(["a"]);
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

describe("staffGeneralAction", () => {
  const gen = (unitKey: string, kind: "staff" | "combat") =>
    makeUnit({
      unitKey,
      unitClass: "general",
      isGeneral: true,
      generalKind: kind,
      menRaw: kind === "staff" ? 32 : 80,
      cap: 1,
      groupCap: 1,
    });
  const idx = () =>
    indexRoster(makeRoster([gen("staff_a", "staff"), gen("staff_b", "staff"), gen("combat", "combat")]));

  it("sets the commander when the slot is empty", () => {
    const i = idx();
    expect(staffGeneralAction(i, b([]), i.byKey.get("staff_a")!)).toBe("set-commander");
  });

  it("unsets when the card already holds the slot", () => {
    const i = idx();
    expect(staffGeneralAction(i, b([], "staff_a"), i.byKey.get("staff_a")!)).toBe("set-commander");
  });

  it("swaps when another staff general commands", () => {
    const i = idx();
    expect(staffGeneralAction(i, b([], "staff_a"), i.byKey.get("staff_b")!)).toBe("set-commander");
  });

  // The case that produced the wrong red frame: a combat general commands, so the
  // click recruits rather than replacing him — and must be priced that way.
  it("recruits when a combat general commands", () => {
    const i = idx();
    expect(staffGeneralAction(i, b([], "combat"), i.byKey.get("staff_a")!)).toBe("recruit");
  });

  it("a recruit-action staff general is priced as an add, not as a commander swap", () => {
    // Commander costs 5,000; the staff general 1,000. Replacing the commander would
    // free 5,000, so a swap is trivially affordable — but recruiting adds on top.
    const roster = makeRoster([
      makeUnit({ unitKey: "combat", unitClass: "general", isGeneral: true, generalKind: "combat",
                 menRaw: 80, cost: 5000, cap: 1, groupCap: 1 }),
      makeUnit({ unitKey: "staff_a", unitClass: "general", isGeneral: true, generalKind: "staff",
                 menRaw: 32, cost: 1000, cap: 1, groupCap: 1 }),
      makeUnit({ unitKey: "filler", cost: 4500, cap: 9, groupCap: 9 }),
    ]);
    const i = indexRoster(roster);
    const build = b(["filler"], "combat"); // 9,500 committed
    const staff = i.byKey.get("staff_a")!;
    expect(staffGeneralAction(i, build, staff)).toBe("recruit");
    // Recruiting: 9,500 + 1,000 = 10,500 -> over. A swap would have read as affordable.
    expect(addWouldExceedBudget(i, build, staff)).toBe(true);
  });
});

describe("evaluateSetCommander", () => {
  // Default test faction is "_ac_" rated 5, so the combat-general cap is 4.
  const gen = (unitKey: string, kind: "staff" | "combat", partial: Partial<UnitCard> = {}) =>
    makeUnit({
      unitKey, unitClass: "general", isGeneral: true, generalKind: kind, menRaw: kind === "staff" ? 32 : 80,
      cap: 1, groupCap: 1, placement: null, ...partial,
    });

  it("blocks a second staff general when one is already recruited as a unit", () => {
    const idx = indexRoster(makeRoster([gen("s1", "staff"), gen("s2", "staff")]));
    expect(evaluateSetCommander(idx, b(["s1"]), idx.byKey.get("s2")!)?.reason).toMatch(/one staff general/i);
  });

  it("blocks a 32nd card, but lets a commander swap keep the build at 31", () => {
    const filler = makeUnit({ unitKey: "f", cost: 10, cap: 99, groupCap: 99 });
    const idx = indexRoster(makeRoster([filler, gen("s1", "staff"), gen("s2", "staff")]));
    const full = Array.from({ length: 31 }, () => "f");
    expect(evaluateSetCommander(idx, b(full), idx.byKey.get("s1")!)?.reason).toMatch(/full/i);
    expect(evaluateSetCommander(idx, b(full.slice(1), "s2"), idx.byKey.get("s1")!)).toBeNull();
  });

  it("counts an artillery-led combat general against the foot-artillery cap", () => {
    const art = makeUnit({ unitKey: "art", unitClass: "artillery_foot", underlyingUnitClass: "artillery_foot", cap: 9, groupCap: 9 });
    const artCom = gen("gun_com", "combat", { underlyingUnitClass: "artillery_foot", capGroupKey: "gun", baseUnitKey: "gun" });
    const idx = indexRoster(makeRoster([art, artCom]));
    expect(evaluateSetCommander(idx, b(["art", "art"]), artCom)?.reason).toMatch(/foot-artillery/i);
  });

  it("blocks a combat general whose unit's shared cap is already full (no free formation copy)", () => {
    // (Real combat-general keys end in _com_<n>, which the rules engine's cap groups key on.)
    // Brigade A + B, cap 1 each. Commanding with A's combat general on top of A would
    // count A twice toward the division and earn a discount the game never grants.
    const a = makeUnit({ unitKey: "a", placement: { division: 1, brigade: 1 } });
    const bb = makeUnit({ unitKey: "bb", placement: { division: 1, brigade: 2 } });
    const aCom = gen("a_com_1", "combat", { capGroupKey: "a", baseUnitKey: "a", placement: { division: 1, brigade: 1 } });
    const idx = indexRoster(makeRoster([a, bb, aCom]));
    expect(evaluateSetCommander(idx, b(["a"]), aCom)?.reason).toMatch(/shared cap/i);
    expect(evaluateSetCommander(idx, b(["bb"]), aCom)).toBeNull();
  });

  it("blocks a second combat general for a unit that already has one", () => {
    const u = makeUnit({ unitKey: "u", cap: 3, groupCap: 3 });
    const c1 = gen("u_com_1", "combat", { capGroupKey: "u", baseUnitKey: "u", cap: 3, groupCap: 3 });
    const c2 = gen("u_com_2", "combat", { capGroupKey: "u", baseUnitKey: "u", cap: 3, groupCap: 3 });
    const idx = indexRoster(makeRoster([u, c1, c2]));
    expect(evaluateSetCommander(idx, b(["u", "u_com_1"]), c2)?.reason).toMatch(/one combat general/i);
  });

  it("always allows clearing the slot, and moving a recruited general into it", () => {
    const c = gen("c", "combat");
    const idx = indexRoster(makeRoster([c, gen("s", "staff")]));
    expect(evaluateSetCommander(idx, b([], "c"), c)).toBeNull();
    expect(evaluateSetCommander(idx, b(["c"]), c)).toBeNull();
  });

  it("does not blame the commander for a limit an imported build already breaks", () => {
    const art = makeUnit({ unitKey: "art", unitClass: "artillery_foot", underlyingUnitClass: "artillery_foot", cap: 9, groupCap: 9 });
    const idx = indexRoster(makeRoster([art, gen("s", "staff")]));
    expect(evaluateSetCommander(idx, b(["art", "art", "art"]), idx.byKey.get("s")!)).toBeNull();
  });

  it("refuses a non-general", () => {
    const u = makeUnit({ unitKey: "u" });
    const idx = indexRoster(makeRoster([u]));
    expect(evaluateSetCommander(idx, b([]), u)?.reason).toMatch(/general/i);
  });
});

describe("summarize", () => {
  it("reports a build the rules engine can't check as invalid, not as legal", () => {
    // An imported save whose staff slot names a plain unit.
    const u = makeUnit({ unitKey: "u", cap: 9, groupCap: 9 });
    const c = makeUnit({ unitKey: "c", unitClass: "general", isGeneral: true, generalKind: "combat", menRaw: 80, capGroupKey: "u", baseUnitKey: "u", cap: 9, groupCap: 9 });
    const idx = indexRoster(makeRoster([u, c]));
    const summary = summarize(idx, b(["u", "c"], "u"));
    expect(summary.limits.valid).toBe(false);
    expect(summary.violationMessages[0]).toMatch(/can't be checked/i);
    expect(summary.limits.counts.combat_generals_against_cap).toBe(1);
  });

  it("labels the staff-general limit", () => {
    const s = (k: string) => makeUnit({ unitKey: k, unitClass: "general", isGeneral: true, generalKind: "staff", menRaw: 32, placement: null });
    const idx = indexRoster(makeRoster([s("s1"), s("s2")]));
    const summary = summarize(idx, b(["s1"], "s2"));
    expect(summary.violationMessages).toContain("Staff generals: 2 selected, maximum is 1.");
  });
});

describe("autoPickCombatGenerals — exact search", () => {
  const FK = "ntw3_ac_test_x5_001";
  const unit = (key: string, cost: number, cap: number, brigade: number) =>
    makeUnit({ unitKey: key, factionKey: FK, cost, cap, groupCap: cap, placement: { division: 1, brigade } });
  const general = (key: string, group: string, cost: number, cap: number, brigade: number) =>
    makeUnit({
      unitKey: key, factionKey: FK, cost, cap, groupCap: cap, capGroupKey: group, baseUnitKey: group,
      isGeneral: true, generalKind: "combat", unitClass: "general", menRaw: 80, placement: { division: 1, brigade },
    });
  const apply = (build: BuildState, replacements: { instanceId: string; generalUnitKey: string }[]) =>
    replacements.reduce((acc, r) => swapInstanceUnit(acc, r.instanceId, r.generalUnitKey), build);

  it("picks the copies whose swap unlocks a discount, not just the first copies", () => {
    // Brigade 1 = u3×2 + u2×2 + u1 (roster 10,500, 5 copies → 420 discount); u0×2 sits
    // in brigade 2. Swapping the *first* u3/u2 copies (the old greedy pick) leaves the
    // later copies over budget (16,800); swapping the *second* copies lets them in and
    // completes brigade 1 (16,800 − 420).
    const idx = indexRoster(makeRoster([
      unit("u0", 3900, 2, 2), unit("u1", 2500, 1, 1), unit("u2", 2200, 2, 1), unit("u3", 1800, 2, 1),
      general("u2_com", "u2", 1500, 2, 1), general("u3_com", "u3", 1000, 2, 1),
    ], FK));
    const build = b(["u3", "u2", "u1", "u0", "u3", "u2", "u0"]);
    expect(priceBuild(idx, apply(build, [
      { instanceId: "i0", generalUnitKey: "u3_com" },
      { instanceId: "i1", generalUnitKey: "u2_com" },
    ])).finalCost).toBe(16800);
    const { replacements } = autoPickCombatGenerals(idx, build, 2);
    expect(replacements).toEqual([
      { instanceId: "i4", generalUnitKey: "u3_com" },
      { instanceId: "i5", generalUnitKey: "u2_com" },
    ]);
    expect(priceBuild(idx, apply(build, replacements)).finalCost).toBe(16380);
  });

  it("never spends a slot on a swap that doesn't lower the cost", () => {
    const idx = indexRoster(makeRoster([unit("a", 500, 2, 1), general("a_com", "a", 500, 2, 1)], FK));
    expect(autoPickCombatGenerals(idx, b(["a"]), 4).replacements).toEqual([]);
  });

  it("falls back to greedy on a large candidate space and still only takes savings", () => {
    // 31 distinct units, each with a cheaper general, and a cap of 8: far too many
    // swap sets to price exhaustively. Greedy takes the eight biggest savings.
    const cards = [];
    for (let i = 0; i < 31; i++) {
      cards.push(makeUnit({ unitKey: `u${i}`, factionKey: "ntw3_zz_test_001", cost: 300 }));
      cards.push(makeUnit({
        unitKey: `u${i}_com`, factionKey: "ntw3_zz_test_001", cost: 300 - i, capGroupKey: `u${i}`, baseUnitKey: `u${i}`,
        isGeneral: true, generalKind: "combat", unitClass: "general", menRaw: 80,
      }));
    }
    const idx = indexRoster(makeRoster(cards, "ntw3_zz_test_001"));
    const build = b(Array.from({ length: 31 }, (_, i) => `u${i}`));
    const { replacements } = autoPickCombatGenerals(idx, build, 8);
    expect(replacements.map((r) => r.generalUnitKey).sort()).toEqual(
      ["u23_com", "u24_com", "u25_com", "u26_com", "u27_com", "u28_com", "u29_com", "u30_com"],
    );
  });
});

describe("addWouldExceedBudget follows the affordability replay", () => {
  it("does not flag a copy that fits beside the affordable cards and earns its discount", () => {
    // e (9,000) is affordable, big (3,000) is not, x (500) is. A 2nd x still fits the
    // affordable running total (9,500 + 500) and completes x's brigade for a discount,
    // so it must not read as over budget even though the paid total is already 12,500.
    const FK = "ntw3_ac_test_x5_001";
    const u = (unitKey: string, cost: number, brigade: number, cap = 1) =>
      makeUnit({ unitKey, factionKey: FK, cost, cap, groupCap: cap, placement: { division: 1, brigade } });
    const idx = indexRoster(makeRoster([u("e", 9000, 9), u("big", 3000, 8), u("x", 500, 1, 2)], FK));
    const build = b(["e", "big", "x"]);
    expect(addWouldExceedBudget(idx, build, idx.byKey.get("x")!)).toBe(false);
    const after = priceBuild(idx, b(["e", "big", "x", "x"]));
    expect(after.completedGroups.some((g) => g.groupType === "brigade" && g.brigadeId === 1)).toBe(true);
    // A copy that doesn't fit is still flagged.
    expect(addWouldExceedBudget(idx, build, idx.byKey.get("big")!)).toBe(true);
  });
});

describe("take entire division", () => {
  const FK = "ntw3_ac_test_x5_001";
  const u = (unitKey: string, cost: number, division: number, brigade: number, cap = 1, partial: Partial<UnitCard> = {}) =>
    makeUnit({ unitKey, factionKey: FK, cost, cap, groupCap: cap, placement: { division, brigade }, ...partial });
  const roster = () =>
    indexRoster(makeRoster([
      u("x", 800, 1, 2, 2),
      u("y", 600, 1, 2),
      u("z", 700, 1, 1),
      u("x_com", 900, 1, 2, 2, { capGroupKey: "x", baseUnitKey: "x", isGeneral: true, generalKind: "combat", unitClass: "general", menRaw: 80 }),
      u("staff", 400, 1, 1, 1, { isGeneral: true, generalKind: "staff", unitClass: "general", menRaw: 32 }),
      u("w", 500, 2, 1),
      u("f1", 300, 1, 3, 3, { unitClass: "artillery_foot", underlyingUnitClass: "artillery_foot" }),
    ], FK));

  it("lists every plain unit of the division up to its cap, brigade by brigade in grid order", () => {
    const idx = roster();
    expect(divisionFillPlan(idx, b([]), 1).map((c) => c.unitKey)).toEqual(["z", "x", "x", "y", "f1", "f1", "f1"]);
  });

  it("tops up a partial division, counting a combat general as a copy of its unit", () => {
    const idx = roster();
    expect(divisionFillPlan(idx, b(["x_com", "z"]), 1).map((c) => c.unitKey)).toEqual(["x", "y", "f1", "f1", "f1"]);
    expect(divisionFillPlan(idx, b(["w"]), 2)).toEqual([]);
  });

  it("adds through the normal limits, skipping what a cap refuses", () => {
    const idx = roster();
    const fill = fillDivision(idx, b(["w"]), 1, 4);
    expect(fill.wanted).toBe(7);
    expect(fill.added.map((c) => c.unitKey)).toEqual(["z", "x", "x", "y", "f1", "f1"]);
    expect(fill.blockedReasons).toEqual(["Foot-artillery limit (2) reached."]);
    expect(fill.build.instances.map((i) => i.unitKey)).toEqual(["w", "z", "x", "x", "y", "f1", "f1"]);
    // The division is complete once filled (the refused third gun aside, the count is
    // what matters: 6 of 7 copies here, so it is not).
    expect(priceBuild(idx, fill.build).completedGroups.some((g) => g.groupType === "division" && g.divisionId === 1)).toBe(false);
  });

  it("completes the division's discount when nothing is refused", () => {
    const idx = indexRoster(makeRoster([u("x", 800, 1, 2, 2), u("y", 600, 1, 1)], FK));
    const fill = fillDivision(idx, b([]), 1, 4);
    expect(fill.added).toHaveLength(3);
    expect(priceBuild(idx, fill.build).completedGroups).toEqual([
      expect.objectContaining({ groupType: "division", divisionId: 1 }),
    ]);
  });
});
