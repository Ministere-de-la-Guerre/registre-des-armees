"""Faction modifiers: the faction modifier shared across arms, and the faction × unit-class
multiplier with its nested ridge κ (from the blind study).

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from typing import Callable, Sequence

import numpy as np

from common import ARMS
from pricing.pickling import pickled_as_unit_pricing
from pricing.constants import N_SPLITS, REF_RATING
from pricing.data import Unit
from pricing.spec import Spec
from pricing.design import Design, design_for
from pricing.model import PriceModel, metrics
from pricing.splits import Fold
from pricing.cv import CVRun, Slice, cv_spec, data_for, fit_on, predict_total, side_spec, sub


# --- Faction modifier shared across arms --------------------------------------

def shared_modifier(blocks: Sequence[tuple[np.ndarray, np.ndarray, np.ndarray]]) -> dict[str, float]:
    """One multiplier per faction across every arm, on the scaled part of the
    price: m_f = Σ (cost − c)·s / Σ s² over (factions, cost − c, s) blocks in
    total price. Total-price least squares weights units by their price, so a
    near-zero prediction can't dominate."""
    num: dict[str, float] = defaultdict(float)
    den: dict[str, float] = defaultdict(float)
    for factions, target, scaled in blocks:
        for f, t, s in zip(factions.tolist(), target.tolist(), scaled.tolist()):
            num[f] += t * s
            den[f] += s * s
    return {f: num[f] / den[f] for f in den if den[f] > 0}


def shared_faction_runs(slices: dict[tuple[str, str], Slice], side: str,
                        final: dict[str, Spec]) -> tuple[dict[str, CVRun], dict[str, float]]:
    """Final model × one faction modifier shared by all three arms. Fold k of
    each arm holds disjoint units, so pooling the training rows of fold k across
    arms leaks nothing into any arm's fold-k test rows."""
    per_arm = {}
    for arm in ARMS:
        sl = slices[(arm, side)]
        spec = final[arm] if side == "merged" else side_spec(final[arm])
        design, d = design_for(spec, sl.units, arm), data_for(spec, sl.units)

        def parts(model, rows):
            s, c = model.parts(design.X[rows], d.inv[rows], d.g[rows], sub(d.fvals, rows), d.factions[rows])
            return d.size[rows] * s, d.size[rows] * c       # total price: scaled part, flat c

        fits = []
        for train, test in sl.plan.folds:
            model = fit_on(spec, design, d, train)
            fits.append((train, test, *parts(model, train), *parts(model, test)))
        full = fit_on(spec, design, d, np.arange(len(sl.units)))
        per_arm[arm] = (d, fits, parts(full, np.arange(len(sl.units))))
    oof = {arm: np.full(len(slices[(arm, side)].units), np.nan) for arm in ARMS}
    oof_fold = {arm: np.zeros(len(slices[(arm, side)].units), int) for arm in ARMS}
    fold_metrics: dict[str, list] = {arm: [] for arm in ARMS}
    fallbacks = Counter()
    for k in range(N_SPLITS):
        blocks = []
        for arm in ARMS:
            d, fits, _ = per_arm[arm]
            train, _, s_tr, c_tr, _, _ = fits[k]
            blocks.append((d.factions[train], d.cost[train] - c_tr, s_tr))
        m = shared_modifier(blocks)
        for arm in ARMS:
            d, fits, _ = per_arm[arm]
            _, test, _, _, s_te, c_te = fits[k]
            factor = np.array([m.get(f, 1.0) for f in d.factions[test]])
            pred = s_te * factor + c_te
            fallbacks[arm] += int(sum(f not in m for f in d.factions[test]))
            oof[arm][test], oof_fold[arm][test] = pred, k + 1
            fold_metrics[arm].append(metrics(d.cost[test], pred, d.size[test]))
    full_m = shared_modifier([(per_arm[arm][0].factions, per_arm[arm][0].cost - per_arm[arm][2][1], per_arm[arm][2][0])
                              for arm in ARMS])
    runs = {arm: CVRun("final × shared faction modifier", fold_metrics[arm], oof[arm], oof_fold[arm],
                       fallbacks=fallbacks[arm]) for arm in ARMS}
    return runs, full_m


# --- Faction × unit-class modifier (from the blind study) ---------------------
#
# NTW3 prices look hand-set per corps per unit class (blind study, branch
# blind-pricing-study; tested here by analysis/blind_ideas.py). Two forms:
#   RFC  residual: the final model × per-arm faction modifier × a faction × class
#        cell, shrunk towards 1 (i.e. towards the faction modifier);
#   JFC  joint: a faction × class multiplier inside the ALS fit around the fixed
#        divisor REF_RATING / rating, so stat coefficients are fitted net of it.
# The ridge strength κ is chosen by inner CV inside each outer training fold.

FCLASS_GRID = {"RFC": (0.0, 0.5, 1.0, 3.0, 10.0, 30.0), "JFC": (0.5, 1.0, 3.0, 10.0, 30.0)}
FCLASS_LABEL = {"RFC": "residual faction × class", "JFC": f"joint faction × class around {REF_RATING}/N"}
# Adopted by analysis/blind_ideas.py (see blind_ideas_report.md): (variant, loss).
FCLASS_FORM: tuple[str, str] | None = ("JFC", "ls")


def residual_fclass_spec(spec: Spec, kappa: float) -> Spec:
    return replace(spec, faction=True, fclass="residual", kappa=kappa)


def joint_fclass_spec(spec: Spec, kappa: float) -> Spec:
    return replace(spec, mult=(spec.mult - {"rating"}) | {"fclass"}, fixed_rating=True, kappa=kappa)


FCLASS_MAKERS: dict[str, Callable[[Spec, float], Spec]] = {"RFC": residual_fclass_spec, "JFC": joint_fclass_spec}


def fold_run(label: str, specs: Sequence[Spec], full_spec: Spec, units: Sequence[Unit], folds: list[Fold],
             arm: str, design: Design) -> CVRun:
    """CV with one spec per outer fold (e.g. κ chosen per fold), plus a full-data fit."""
    oof = np.full(len(units), np.nan)
    oof_fold = np.zeros(len(units), int)
    fold_metrics, fallbacks = [], 0
    for k, ((train, test), spec) in enumerate(zip(folds, specs)):
        d = data_for(spec, units)
        model = fit_on(spec, design, d, train)
        pred = predict_total(model, design, d, test)
        fallbacks += model.unseen(sub(d.fvals, test), d.factions[test])
        oof[test], oof_fold[test] = pred, k + 1
        fold_metrics.append(metrics(d.cost[test], pred, d.size[test]))
    d = data_for(full_spec, units)
    full = fit_on(full_spec, design, d, np.arange(len(units)))
    return CVRun(label, fold_metrics, oof, oof_fold, full_spec, full, design.names, design.references,
                 design.aliases, full.n_params(design.X), fallbacks)


def inner_kappa(make: Callable[[Spec, float], Spec], base: Spec, grid: Sequence[float], units: Sequence[Unit],
                folds: list[Fold], arm: str, design: Design, k: int) -> float:
    """κ with the lowest pooled MAE over inner folds = the other outer folds' test
    sets, each fitted on the rest of outer fold k's training rows."""
    train = folds[k][0]
    best = (np.inf, grid[0])
    for kappa in grid:
        spec = make(base, kappa)
        d = data_for(spec, units)
        errors = []
        for j, (_, inner_test) in enumerate(folds):
            if j == k:
                continue
            model = fit_on(spec, design, d, np.setdiff1d(train, inner_test))
            errors.append(np.abs(predict_total(model, design, d, inner_test) - d.cost[inner_test]))
        score = float(np.concatenate(errors).mean())
        if score < best[0] - 1e-12:
            best = (score, kappa)
    return best[1]


@pickled_as_unit_pricing
@dataclass
class FclassResult:
    run: CVRun                                   # nested: κ chosen per outer fold
    kappas: list[float]                          # κ per outer fold
    grid: list[tuple[float, CVRun]]              # non-nested CV per κ (full fit uses the best)
    full_kappa: float


def fclass_cv(variant: str, base: Spec, units: Sequence[Unit], folds: list[Fold], arm: str,
              design: Design | None = None, kappas: Sequence[float] | None = None,
              grid: Sequence[float] | None = None) -> FclassResult:
    """Faction × class variant with nested κ. `kappas` reuses per-fold κ (e.g. LAD
    on the least-squares choice) instead of re-selecting them; `grid` replaces the
    variant's κ grid (FCLASS_GRID) for this call only."""
    make = FCLASS_MAKERS[variant]
    grid = FCLASS_GRID[variant] if grid is None else tuple(grid)
    design = design or design_for(base, units, arm)
    grid_runs = []
    for kappa in grid:
        spec = make(base, kappa)
        grid_runs.append((kappa, cv_spec(spec, units, folds, arm, label=f"{variant} κ={kappa:g}", design=design,
                                         data=data_for(spec, units), full_fit=False)))
    full_kappa = min(grid_runs, key=lambda t: t[1].mean("mae"))[0]
    chosen = list(kappas) if kappas is not None else [
        inner_kappa(make, base, grid, units, folds, arm, design, k) for k in range(len(folds))]
    label = FCLASS_LABEL[variant] + (", LAD" if base.loss == "lad" else "")
    run = fold_run(label, [make(base, kappa) for kappa in chosen], make(base, full_kappa), units, folds, arm, design)
    return FclassResult(run, chosen, grid_runs, full_kappa)


def fclass_multiplier(model: PriceModel, u: Unit) -> float:
    """A unit's army multiplier relative to the plain REF_RATING / rating rule:
    1 = priced as the rating alone predicts."""
    cell = f"{u.faction}|{u.unit_class}"
    if model.spec.fclass == "residual":
        m = model.faction_m.get(u.faction, 1.0) * model.fclass_m.get(cell, 1.0)
        if "rating" in model.spec.mult:
            m *= model.levels["rating"].get(u.rating, 1.0) / (REF_RATING / u.rating)
        return m
    return model.levels["fclass"].get(cell, 1.0)
