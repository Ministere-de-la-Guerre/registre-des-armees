from __future__ import annotations

import csv
import hashlib
import re
import shutil
from collections import defaultdict
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATABASE_PATH = PROJECT_ROOT / "data" / "generated" / "ntw3_army_builder_units.csv"
TABLE_DIR = PROJECT_ROOT / "source" / "tables"
ORIGINAL_ICON_DIR = (
    PROJECT_ROOT
    / "source"
    / "original_ntw3_v94_staff_general_icons"
    / "ui"
    / "units"
    / "icons"
)
OUTPUT_DIR = PROJECT_ROOT / "assets" / "staff_general_icons_by_corps"
PLACEMENT_REPORT = PROJECT_ROOT / "reports" / "staff_general_corps_placement.csv"
ROOT_PLACEMENT_REPORT = PROJECT_ROOT / "data" / "staff_generals" / "staff_general_corps_placement.csv"
ROOT_STAR_PLACEMENT_REPORT = PROJECT_ROOT / "data" / "staff_generals" / "staff_general_corps_placement_with_stars.csv"
INVENTORY_REPORT = PROJECT_ROOT / "reports" / "staff_general_original_icon_inventory.csv"
SUMMARY_REPORT = PROJECT_ROOT / "reports" / "staff_general_corps_summary.md"

ORIGINAL_PACK = (
    "NTW3/Version94/Graphics/cards94.pack"
)
PERMISSION_TABLE = "db/units_to_exclusive_faction_permissions_tables/units_to_exclusive_faction_permissions"
LAND_UNIT_TABLE = "db/units_tables/ntw3_land_units"
RATING_TABLE = "db/mp_general_command_ratings_tables/mp_general_command_ratings"
LOCALISATION_FILE = "NTW3/Version94/Data/txt.9401.pack:text/localisation.loc"

STAFF_KEY_RE = re.compile(r"_gen_staff_(?P<corps_id>\d+)_(?P<rank>\d+)_(?P<id>\d+)")
ICON_KEY_RE = re.compile(r"gen_staff_(?P<body>\d+_\d+_\d+)_icon\.tga$", re.IGNORECASE)


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_tsv_with_lines(path: Path) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle, delimiter="\t")
        headers = next(reader)
        for line_number, values in enumerate(reader, start=2):
            if not values or values[0].startswith("#"):
                continue
            values += [""] * (len(headers) - len(values))
            row = dict(zip(headers, values))
            row["source_line"] = str(line_number)
            rows.append(row)
    return rows


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_csv(path: Path, rows: list[dict[str, str]], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    database_rows = [
        row for row in read_csv(DATABASE_PATH) if "_gen_staff_" in row["unit_key"]
    ]
    permissions = read_tsv_with_lines(
        TABLE_DIR / "units_to_exclusive_faction_permissions.tsv"
    )
    land_units = read_tsv_with_lines(TABLE_DIR / "ntw3_land_units.tsv")
    ratings = read_tsv_with_lines(TABLE_DIR / "mp_general_command_ratings.tsv")

    permission_lines = {
        (row["key"], row["faction"]): row["source_line"]
        for row in permissions
        if row.get("allowed", "").casefold() == "true"
    }
    land_lines: dict[str, list[str]] = defaultdict(list)
    for row in land_units:
        land_lines[row["key"]].append(row["source_line"])
    rating_lines: dict[str, list[str]] = defaultdict(list)
    for row in ratings:
        rating_lines[row["unit_key"]].append(row["source_line"])

    original_icons = {path.name: path for path in ORIGINAL_ICON_DIR.glob("*gen_staff*_icon.tga")}
    if not original_icons:
        raise FileNotFoundError(f"No extracted original staff icons found in {ORIGINAL_ICON_DIR}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    placement_rows: list[dict[str, str]] = []
    referenced_icons: dict[str, list[dict[str, str]]] = defaultdict(list)
    copied_destinations: set[Path] = set()

    for row in database_rows:
        unit_key = row["unit_key"]
        faction_key = row["faction_key"]
        icon_filename = row["icon_filename"]
        source = original_icons.get(icon_filename)
        is_tow = row["is_tow_variant"].casefold() == "true"
        key_match = STAFF_KEY_RE.search(unit_key)
        encoded_rank = key_match.group("rank") if key_match else ""

        if is_tow:
            destination = OUTPUT_DIR / "TOW" / icon_filename
            recommended_placement = "TOW (combined staff-general folder)"
        else:
            destination = OUTPUT_DIR / faction_key / icon_filename
            recommended_placement = f"{faction_key} corps root"

        copy_status = "missing_from_original_pack_extract"
        original_hash = ""
        existing_asset_hash = ""
        hashes_match = ""
        if source is not None:
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination not in copied_destinations:
                shutil.copy2(source, destination)
                copied_destinations.add(destination)
            copy_status = "copied_from_original_cards94"
            original_hash = sha256(source)

            existing_asset_path = PROJECT_ROOT / row["icon_path"]
            if existing_asset_path.is_file():
                existing_asset_hash = sha256(existing_asset_path)
                hashes_match = str(original_hash == existing_asset_hash).lower()

        permission_line = permission_lines.get((unit_key, faction_key), "")
        referenced_icons[icon_filename].append(row)
        placement_rows.append(
            {
                "unit_key": unit_key,
                "faction_key": faction_key,
                "army_corps_name": row["army_corps_name"],
                "unit_name": row["unit_name"],
                "is_tow_variant": row["is_tow_variant"],
                "encoded_staff_rank": encoded_rank,
                "command_stars": row["command_stars"],
                "command_star_icon_path": row.get("command_star_icon_path", ""),
                "command_star_strip_path": row.get("command_star_strip_path", ""),
                "command_star_layout": row.get("command_star_layout", ""),
                "base_mp_cost": row["base_mp_cost"],
                "unit_cap": row["unit_cap"],
                "recommended_placement": recommended_placement,
                "placement_basis": "exact unit_key + faction_key permission with allowed=true",
                "permission_table": PERMISSION_TABLE,
                "permission_source_line": permission_line,
                "land_unit_table": LAND_UNIT_TABLE,
                "land_unit_source_lines": ";".join(land_lines.get(unit_key, [])),
                "rating_table": RATING_TABLE,
                "rating_source_lines": ";".join(rating_lines.get(unit_key, [])),
                "localisation_source": LOCALISATION_FILE,
                "original_pack": ORIGINAL_PACK,
                "original_internal_icon_path": f"ui/units/icons/{icon_filename}",
                "original_extracted_path": source.relative_to(PROJECT_ROOT).as_posix() if source else "",
                "copied_icon_path": destination.relative_to(PROJECT_ROOT).as_posix(),
                "original_sha256": original_hash,
                "existing_asset_sha256": existing_asset_hash,
                "matches_existing_asset": hashes_match,
                "copy_status": copy_status,
            }
        )

    inventory_rows: list[dict[str, str]] = []
    unassigned_dir = OUTPUT_DIR / "_UNASSIGNED_OR_ALTERNATE_ORIGINALS"
    for filename, source in sorted(original_icons.items()):
        references = referenced_icons.get(filename, [])
        non_tow_references = [row for row in references if row["is_tow_variant"].casefold() != "true"]
        tow_references = [row for row in references if row["is_tow_variant"].casefold() == "true"]
        match = ICON_KEY_RE.search(filename)
        inferred_key = f"ntw3_gen_staff_{match.group('body')}" if match else ""

        if non_tow_references:
            status = "assigned_to_corps"
        elif tow_references:
            status = "tow_only"
        else:
            status = "not_referenced_by_allowed_corps_or_tow_rows"
            unassigned_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, unassigned_dir / filename)

        inventory_rows.append(
            {
                "icon_filename": filename,
                "inferred_unit_key": inferred_key,
                "status": status,
                "non_tow_corps_keys": ";".join(
                    sorted({row["faction_key"] for row in non_tow_references})
                ),
                "non_tow_corps_names": ";".join(
                    sorted({row["army_corps_name"] for row in non_tow_references})
                ),
                "tow_keys": ";".join(sorted({row["faction_key"] for row in tow_references})),
                "unit_names": ";".join(sorted({row["unit_name"] for row in references})),
                "original_pack": ORIGINAL_PACK,
                "original_internal_icon_path": f"ui/units/icons/{filename}",
                "original_extracted_path": source.relative_to(PROJECT_ROOT).as_posix(),
                "original_sha256": sha256(source),
            }
        )

    placement_fields = [
        "unit_key", "faction_key", "army_corps_name", "unit_name", "is_tow_variant",
        "encoded_staff_rank", "command_stars", "command_star_icon_path",
        "command_star_strip_path", "command_star_layout", "base_mp_cost", "unit_cap",
        "recommended_placement", "placement_basis", "permission_table",
        "permission_source_line", "land_unit_table", "land_unit_source_lines",
        "rating_table", "rating_source_lines", "localisation_source", "original_pack",
        "original_internal_icon_path", "original_extracted_path", "copied_icon_path",
        "original_sha256", "existing_asset_sha256", "matches_existing_asset", "copy_status",
    ]
    inventory_fields = [
        "icon_filename", "inferred_unit_key", "status", "non_tow_corps_keys",
        "non_tow_corps_names", "tow_keys", "unit_names", "original_pack",
        "original_internal_icon_path", "original_extracted_path", "original_sha256",
    ]
    write_csv(PLACEMENT_REPORT, placement_rows, placement_fields)
    write_csv(ROOT_STAR_PLACEMENT_REPORT, placement_rows, placement_fields)
    try:
        write_csv(ROOT_PLACEMENT_REPORT, placement_rows, placement_fields)
    except PermissionError:
        print(f"Skipped locked root CSV: {ROOT_PLACEMENT_REPORT.name}")
    write_csv(INVENTORY_REPORT, inventory_rows, inventory_fields)

    missing_originals = sum(row["copy_status"] != "copied_from_original_cards94" for row in placement_rows)
    hash_mismatches = sum(row["matches_existing_asset"] == "false" for row in placement_rows)
    unassigned_originals = sum(
        row["status"] == "not_referenced_by_allowed_corps_or_tow_rows"
        for row in inventory_rows
    )
    summary = f"""# NTW3 Staff-General Icon Placement

## Result

- Original source set: NTW3 v9.4 `cards94.pack`, `db.9401.pack`, and `txt.9401.pack`.
- Original staff-general icons extracted read-only: {len(original_icons)}.
- Allowed staff-general placement rows: {len(placement_rows)}.
- Non-ToW corps placements: {sum(row['is_tow_variant'].casefold() != 'true' for row in database_rows)}.
- ToW placements combined into one folder: {sum(row['is_tow_variant'].casefold() == 'true' for row in database_rows)}.
- Original icons not referenced by an allowed corps or ToW row: {unassigned_originals}.
- Placement rows missing an original icon: {missing_originals}.
- Hash mismatches against the repository's earlier icon extraction: {hash_mismatches}.

## Placement Rule

The exact corps assignment comes from `{PERMISSION_TABLE}` using
`unit_key + faction_key` where `allowed=true`. The readable corps name comes from
`factions_screen_name_<faction_key>` in `{LOCALISATION_FILE}`. Staff-general units
do not carry `ACDV<division>B<brigade>` tags, so their recommended location is the
army-corps root rather than a division folder. ToW icons are kept together.

## Files

- Organized copies: `assets/staff_general_icons_by_corps/`
- Exact placement evidence: `reports/staff_general_corps_placement.csv`
- Staff placement CSV: `data/staff_generals/staff_general_corps_placement.csv`
- Star-ready staff CSV: `data/staff_generals/staff_general_corps_placement_with_stars.csv`
- Complete original icon inventory: `reports/staff_general_original_icon_inventory.csv`
- Raw read-only extraction copies: `source/original_ntw3_v94_staff_general_icons/`
"""
    SUMMARY_REPORT.write_text(summary, encoding="utf-8")

    print(f"Original icons: {len(original_icons)}")
    print(f"Placement rows: {len(placement_rows)}")
    print(f"Organized copied destinations: {len(copied_destinations)}")
    print(f"Unassigned or alternate originals: {unassigned_originals}")
    print(f"Missing original icons: {missing_originals}")
    print(f"Hash mismatches: {hash_mismatches}")

    if missing_originals or hash_mismatches:
        raise SystemExit("Staff-general collection completed with verification failures.")


if __name__ == "__main__":
    main()
