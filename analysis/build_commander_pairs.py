"""Unit ↔ commander pairs: the input of the commander blind study.

Every commander variant (a named general leading a unit: `is_commander_variant`,
`unit_class = general`) in the Theatre-of-War and Custom armies has a regular
counterpart in the same army — the same unit key without `_com_<id>`. This writes
one row per commander with the regular unit and the commander version side by
side, so a study of "how is a commander priced, given its unit?" needs nothing
else.

Scope matches analysis/unit_pricing.py: ToW + Custom, without the developer
corps (aaa_lordz, austria, hannover, saxony), corps with a rating only.

Output: analysis/commander_blind/data/pairs.csv

    python analysis/build_commander_pairs.py
"""

from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
import unit_pricing as up  # noqa: E402

OUT = common.COMMANDER_PAIRS
STATS = ("morale", "melee_attack", "melee_defense", "charge_bonus", "accuracy", "reload_skill", "ammo", "range")
FLAGS = ("can_form_square", "has_stamina", "is_shock_resistant", "can_inspire", "has_guerrilla_deployment",
         "can_place_stakes", "can_place_mines", "scares_enemies", "can_build_barricades",
         "guard_mode", "skirmish", "can_snipe", "pike_square")
ARM = common.ARM_SHORT


def build_pairs(out: Path = OUT, scope=None, side=None) -> None:
    """Write the regular / commander pairs of the rows in `scope` (default: ToW + Custom,
    unit_pricing.in_scope) with `side` (default unit_pricing.side_of) to `out`."""
    scope = up.in_scope if scope is None else scope
    side = up.side_of if side is None else side
    ratings = up.load_ratings()
    with up.DATA_CSV.open(encoding="utf-8-sig", newline="") as fh:
        rows = [r for r in csv.DictReader(fh) if scope(r) and r["faction_key"] in ratings]
    regular = {(r["faction_key"], r["unit_key"]): r for r in rows if r["is_general"] != "true"}
    commanders = [r for r in rows if r["is_general"] == "true" and r["is_commander_variant"] == "true"]
    header = ["pair_id", "faction_key", "army_corps_name", "corps_number", "side", "arm", "unit_class",
              "regular_unit_key", "commander_unit_key", "commander_name", "command_stars",
              "regular_price", "commander_price", "regular_men", "commander_men", "regular_guns", "commander_guns",
              "speed_tag", "training_level", "regular_rank_depth", "commander_rank_depth"]
    header += [f"{side}_{s}" for s in STATS for side in ("regular", "commander")]
    header += [f"{side}_{f}" for f in FLAGS for side in ("regular", "commander")]
    out.parent.mkdir(parents=True, exist_ok=True)
    unmatched = 0
    with out.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        for i, c in enumerate(sorted(commanders, key=lambda r: (r["faction_key"], r["unit_key"]))):
            r = regular.get((c["faction_key"], re.sub(r"_com_\d+", "", c["unit_key"])))
            if r is None:
                unmatched += 1
                continue
            tag = up.SPEED_TAG_RE.search(r["unit_name"])
            line = [i + 1, c["faction_key"], c["army_corps_name"], ratings[c["faction_key"]], side(c),
                    ARM[c["unit_key"].split("_")[1]], r["unit_class"], r["unit_key"], c["unit_key"], c["unit_name"],
                    int(up.num(c["command_stars"])), r["base_mp_cost"], c["base_mp_cost"], r["men_raw"], c["men_raw"],
                    r["guns"], c["guns"], tag.group(0).strip("[] ") if tag else "", r["unit_training_level"],
                    r["rank_depth"], c["rank_depth"]]
            line += [x[s] or "0" for s in STATS for x in (r, c)]
            line += [int(x[f] == "true") for f in FLAGS for x in (r, c)]
            w.writerow(line)
    print(f"{len(commanders) - unmatched} pairs ({unmatched} commanders without a counterpart) → {out.relative_to(up.ROOT)}")


def main() -> int:
    build_pairs()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
