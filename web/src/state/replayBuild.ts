// Adapter: a parsed replay army → the app's saved-build shape.
//
// A replay army is already an ordered list of unit keys plus a staff general,
// which is exactly what SavedBuild stores, so importing one is a straight
// translation. Resolving it against a roster reuses resolveSavedBuild, so an
// imported build drops unknown keys and reports them the same way a loaded save
// does — no second, divergent code path.

import type { ReplayArmy, ReplayBattle } from "../domain/replay";
import type { FactionRoster } from "../domain/types";
import type { BuildState } from "./build";
import { SAVE_FORMAT_VERSION, type SavedBuild, makeId, resolveSavedBuild } from "./saves";

/** A replay the user has opened, plus the rosters its armies price against.
 *  Held by App rather than the screen, so opening an army in the builder — which
 *  unmounts the screen — does not discard the parsed file. */
export interface ReplaySession {
  battle: ReplayBattle | null;
  fileName: string;
  rosters: Map<string, FactionRoster>;
  /** factionKey of the army currently shown in the detail panel. */
  activeKey: string | null;
}

export const emptyReplaySession = (): ReplaySession => ({
  battle: null,
  fileName: "",
  rosters: new Map(),
  activeKey: null,
});

/** Default save name for an imported army: "Player — 13. Wellesley / Peninsular". */
export function replayBuildName(army: ReplayArmy): string {
  const corps = army.corpsName || army.factionKey;
  return army.player ? `${army.player} — ${corps}` : corps;
}

export function savedBuildFromReplayArmy(army: ReplayArmy, name?: string): SavedBuild {
  const now = new Date().toISOString();
  return {
    saveFormatVersion: SAVE_FORMAT_VERSION,
    id: makeId(),
    name: name?.trim() || replayBuildName(army),
    createdAt: now,
    updatedAt: now,
    factionKey: army.factionKey,
    armyCorpsName: army.corpsName,
    instances: army.units.map((u) => u.key),
    staffSlotUnitKey: army.staffKey,
    config: { density: "compact", showCombatGenerals: true },
  };
}

export interface ResolvedReplayArmy {
  build: BuildState;
  /** Replay unit keys absent from the roster (dropped from the build). */
  missingKeys: string[];
}

/** Resolve an imported army against the roster it claims to belong to. */
export function resolveReplayArmy(army: ReplayArmy, roster: FactionRoster): ResolvedReplayArmy {
  const { build, missingKeys } = resolveSavedBuild(savedBuildFromReplayArmy(army), roster);
  return { build, missingKeys };
}
