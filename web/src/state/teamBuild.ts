// The optimiser run for whole teams (the planner's "Suggest a team", state/teamSuggest.ts):
// live army values when the suggestion's settings or kept units constrain the builds, and
// the builds of the team the player picks. Each army is one optimiseBuild (state/optimiser.ts)
// on its full roster — no roster filters, rotation or corps roll, the same as the precomputed
// values (the Builder can re-optimise an army later with "Offered now"). Solves run one at a
// time through the app's single HiGHS worker.

import type { CorpsEntry, FactionRoster } from "../domain/types";
import { emptyBuild, indexRoster } from "./build";
import { type OptimiseSettings, type OptimiseSummary, optimiseBuild } from "./optimiser";
import { type SavedBuild, buildToSaved, resolveSavedBuild } from "./saves";
import type { LpSolver } from "./solveLp";

export interface TeamBuildDeps {
  loadRoster: (factionKey: string) => Promise<FactionRoster>;
  solver: LpSolver;
  /** Called before each army: 0-based position, total, the army's name. */
  onProgress?: (done: number, total: number, name: string) => void;
  /** Set `cancelled` to stop after the army being optimised (cancelSolves() stops that one too). */
  signal?: { cancelled: boolean };
}

export type ArmyResult =
  | { factionKey: string; ok: true; build: SavedBuild; summary: OptimiseSummary }
  | { factionKey: string; ok: false; error: string };

/** One army optimised with `settings`; `kept` is its current build (remainder mode keeps it). */
export async function optimiseArmy(entry: Pick<CorpsEntry, "factionKey" | "name">, kept: SavedBuild | null,
                                   settings: OptimiseSettings, deps: Pick<TeamBuildDeps, "loadRoster" | "solver">)
  : Promise<ArmyResult> {
  const { factionKey } = entry;
  let roster: FactionRoster;
  try {
    roster = await deps.loadRoster(factionKey);
  } catch {
    return { factionKey, ok: false, error: `${entry.name}: its roster could not be loaded (offline and not saved for offline use?).` };
  }
  if (!roster.optimiser) return { factionKey, ok: false, error: `${entry.name}: no optimiser data for this army.` };
  const index = indexRoster(roster);
  const current = kept && settings.remainder ? resolveSavedBuild(kept, roster).build : emptyBuild();
  const outcome = await optimiseBuild(roster, index, current, roster.cards, settings, deps.solver);
  if (!outcome.ok) return { factionKey, ok: false, error: `${entry.name}: ${outcome.error}` };
  const build = buildToSaved(
    { build: outcome.build, config: kept?.config ?? { density: "comfortable", showCombatGenerals: true },
      factionKey, armyCorpsName: roster.armyCorpsName || entry.name },
    { name: kept?.name ?? entry.name },
  );
  return { factionKey, ok: true, build, summary: outcome.summary };
}

/** Several armies, one after another; stops early when `signal.cancelled` is set. */
export async function optimiseArmies(targets: readonly { entry: Pick<CorpsEntry, "factionKey" | "name">; kept: SavedBuild | null }[],
                                     settings: OptimiseSettings, deps: TeamBuildDeps): Promise<ArmyResult[]> {
  const results: ArmyResult[] = [];
  for (const [i, target] of targets.entries()) {
    if (deps.signal?.cancelled) break;
    deps.onProgress?.(i, targets.length, target.entry.name);
    results.push(await optimiseArmy(target.entry, target.kept, settings, deps));
  }
  return results;
}

// Live values are kept for the session: ranking a pool again at another points total, or
// building the team picked from it, reuses them.
const liveCache = new Map<string, ArmyResult>();

function cacheKey(factionKey: string, settings: OptimiseSettings, kept: SavedBuild | null): string {
  const keptSig = kept && settings.remainder ? `${kept.staffSlotUnitKey ?? ""}:${kept.instances.join(",")}` : "";
  return [factionKey, settings.mode, settings.maxCards, settings.allowNoStaff, settings.singleRoll, settings.remainder, keptSig].join("|");
}

/** An army's live result, from the session cache when this exact question was answered. */
export async function cachedArmy(entry: Pick<CorpsEntry, "factionKey" | "name">, kept: SavedBuild | null,
                                 settings: OptimiseSettings, deps: Pick<TeamBuildDeps, "loadRoster" | "solver">)
  : Promise<ArmyResult> {
  const key = cacheKey(entry.factionKey, settings, kept);
  const hit = liveCache.get(key);
  if (hit) return hit;
  const result = await optimiseArmy(entry, kept, settings, deps);
  if (result.ok) liveCache.set(key, result);
  return result;
}

/** Live values of a pool's armies (and kept armies' completed builds): faction → result. */
export async function liveArmyResults(targets: readonly { entry: Pick<CorpsEntry, "factionKey" | "name">; kept: SavedBuild | null }[],
                                      settings: OptimiseSettings, deps: TeamBuildDeps): Promise<Map<string, ArmyResult>> {
  const out = new Map<string, ArmyResult>();
  for (const [i, target] of targets.entries()) {
    if (deps.signal?.cancelled) break;
    deps.onProgress?.(i, targets.length, target.entry.name);
    out.set(target.entry.factionKey, await cachedArmy(target.entry, target.kept, settings, deps));
  }
  return out;
}

/** For tests: forget the session's live values. */
export function clearLiveArmyCache(): void {
  liveCache.clear();
}
