"""Unit-pricing model for NTW3 Theatre-of-War and Custom armies: the front of the pricing package.

The model, its validation and its outputs are described in analysis/pricing/__init__.py and written out
in analysis/PRICING_MODEL_REPORT.md. The code lives in analysis/pricing/, one module per stage:

    constants, data, spec      fixed constants; units and staff from the CSVs; Spec (one candidate model)
    design, model              the design matrix; PriceModel (alternating least squares) and metrics
    splits, cv                 fold plans; cross-validation, slices, size-frequency weights
    pool, search               worker pool; size power profile, structure / stat-power / shape searches
    fclass, staff              faction modifiers and the faction × class multiplier; staff generals
    final                      FINAL, the committed final model of each arm
    formatting, diagnostics,   what a full run reports and writes
    results, report, outputs
    cli                        the command line (main)
    config                     runtime settings (workers, grids, output dir, ...): change with configure()
    pickling                   keeps checkpointed classes loadable as unit_pricing.<Name>

Other scripts use `import unit_pricing as up` and the names re-exported below. Settings still read under
their old names (up.WORKERS, up.P_GRID, ...). Assigning a setting or a re-exported name raises, because
the code that uses it lives in the pricing modules and would never see the new value.

Run from the repository root (~50 minutes with the default 6 worker processes):

    python analysis/unit_pricing.py [--seeds 500] [--workers 6] [--out DIR] [--artillery-cal …] [--linear]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ARMS, DATA_CSV, ROOT, SIZE_WEIGHT_BANDS, log, table  # noqa: E402,F401
from pricing import config  # noqa: E402,F401
from pricing.config import Settings, configure  # noqa: E402,F401
from pricing.constants import DEV_CORPS, MULT_CATEGORICAL, N_SPLITS, REF_RATING, SPEED_TAG_RE  # noqa: E402,F401
from pricing.data import Staff, Unit, in_scope, load, load_ratings, num, side_of  # noqa: E402,F401
from pricing.spec import Spec, with_powers  # noqa: E402,F401
from pricing.design import Design, design_for, natural_spline_basis, spline_knots  # noqa: E402,F401
from pricing.model import PriceModel, metrics  # noqa: E402,F401
from pricing.splits import SplitPlan  # noqa: E402,F401
from pricing.formatting import f1, f2, pm  # noqa: E402,F401
from pricing.cv import (  # noqa: E402,F401
    CVRun, Slice, SliceData, cv_spec, data_for, fit_on, kish_ess, make_slice, predict_total, size_band_labels,
    size_of, size_weights, slice_units)
from pricing.pool import parallel_map  # noqa: E402,F401
from pricing.search import PowerResult, nested_powers  # noqa: E402,F401
from pricing.fclass import (  # noqa: E402,F401
    FCLASS_FORM, FCLASS_GRID, FCLASS_LABEL, FCLASS_MAKERS, FclassResult, fclass_cv, fclass_multiplier,
    joint_fclass_spec)
from pricing.final import FINAL  # noqa: E402,F401
from pricing.staff import (  # noqa: E402,F401
    StaffRun, StaffSlice, make_staff_slice, staff_power_fit, staff_power_price)
from pricing.cli import main  # noqa: E402,F401

# --- Settings access for importers ---------------------------------------------
# The settings used to be module globals that importers reassigned (up.WORKERS = 4). Reading them under
# their old names still works; assigning one raises, because it would no longer reach the code.
SETTING_NAMES = {"WORKERS": "workers", "OUT_DIR": "out_dir", "P_GRID": "p_grid", "POWER_GRID": "power_grid",
                 "MAX_PASSES": "max_passes", "FINE_PASSES": "fine_passes", "MAX_ITER": "max_iter",
                 "TOLERANCE": "tolerance", "ARTILLERY_CAL": "artillery_cal", "SIZE_WEIGHTING": "size_weighting"}


def __getattr__(name: str) -> object:
    if name in SETTING_NAMES:
        return getattr(config.settings, SETTING_NAMES[name])
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# Every public name above is a re-export: rebinding it here would not reach the pricing module that uses it.
REEXPORTED = frozenset(name for name in globals() if not name.startswith("_")) - {"annotations", "sys", "Path"}


class _Module(type(sys)):
    def __setattr__(self, name: str, value: object) -> None:
        if name in SETTING_NAMES:
            raise AttributeError(f"{name} is a setting: use unit_pricing.configure({SETTING_NAMES[name]}=...)")
        if name in REEXPORTED:
            raise AttributeError(f"unit_pricing.{name} is re-exported from the pricing package; assigning it "
                                 "here would not change the code that uses it")
        super().__setattr__(name, value)


sys.modules[__name__].__class__ = _Module


if __name__ == "__main__":
    raise SystemExit(main())
