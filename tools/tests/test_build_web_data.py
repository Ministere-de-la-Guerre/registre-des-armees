"""Tests for tools/build_web_data.py: TOW placement nulling, the data-version
content hash, stale-output pruning and fatal exit codes."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools import build_web_data as web


def csv_row(**overrides: str) -> dict[str, str]:
    row = {
        "unit_key": "ntw3_inf_line_001", "faction_key": "ntw3_tow_a05_x8_001",
        "unit_class": "infantry_line", "is_general": "false", "base_mp_cost": "500",
        "unit_cap": "2", "division_id": "3", "brigade_id": "2",
        "division_brigade_code": "ACDV3B2", "reload_skill": "80", "ammo": "47",
        "firearm": "M1798",
    }
    row.update(overrides)
    return row


class NormalizeUnitTests(unittest.TestCase):
    def normalize(self, **overrides: str) -> dict:
        errors: list[str] = []
        card = web.normalize_unit(csv_row(**overrides), web.AssetCopier(), errors)
        self.assertEqual(errors, [])
        return card

    def test_tow_corps_drops_every_placement_field(self) -> None:
        card = self.normalize()
        self.assertIsNone(card["division"])
        self.assertIsNone(card["brigade"])
        self.assertIsNone(card["divisionBrigadeCode"])

    def test_army_corps_keeps_placement(self) -> None:
        card = self.normalize(faction_key="ntw3_ac_a05_x5_095")
        self.assertEqual((card["division"], card["brigade"]), (3, 2))
        self.assertEqual(card["divisionBrigadeCode"], "ACDV3B2")

    def test_stats_carry_ammo_and_firearm(self) -> None:
        stats = self.normalize()["stats"]
        self.assertEqual(stats["ammo"], 47)
        self.assertEqual(stats["firearm"], "M1798")
        stats = self.normalize(ammo="", firearm="")["stats"]
        self.assertIsNone(stats["ammo"])
        self.assertIsNone(stats["firearm"])


class ContentHashTests(unittest.TestCase):
    def test_hash_is_order_independent_and_content_sensitive(self) -> None:
        a = {"data/factions/a.json": b"{}", "data/corps-index.json": b"[1]"}
        b = dict(reversed(list(a.items())))
        self.assertEqual(web.content_hash(a), web.content_hash(b))
        self.assertEqual(len(web.content_hash(a)), 64)
        changed = dict(a, **{"data/factions/a.json": b"{ }"})
        self.assertNotEqual(web.content_hash(a), web.content_hash(changed))
        renamed = {"data/factions/b.json": b"{}", "data/corps-index.json": b"[1]"}
        self.assertNotEqual(web.content_hash(a), web.content_hash(renamed))


class OutputTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.public = Path(self._tmp.name) / "public"
        self.patches = [
            mock.patch.object(web, "WEB_PUBLIC", self.public),
            mock.patch.object(web, "OUT_DATA", self.public / "data"),
            mock.patch.object(web, "OUT_ASSETS", self.public / "assets"),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self) -> None:
        for patch in reversed(self.patches):
            patch.stop()
        self._tmp.cleanup()

    def test_prune_removes_only_files_this_run_did_not_produce(self) -> None:
        keep = self.public / "data" / "factions" / "kept.json"
        stale = self.public / "data" / "factions" / "removed_faction.json"
        stale_dir_file = self.public / "data" / "old" / "x.json"
        for path in (keep, stale, stale_dir_file):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{}", encoding="utf-8")
        removed = web.prune_stale(self.public / "data", {"data/factions/kept.json"})
        self.assertEqual(removed, 2)
        self.assertTrue(keep.is_file())
        self.assertFalse(stale.exists())
        self.assertFalse(stale_dir_file.parent.exists())

    def test_missing_required_input_is_fatal(self) -> None:
        with mock.patch.object(web, "UNITS_CSV", Path(self._tmp.name) / "missing.csv"):
            self.assertEqual(web.main(), 1)

    def test_no_factions_is_fatal(self) -> None:
        empty_csv = Path(self._tmp.name) / "units.csv"
        empty_csv.write_text("unit_key,faction_key\n", encoding="utf-8")
        catalog = Path(self._tmp.name) / "catalog.json"
        catalog.write_text("{}", encoding="utf-8")
        with mock.patch.object(web, "UNITS_CSV", empty_csv), \
                mock.patch.object(web, "CATALOG_JSON", catalog):
            self.assertEqual(web.main(), 1)


if __name__ == "__main__":
    unittest.main()
