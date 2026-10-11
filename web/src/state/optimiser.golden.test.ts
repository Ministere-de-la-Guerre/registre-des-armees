// Golden LP text of the ToW / Custom optimiser. The Army Corps extension (acOptimiser.ts)
// adds rebate columns and rows only for Army Corps factions; for every other army the
// programme must stay byte-for-byte what it was, or the ToW parity with
// analysis/cost_effective_builds.py could drift unnoticed. The snapshots were written by
// the optimiser before the AC extension; a deliberate change to the ToW model means
// updating them (vitest -u) and re-running optimiser.parity.test.ts.

import fixture from "./__fixtures__/optimiser-parity.json";
import type { FactionRoster, UnitCard } from "../domain/types";
import { normalizeCard, normalizeOptimiserParams } from "../data/load";
import { emptyBuild, indexRoster } from "./build";
import { DEFAULT_OPTIMISE_SETTINGS, buildOptimiseProblem, renderOptimiseLp } from "./optimiser";

interface FixtureArmy { optimiser: unknown; cards: Record<string, unknown>[] }

const armies = (fixture as unknown as { armies: Record<string, FixtureArmy> }).armies;

function rosterOf(factionKey: string): FactionRoster {
  const army = armies[factionKey];
  const cards = army.cards.map(normalizeCard).filter((c): c is UnitCard => c !== null);
  return { schemaVersion: 2, factionKey, armyCorpsName: factionKey, cards, optimiser: normalizeOptimiserParams(army.optimiser) };
}

const cases = [
  { factionKey: "ntw3_tow_b06_x8_009", mode: "quantity", singleRoll: true },
  { factionKey: "ntw3_tow_c14_x8_030", mode: "quality", singleRoll: false },
  { factionKey: "ntw3_hre", mode: "quantity", singleRoll: true },
] as const;

describe("ToW / Custom optimiser LP is unchanged", () => {
  it.each(cases)("$factionKey $mode single roll $singleRoll", async ({ factionKey, mode, singleRoll }) => {
    const roster = rosterOf(factionKey);
    const index = indexRoster(roster);
    const made = buildOptimiseProblem(roster, index, emptyBuild(), roster.cards,
      { ...DEFAULT_OPTIMISE_SETTINGS, mode, singleRoll, useFilters: false });
    if ("error" in made) throw new Error(made.error);
    await expect(renderOptimiseLp(made.problem)).toMatchFileSnapshot(`./__fixtures__/golden-lp/${factionKey}-${mode}.lp`);
  });
});
