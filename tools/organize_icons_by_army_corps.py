from __future__ import annotations

import csv
import re
import shutil
from collections import Counter
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATABASE_PATH = PROJECT_ROOT / "ntw3_army_builder_units.csv"
OUTPUT_DIR = PROJECT_ROOT / "assets" / "icons_by_army_corps"
MANIFEST_PATH = PROJECT_ROOT / "reports" / "icon_army_corps_manifest.csv"
SUMMARY_PATH = PROJECT_ROOT / "reports" / "icon_army_corps_summary.txt"

DIVISION_RE = re.compile(r"^ACDV(?P<division>\d+)B(?P<brigade>\d+)$", re.IGNORECASE)
INVALID_PATH_CHARS_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_component(value: str, fallback: str) -> str:
    cleaned = INVALID_PATH_CHARS_RE.sub("_", value.strip()).rstrip(". ")
    return cleaned or fallback


def read_rows() -> list[dict[str, str]]:
    with DATABASE_PATH.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        required = {
            "unit_key",
            "faction_key",
            "division_brigade_code",
            "division_id",
            "brigade_id",
            "is_tow_variant",
            "icon_filename",
            "icon_path",
        }
        missing = required.difference(reader.fieldnames or [])
        if missing:
            raise ValueError(f"Database is missing columns: {', '.join(sorted(missing))}")
        return list(reader)


def destination_for(row: dict[str, str]) -> tuple[Path, str, str, str]:
    if row["is_tow_variant"].strip().lower() == "true":
        return OUTPUT_DIR / "TOW" / row["icon_filename"], "TOW", "", ""

    corps_key = safe_component(row["faction_key"], "Unknown_Army_Corps")
    code = row["division_brigade_code"].strip()
    match = DIVISION_RE.fullmatch(code)
    division = row["division_id"].strip()
    brigade = row["brigade_id"].strip()
    if match:
        division = match.group("division")
        brigade = match.group("brigade")

    division_folder = f"Division_{int(division):02d}" if division.isdigit() else "Unassigned"
    destination = OUTPUT_DIR / corps_key / division_folder / row["icon_filename"]
    return destination, corps_key, division, brigade


def main() -> None:
    rows = read_rows()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)

    counters: Counter[str] = Counter()
    seen_destinations: dict[Path, Path] = {}
    manifest_rows: list[dict[str, str]] = []

    for row in rows:
        source_text = row["icon_path"].strip()
        filename = row["icon_filename"].strip()
        if not source_text or not filename:
            counters["missing_icon_reference"] += 1
            continue

        source = (PROJECT_ROOT / Path(source_text)).resolve()
        destination, corps_key, division, brigade = destination_for(row)
        status = "copied"

        if not source.is_file():
            counters["missing_source_file"] += 1
            status = "missing_source_file"
        elif destination in seen_destinations:
            if seen_destinations[destination] == source:
                counters["duplicate_destination_skipped"] += 1
                status = "duplicate_destination_skipped"
            else:
                suffix = safe_component(row["unit_key"], "unit")
                destination = destination.with_name(
                    f"{destination.stem}__{suffix}{destination.suffix}"
                )
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
                seen_destinations[destination] = source
                counters["renamed_collision_copy"] += 1
                status = "renamed_collision_copy"
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            seen_destinations[destination] = source
            counters["copied"] += 1

        if row["is_tow_variant"].strip().lower() == "true":
            counters["tow_rows"] += 1
        elif division:
            counters["division_rows"] += 1
        else:
            counters["unassigned_rows"] += 1

        manifest_rows.append(
            {
                "army_corps_key": corps_key,
                "division_id": division,
                "brigade_id": brigade,
                "unit_key": row["unit_key"],
                "source_icon_path": source.relative_to(PROJECT_ROOT).as_posix(),
                "organized_icon_path": destination.relative_to(PROJECT_ROOT).as_posix(),
                "status": status,
            }
        )

    manifest_fields = [
        "army_corps_key",
        "division_id",
        "brigade_id",
        "unit_key",
        "source_icon_path",
        "organized_icon_path",
        "status",
    ]
    with MANIFEST_PATH.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=manifest_fields)
        writer.writeheader()
        writer.writerows(manifest_rows)

    corps_directories = [path for path in OUTPUT_DIR.iterdir() if path.is_dir() and path.name != "TOW"]
    summary_lines = [
        "NTW3 icon organization by army corps",
        f"database_rows: {len(rows)}",
        f"army_corps_directories: {len(corps_directories)}",
        f"copied_files: {counters['copied'] + counters['renamed_collision_copy']}",
        f"division_rows: {counters['division_rows']}",
        f"unassigned_rows: {counters['unassigned_rows']}",
        f"tow_rows: {counters['tow_rows']}",
        f"duplicate_destinations_skipped: {counters['duplicate_destination_skipped']}",
        f"renamed_collision_copies: {counters['renamed_collision_copy']}",
        f"missing_icon_references: {counters['missing_icon_reference']}",
        f"missing_source_files: {counters['missing_source_file']}",
        f"output_directory: {OUTPUT_DIR.relative_to(PROJECT_ROOT).as_posix()}",
        f"manifest: {MANIFEST_PATH.relative_to(PROJECT_ROOT).as_posix()}",
    ]
    SUMMARY_PATH.write_text("\n".join(summary_lines) + "\n", encoding="utf-8")
    print("\n".join(summary_lines))

    if counters["missing_source_file"] or counters["missing_icon_reference"]:
        raise SystemExit("Icon organization completed with missing icon data; inspect the manifest.")


if __name__ == "__main__":
    main()
