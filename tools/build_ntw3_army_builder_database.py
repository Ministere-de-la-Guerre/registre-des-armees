#!/usr/bin/env python3
"""Build the NTW3 army-builder unit database from the exported TSV files."""

from __future__ import annotations

import csv
import math
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable

import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parent.parent
TSV_DIR = PROJECT_ROOT / "source" / "tables"
ICON_DIR = PROJECT_ROOT / "assets" / "icons"
REPORT_DIR = PROJECT_ROOT / "reports"
UNIFORMS_PATH = (
    PROJECT_ROOT / "source" / "reference" / "non-campaign-db" / "9.6"
    / "uniforms_tables" / "ntw3_uniforms.tsv"
)

INPUT_FILES = [
    "localisation.loc.tsv",
    "mp_general_command_ratings.tsv",
    "ntw3_battle_entities.tsv",
    "ntw3_land_projectiles.tsv",
    "ntw3_land_units.tsv",
    "ntw3_unit_stats_land.tsv",
    "units_to_exclusive_faction_permissions.tsv",
    "gun_type_to_projectiles.tsv",
]

OUTPUT_COLUMNS = [
    "unit_key", "faction_key", "army_corps_name", "unit_name", "unit_class", "men_raw",
    "men_display", "speed_code", "speed_entity_key", "division_brigade_code",
    "division_id", "brigade_id", "base_mp_cost", "unit_cap", "range",
    "weapon_key", "projectile_key", "range_selection_method", "command_stars",
    "command_star_icon_path", "command_star_strip_path", "command_star_layout",
    "is_general", "is_commander_variant", "is_tow_variant", "icon_name",
    "icon_filename", "icon_path", "icon_match_method",
    "accuracy", "reload_skill", "morale", "melee_attack", "melee_defense",
    "charge_bonus", "can_form_square", "has_stamina", "is_shock_resistant",
    "can_inspire", "has_guerrilla_deployment", "guerrilla_badge_path",
    "guerrilla_badge_layout", "can_place_stakes",
    "can_place_mines", "scares_enemies", "can_build_barricades",
    "placement_source",
]

# These two source keys have conflicting duplicate localisation rows. The original
# in-game card identifies the shared portrait and biography as Wintzingerode.
UNIT_NAME_OVERRIDES = {
    "ntw3_gen_staff_285_2_0600": "Ferdinand von Wintzingerode",
    "ntw3_gen_staff_285_2_0600_tow_057": "Ferdinand von Wintzingerode",
}

# In-game placement confirmed for Bonaparte / Italie.C. This explicit seed is
# needed because every card in its fifth division lacks an ACDV tag; the general
# final-division fallback can then resolve the remaining untagged corps cards.
DIVISION_PLACEMENT_OVERRIDES = {
    ("ntw3_ac_a03_x5_080", "ntw3_art_foot_080_006_0206"): (5, 1),
    ("ntw3_ac_a03_x5_080", "ntw3_art_foot_080_006_0207"): (5, 1),
    ("ntw3_ac_a03_x5_080", "ntw3_art_foot_080_006_0209"): (5, 1),
    ("ntw3_ac_a03_x5_080", "ntw3_art_foot_080_006_0209_com_0308"): (5, 1),
    ("ntw3_ac_a03_x5_080", "ntw3_art_horse_080_002_0704"): (5, 2),
    ("ntw3_ac_a03_x5_080", "ntw3_art_horse_080_005_0703"): (5, 2),
    ("ntw3_ac_a03_x5_080", "ntw3_inf_line_080_999_2437"): (5, 3),
    ("ntw3_ac_a03_x5_080", "ntw3_inf_skirm_080_999_4755"): (5, 3),
}

WARNING_COLUMNS = [
    "warning_type", "unit_key", "faction_key", "source_file", "source_row",
    "reference_value", "details",
]
SPEED_MAP = {
    **{f"inf_gren_v{i}": f"G{i}" for i in range(1, 7)},
    **{f"inf_line_v{i}": f"L{i}" for i in range(1, 7)},
    **{f"inf_skirm_v{i}": f"S{i}" for i in range(1, 4)},
    **{f"inf_skirmg_v{i}": f"GS{i}" for i in range(1, 4)},
    **{f"cav_v{i}": f"C{i}" for i in range(1, 6)},
    **{f"art_foot_v{i}": f"F{i}" for i in range(1, 7)},
    **{f"art_horse_v{i}": f"H{i}" for i in range(1, 4)},
}

DIVISION_RE = re.compile(r"ACDV(\d+)B(\d+)")
COMMANDER_SUFFIX_RE = re.compile(r"_com_\d+$")
ABILITY_LINE_RE = re.compile(r"^\s*Abilit(?:y|ies):\s*([^\\\r\n]+)", re.IGNORECASE)
ICON_EXTENSIONS = {".tga", ".png", ".jpg", ".jpeg", ".webp"}
SAPPER_RE = re.compile(
    r"sappers?|sapeurs?|sappeurs?|sap[eé]ri|saper|pioniere|pionier|pioneers?|"
    r"engineers?|ingenj[oö]r|artificers?|artífices|zapadores|gastadores",
    re.IGNORECASE,
)
MARINE_RE = re.compile(r"marins?|marines?", re.IGNORECASE)


def blank(value: object) -> bool:
    return value is None or pd.isna(value) or str(value) == ""


def text_value(value: object) -> str:
    return "" if blank(value) else str(value)


def resolve_stats(
    unit_key: str,
    stats_lookup: dict[str, pd.Series],
    stats_first_lookup: dict[str, pd.Series] | None = None,
) -> tuple[pd.Series | None, str]:
    stats = stats_lookup.get(unit_key)
    if stats is not None:
        return stats, "unit"
    if COMMANDER_SUFFIX_RE.search(unit_key):
        base_key = COMMANDER_SUFFIX_RE.sub("", unit_key)
        base_stats = stats_lookup.get(base_key)
        if base_stats is not None:
            return base_stats, "base_unit"
    # The strict unique lookup drops a key whose stats row is an ambiguous duplicate
    # (balance-edited rows that conflict only on cost/cap), leaving the unit with no
    # Men, speed entity, or combat stats at all. The game loads the first occurrence
    # of a duplicate key, so fall back to that first-declared row to recover the full
    # stat block (Men, speed, accuracy, …) deterministically.
    if stats_first_lookup is not None:
        first = stats_first_lookup.get(unit_key)
        if first is not None:
            return first, "first_occurrence"
        if COMMANDER_SUFFIX_RE.search(unit_key):
            base_first = stats_first_lookup.get(COMMANDER_SUFFIX_RE.sub("", unit_key))
            if base_first is not None:
                return base_first, "base_first_occurrence"
    return None, ""


def final_division_category(row: pd.Series) -> str:
    """Classify a card into a support-brigade category (or "" for combat arms)."""
    unit_key = text_value(row.get("unit_key"))
    unit_name = text_value(row.get("unit_name"))
    unit_class = text_value(row.get("unit_class"))
    if unit_key.startswith(("ntw3_art_foot_", "ntw3_art_fixed_")) or unit_class in {
        "artillery_foot", "artillery_fixed"
    }:
        return "foot_artillery"
    if unit_key.startswith("ntw3_art_horse_") or unit_class == "artillery_horse":
        return "horse_artillery"
    if unit_key.startswith("ntw3_inf_skirm_") or SAPPER_RE.search(unit_name) or MARINE_RE.search(unit_name):
        return "specialists"
    return ""


def _row_is_guerrilla(row: pd.Series) -> bool:
    return text_value(row.get("has_guerrilla_deployment")).casefold() == "true"


def _support_brigade(category: str, is_guerrilla: bool, category_brigades: dict[str, int]) -> int:
    """Pick the support-division brigade for a card. Guerrilla artillery sits in
    its own brigade, separate from non-guerrilla artillery of the same type — the
    game never mixes guerrilla and non-guerrilla artillery in a single brigade.
    Specialists (skirmishers/sappers/marines) are NOT split: the game does mix
    guerrilla and non-guerrilla infantry-type units within a brigade."""
    if is_guerrilla and category == "foot_artillery":
        return category_brigades["specialists"] + 1
    if is_guerrilla and category == "horse_artillery":
        return category_brigades["specialists"] + 2
    return category_brigades[category]


def _set_placement(
    output: pd.DataFrame, index: object, division_id: int, brigade_id: int, source: str
) -> None:
    output.loc[index, ["division_brigade_code", "division_id", "brigade_id", "__placement_source"]] = (
        f"ACDV{division_id}B{brigade_id}", str(division_id), str(brigade_id), source,
    )


def infer_final_division_placements(output: pd.DataFrame) -> dict[str, list[str]]:
    """Resolve untagged support cards into a real final support division.

    A corps' final artillery/support division is frequently entirely untagged. The
    naive ``max(existing division_id)`` then merges that artillery into the last
    *combat* division. Instead, decide whether the highest explicitly tagged
    division is already a support division (it contains artillery): if so, untagged
    support cards join it; if not, a *new* division is created after the highest
    combat division. Verified overrides are applied first and always win.

    Returns a report mapping warning-kind -> list of human-readable details.
    """
    report: dict[str, list[str]] = {
        "ambiguous_no_tagged_division": [],
        "created_support_division": [],
        "reused_support_division": [],
    }

    for (faction_key, unit_key), (division_id, brigade_id) in DIVISION_PLACEMENT_OVERRIDES.items():
        mask = (output["faction_key"] == faction_key) & (output["unit_key"] == unit_key)
        output.loc[mask, ["division_brigade_code", "division_id", "brigade_id"]] = (
            f"ACDV{division_id}B{brigade_id}", str(division_id), str(brigade_id)
        )
        output.loc[mask, "__placement_source"] = "verified_override"

    for faction_key, indexes in output.groupby("faction_key").groups.items():
        faction = text_value(faction_key)
        if not faction.startswith("ntw3_ac_"):
            continue
        corps = output.loc[indexes]

        unresolved = corps.loc[(corps["division_id"] == "") & (corps["is_general"] != "true")]
        unresolved_support = [
            (index, row)
            for index, row in unresolved.iterrows()
            if final_division_category(row)
        ]

        # Division 0 (ACDV0B*) is the game's reserve/support division. When a corps
        # has one, *all* of its reserve support consolidates there — the division-0
        # tagged artillery plus any untagged support — organised by category brigade
        # (foot=1, horse=2, specialists=3), which is how the in-game builder lays the
        # reserve division out. It is displayed after the combat divisions (the
        # web remap sorts division 0 last). Divisional artillery tagged into a combat
        # division (e.g. ACDV4B4) is untouched and stays with its division.
        # Guerrilla artillery splits into its own brigade (foot=4, horse=5); see
        # _support_brigade.
        reserve_brigades = {"foot_artillery": 1, "horse_artillery": 2, "specialists": 3}
        div0 = corps.loc[(corps["division_id"] == "0") & (corps["is_general"] != "true")]
        if not div0.empty:
            for index, row in div0.iterrows():
                category = final_division_category(row)
                if category:
                    brigade = _support_brigade(category, _row_is_guerrilla(row), reserve_brigades)
                    _set_placement(output, index, 0, brigade, "reserve_support_division")
            for index, row in unresolved_support:
                category = final_division_category(row)
                brigade = _support_brigade(category, _row_is_guerrilla(row), reserve_brigades)
                _set_placement(output, index, 0, brigade, "reserve_support_division")
            report["reused_support_division"].append(f"{faction}: division 0 (reserve)")
            continue

        if not unresolved_support:
            continue

        placed = corps.loc[(corps["division_id"] != "") & (corps["is_general"] != "true")].copy()
        if placed.empty:
            report["ambiguous_no_tagged_division"].append(
                f"{faction}: {len(unresolved_support)} untagged support cards but no tagged division to anchor."
            )
            continue
        placed["__division_number"] = pd.to_numeric(placed["division_id"], errors="coerce")
        max_tagged = int(placed["__division_number"].max())

        # Is the highest tagged division *itself* an artillery/support division?
        # It must be made up ENTIRELY of support units (no combat infantry/cavalry):
        # a combat division that merely carries some divisional artillery (e.g. Junot's
        # cavalry division with an organic horse battery) is NOT the support division —
        # its untagged reserve artillery belongs in a new division after it, not merged
        # in. `final_division_category` returns "" for combat arms.
        final_rows = placed.loc[placed["__division_number"] == max_tagged].copy()
        final_categories = {final_division_category(row) for _, row in final_rows.iterrows()}
        final_has_artillery = bool(final_categories & {"foot_artillery", "horse_artillery"})
        final_is_support_only = bool(final_categories) and "" not in final_categories

        if final_is_support_only and final_has_artillery:
            target_division = max_tagged
            source = "inferred_existing_support_division"
            report["reused_support_division"].append(f"{faction}: division {target_division}")
            final_rows["__brigade_number"] = pd.to_numeric(final_rows["brigade_id"], errors="coerce")
            category_brigades: dict[str, int] = {}
            for category in ("foot_artillery", "horse_artillery", "specialists"):
                matches = final_rows.loc[final_rows.apply(final_division_category, axis=1) == category]
                if not matches.empty:
                    category_brigades[category] = int(matches["__brigade_number"].mode().iloc[0])
            final_brigade = int(final_rows["__brigade_number"].max())
            category_brigades.setdefault("foot_artillery", 1)
            category_brigades.setdefault("horse_artillery", 2)
            category_brigades.setdefault("specialists", max(final_brigade, 3))
        else:
            target_division = max_tagged + 1
            source = "inferred_new_support_division"
            report["created_support_division"].append(f"{faction}: division {target_division}")
            category_brigades = {"foot_artillery": 1, "horse_artillery": 2, "specialists": 3}

        for index, row in unresolved_support:
            category = final_division_category(row)
            brigade = _support_brigade(category, _row_is_guerrilla(row), category_brigades)
            _set_placement(output, index, target_division, brigade, source)

    return report


def inherit_commander_placements(output: pd.DataFrame) -> dict[str, list[str]]:
    """Untagged ``_com_<digits>`` commander variants inherit their base unit's
    division/brigade. Runs after support inference so inferred base artillery is
    available. Records base/commander placement disagreements."""
    report: dict[str, list[str]] = {"inherited": [], "disagreement": []}
    by_faction_unit: dict[tuple[str, str], pd.Series] = {
        (text_value(row["faction_key"]), text_value(row["unit_key"])): row
        for _, row in output.iterrows()
    }
    for index, row in output.iterrows():
        unit_key = text_value(row["unit_key"])
        if not COMMANDER_SUFFIX_RE.search(unit_key):
            continue
        faction = text_value(row["faction_key"])
        base_key = COMMANDER_SUFFIX_RE.sub("", unit_key)
        base = by_faction_unit.get((faction, base_key))
        if base is None or text_value(base["division_id"]) == "":
            continue
        base_div = text_value(base["division_id"])
        base_brig = text_value(base["brigade_id"])
        if text_value(row["division_id"]) == "":
            _set_placement(output, index, int(base_div), int(base_brig), "inherited_base_unit")
            report["inherited"].append(f"{faction}/{unit_key} <- {base_key}")
        elif (
            text_value(row["division_id"]) != base_div
            or text_value(row["brigade_id"]) != base_brig
        ):
            report["disagreement"].append(
                f"{faction}/{unit_key} at ACDV{row['division_id']}B{row['brigade_id']} "
                f"but base {base_key} at ACDV{base_div}B{base_brig}"
            )
    return report


def add_warning(
    warnings: list[dict[str, str]], warning_type: str, unit_key: str = "",
    faction_key: str = "", source_file: str = "", source_row: object = "",
    reference_value: str = "", details: str = "",
) -> None:
    warnings.append({
        "warning_type": warning_type,
        "unit_key": unit_key,
        "faction_key": faction_key,
        "source_file": source_file,
        "source_row": text_value(source_row),
        "reference_value": reference_value,
        "details": details,
    })


def read_tsv(path: Path) -> tuple[pd.DataFrame, int]:
    """Read a TSV while preserving strings and original physical row numbers."""
    rows: list[dict[str, str]] = []
    metadata_count = 0
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle, delimiter="\t")
        try:
            headers = next(reader)
        except StopIteration as exc:
            raise ValueError(f"Empty TSV: {path}") from exc
        headers = [header.strip() for header in headers]
        for source_row, values in enumerate(reader, start=2):
            if values and values[0].startswith("#"):
                metadata_count += 1
                continue
            if not values or all(value == "" for value in values):
                continue
            if len(values) != len(headers):
                raise ValueError(
                    f"{path.name}:{source_row} has {len(values)} fields; expected {len(headers)}"
                )
            row = dict(zip(headers, values))
            row["__source_row"] = str(source_row)
            rows.append(row)
    frame = pd.DataFrame(rows, columns=headers + ["__source_row"], dtype=object)
    frame = frame.replace("", pd.NA)
    assert not frame.iloc[:, 0].fillna("").astype(str).str.startswith("#").any()
    return frame, metadata_count


def dedupe_exact(frame: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    data_columns = [column for column in frame.columns if column != "__source_row"]
    duplicate_mask = frame.duplicated(subset=data_columns, keep="first")
    return frame.loc[~duplicate_mask].copy(), int(duplicate_mask.sum())


def unique_by_key(
    frame: pd.DataFrame, key_columns: list[str], source_file: str,
    warnings: list[dict[str, str]], conflict_unit_column: str = "key",
) -> tuple[pd.DataFrame, set[tuple[str, ...]], int]:
    """Keep only unambiguous keys and log every row belonging to a conflict."""
    frame, exact_duplicates = dedupe_exact(frame)
    grouped = frame.groupby(key_columns, dropna=False, sort=False)
    conflict_keys: set[tuple[str, ...]] = set()
    for raw_key, group in grouped:
        if len(group) <= 1:
            continue
        key_tuple = raw_key if isinstance(raw_key, tuple) else (raw_key,)
        normalized = tuple(text_value(value) for value in key_tuple)
        conflict_keys.add(normalized)
        for _, row in group.iterrows():
            add_warning(
                warnings,
                "duplicate_conflict",
                unit_key=text_value(row.get(conflict_unit_column)),
                faction_key=text_value(row.get("faction")),
                source_file=source_file,
                source_row=row.get("__source_row"),
                reference_value=" | ".join(normalized),
                details="Conflicting duplicate row: " + "; ".join(
                    f"{column}={text_value(row.get(column))}"
                    for column in frame.columns if column != "__source_row"
                ),
            )
    if conflict_keys:
        normalized_series = frame[key_columns].fillna("").astype(str).apply(tuple, axis=1)
        frame = frame.loc[~normalized_series.isin(conflict_keys)].copy()
    return frame, conflict_keys, exact_duplicates


def resolve_first_occurrence(
    frame: pd.DataFrame, key_column: str, source_file: str,
    warnings: list[dict[str, str]],
) -> tuple[pd.DataFrame, set[tuple[str, ...]], int]:
    """Collapse exact duplicates, then resolve any remaining same-key conflicts by
    keeping the **first declared row** rather than dropping the unit.

    ``ntw3_land_units`` ships with duplicate primary keys: a unit's original row is
    followed by one or more balance-edited rows that change only cost/cap columns.
    Total War loads the first occurrence of a duplicate key and ignores the rest, so
    the later rows are inert in-game (confirmed against several in-game card costs and
    caps). The previous ``unique_by_key`` treatment discarded *both* rows, silently
    deleting the unit from every corps that recruits it. Here we instead keep the
    first row, log each superseded duplicate, and never drop the unit.
    """
    frame, exact_duplicates = dedupe_exact(frame)
    resolved_keys: set[tuple[str, ...]] = set()
    for raw_key, group in frame.groupby(key_column, dropna=False, sort=False):
        if len(group) <= 1:
            continue
        key = text_value(raw_key)
        resolved_keys.add((key,))
        kept = group.iloc[0]
        for _, row in group.iloc[1:].iterrows():
            add_warning(
                warnings,
                "resolved_duplicate_first_occurrence",
                unit_key=key,
                source_file=source_file,
                source_row=row.get("__source_row"),
                reference_value=f"kept row {text_value(kept.get('__source_row'))}",
                details="Superseded duplicate row (inert in-game): " + "; ".join(
                    f"{column}={text_value(row.get(column))}"
                    for column in frame.columns
                    if column != "__source_row" and text_value(row.get(column)) != text_value(kept.get(column))
                ),
            )
    if resolved_keys:
        frame = frame.drop_duplicates(subset=[key_column], keep="first").copy()
    return frame, resolved_keys, exact_duplicates


def make_lookup(frame: pd.DataFrame, key: str) -> dict[str, pd.Series]:
    return {
        text_value(row[key]): row
        for _, row in frame.iterrows()
        if not blank(row.get(key))
    }


def consensus_value_lookup(
    frame: pd.DataFrame, key_column: str, value_column: str
) -> dict[str, str]:
    result: dict[str, str] = {}
    for raw_key, group in frame.groupby(key_column, dropna=False, sort=False):
        key = text_value(raw_key)
        values = {
            text_value(value) for value in group[value_column]
            if not blank(value)
        }
        if key and len(values) == 1:
            result[key] = values.pop()
    return result


def first_value_lookup(
    frame: pd.DataFrame, key_column: str, value_column: str
) -> dict[str, str]:
    result: dict[str, str] = {}
    for _, row in frame.iterrows():
        key = text_value(row.get(key_column))
        value = text_value(row.get(value_column))
        if key and value and key not in result:
            result[key] = value
    return result


def localisation_value(
    unit_row: pd.Series, loc_lookup: dict[str, pd.Series], kind: str,
) -> tuple[str, str]:
    unit_key = text_value(unit_row.get("key"))
    if kind == "name":
        raw = text_value(unit_row.get("on_screen_name"))
        candidates = []
        if raw and raw != "-":
            candidates.extend([raw, f"units_on_screen_name_{raw}"])
        candidates.append(f"units_on_screen_name_{unit_key}")
    else:
        raw = text_value(unit_row.get("unit_description_text"))
        candidates = []
        if raw and raw != "-":
            candidates.extend([raw, f"unit_description_texts_description_text_{raw}"])
        candidates.append(f"unit_description_texts_description_text_{unit_key}")
    for candidate in dict.fromkeys(candidates):
        match = loc_lookup.get(candidate)
        if match is not None and not blank(match.get("text")):
            return text_value(match.get("text")), candidate
    return "", ""


def parse_displayed_abilities(description: str) -> dict[str, str]:
    """Parse only the structured Ability/Abilities declaration at the start."""
    match = ABILITY_LINE_RE.match(description)
    tokens: set[str] = set()
    if match:
        tokens = {
            token.strip().casefold()
            for token in re.split(r"\s*,\s*|\s+and\s+", match.group(1))
            if token.strip() and token.strip() != "-"
        }
    ability_tokens = {
        "can_form_square": "square",
        "has_stamina": "stamina",
        "is_shock_resistant": "shock resistant",
        "can_inspire": "inspires",
        "has_guerrilla_deployment": "guerilla",
        "can_place_stakes": "stakes",
        "can_place_mines": "mines",
        "scares_enemies": "scares",
        "can_build_barricades": "barricade",
    }
    return {
        column: str(token in tokens).lower()
        for column, token in ability_tokens.items()
    }


def resolve_speed(stats_row: pd.Series | None, battle_keys: set[str]) -> tuple[str, str, list[str]]:
    if stats_row is None:
        return "", "", []
    references = [
        text_value(stats_row.get(column))
        for column in ("man_entity", "mount_entity", "articulated_entity")
        if not blank(stats_row.get(column))
    ]
    matches = list(dict.fromkeys(
        reference for reference in references
        if reference in SPEED_MAP and reference in battle_keys
    ))
    cavalry = [reference for reference in matches if reference.startswith("cav_v")]
    artillery = [reference for reference in matches if reference.startswith(("art_foot_v", "art_horse_v"))]
    man_entity = text_value(stats_row.get("man_entity"))
    infantry = [
        man_entity
        for prefix in ("inf_gren_v", "inf_line_v", "inf_skirm_v", "inf_skirmg_v")
        if man_entity.startswith(prefix) and man_entity in matches
    ]
    # Mounted and artillery units commonly retain an infantry entity for the rider/crew.
    # The requested entity families therefore take precedence over that incidental reference.
    for family in (cavalry, artillery, infantry):
        if len(family) == 1:
            entity = family[0]
            return SPEED_MAP[entity], entity, references
        if len(family) > 1:
            return "", "", references
    return "", "", references


def select_projectile(
    unit_key: str, stats_row: pd.Series | None, projectiles: dict[str, pd.Series],
    gun_map: dict[str, list[str]], warnings: list[dict[str, str]],
) -> tuple[str, str, str, str]:
    if stats_row is None:
        return "", "", "", ""

    # Some melee cavalry templates name a carried carbine even though the unit has
    # no ammunition and cannot fire. Do not treat equipment-only weapon labels as
    # active ranged weapons.
    try:
        ammunition = int(float(text_value(stats_row.get("ammo")) or "0"))
    except ValueError:
        ammunition = 0
    if ammunition <= 0 and not text_value(stats_row.get("gun_type")):
        return "", "", "", ""

    direct_fields = ["primary_missile_weapon", "default_missile_type"]
    direct = []
    for field in direct_fields:
        value = text_value(stats_row.get(field))
        if value and value in projectiles:
            direct.append((value, field))
    unique_direct = list(dict.fromkeys(value for value, _ in direct))
    if len(unique_direct) == 1:
        projectile_key = unique_direct[0]
        return projectile_key, projectile_key, text_value(projectiles[projectile_key].get("effective_range")), "direct_projectile_match"
    if len(unique_direct) > 1:
        add_warning(warnings, "ambiguous_projectile", unit_key=unit_key,
                    source_file="ntw3_unit_stats_land.tsv",
                    reference_value=" | ".join(unique_direct),
                    details="Multiple direct projectile fields matched exactly.")
        return "", "", "", ""

    gun_type = text_value(stats_row.get("gun_type"))
    if not gun_type:
        weapon_refs = [text_value(stats_row.get(field)) for field in direct_fields if not blank(stats_row.get(field))]
        if weapon_refs:
            add_warning(warnings, "unresolved_weapon", unit_key=unit_key,
                        source_file="ntw3_unit_stats_land.tsv",
                        reference_value=" | ".join(weapon_refs),
                        details="No missile reference exactly matched the projectile table.")
        return "", "", "", ""

    candidates = list(dict.fromkeys(gun_map.get(gun_type, [])))
    lower = gun_type.lower()
    if "rocket" in lower:
        selected = [key for key in candidates if key == "rockets"]
        method = "rocket_projectile"
    elif lower.startswith("unicorn_"):
        selected = [key for key in candidates if key.endswith("_shell")]
        method = "unicorn_shell"
    elif lower.startswith("howitzer_") or lower == "ott_howitzer":
        selected = [key for key in candidates if key.endswith("_shell")]
        method = "howitzer_shell"
    elif lower.startswith("mortar_") or lower == "ott_mortar":
        selected = [key for key in candidates if key.endswith("_shell")]
        method = "mortar_shell"
    elif lower.startswith(("cannon_", "ott_cannon_", "siege_cannon_")):
        selected = [key for key in candidates if key.endswith("_shot")]
        method = "cannon_round_shot"
    else:
        add_warning(warnings, "unresolved_gun_type", unit_key=unit_key,
                    source_file="gun_type_to_projectiles.tsv", reference_value=gun_type,
                    details="Gun type does not match a requested exact selection rule.")
        return gun_type, "", "", ""

    selected = list(dict.fromkeys(selected))
    if len(selected) > 1:
        add_warning(warnings, "ambiguous_projectile", unit_key=unit_key,
                    source_file="gun_type_to_projectiles.tsv", reference_value=gun_type,
                    details="Multiple rule-compliant projectiles: " + " | ".join(selected))
        return gun_type, "", "", ""
    if not selected:
        warning_type = "unresolved_gun_type" if not candidates else "missing_projectile"
        add_warning(warnings, warning_type, unit_key=unit_key,
                    source_file="gun_type_to_projectiles.tsv", reference_value=gun_type,
                    details="No exact projectile satisfied the requested selection rule.")
        return gun_type, "", "", ""
    projectile_key = selected[0]
    projectile = projectiles.get(projectile_key)
    if projectile is None:
        add_warning(warnings, "missing_projectile", unit_key=unit_key,
                    source_file="ntw3_land_projectiles.tsv", reference_value=projectile_key,
                    details="Selected shot_type is absent from the projectile table.")
        return gun_type, "", "", ""
    return gun_type, projectile_key, text_value(projectile.get("effective_range")), method


def scan_icons(
    unit_keys: Iterable[str],
) -> tuple[
    list[Path], dict[str, list[Path]], dict[str, list[Path]],
    dict[str, list[Path]], Counter,
]:
    files = sorted(
        path for path in ICON_DIR.rglob("*")
        if path.is_file() and path.suffix.lower() in ICON_EXTENSIONS
    )
    by_filename: dict[str, list[Path]] = defaultdict(list)
    by_stem: dict[str, list[Path]] = defaultdict(list)
    by_unit_key_body: dict[str, list[Path]] = defaultdict(list)
    extensions: Counter = Counter()
    body_to_key = {
        (key[5:] if key.startswith("ntw3_") else key).casefold(): key
        for key in unit_keys
    }
    for path in files:
        by_filename[path.name.casefold()].append(path)
        by_stem[path.stem.casefold()].append(path)
        extensions[path.suffix.lower()] += 1
        core = path.stem[:-5] if path.stem.casefold().endswith("_icon") else path.stem
        parts = core.casefold().split("_")
        matches = [
            body_to_key[suffix]
            for index in range(len(parts))
            if (suffix := "_".join(parts[index:])) in body_to_key
        ]
        if matches:
            by_unit_key_body[max(matches, key=len)].append(path)
    return files, by_filename, by_stem, by_unit_key_body, extensions


def resolve_icon(
    unit_key: str, icon_name: str, by_filename: dict[str, list[Path]],
    by_stem: dict[str, list[Path]], by_unit_key_body: dict[str, list[Path]],
    warnings: list[dict[str, str]],
) -> tuple[str, str, str]:
    attempts: list[tuple[str, list[Path]]] = []
    if icon_name:
        if Path(icon_name).suffix:
            attempts.append(("icon_name_exact_filename", by_filename.get(Path(icon_name).name.casefold(), [])))
        attempts.append(("icon_name_exact_stem", by_stem.get(Path(icon_name).stem.casefold(), [])))
        attempts.append(("icon_name_added_tga", by_filename.get((icon_name + ".tga").casefold(), [])))
    attempts.append(("unit_key_icon_exact", by_filename.get((unit_key + "_icon.tga").casefold(), [])))
    attempts.append(("unit_key_exact", by_filename.get((unit_key + ".tga").casefold(), [])))
    attempts.append(("unit_key_body_suffix", by_unit_key_body.get(unit_key, [])))
    for method, matches in attempts:
        if len(matches) == 1:
            path = matches[0]
            return path.name, path.relative_to(PROJECT_ROOT).as_posix(), method
        if len(matches) > 1:
            add_warning(warnings, "ambiguous_icon", unit_key=unit_key,
                        source_file="icons", reference_value=icon_name,
                        details=f"{method}: " + " | ".join(path.relative_to(PROJECT_ROOT).as_posix() for path in matches))
            return "", "", ""
    add_warning(warnings, "missing_icon", unit_key=unit_key, source_file="icons",
                reference_value=icon_name, details="No exact icon match found.")
    return "", "", ""


def load_uniform_icon_candidates(
    by_filename: dict[str, list[Path]], by_stem: dict[str, list[Path]],
) -> dict[tuple[str, str], list[Path]]:
    """Map an exact faction/unit pair to icons in uniform-table declaration order."""
    uniforms, _ = read_tsv(UNIFORMS_PATH)
    candidates: dict[tuple[str, str], list[Path]] = defaultdict(list)
    for _, row in uniforms.iterrows():
        key = (text_value(row.get("faction")), text_value(row.get("unit")))
        if not all(key):
            continue
        names = [text_value(row.get("filename")), text_value(row.get("uniform_name"))]
        for name in names:
            if not name:
                continue
            attempts = [
                by_filename.get((name + ".tga").casefold(), []),
                by_filename.get((name + "_icon.tga").casefold(), []),
                by_stem.get(name.casefold(), []),
                by_stem.get((name + "_icon").casefold(), []),
            ]
            for matches in attempts:
                for path in matches:
                    if path not in candidates[key]:
                        candidates[key].append(path)
                if matches:
                    break
    return candidates


def numeric_display(value: str) -> str:
    if not value:
        return ""
    number = float(value)
    return str(math.floor(number / 2))


def write_summary(
    path: Path, frames: dict[str, pd.DataFrame], exact_duplicates: dict[str, int],
    conflicts: dict[str, set[tuple[str, ...]]], metadata_counts: dict[str, int],
    icon_extensions: Counter, output: pd.DataFrame, warnings: list[dict[str, str]],
    representative: dict[str, str], merge_multiplied: bool,
) -> None:
    warning_counts = Counter(warning["warning_type"] for warning in warnings)
    speed_counts = Counter(output["speed_code"].loc[output["speed_code"] != ""])
    method_counts = Counter(output["range_selection_method"].loc[output["range_selection_method"] != ""])
    icon_method_counts = Counter(output["icon_match_method"].loc[output["icon_match_method"] != ""])
    lines = [
        "NTW3 army-builder merge summary",
        f"project_root: {PROJECT_ROOT}",
        f"tsv_directory: {TSV_DIR}",
        f"icon_directory: {ICON_DIR}",
        "",
        "Input TSVs:",
    ]
    key_columns = {
        "localisation.loc.tsv": "key", "mp_general_command_ratings.tsv": "unit_key",
        "ntw3_battle_entities.tsv": "key", "ntw3_land_projectiles.tsv": "key",
        "ntw3_land_units.tsv": "key", "ntw3_unit_stats_land.tsv": "key",
        "units_to_exclusive_faction_permissions.tsv": "key",
        "gun_type_to_projectiles.tsv": "gun_type",
    }
    for name in INPUT_FILES:
        frame = frames[name]
        key = key_columns[name]
        lines.append(
            f"- {name}: rows={len(frame)}, unique_{key}={frame[key].nunique(dropna=True)}, "
            f"exact_duplicates={exact_duplicates.get(name, 0)}, conflict_keys={len(conflicts.get(name, set()))}, "
            f"metadata_rows_removed={metadata_counts[name]}"
        )
    lines.extend(["", "Icons by extension:"])
    lines.extend(f"- {extension}: {count}" for extension, count in sorted(icon_extensions.items()))
    resolved_names = int((output["unit_name"] != "").sum())
    with_placements = int((output["division_brigade_code"] != "").sum())
    placement_sources = Counter(output["__placement_source"].loc[output["__placement_source"] != ""])
    unresolved_corps = int((
        output["faction_key"].str.startswith("ntw3_ac_")
        & output["division_brigade_code"].eq("")
        & output["is_general"].ne("true")
    ).sum())
    lines.extend([
        "", "Final output:",
        f"rows: {len(output)}",
        f"unique_unit_keys: {output['unit_key'].nunique()}",
        f"unique_faction_keys: {output['faction_key'].nunique()}",
        f"resolved_unit_names: {resolved_names}",
        f"unresolved_unit_names: {len(output) - resolved_names}",
        f"units_with_division_placements: {with_placements}",
        f"placements_from_ACDV_tags: {placement_sources['localisation_tag']}",
        f"placements_from_verified_overrides: {placement_sources['verified_override']}",
        f"placements_reused_support_division: {placement_sources['inferred_existing_support_division']}",
        f"placements_created_support_division: {placement_sources['inferred_new_support_division']}",
        f"placements_inherited_base_unit: {placement_sources['inherited_base_unit']}",
        f"army_corps_combat_units_without_placement: {unresolved_corps}",
        f"resolved_speed_codes: {int((output['speed_code'] != '').sum())}",
        "speed_codes: " + ", ".join(f"{key}={value}" for key, value in sorted(speed_counts.items())),
        "unmapped_speed_entities: " + " | ".join(sorted({
            warning["reference_value"] for warning in warnings
            if warning["warning_type"] == "unmapped_speed_entity" and warning["reference_value"]
        })),
        f"resolved_ranges: {int((output['range'] != '').sum())}",
        "ranges_by_selection_method: " + ", ".join(f"{key}={value}" for key, value in sorted(method_counts.items())),
        "unresolved_weapon_keys: " + " | ".join(sorted({w['reference_value'] for w in warnings if w['warning_type'] == 'unresolved_weapon'})),
        "unresolved_gun_types: " + " | ".join(sorted({w['reference_value'] for w in warnings if w['warning_type'] == 'unresolved_gun_type'})),
        "missing_projectile_keys: " + " | ".join(sorted({w['reference_value'] for w in warnings if w['warning_type'] == 'missing_projectile'})),
        f"ambiguous_projectile_selections: {warning_counts['ambiguous_projectile']}",
        f"units_with_command_stars: {int((output['command_stars'] != '').sum())}",
        f"resolved_icons: {int((output['icon_path'] != '').sum())}",
        f"unresolved_icons: {warning_counts['missing_icon']}",
        f"ambiguous_icons: {warning_counts['ambiguous_icon']}",
        "icon_matches_by_method: " + ", ".join(f"{key}={value}" for key, value in sorted(icon_method_counts.items())),
        f"duplicate_conflict_rows: {warning_counts['duplicate_conflict']}",
        f"merge_unexpectedly_multiplied_records: {'yes' if merge_multiplied else 'no'}",
        "", "Warnings by type:",
    ])
    lines.extend(f"- {key}: {value}" for key, value in sorted(warning_counts.items()))
    lines.extend(["", "Representative validation rows:"])
    lines.extend(f"- {kind}: {unit_key or 'not found'}" for kind, unit_key in representative.items())
    lines.extend(["", f"database_complete: {'yes' if not warnings else 'no'}"])
    path.write_text("\n".join(line.rstrip() for line in lines) + "\n", encoding="utf-8")


def first_matching(output: pd.DataFrame, mask: pd.Series) -> str:
    matches = output.loc[mask, "unit_key"]
    return text_value(matches.iloc[0]) if not matches.empty else ""


def main() -> None:
    assert TSV_DIR.is_dir(), f"Missing TSV directory: {TSV_DIR}"
    assert ICON_DIR.is_dir(), f"Missing icon directory: {ICON_DIR}"
    assert UNIFORMS_PATH.is_file(), f"Missing non-campaign uniforms table: {UNIFORMS_PATH}"
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    for filename in INPUT_FILES:
        assert (TSV_DIR / filename).is_file(), f"Missing input: {TSV_DIR / filename}"

    warnings: list[dict[str, str]] = []
    frames: dict[str, pd.DataFrame] = {}
    metadata_counts: dict[str, int] = {}
    exact_duplicates: dict[str, int] = {}
    conflicts: dict[str, set[tuple[str, ...]]] = {}
    for filename in INPUT_FILES:
        frames[filename], metadata_counts[filename] = read_tsv(TSV_DIR / filename)

    unique_specs = {
        "localisation.loc.tsv": (["key"], "key"),
        "mp_general_command_ratings.tsv": (["unit_key"], "unit_key"),
        "ntw3_battle_entities.tsv": (["key"], "key"),
        "ntw3_land_projectiles.tsv": (["key"], "key"),
        "ntw3_unit_stats_land.tsv": (["key"], "key"),
        "units_to_exclusive_faction_permissions.tsv": (["key", "faction"], "key"),
    }
    clean: dict[str, pd.DataFrame] = {}
    for filename, (keys, unit_column) in unique_specs.items():
        clean[filename], conflicts[filename], exact_duplicates[filename] = unique_by_key(
            frames[filename], keys, filename, warnings, unit_column
        )
    # ntw3_land_units ships duplicate primary keys (balance-edited rows that the game
    # ignores). Keep the first declared row instead of dropping the unit entirely. This
    # rule is intentionally scoped to land_units; other tables keep the strict treatment.
    clean["ntw3_land_units.tsv"], conflicts["ntw3_land_units.tsv"], exact_duplicates["ntw3_land_units.tsv"] = (
        resolve_first_occurrence(frames["ntw3_land_units.tsv"], "key", "ntw3_land_units.tsv", warnings)
    )
    clean["gun_type_to_projectiles.tsv"], exact_duplicates["gun_type_to_projectiles.tsv"] = dedupe_exact(
        frames["gun_type_to_projectiles.tsv"]
    )
    conflicts["gun_type_to_projectiles.tsv"] = set()

    land_lookup = make_lookup(clean["ntw3_land_units.tsv"], "key")
    stats_lookup = make_lookup(clean["ntw3_unit_stats_land.tsv"], "key")
    # First-declared (game-loaded) stats row per key, used to recover units the strict
    # unique lookup dropped as ambiguous duplicates (see resolve_stats).
    stats_first_lookup: dict[str, pd.Series] = {}
    for _, _row in frames["ntw3_unit_stats_land.tsv"].iterrows():
        _k = text_value(_row.get("key"))
        if _k and _k not in stats_first_lookup:
            stats_first_lookup[_k] = _row
    consensus_men = consensus_value_lookup(
        frames["ntw3_unit_stats_land.tsv"], "key", "men"
    )
    first_declared_men = first_value_lookup(
        frames["ntw3_unit_stats_land.tsv"], "key", "men"
    )
    loc_lookup = make_lookup(clean["localisation.loc.tsv"], "key")
    rating_lookup = make_lookup(clean["mp_general_command_ratings.tsv"], "unit_key")
    projectile_lookup = make_lookup(clean["ntw3_land_projectiles.tsv"], "key")
    battle_keys = set(clean["ntw3_battle_entities.tsv"]["key"].dropna().astype(str))

    gun_map: dict[str, list[str]] = defaultdict(list)
    for _, row in clean["gun_type_to_projectiles.tsv"].iterrows():
        gun_type = text_value(row.get("gun_type"))
        shot_type = text_value(row.get("shot_type"))
        if gun_type and shot_type:
            gun_map[gun_type].append(shot_type)

    _, by_filename, by_stem, by_unit_key_body, icon_extensions = scan_icons(land_lookup)
    uniform_icon_candidates = load_uniform_icon_candidates(by_filename, by_stem)

    permissions = clean["units_to_exclusive_faction_permissions.tsv"].copy()
    allowed_values = permissions["allowed"].fillna("").astype(str).str.casefold()
    permissions = permissions.loc[allowed_values == "true"].copy()
    assert permissions["allowed"].fillna("").astype(str).str.casefold().eq("true").all()

    unit_cache: dict[str, dict[str, str]] = {}
    output_rows: list[dict[str, str]] = []
    missing_army_corps_warned: set[str] = set()
    for _, permission in permissions.iterrows():
        unit_key = text_value(permission.get("key"))
        faction_key = text_value(permission.get("faction"))
        unit = land_lookup.get(unit_key)
        if unit is None:
            add_warning(warnings, "missing_land_unit", unit_key=unit_key, faction_key=faction_key,
                        source_file="ntw3_land_units.tsv", reference_value=unit_key,
                        details="Allowed permission has no unambiguous land-unit row.")
            continue
        if unit_key not in unit_cache:
            stats, stats_source = resolve_stats(unit_key, stats_lookup, stats_first_lookup)
            if stats is None:
                add_warning(warnings, "missing_land_stats", unit_key=unit_key,
                            source_file="ntw3_unit_stats_land.tsv", reference_value=unit_key,
                            details="No unambiguous land-stats row found.")

            unit_name = UNIT_NAME_OVERRIDES.get(unit_key, "")
            if not unit_name:
                unit_name, _ = localisation_value(unit, loc_lookup, "name")
            if not unit_name:
                add_warning(warnings, "missing_unit_name", unit_key=unit_key,
                            source_file="localisation.loc.tsv", reference_value=text_value(unit.get("on_screen_name")),
                            details="No exact inspected localisation-key candidate resolved.")
            description, _ = localisation_value(unit, loc_lookup, "description")
            displayed_abilities = parse_displayed_abilities(description)
            if (
                stats is not None
                and text_value(stats.get("guerrilla_deployment")).casefold() == "true"
            ):
                displayed_abilities["has_guerrilla_deployment"] = "true"
            tag = DIVISION_RE.search(description)
            if tag:
                division_code, division_id, brigade_id = tag.group(0), tag.group(1), tag.group(2)
                placement_source = "localisation_tag"
            else:
                division_code = division_id = brigade_id = ""
                placement_source = ""

            speed_code, speed_entity, entity_refs = resolve_speed(stats, battle_keys)
            if not speed_code:
                add_warning(warnings, "unmapped_speed_entity", unit_key=unit_key,
                            source_file="ntw3_unit_stats_land.tsv",
                            reference_value=" | ".join(entity_refs),
                            details="No unique mapped entity exists in man_entity, mount_entity, or articulated_entity.")

            weapon_key, projectile_key, range_value, range_method = select_projectile(
                unit_key, stats, projectile_lookup, gun_map, warnings
            )

            icon_name = text_value(unit.get("icon_name"))
            icon_filename, icon_path, icon_method = resolve_icon(
                unit_key, icon_name, by_filename, by_stem, by_unit_key_body, warnings
            )

            unit_class = text_value(unit.get("class"))
            men_raw = text_value(stats.get("men")) if stats is not None else ""
            men_display = ""
            if unit_class.casefold() == "general" and "_gen_staff_" in unit_key and not men_raw:
                men_raw = "32"
            elif not men_raw:
                # The strict per-key stats lookup drops a unit whose stats row is an
                # ambiguous duplicate (balance-edited rows that conflict on cost/cap),
                # leaving Men blank even though the Men value itself is unambiguous.
                # Recover it by consensus exactly as commander variants do, so every
                # card (base unit or general) shows a real men count.
                base_key = COMMANDER_SUFFIX_RE.sub("", unit_key)
                men_raw = consensus_men.get(base_key) or first_declared_men.get(base_key, "")
            if men_raw:
                try:
                    men_display = numeric_display(men_raw)
                    if not float(men_raw).is_integer() or not (float(men_raw) / 2).is_integer():
                        add_warning(warnings, "rounded_down_men_display", unit_key=unit_key,
                                    source_file="ntw3_unit_stats_land.tsv", reference_value=men_raw,
                                    details=f"men_raw / 2 was rounded down to {men_display} to match in-game display.")
                except ValueError:
                    add_warning(warnings, "invalid_men", unit_key=unit_key,
                                source_file="ntw3_unit_stats_land.tsv", reference_value=men_raw,
                                details="Men value is not numeric.")

            if unit_class.casefold() == "general" and "_gen_staff_" in unit_key:
                men_display = "16"

            rating = rating_lookup.get(unit_key)
            unit_cache[unit_key] = {
                "unit_key": unit_key,
                "unit_name": unit_name,
                "unit_class": unit_class,
                "men_raw": men_raw,
                "men_display": men_display,
                "speed_code": speed_code,
                "speed_entity_key": speed_entity,
                "division_brigade_code": division_code,
                "division_id": division_id,
                "brigade_id": brigade_id,
                "__placement_source": placement_source,
                "base_mp_cost": text_value(unit.get("multiplayer_cost")),
                "unit_cap": text_value(unit.get("total_cap_mp")),
                "range": range_value,
                "weapon_key": weapon_key,
                "projectile_key": projectile_key,
                "range_selection_method": range_method,
                "command_stars": text_value(rating.get("command_stars")) if rating is not None else "",
                "command_star_icon_path": (
                    "assets/ui/command_stars/star_gold.png" if rating is not None and not blank(rating.get("command_stars")) else ""
                ),
                "command_star_strip_path": (
                    f"assets/ui/command_stars/vertical/command_stars_{text_value(rating.get('command_stars'))}.png"
                    if rating is not None and not blank(rating.get("command_stars")) else ""
                ),
                "command_star_layout": (
                    "vertical_left" if rating is not None and not blank(rating.get("command_stars")) else ""
                ),
                "is_general": str(unit_class.casefold() == "general").lower(),
                "is_commander_variant": str("_com_" in unit_key).lower(),
                "is_tow_variant": str("_tow_" in unit_key).lower(),
                "icon_name": icon_name,
                "icon_filename": icon_filename,
                "icon_path": icon_path,
                "icon_match_method": icon_method,
                "accuracy": text_value(stats.get("core_marksmanship")) if stats is not None else "",
                "reload_skill": text_value(stats.get("core_loading_skill")) if stats is not None else "",
                "morale": text_value(stats.get("morale")) if stats is not None else "",
                "melee_attack": text_value(stats.get("melee_attack")) if stats is not None else "",
                "melee_defense": text_value(stats.get("melee_defense")) if stats is not None else "",
                "charge_bonus": text_value(stats.get("charge_bonus")) if stats is not None else "",
                **displayed_abilities,
                "guerrilla_badge_path": (
                    "assets/ui/guerrilla_badge/guerrilla_badge.png"
                    if displayed_abilities["has_guerrilla_deployment"] == "true"
                    else ""
                ),
                "guerrilla_badge_layout": (
                    "lower_right"
                    if displayed_abilities["has_guerrilla_deployment"] == "true"
                    else ""
                ),
                "__gun_type": text_value(stats.get("gun_type")) if stats is not None else "",
                "__stats_source": stats_source,
            }
        row = dict(unit_cache[unit_key])
        row["faction_key"] = faction_key
        faction_localisation_key = f"factions_screen_name_{faction_key}"
        faction_localisation = loc_lookup.get(faction_localisation_key)
        if faction_localisation is not None and not blank(faction_localisation.get("text")):
            row["army_corps_name"] = text_value(faction_localisation.get("text"))
        else:
            row["army_corps_name"] = ""
            if faction_key not in missing_army_corps_warned:
                add_warning(
                    warnings,
                    "missing_army_corps_name",
                    faction_key=faction_key,
                    source_file="localisation.loc.tsv",
                    reference_value=faction_localisation_key,
                    details="No exact factions_screen_name_<faction_key> localisation row found.",
                )
                missing_army_corps_warned.add(faction_key)
        output_rows.append(row)

    output = pd.DataFrame(output_rows, dtype=object)
    if output.empty:
        output = pd.DataFrame(
            columns=OUTPUT_COLUMNS + ["__gun_type", "__placement_source", "__stats_source"]
        )

    placement_report = infer_final_division_placements(output)
    inheritance_report = inherit_commander_placements(output)

    unresolved_corps = output.loc[
        output["faction_key"].str.startswith("ntw3_ac_")
        & output["division_brigade_code"].eq("")
        & output["is_general"].ne("true")
    ]
    for _, row in unresolved_corps.iterrows():
        add_warning(
            warnings,
            "missing_division_tag",
            unit_key=text_value(row["unit_key"]),
            faction_key=text_value(row["faction_key"]),
            source_file="localisation.loc.tsv",
            details="Army-corps combat unit has no ACDV tag and did not match a support-division convention.",
        )

    # A commander variant should never sit unplaced when its base unit is placed.
    placed_units = {
        (text_value(r["faction_key"]), text_value(r["unit_key"])): text_value(r["division_brigade_code"])
        for _, r in output.iterrows()
    }
    for _, row in output.loc[
        output["faction_key"].str.startswith("ntw3_ac_")
        & output["division_brigade_code"].eq("")
        & output["unit_key"].str.contains("_com_")
    ].iterrows():
        faction = text_value(row["faction_key"])
        base_key = COMMANDER_SUFFIX_RE.sub("", text_value(row["unit_key"]))
        if placed_units.get((faction, base_key)):
            add_warning(
                warnings, "unplaced_commander_with_placed_base",
                unit_key=text_value(row["unit_key"]), faction_key=faction,
                source_file="localisation.loc.tsv",
                details=f"Commander variant is unplaced although base {base_key} is placed.",
            )
    for detail in inheritance_report["disagreement"]:
        add_warning(
            warnings, "commander_base_placement_disagreement",
            source_file="localisation.loc.tsv", details=detail,
        )
    for detail in placement_report["ambiguous_no_tagged_division"]:
        add_warning(
            warnings, "ambiguous_support_division",
            source_file="localisation.loc.tsv", details=detail,
        )

    # ToW records frequently duplicate the base unit exactly while omitting a separate
    # icon file. Reuse only the icon from the exact key obtained by removing _tow_###.
    ambiguous_icon_units = {
        warning["unit_key"] for warning in warnings
        if warning["warning_type"] == "ambiguous_icon"
    }
    resolved_icon_rows = output.loc[output["icon_path"] != ""].drop_duplicates("unit_key")
    resolved_icons = {
        text_value(row["unit_key"]): (
            text_value(row["icon_filename"]), text_value(row["icon_path"])
        )
        for _, row in resolved_icon_rows.iterrows()
    }
    tow_reused_units: set[str] = set()
    for index, row in output.loc[output["icon_path"] == ""].iterrows():
        unit_key = text_value(row["unit_key"])
        if unit_key in ambiguous_icon_units or "_tow_" not in unit_key:
            continue
        base_key = re.sub(r"_tow_\d+(?=_com_\d+$|$)", "", unit_key)
        base_icon = resolved_icons.get(base_key)
        if base_icon is None:
            base_unit = land_lookup.get(base_key)
            base_icon_name = text_value(base_unit.get("icon_name")) if base_unit is not None else ""
            base_attempts: list[list[Path]] = []
            if base_icon_name:
                if Path(base_icon_name).suffix:
                    base_attempts.append(by_filename.get(Path(base_icon_name).name.casefold(), []))
                base_attempts.append(by_stem.get(Path(base_icon_name).stem.casefold(), []))
                base_attempts.append(by_filename.get((base_icon_name + ".tga").casefold(), []))
            base_attempts.extend([
                by_filename.get((base_key + "_icon.tga").casefold(), []),
                by_filename.get((base_key + ".tga").casefold(), []),
                by_unit_key_body.get(base_key, []),
            ])
            for matches in base_attempts:
                if len(matches) == 1:
                    matched_path = matches[0]
                    base_icon = (
                        matched_path.name,
                        matched_path.relative_to(PROJECT_ROOT).as_posix(),
                    )
                    break
                if len(matches) > 1:
                    break
        if base_icon is None:
            continue
        output.at[index, "icon_filename"] = base_icon[0]
        output.at[index, "icon_path"] = base_icon[1]
        output.at[index, "icon_match_method"] = "tow_base_reuse"
        tow_reused_units.add(unit_key)
    if tow_reused_units:
        warnings = [
            warning for warning in warnings
            if not (
                warning["warning_type"] == "missing_icon"
                and warning["unit_key"] in tow_reused_units
            )
        ]

    # Some cards use a country or uniform tag that is unrelated to the unit-key
    # prefix. The standard non-campaign uniforms table supplies that exact link.
    uniform_resolved_units: set[str] = set()
    for index, row in output.loc[output["icon_path"] == ""].iterrows():
        unit_key = text_value(row["unit_key"])
        faction_key = text_value(row["faction_key"])
        candidates = uniform_icon_candidates.get((faction_key, unit_key), [])
        if not candidates:
            continue
        matched_path = candidates[0]
        output.at[index, "icon_filename"] = matched_path.name
        output.at[index, "icon_path"] = matched_path.relative_to(PROJECT_ROOT).as_posix()
        output.at[index, "icon_match_method"] = (
            "uniform_table_exact" if len(candidates) == 1
            else "uniform_table_first_declared"
        )
        uniform_resolved_units.add(unit_key)
    if uniform_resolved_units:
        warnings = [
            warning for warning in warnings
            if not (
                warning["warning_type"] in {"missing_icon", "ambiguous_icon"}
                and warning["unit_key"] in uniform_resolved_units
            )
        ]
    merge_multiplied = len(output) != len(permissions.loc[permissions["key"].isin(land_lookup)])

    assert output["unit_key"].fillna("").ne("").all()
    assert output["faction_key"].fillna("").ne("").all()
    assert not output.duplicated(["unit_key", "faction_key"]).any()
    assert set(output["speed_code"].loc[output["speed_code"] != ""]).issubset(set(SPEED_MAP.values()))
    for _, row in output.loc[output["range"] != ""].iterrows():
        projectile = projectile_lookup.get(text_value(row["projectile_key"]))
        assert projectile is not None
        assert text_value(projectile.get("effective_range")) == text_value(row["range"])
        method = text_value(row["range_selection_method"])
        projectile_key = text_value(row["projectile_key"])
        if method == "cannon_round_shot":
            assert projectile_key.endswith("_shot")
        if method in {"howitzer_shell", "unicorn_shell", "mortar_shell"}:
            assert projectile_key.endswith("_shell")
    for icon_path in output["icon_path"].loc[output["icon_path"] != ""]:
        path = Path(str(icon_path))
        assert not path.is_absolute()
        assert (PROJECT_ROOT / path).is_file()

    output["__division_sort"] = pd.to_numeric(output["division_id"], errors="coerce")
    output["__brigade_sort"] = pd.to_numeric(output["brigade_id"], errors="coerce")
    output = output.sort_values(
        ["faction_key", "__division_sort", "__brigade_sort", "unit_class", "unit_name", "unit_key"],
        na_position="last", kind="stable",
    )

    representative = {
        "infantry": first_matching(
            output,
            output["speed_code"].str.startswith(("L", "G")) & output["unit_class"].ne("general"),
        ),
        "grenadier": first_matching(output, output["speed_entity_key"].str.startswith("inf_gren_")),
        "skirmisher": first_matching(output, output["speed_code"].str.startswith(("S", "GS"))),
        "cavalry": first_matching(output, output["speed_code"].str.startswith("C")),
        "artillery": first_matching(output, output["speed_code"].str.startswith(("F", "H"))),
        "howitzer": first_matching(output, output["range_selection_method"] == "howitzer_shell"),
        "general": first_matching(output, output["is_general"] == "true"),
        "commander": first_matching(output, output["is_commander_variant"] == "true"),
        "tow": first_matching(output, output["is_tow_variant"] == "true"),
    }

    output["placement_source"] = output["__placement_source"]

    csv_path = PROJECT_ROOT / "data" / "generated" / "ntw3_army_builder_units.csv"
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    warning_path = REPORT_DIR / "ntw3_merge_warnings.csv"
    summary_path = REPORT_DIR / "ntw3_merge_summary.txt"
    output.loc[:, OUTPUT_COLUMNS].to_csv(csv_path, index=False, encoding="utf-8-sig")
    pd.DataFrame(warnings, columns=WARNING_COLUMNS).to_csv(warning_path, index=False, encoding="utf-8-sig")
    write_summary(
        summary_path, frames, exact_duplicates, conflicts, metadata_counts,
        icon_extensions, output, warnings, representative, merge_multiplied,
    )

    print(csv_path)
    print(warning_path)
    print(summary_path)
    print(f"Rows: {len(output):,}; units: {output['unit_key'].nunique():,}; factions: {output['faction_key'].nunique():,}")
    print(f"Warnings: {len(warnings):,}; complete: {'yes' if not warnings else 'no'}")
    unresolved = Counter(warning["warning_type"] for warning in warnings)
    print("Unresolved mappings: " + ", ".join(f"{key}={value}" for key, value in sorted(unresolved.items())))


if __name__ == "__main__":
    main()
