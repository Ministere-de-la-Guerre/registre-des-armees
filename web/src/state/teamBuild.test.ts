import { beforeEach, describe, expect, it } from "vitest";
import fixture from "./__fixtures__/optimiser-parity.json";
import type { FactionRoster, UnitCard } from "../domain/types";
import { normalizeCard, normalizeOptimiserParams } from "../data/load";
import { nodeSolver } from "../test/highs";
import { indexRoster, priceBuild, summarize } from "./build";
import { DEFAULT_OPTIMISE_SETTINGS } from "./optimiser";
import { resolveSavedBuild } from "./saves";
import type { LpSolver } from "./solveLp";
import { clearLiveArmyCache, liveArmyResults, optimiseArmies, optimiseArmy } from "./teamBuild";

interface FixtureArmy { optimiser: unknown; cards: Record<string, unknown>[] }
const armies = (fixture as unknown as { armies: Record<string, FixtureArmy> }).armies;

function rosterOf(factionKey: string): FactionRoster {
  const army = armies[factionKey];
  const cards = army.cards.map(normalizeCard).filter((c): c is UnitCard => c !== null);
  return { schemaVersion: 3, factionKey, armyCorpsName: factionKey, cards, optimiser: normalizeOptimiserParams(army.optimiser) };
}

const loadRoster = async (factionKey: string) => {
  if (!armies[factionKey]) throw new Error("offline");
  return rosterOf(factionKey);
};
const DAVOUT = { factionKey: "ntw3_ac_a11_x5_117", name: "13. Davout / I.C" };
const EUGENE = { factionKey: "ntw3_ac_a08_x5_242", name: "11. Eugène / Italie" };
const settings = { ...DEFAULT_OPTIMISE_SETTINGS, useFilters: false };

beforeEach(() => clearLiveArmyCache());

describe("team builds", () => {
  it("optimises an army into a saved build the app prices within the funds", async () => {
    const result = await optimiseArmy(DAVOUT, null, settings, { loadRoster, solver: await nodeSolver() });
    if (!result.ok) throw new Error(result.error);
    const roster = rosterOf(DAVOUT.factionKey);
    const index = indexRoster(roster);
    const build = resolveSavedBuild(result.build, roster).build;
    expect(result.build.name).toBe(DAVOUT.name);
    expect(priceBuild(index, build).finalCost).toBeLessThanOrEqual(10_000);
    expect(summarize(index, build).limits.violations).toEqual([]);
  });

  it("reports an army whose roster cannot be loaded, and goes on with the others", async () => {
    const progress: string[] = [];
    const results = await optimiseArmies(
      [{ entry: { factionKey: "ntw3_ac_missing", name: "Missing" }, kept: null }, { entry: DAVOUT, kept: null }],
      settings, { loadRoster, solver: await nodeSolver(), onProgress: (i, n, name) => progress.push(`${i + 1}/${n} ${name}`) });
    expect(results.map((r) => r.ok)).toEqual([false, true]);
    expect(!results[0].ok && results[0].error).toContain("could not be loaded");
    expect(progress).toEqual(["1/2 Missing", "2/2 13. Davout / I.C"]);
  });

  it("stops when cancelled, and answers a repeated question from the session cache", async () => {
    const real = await nodeSolver();
    let solves = 0;
    const counting: LpSolver = (lp, options) => { solves += 1; return real(lp, options); };
    const signal = { cancelled: false };
    const first = await liveArmyResults([{ entry: DAVOUT, kept: null }, { entry: EUGENE, kept: null }], settings,
      { loadRoster, solver: counting, signal, onProgress: (i) => { if (i === 0) signal.cancelled = true; } });   // cancelled while army 1 runs
    expect([...first.keys()]).toEqual([DAVOUT.factionKey]);
    const used = solves;
    const again = await liveArmyResults([{ entry: DAVOUT, kept: null }], settings, { loadRoster, solver: counting });
    expect(again.get(DAVOUT.factionKey)?.ok).toBe(true);
    expect(solves).toBe(used);
  });
});
