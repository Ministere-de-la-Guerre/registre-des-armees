"""Tests for build_ntw3_army_builder_database.py: header parsing, duplicate-key
resolution, and the generated CSV (run the generator first)."""

from __future__ import annotations

import csv
import unittest
from pathlib import Path

import pandas as pd

from tools.build_ntw3_army_builder_database import (
    build_firearm_names,
    parse_displayed_abilities,
    parse_firearm_line,
    resolve_first_occurrence,
)

ROOT = Path(__file__).resolve().parents[2]
UNITS_CSV = ROOT / "data" / "generated" / "ntw3_army_builder_units.csv"
STAFF_CSVS = [
    ROOT / "data" / "staff_generals" / "staff_general_corps_placement.csv",
    ROOT / "data" / "staff_generals" / "staff_general_corps_placement_with_stars.csv",
]
# The localisation table escapes line breaks as the two characters "\\n".
BR = "\\\\n"


def load_rows(path: Path = UNITS_CSV) -> list[dict]:
    with path.open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


class AbilityParsingTests(unittest.TestCase):
    def test_declaration_on_first_line(self) -> None:
        abilities = parse_displayed_abilities(
            f"Abilities: shock resistant, square, stamina{BR}Firearm: M1798{BR}{BR}ACDV1B2"
        )
        self.assertEqual(abilities["is_shock_resistant"], "true")
        self.assertEqual(abilities["can_form_square"], "true")
        self.assertEqual(abilities["has_stamina"], "true")
        self.assertEqual(abilities["can_inspire"], "false")

    def test_staff_general_declaration_after_star_line(self) -> None:
        abilities = parse_displayed_abilities(
            f"2-stars commander{BR}Abilities: inspires, shock resistant, stamina{BR}{BR}Biography."
        )
        self.assertEqual(abilities["can_inspire"], "true")
        self.assertEqual(abilities["is_shock_resistant"], "true")
        self.assertEqual(abilities["has_stamina"], "true")

    def test_real_newlines_are_line_breaks_too(self) -> None:
        abilities = parse_displayed_abilities("0-star commander\nAbility: inspires")
        self.assertEqual(abilities["can_inspire"], "true")

    def test_biography_free_text_is_never_a_declaration(self) -> None:
        abilities = parse_displayed_abilities(
            f"1-star commander{BR}{BR}Ability: inspires his men, and stamina."
        )
        self.assertTrue(all(value == "false" for value in abilities.values()), abilities)
        self.assertEqual(parse_displayed_abilities("He inspires. Ability: square"),
                         parse_displayed_abilities(""))

    def test_firearm_line(self) -> None:
        self.assertEqual(
            parse_firearm_line(f"Ability: square{BR}Firearm: Land Pattern (aka Brown Bess){BR}{BR}x"),
            "Land Pattern (aka Brown Bess)",
        )
        self.assertEqual(parse_firearm_line(f"Ability: square{BR}{BR}Firearm: late"), "")


class FirstOccurrenceTests(unittest.TestCase):
    def test_conflicting_rating_keeps_first_row_and_logs_the_rest(self) -> None:
        frame = pd.DataFrame([
            {"unit_key": "a_com_1", "command_stars": "3", "__source_row": "2"},
            {"unit_key": "a_com_1", "command_stars": "1", "__source_row": "3"},
            {"unit_key": "a_com_1", "command_stars": "3", "__source_row": "4"},
            {"unit_key": "b_com_2", "command_stars": "2", "__source_row": "5"},
        ], dtype=object)
        warnings: list[dict[str, str]] = []
        clean, conflicts, exact = resolve_first_occurrence(frame, "unit_key", "ratings.tsv", warnings)
        self.assertEqual(dict(zip(clean["unit_key"], clean["command_stars"])), {"a_com_1": "3", "b_com_2": "2"})
        self.assertEqual(conflicts, {("a_com_1",)})
        self.assertEqual(exact, 1)
        self.assertEqual([w["source_row"] for w in warnings], ["3"])


class FirearmNameTests(unittest.TestCase):
    def test_names_come_from_weapon_with_fallbacks_and_conflicts_logged(self) -> None:
        warnings: list[dict[str, str]] = []
        names = build_firearm_names({
            "u1": ("musket_charleville", "Charleville 1777"),
            "u2": ("musket_charleville", "Charleville 1777"),
            "u3": ("musket_charleville", "Charleville An IX"),
            "u4": ("bow", "bow"),
            "u5": ("cannon_6_pounder", "Six-pounder"),
        }, warnings)
        self.assertEqual(names["musket_charleville"], "Charleville 1777")
        self.assertEqual(names["bow"], "Bow")
        self.assertEqual(names["musket_flintlock"], "Flintlock musket")
        self.assertNotIn("cannon_6_pounder", names)
        kinds = sorted(w["warning_type"] for w in warnings)
        self.assertEqual(kinds, ["firearm_line_disagrees_with_weapon", "firearm_name_conflict"])


class GeneratedDatabaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.rows = load_rows()
        cls.by_key = {row["unit_key"]: row for row in cls.rows}

    def test_staff_generals_carry_their_declared_abilities(self) -> None:
        staff = [row for row in self.rows if "_gen_staff_" in row["unit_key"]]
        self.assertTrue(staff)
        inspiring = sum(row["can_inspire"] == "true" for row in staff)
        # Every staff general declares "inspires" except the two cards whose
        # localisation row is an ambiguous duplicate (Wintzingerode).
        self.assertGreaterEqual(inspiring, len(staff) - 2)
        self.assertGreater(sum(row["is_shock_resistant"] == "true" for row in staff), 0)
        self.assertGreater(sum(row["has_stamina"] == "true" for row in staff), 0)

    def test_conflicting_command_ratings_use_first_occurrence(self) -> None:
        for unit_key, stars in {
            "ntw3_cav_light_128_001_1070_com_0524": "3",
            "ntw3_inf_line_291_086_6792_com_4294": "4",
            "ntw3_inf_line_284_005_6282_com_3640": "3",
            "ntw3_inf_light_122_003_1280_com_3765": "1",
        }.items():
            row = self.by_key[unit_key]
            self.assertEqual(row["command_stars"], stars, unit_key)
            self.assertEqual(
                row["command_star_strip_path"],
                f"assets/ui/command_stars/vertical/command_stars_{stars}.png",
            )

    def test_ammo_is_an_integer_for_every_card(self) -> None:
        for row in self.rows:
            self.assertTrue(row["ammo"].isdigit(), (row["unit_key"], row["ammo"]))

    def test_every_small_arm_and_only_small_arms_have_a_firearm(self) -> None:
        for row in self.rows:
            weapon = row["weapon_key"]
            small_arm = weapon.startswith("musket_") or weapon == "bow"
            self.assertEqual(bool(row["firearm"]), small_arm, (row["unit_key"], weapon))
        self.assertEqual(self.by_key["ntw3_inf_line_291_086_6792_com_4294"]["firearm"],
                         "Charleville 1777 révisé an IX")

    def test_generated_csvs_use_crlf_line_endings(self) -> None:
        for path in [UNITS_CSV, *STAFF_CSVS]:
            data = path.read_bytes()
            self.assertEqual(data.count(b"\n"), data.count(b"\r\n"), path)

    def test_staff_general_csvs_have_every_unit_name(self) -> None:
        for path in STAFF_CSVS:
            rows = load_rows(path)
            self.assertTrue(rows)
            self.assertEqual([r["unit_key"] for r in rows if not r["unit_name"]], [], path)


if __name__ == "__main__":
    unittest.main()
