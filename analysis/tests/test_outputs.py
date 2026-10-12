"""The committed outputs still follow from the checkpoints: values recomputed by today's code equal the
CSVs the app's data was exported from, and the AC optimiser reproduces its summary rows."""

from __future__ import annotations

import csv
import unittest

from support import ANALYSIS, HAS_CACHE

TEAMS = ANALYSIS / "output" / "teams"


def rows(name: str) -> list[dict]:
    with open(TEAMS / name, encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


HAS_OUTPUTS = (TEAMS / "values_ac.csv").exists()


@unittest.skipUnless(HAS_CACHE and HAS_OUTPUTS, "needs the checkpoints and outputs of a pipeline run")
class OutputTests(unittest.TestCase):
    def test_ac_unit_values(self) -> None:
        import team_values as tv
        import unit_pricing as up
        stored = {(r["faction_key"], r["unit_key"]): r for r in rows("values_ac.csv") if r["kind"] == "unit"}
        for arm in up.ARMS:
            sl = tv.slice_of("ac", arm)
            raw, _ = tv.v4_raw_and_oof("ac", arm, sl.units)
            sb, _ = tv.sb_values("ac", arm, sl.units, sl.plan.folds)
            with self.subTest(arm=arm):
                for k, v in raw.items():
                    self.assertEqual(f"{v:.3f}", stored[k]["value_raw"], k)
                for k, v in sb.items():
                    self.assertEqual(f"{v:.3f}", stored[k]["value_sb"], k)

    def test_tow_size_band_values(self) -> None:
        import team_values as tv
        import unit_pricing as up
        stored = {(r["faction_key"], r["unit_key"]): r["value_sb"] for r in rows("values_tow_sb.csv") if r["kind"] == "unit"}
        for arm in up.ARMS:
            sl = tv.slice_of("tow", arm)
            sb, _ = tv.sb_values("tow", arm, sl.units, sl.plan.folds)
            with self.subTest(arm=arm):
                for k, v in sb.items():
                    self.assertEqual(f"{v:.3f}", stored[k], k)

    def test_ac_builds(self) -> None:
        import ac_builds as ab
        import cost_effective_builds as ceb
        catalog, values, extra, _, _, t3 = ab.load_inputs()
        command = ceb.Command(ab.LAMBDA["sb"], ceb.SPEED_BONUS, ceb.bodyguard_melee_bonus())
        summary = {r["faction_key"]: r for r in rows("ac_build_summary_sb.csv")}
        for faction in ("ntw3_ac_a11_x5_117", "ntw3_ac_a03_x5_080", "ntw3_ac_a08_x5_242"):
            res = ab.solve_corps(faction, catalog, values["sb"], extra, t3, command, 31)
            with self.subTest(corps=faction):
                self.assertEqual(f"{res['value']:.1f}", summary[faction]["value"])
                self.assertEqual(str(res["price"].final_cost), summary[faction]["final_cost"])
                self.assertEqual(str(res["price"].base_cost), summary[faction]["list_cost"])
                self.assertEqual(res["cuts"], 0)


@unittest.skipUnless(HAS_OUTPUTS, "needs the outputs of a pipeline run")
class FormationDiscountScoreTests(unittest.TestCase):
    def test_score_is_face_per_10000_times_corps_number(self) -> None:
        # The "Formation discount only" team score (team_search.py `price`): face / 10 000 × N of the
        # best formation-discount build, for every AC army; ToW / Custom rows have none.
        price = {r["faction_key"]: r for r in rows("ac_build_summary_price.csv") if r["cards"]}
        scored = 0
        for r in rows("army_values.csv"):
            if r["kind"] != "ac":
                self.assertEqual((r["value_price"], r["cost_price"]), ("", ""))
                continue
            s = price[r["faction_key"]]
            self.assertEqual(r["value_price"], f"{int(s['list_cost']) / 10_000 * int(s['corps_number']):.3f}")
            self.assertEqual(r["cost_price"], s["final_cost"])
            scored += 1
        self.assertGreater(scored, 200)


if __name__ == "__main__":
    unittest.main()
