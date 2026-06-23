"""Validate army-builder rule inputs and write a reproducible text report."""

from __future__ import annotations

import csv
from collections import Counter
from pathlib import Path

from army_builder_rules import (
    RuleDataError,
    UnitCatalog,
    classify_general,
    general_caps,
)


ROOT = Path(__file__).resolve().parents[1]
UNITS_CSV = ROOT / "data" / "generated" / "ntw3_army_builder_units.csv"
STAFF_CSV = ROOT / "data" / "staff_generals" / "staff_general_corps_placement.csv"
REPORT = ROOT / "reports" / "army_builder_rules_validation.txt"


def main() -> None:
    catalog = UnitCatalog.from_csv(UNITS_CSV)
    factions = sorted({card.faction_key for card in catalog.cards})
    ac_factions = [key for key in factions if "_ac_" in key]
    tow_factions = [key for key in factions if "_tow_" in key]
    german_factions = [
        key for key in factions
        if len(key.split("_")) >= 4 and "g" in key.split("_")[3]
    ]

    general_classes = Counter()
    unresolved_generals: list[str] = []
    staff_final_men_errors: list[str] = []
    for card in catalog.cards:
        if "_gen_staff_" in card.unit_key and card.final_men_count != 16:
            staff_final_men_errors.append(f"{card.faction_key},{card.unit_key}")
        if not card.is_general:
            continue
        try:
            general_classes[classify_general(card)] += 1
        except RuleDataError:
            unresolved_generals.append(f"{card.faction_key},{card.unit_key}")

    cap_errors: list[str] = []
    for faction in ac_factions + tow_factions:
        try:
            general_caps(faction)
        except RuleDataError as exc:
            cap_errors.append(str(exc))

    with STAFF_CSV.open(newline="", encoding="utf-8-sig") as handle:
        staff_rows = list(csv.DictReader(handle))
    staff_pairs = {(row["faction_key"], row["unit_key"]) for row in staff_rows}
    main_pairs = {(card.faction_key, card.unit_key) for card in catalog.cards}
    staff_missing_from_main = sorted(staff_pairs - main_pairs)

    lines = [
        "NTW3 army-builder rules validation",
        "===================================",
        f"main recruitable rows: {len(catalog.cards)}",
        f"factions: {len(factions)}",
        f"AC factions: {len(ac_factions)}",
        f"ToW factions: {len(tow_factions)}",
        f"German States fourth-component matches: {len(german_factions)}",
        f"staff-general placement rows: {len(staff_rows)}",
        f"staff placement rows missing from main CSV: {len(staff_missing_from_main)}",
        f"classified staff-general rows (exact raw Men / 2 is 16 or 61): {general_classes['staff']}",
        f"classified combat-general rows: {general_classes['combat']}",
        f"general rows unresolved because raw Men is blank: {len(unresolved_generals)}",
        f"staff-general rows whose final men count is not 16: {len(staff_final_men_errors)}",
        f"AC/ToW faction cap parse errors: {len(cap_errors)}",
        "combat-general cap exceptions: none (all AC/ToW factions use 9 - N)",
        "",
        "Unresolved mappings",
        "-------------------",
        "General rows with blank raw Men are not classified by guessing from their key.",
    ]
    lines.extend(unresolved_generals or ["none"])
    lines.extend(["", "Staff final-men normalization errors", "------------------------------------"])
    lines.extend(staff_final_men_errors or ["none"])
    lines.extend(["", "Faction cap parse errors", "------------------------"])
    lines.extend(cap_errors or ["none"])
    lines.extend(["", "Staff placement rows absent from main CSV", "-----------------------------------------"])
    lines.extend([f"{faction},{unit}" for faction, unit in staff_missing_from_main] or ["none"])
    lines.extend([
        "",
        "Confirmed app scope",
        "-------------------",
        "The one staff slot is independent of the combat-general cap.",
        "A staff or combat general may occupy it; a combat occupant does not use combat cap.",
        "Commander variants share the cap of the unit key before _com_<digits>.",
        "Unit compatibility exclusions are not applied.",
        "XP-adjusted pricing is not applied; base_mp_cost is used directly.",
        "No additional commander-conflict rule is assumed.",
    ])

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {REPORT}")
    print(f"Validated {len(catalog.cards)} recruitable rows across {len(factions)} factions.")
    print(f"Unresolved general classifications: {len(unresolved_generals)}")
    print(f"Faction cap parse errors: {len(cap_errors)}")


if __name__ == "__main__":
    main()
