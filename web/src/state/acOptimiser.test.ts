// The Army Corps optimiser on small synthetic corps (the real-roster check is
// optimiser.parity.test.ts): formation rebates, the recruit-order rule, remainder mode,
// support divisions, the combat-general cap, the "Formation discount only" mode and the
// cut-and-fallback safety net.

import type { OptimiserParams, UnitCard } from "../domain/types";
import { calculateArmyCost } from "../rules/rules";
import { makeRoster, makeUnit } from "../test/factories";
import { nodeSolver } from "../test/highs";
import { acBuildEarnsItsRebates, compareRebateGroups, rebateGroups, type RebateGroup } from "./acOptimiser";
import { type BuildState, emptyBuild, expandBuild, indexRoster, priceBuild, summarize } from "./build";
import {
  DEFAULT_OPTIMISE_SETTINGS,
  MAX_REBATE_CUTS,
  allowedModes,
  normaliseMode,
  optimiseBuild,
  type OptimiseSettings,
} from "./optimiser";
import type { LpSolver } from "./solveLp";

const FK = "ntw3_ac_test_x5_001";          // x5 → combat-general cap 9 − 5 = 4
const PARAMS: OptimiserParams = {
  t3B: 80, t3Q: 1.3, mRef: 10, lambda: { quantity: 0.0035, sizeBands: 0.0045 },
  speedBonus: 0.02, meleeBonus: 0, standardGeneralMelee: 3,
};

const staff = (faction = FK) => makeUnit({
  unitKey: "staff", factionKey: faction, isGeneral: true, generalKind: "staff", menRaw: 32, placement: null,
  divisionBrigadeCode: null, cost: 100, commandStars: 1, unitClass: "general", underlyingUnitClass: "general",
});

function unit(unitKey: string, cost: number, division: number, brigade: number, value: number,
              extra: Partial<UnitCard> = {}): UnitCard {
  return makeUnit({ unitKey, cost, placement: { division, brigade }, divisionBrigadeCode: `ACDV${division}B${brigade}`,
                    optimiserValue: { quantity: value, sizeBands: value }, ...extra });
}

const settings = (over: Partial<OptimiseSettings> = {}): OptimiseSettings =>
  ({ ...DEFAULT_OPTIMISE_SETTINGS, useFilters: false, ...over });

async function optimise(cards: UnitCard[], over: Partial<OptimiseSettings> = {}, current: BuildState = emptyBuild(),
                        solver?: LpSolver, faction = FK) {
  const roster = { ...makeRoster(cards, faction), optimiser: PARAMS };
  const index = indexRoster(roster);
  const outcome = await optimiseBuild(roster, index, current, roster.cards, settings(over), solver ?? await nodeSolver());
  if (!outcome.ok) throw new Error(outcome.error);
  return { outcome, index, price: priceBuild(index, outcome.build) };
}

const keys = (build: BuildState) => build.instances.map((i) => i.unitKey);

describe("Army Corps optimiser", () => {
  it("offers Quantity, Size bands (shown as Quality) and Formation discount only for AC; Quantity and Quality elsewhere", () => {
    expect(allowedModes(FK)).toEqual(["quantity", "sizeBands", "formationDiscount"]);
    expect(allowedModes("ntw3_tow_b06_x8_009")).toEqual(["quantity", "quality"]);
    expect(normaliseMode("quality", FK)).toBe("quantity");
    expect(normaliseMode("formationDiscount", "ntw3_hre")).toBe("quantity");
    expect(normaliseMode("sizeBands", FK)).toBe("sizeBands");
  });

  it("uses a brigade rebate to field more than 10 000 of list value", async () => {
    // Brigade 1/1 (3 × 3250, rebate floor(9750·2/100) = 195) plus a 200-gold card: list 10 050.
    const cards = [unit("a", 3250, 1, 1, 1000), unit("b", 3250, 1, 1, 1000), unit("c", 3250, 1, 1, 1000),
                   unit("d", 200, 2, 1, 500), staff()];
    const { outcome, price } = await optimise(cards);
    expect(keys(outcome.build).sort()).toEqual(["a", "b", "c", "d"]);
    expect(price.baseCost).toBe(10_050);
    expect(price.finalCost).toBe(9_855);
    expect(outcome.summary).toMatchObject({ listCost: 10_050, cost: 9_855, rebate: 195, groupsCompleted: 1 });
    expect(outcome.cuts).toBe(0);
  });

  it("credits a completed division's rebate in place of its brigades'", async () => {
    // Division 1 = brigades 1 (a, b) and 2 (c, d), 2000 each: division rebate floor(8000·3/100) = 240,
    // each brigade floor(4000·1/100) = 40.
    const cards = [unit("a", 2000, 1, 1, 900), unit("b", 2000, 1, 1, 900), unit("c", 2000, 1, 2, 900),
                   unit("d", 2000, 1, 2, 900), staff()];
    const { outcome, price } = await optimise(cards);
    expect(keys(outcome.build).sort()).toEqual(["a", "b", "c", "d"]);
    expect(price.appliedDiscount).toBe(240);
    expect(price.completedGroups.map((g) => g.groupType)).toEqual(["division"]);
  });

  it("never claims a rebate the recruit order cannot earn", async () => {
    // a + b (5000 each) complete a brigade worth 100 and end at 10 000 — but after the staff
    // general (100) and a (5000), b at list price would need 10 100: the app refuses the rebate.
    const cards = [unit("a", 5000, 1, 1, 2000), unit("b", 5000, 1, 1, 2000), unit("e", 4000, 2, 1, 1000), staff()];
    const { outcome, index, price } = await optimise(cards);
    expect(keys(outcome.build)).not.toEqual(expect.arrayContaining(["a", "b"]));
    expect(price.finalCost).toBeLessThanOrEqual(10_000);
    expect(acBuildEarnsItsRebates(index, outcome.build)).toBe(true);
    expect(outcome.cuts).toBe(0);
  });

  it("recruits completed groups first, in ≺ order, each one contiguous", async () => {
    // Group x, y, z (rebate floor(6000·2/100) = 120) before p, q, r (floor(3000·2/100) = 60); f is
    // loose. List 10 150 with the staff general: f only fits if both rebates are earned (final 9 970).
    const cards = [unit("p", 1000, 1, 1, 400), unit("q", 1000, 1, 1, 400), unit("r", 1000, 1, 1, 400),
                   unit("x", 2000, 2, 1, 800), unit("y", 2000, 2, 1, 800), unit("z", 2000, 2, 1, 800),
                   unit("f", 1050, 3, 1, 600), staff()];
    const { outcome, index, price } = await optimise(cards);
    const order = keys(outcome.build);
    expect(order.slice(0, 3).sort()).toEqual(["x", "y", "z"]);
    expect(order.slice(3, 6).sort()).toEqual(["p", "q", "r"]);
    expect(order[6]).toBe("f");
    expect(price.finalCost).toBe(calculateArmyCost(expandBuild(index, outcome.build).cards, index.roster.cards, FK).finalCost);
  });

  it("in remainder mode keeps the player's cards first and earns the rebate they complete", async () => {
    const cards = [unit("a", 1000, 1, 1, 400), unit("b", 1000, 1, 1, 400), unit("c", 1000, 1, 1, 400),
                   unit("d", 500, 2, 1, 100), staff()];
    const kept: BuildState = { instances: [{ id: "k1", unitKey: "b" }, { id: "k2", unitKey: "a" }], staffSlotUnitKey: "staff" };
    const { outcome, price } = await optimise(cards, { remainder: true }, kept);
    expect(outcome.build.instances.slice(0, 2)).toEqual(kept.instances);
    expect(keys(outcome.build)).toContain("c");
    expect(price.completedGroups.filter((g) => g.discount > 0).length).toBe(1);
    expect(price.appliedDiscount).toBe(60);       // floor(3000·2/100)
  });

  it("gives a support division nothing, except the Davout corps' sapper and skirmisher brigades", () => {
    const division3 = (faction: string) => [
      makeUnit({ unitKey: "gun", factionKey: faction, unitClass: "artillery_foot", underlyingUnitClass: "artillery_foot",
                 cost: 600, cap: 2, groupCap: 2, placement: { division: 3, brigade: 1 } }),
      makeUnit({ unitKey: "skirm", factionKey: faction, unitClass: "infantry_skirmishers", underlyingUnitClass: "infantry_skirmishers",
                 cost: 400, cap: 2, groupCap: 2, placement: { division: 3, brigade: 2 } }),
    ];
    const room = () => 5;
    expect(rebateGroups(division3(FK), FK, [], room)).toEqual([]);
    const davout = "ntw3_ac_a11_x5_117";
    expect(rebateGroups(division3(davout), davout, [], room).map((g) => [g.kind, g.division, g.brigade, g.rebate]))
      .toEqual([["brigade", 3, 2, 8]]);                    // floor(800·1/100)
  });

  it("orders groups by rebate − credit, then division before brigade, then ids", () => {
    const g = (kind: RebateGroup["kind"], division: number, brigade: number | null, rebate: number, credit = 0): RebateGroup =>
      ({ kind, division, brigade, rebate, required: 2, kept: 0, credit });
    const sorted = [g("brigade", 1, 1, 50), g("division", 2, null, 300, 200), g("brigade", 3, 1, 100),
                    g("division", 4, null, 100), g("brigade", 5, 1, 150)].sort(compareRebateGroups);
    // Division 2 has the largest rebate (300) but its brigades credit 200 of it before its last
    // card, so brigade 5 (150) comes first; the three groups at 100 fall to the tie-breaks.
    expect(sorted.map((x) => [x.kind, x.division])).toEqual(
      [["brigade", 5], ["division", 2], ["division", 4], ["brigade", 3], ["brigade", 1]]);
  });

  it("respects the corps' combat-general cap (9 − the key's digit)", async () => {
    const generals = Array.from({ length: 6 }, (_, i) => unit(`gen${i}`, 300, 1, i + 1, 900, {
      isGeneral: true, generalKind: "combat", isCommanderVariant: true, menRaw: 160, commandStars: 2 }));
    const { outcome, index } = await optimise([...generals, staff()]);
    expect(keys(outcome.build).filter((k) => k.startsWith("gen")).length).toBe(4);
    expect(summarize(index, outcome.build).limits.violations).toEqual([]);
  });

  it("'Formation discount only' values a build at its list price", async () => {
    const cards = [unit("a", 3250, 1, 1, 1), unit("b", 3250, 1, 1, 1), unit("c", 3250, 1, 1, 1),
                   unit("d", 200, 2, 1, 1), staff()];
    const { outcome } = await optimise(cards, { mode: "formationDiscount" });
    expect(outcome.summary.listCost).toBe(10_050);
    expect(outcome.summary.value).toBeCloseTo(10_050, 0);
    expect(outcome.summary.efficiency).toBeGreaterThan(1);
  });

  it("cuts a build whose rebate is not earned, then falls back to one without rebates", async () => {
    const cards = [unit("a", 5000, 1, 1, 2000), unit("b", 5000, 1, 1, 2000), unit("e", 4000, 2, 1, 1000), staff()];
    const real = await nodeSolver();
    let calls = 0;
    // A solver that keeps answering a + b + the staff general with the division "completed" —
    // a build the recruit order cannot pay for — whenever rebate columns exist.
    const stub: LpSolver = async (lp, options) => {
      if (!lp.includes(" g0")) return real(lp, options);
      calls += 1;
      return { status: "Optimal", columns: { x0: 1, x1: 1, z0: 1, g0: 1 } };
    };
    const { outcome, index } = await optimise(cards, {}, emptyBuild(), stub);
    expect(calls).toBe(MAX_REBATE_CUTS + 1);
    expect(outcome.cuts).toBe(MAX_REBATE_CUTS);
    expect(outcome.fallback).toBe("noRebates");
    expect(acBuildEarnsItsRebates(index, outcome.build)).toBe(true);
  });
});
