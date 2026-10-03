// Keeps a planner slot in step with the builder it was opened in. The slot holds a
// SavedBuild, the builder reports a CurrentBuild; this bridges the two without
// touching the player's build library.

import { type CurrentBuild, type SavedBuild, buildToSaved } from "./saves";

/** The slot's build after the builder reports `current`. The slot keeps its own id,
 *  name and creation time (so it reads as the same army), and takes everything else
 *  from the builder. A brand-new slot is named after its corps. A previous build
 *  for a different corps is not carried over. */
export function slotBuildFromCurrent(prev: SavedBuild | null, current: CurrentBuild): SavedBuild {
  const keep = prev && prev.factionKey === current.factionKey ? prev : null;
  const built = buildToSaved(current, {
    id: keep?.id,
    name: keep?.name ?? (current.armyCorpsName || current.factionKey),
    createdAt: keep?.createdAt,
  });
  // The builder reports its own display config (density, combat-general badges);
  // keep the slot's, so a first edit doesn't silently rewrite the copy's config.
  return keep ? { ...built, config: keep.config } : built;
}
