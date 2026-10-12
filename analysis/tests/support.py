"""Shared helpers for the analysis tests: puts analysis/ on the import path and computes the
fingerprints that analysis/tests/make_golden.py writes and the tests compare."""

from __future__ import annotations

import hashlib
import pickle
import sys
from pathlib import Path

ANALYSIS = Path(__file__).resolve().parents[1]
if str(ANALYSIS) not in sys.path:
    sys.path.insert(0, str(ANALYSIS))

CACHE = ANALYSIS / ".cache"
GOLDEN = ANALYSIS / "tests" / "golden"
HAS_CACHE = CACHE.is_dir() and any(CACHE.rglob("*.pkl"))


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def headline(obj) -> str | None:
    """The number a checkpoint is usually read for: CV MAE of a CVRun (also inside tuples), or κ."""
    import unit_pricing as up
    if isinstance(obj, tuple) and obj:
        obj = obj[0]
    if isinstance(obj, dict) and isinstance(obj.get("run"), up.CVRun):
        obj = obj["run"]
    if isinstance(obj, up.CVRun):
        return repr(obj.mean("mae"))
    if isinstance(obj, up.FclassResult):
        return repr(obj.full_kappa)
    if isinstance(obj, float):
        return repr(obj)
    return None


def canonical(obj) -> object:
    """A hash-order-independent description of a loaded checkpoint: sets sorted (their pickled order
    follows PYTHONHASHSEED, which changes every process), arrays by dtype, shape and bytes, and every
    object by its class's module and name (which pins the path pickle loads it from) plus its state."""
    import numpy as np
    if obj is None or isinstance(obj, (bool, int, str)):
        return obj
    if isinstance(obj, float):
        return repr(obj)
    if isinstance(obj, np.generic):
        return ["np", obj.dtype.str, repr(obj.item())]
    if isinstance(obj, np.ndarray):
        if obj.dtype == object:
            return ["ndarray-object", list(obj.shape), [canonical(x) for x in obj.ravel().tolist()]]
        return ["ndarray", obj.dtype.str, list(obj.shape), sha(np.ascontiguousarray(obj).tobytes())]
    if isinstance(obj, (set, frozenset)):
        return [type(obj).__name__, sorted((canonical(x) for x in obj), key=repr)]
    if isinstance(obj, (list, tuple)):
        return [type(obj).__name__, [canonical(x) for x in obj]]
    if isinstance(obj, dict):
        items = [(canonical(k), canonical(v)) for k, v in obj.items()]
        return [type(obj).__name__, sorted(items, key=lambda kv: repr(kv[0]))]
    state = obj.__getstate__() if hasattr(obj, "__getstate__") else getattr(obj, "__dict__", repr(obj))
    return [f"{type(obj).__module__}.{type(obj).__qualname__}", canonical(state)]


def checkpoint_record(path: Path) -> dict:
    obj = pickle.loads(path.read_bytes())
    return {"type": type(obj).__name__, "fingerprint": sha(repr(canonical(obj)).encode("utf-8")),
            "headline": headline(obj)}


def load_fingerprints() -> dict:
    import ac_pricing as ap
    import unit_pricing as up
    units, staff, _, _ = up.load(up.load_ratings())
    ac_units, ac_staff = ap.ac_units()
    return {name: {"count": len(rows), "sha": sha("\n".join(repr(r) for r in rows).encode("utf-8"))}
            for name, rows in (("tow_units", units), ("tow_staff", staff), ("ac_units", ac_units), ("ac_staff", ac_staff))}


def numerics() -> dict:
    import numpy as np
    import team_values as tv
    import unit_pricing as up
    from pricing.final import FINAL
    out = {}
    for arm in up.ARMS:
        units = tv.slice_of("tow", arm).units
        spec = up.joint_fclass_spec(FINAL[arm], tv.kappa_of("tow", arm))
        design = up.design_for(spec, units, arm)
        model = up.fit_on(spec, design, up.data_for(spec, units), np.arange(len(units)))
        size = np.array([up.size_of(u, spec.size) for u in units])
        w, table = up.size_weights(size, spec.size, {"alpha": 1.0, "cap": 10.0, "min_band": 20})
        out[arm] = {"sse": repr(float(model.sse)), "weights_sha": sha(np.asarray(w, float).tobytes()),
                    "weight_table": table}
    return out


def worker_settings(_: int = 0):
    """The settings a pool worker computes with (a module-level function, so the pool can pickle it)."""
    from pricing import config
    return config.settings
