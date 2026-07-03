from __future__ import annotations

import csv
import unittest
from pathlib import Path

from PIL import Image

from tools.build_army_corps_catalog import display_numbers, identity, theatre_for


ROOT = Path(__file__).resolve().parents[2]


class ArmyCorpsCatalogTests(unittest.TestCase):
    def test_normalized_and_source_keys_share_stable_identity(self) -> None:
        self.assertEqual(
            identity("ntw3_ac_a05_x5_095"),
            identity("ntw3_ac_a05_fg5_095"),
        )

    def test_known_theatre_groups(self) -> None:
        self.assertEqual(theatre_for("ntw3_ac_b05_x7_030")[2], "3rd Coalition (1805)")
        self.assertEqual(theatre_for("ntw3_ac_a12_x6_132")[2], "Hundred Days (1815)")
        self.assertEqual(theatre_for("ntw3_tow_a05_x8_001")[0], "tow_french_imperial")
        self.assertEqual(theatre_for("ntw3_tow_b05_x8_006")[0], "tow_coalition")
        self.assertEqual(theatre_for("ntw3_tow_c10_x8_025")[0], "tow_french_imperial")
        self.assertEqual(theatre_for("ntw3_tow_b05_x8_006")[2], "Theatres of War")

    def test_display_numbers(self) -> None:
        self.assertEqual(display_numbers("13. Soult / IV.C"), (None, 13))
        self.assertEqual(display_numbers("[1812] 10. Rossiya"), (1812, 10))

    def test_catalog_covers_every_main_faction_with_44x22_flags(self) -> None:
        with (ROOT / "data" / "generated" / "ntw3_army_builder_units.csv").open(
            newline="", encoding="utf-8-sig"
        ) as handle:
            main_factions = {row["faction_key"] for row in csv.DictReader(handle)}
        with (ROOT / "data" / "generated" / "army_corps_catalog.csv").open(
            newline="", encoding="utf-8-sig"
        ) as handle:
            catalog = list(csv.DictReader(handle))

        self.assertEqual({row["faction_key"] for row in catalog}, main_factions)
        self.assertEqual(len(catalog), len(main_factions))
        for row in catalog:
            for field in ("flag_png_path", "flag_tga_path"):
                path = ROOT / row[field]
                self.assertTrue(path.is_file(), path)
                with Image.open(path) as image:
                    self.assertEqual(image.size, (44, 22), path)

    def test_written_flags_are_post_selection_only(self) -> None:
        with (ROOT / "data" / "generated" / "army_corps_catalog.csv").open(
            newline="", encoding="utf-8-sig"
        ) as handle:
            rows = {row["faction_key"]: row for row in csv.DictReader(handle)}

        for faction in (
            "ntw3_ac_b11_x5_190",
            "ntw3_ac_b11_x5_188",
            "ntw3_ac_a11_x6_118",
        ):
            row = rows[faction]
            self.assertNotEqual(row["selection_flag_source_file"], "flag_132.tga")
            self.assertEqual(row["post_selection_flag_source_file"], "flag_132.tga")
            for field in (
                "post_selection_flag_png_path",
                "post_selection_flag_tga_path",
            ):
                path = ROOT / row[field]
                self.assertTrue(path.is_file(), path)
                with Image.open(path) as image:
                    self.assertEqual(image.size, (132, 66), path)

    def test_hessen_kassel_uses_clean_donor_only_on_main_screen(self) -> None:
        with (ROOT / "data" / "generated" / "army_corps_catalog.csv").open(
            newline="", encoding="utf-8-sig"
        ) as handle:
            rows = {row["faction_key"]: row for row in csv.DictReader(handle)}
        row = rows["ntw3_ac_a16_x7_269"]
        self.assertEqual(
            row["selection_flag_donor_source_faction_key"], "ntw3_ac_a07_s7_179"
        )
        self.assertEqual(row["post_selection_flag_source_file"], "flag_132.tga")


if __name__ == "__main__":
    unittest.main()
