"""Build app-ready army-corps flag assets and theatre metadata."""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import shutil
from collections import defaultdict
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FLAGS = Path(r"C:\Users\M0obo\Desktop\NTW3 Files\9.4\graphic\ui\flags")
GENERATED_DATA = ROOT / "data" / "generated"
MAIN_CSV = GENERATED_DATA / "ntw3_army_builder_units.csv"
FACTIONS_TSV = ROOT / "source" / "tables" / "ntw3_factions.tsv"
OUTPUT = ROOT / "assets" / "army_corps_by_theatre"
CATALOG_CSV = GENERATED_DATA / "army_corps_catalog.csv"
CATALOG_JSON = GENERATED_DATA / "army_corps_catalog.json"
REPORT = ROOT / "reports" / "army_corps_catalog_validation.txt"

CORPS_RE = re.compile(
    r"^ntw3_(?P<kind>ac|tow)_(?P<side>[abc])(?P<block>\d+)_[^_]+_(?P<id>\d+)$"
)

# Titles visible in the supplied English selection screenshots. The a16/b16
# blocks exist in the source faction table but are not visible in those images.
THEATRES = {
    "a04": (10, "Egypt (1798-1801)", "screenshot"),
    "a03": (20, "Rhine-Italy (1798-1800)", "screenshot"),
    "a15": (30, "Liberation War (1804-1813)", "screenshot"),
    "a05": (40, "Germany (1805)", "screenshot"),
    "a06": (50, "Prussia (1806-1807)", "screenshot"),
    "a07": (60, "Finland (1808-1809)", "screenshot"),
    "a08": (70, "Austria (1809)", "screenshot"),
    "a09": (80, "Spain (1809)", "screenshot"),
    "a13": (90, "Spain (1811)", "screenshot"),
    "a10": (100, "War of 1812 (1812)", "screenshot"),
    "a11": (110, "Russia (1812)", "screenshot"),
    "a16": (120, "German Campaign (1813)", "source_block_inference"),
    "a17": (130, "France (1814)", "screenshot"),
    "a14": (140, "Naples (1815)", "screenshot"),
    "a12": (150, "Hundred Days (1815)", "screenshot"),
    "b04": (10, "Egypt (1798-1801)", "screenshot"),
    "b03": (20, "2nd Coalition (1798-1800)", "screenshot"),
    "b15": (30, "Subjugation (1804-1813)", "screenshot"),
    "b05": (40, "3rd Coalition (1805)", "screenshot"),
    "b06": (50, "4th Coalition (1806-1807)", "screenshot"),
    "b07": (60, "Finland (1808-1809)", "screenshot"),
    "b08": (70, "5th Coalition (1809)", "screenshot"),
    "b09": (80, "Peninsular War (1809)", "screenshot"),
    "b13": (90, "Peninsular War (1811)", "screenshot"),
    "b10": (100, "War of 1812 (1812)", "screenshot"),
    "b11": (110, "Patriotic War (1812)", "screenshot"),
    "b16": (120, "German Campaign (1813)", "source_block_inference"),
    "b17": (130, "France (1814)", "screenshot"),
    "b14": (140, "Italy (1815)", "screenshot"),
    "b12": (150, "Hundred Days (1815)", "screenshot"),
}


def slug(value: str) -> str:
    value = value.casefold().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", "_", value).strip("_")


def identity(key: str) -> tuple[str, str, str, int] | None:
    match = CORPS_RE.fullmatch(key)
    if not match:
        return None
    return (
        match.group("kind"), match.group("side"), match.group("block"),
        int(match.group("id")),
    )


def load_main_factions() -> dict[str, str]:
    names: dict[str, str] = {}
    with MAIN_CSV.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle):
            names.setdefault(row["faction_key"], row["army_corps_name"])
    return names


def load_source_factions() -> tuple[dict[tuple[str, str, str, int], dict[str, str]], dict[str, dict[str, str]]]:
    corps: dict[tuple[str, str, str, int], dict[str, str]] = {}
    standard: dict[str, dict[str, str]] = {}
    with FACTIONS_TSV.open(newline="", encoding="utf-8-sig") as handle:
        for row in csv.DictReader(handle, delimiter="\t"):
            key = row.get("key", "")
            if key.startswith("#"):
                continue
            parsed = identity(key)
            if parsed is None:
                standard[key] = row
            else:
                corps[parsed] = row
    return corps, standard


def source_flag_directory(flags_root: Path, source_row: dict[str, str]) -> Path:
    raw = source_row["flags_path"].replace("\\", "/")
    return flags_root / Path(raw).name


def contingent_code(source_key: str) -> str:
    return source_key.split("_")[3]


def clean_flag_donor(
    source_row: dict[str, str], source_corps: dict[tuple[str, str, str, int], dict[str, str]],
    flags_root: Path,
) -> dict[str, str] | None:
    target_code = contingent_code(source_row["key"])
    target_index = int(source_row["index"])
    candidates = [
        row for row in source_corps.values()
        if contingent_code(row["key"]) == target_code
        and (source_flag_directory(flags_root, row) / "mini_flag.tga").is_file()
    ]
    return min(candidates, key=lambda row: abs(int(row["index"]) - target_index), default=None)


def theatre_for(key: str) -> tuple[str, int, str, str]:
    parsed = identity(key)
    if parsed is None:
        return "custom", 1000, "Custom Armies", "source_faction_table"
    kind, side, block, _ = parsed
    if kind == "tow":
        side_name = {
            "a": "tow_french_imperial",
            "b": "tow_coalition",
            "c": "tow_french_imperial",
        }[side]
        return side_name, 900, "Theatres of War", "screenshot"
    group_key = f"{side}{block}"
    order, title, basis = THEATRES[group_key]
    side_name = "empire" if side == "a" else "coalition"
    return side_name, order, title, basis


def display_numbers(name: str) -> tuple[int | None, int | None]:
    tow = re.match(r"^\[(?P<year>\d{4})\]\s*(?P<rating>\d+)", name)
    if tow:
        return int(tow.group("year")), int(tow.group("rating"))
    rating = re.match(r"^(?P<rating>\d+)\.", name)
    return None, int(rating.group("rating")) if rating else None


def copy_selection_flag(source_dir: Path, destination_dir: Path) -> tuple[str, str, str, str]:
    source = next(
        (source_dir / name for name in (
            "mini_flag.tga", "id_flag_infantry.tga", "id_flag_cavalry.tga",
            "id_flag_artillery.tga", "large.tga", "large.dds", "small.tga",
        )
         if (source_dir / name).is_file()),
        None,
    )
    if source is None:
        raise FileNotFoundError(f"Missing selection flag in: {source_dir}")
    destination_dir.mkdir(parents=True, exist_ok=True)
    tga = destination_dir / "flag.tga"
    png = destination_dir / "flag.png"
    with Image.open(source) as image:
        prepared = image.convert("RGBA")
        if prepared.size == (44, 22):
            method = "native_44x22"
        else:
            alpha_box = prepared.getchannel("A").getbbox()
            if alpha_box is not None:
                prepared = prepared.crop(alpha_box)
            prepared = prepared.resize((44, 22), Image.Resampling.LANCZOS)
            method = "alpha_crop_and_resize_44x22"
        prepared.save(tga)
        prepared.save(png)
    return (
        source.name, method, tga.relative_to(ROOT).as_posix(),
        png.relative_to(ROOT).as_posix(),
    )


def copy_post_selection_flag(
    source_dir: Path, destination_dir: Path
) -> tuple[str, str, str]:
    source = source_dir / "flag_132.tga"
    if not source.is_file():
        return "", "", ""
    tga = destination_dir / "post_selection_flag.tga"
    png = destination_dir / "post_selection_flag.png"
    shutil.copy2(source, tga)
    with Image.open(source) as image:
        image.save(png)
    return (
        source.name, tga.relative_to(ROOT).as_posix(),
        png.relative_to(ROOT).as_posix(),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--flags-root", type=Path, default=DEFAULT_FLAGS)
    args = parser.parse_args()

    main_factions = load_main_factions()
    source_corps, source_standard = load_source_factions()
    rows: list[dict[str, object]] = []
    missing_source: list[str] = []
    missing_flags: list[str] = []
    flag_source_counts: dict[str, int] = defaultdict(int)
    post_selection_count = 0

    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)

    for faction_key, main_name in main_factions.items():
        parsed = identity(faction_key)
        if parsed is None:
            source_row = source_standard.get(faction_key)
        else:
            source_row = source_corps.get(parsed)
        if source_row is None:
            missing_source.append(faction_key)
            continue

        side, theatre_order, theatre_name, theatre_basis = theatre_for(faction_key)
        destination = OUTPUT / side / f"{theatre_order:04d}_{slug(theatre_name)}" / faction_key
        source_dir = source_flag_directory(args.flags_root, source_row)
        selection_source_row = source_row
        try:
            flag_source_file, flag_derivation, tga_path, png_path = copy_selection_flag(
                source_dir, destination
            )
        except FileNotFoundError:
            donor = clean_flag_donor(source_row, source_corps, args.flags_root)
            if donor is None:
                missing_flags.append(faction_key)
                continue
            selection_source_row = donor
            flag_source_file, flag_derivation, tga_path, png_path = copy_selection_flag(
                source_flag_directory(args.flags_root, donor), destination
            )
            flag_derivation = "same_contingent_donor_" + flag_derivation

        variants = sorted(path.name for path in source_dir.iterdir() if path.is_file())
        flag_source_counts[flag_source_file] += 1
        post_source, post_tga_path, post_png_path = copy_post_selection_flag(
            source_dir, destination
        )
        if post_source:
            post_selection_count += 1
        display_name = main_name or html.unescape(source_row["screen_name"])
        display_year, display_rating = display_numbers(display_name)
        rows.append({
            "side": side,
            "theatre_order": theatre_order,
            "theatre_name": theatre_name,
            "theatre_basis": theatre_basis,
            "faction_key": faction_key,
            "canonical_source_faction_key": source_row["key"],
            "corps_order": int(source_row["index"]),
            "army_corps_name": display_name,
            "display_year": display_year if display_year is not None else "",
            "display_rating": display_rating if display_rating is not None else "",
            "theatre_display_order": 0,
            "source_flag_directory": source_row["flags_path"].replace("\\", "/"),
            "available_source_flag_files": "|".join(variants),
            "selection_flag_source_file": flag_source_file,
            "selection_flag_derivation": flag_derivation,
            "selection_flag_donor_source_faction_key": (
                selection_source_row["key"] if selection_source_row is not source_row else ""
            ),
            "flag_tga_path": tga_path,
            "flag_png_path": png_path,
            "post_selection_flag_source_file": post_source,
            "post_selection_flag_tga_path": post_tga_path,
            "post_selection_flag_png_path": post_png_path,
        })

    theatre_rows: dict[tuple[str, str], list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        theatre_rows[(str(row["side"]), str(row["theatre_name"]))].append(row)
    for members in theatre_rows.values():
        members.sort(key=lambda row: (
            int(row["display_year"]) if row["display_year"] != "" else 0,
            -int(row["display_rating"]) if row["display_rating"] != "" else 0,
            int(row["corps_order"]),
        ))
        for position, row in enumerate(members, start=1):
            row["theatre_display_order"] = position

    rows.sort(key=lambda row: (
        {
            "empire": 0,
            "coalition": 1,
            "tow_french_imperial": 2,
            "tow_coalition": 3,
            "custom": 4,
        }[str(row["side"])],
        int(row["theatre_order"]), int(row["theatre_display_order"]),
        str(row["faction_key"]),
    ))
    fields = list(rows[0])
    with CATALOG_CSV.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)

    grouped: dict[str, dict[str, list[dict[str, object]]]] = defaultdict(lambda: defaultdict(list))
    for row in rows:
        grouped[str(row["side"])][str(row["theatre_name"])].append(row)
    CATALOG_JSON.write_text(
        json.dumps(grouped, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    inferred = sorted({str(row["theatre_name"]) for row in rows if row["theatre_basis"] == "source_block_inference"})
    REPORT.write_text("\n".join([
        "NTW3 army-corps theatre and flag validation",
        "===========================================",
        f"catalog rows: {len(rows)}",
        f"main factions: {len(main_factions)}",
        f"missing source faction mappings: {len(missing_source)}",
        f"missing selection flags: {len(missing_flags)}",
        f"theatre groups: {len({(row['side'], row['theatre_name']) for row in rows})}",
        "selection flag sources: " + ", ".join(
            f"{name}={count}" for name, count in sorted(flag_source_counts.items())
        ),
        f"authored post-selection flags: {post_selection_count}",
        "",
        "Theatre names inferred from source blocks not visible in screenshots:",
        *(inferred or ["none"]),
        "",
        "Missing source mappings:",
        *(missing_source or ["none"]),
        "",
        "Missing flags:",
        *(missing_flags or ["none"]),
    ]) + "\n", encoding="utf-8")

    if missing_source or missing_flags:
        raise SystemExit("Catalog validation failed; see report.")
    print(f"Wrote {len(rows)} corps to {CATALOG_CSV}")
    print(f"Assets: {OUTPUT}")


if __name__ == "__main__":
    main()
