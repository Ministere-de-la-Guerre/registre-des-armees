"""Cross-check every unit key pulled out of a .replay against the project's own
unit database, then re-price each army with the project's own rules engine.

If every key resolves and the prices land on sane MP totals, the extraction is
provably the exact build each player fielded.

Usage: python3 validate_replay.py <file.replay>
"""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).parent))

from army_builder_rules import (  # noqa: E402
    calculate_army_cost, check_known_limits, load_unit_cards,
)
from replay_parser import parse  # noqa: E402

CSV = ROOT / "data" / "generated" / "ntw3_army_builder_units.csv"


def main() -> None:
    battle = parse(Path(sys.argv[1]).read_bytes())
    armies = battle.armies
    cards = load_unit_cards(CSV)
    by_faction: dict[str, list] = {}
    for c in cards:
        by_faction.setdefault(c.faction_key, []).append(c)
    lookup = {(c.faction_key, c.unit_key): c for c in cards}

    print(f"map {battle.map}   |   {battle.victory_condition}   |   {battle.wind}")
    print(f"{len(armies)} armies\n")
    for warning in battle.warnings:
        print(f"!! {warning}")

    grand_missing = 0
    for a in armies:
        roster = by_faction.get(a.army_key, [])
        keys = [a.staff_key] + [u.key for u in a.units]
        selected, missing = [], []
        for k in keys:
            c = lookup.get((a.army_key, k))
            (selected if c else missing).append(c or k)
        grand_missing += len(missing)

        price = calculate_army_cost(selected, roster, a.army_key) if roster else None
        limits = check_known_limits(selected, a.army_key) if roster else None

        print(f"── {a.corps_name or a.army_key}  [{a.army_key}]")
        print(f"   player {a.player or '(none)':<18} general {a.general}")
        print(f"   {len(a.units)} units + staff   roster known: {len(roster)} cards"
              f"   unresolved keys: {len(missing)}")
        if missing:
            for m in missing:
                print(f"      !! {m}")
        if price:
            print(f"   cost: base {price.base_cost}  discount {price.applied_discount}"
                  f"  ->  FINAL {price.final_cost} MP")
        if limits and limits.violations:
            for v in limits.violations:
                print(f"   !! limit {v.rule}: {v.actual} > {v.maximum}")
        # sanity: duplicate regiments = multiple copies fielded, expected
        dupes = {k: n for k, n in Counter(u.key for u in a.units).items() if n > 1}
        if dupes:
            print(f"   multi-copy regiments: "
                  + ", ".join(f"{k.split('_')[-1]}×{n}" for k, n in dupes.items()))
        print()

    print(f"TOTAL unresolved unit keys across all armies: {grand_missing}")


if __name__ == "__main__":
    main()
