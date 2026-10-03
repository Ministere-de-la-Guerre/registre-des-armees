// Adapter: ticked replay armies → a fresh Ordre de Bataille working plan.
//
// A replay records who fielded which army but not who was on whose team, so the
// user picks the armies for the plan and this only translates the pick.

import type { ReplayBattle } from "../domain/replay";
import { type CurrentPlan, MAX_PLAN_ARMIES, PLAN_FORMAT_VERSION, emptySlot, makePlanId, makeSlotId } from "./plan";
import { replayBuildName, savedBuildFromReplayArmy } from "./replayBuild";

/** Indices pre-ticked in the send-to-planner dialog: the first half of the armies
 *  (a replay lists one side's players first), at least one, capped at the plan size. */
export function defaultTickedArmies(armyCount: number): number[] {
  const count = Math.min(MAX_PLAN_ARMIES, Math.max(1, Math.floor(armyCount / 2)), armyCount);
  return Array.from({ length: count }, (_, i) => i);
}

/** "Map — file name": underscores become spaces and `.replay` is stripped, e.g.
 *  ("Austerlitz", "my_game.replay") → "Austerlitz — my game". Falls back to "Replay team". */
export function replayPlanName(battle: ReplayBattle, fileName: string): string {
  const file = fileName.replace(/\.replay$/i, "").replace(/_/g, " ").trim();
  return [battle.map.replace(/_/g, " ").trim(), file].filter(Boolean).join(" — ") || "Replay team";
}

/** A new working plan (not tied to any saved plan) with one slot per ticked army, in
 *  replay order. Out-of-range and repeated indices are ignored; at most the plan size.
 *  With no valid index it still has one empty slot (a plan always has 1..4 slots). */
export function planFromReplayArmies(battle: ReplayBattle, indices: number[], fileName: string): CurrentPlan {
  const picked = [...new Set(indices)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < battle.armies.length)
    .sort((a, b) => a - b)
    .slice(0, MAX_PLAN_ARMIES);
  const now = new Date().toISOString();
  return {
    loadedPlanId: null,
    plan: {
      planFormatVersion: PLAN_FORMAT_VERSION,
      id: makePlanId(),
      name: replayPlanName(battle, fileName),
      createdAt: now,
      updatedAt: now,
      slots:
        picked.length === 0
          ? [emptySlot()]
          : picked.map((i) => {
              const army = battle.armies[i];
              return {
                id: makeSlotId(),
                player: army.player,
                build: savedBuildFromReplayArmy(army, replayBuildName(army)),
              };
            }),
    },
  };
}
