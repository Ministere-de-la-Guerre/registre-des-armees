// Card ordering for the grid (section 8 & 9).
//
// Within a brigade, each base unit and its commander variants stay together:
// expensive commanders to the left of the base, then the base, then cheaper/equal
// commanders to the right. Staff generals sort by command stars.
//
// Across groups in a brigade the game orders by broad unit type (left to right):
// infantry & skirmishers, then cavalry, then artillery. Foot and horse artillery
// are treated as the same type (no foot-before-horse split) — they interleave by
// cost. Within one type, more expensive units come first (cost-desc, like in-game).

import type { UnitCard } from "../domain/types";
import { towBrigadeIndexOf as towBrigadeIndexOfCard } from "../domain/tow";

/** Broad type rank used to order groups within a brigade. Combat generals use
 *  their underlying unit class, so they sort beside the unit they lead. */
function brigadeTypeRank(card: UnitCard): number {
  const cls = card.underlyingUnitClass || card.unitClass;
  if (cls.startsWith("infantry")) return 0; // includes skirmishers
  if (cls.startsWith("cavalry")) return 1;
  if (cls.startsWith("artillery")) return 2; // foot + horse + fixed, sorted by cost
  return 3;
}

/** Tie-break order used within a base/commander side and for group anchors:
 *  cost desc, stars desc, rated before unrated, name, unit key. */
export function compareWithinSide(a: UnitCard, b: UnitCard): number {
  if (a.cost !== b.cost) return b.cost - a.cost;
  const sa = a.commandStars ?? -1;
  const sb = b.commandStars ?? -1;
  if (sa !== sb) return sb - sa;
  const ra = a.commandStars != null ? 0 : 1;
  const rb = b.commandStars != null ? 0 : 1;
  if (ra !== rb) return ra - rb;
  if (a.name !== b.name) return a.name.localeCompare(b.name);
  return a.unitKey.localeCompare(b.unitKey);
}

export function orderBrigadeCards(cards: UnitCard[]): UnitCard[] {
  if (cards.length > 0 && cards.every((c) => c.isGeneral && c.generalKind === "staff")) {
    return sortStaffGenerals(cards);
  }

  const groups = new Map<string, UnitCard[]>();
  for (const c of cards) {
    const k = c.capGroupKey;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
  }

  const ordered: { anchor: UnitCard; cards: UnitCard[] }[] = [];
  for (const members of groups.values()) {
    const base = members.find((c) => c.unitKey === c.capGroupKey);
    const anchorCost = base ? base.cost : Math.max(...members.map((c) => c.cost));
    const commanders = members.filter((c) => c !== base);
    const expensive = commanders.filter((c) => c.cost > anchorCost).sort(compareWithinSide);
    const cheaper = commanders.filter((c) => c.cost <= anchorCost).sort(compareWithinSide);
    const groupCards = [...expensive, ...(base ? [base] : []), ...cheaper];
    ordered.push({ anchor: base ?? expensive[0] ?? cheaper[0], cards: groupCards });
  }

  // Order groups by broad type (infantry, cavalry, artillery), then by the
  // anchor's within-side rank (cost desc) inside each type — so foot and horse
  // guns interleave purely by cost.
  ordered.sort((g1, g2) => {
    const r1 = brigadeTypeRank(g1.anchor);
    const r2 = brigadeTypeRank(g2.anchor);
    if (r1 !== r2) return r1 - r2;
    return compareWithinSide(g1.anchor, g2.anchor);
  });

  return ordered.flatMap((g) => g.cards);
}

/** Staff generals: highest stars left, unrated last; name + key tie-breakers. */
export function sortStaffGenerals(cards: UnitCard[]): UnitCard[] {
  return [...cards].sort((a, b) => {
    const sa = a.commandStars ?? -1;
    const sb = b.commandStars ?? -1;
    if (sa !== sb) return sb - sa;
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.unitKey.localeCompare(b.unitKey);
  });
}

export function towBrigadeIndexOf(unitClass: string): number {
  return towBrigadeIndexOfCard(unitClass);
}

/** Combined Theatres-of-War layout: dissolve the per-source-corps divisions and
 *  pool every card into one corps. Staff generals lift out into a top row; every
 *  other unit is grouped by its brigade type (cavalry heavy → … → artillery)
 *  across all corps, each brigade ordered by the normal price rule. Backs the
 *  TOW "Combine corps" view; the caller maps each brigade to a grid section. */
export function combinedTowLayout(cards: UnitCard[]): {
  staffGenerals: UnitCard[];
  brigades: { brigade: number; cards: UnitCard[] }[];
} {
  const staffGenerals: UnitCard[] = [];
  const rest: UnitCard[] = [];
  for (const c of cards) {
    if (c.isGeneral && c.generalKind === "staff") staffGenerals.push(c);
    else rest.push(c);
  }
  return { staffGenerals: sortStaffGenerals(staffGenerals), brigades: towBrigades(rest) };
}

export function towBrigades(cards: UnitCard[]): { brigade: number; cards: UnitCard[] }[] {
  const byBrigade = new Map<number, UnitCard[]>();
  for (const card of cards) {
    const brigade = towBrigadeIndexOfCard(card);
    const group = byBrigade.get(brigade) ?? [];
    group.push(card);
    byBrigade.set(brigade, group);
  }
  return [...byBrigade.entries()]
    .sort(([a], [b]) => a - b)
    .map(([brigade, group]) => ({ brigade, cards: orderBrigadeCards(group) }));
}
