// Card ordering for the grid (section 8 & 9).
//
// Within a brigade, each base unit and its commander variants stay together:
// expensive commanders to the left of the base, then the base, then cheaper/equal
// commanders to the right. Staff generals sort by command stars.

import type { UnitCard } from "../domain/types";

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

  // Order groups: keep unit classes together, then by the anchor's within-side rank.
  ordered.sort((g1, g2) => {
    const c1 = g1.anchor.underlyingUnitClass || g1.anchor.unitClass;
    const c2 = g2.anchor.underlyingUnitClass || g2.anchor.unitClass;
    if (c1 !== c2) return c1.localeCompare(c2);
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
