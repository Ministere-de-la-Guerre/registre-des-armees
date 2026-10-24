"""Model search: the size power profile, the structure search, the nested stat-power descent and
its fine refinement, and the firearm / calibre shape variants.

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

import itertools
from dataclasses import dataclass, replace
from typing import Callable, Sequence

import numpy as np

from pricing import config
from pricing.constants import (
    CANDIDATES, FINE_P_HALF, FINE_P_STEP, FINE_STAT_HALF, FINE_STAT_STEP, MAX_RECENTRE, MIN_POWER, POWER_SCALE,
    P_WINDOW)
from pricing.data import Unit
from pricing.spec import Spec, with_powers
from pricing.design import Design, build_design, design_for
from pricing.model import PriceModel, metrics
from pricing.splits import unidentified
from pricing.cv import CVRun, Slice, SliceData, cv_spec, data_for, fit_on, predict_total, slice_data
from pricing.pool import parallel_map


# --- Size power profile -------------------------------------------------------

@dataclass
class Profile:
    arm: str
    curves: dict[tuple[str, bool], list[tuple[float, float, float]]]   # (size, const) -> [(p, mae, se)]
    best_size: str
    best_p: float
    best_const: bool
    best_mae: float


def profile_p(spec: Spec, sl: Slice, kinds: Sequence[str], consts: Sequence[bool],
              grid: Sequence[float] | None = None) -> Profile:
    grid = config.settings.p_grid if grid is None else grid
    design = design_for(spec, sl.units, sl.arm)
    curves: dict[tuple[str, bool], list] = {}
    best = None
    for kind in kinds:
        for const in consts:
            curve = []
            for p in grid:
                variant = replace(spec, size=kind, const=const, p=p)
                run = cv_spec(variant, sl.units, sl.plan.folds, sl.arm, full_fit=False, design=design,
                              data=slice_data(sl.units, kind, p))
                curve.append((p, run.mean("mae"), run.se("mae")))
                if best is None or run.mean("mae") < best[0]:
                    best = (run.mean("mae"), kind, p, const)
            curves[(kind, const)] = curve
    return Profile(sl.arm, curves, best[1], best[2], best[3], best[0])


# --- Structure search ---------------------------------------------------------

@dataclass
class SearchResult:
    arm: str
    runs: list[CVRun]                      # every structure, merged slice
    best: CVRun
    headline: CVRun                        # simplest within 1 SE of best
    placement: dict[str, dict[str, float]]  # var -> placement -> best MAE


def enumerate_specs(arm: str, side: str, kind: str, p: float) -> list[Spec]:
    candidates = [v for v in CANDIDATES[arm] if side == "merged" or v != "side"]
    specs = []
    for placement in itertools.product(("out", "linear", "mult"), repeat=len(candidates)):
        linear = frozenset(v for v, w in zip(candidates, placement) if w == "linear")
        mult = frozenset(v for v, w in zip(candidates, placement) if w == "mult")
        for const in (False, True):
            specs.append(Spec(linear=linear, mult=mult, const=const, size=kind, p=p))
    return specs


def structure_search(sl: Slice, kind: str, p: float) -> SearchResult:
    data = slice_data(sl.units, kind, p)
    designs: dict[frozenset, Design] = {}
    runs = []
    for spec in enumerate_specs(sl.arm, sl.side, kind, p):
        design = designs.setdefault(spec.linear, design_for(spec, sl.units, sl.arm))
        runs.append(cv_spec(spec, sl.units, sl.plan.folds, sl.arm, full_fit=False, design=design, data=data))
    runs.sort(key=lambda r: (r.mean("mae"), r.params))
    best = runs[0]
    threshold = best.mean("mae") + best.se("mae")
    headline = min((r for r in runs if r.mean("mae") <= threshold), key=lambda r: (r.params, r.mean("mae")))
    placement: dict[str, dict[str, float]] = {}
    for var in CANDIDATES[sl.arm]:
        placement[var] = {}
        for where in ("out", "linear", "mult"):
            pool = [r for r in runs if (var in r.spec.linear) == (where == "linear")
                    and (var in r.spec.mult) == (where == "mult")]
            placement[var][where] = min(r.mean("mae") for r in pool) if pool else float("nan")
    return SearchResult(sl.arm, runs, best, headline, placement)


# --- Stat powers (nested coordinate descent) ----------------------------------

def descend_powers(spec: Spec, units: Sequence[Unit], arm: str, rows: np.ndarray) -> tuple[dict[str, float], float, int]:
    """Coordinate descent on the training SSE (per-size space, the model's own
    objective) over one power per numeric stat and the size power p.

    Each exponent (the design's power keys: additive stats, shooting-product
    factors, the calibre column) is tried on the power grid with the others held —
    the gun fire-rate exponent also on 0, meaning "the gun's reload time doesn't
    matter" — then p on a 0.05 grid within ±P_WINDOW of the current p; up to
    max_passes passes, stopping when a full pass changes nothing.
    Returns (powers, p, passes used)."""
    stats = design_for(spec, units, arm).power_keys
    powers = {s: spec.power_of(s) for s in stats}
    p = spec.p
    designs: dict[tuple, Design] = {}
    datas: dict[float, SliceData] = {}

    def sse(trial: dict[str, float], p_trial: float) -> float:
        key = tuple(sorted(trial.items()))
        design = designs.get(key)
        if design is None:
            design = designs[key] = build_design(units, arm, linear=spec.linear, extras=spec.extras, powers=trial,
                                                 shape=dict(spec.shape))
        d = datas.get(p_trial)
        if d is None:
            d = datas[p_trial] = slice_data(units, spec.size, p_trial)
        return fit_on(replace(spec, p=p_trial), design, d, rows).sse

    current = sse(powers, p)
    for passes in range(1, config.settings.max_passes + 1):
        changed = False
        for s in stats:
            grid = config.settings.power_grid
            for a in ((0.0,) + grid if s == "shoot:rate" else grid):
                if a == powers[s]:
                    continue
                trial = {**powers, s: a}
                value = sse(trial, p)
                if value < current * (1 - 1e-9):
                    powers, current, changed = trial, value, True
        for step in range(-int(round(P_WINDOW / 0.05)), int(round(P_WINDOW / 0.05)) + 1):
            p_trial = round(p + 0.05 * step, 2)
            if p_trial <= 0 or p_trial == p:
                continue
            value = sse(powers, p_trial)
            if value < current * (1 - 1e-9):
                p, current, changed = p_trial, value, True
        if not changed:
            break
    return powers, p, passes


@dataclass
class PowerResult:
    base: CVRun                       # final structure, linear stats
    nested: CVRun                     # coarse powers + p fitted inside each training fold
    fold_powers: list[tuple[dict[str, float], float]]
    full_powers: dict[str, float]
    full_p: float
    kept: bool                        # coarse powers beat linear by > 1 SE
    fine: "FineResult | None" = None


@dataclass
class FineResult:
    nested: CVRun                     # fine powers + p, refined inside each training fold
    fold_powers: list[tuple[dict[str, float], float]]
    full_powers: dict[str, float]
    full_p: float
    profiles: list[dict]              # local CV curves per coordinate
    choice: str                       # "linear" | "coarse" | "fine"


class PowerObjective:
    """Training SSE (per-size space, the model's own objective) for a set of
    stat powers and a size power, with designs and size data cached."""

    def __init__(self, spec: Spec, units: Sequence[Unit], arm: str, rows: np.ndarray):
        self.spec, self.units, self.arm, self.rows = spec, units, arm, rows
        self.designs: dict[tuple, Design] = {}
        self.datas: dict[float, SliceData] = {}
        self.values: dict[tuple, float] = {}

    def __call__(self, powers: dict[str, float], p: float) -> float:
        key = (tuple(sorted((s, round(a, 4)) for s, a in powers.items())), round(p, 4))
        if key in self.values:
            return self.values[key]
        design = self.designs.get(key[0])
        if design is None:
            design = self.designs[key[0]] = build_design(self.units, self.arm, linear=self.spec.linear,
                                                         extras=self.spec.extras, powers=dict(key[0]),
                                                         shape=dict(self.spec.shape))
        d = self.datas.get(key[1])
        if d is None:
            d = self.datas[key[1]] = slice_data(self.units, self.spec.size, key[1])
        value = fit_on(replace(self.spec, p=key[1]), design, d, self.rows).sse
        self.values[key] = value
        return value


def power_floor(key: str) -> float:
    """Smallest exponent tried. The gun fire-rate exponent may reach 0 (its reload
    time then has no effect); other exponents stay positive — a shooting-product
    factor at 0 would turn a zero stat into a 1."""
    return 0.0 if key == "shoot:rate" else MIN_POWER


def line_search(f: Callable[[float], float], center: float, step: float, half: int,
                floor: float) -> tuple[float, float]:
    """Best value of f on center ± half·step (≥ floor), re-centring on the best
    point while it sits on a window edge, up to MAX_RECENTRE times."""
    best = (f(center), center)
    for _ in range(MAX_RECENTRE + 1):
        grid = [round(center + step * k, 4) for k in range(-half, half + 1)]
        grid = [g for g in grid if g >= floor - 1e-12]
        value, point = min((f(g), g) for g in grid)
        if value < best[0]:
            best = (value, point)
        on_edge = point == grid[-1] or (point == grid[0] and grid[0] > floor + 1e-12)
        if not on_edge:
            break
        center = point
    return best[1], best[0]


def refine_powers(spec: Spec, units: Sequence[Unit], arm: str, rows: np.ndarray,
                  powers: dict[str, float], p: float) -> tuple[dict[str, float], float]:
    """Fine coordinate descent from a coarse solution: each stat on a ±0.5 window
    in steps of 0.05, then p on ±0.15 in steps of 0.01, windows re-centred at
    edges; up to fine_passes passes until nothing changes."""
    objective = PowerObjective(spec, units, arm, rows)
    stats = design_for(spec, units, arm).power_keys
    powers = {s: powers.get(s, 1.0) for s in stats}
    current = objective(powers, p)
    for _ in range(config.settings.fine_passes):
        changed = False
        for s in stats:
            a, value = line_search(lambda v: objective({**powers, s: v}, p), powers[s],
                                   FINE_STAT_STEP, FINE_STAT_HALF, power_floor(s))
            if value < current * (1 - 1e-9):
                powers, current, changed = {**powers, s: a}, value, True
        q, value = line_search(lambda v: objective(powers, v), p, FINE_P_STEP, FINE_P_HALF, MIN_POWER)
        if value < current * (1 - 1e-9):
            p, current, changed = q, value, True
        if not changed:
            break
    return powers, p


def local_profiles(spec: Spec, sl: Slice, powers: dict[str, float], p: float) -> list[dict]:
    """Exploratory CV curves: each coordinate varied over its fine window around
    the full-data fine solution (the others held there), plus its linear value
    (power 1 / p = 1). Holding the others at full-data values makes the curves
    slightly optimistic, so they show shape and identifiability, not accuracy."""
    out = []
    coordinates = [(s, FINE_STAT_STEP, FINE_STAT_HALF) for s in powers] + [("size power p", FINE_P_STEP, FINE_P_HALF)]
    for name, step, half in coordinates:
        center = p if name == "size power p" else powers[name]
        floor = MIN_POWER if name == "size power p" else power_floor(name)
        grid = sorted({round(center + step * k, 4) for k in range(-half, half + 1) if center + step * k >= floor - 1e-12}
                      | {1.0})
        curve = []
        for v in grid:
            trial_powers = powers if name == "size power p" else {**powers, name: v}
            trial = with_powers(spec, trial_powers, v if name == "size power p" else p)
            run = cv_spec(trial, sl.units, sl.plan.folds, sl.arm, full_fit=False)
            curve.append((v, run.mean("mae"), run.se("mae")))
        best_v, best_mae, best_se = min(curve, key=lambda t: (t[1], t[0]))
        window = [t for t in curve if abs(t[0] - center) <= step * half + 1e-9]
        within = [v for v, mae, _ in window if mae <= best_mae + best_se]
        out.append({
            "name": name, "center": center, "best": best_v, "best_mae": best_mae, "se": best_se,
            "lo": min(within), "hi": max(within),
            "at_center": next(mae for v, mae, _ in curve if v == round(center, 4)),
            "at_linear": next(mae for v, mae, _ in curve if v == 1.0),
            "edge": min(within) <= window[0][0] + 1e-9 or max(within) >= window[-1][0] - 1e-9,
        })
    return out


def nested_fine(spec: Spec, sl: Slice, coarse: PowerResult) -> FineResult:
    """Fine refinement nested inside each training fold, starting from that
    fold's coarse powers; then a full-data refinement and local CV curves.
    The model choice: powers are kept only if the better of coarse / fine beats
    linear stats by more than one SE, and then whichever of the two is lower."""
    units, arm = sl.units, sl.arm
    cost = np.array([u.cost for u in units], float)
    oof = np.full(len(units), np.nan)
    oof_fold = np.zeros(len(units), int)
    fold_metrics, fold_powers = [], []
    everything = np.arange(len(units))
    refined = parallel_map(refine_powers, [(spec, units, arm, train, *coarse.fold_powers[k])
                                           for k, (train, _) in enumerate(sl.plan.folds)]
                           + [(spec, units, arm, everything, coarse.full_powers, coarse.full_p)])
    for k, (train, test) in enumerate(sl.plan.folds):
        powers, p = refined[k]
        fold_powers.append((powers, p))
        fitted = with_powers(spec, powers, p)
        design, d = design_for(fitted, units, arm), data_for(fitted, units)
        model = fit_on(fitted, design, d, train)
        pred = predict_total(model, design, d, test)
        oof[test], oof_fold[test] = pred, k + 1
        fold_metrics.append(metrics(cost[test], pred, d.size[test]))
    nested = CVRun("fine powers + p, refined inside each training fold", fold_metrics, oof, oof_fold, spec)
    full_powers, full_p = refined[-1]
    profiles = local_profiles(spec, sl, full_powers, full_p)
    base = coarse.base
    best_power = min(coarse.nested.mean("mae"), nested.mean("mae"))
    if best_power >= base.mean("mae") - base.se("mae"):
        choice = "linear"
    else:
        choice = "fine" if nested.mean("mae") <= coarse.nested.mean("mae") else "coarse"
    return FineResult(nested, fold_powers, full_powers, full_p, profiles, choice)


def nested_powers(spec: Spec, sl: Slice, base: CVRun) -> PowerResult:
    units, arm = sl.units, sl.arm
    cost = np.array([u.cost for u in units], float)
    oof = np.full(len(units), np.nan)
    oof_fold = np.zeros(len(units), int)
    fold_metrics, fold_powers = [], []
    descents = parallel_map(descend_powers, [(spec, units, arm, train) for train, _ in sl.plan.folds]
                            + [(spec, units, arm, np.arange(len(units)))])
    for k, (train, test) in enumerate(sl.plan.folds):
        powers, p, _ = descents[k]
        fold_powers.append((powers, p))
        fitted = with_powers(spec, powers, p)
        design, d = design_for(fitted, units, arm), data_for(fitted, units)
        model = fit_on(fitted, design, d, train)
        pred = predict_total(model, design, d, test)
        oof[test], oof_fold[test] = pred, k + 1
        fold_metrics.append(metrics(cost[test], pred, d.size[test]))
    nested = CVRun("stat powers + p, fitted inside each training fold", fold_metrics, oof, oof_fold, spec)
    full_powers, full_p, _ = descents[-1]
    kept = nested.mean("mae") < base.mean("mae") - base.se("mae")
    return PowerResult(base, nested, fold_powers, full_powers, full_p, kept)


# --- Shape variants: firearm/calibre representation × shooting cluster --------

@dataclass
class VariantResult:
    key: str                 # e.g. "F1·SH2"
    label: str
    spec: Spec               # linear exponents; powers live in `power`
    power: PowerResult       # nested coarse stat powers for this shape
    params: int              # fitted parameters incl. exponents and p
    unseen: int              # test rows hitting a level absent from their training fold
    adopted: bool = False
    eligible: bool = True    # product variants: beat their own summation by > 1 SE

    def mean(self) -> float:
        return self.power.nested.mean("mae")

    def se(self) -> float:
        return self.power.nested.se("mae")


# --artillery-cal: restrict the artillery calibre representations screened.
# "auto" (the artillery_cal setting) screens them all; otherwise F0 (the baseline) plus the named one.
ARTILLERY_CAL_KEYS = {"calibre": "F1", "projectile": "F2", "spline": "F3"}


def shape_variants(arm: str) -> list[tuple[str, str, tuple[tuple[str, str], ...]]]:
    """(key, label, shape) for every variant of one arm. F = firearm / calibre
    representation, SH = shooting: 0 additive, 1 product, 2 product per type."""
    if arm == "artillery":
        # F3: the smooth calibre function from experiments/ (analysis branch) calibre_function.py — a
        # natural cubic spline in log range (df 5) with the shot type, which matched
        # the cannon-type one-hot (49.68 vs 49.43 nested MAE) with 9 fewer parameters.
        reps = [("F0", "range + damage + gun reload", ()),
                ("F1", "calibre", (("cal", "calibre"),)),
                ("F2", "cannon type", (("cal", "projectile"),)),
                ("F3", "range spline (df 5)", (("cal", "spline_r"), ("cal_df", "5")))]
        cal = config.settings.artillery_cal
        if cal != "auto":
            reps = [r for r in reps if r[0] in ("F0", ARTILLERY_CAL_KEYS[cal])]
        per_type = {"F1": "calibre inside the shooting product", "F2": "shooting product per cannon type"}
    else:
        reps = [("F0", "range", ()), ("F1", "firearm one-hot", (("fire", "firearm"),))]
        per_type = {"F1": "shooting product per firearm"}
    out = []
    for fkey, flabel, fshape in reps:
        shoots = [("SH0", "additive shooting", ()), ("SH1", "shooting product", (("shoot", "product"),))]
        if fkey in per_type:
            shoots.append(("SH2", per_type[fkey], (("shoot", "product_type"),)))
        for skey, slabel, sshape in shoots:
            out.append((f"{fkey}·{skey}", f"{flabel}; {slabel}", tuple(sorted(fshape + sshape))))
    return out


def screen_variants(pre: Spec, sl: Slice, log_fn: Callable[[str], None]) -> list[VariantResult]:
    """Nested coarse CV for every shape variant of one arm, then the adoption
    rule, with summation as the default (per the user — a product is probably
    not how the game implements shooting):

    1. A shooting-product variant (SH1/SH2) is eligible only if it beats the
       summation variant with the same firearm/calibre representation (its
       F·SH0) by more than one SE. Summation variants are always eligible.
    2. F0·SH0 is the current model. An eligible variant is adopted only if it
       beats F0·SH0 by more than one SE.
    3. Among those within one SE of the best, summation is preferred, then the
       fewest parameters."""
    out = []
    for key, label, shape in shape_variants(sl.arm):
        spec = replace(pre, shape=shape)
        base = cv_spec(spec, sl.units, sl.plan.folds, sl.arm, full_fit=False, label=f"{key}, linear exponents")
        power = nested_powers(spec, sl, base)
        design = design_for(spec, sl.units, sl.arm)
        unseen = 0
        for train, test in sl.plan.folds:
            bad = unidentified(design.X, train, test)
            if bad.any():
                unseen += int(np.any(design.X[test][:, bad] != design.X[train][0, bad], axis=1).sum())
        params = base.params + len(design.power_keys) + 1
        out.append(VariantResult(key, label, spec, power, params, unseen))
        log_fn(f"variant   {sl.arm:9} {key} {label:45} linear {base.mean('mae'):6.2f}  nested {power.nested.mean('mae'):6.2f}")
    adopt_variant(out)
    return out


def adopt_variant(out: list[VariantResult]) -> VariantResult:
    """Apply the adoption rule (see screen_variants) and mark the pick. out[0]
    is F0·SH0, the current model."""
    current = out[0]
    summation = {v.key.split("·")[0]: v for v in out if v.key.endswith("SH0")}
    for v in out:
        if v.key.endswith("SH0"):
            v.eligible = True
        else:
            ref = summation[v.key.split("·")[0]]
            v.eligible = v.mean() < ref.mean() - ref.se()
    beats = [v for v in out[1:] if v.eligible and v.mean() < current.mean() - current.se()]
    if beats:
        best = min(beats, key=lambda v: v.mean())
        pool = [v for v in beats if v.mean() <= best.mean() + best.se()]
        pick = min(pool, key=lambda v: (not v.key.endswith("SH0"), v.params, v.mean()))
    else:
        pick = current
    pick.adopted = True
    return pick


def variant_details(variants: list[VariantResult], sl: Slice) -> dict:
    """Full-data fits of the best F1 (and, for artillery, F2) variant, for the
    report: per-firearm coefficients, or the calibre curve and cannon-type
    coefficients."""
    def full_fit(v: VariantResult) -> tuple[Spec, Design, PriceModel]:
        spec = with_powers(v.spec, v.power.full_powers, v.power.full_p)
        design, d = design_for(spec, sl.units, sl.arm), data_for(spec, sl.units)
        return spec, design, fit_on(spec, design, d, np.arange(len(sl.units)))

    def best_of(prefix: str) -> VariantResult | None:
        # A representation may be absent (e.g. --artillery-cal restricts the screen).
        pool = [v for v in variants if v.key.startswith(prefix)]
        return min(pool, key=lambda v: v.mean()) if pool else None

    out: dict = {}
    f1 = best_of("F1")
    if sl.arm == "artillery":
        if f1:
            spec, design, model = full_fit(f1)
            coef = dict(zip(design.names, model.beta))
            a = spec.power_of("cal:damage")
            projectiles: dict[str, tuple[str, float]] = {}
            for u in sl.units:
                projectiles.setdefault(u.projectile, (u.shot, u.values["proj_damage"]))
            out["calibre"] = {
                "variant": f1.key, "beta": coef.get("calibre", float("nan")), "a": a,
                "rows": [(proj, shot, dmg, coef.get("calibre", float("nan")) * (dmg / POWER_SCALE) ** a)
                         for proj, (shot, dmg) in sorted(projectiles.items(), key=lambda t: (t[1][0], t[1][1]))],
            }
        f2 = best_of("F2")
        if f2:
            spec2, design2, model2 = full_fit(f2)
            out["cannon"] = {"variant": f2.key, "reference": design2.references.get("projectile"),
                             "rows": [(n, c) for n, c in zip(design2.names, model2.beta)
                                      if n.startswith("projectile=") or n.startswith("shoot×projectile=")]}
    elif f1:
        spec, design, model = full_fit(f1)
        coef = dict(zip(design.names, model.beta))
        out["firearm"] = {"variant": f1.key, "reference": design.references.get("firearm"),
                          "rows": [(n, c) for n, c in coef.items()
                                   if n.startswith("firearm=") or n.startswith("shoot×firearm=") or n == "shoot"]}
    return out
