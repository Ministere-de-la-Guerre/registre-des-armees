from __future__ import annotations

import csv
import re
import unittest
from pathlib import Path

from tools.army_builder_rules import (
    MAX_BRIGADE_SLOTS_PER_DIVISION,
    Placement,
    RuleDataError,
    UnitCard,
    UnitCatalog,
    ac_selection_general_maxima,
    calculate_army_cost,
    check_known_limits,
    general_caps,
)


def card(
    key: str,
    *,
    faction: str = "ntw3_ac_test_x5_001",
    unit_class: str = "infantry_line",
    men: int | None = 100,
    division: int | None = 1,
    brigade: int | None = 1,
    cost: int = 100,
    cap: int = 1,
    men_display: int | None = None,
    unit_name: str = "",
    placement_source: str = "",
) -> UnitCard:
    return UnitCard(
        unit_key=key,
        faction_key=faction,
        unit_class=unit_class,
        men_raw=men,
        placement=(
            Placement(division, brigade)
            if division is not None and brigade is not None
            else None
        ),
        mp_cost=cost,
        cap=cap,
        is_general=unit_class == "general",
        men_display=men_display,
        unit_name=unit_name,
        placement_source=placement_source,
    )


class PricingTests(unittest.TestCase):
    def test_normal_brigade_discount(self) -> None:
        faction = "ntw3_ac_test_x5_001"
        unit = card("line", faction=faction, cost=500, cap=2)
        sibling = card("sibling", faction=faction, brigade=2, cost=100, cap=1)
        result = calculate_army_cost([unit, unit], [unit, sibling], faction)

        self.assertEqual(result.base_cost, 1000)
        self.assertEqual(result.normal_discount, 10)
        self.assertEqual(result.final_cost, 990)
        self.assertEqual(result.completed_groups[0].group_type, "brigade")

    def test_full_division_replaces_brigade_discounts(self) -> None:
        faction = "ntw3_ac_test_x5_001"
        first = card("first", faction=faction, brigade=1, cost=100, cap=2)
        second = card("second", faction=faction, brigade=2, cost=100, cap=2)
        selected = [first, first, second, second]
        result = calculate_army_cost(selected, [first, second], faction)

        self.assertEqual(result.normal_discount, 12)
        self.assertEqual(len(result.completed_groups), 1)
        self.assertEqual(result.completed_groups[0].group_type, "division")

    def test_german_states_multiplies_total_normal_discount(self) -> None:
        faction = "ntw3_ac_test_g5_001"
        unit = card("line", faction=faction, cost=500, cap=2)
        sibling = card("sibling", faction=faction, brigade=2, cost=100, cap=1)
        result = calculate_army_cost([unit, unit], [unit, sibling], faction)

        self.assertEqual(result.normal_discount, 10)
        self.assertEqual(result.applied_discount, 15)
        self.assertEqual(result.final_cost, 985)
        self.assertTrue(result.german_states)

    def test_tagged_general_can_complete_brigade_but_is_not_in_roster(self) -> None:
        faction = "ntw3_ac_test_x5_001"
        unit = card("line", faction=faction, cost=500, cap=2)
        general = card(
            "general", faction=faction, unit_class="general", men=80, cost=845, cap=1
        )
        sibling = card("sibling", faction=faction, brigade=2, cost=100, cap=1)
        result = calculate_army_cost(
            [unit, general], [unit, general, sibling], faction
        )

        self.assertEqual(result.base_cost, 1345)
        self.assertEqual(result.completed_groups[0].roster_cost, 1000)
        self.assertEqual(result.completed_groups[0].required_count, 2)
        self.assertEqual(result.completed_groups[0].selected_count, 2)
        self.assertEqual(result.normal_discount, 10)

    def test_verified_5645_example(self) -> None:
        faction = "ntw3_ac_test_x5_001"
        roster = [
            card("roster_a", faction=faction, cost=1003, cap=2),
            card("roster_b", faction=faction, cost=807, cap=2),
            card("roster_c", faction=faction, cost=384, cap=4),
            card("other_brigade", faction=faction, brigade=2, cost=100, cap=1),
        ]
        selected = [
            card(f"selected_{index}", faction=faction, cost=cost)
            for index, cost in enumerate([1003, 1003, 807, 807, 384, 384, 772])
        ]
        selected.append(
            card("tagged_general", faction=faction, unit_class="general", men=80, cost=845)
        )
        result = calculate_army_cost(selected, roster, faction)

        self.assertEqual(result.base_cost, 6005)
        self.assertEqual(result.completed_groups[0].roster_cost, 5156)
        self.assertEqual(result.completed_groups[0].required_count, 8)
        self.assertEqual(result.completed_groups[0].selected_count, 8)
        self.assertEqual(result.normal_discount, 360)
        self.assertEqual(result.final_cost, 5645)
        self.assertEqual(result.completed_groups[0].group_type, "brigade")

    def test_non_ac_faction_receives_no_discount(self) -> None:
        unit = card("line", faction="france", cost=500, cap=2)
        result = calculate_army_cost([unit, unit], [unit], "france")
        self.assertEqual(result.final_cost, 1000)
        self.assertEqual(result.normal_discount, 0)

    def test_support_division_with_sapper_earns_no_discount(self) -> None:
        # Sappers are classed as line/grenadier infantry but belong to the final
        # support division, which must earn no brigade/division discount.
        faction = "ntw3_ac_test_x5_001"
        inf = card("inf", faction=faction, division=1, brigade=1, cost=500, cap=2)
        # Division 2 = the support division: artillery + a sapper unit (inf class).
        art = card(
            "art", faction=faction, unit_class="artillery_foot",
            division=2, brigade=1, cost=100, cap=2,
        )
        sapper = card(
            "ntw3_inf_line_test_sap", faction=faction, unit_class="infantry_grenadiers",
            division=2, brigade=2, cost=100, cap=2, unit_name="Sapeurs [G4]",
        )
        roster = [inf, art, sapper]
        result = calculate_army_cost([inf, inf, art, art, sapper, sapper], roster, faction)
        # Only the combat division discounts; division 2 contributes nothing.
        self.assertEqual([g.division_id for g in result.completed_groups], [1])
        self.assertEqual(result.normal_discount, 10)

    def test_skirmisher_only_combat_division_keeps_discount(self) -> None:
        # A division of pure skirmishers with no artillery (e.g. native warriors)
        # is a real combat division, NOT the artillery support reserve.
        faction = "ntw3_ac_test_x5_001"
        warriors = card(
            "warriors", faction=faction, unit_class="infantry_skirmishers",
            division=1, brigade=1, cost=300, cap=2, unit_name="Mohawk [GS3]",
        )
        result = calculate_army_cost([warriors, warriors], [warriors], faction)
        self.assertEqual(result.normal_discount, 6)
        self.assertEqual(result.completed_groups[0].division_id, 1)

    def test_builder_designated_specialist_reserve_earns_no_discount(self) -> None:
        # The builder can infer a support division of loose specialists with no
        # artillery; placement_source marks it, so it must earn no discount.
        faction = "ntw3_ac_test_x5_001"
        skirm = card(
            "skirm", faction=faction, unit_class="infantry_skirmishers",
            division=2, brigade=1, cost=300, cap=2, unit_name="Voltigeurs [S2]",
            placement_source="inferred_new_support_division",
        )
        result = calculate_army_cost([skirm, skirm], [skirm], faction)
        self.assertEqual(result.normal_discount, 0)
        self.assertEqual(result.completed_groups, ())


class LimitTests(unittest.TestCase):
    def test_general_caps_and_separate_ac_selection_maximum(self) -> None:
        self.assertEqual(general_caps("france").combat, 1)
        self.assertEqual(general_caps("ntw3_tow_test_x8_001").combat, 1)
        self.assertEqual(general_caps("ntw3_ac_test_x5_001").combat, 4)
        self.assertEqual(ac_selection_general_maxima("ntw3_ac_test_x5_001").combat, 6)

    def test_every_real_ac_and_tow_faction_uses_nine_minus_n(self) -> None:
        csv_path = Path(__file__).resolve().parents[2] / "data" / "generated" / "ntw3_army_builder_units.csv"
        with csv_path.open(newline="", encoding="utf-8-sig") as handle:
            factions = {
                row["faction_key"]
                for row in csv.DictReader(handle)
                if "_ac_" in row["faction_key"] or "_tow_" in row["faction_key"]
            }

        self.assertGreater(len(factions), 0)
        for faction in factions:
            match = re.search(r"(\d+)$", faction.split("_")[3])
            self.assertIsNotNone(match, faction)
            expected = 9 - int(match.group(1))
            self.assertEqual(general_caps(faction).combat, expected, faction)
            if "_ac_" in faction:
                self.assertEqual(
                    ac_selection_general_maxima(faction).combat, expected + 2, faction
                )

    def test_known_card_and_type_limits(self) -> None:
        faction = "france"
        selected = [
            card(f"foot_{index}", faction=faction, unit_class="artillery_foot")
            for index in range(3)
        ]
        selected += [
            card(f"horse_{index}", faction=faction, unit_class="artillery_horse")
            for index in range(2)
        ]
        result = check_known_limits(selected, faction)
        rules = {violation.rule for violation in result.violations}
        self.assertEqual(rules, {"artillery_foot", "artillery_horse"})
        self.assertEqual(MAX_BRIGADE_SLOTS_PER_DIVISION, 7)

    def test_staff_general_is_based_only_on_exact_raw_men(self) -> None:
        faction = "france"
        staff_16 = card("staff16", faction=faction, unit_class="general", men=32)
        staff_61 = card("staff61", faction=faction, unit_class="general", men=122)
        combat = card("combat", faction=faction, unit_class="general", men=33)
        result = check_known_limits([staff_16, staff_61, combat], faction)
        rules = {violation.rule for violation in result.violations}
        self.assertEqual(result.counts["staff_generals"], 2)
        self.assertEqual(result.counts["combat_generals"], 1)
        self.assertEqual(rules, {"staff_slot_occupants"})

    def test_missing_general_men_is_not_guessed(self) -> None:
        unknown = card("unknown", faction="france", unit_class="general", men=None)
        with self.assertRaises(RuleDataError):
            check_known_limits([unknown], "france")

    def test_all_staff_general_final_men_counts_are_16(self) -> None:
        sourced = card(
            "ntw3_gen_staff_sourced", unit_class="general", men=122, men_display=61
        )
        missing_source = card(
            "ntw3_gen_staff_missing", unit_class="general", men=None, men_display=None
        )
        self.assertEqual(sourced.final_men_count, 16)
        self.assertEqual(missing_source.final_men_count, 16)

    def test_generated_general_rows_all_have_source_backed_or_forced_men(self) -> None:
        csv_path = Path(__file__).resolve().parents[2] / "data" / "generated" / "ntw3_army_builder_units.csv"
        with csv_path.open(newline="", encoding="utf-8-sig") as handle:
            unresolved = [
                row for row in csv.DictReader(handle)
                if row["is_general"] == "true" and not row["men_raw"]
            ]

        self.assertEqual(unresolved, [])

    def test_staff_and_combat_general_caps_are_independent(self) -> None:
        faction = "ntw3_ac_test_x7_001"
        staff = card("staff", faction=faction, unit_class="general", men=32)
        combat_a = card("combat_a", faction=faction, unit_class="general", men=80)
        combat_b = card("combat_b", faction=faction, unit_class="general", men=80)
        result = check_known_limits([staff, combat_a, combat_b], faction)
        self.assertFalse(result.violations)

    def test_combat_general_can_fill_staff_slot_without_using_combat_cap(self) -> None:
        faction = "ntw3_ac_test_x7_001"
        combat = [
            card(f"combat_{index}", faction=faction, unit_class="general", men=80)
            for index in range(3)
        ]
        without_slot = check_known_limits(combat, faction)
        self.assertEqual(
            {violation.rule for violation in without_slot.violations},
            {"combat_generals_against_cap"},
        )

        with_slot = check_known_limits(combat, faction, staff_slot_index=0)
        self.assertFalse(with_slot.violations)
        self.assertEqual(with_slot.counts["combat_generals"], 3)
        self.assertEqual(with_slot.counts["combat_generals_against_cap"], 2)
        self.assertEqual(with_slot.counts["staff_slot_occupants"], 1)

    def test_combat_general_cannot_share_staff_slot_with_staff_general(self) -> None:
        faction = "ntw3_ac_test_x7_001"
        combat = card("combat", faction=faction, unit_class="general", men=80)
        staff = card("staff", faction=faction, unit_class="general", men=32)
        result = check_known_limits([combat, staff], faction, staff_slot_index=0)
        self.assertEqual(
            {violation.rule for violation in result.violations},
            {"staff_slot_occupants"},
        )

    def test_commander_variant_uses_its_underlying_unit_cap(self) -> None:
        faction = "france"
        base = card(
            "ntw3_cav_light_214_018_1397",
            faction=faction,
            unit_class="cavalry_light",
            cap=1,
        )
        commander = card(
            "ntw3_cav_light_214_018_1397_com_1463",
            faction=faction,
            unit_class="general",
            men=80,
            cap=1,
        )
        result = check_known_limits([base, commander], faction)
        violations = {violation.rule: violation for violation in result.violations}
        rule = f"unit_cap:{faction}:{base.unit_key}"
        self.assertIn(rule, violations)
        self.assertEqual(violations[rule].actual, 2)
        self.assertEqual(violations[rule].maximum, 1)

    def test_platov_catalog_exposes_every_general_without_random_rolls(self) -> None:
        csv_path = Path(__file__).resolve().parents[2] / "data" / "generated" / "ntw3_army_builder_units.csv"
        catalog = UnitCatalog.from_csv(csv_path)
        cards = catalog.cards_for_faction("ntw3_ac_b11_r5_189")
        generals = [unit for unit in cards if unit.is_general]
        combat_variants = [unit for unit in generals if "_com_" in unit.unit_key]
        staff = [unit for unit in generals if "_gen_staff_" in unit.unit_key]

        self.assertEqual(len(cards), 63)
        self.assertEqual(len(combat_variants), 18)
        self.assertEqual(len(staff), 1)


class AssetMappingTests(unittest.TestCase):
    def test_bonaparte_italie_c_final_division_placements(self) -> None:
        root = Path(__file__).resolve().parents[2]
        expected = {
            "ntw3_art_foot_080_006_0206": "ACDV5B1",
            "ntw3_art_foot_080_006_0207": "ACDV5B1",
            "ntw3_art_foot_080_006_0209": "ACDV5B1",
            "ntw3_art_foot_080_006_0209_com_0308": "ACDV5B1",
            "ntw3_art_horse_080_002_0704": "ACDV5B2",
            "ntw3_art_horse_080_005_0703": "ACDV5B2",
            "ntw3_inf_line_080_999_2437": "ACDV5B3",
            "ntw3_inf_skirm_080_999_4755": "ACDV5B3",
        }
        with (root / "data" / "generated" / "ntw3_army_builder_units.csv").open(
            newline="", encoding="utf-8-sig"
        ) as handle:
            rows = {
                row["unit_key"]: row
                for row in csv.DictReader(handle)
                if row["faction_key"] == "ntw3_ac_a03_x5_080"
            }

        for unit_key, placement in expected.items():
            self.assertEqual(rows[unit_key]["division_brigade_code"], placement)

    def test_all_army_corps_combat_cards_have_placements(self) -> None:
        root = Path(__file__).resolve().parents[2]
        with (root / "data" / "generated" / "ntw3_army_builder_units.csv").open(
            newline="", encoding="utf-8-sig"
        ) as handle:
            unresolved = [
                row for row in csv.DictReader(handle)
                if row["faction_key"].startswith("ntw3_ac_")
                and row["is_general"] != "true"
                and not row["division_brigade_code"]
                # Untagged combat unit with no support-division match; the game files
                # give it no ACDV tag, so the app shows it under "Other units".
                and (row["faction_key"], row["unit_key"])
                != ("ntw3_ac_a17_x6_290", "ntw3_inf_line_290_999_7045")
            ]

        self.assertEqual(unresolved, [])

    def test_guard_marines_use_the_final_brigade_of_the_final_division(self) -> None:
        root = Path(__file__).resolve().parents[2]
        with (root / "data" / "generated" / "ntw3_army_builder_units.csv").open(
            newline="", encoding="utf-8-sig"
        ) as handle:
            rows = list(csv.DictReader(handle))

        for faction_key, unit_key in (
            ("ntw3_ac_a06_x4_105", "ntw3_inf_line_105_999_2648"),
            ("ntw3_ac_a08_x5_114", "ntw3_inf_line_114_999_5979"),
        ):
            corps = [row for row in rows if row["faction_key"] == faction_key]
            marine = next(row for row in corps if row["unit_key"] == unit_key)
            final_division = max(int(row["division_id"]) for row in corps if row["division_id"])
            final_brigade = max(
                int(row["brigade_id"])
                for row in corps
                if row["division_id"] == str(final_division)
            )
            self.assertEqual(int(marine["division_id"]), final_division)
            self.assertEqual(int(marine["brigade_id"]), final_brigade)

    def test_guerrilla_cards_reference_reusable_badge_overlay(self) -> None:
        root = Path(__file__).resolve().parents[2]
        badge_path = "assets/ui/guerrilla_badge/guerrilla_badge.png"
        with (root / "data" / "generated" / "ntw3_army_builder_units.csv").open(
            newline="", encoding="utf-8-sig"
        ) as handle:
            rows = list(csv.DictReader(handle))

        marked = [row for row in rows if row["has_guerrilla_deployment"] == "true"]
        unmarked = [row for row in rows if row["has_guerrilla_deployment"] == "false"]
        self.assertGreater(len(marked), 0)
        self.assertTrue((root / badge_path).is_file())
        self.assertTrue(all(row["guerrilla_badge_path"] == badge_path for row in marked))
        self.assertTrue(all(row["guerrilla_badge_layout"] == "lower_right" for row in marked))
        self.assertTrue(all(not row["guerrilla_badge_path"] for row in unmarked))
        self.assertTrue(all(not row["guerrilla_badge_layout"] for row in unmarked))


if __name__ == "__main__":
    unittest.main()
