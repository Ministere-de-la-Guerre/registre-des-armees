"""PriceModel, the alternating least-squares fit of price = M × size^p × (β·x) + c, and the error
metrics.

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

import numpy as np

from pricing import config
from pricing.pickling import pickled_as_unit_pricing
from pricing.constants import CATEGORICAL, GROUPING, MULT_CATEGORICAL, REF_RATING
from pricing.spec import Spec
from pricing.design import most_common_level


# --- Model --------------------------------------------------------------------

@pickled_as_unit_pricing
class PriceModel:
    """Per-size price y = cost/size = M·g·(b0 + β·f(x)) + c/size, where
    g = size^(p−1) carries the size power and M = Π_k m_k (one factor per
    variable in spec.mult; categorical factors have one m per level with the
    reference fixed at 1, rank_depth has m = 1 + δ·(rank_depth − median)).

    Fitted by alternating least squares on Σ w·(y − M·g·(b0 + β·f(x)) − c/size)²
    (w = 1 unless IRLS row weights are passed): the β/c step is exact least
    squares on the columns [M·g, M·g·X, 1/size]; each factor step is a
    closed-form regression on y − c/size given everything else. Every step lowers
    the objective, which is asserted. Grouping factors (faction, faction × class)
    carry no reference level; instead the objective adds λ·Σ (m − 1)² with
    λ = κ·mean(w·y²) — κ pseudo-units of average price at m = 1 — so their step
    is m = (Σ w·t·q + λ) / (Σ w·q² + λ).

    A faction modifier, when asked for, is fitted afterwards on the scaled part:
    m_f = Σ (y − c/size)·q / Σ q², q = M·g·base; a residual faction × class
    modifier then multiplies it, shrunk towards 1 (i.e. towards m_f) the same way.
    """

    def __init__(self, spec: Spec):
        self.spec = spec
        self.b0 = 0.0
        self.beta = np.zeros(0)
        self.c = 0.0
        self.levels: dict[str, dict[object, float]] = {}
        self.refs: dict[str, object] = {}
        self.delta: dict[str, float] = {}
        self.faction_m: dict[str, float] = {}
        self.fclass_m: dict[str, float] = {}
        self.ridge: dict[str, float] = {}
        self.iterations = 0
        self.sse = float("nan")

    def _factor(self, var: str, values: np.ndarray) -> np.ndarray:
        if var in MULT_CATEGORICAL:
            table = self.levels[var]
            return np.array([table.get(v, 1.0) for v in values.tolist()])
        return 1 + self.delta[var] * (values - self.refs[var])

    def fit(self, X: np.ndarray, y: np.ndarray, inv: np.ndarray, g: np.ndarray,
            fvals: dict[str, np.ndarray], factions: np.ndarray,
            weights: np.ndarray | None = None) -> "PriceModel":
        mult = sorted(self.spec.mult)
        w = np.ones(len(y)) if weights is None else weights
        sw = None if weights is None else np.sqrt(weights)
        scale2 = float(np.mean(w * y * y))
        codes: dict[str, tuple[np.ndarray, list]] = {}
        for var in mult:
            values = fvals[var]
            if var in MULT_CATEGORICAL:
                levels = sorted(set(values.tolist()), key=str)
                if var in GROUPING:
                    self.refs[var] = None
                    self.ridge[var] = self.spec.kappa * scale2
                else:
                    ref = REF_RATING if var == "rating" and REF_RATING in levels else most_common_level(values.tolist())
                    self.refs[var] = ref
                self.levels[var] = {level: 1.0 for level in levels}
                index = {level: i for i, level in enumerate(levels)}
                codes[var] = (np.array([index[v] for v in values.tolist()]), levels)
            else:
                self.refs[var] = float(np.median(values))
                self.delta[var] = 0.0
        factor = {var: np.ones(len(y)) for var in mult}
        M = np.ones(len(y))
        previous = np.inf
        for self.iterations in range(1, config.settings.max_iter + 1):
            scale = M * g
            Z = np.hstack([scale[:, None], scale[:, None] * X] + ([inv[:, None]] if self.spec.const else []))
            if sw is None:
                coef, *_ = np.linalg.lstsq(Z, y, rcond=None)
            else:
                coef, *_ = np.linalg.lstsq(Z * sw[:, None], y * sw, rcond=None)
            self.b0 = float(coef[0])
            self.beta = coef[1:1 + X.shape[1]]
            self.c = float(coef[-1]) if self.spec.const else 0.0
            base = g * (self.b0 + X @ self.beta)
            target = y - self.c * inv
            for var in mult:
                q = base.copy()
                for other in mult:
                    if other != var:
                        q *= factor[other]
                wq = q if weights is None else w * q
                if var in MULT_CATEGORICAL:
                    code, levels = codes[var]
                    numerator = np.bincount(code, weights=target * wq, minlength=len(levels))
                    denominator = np.bincount(code, weights=q * wq, minlength=len(levels))
                    if var in GROUPING:
                        lam = self.ridge[var]
                        m = np.divide(numerator + lam, denominator + lam, out=np.ones(len(levels)),
                                      where=denominator + lam > 0)
                    else:
                        m = np.divide(numerator, denominator, out=np.ones(len(levels)), where=denominator > 0)
                        m[levels.index(self.refs[var])] = 1.0
                    self.levels[var] = dict(zip(levels, m.tolist()))
                    factor[var] = m[code]
                else:
                    d = fvals[var] - self.refs[var]
                    if weights is None:
                        denominator = float(((d * q) ** 2).sum())
                        numerator = float(((target - q) * d * q).sum())
                    else:
                        denominator = float((w * (d * q) ** 2).sum())
                        numerator = float((w * (target - q) * d * q).sum())
                    self.delta[var] = numerator / denominator if denominator else 0.0
                    factor[var] = 1 + self.delta[var] * d
            M = np.prod([factor[var] for var in mult], axis=0) if mult else np.ones(len(y))
            residual = y - M * base - self.c * inv
            sse = float((residual ** 2).sum()) if weights is None else float((w * residual ** 2).sum())
            sse += sum(lam * sum((m - 1) ** 2 for m in self.levels[var].values()) for var, lam in self.ridge.items())
            if not mult:
                break
            if sse > previous * (1 + 1e-7) + 1e-9:
                raise AssertionError(f"ALS objective rose: {previous} -> {sse} ({self.spec.describe()})")
            if np.isfinite(previous) and previous - sse <= config.settings.tolerance * previous:
                break
            previous = sse
        self.sse = sse
        if self.spec.faction:
            q = M * g * (self.b0 + X @ self.beta)
            target = y - self.c * inv
            self.faction_m = {}
            for faction in set(factions.tolist()):
                mask = factions == faction
                if weights is None:
                    self.faction_m[faction] = float((target[mask] * q[mask]).sum() / (q[mask] ** 2).sum())
                else:
                    wm = w[mask]
                    self.faction_m[faction] = float((wm * target[mask] * q[mask]).sum() / (wm * q[mask] ** 2).sum())
            if self.spec.fclass == "residual":
                s = q * np.array([self.faction_m[f] for f in factions.tolist()])
                ws = s if weights is None else w * s
                lam = self.spec.kappa * scale2
                cells = fvals["fclass"].tolist()
                code_of = {cell: i for i, cell in enumerate(sorted(set(cells)))}
                code = np.array([code_of[cell] for cell in cells])
                numerator = np.bincount(code, weights=target * ws, minlength=len(code_of))
                denominator = np.bincount(code, weights=s * ws, minlength=len(code_of))
                m = np.divide(numerator + lam, denominator + lam, out=np.ones(len(code_of)),
                              where=denominator + lam > 0)
                self.fclass_m = dict(zip(code_of, m.tolist()))
        return self

    def multiplier(self, fvals: dict[str, np.ndarray], size: int) -> np.ndarray:
        M = np.ones(size)
        for var in self.spec.mult:
            M = M * self._factor(var, fvals[var])
        return M

    def parts(self, X: np.ndarray, inv: np.ndarray, g: np.ndarray, fvals: dict[str, np.ndarray],
              factions: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """(scaled per-size part M·m_f·g·(b0 + β·f(x)), constant per-size part c/size)."""
        scaled = self.multiplier(fvals, len(X)) * g * (self.b0 + X @ self.beta)
        if self.spec.faction:
            scaled = scaled * np.array([self.faction_m.get(f, 1.0) for f in factions])
            if self.spec.fclass == "residual":
                scaled = scaled * np.array([self.fclass_m.get(c, 1.0) for c in fvals["fclass"].tolist()])
        return scaled, self.c * inv

    def predict(self, X, inv, g, fvals, factions) -> np.ndarray:
        scaled, const = self.parts(X, inv, g, fvals, factions)
        return scaled + const

    def unseen(self, fvals: dict[str, np.ndarray], factions: np.ndarray) -> int:
        """Test rows predicted with a fallback multiplier of 1 (level/faction not in
        training). An unseen faction × class cell counts too, although it falls
        back to its faction's factor rather than to 1."""
        bad = np.zeros(len(factions), bool)
        for var in self.spec.mult:
            if var in MULT_CATEGORICAL:
                bad |= np.array([v not in self.levels[var] for v in fvals[var].tolist()])
        if self.spec.faction:
            bad |= np.array([f not in self.faction_m for f in factions])
            if self.spec.fclass == "residual":
                bad |= np.array([c not in self.fclass_m for c in fvals["fclass"].tolist()])
        return int(bad.sum())

    def n_params(self, X: np.ndarray) -> int:
        """Free coefficients; ridge-shrunk grouping levels and residual faction ×
        class cells count in full (an upper bound on their effective number); the
        plain faction modifier is not counted, as before."""
        count = 1 + X.shape[1] + (1 if self.spec.const else 0)
        for var in self.spec.mult:
            if var in GROUPING:
                count += len(self.levels[var])
            else:
                count += len(self.levels[var]) - 1 if var in CATEGORICAL else 1
        if self.spec.fclass == "residual":
            count += len(self.fclass_m)
        return count


def metrics(cost: np.ndarray, pred: np.ndarray, size: np.ndarray | None = None,
            mape_mask: np.ndarray | None = None) -> dict[str, float]:
    error = cost - pred
    sst = float(((cost - cost.mean()) ** 2).sum())
    mask = np.ones(len(cost), bool) if mape_mask is None else mape_mask
    ape = np.abs(error[mask]) / cost[mask]
    out = {
        "r2": 1 - float((error ** 2).sum()) / sst if sst else float("nan"),
        "mae": float(np.abs(error).mean()),
        "mape": float(ape.mean() * 100) if mask.any() else float("nan"),
        "medape": float(np.median(ape) * 100) if mask.any() else float("nan"),
    }
    if size is not None:
        per, per_pred = cost / size, pred / size
        sst_pm = float(((per - per.mean()) ** 2).sum())
        out["r2_pm"] = 1 - float(((per - per_pred) ** 2).sum()) / sst_pm
    return out
