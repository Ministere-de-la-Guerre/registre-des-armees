"""End-to-end tests for build_army_corps_catalog.main() in a throwaway tree:
it must validate before touching the published assets, build into staging,
and only swap on success."""

from __future__ import annotations

import csv
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from tools import build_army_corps_catalog as catalog


FACTIONS = [
    # key, index, flags directory name
    ("custom_army", "1", "f_custom"),
    ("ntw3_ac_a05_fg5_095", "10", "f_ac_095"),
    ("ntw3_ac_a05_fg5_096", "11", "f_ac_096"),
]


class CatalogBuildTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.flags = self.root / "flags"
        self.output = self.root / "assets" / "army_corps_by_theatre"
        generated = self.root / "data" / "generated"
        generated.mkdir(parents=True)
        main_csv = generated / "ntw3_army_builder_units.csv"
        with main_csv.open("w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.writer(handle)
            writer.writerow(["unit_key", "faction_key", "army_corps_name"])
            for key, _, _ in FACTIONS:
                writer.writerow(["u", key, f"1. {key}"])
        factions_tsv = self.root / "ntw3_factions.tsv"
        with factions_tsv.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle, delimiter="\t")
            writer.writerow(["key", "index", "screen_name", "flags_path"])
            writer.writerow(["#factions_tables;3", "", "", ""])
            for key, index, flag_dir in FACTIONS:
                writer.writerow([key, index, key, f"data\\ui\\flags\\{flag_dir}"])
        # Published tree from a previous run that must survive any failure.
        self.sentinel = self.output / "empire" / "old_flag.png"
        self.sentinel.parent.mkdir(parents=True)
        self.sentinel.write_bytes(b"old")
        self.patches = [
            mock.patch.object(catalog, "ROOT", self.root),
            mock.patch.object(catalog, "OUTPUT", self.output),
            mock.patch.object(catalog, "MAIN_CSV", main_csv),
            mock.patch.object(catalog, "FACTIONS_TSV", factions_tsv),
            mock.patch.object(catalog, "CATALOG_CSV", generated / "army_corps_catalog.csv"),
            mock.patch.object(catalog, "CATALOG_JSON", generated / "army_corps_catalog.json"),
            mock.patch.object(catalog, "REPORT", self.root / "reports" / "validation.txt"),
            mock.patch.object(sys, "argv", ["build", "--flags-root", str(self.flags)]),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self) -> None:
        for patch in reversed(self.patches):
            patch.stop()
        self._tmp.cleanup()

    def write_flag(self, flag_dir: str) -> None:
        directory = self.flags / flag_dir
        directory.mkdir(parents=True, exist_ok=True)
        Image.new("RGBA", (44, 22), (200, 0, 0, 255)).save(directory / "mini_flag.tga")

    def assert_published_tree_untouched(self) -> None:
        self.assertEqual(self.sentinel.read_bytes(), b"old")
        self.assertFalse(self.output.with_name(self.output.name + ".staging").exists())
        self.assertFalse(catalog.CATALOG_CSV.exists())

    def test_missing_flags_root_fails_before_touching_assets(self) -> None:
        with self.assertRaises(SystemExit):
            catalog.main()
        self.assert_published_tree_untouched()

    def test_missing_flags_fail_without_wiping_and_without_index_error(self) -> None:
        # The non-corps custom army has no flag: it has no contingent, so no
        # donor lookup is possible (previously an IndexError in contingent_code).
        self.write_flag("f_ac_095")
        with self.assertRaises(SystemExit):
            catalog.main()
        self.assert_published_tree_untouched()
        report = catalog.REPORT.read_text(encoding="utf-8")
        self.assertIn("custom_army", report)

    def test_success_swaps_in_new_tree_with_published_paths(self) -> None:
        self.write_flag("f_custom")
        self.write_flag("f_ac_095")
        # f_ac_096 has no flag directory at all: it borrows its contingent's flag.
        catalog.main()
        self.assertFalse(self.sentinel.exists())
        self.assertFalse(self.output.with_name(self.output.name + ".staging").exists())
        self.assertFalse(self.output.with_name(self.output.name + ".old").exists())
        with catalog.CATALOG_CSV.open(newline="", encoding="utf-8-sig") as handle:
            rows = {row["faction_key"]: row for row in csv.DictReader(handle)}
        self.assertEqual(set(rows), {key for key, _, _ in FACTIONS})
        donor_row = rows["ntw3_ac_a05_fg5_096"]
        self.assertEqual(donor_row["selection_flag_donor_source_faction_key"], "ntw3_ac_a05_fg5_095")
        self.assertEqual(donor_row["available_source_flag_files"], "")
        for row in rows.values():
            self.assertTrue(row["flag_png_path"].startswith("assets/army_corps_by_theatre/"), row)
            self.assertTrue((self.root / row["flag_png_path"]).is_file(), row)

    def test_contingent_code_is_empty_for_non_corps_keys(self) -> None:
        self.assertEqual(catalog.contingent_code("aaa_lordz"), "")
        self.assertEqual(catalog.contingent_code("ntw3_ac_a05_fg5_095"), "fg5")


if __name__ == "__main__":
    unittest.main()
