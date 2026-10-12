// Parity with the Python optimisers. ToW / Custom (analysis/cost_effective_builds.py): for
// [1806] 10. Preußen and [1815] 6. Napoli (the two calibration anchors of the general
// correction) and the Custom army HRE, the app's optimiser must reach the same optimum as
// Python's "max value" build (no roll limit) and "four corps" build (Single roll), at 31
// cards, in both value versions. Army Corps (analysis/ac_builds.py solve_corps): for Davout
// I.C 1812 (the support-division brigade exception), Bonaparte / Italie.C (the verified
// placement override) and Eugène / Italie (the corps that needed the most cuts before the
// recruit-order rows went into the model), in all three AC modes, the same optimum, final
// cost, rebate and completed groups, every rebate earned in recruit order, and no cut. The
// fixture holds the cards exactly as the app's faction JSON has them plus Python's results;
// regenerate it with `py -3.13 analysis/export_optimiser_values.py --fixture` after
// tools/build_web_data.py.

import fixture from "./__fixtures__/optimiser-parity.json";
import type { FactionRoster, OptimiserMode, UnitCard } from "../domain/types";
import { normalizeCard, normalizeOptimiserParams } from "../data/load";
import { calculateArmyCost } from "../rules/rules";
import { emptyBuild, expandBuild, indexRoster, priceBuild, summarize } from "./build";
import { DEFAULT_OPTIMISE_SETTINGS, optimiseBuild } from "./optimiser";
import { nodeSolver } from "../test/highs";

interface PythonBuild {
  objective: number;
  cost: number;
  staff: string;
  units: [string, number][];
  /** Army Corps only. */
  listCost?: number;
  rebate?: number;
  cuts?: number;
  groups?: string[];
}
interface FixtureArmy { optimiser: unknown; cards: Record<string, unknown>[]; python: Record<string, PythonBuild> }

const armies = (fixture as unknown as { armies: Record<string, FixtureArmy> }).armies;

function rosterOf(factionKey: string, army: FixtureArmy): FactionRoster {
  const cards = army.cards.map(normalizeCard).filter((c): c is UnitCard => c !== null);
  return { schemaVersion: 3, factionKey, armyCorpsName: factionKey, cards, optimiser: normalizeOptimiserParams(army.optimiser) };
}

const cases = Object.entries(armies).flatMap(([factionKey, army]) =>
  Object.entries(army.python).map(([key, python]) => ({ factionKey, army, key, python })));

describe("optimiser parity with the Python optimisers", () => {
  it("covers ToW, Custom and Army Corps armies", () => {
    expect(cases.filter((c) => c.factionKey.includes("_ac_")).length).toBe(9);
    expect(cases.filter((c) => !c.factionKey.includes("_ac_")).length).toBe(12);
  });

  it.each(cases)("$factionKey $key", async ({ factionKey, army, key, python }) => {
    const [mode, variant] = key.split("/") as [OptimiserMode, string];
    const roster = rosterOf(factionKey, army);
    const index = indexRoster(roster);
    const settings = { ...DEFAULT_OPTIMISE_SETTINGS, mode, useFilters: false, singleRoll: variant === "four corps" };
    const outcome = await optimiseBuild(roster, index, emptyBuild(), roster.cards, settings, await nodeSolver());
    if (!outcome.ok) throw new Error(outcome.error);
    // Same optimum (values in the fixture are rounded to 1e-6 gold, hence the tolerance).
    expect(outcome.summary.value).toBeCloseTo(python.objective, 3);
    expect(outcome.summary.cost).toBeLessThanOrEqual(10_000);
    expect(outcome.build.staffSlotUnitKey).toBe(python.staff);
    expect(summarize(index, outcome.build).limits.violations).toEqual([]);
    if (python.rebate === undefined) return;

    // Army Corps: priced as the app prices it, with every rebate earned in recruit order.
    const price = priceBuild(index, outcome.build);
    expect(price.finalCost).toBe(calculateArmyCost(expandBuild(index, outcome.build).cards, roster.cards, factionKey).finalCost);
    expect(outcome.cuts).toBe(0);
    expect(outcome.fallback).toBeUndefined();
    expect(python.cuts).toBe(0);
    expect(price.finalCost).toBe(python.cost);
    expect(price.baseCost).toBe(python.listCost);
    expect(price.appliedDiscount).toBe(python.rebate);
    expect(price.completedGroups.map((g) => `${g.groupType}:${g.divisionId}:${g.brigadeId ?? 0}`).sort())
      .toEqual(python.groups);
  });
});
