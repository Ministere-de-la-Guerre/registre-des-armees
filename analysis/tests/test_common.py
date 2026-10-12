"""The shared helpers (analysis/common.py, analysis/checkpoints.py)."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import support  # noqa: F401  (puts analysis/ on the path)
import checkpoints as ckpt
import common


class CommonTests(unittest.TestCase):
    def test_theatre_and_wip(self) -> None:
        self.assertEqual(common.theatre_of("ntw3_ac_a11_x5_117"), "a11")
        self.assertTrue(common.is_wip("ntw3_ac_b16_x7_273"))
        self.assertFalse(common.is_wip("ntw3_ac_a11_x5_117"))
        self.assertFalse(common.is_wip("ntw3_tow_b16_x8_009"))        # only Army Corps have theatres

    def test_table(self) -> None:
        self.assertEqual(common.table(["a", "b"], [[1, "x"]]), ["| a | b |", "| --- | --- |", "| 1 | x |"])

    def test_cached_computes_once_and_writes_atomically(self) -> None:
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sub" / "x.pkl"
            first = common.cached(path, lambda: calls.append(1) or {"v": 1})
            second = common.cached(path, lambda: calls.append(1) or {"v": 2})
            self.assertEqual((first, second, len(calls)), ({"v": 1}, {"v": 1}, 1))
            self.assertEqual(common.cached(path, lambda: {"v": 3}, fresh=True), {"v": 3})
            self.assertEqual(sorted(p.name for p in path.parent.iterdir()), ["x.pkl"])   # no temp left

    def test_checkpoint_names_are_unchanged(self) -> None:
        # These names are the contract with the existing checkpoints; never change them.
        self.assertEqual(ckpt.slice_path("ac", "cavalry").name, "v1_s500_cavalry_slice.pkl")
        self.assertEqual(ckpt.slice_path("tow", "cavalry").name, "v1_s500_tow_cavalry_slice.pkl")
        self.assertEqual(ckpt.v4_path("ac", "infantry").name, "v1_s500_infantry_v4.pkl")
        self.assertEqual(ckpt.v4_path("tow", "infantry").name, "v2_infantry_V4.pkl")
        self.assertEqual(ckpt.tow_kappa_path("artillery").name, "v2_artillery_kappa.pkl")
        self.assertEqual(ckpt.sb_path("tow", "artillery").name, "sb_tow_artillery.pkl")
        self.assertEqual(ckpt.tow_builds_path("sb").name, "tow_builds_v2_sb.pkl")
        self.assertEqual(ckpt.ac_jfc_path("artillery", 3).name, "v1_s3_artillery_jfc.pkl")
        self.assertEqual(ckpt.class_structure("cavalry_V0").name, "v2_cavalry_V0.pkl")

    def test_ac_discounts_self_checks_raise(self) -> None:
        # ac_discounts validates the data and the rules port with check(), which python -O cannot strip.
        import ac_discounts
        ac_discounts.check(True, "fine")
        with self.assertRaisesRegex(ValueError, "self-check failed: detail"):
            ac_discounts.check(False, "detail")


if __name__ == "__main__":
    unittest.main()
