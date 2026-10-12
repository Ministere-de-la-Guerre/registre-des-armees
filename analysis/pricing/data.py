"""Loading units and staff generals from the analysis CSV, with corps ratings, sides and scope.

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

import csv
import sys
from dataclasses import dataclass, field
from typing import Callable

from common import CATALOG_CSV, DATA_CSV
from pricing.pickling import pickled_as_unit_pricing
from pricing.constants import ABILITIES, DEV_CORPS, EXTRA_ABILITIES, IMPERIAL_CUSTOM, NUMERIC, SPEED_TAG_RE


# --- Loading ------------------------------------------------------------------

@pickled_as_unit_pricing
@dataclass
class Unit:
    key: str
    name: str
    faction: str
    corps: str
    side: str            # imperial | coalition
    rating: int          # corps display_rating
    arm: str             # infantry | cavalry | artillery
    unit_class: str
    n: float             # models = men_raw / 2
    cost: int
    raw_tag: str         # speed tag exactly as in the name ("GS2", "DR")
    speed: str           # GS folded into S ("S2"); "DR" for camels
    speed_code: str      # pipeline value, kept only for the mismatch check
    is_camel: bool
    is_gs: bool
    training: str
    drill: str
    shot: str
    firearm: str
    weapon: str
    projectile: str
    rank_depth: float
    guns: float
    values: dict[str, float] = field(default_factory=dict)


@pickled_as_unit_pricing
@dataclass
class Staff:
    key: str
    name: str
    faction: str
    corps: str
    side: str
    rating: int
    stars: int
    cost: int


def load_ratings() -> dict[str, int]:
    """faction_key -> display_rating, the number that opens a corps name."""
    with CATALOG_CSV.open(encoding="utf-8-sig", newline="") as handle:
        return {row["faction_key"]: int(row["display_rating"])
                for row in csv.DictReader(handle) if row["display_rating"].strip().isdigit()}


def side_of(row: dict[str, str]) -> str:
    if row["corps_side"] == "tow_french_imperial" or row["faction_key"] in IMPERIAL_CUSTOM:
        return "imperial"
    return "coalition"


def in_scope(row: dict[str, str]) -> bool:
    return row["faction_kind"] in ("theatre_of_war", "custom") and row["faction_key"] not in DEV_CORPS


def num(text: str) -> float:
    text = text.strip()
    return float(text) if text else 0.0


def load(ratings: dict[str, int], scope: Callable[[dict[str, str]], bool] | None = None,
         side: Callable[[dict[str, str]], str] | None = None) -> tuple[list[Unit], list[Staff], list[str], list[str]]:
    """Units and staff generals of the analysis dataset, with the rows in `scope` and their `side`:
    ToW + Custom by default (in_scope, side_of); ac_pricing passes its Army Corps rules."""
    scope = in_scope if scope is None else scope
    side = side_of if side is None else side
    with DATA_CSV.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    missing = [c for c in ("skirmish", "projectile_damage", "rank_depth") if c not in rows[0]]
    if missing:
        sys.exit(f"{DATA_CSV.name} lacks {missing} — re-run tools/build_analysis_dataset.py")
    units: list[Unit] = []
    staff: list[Staff] = []
    unparsed: list[str] = []
    unrated: set[str] = set()
    for row in rows:
        if not scope(row):
            continue
        faction = row["faction_key"]
        if faction not in ratings:
            unrated.add(faction)
            continue
        if row["is_general"] == "true":
            # Staff rule: raw Men ∈ {32, 122} (Men/2 ∈ {16, 61}); only 32 occurs here.
            if row["men_raw"] in ("32", "122"):
                staff.append(Staff(
                    key=row["unit_key"], name=row["unit_name"], faction=faction,
                    corps=row["army_corps_name"], side=side(row), rating=ratings[faction],
                    stars=int(num(row["command_stars"])), cost=int(row["base_mp_cost"]),
                ))
            continue
        if row["unit_class"] == "artillery_fixed":
            continue
        match = SPEED_TAG_RE.search(row["unit_name"])
        if not match:
            unparsed.append(row["unit_key"])
            continue
        letter, tier = match.groups()
        raw_tag = letter + tier
        values = {column: num(row[column]) for column in NUMERIC}
        values["has_range"] = 1.0 if values["range"] > 0 else 0.0
        for column in ABILITIES + EXTRA_ABILITIES + ("pike_square",):
            values[column] = 1.0 if row[column] == "true" else 0.0
        values["proj_damage"] = num(row["projectile_damage"])
        values["proj_reload"] = num(row["projectile_reload_time"])
        units.append(Unit(
            key=row["unit_key"], name=row["unit_name"], faction=faction, corps=row["army_corps_name"],
            side=side(row), rating=ratings[faction],
            arm=row["unit_class"].split("_")[0], unit_class=row["unit_class"],
            n=int(row["men_raw"]) / 2, cost=int(row["base_mp_cost"]),
            raw_tag=raw_tag, speed=("S" if letter == "GS" else letter) + tier, speed_code=row["speed_code"],
            is_camel=raw_tag == "DR", is_gs=letter == "GS",
            training=row["unit_training_level"], drill=row["unit_drill_set"],
            shot=row["range_selection_method"], firearm=row["firearm"] or row["weapon_key"] or "none",
            weapon=row["weapon_key"], projectile=row["projectile_key"],
            rank_depth=num(row["rank_depth"]), guns=num(row["guns"]), values=values,
        ))
    return units, staff, unparsed, sorted(unrated)
