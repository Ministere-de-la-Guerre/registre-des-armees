"""Number formatting and small statistics shared by the logs, the report and the outputs
(f1/f2/f3, ± strings, % residuals, Spearman, factor descriptions).

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

from typing import Callable, Sequence

import numpy as np

from pricing.constants import CATEGORICAL
from pricing.model import PriceModel


# --- Report helpers -----------------------------------------------------------

def f1(x: float) -> str:
    return f"{x:,.1f}"


def f2(x: float) -> str:
    return f"{x:,.2f}"


def f3(x: float) -> str:
    return f"{x:.3f}"


def pm(run, metric: str, fmt: Callable[[float], str]) -> str:
    return f"{fmt(run.mean(metric))} ± {fmt(run.sd(metric))}"


def pct_resid(actual: np.ndarray, pred: np.ndarray) -> np.ndarray:
    """(actual − predicted) / predicted × 100: positive = game price above formula."""
    with np.errstate(divide="ignore", invalid="ignore"):
        return (actual - pred) / pred * 100


def spearman(x: Sequence[float], y: Sequence[float]) -> float:
    """Rank correlation (average ranks for ties), without importing scipy."""
    def ranks(values: Sequence[float]) -> np.ndarray:
        values = np.asarray(values, float)
        order = np.argsort(values, kind="mergesort")
        out = np.empty(len(values))
        out[order] = np.arange(len(values))
        for value in np.unique(values):
            tied = values == value
            out[tied] = out[tied].mean()
        return out
    return float(np.corrcoef(ranks(x), ranks(y))[0, 1])


def describe_factors(model: PriceModel) -> str:
    parts = []
    for var in sorted(model.spec.mult):
        if var in CATEGORICAL:
            parts.append(f"m_{var}: " + ", ".join(f"{k}: {v:.3f}" for k, v in sorted(model.levels[var].items(), key=lambda t: str(t[0]))))
        else:
            parts.append(f"m_{var} = 1 {model.delta[var]:+.4f}·({var} − {model.refs[var]:g})")
    return "; ".join(parts) or "—"
