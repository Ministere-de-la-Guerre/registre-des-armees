"""Staff generals: price = b·stars^q·(8/N), its cross-validation and fold plans.

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Sequence

import numpy as np
from sklearn.linear_model import LinearRegression

from pricing.pickling import pickled_as_unit_pricing
from pricing.constants import REF_RATING
from pricing.data import Staff
from pricing.model import metrics
from pricing.splits import Fold, SplitPlan, group_ids, search_splits


# --- Staff generals ------------------------------------------------------------

@pickled_as_unit_pricing
@dataclass
class StaffRun:
    label: str
    fold_metrics: list[dict[str, float]]
    oof: np.ndarray
    fallbacks: int = 0

    def mean(self, metric: str) -> float:
        return float(np.mean([m[metric] for m in self.fold_metrics]))

    def sd(self, metric: str) -> float:
        return float(np.std([m[metric] for m in self.fold_metrics], ddof=1))

    def fold1(self, metric: str) -> float:
        return self.fold_metrics[0][metric]


def staff_rating_design(stars: np.ndarray, d: np.ndarray, form: str) -> np.ndarray:
    """cost − 1 as a no-intercept linear model; d = rating − 8.
    T1: rating shifts the price per star.  T2: rating scales both the per-star
    and the per-star² price (= (1 + δd)(b·s + q·s²) with free coefficients)."""
    if form == "T1":
        return np.column_stack([stars, d * stars, stars ** 2])
    return np.column_stack([stars, stars ** 2, d * stars, d * stars ** 2])


STAFF_RATING_NAMES = {
    "T1": ["b (per star)", "γ (per star per rating point)", "q (per star²)"],
    "T2": ["b (per star)", "q (per star²)", "γ (per star per rating point)", "κ (per star² per rating point)"],
    "T3": ["b (gold per star^q at rating 8)", "q (star power)"],
}


STAFF_POWER_GRID = np.round(np.arange(0.5, 3.0001, 0.005), 3)


def staff_power_fit(stars: np.ndarray, cost: np.ndarray, rating: np.ndarray) -> tuple[float, float]:
    """T3 (from the blind study): a starred general costs b·stars^q·(REF_RATING / rating),
    one without stars 1 gold. q on a 0.005 grid, b by least squares given q; fitted
    on starred generals only."""
    starred = stars > 0
    s, c, divisor = stars[starred], cost[starred], REF_RATING / rating[starred]
    best = (np.inf, 0.0, 1.0)
    for q in STAFF_POWER_GRID:
        x = s ** q * divisor
        b = float((c * x).sum() / (x * x).sum())
        sse = float(((c - b * x) ** 2).sum())
        if sse < best[0]:
            best = (sse, b, float(q))
    return best[1], best[2]


def staff_power_price(stars: np.ndarray, rating: np.ndarray, b: float, q: float) -> np.ndarray:
    return np.where(stars > 0, b * stars ** q * REF_RATING / rating, 1.0)


def staff_faction_m(cost: np.ndarray, p: np.ndarray, factions: np.ndarray) -> dict[str, float]:
    """Faction modifier on the star part: cost − 1 ≈ m_f × (p − 1)."""
    out = {}
    for faction in set(factions.tolist()):
        mask = factions == faction
        denominator = float(((p[mask] - 1) ** 2).sum())
        if denominator > 0:
            out[faction] = float(((cost[mask] - 1) * (p[mask] - 1)).sum()) / denominator
    return out


def staff_cv(gens: Sequence[Staff], folds: list[Fold]) -> dict[str, StaffRun]:
    stars = np.array([g.stars for g in gens], float)
    cost = np.array([g.cost for g in gens], float)
    factions = np.array([g.faction for g in gens])
    d = np.array([g.rating - REF_RATING for g in gens], float)
    starred = stars > 0

    def run(label: str, predict: Callable[[np.ndarray, np.ndarray], tuple[np.ndarray, int]]) -> StaffRun:
        oof = np.full(len(gens), np.nan)
        fold_metrics, fallbacks = [], 0
        for train, test in folds:
            pred, fb = predict(train, test)
            oof[test] = pred
            fallbacks += fb
            # MAPE over starred generals only: a 1-gold miss on a 1-gold general reads as 100%.
            fold_metrics.append(metrics(cost[test], pred, mape_mask=starred[test]))
        return StaffRun(label, fold_metrics, oof, fallbacks)

    def s1(train, test):
        model = LinearRegression().fit(stars[train, None], cost[train])
        return model.predict(stars[test, None]), 0

    def s2_quadratic(train, test):
        design = lambda index: np.column_stack([stars[index], stars[index] ** 2])
        coef, *_ = np.linalg.lstsq(design(train), cost[train] - 1, rcond=None)
        return 1 + design(test) @ coef, 0

    def s3_quadratic(train, test):
        levels = sorted(set(factions[train].tolist()))
        def design(index):
            return np.column_stack([stars[index] * (factions[index] == f) for f in levels] + [stars[index] ** 2])
        coef, *_ = np.linalg.lstsq(design(train), cost[train] - 1, rcond=None)
        return 1 + design(test) @ coef, 0

    def rating_model(form: str, with_faction: bool):
        def predict(train, test):
            X = staff_rating_design(stars, d, form)
            coef, *_ = np.linalg.lstsq(X[train], cost[train] - 1, rcond=None)
            p = 1 + X @ coef
            if not with_faction:
                return p[test], 0
            m = staff_faction_m(cost[train], p[train], factions[train])
            fb = int(sum(1 for i in test if factions[i] not in m and stars[i] > 0))
            return 1 + np.array([m.get(factions[i], 1.0) for i in test]) * (p[test] - 1), fb
        return predict

    rating = np.array([g.rating for g in gens], float)

    def power_rule(with_faction: bool):
        def predict(train, test):
            b, q = staff_power_fit(stars[train], cost[train], rating[train])
            p = staff_power_price(stars, rating, b, q)
            if not with_faction:
                return p[test], 0
            m = staff_faction_m(cost[train], p[train], factions[train])
            fb = int(sum(1 for i in test if factions[i] not in m and stars[i] > 0))
            return 1 + np.array([m.get(factions[i], 1.0) for i in test]) * (p[test] - 1), fb
        return predict

    return {
        "S1": run("S1: a + b·stars (free constant)", s1),
        "S2q": run("S2q: 1 + b·stars + q·stars² (no rating/faction)", s2_quadratic),
        "S3q": run("S3q: 1 + b_f·stars + q·stars² (faction, no rating)", s3_quadratic),
        "T1": run("T1: 1 + (b + γ·(r−8))·stars + q·stars²", rating_model("T1", False)),
        "T2": run("T2: 1 + (1 + δ·(r−8))·(b·stars + q·stars²), free", rating_model("T2", False)),
        "TF1": run("TF1: T1 + faction modifier", rating_model("T1", True)),
        "TF2": run("TF2: T2 + faction modifier", rating_model("T2", True)),
        "T3": run(f"T3: b·stars^q·({REF_RATING}/r), 1 without stars", power_rule(False)),
        "TF3": run("TF3: T3 + faction modifier", power_rule(True)),
    }


def staff_full(gens: Sequence[Staff], form: str) -> tuple[np.ndarray, np.ndarray, dict[str, float]]:
    stars = np.array([g.stars for g in gens], float)
    cost = np.array([g.cost for g in gens], float)
    factions = np.array([g.faction for g in gens])
    if form == "T3":
        rating = np.array([g.rating for g in gens], float)
        b, q = staff_power_fit(stars, cost, rating)
        p = staff_power_price(stars, rating, b, q)
        return np.array([b, q]), p, staff_faction_m(cost, p, factions)
    d = np.array([g.rating - REF_RATING for g in gens], float)
    X = staff_rating_design(stars, d, form)
    coef, *_ = np.linalg.lstsq(X, cost - 1, rcond=None)
    p = 1 + X @ coef
    return coef, p, staff_faction_m(cost, p, factions)


@pickled_as_unit_pricing
@dataclass
class StaffSlice:
    side: str
    gens: list[Staff]
    plan: SplitPlan
    runs: dict[str, StaffRun]


def staff_coverage(gens: Sequence[Staff]) -> tuple[np.ndarray, list[str]]:
    factions = sorted({g.faction for g in gens})
    star_levels = sorted({g.stars for g in gens})
    C = np.column_stack(
        [[1.0 if g.faction == f else 0.0 for g in gens] for f in factions]
        + [[1.0 if g.stars == s else 0.0 for g in gens] for s in star_levels]
    )
    return C, [f"faction={f}" for f in factions] + [f"stars={s}" for s in star_levels]


def make_staff_slice(side: str, gens: list[Staff], n_seeds: int) -> StaffSlice:
    C, names = staff_coverage(gens)
    groups = group_ids(C, [0] * len(gens))
    strata = np.array([g.faction for g in gens])
    balance = np.array([str(g.stars) for g in gens])
    plan = search_splits(C, names, strata, balance, groups, n_seeds)
    return StaffSlice(side, gens, plan, staff_cv(gens, plan.folds))
