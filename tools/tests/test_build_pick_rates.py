"""Tests for the per-corps `builds` field of build_pick_rates.py, on small fixture CSVs."""

from __future__ import annotations

import csv
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tools import build_pick_rates

CORPS = "ntw3_ac_test_x5_001"
OTHER = "ntw3_ac_test_x5_002"
TOW = "ntw3_tow_test_x5_003"
STAFF = "ntw3_gen_staff_001"
FIELDS = ["battle_id", "army_index", "army_key", "slot", "unit_key", "base_unit_key",
          "is_commander", "is_staff_slot", "resolved"]


def write(path: Path, header: list[str], rows: list[list]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        w = csv.writer(handle)
        w.writerow(header)
        w.writerows(rows)


def unit_rows(battle: str, army: int, key: str, units: list[str]) -> list[list]:
    rows = [[battle, army, key, 0, STAFF, STAFF, "False", "True", "True"]]
    for slot, unit in enumerate(units, 1):
        rows.append([battle, army, key, slot, unit, unit.removesuffix("_com_1"),
                     str(unit.endswith("_com_1")), "False", "True"])
    return rows


class BuildsFieldTests(unittest.TestCase):
    def build(self, rows: list[list], *, header: list[str] = FIELDS, popularity: dict | None = None) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            stats = Path(tmp)
            write(stats / "army_units.csv", header, rows)
            write(stats / "battles.csv", ["battle_id", "game_build"], [])
            write(stats / "armies.csv", ["battle_id", "army_index", "army_key", "player"], [])
            write(stats / "players.csv", ["player"], [])
            counts = popularity or {}
            write(stats / "corps_popularity.csv", ["army_key", "appearances", "distinct_players"],
                  [[k, v, 1] for k, v in counts.items()])
            with mock.patch.object(build_pick_rates, "all_corps",
                                   return_value={CORPS: "Corps", OTHER: "Other", TOW: "Tow"}), \
                 mock.patch.object(build_pick_rates, "PUBLIC", Path(tmp)):
                (Path(tmp) / "data-version.json").write_text("{}", encoding="utf-8")
                return build_pick_rates.build_season("s", "S", "now", stats)

    def test_shape_copies_and_staff(self) -> None:
        rows = (unit_rows("a", 0, CORPS, ["u_b", "u_a", "u_b"])
                + unit_rows("b", 0, CORPS, ["u_c"]))
        season = self.build(rows, popularity={CORPS: 2})
        builds = season["corps"][CORPS]["builds"]
        self.assertEqual(season["schemaVersion"], 3)
        self.assertEqual(builds["keys"], ["u_a", "u_b", "u_c"])
        self.assertNotIn(STAFF, builds["keys"])
        self.assertEqual(builds["b"], [[0, 1, 1], [2]])
        self.assertEqual(len(builds["b"]), season["corps"][CORPS]["n"])

    def test_two_armies_one_battle_stay_separate(self) -> None:
        rows = unit_rows("a", 0, CORPS, ["u_a"]) + unit_rows("a", 1, CORPS, ["u_b"])
        season = self.build(rows, popularity={CORPS: 2})
        corps = season["corps"][CORPS]
        self.assertEqual(corps["builds"]["b"], [[0], [1]])
        self.assertEqual(len(corps["builds"]["b"]), corps["n"])

    def test_out_of_scope_and_unplayed_have_no_builds(self) -> None:
        rows = unit_rows("a", 0, CORPS, ["u_a"]) + unit_rows("a", 1, TOW, ["u_a"])
        season = self.build(rows, popularity={CORPS: 1})
        self.assertNotIn(TOW, season["corps"])
        self.assertNotIn("builds", season["corps"][OTHER])
        self.assertIn("builds", season["corps"][CORPS])

    def test_missing_staff_column_warns_and_falls_back_to_slot(self) -> None:
        header = [c for c in FIELDS if c != "is_staff_slot"]
        rows = [[r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[8]]
                for r in unit_rows("a", 0, CORPS, ["u_a"])]
        with mock.patch("builtins.print") as printed:
            season = self.build(rows, header=header, popularity={CORPS: 1})
        self.assertEqual(season["corps"][CORPS]["builds"], {"keys": ["u_a"], "b": [[0]]})
        self.assertTrue(any("is_staff_slot" in str(c) for c in printed.call_args_list))


if __name__ == "__main__":
    unittest.main()
