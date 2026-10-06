// The Ordre de Bataille team rule: a plan is one team, so every army in it must share
// a side and a theatre. The first army chosen fixes both; each later army must match.
//
//   campaign corps (Empire / Coalition) → same side AND same theatre
//                                          (Coalition "Patriotic War (1812)" only mixes with itself)
//   Theatres of War + Custom Armies     → one shared pool: TOW factions and custom
//                                          armies mix freely, and nothing else joins them.
//                                          TOW factions still belong to a side
//                                          (Imperial / Coalition); custom armies have none
//                                          of their own, so they fit either until a TOW
//                                          army fixes the side.

import type { CorpsIndex } from "./types";

export type TeamSide = "imperial" | "coalition";

export interface TeamKey {
  /** Null only for custom armies, which don't carry a side of their own. */
  side: TeamSide | null;
  /** "tow" (Theatres of War + custom) or "campaign:<theatre>". */
  pool: string;
  /** Human label, e.g. "Coalition · Patriotic War (1812)". */
  label: string;
}

const SIDE_NAME: Record<TeamSide, string> = { imperial: "Imperial", coalition: "Coalition" };

export const TOW_POOL = "tow";

function keyFor(indexSide: string, theatre: string): TeamKey | null {
  switch (indexSide) {
    case "empire":
      return { side: "imperial", pool: `campaign:${theatre}`, label: `Imperial · ${theatre}` };
    case "coalition":
      return { side: "coalition", pool: `campaign:${theatre}`, label: `Coalition · ${theatre}` };
    case "tow_french_imperial":
      return { side: "imperial", pool: TOW_POOL, label: "Imperial · Theatres of War + Custom" };
    case "tow_coalition":
      return { side: "coalition", pool: TOW_POOL, label: "Coalition · Theatres of War + Custom" };
    case "custom":
      return { side: null, pool: TOW_POOL, label: "Theatres of War + Custom" };
    default:
      return null;
  }
}

/** factionKey → team key, for every corps in the index. */
export function teamKeysByFaction(index: CorpsIndex | null): Map<string, TeamKey> {
  const map = new Map<string, TeamKey>();
  for (const s of index?.sides ?? [])
    for (const t of s.theatres) {
      const key = keyFor(s.side, t.theatre);
      if (key) for (const c of t.corps) map.set(c.factionKey, key);
    }
  return map;
}

/** Whether `key` may join a team anchored on `anchor` (null anchor: anything goes). */
export function fitsTeam(anchor: TeamKey | null, key: TeamKey): boolean {
  if (!anchor) return true;
  if (anchor.pool !== key.pool) return false;
  return anchor.side === null || key.side === null || anchor.side === key.side;
}

/** The anchor after `key` joins: a side-less anchor (custom armies so far) takes the
 *  side of the first army that has one. Null when `key` doesn't fit. */
export function joinTeam(anchor: TeamKey | null, key: TeamKey): TeamKey | null {
  if (!fitsTeam(anchor, key)) return null;
  if (!anchor) return key;
  if (anchor.side !== null || key.side === null) return anchor;
  return { ...anchor, side: key.side, label: `${SIDE_NAME[key.side]} · Theatres of War + Custom` };
}

/** The team a list of armies (in the order they were chosen) is anchored on. An army that
 *  clashes with the ones before it (an older plan from before the rule) is skipped. */
export function teamAnchor(keys: (TeamKey | null)[]): TeamKey | null {
  let anchor: TeamKey | null = null;
  for (const k of keys) {
    if (!k) continue;
    anchor = joinTeam(anchor, k) ?? anchor;
  }
  return anchor;
}

/** Armies of a replay for one side, in replay order, capped at `max`: the first army
 *  with a side anchors the team and every other must fit it. Custom armies (no side of
 *  their own) are added last, only where they fit the anchor. Returns indices. */
export function pickSideArmies(keys: (TeamKey | null)[], side: TeamSide, max: number): number[] {
  let anchor: TeamKey | null = null;
  const picked: number[] = [];
  const take = (i: number) => {
    const k = keys[i];
    if (!k || picked.length >= max) return;
    const next = joinTeam(anchor, k);
    if (!next) return;
    anchor = next;
    picked.push(i);
  };
  keys.forEach((k, i) => k?.side === side && take(i));
  keys.forEach((k, i) => k && k.side === null && take(i));
  return picked.sort((a, b) => a - b);
}
