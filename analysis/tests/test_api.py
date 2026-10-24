"""The analysis scripts' contract with each other: importing a script changes no other module's
settings (ac_pricing used to widen unit_pricing's κ grid for every importer), and the names other
scripts use from unit_pricing keep resolving."""

from __future__ import annotations

import os
import subprocess
import sys
import unittest
from dataclasses import fields

from support import ANALYSIS, worker_settings

SNAPSHOT = """
import sys
sys.path.insert(0, {analysis!r})
import common, unit_pricing as up, commander_model as cm
def snap():
    return repr((sorted(up.FCLASS_GRID.items()), up.WORKERS, up.SIZE_WEIGHTING, up.P_GRID, up.POWER_GRID,
                 up.MAX_PASSES, up.FINE_PASSES, up.MAX_ITER, up.TOLERANCE, up.ARTILLERY_CAL, str(up.DATA_CSV),
                 up.in_scope.__qualname__, up.side_of.__qualname__, sorted(common.AC_STUDY_BANDS.items()),
                 sorted(common.SB_BANDS.items()), str(cm.PAIRS)))
before = snap()
import ac_pricing, class_structure, cost_effective_builds, team_values, ac_builds, team_search  # noqa
import export_optimiser_values  # noqa
print("SAME" if snap() == before else "CHANGED:\\n" + before + "\\n" + snap())
"""

# Names other scripts read from unit_pricing (grep `up\\.<name>` over analysis/); they must keep resolving.
PUBLIC = """ROOT log table Unit Spec REF_RATING design_for CVRun num data_for load_ratings fit_on size_of DATA_CSV
slice_units Design predict_total load ARMS joint_fclass_spec make_slice in_scope side_of SliceData Slice fclass_cv
cv_spec WORKERS FCLASS_MAKERS FCLASS_FORM with_powers staff_power_fit parallel_map PowerResult N_SPLITS FCLASS_GRID
staff_power_price size_weights size_band_labels metrics make_staff_slice kish_ess Staff OUT_DIR spline_knots pm
nested_powers natural_spline_basis fclass_multiplier f2 f1 StaffRun SPEED_TAG_RE SIZE_WEIGHT_BANDS SIZE_WEIGHTING
MULT_CATEGORICAL FclassResult FCLASS_LABEL DEV_CORPS PriceModel SplitPlan StaffSlice""".split()
PICKLED = ("Unit", "Staff", "Spec", "SplitPlan", "PriceModel", "CVRun", "Slice", "FclassResult", "StaffRun", "StaffSlice")


class ApiTests(unittest.TestCase):
    def test_importing_scripts_changes_no_shared_setting(self) -> None:
        out = subprocess.run([sys.executable, "-c", SNAPSHOT.format(analysis=str(ANALYSIS))],
                             capture_output=True, text=True, encoding="utf-8", check=True).stdout
        self.assertEqual(out.strip(), "SAME", out)

    def test_public_names_resolve(self) -> None:
        import unit_pricing as up
        missing = [name for name in PUBLIC if not hasattr(up, name)]
        self.assertEqual(missing, [])

    def test_pickled_classes_keep_their_module_path(self) -> None:
        # Checkpoints in analysis/.cache/ pickle these as unit_pricing.<Name>; moving one breaks them.
        import unit_pricing as up
        for name in PICKLED:
            cls = getattr(up, name)
            self.assertEqual((cls.__module__, cls.__qualname__), ("unit_pricing", name))

    def test_each_pricing_module_imports_on_its_own(self) -> None:
        # A fresh interpreter per module: no module may rely on another having been imported first.
        modules = sorted(p.stem for p in (ANALYSIS / "pricing").glob("*.py") if p.stem != "__init__")
        code = "import sys; sys.path.insert(0, {a!r}); import importlib; importlib.import_module('pricing.' + {m!r})"
        for m in modules:
            r = subprocess.run([sys.executable, "-c", code.format(a=str(ANALYSIS), m=m)],
                               capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(r.returncode, 0, f"pricing.{m}: {r.stderr[-600:]}")

    def test_assigning_a_reexported_name_raises(self) -> None:
        import unit_pricing as up
        with self.assertRaisesRegex(AttributeError, "re-exported"):
            up.FCLASS_GRID = {}
        up.scratch_value = 1          # names the module does not export can still be set
        del up.scratch_value

    def test_cli_help_runs(self) -> None:
        r = subprocess.run([sys.executable, str(ANALYSIS / "unit_pricing.py"), "--help"],
                           capture_output=True, text=True, encoding="utf-8",
                           env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        self.assertEqual(r.returncode, 0, r.stderr[-600:])
        self.assertIn("price = M × size^p", r.stdout)
        self.assertIn("--artillery-cal", r.stdout)


class SettingsTests(unittest.TestCase):
    def setUp(self) -> None:
        from pricing import config
        self.original = config.settings

    def tearDown(self) -> None:
        import unit_pricing as up
        up.configure(**{f.name: getattr(self.original, f.name) for f in fields(self.original)})

    def test_assigning_a_setting_raises(self) -> None:
        import unit_pricing as up
        with self.assertRaisesRegex(AttributeError, r"configure\(workers=\.\.\.\)"):
            up.WORKERS = 2
        with self.assertRaises(AttributeError):
            up.SIZE_WEIGHTING = {"alpha": 1.0}
        self.assertEqual(up.WORKERS, self.original.workers)

    def test_configure_is_read_back_under_the_old_names(self) -> None:
        import unit_pricing as up
        up.configure(power_grid=(1.0,), max_passes=1, workers=1)
        self.assertEqual((up.POWER_GRID, up.MAX_PASSES, up.WORKERS), ((1.0,), 1, 1))
        self.assertEqual(up.P_GRID, self.original.p_grid)

    def test_unknown_setting_raises(self) -> None:
        import unit_pricing as up
        with self.assertRaises(TypeError):
            up.configure(WORKERS=2)

    def test_pool_workers_get_the_configured_settings(self) -> None:
        import unit_pricing as up
        up.configure(workers=2, p_grid=(0.75, 1.0))
        seen = up.parallel_map(worker_settings, [(0,), (1,)])
        self.assertEqual([(s.p_grid, s.workers) for s in seen], [((0.75, 1.0), 1)] * 2)
        up.configure(p_grid=(1.25,))      # a changed setting retires the old pool
        seen = up.parallel_map(worker_settings, [(0,), (1,)])
        self.assertEqual([s.p_grid for s in seen], [(1.25,)] * 2)


if __name__ == "__main__":
    unittest.main()
