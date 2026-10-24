"""Analysis-only superset of the army-builder units CSV.

The app's dataset (``data/generated/ntw3_army_builder_units.csv``) carries only
what a unit card displays, so engine stats the builder never shows are dropped
during the merge in ``build_ntw3_army_builder_database.py``. This script re-joins
those columns for offline analysis without touching the app's data contract:
nothing here feeds ``build_web_data.py``, so adding a column cannot change the
shipped JSON or require a SCHEMA_VERSION bump.

Output: ``data/generated/ntw3_units_analysis.csv`` — every column of the builder
CSV, in the same order, followed by the engine stats in EXTRA_STAT_COLUMNS and
the faction-classification columns in CLASSIFICATION_COLUMNS.

Run from the repository root:

    python tools/build_analysis_dataset.py [--check]

``--check`` validates and reports without writing.
"""

from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parent.parent
BUILDER_CSV = ROOT / "data" / "generated" / "ntw3_army_builder_units.csv"
CATALOG_CSV = ROOT / "data" / "generated" / "army_corps_catalog.csv"
STATS_TSV = ROOT / "source" / "tables" / "ntw3_unit_stats_land.tsv"
PROJECTILES_TSV = ROOT / "source" / "tables" / "ntw3_land_projectiles.tsv"
OUTPUT_CSV = ROOT / "data" / "generated" / "ntw3_units_analysis.csv"

# Engine columns lifted from ntw3_unit_stats_land.tsv. These are analysis inputs,
# not card fields — the builder deliberately does not show them. Append here to
# widen the dataset; no other file needs changing.
EXTRA_STAT_COLUMNS = (
    # Quality tier: elite | well_trained | trained | poorly_trained | mob.
    "unit_training_level",
    # Which formations the engine grants the unit.
    "unit_drill_set",
    # Model packing. The spacings are effectively constant per arm; rank_depth is
    # the per-unit dial, so frontage is spacing x rank_depth x men.
    "rank_depth",
    "base_density",
    "close_formation_spacing_horizontal",
    "close_formation_spacing_vertical",
    "loose_formation_spacing_horizontal",
    "loose_formation_spacing_vertical",
    # In-game abilities the description "Abilities:" line does not list. (The
    # engine's `disciplined` and `fatigue_resistance` are omitted: they duplicate
    # the shock-resistant and stamina description traits, Jaccard 100% / 98.6%.)
    "skirmish",        # skirmish mode
    "guard_mode",      # melee guard mode — distinct from stakes (Jaccard 24%)
    "can_snipe",
    "pike_square",     # forms a solid rather than a hollow square
)

# Ballistics of the projectile a unit fires (joined on the builder's
# projectile_key). These are what the game simulates, and they are shared across
# nations — so they measure calibre consistently where names mix units (Russian
# funt, Ottoman okka, Persian pewend). (source column, output column).
EXTRA_PROJECTILE_COLUMNS = (
    ("damage", "projectile_damage"),
    ("base_reload_time", "projectile_reload_time"),
)

# Derived columns. faction_kind/corps_side answer "is this row an Army Corps, a
# Theatre of War, or a Custom Army unit"; the source_corps_* columns resolve a
# ToW unit back to the AC corps it is drawn from.
CLASSIFICATION_COLUMNS = (
    "faction_kind",
    "corps_side",
    "source_corps_id",
    "source_corps_faction_key",
    "source_corps_name",
)

# The builder CSV is written with a BOM and CRLF line endings for byte-stable
# diffs across platforms; match it so the two files compare cleanly.
ENCODING = "utf-8-sig"
LINE_TERMINATOR = "\r\n"


def read_csv(path: Path, delimiter: str = ",") -> list[dict[str, str]]:
    with path.open(encoding=ENCODING, newline="") as handle:
        return list(csv.DictReader(handle, delimiter=delimiter))


def faction_kind(faction_key: str) -> str:
    """Army Corps, Theatre of War, or Custom Army, from the faction key alone.

    Verified exhaustive over all 297 corps and all 25 668 unit rows: every key
    either contains ``_ac_`` or starts with ``ntw3_tow_``, never both, and the
    remainder are the Custom Armies. Agrees row-for-row with the ``is_tow_variant``
    column and with the presence of ``_tow_<id>`` in the unit key.
    """
    if "_ac_" in faction_key:
        return "army_corps"
    if faction_key.startswith("ntw3_tow_"):
        return "theatre_of_war"
    return "custom"


def source_corps_id(unit_key: str, is_tow: bool) -> str:
    """The AC corps a ToW unit is drawn from — the 4th underscore component.

    Port of ``towSourceCorpsIdOf`` in web/src/domain/tow.ts; keep in parity.
    e.g. ntw3_inf_line_081_030_2438_tow_032_com_3016 -> "081". All 207 ids seen
    in the data resolve to a real AC faction key suffix.
    """
    if not is_tow:
        return ""
    parts = unit_key.split("_")
    return parts[3] if len(parts) > 3 else ""


def build_corps_lookups(catalog: Iterable[dict[str, str]]) -> tuple[dict[str, str], dict[str, tuple[str, str]]]:
    """(faction_key -> side, AC key numeric suffix -> (faction_key, corps name))."""
    sides: dict[str, str] = {}
    by_suffix: dict[str, tuple[str, str]] = {}
    for row in catalog:
        key = row["faction_key"]
        sides[key] = row["side"]
        if "_ac_" in key:
            by_suffix[key.rsplit("_", 1)[-1]] = (key, row["army_corps_name"])
    return sides, by_suffix


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate without writing")
    args = parser.parse_args()

    for path in (BUILDER_CSV, CATALOG_CSV, STATS_TSV, PROJECTILES_TSV):
        if not path.exists():
            print(f"missing input: {path}", file=sys.stderr)
            return 1

    units = read_csv(BUILDER_CSV)
    if not units:
        print(f"no rows in {BUILDER_CSV}", file=sys.stderr)
        return 1
    base_columns = list(units[0])

    sides, ac_by_suffix = build_corps_lookups(read_csv(CATALOG_CSV))

    # First occurrence wins, matching the game loader's duplicate-key resolution
    # (see resolve_first_occurrence in build_ntw3_army_builder_database.py).
    stats: dict[str, dict[str, str]] = {}
    for row in read_csv(STATS_TSV, delimiter="\t"):
        stats.setdefault(row["key"], row)
    projectiles: dict[str, dict[str, str]] = {}
    for row in read_csv(PROJECTILES_TSV, delimiter="\t"):
        projectiles.setdefault(row["key"], row)

    unresolved_stats: list[str] = []
    unresolved_source: list[str] = []
    out_rows: list[dict[str, str]] = []

    for unit in units:
        unit_key = unit["unit_key"]
        faction_key = unit["faction_key"]
        kind = faction_kind(faction_key)
        is_tow = kind == "theatre_of_war"

        stat_row = stats.get(unit_key)
        if stat_row is None:
            unresolved_stats.append(unit_key)

        source_id = source_corps_id(unit_key, is_tow)
        source_key, source_name = ac_by_suffix.get(source_id, ("", ""))
        if is_tow and not source_key:
            unresolved_source.append(unit_key)

        row = dict(unit)
        for column in EXTRA_STAT_COLUMNS:
            row[column] = (stat_row or {}).get(column, "") or ""
        projectile = projectiles.get(unit["projectile_key"], {})
        for source, column in EXTRA_PROJECTILE_COLUMNS:
            row[column] = projectile.get(source, "") or ""
        row["faction_kind"] = kind
        row["corps_side"] = sides.get(faction_key, "")
        row["source_corps_id"] = source_id
        row["source_corps_faction_key"] = source_key
        row["source_corps_name"] = source_name
        out_rows.append(row)

    projectile_columns = [column for _, column in EXTRA_PROJECTILE_COLUMNS]
    columns = base_columns + list(EXTRA_STAT_COLUMNS) + projectile_columns + list(CLASSIFICATION_COLUMNS)

    # The classification must agree with the column the builder already emits; a
    # mismatch means a faction key changed shape and faction_kind needs revisiting.
    disagreements = [
        r["unit_key"] for r in out_rows
        if (r["is_tow_variant"].strip().lower() == "true") != (r["faction_kind"] == "theatre_of_war")
    ]

    print(f"rows                 {len(out_rows)}")
    print(f"columns              {len(columns)} ({len(base_columns)} base "
          f"+ {len(EXTRA_STAT_COLUMNS)} stats + {len(projectile_columns)} projectile "
          f"+ {len(CLASSIFICATION_COLUMNS)} derived)")
    with_projectile = sum(1 for r in out_rows if r["projectile_damage"])
    print(f"with projectile row  {with_projectile}")
    print(f"faction_kind         {dict(Counter(r['faction_kind'] for r in out_rows))}")
    print(f"corps_side           {dict(Counter(r['corps_side'] for r in out_rows))}")
    print(f"training levels      {dict(Counter(r['unit_training_level'] for r in out_rows))}")
    print(f"missing stats row    {len(unresolved_stats)}")
    print(f"unresolved ToW source{len(unresolved_source):>5}")
    print(f"is_tow_variant disagreements {len(disagreements)}")

    if unresolved_stats:
        print(f"  e.g. {unresolved_stats[:3]}", file=sys.stderr)
    if unresolved_source:
        print(f"  e.g. {unresolved_source[:3]}", file=sys.stderr)
    if disagreements:
        print(f"  e.g. {disagreements[:3]}", file=sys.stderr)
        print("faction_kind disagrees with is_tow_variant — refusing to write", file=sys.stderr)
        return 1

    if args.check:
        print("\n--check: nothing written")
        return 0

    OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_CSV.open("w", encoding=ENCODING, newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator=LINE_TERMINATOR)
        writer.writeheader()
        writer.writerows(out_rows)

    size_mb = OUTPUT_CSV.stat().st_size / 1_048_576
    print(f"\nwrote {OUTPUT_CSV.relative_to(ROOT)} ({size_mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
