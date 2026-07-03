import type { RollDirection } from "./rollTimeFormat";

/** Shared pill showing whether a rolled/rotated result is offered now, upcoming,
 *  or most recently in the past. */
export function DirectionBadge({ dir }: { dir: RollDirection }) {
  if (dir === "now") return <span className="rot-badge now">offered now</span>;
  if (dir === "future") return <span className="rot-badge future">upcoming</span>;
  if (dir === "past") return <span className="rot-badge past">most recent</span>;
  return null;
}
