"""Tests for the robust final-support-division inference and commander
inheritance in build_ntw3_army_builder_database.py. These read the generated
data/generated/ntw3_army_builder_units.csv (run the generator first)."""

from __future__ import annotations

import csv
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
COM_RE = re.compile(r"_com_\d+$")


def load_rows() -> list[dict]:
    with (ROOT / "data" / "generated" / "ntw3_army_builder_units.csv").open(newline="", encoding="utf-8-sig") as handle:
        return list(csv.DictReader(handle))


class DivisionPlacementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.rows = load_rows()

    def corps(self, faction_key: str) -> list[dict]:
        return [r for r in self.rows if r["faction_key"] == faction_key]

    def test_new_support_division_created_for_untagged_artillery(self) -> None:
        # Desaix / Italie.R: the entire artillery division is untagged, so a new
        # division must be created *after* the last combat division, not merged in.
        corps = self.corps("ntw3_ac_a03_x5_081")
        self.assertTrue(corps)
        foot = [r for r in corps if r["unit_class"] == "artillery_foot"]
        self.assertTrue(foot)
        for row in foot:
            self.assertEqual(row["placement_source"], "inferred_new_support_division")
            self.assertEqual(row["brigade_id"], "1")
        combat_divs = [
            int(r["division_id"])
            for r in corps
            if r["division_id"]
            and r["is_general"] != "true"
            and r["unit_class"] not in {"artillery_foot", "artillery_horse", "artillery_fixed"}
        ]
        art_div = int(foot[0]["division_id"])
        self.assertGreater(art_div, max(combat_divs))

    def test_italie_c_verified_fifth_division_override_preserved(self) -> None:
        rows = {r["unit_key"]: r for r in self.corps("ntw3_ac_a03_x5_080")}
        self.assertEqual(rows["ntw3_art_foot_080_006_0206"]["division_brigade_code"], "ACDV5B1")
        self.assertEqual(rows["ntw3_art_horse_080_002_0704"]["division_brigade_code"], "ACDV5B2")
        # The 8-pound foot battery's combat-general variant is placed with its battery.
        self.assertEqual(rows["ntw3_art_foot_080_006_0209_com_0308"]["division_brigade_code"], "ACDV5B1")

    @staticmethod
    def _is_combat_arm(unit_class: str) -> bool:
        if unit_class.startswith("cavalry"):
            return True
        if unit_class.startswith("infantry"):
            return unit_class != "infantry_skirmishers"
        return False

    def test_inferred_support_never_merges_into_a_combat_division(self) -> None:
        # Regression (1812 7. Junot): untagged reserve/support artillery must form its
        # own support division, never get merged into a real combat division — even
        # when that division carries some organic (divisional) artillery. A "combat
        # division" is one holding a game-tagged (non-inferred) combat-arm card.
        support_sources = {
            "inferred_new_support_division",
            "inferred_existing_support_division",
            "reserve_support_division",
        }
        combat_divisions: dict[str, set[str]] = {}
        for r in self.rows:
            if r["is_general"] == "true" or not r["division_id"]:
                continue
            if r["placement_source"] in support_sources:
                continue  # only game-tagged combat units define a combat division
            if self._is_combat_arm(r["unit_class"]):
                combat_divisions.setdefault(r["faction_key"], set()).add(r["division_id"])
        offenders = [
            (r["faction_key"], r["unit_key"], r["division_brigade_code"])
            for r in self.rows
            if r["placement_source"] in support_sources
            and r["division_id"] in combat_divisions.get(r["faction_key"], set())
        ]
        self.assertEqual(offenders, [])

    def test_junot_reserve_artillery_forms_separate_support_division(self) -> None:
        corps = self.corps("ntw3_ac_a11_x5_124")
        self.assertTrue(corps)
        reserve = [r for r in corps if r["placement_source"] == "inferred_new_support_division"]
        self.assertTrue(reserve, "Junot's untagged reserve artillery should create a new support division")
        combat_divs = [
            int(r["division_id"])
            for r in corps
            if r["division_id"] and r["is_general"] != "true" and self._is_combat_arm(r["unit_class"])
        ]
        support_div = int(reserve[0]["division_id"])
        self.assertGreater(support_div, max(combat_divs))

    def test_artillery_commanders_inherit_their_base_placement(self) -> None:
        by_key = {(r["faction_key"], r["unit_key"]): r for r in self.rows}
        checked = 0
        for row in self.rows:
            key = row["unit_key"]
            if not row["faction_key"].startswith("ntw3_ac_") or not COM_RE.search(key):
                continue
            if "art_" not in key:
                continue
            base = by_key.get((row["faction_key"], COM_RE.sub("", key)))
            if base and base["division_brigade_code"] and row["division_brigade_code"]:
                self.assertEqual(row["division_brigade_code"], base["division_brigade_code"], key)
                checked += 1
        self.assertGreater(checked, 0)

    def test_no_unplaced_commander_when_base_is_placed(self) -> None:
        placed = {
            (r["faction_key"], r["unit_key"]): r["division_brigade_code"] for r in self.rows
        }
        unplaced = []
        for row in self.rows:
            if not row["faction_key"].startswith("ntw3_ac_") or not COM_RE.search(row["unit_key"]):
                continue
            if row["division_brigade_code"]:
                continue
            base_key = COM_RE.sub("", row["unit_key"])
            if placed.get((row["faction_key"], base_key)):
                unplaced.append(row["unit_key"])
        self.assertEqual(unplaced, [])

    # Untagged combat units with no division tag and no support-division match. The
    # game files give these no ACDV tag; the app surfaces them in its "Other units"
    # section. Documented here so the placement check stays strict for everything else.
    UNPLACED_EXCEPTIONS = {
        ("ntw3_ac_a17_x6_290", "ntw3_inf_line_290_999_7045"),  # Infanterie espagnole 'Joseph Napoléon'
    }

    def test_all_army_corps_combat_cards_have_placement(self) -> None:
        unplaced = [
            r for r in self.rows
            if r["faction_key"].startswith("ntw3_ac_")
            and r["is_general"] != "true"
            and not r["division_brigade_code"]
            and (r["faction_key"], r["unit_key"]) not in self.UNPLACED_EXCEPTIONS
        ]
        self.assertEqual(unplaced, [])


if __name__ == "__main__":
    unittest.main()
