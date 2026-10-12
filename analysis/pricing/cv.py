"""Cross-validation: CVRun, per-slice data, size-frequency weights, fit_on / predict_total, cv_spec,
and the arm × side slices with their fold plans.

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field, replace
from typing import Callable, Sequence

import numpy as np

from common import SIZE_WEIGHT_BANDS
from pricing import config
from pricing.pickling import pickled_as_unit_pricing
from pricing.constants import CATEGORICAL, GROUPING, MIN_STRATUM_GROUPS, MULT_CATEGORICAL, REF_RATING
from pricing.data import Unit
from pricing.spec import Spec
from pricing.design import Design, build_design, design_for, factor_values
from pricing.model import PriceModel, metrics
from pricing.splits import Fold, SplitPlan, group_ids, search_splits


# --- Cross-validation ---------------------------------------------------------

@pickled_as_unit_pricing
@dataclass
class CVRun:
    label: str
    fold_metrics: list[dict[str, float]]
    oof: np.ndarray
    oof_fold: np.ndarray
    spec: Spec | None = None
    full: PriceModel | None = None
    names: list[str] = field(default_factory=list)
    references: dict[str, str] = field(default_factory=dict)
    aliases: list[str] = field(default_factory=list)
    params: int = 0
    fallbacks: int = 0      # test rows predicted with a fallback multiplier of 1

    def coef(self, name: str) -> float:
        return float(self.full.beta[self.names.index(name)]) if name in self.names else float("nan")

    def mean(self, metric: str) -> float:
        return float(np.mean([m[metric] for m in self.fold_metrics]))

    def sd(self, metric: str) -> float:
        return float(np.std([m[metric] for m in self.fold_metrics], ddof=1))

    def se(self, metric: str) -> float:
        return self.sd(metric) / np.sqrt(len(self.fold_metrics))

    def fold1(self, metric: str) -> float:
        return self.fold_metrics[0][metric]


@dataclass
class SliceData:
    n: np.ndarray        # models
    size: np.ndarray     # models or guns — the multiplied size
    cost: np.ndarray
    y: np.ndarray        # cost / size
    inv: np.ndarray      # 1 / size
    g: np.ndarray        # size^(p − 1)
    factions: np.ndarray
    fvals: dict[str, np.ndarray]
    w: np.ndarray | None = None   # size-frequency row weights (size_weighting setting), None = unweighted


def size_of(u: Unit, kind: str) -> float:
    return u.guns if kind == "guns" else u.n


def slice_data(units: Sequence[Unit], kind: str = "n", p: float = 1.0) -> SliceData:
    n = np.array([u.n for u in units])
    size = np.array([size_of(u, kind) for u in units])
    cost = np.array([u.cost for u in units], float)
    return SliceData(n, size, cost, cost / size, 1 / size, size ** (p - 1), np.array([u.faction for u in units]),
                     {var: factor_values(units, var)
                      for var in ("rating", "training", "drill", "side", "rank_depth", "size", "uclass") + GROUPING})


def data_for(spec: Spec, units: Sequence[Unit]) -> SliceData:
    d = slice_data(units, spec.size, spec.p)
    if spec.fixed_rating:
        # Rating as a fixed divisor: price ∝ REF_RATING / rating, folded into g so
        # it scales the β part (c stays outside, like every multiplier).
        d = replace(d, g=d.g * REF_RATING / d.fvals["rating"].astype(float))
    if config.settings.size_weighting is not None:
        d = replace(d, w=size_weights(d.size, spec.size, config.settings.size_weighting)[0])
    return d


# --- size-frequency weighting (experiments/ (analysis branch) size_weighting.py; analysis/SIZE_WEIGHTING_PLAN.md) ----------------
# The fits are dominated by the commonest sizes (e.g. 2 005 AC infantry units of 100–140 models against 13
# of 240+). With the size_weighting setting on, each row's squared error is multiplied by the inverse
# frequency of its size band (common.SIZE_WEIGHT_BANDS) within the slice (one arm), (median band count /
# band count)^alpha, capped at `cap` (None = no cap); bands under `min_band` units merge into the neighbour towards the commonest band. The weights
# multiply the per-size loss PriceModel already minimises (total-price LS × 1/size²); counts come from the
# whole slice (sizes are features, no target leakage); fit_on normalises them to mean 1 on its rows (ridge
# κ is scale-free, so that is only cosmetic). None (the default) leaves every fit exactly as before.


def size_band_labels(kind: str) -> list[str]:
    edges = SIZE_WEIGHT_BANDS[kind]
    return [f"0-{edges[0]}"] + [f"{a}-{b}" for a, b in zip(edges, edges[1:])] + [f"{edges[-1]}+"]


def size_weights(size: np.ndarray, kind: str, setting: dict) -> tuple[np.ndarray, list[dict]]:
    """Row weights for one slice and the per-band table (label, units, weight, share of total weight).
    Band = [lo, hi) on SIZE_WEIGHT_BANDS[kind] (as ac_pricing.band_of)."""
    labels = size_band_labels(kind)
    band = np.searchsorted(np.array(SIZE_WEIGHT_BANDS[kind]), size, side="right")
    groups = [[i] for i in range(len(labels))]               # band indices merged into each group
    counts = lambda: [int(sum((band == b).sum() for b in g)) for g in groups]
    min_band = int(setting.get("min_band", 1))
    while True:
        c = counts()
        live = [i for i, x in enumerate(c) if x > 0]
        small = [i for i in live if c[i] < min_band]
        if not small or len(live) <= 1:
            break
        i = small[0]
        top = int(np.argmax(c))
        step = 1 if top > i else -1
        j = i + step
        while c[j] == 0 and 0 <= j + step < len(groups):
            j += step
        groups[j] = sorted(groups[j] + groups[i])
        groups[i] = []
    c = np.array(counts(), float)
    ref = float(np.median(c[c > 0]))
    weight_of = np.zeros(len(groups))
    for gi, x in enumerate(c):
        if x > 0:
            weight_of[gi] = (ref / x) ** float(setting["alpha"])
    if setting.get("cap") is not None:
        weight_of = np.minimum(weight_of, float(setting["cap"]))
    group_of_band = {b: gi for gi, g in enumerate(groups) for b in g}
    w = np.array([weight_of[group_of_band[b]] for b in band])
    total = w.sum()
    table = [{"band": "+".join(labels[b] for b in g), "units": int(c[gi]), "weight": float(weight_of[gi]),
              "weight_share": float(weight_of[gi] * c[gi] / total)}
             for gi, g in enumerate(groups) if g and c[gi] > 0]
    return w, table


def kish_ess(w: np.ndarray) -> float:
    """Kish effective sample size of a weighted fit."""
    return float(w.sum() ** 2 / (w ** 2).sum())


def sub(fvals: dict[str, np.ndarray], index: np.ndarray) -> dict[str, np.ndarray]:
    return {k: v[index] for k, v in fvals.items()}


IRLS_STEPS = 10          # loss = "lad": reweighted least-squares passes
IRLS_FLOOR = 1.0         # gold; |residual| floor in the IRLS weights


def fit_on(spec: Spec, design: Design, d: SliceData, rows: np.ndarray) -> PriceModel:
    args = (design.X[rows], d.y[rows], d.inv[rows], d.g[rows], sub(d.fvals, rows), d.factions[rows])
    sw = None if d.w is None else d.w[rows] / d.w[rows].mean()     # size-frequency weights (size_weighting setting)
    model = PriceModel(spec).fit(*args, weights=sw)
    if spec.loss == "lad":
        # Least absolute deviation on total price, Σ size·|y − ŷ|, by IRLS on the
        # per-size objective: w = size / |y − ŷ| = size² / |total residual|.
        size = d.size[rows]
        X, y, inv, g, fvals, factions = args
        for _ in range(IRLS_STEPS):
            resid = size * np.abs(y - model.predict(X, inv, g, fvals, factions))
            irls = size ** 2 / np.maximum(resid, IRLS_FLOOR)
            model = PriceModel(spec).fit(*args, weights=irls if sw is None else irls * sw)
    return model


def predict_total(model: PriceModel, design: Design, d: SliceData, rows: np.ndarray) -> np.ndarray:
    return d.size[rows] * model.predict(design.X[rows], d.inv[rows], d.g[rows], sub(d.fvals, rows), d.factions[rows])


def cv_spec(spec: Spec, units: Sequence[Unit], folds: list[Fold], arm: str, *,
            full_fit: bool = True, label: str | None = None, design: Design | None = None,
            data: SliceData | None = None) -> CVRun:
    design = design or design_for(spec, units, arm)
    d = data or data_for(spec, units)
    # Rows pinned to train never get an out-of-fold prediction: they stay NaN.
    oof = np.full(len(units), np.nan)
    oof_fold = np.zeros(len(units), int)
    fold_metrics, fallbacks = [], 0
    for k, (train, test) in enumerate(folds):
        model = fit_on(spec, design, d, train)
        pred = predict_total(model, design, d, test)
        fallbacks += model.unseen(sub(d.fvals, test), d.factions[test])
        oof[test], oof_fold[test] = pred, k + 1
        fold_metrics.append(metrics(d.cost[test], pred, d.size[test]))
    full = fit_on(spec, design, d, np.arange(len(units))) if full_fit else None
    params = full.n_params(design.X) if full else (
        1 + design.X.shape[1] + int(spec.const) +
        sum(len(set(d.fvals[v].tolist())) - (v in CATEGORICAL) if v in MULT_CATEGORICAL else 1 for v in spec.mult))
    return CVRun(label or spec.describe(), fold_metrics, oof, oof_fold, spec, full,
                 design.names, design.references, design.aliases, params, fallbacks)


def cv_baseline(units: Sequence[Unit], folds: list[Fold]) -> CVRun:
    """Mean price per model of the unit's class (from the training fold) × n."""
    d = slice_data(units)
    classes = np.array([u.unit_class for u in units])
    oof = np.full(len(units), np.nan)
    oof_fold = np.zeros(len(units), int)
    fold_metrics = []
    for k, (train, test) in enumerate(folds):
        means = {c: d.y[train][classes[train] == c].mean() for c in set(classes[train].tolist())}
        fallback = d.y[train].mean()
        pred = d.n[test] * np.array([means.get(c, fallback) for c in classes[test]])
        oof[test], oof_fold[test] = pred, k + 1
        fold_metrics.append(metrics(d.cost[test], pred, d.n[test]))
    return CVRun("baseline (class mean × n)", fold_metrics, oof, oof_fold)


# --- Slices -------------------------------------------------------------------

@pickled_as_unit_pricing
@dataclass
class Slice:
    arm: str
    side: str
    units: list[Unit]
    plan: SplitPlan
    groups: np.ndarray
    runs: dict[str, CVRun] = field(default_factory=dict)
    coverage: dict[str, tuple[int, int, int]] = field(default_factory=dict)


def strata_for(units: Sequence[Unit], groups: np.ndarray) -> np.ndarray:
    cell = [f"{u.unit_class}|{u.speed}" for u in units]
    groups_per_cell: dict[str, set[int]] = defaultdict(set)
    for c, g in zip(cell, groups.tolist()):
        groups_per_cell[c].add(g)
    return np.array([
        c if len(groups_per_cell[c]) >= MIN_STRATUM_GROUPS else u.unit_class
        for c, u in zip(cell, units)
    ])


def coverage_report(units: Sequence[Unit], folds: list[Fold], arm: str) -> dict[str, tuple[int, int, int]]:
    """family -> (levels in both sets in fold 1, min over folds, total levels)."""
    families: dict[str, Callable[[Unit], object]] = {
        "unit_class": lambda u: u.unit_class,
        "speed": lambda u: u.speed,
        "training": lambda u: u.training,
        "rating": lambda u: u.rating,
    }
    if arm == "infantry":
        families["drill"] = lambda u: u.drill
    if arm == "artillery":
        families["shot"] = lambda u: u.shot
    out = {}
    for family, getter in families.items():
        levels = np.array([getter(u) for u in units])
        total = len(set(levels.tolist()))
        both = [len(set(levels[tr].tolist()) & set(levels[te].tolist())) for tr, te in folds]
        out[family] = (both[0], min(both), total)
    return out


def rich_design(units: Sequence[Unit], arm: str) -> Design:
    """Every column any variant can use. Coverage is checked on these, so every
    variant (a subset of them) inherits the guarantee."""
    return build_design(units, arm, linear=frozenset(CATEGORICAL) | {"rank_depth"},
                        extras=frozenset({"pike_square", "firearm", "damage", "proj_reload"}), const_inside=True)


def make_slice(arm: str, side: str, units: list[Unit], n_seeds: int,
               extra_pinned: Callable[[np.ndarray], set[int]] | None = None) -> Slice:
    """`extra_pinned(groups)` returns further group ids to pin to train."""
    rich = rich_design(units, arm)
    groups = group_ids(rich.X, [u.n for u in units])
    strata = strata_for(units, groups)
    balance = np.array([u.faction for u in units])
    plan = search_splits(rich.X, rich.names, strata, balance, groups, n_seeds,
                         extra_pinned(groups) if extra_pinned else None)
    sl = Slice(arm, side, units, plan, groups)
    sl.coverage = coverage_report(units, plan.folds, arm)
    return sl


def slice_units(units: Sequence[Unit], arm: str, side: str, exclude: frozenset[str] = frozenset()) -> list[Unit]:
    return [u for u in units if u.arm == arm and (side == "merged" or u.side == side) and u.faction not in exclude]


def side_spec(spec: Spec) -> Spec:
    """A merged-slice structure for a side slice: side is constant there."""
    return replace(spec, linear=spec.linear - {"side"}, mult=spec.mult - {"side"})


# The previous run's final structures (size = models, p = 1, linear stats) and
# their merged-slice CV MAE — the generalised fitter must reproduce these.
PREVIOUS_FINAL = {
    "infantry": (Spec(mult=frozenset({"rating", "side"}), const=True), 38.4983),
    "cavalry": (Spec(mult=frozenset({"rank_depth", "rating"})), 60.5637),
    "artillery": (Spec(linear=frozenset({"rating"}), const=True), 74.5768),
}


def full_fit_prices(run: CVRun, units: Sequence[Unit], arm: str) -> np.ndarray:
    design, d = design_for(run.spec, units, arm), data_for(run.spec, units)
    return predict_total(run.full, design, d, np.arange(len(units)))
