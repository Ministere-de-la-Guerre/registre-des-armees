"""Army Corps (AC) unit pricing: does the Theatre-of-War price model explain AC list prices?

The adopted pricing model (PRICING_MODEL_REPORT.md) covers Theatre-of-War (ToW) and Custom
armies only. AC is the flagship mode: 238 corps, 7 205 regular units, corps numbers N = 3–13
(ToW only spans 5–12). The game stores a price per unit (`multiplayer_cost`); the Lua has no
per-corps multiplier (analysis/AC_DISCOUNT_RULES.md), so any 1/N scaling is baked into each
unit's price — exactly what the ToW model's fixed 8/N divisor assumes. AC list prices are
before the formation rebates (analysis/ac_discounts.py turns them into effective prices).

This script refits the ToW model forms on AC with the same protocol as unit_pricing.py
(group folds by identical feature rows, 5 folds, fold plan searched over 500 seeds), and
reuses its code unchanged: `ac_units()` swaps unit_pricing's scope and side rules for AC
ones only while loading, so ToW runs are unaffected. The committed final stat powers
(pricing/final.py FINAL) are kept, which skips the ~50-minute power search; step 2 of
analysis/AC_STUDY_PLAN.md says to run that search only if AC fits clearly worse.

Per arm (merged slice; AC side = empire → imperial, coalition → coalition):
  plain     FINAL as committed: free multiplier per corps number (and side for infantry)
  fixed8N   the rating levels replaced by the fixed 8/N divisor, no army × class
  jfc       the adopted form: fixed 8/N × a joint army × class multiplier, κ by nested CV
  v0        jfc with κ fixed at its full-grid value (the base of class_structure's variants)
  v0p       v0 + a size power per class segment
  v4        V4: a separate formula and size power per class segment (class_structure.py)
plus:
  holdout   fit on the 221 AC corps that have a ToW copy, predict the 17 AC-only corps
            (e.g. 6. Eugène / Italie) unseen — their army × class cells fall back to 1
  transfer  fit the same form on ToW + Custom units only, predict every AC unit: is it one
            pricing rule, and what is the AC premium per class?
  staff     T3 = b·stars^q·8/N refitted on AC staff generals (CV by unit_pricing.staff_cv)

Checkpoints: analysis/.cache/ac/ (one file per arm × stage; --fresh ignores them).
Outputs: analysis/output/ac/ (fold ids, out-of-fold predictions, metrics) — `--phase report`
assembles them. Run one arm per process to use the cores:

    py -3.13 analysis/ac_pricing.py --phase model --arm infantry --workers 4
    py -3.13 analysis/ac_pricing.py --phase model --arm cavalry --workers 4
    py -3.13 analysis/ac_pricing.py --phase model --arm artillery --workers 4
    py -3.13 analysis/ac_pricing.py --phase report
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from dataclasses import replace
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import class_structure as cs  # noqa: E402
import checkpoints as ckpt  # noqa: E402
import common  # noqa: E402
import unit_pricing as up  # noqa: E402
from pricing.final import FINAL  # noqa: E402

OUT = common.AC_OUT
# The ToW κ grid starts at 0.5; on AC a 3-seed smoke run chose 0.5 in every fold (the grid's
# edge), so AC gets smaller values too: passed to fclass_cv for the AC fits only.
AC_JFC_GRID = (0.05, 0.1, 0.2, 0.5, 1.0, 3.0, 10.0, 30.0)


# --- Data ----------------------------------------------------------------------

def ac_scope(row: dict[str, str]) -> bool:
    return row["faction_kind"] == "army_corps"


def ac_side(row: dict[str, str]) -> str:
    return "imperial" if row["corps_side"] == "empire" else "coalition"


def ac_units() -> tuple[list[up.Unit], list[up.Staff]]:
    """AC regular units and staff generals: unit_pricing.load with the AC scope and side rules."""
    units, staff, unparsed, unrated = up.load(up.load_ratings(), scope=ac_scope, side=ac_side)
    if unrated:
        raise SystemExit(f"AC corps without a corps number: {sorted(unrated)[:5]}")
    return units, staff


def tow_units() -> list[up.Unit]:
    return up.load(up.load_ratings())[0]


def ac_only_factions() -> set[str]:
    """AC corps with no Theatre-of-War copy: no ToW row names them as its source corps."""
    sourced, ac = set(), set()
    with up.DATA_CSV.open(encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            if r["faction_kind"] == "army_corps":
                ac.add(r["faction_key"])
            elif r["faction_kind"] == "theatre_of_war":
                sourced.add(r["source_corps_faction_key"])
    return ac - sourced


def cached(name: str, compute, fresh: bool):
    """This study's checkpoint `name` (analysis/checkpoints.py ac), computed and saved if missing."""
    return common.cached(ckpt.ac(name), compute, fresh)


# --- Model phase ---------------------------------------------------------------

def holdout_run(spec: up.Spec, design: up.Design, units: list[up.Unit], test_mask: np.ndarray,
                class_p: bool) -> np.ndarray:
    """Fit on the rows outside `test_mask` (class size powers too, if asked), predict inside."""
    train = np.flatnonzero(~test_mask)
    test = np.flatnonzero(test_mask)
    d = up.data_for(spec, units)
    if class_p:
        d = cs.with_class_p(d, units, spec, cs.fit_class_p(spec, design, units, train))
    model = up.fit_on(spec, design, d, train)
    pred = np.full(len(units), np.nan)
    pred[test] = up.predict_total(model, design, d, test)
    return pred


def transfer_run(spec: up.Spec, arm: str, tow: list[up.Unit], ac: list[up.Unit]) -> np.ndarray:
    """The form fitted on ToW + Custom units only, predicting every AC unit (pooled design so
    the columns match; AC army × class cells are unseen and fall back to 1, i.e. pure 8/N)."""
    pooled = tow + ac
    design = up.design_for(spec, pooled, arm)
    d = up.data_for(spec, pooled)
    model = up.fit_on(spec, design, d, np.arange(len(tow)))
    return up.predict_total(model, design, d, np.arange(len(tow), len(pooled)))


def model_phase(arm: str, seeds: int, fresh: bool, started: float) -> None:
    units, staff = ac_units()
    final = FINAL[arm]
    tag = f"s{seeds}_{arm}"          # checkpoints are per seed count, so a smoke run never leaks
    sl = cached(f"{tag}_slice", lambda: up.make_slice(arm, "merged", up.slice_units(units, arm, "merged"), seeds),
                fresh)
    up.log(f"{arm}: {len(sl.units)} AC units, folds from {seeds} seeds", started)
    folds = sl.plan.folds
    runs: dict[str, up.CVRun] = {}
    runs["plain"] = cached(f"{tag}_plain", lambda: up.cv_spec(final, sl.units, folds, arm, label="plain"), fresh)
    fixed = replace(final, mult=final.mult - {"rating"}, fixed_rating=True)
    runs["fixed8N"] = cached(f"{tag}_fixed8N", lambda: up.cv_spec(fixed, sl.units, folds, arm, label="fixed8N"), fresh)
    up.log(f"{arm}: plain {runs['plain'].mean('mae'):.2f}, fixed8N {runs['fixed8N'].mean('mae'):.2f}", started)
    jfc = cached(f"{tag}_jfc", lambda: up.fclass_cv("JFC", final, sl.units, folds, arm, grid=AC_JFC_GRID), fresh)
    runs["jfc"] = jfc.run
    up.log(f"{arm}: jfc {jfc.run.mean('mae'):.2f} (κ per fold {jfc.kappas}, full {jfc.full_kappa})", started)
    v0 = up.joint_fclass_spec(final, jfc.full_kappa)
    d0 = up.design_for(v0, sl.units, arm)
    d3 = cs.segmented(d0, sl.units)
    exps: dict[str, dict[str, float]] = {}
    for key, design, class_p in (("v0", d0, False), ("v0p", d0, True), ("v4", d3, True)):
        runs[key], exps[key] = cached(f"{tag}_{key}", lambda: cs.run_variant(key, v0, design, sl, arm, class_p), fresh)
        up.log(f"{arm}: {key} {runs[key].mean('mae'):.2f} {exps[key] or ''}", started)

    only = ac_only_factions()
    mask = np.array([u.faction in only for u in sl.units])
    holdout = {key: cached(f"{tag}_holdout_{key}", lambda: holdout_run(v0, design, sl.units, mask, class_p), fresh)
               for key, design, class_p in (("v0", d0, False), ("v4", d3, True))}
    up.log(f"{arm}: holdout on {mask.sum()} AC-only units", started)
    tow = up.slice_units(tow_units(), arm, "merged")
    transfer = cached(f"{tag}_transfer", lambda: transfer_run(v0, arm, tow, sl.units), fresh)
    up.log(f"{arm}: transfer from {len(tow)} ToW/Custom units", started)

    # Write this arm's out-of-fold table (one row per AC unit) and fold ids.
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / f"ac_oof_{arm}.csv", "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        keys = list(runs)
        w.writerow(["faction_key", "unit_key", "unit_class", "corps_number", "side", "models", "cost", "fold",
                    "ac_only"] + [f"oof_{k}" for k in keys] + ["holdout_v0", "holdout_v4", "transfer_from_tow"])
        for i, u in enumerate(sl.units):
            w.writerow([u.faction, u.key, u.unit_class, u.rating, u.side, f"{u.n:g}", u.cost, int(runs["v0"].oof_fold[i]),
                        int(mask[i])] + [f"{runs[k].oof[i]:.3f}" if np.isfinite(runs[k].oof[i]) else "" for k in keys]
                       + [f"{holdout[k][i]:.3f}" if np.isfinite(holdout[k][i]) else "" for k in ("v0", "v4")]
                       + [f"{transfer[i]:.3f}"])
    summary = {"arm": arm, "units": len(sl.units), "ac_only_units": int(mask.sum()), "seeds": seeds,
               "kappa_full": jfc.full_kappa, "kappa_folds": jfc.kappas, "class_p": exps,
               "mae": {k: [r.mean("mae"), r.se("mae")] for k, r in runs.items()},
               "mape": {k: r.mean("mape") for k, r in runs.items()},
               "params": {k: r.params for k, r in runs.items()},
               "rating_levels": runs["plain"].full.levels.get("rating", {})}
    (OUT / f"ac_summary_{arm}.json").write_text(json.dumps(summary, indent=2, default=float), encoding="utf-8")
    up.log(f"{arm}: done → {OUT.relative_to(up.ROOT)}/ac_oof_{arm}.csv", started)


def staff_phase(fresh: bool, seeds: int, started: float) -> None:
    _, staff = ac_units()
    gens = [g for g in staff]
    ssl = cached(f"s{seeds}_staff_slice", lambda: up.make_staff_slice("merged", gens, seeds), fresh)
    stars = np.array([g.stars for g in gens], float)
    cost = np.array([g.cost for g in gens], float)
    rating = np.array([g.rating for g in gens], float)
    b, q = up.staff_power_fit(stars, cost, rating)
    OUT.mkdir(parents=True, exist_ok=True)
    runs = {name: {"mae": run.mean("mae"), "mape": run.mean("mape")} for name, run in ssl.runs.items()}
    # unit_pricing's staff fold plan scores only a subset (identical generals are tested once),
    # so T3 is also scored on a full partition: generals sharing stars and corps number in one
    # fold, groups dealt round-robin — the folds the blind study got (blind_data_phase).
    groups = sorted({(g.stars, g.rating) for g in gens})
    order = np.random.default_rng(0).permutation(len(groups))
    group_fold = {groups[j]: 1 + rank % 5 for rank, j in enumerate(order)}
    fold = np.array([group_fold[(g.stars, g.rating)] for g in gens])
    oof = np.full(len(gens), np.nan)
    for k in range(1, 6):
        bk, qk = up.staff_power_fit(stars[fold != k], cost[fold != k], rating[fold != k])
        oof[fold == k] = up.staff_power_price(stars[fold == k], rating[fold == k], bk, qk)
    tow_pred = up.staff_power_price(stars, rating, 76.55039271, 1.39)
    starred = stars > 0
    for name, pred in (("T3 refit on AC (full grouped folds)", oof), ("T3 with the ToW coefficients", tow_pred)):
        err = np.abs(pred - cost)
        runs[name] = {"mae": float(err.mean()), "mape": float(np.mean(err[starred] / cost[starred]) * 100)}
    zero = cost[stars == 0]
    (OUT / "ac_staff.json").write_text(json.dumps({
        "generals": len(gens), "t3_b": b, "t3_q": q, "tow_t3": [76.55039271, 1.39],
        "zero_star_costs": {str(int(c)): int((zero == c).sum()) for c in sorted(set(zero.tolist()))},
        "runs": runs}, indent=2, default=float), encoding="utf-8")
    up.log(f"staff: {len(gens)} AC staff generals, T3 refit b={b:.2f} q={q:.3f}", started)


# --- Size phase (step 3: can unit size be modelled better?) -------------------------
#
# The adopted model prices size as models^p (guns^p for artillery) with one p per arm. On
# ToW its out-of-fold error is U-shaped in size inside every infantry class, which forced the
# size harmonisation in cost_effective_builds.py. Forms compared on the same folds and the
# same base (v0: the adopted joint army × class model, κ fixed at its full-grid value):
#   F0  v0: one size power per arm
#   F1  one size power per class segment (class_structure's exponents)
#   F2  F0 × a free multiplier per size band (a piecewise-constant correction of the curve)
#   F3  F0 with one knot: the power changes by δ above a size K (K, δ fitted on training rows)
#   F4  one size power per training level (mass and mob vs elite)
#   F5  F1 + F2
#   F6  a free multiplier per class segment × size band (a size curve per class)
# Every fitted size parameter is chosen on the training rows of each fold only.

SIZE_BANDS = common.AC_STUDY_BANDS
KNOTS = {"n": (60, 100, 160, 240), "guns": (2, 3, 4)}
DELTA_GRID = tuple(round(-0.8 + 0.1 * i, 1) for i in range(17))


def band_of(size: float, kind: str, bands: dict[str, tuple] | None = None) -> str:
    edges = (SIZE_BANDS if bands is None else bands)[kind]
    k = int(np.searchsorted(np.array(edges, float), size, side="right"))
    lo = 0 if k == 0 else edges[k - 1]
    return f"{lo}+" if k == len(edges) else f"{lo}-{edges[k]}"


def with_bands(units: list[up.Unit], kind: str, per_class: bool,
               bands: dict[str, tuple] | None = None) -> list[up.Unit]:
    """Units whose `drill` attribute holds their size band (or class segment × band), so the
    model's multiplicative categorical machinery fits one free factor per band. `drill` is
    unused by the committed final specs, which is what makes it free to carry this. `bands`
    replaces SIZE_BANDS (team_values' size-band values merge the 240+ band)."""
    return [replace(u, drill=(f"{cs.segment(u)}|" if per_class else "") + band_of(up.size_of(u, kind), kind, bands))
            for u in units]


def with_group_p(d: up.SliceData, groups: np.ndarray, spec: up.Spec, p_of: dict[str, float]) -> up.SliceData:
    p_row = np.array([p_of.get(gr, spec.p) for gr in groups.tolist()])
    return replace(d, g=d.g * d.size ** (p_row - spec.p))


def fit_group_p(spec: up.Spec, design: up.Design, units: list[up.Unit], groups: np.ndarray,
                rows: np.ndarray) -> dict[str, float]:
    """Coordinate descent over one size exponent per group on the training objective (as
    class_structure.fit_class_p, for any grouping)."""
    d0 = up.data_for(spec, units)
    levels = sorted(s for s in set(groups[rows].tolist()) if (groups[rows] == s).sum() >= cs.MIN_SEGMENT_UNITS)
    p_of: dict[str, float] = {}

    def objective(trial: dict[str, float]) -> float:
        return up.fit_on(spec, design, with_group_p(d0, groups, spec, trial), rows).sse

    for _ in range(cs.P_PASSES):
        for s in levels:
            best = (np.inf, p_of.get(s, spec.p))
            for p in cs.P_COARSE:
                sse = objective({**p_of, s: p})
                if sse < best[0] - 1e-12:
                    best = (sse, p)
            for k in (-1, 1):
                p = round(best[1] + k * cs.P_FINE_STEP, 2)
                if p > 0:
                    sse = objective({**p_of, s: p})
                    if sse < best[0] - 1e-12:
                        best = (sse, p)
            p_of[s] = best[1]
    return p_of


def with_knot(d: up.SliceData, knot: float, delta: float) -> up.SliceData:
    return replace(d, g=d.g * np.where(d.size > knot, (d.size / knot) ** delta, 1.0))


def fit_knot(spec: up.Spec, design: up.Design, units: list[up.Unit], rows: np.ndarray, kind: str) -> tuple[float, float]:
    """(K, δ) with the lowest training SSE: δ on a 0.1 grid, then ±0.05 around the best."""
    d0 = up.data_for(spec, units)
    best = (up.fit_on(spec, design, d0, rows).sse, KNOTS[kind][0], 0.0)
    for knot in KNOTS[kind]:
        if (d0.size[rows] > knot).sum() < cs.MIN_SEGMENT_UNITS:
            continue
        for delta in DELTA_GRID:
            sse = up.fit_on(spec, design, with_knot(d0, knot, delta), rows).sse
            if sse < best[0] - 1e-12:
                best = (sse, knot, delta)
        for delta in (best[2] - 0.05, best[2] + 0.05):
            sse = up.fit_on(spec, design, with_knot(d0, knot, delta), rows).sse
            if sse < best[0] - 1e-12:
                best = (sse, knot, delta)
    return best[1], best[2]


def size_form_job(form: str, spec: up.Spec, design: up.Design, units: list[up.Unit], rows: np.ndarray,
                  kind: str) -> dict:
    """The fitted size parameters of one form on `rows` (run per fold in the worker pool)."""
    if form in ("F1", "F5"):
        return {"p": fit_group_p(spec, design, units, np.array([cs.segment(u) for u in units]), rows)}
    if form == "F4":
        return {"p": fit_group_p(spec, design, units, np.array([u.training for u in units]), rows)}
    if form == "F3":
        knot, delta = fit_knot(spec, design, units, rows, kind)
        return {"knot": knot, "delta": delta}
    return {}


def size_form_run(form: str, base: up.Spec, units: list[up.Unit], folds, arm: str,
                  bands: dict[str, tuple] | None = None) -> tuple[up.CVRun, dict]:
    kind = base.size
    banded = form in ("F2", "F5", "F6")
    use = with_bands(units, kind, per_class=form == "F6", bands=bands) if banded else units
    spec = replace(base, mult=base.mult | {"drill"}) if banded else base
    design = up.design_for(spec, use, arm)
    everything = np.arange(len(use))
    fitted = up.parallel_map(size_form_job, [(form, spec, design, use, train, kind) for train, _ in folds]
                             + [(form, spec, design, use, everything, kind)])
    seg = np.array([cs.segment(u) for u in use])
    trn = np.array([u.training for u in use])

    def data(params: dict) -> up.SliceData:
        d = up.data_for(spec, use)
        if "p" in params:
            d = with_group_p(d, trn if form == "F4" else seg, spec, params["p"])
        if "knot" in params:
            d = with_knot(d, params["knot"], params["delta"])
        return d

    oof = np.full(len(use), np.nan)
    oof_fold = np.zeros(len(use), int)
    fold_metrics = []
    for k, (train, test) in enumerate(folds):
        d = data(fitted[k])
        model = up.fit_on(spec, design, d, train)
        oof[test], oof_fold[test] = up.predict_total(model, design, d, test), k + 1
        fold_metrics.append(up.metrics(d.cost[test], oof[test], d.size[test]))
    d = data(fitted[-1])
    full = up.fit_on(spec, design, d, everything)
    run = up.CVRun(f"{form}", fold_metrics, oof, oof_fold, spec, full, design.names, design.references,
                   design.aliases, full.n_params(design.X))
    return run, {"fitted": fitted[-1], "bands": full.levels.get("drill", {})}


SIZE_FORMS = ("F0", "F1", "F2", "F3", "F4", "F5", "F6")


def size_phase(dataset: str, arm: str, seeds: int, fresh: bool, started: float) -> None:
    final = FINAL[arm]
    if dataset == "ac":
        sl = common.load_pickle(ckpt.slice_path("ac", arm, seeds))
        kappa = common.load_pickle(ckpt.ac_jfc_path(arm, seeds)).full_kappa
    else:
        sl = cached(f"s{seeds}_tow_{arm}_slice",
                    lambda: up.make_slice(arm, "merged", up.slice_units(tow_units(), arm, "merged"), seeds), fresh)
        kappa = common.load_pickle(ckpt.tow_kappa_path(arm))
    base = up.joint_fclass_spec(final, kappa)
    results = {}
    for form in SIZE_FORMS:
        results[form] = cached(f"s{seeds}_size_{dataset}_{arm}_{form}",
                               lambda: size_form_run(form, base, sl.units, sl.plan.folds, arm), fresh)
        up.log(f"size {dataset} {arm} {form}: MAE {results[form][0].mean('mae'):.2f} "
               f"{ {k: v for k, v in results[form][1]['fitted'].items()} }", started)
    OUT.mkdir(parents=True, exist_ok=True)
    with open(OUT / f"size_oof_{dataset}_{arm}.csv", "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["faction_key", "unit_key", "unit_class", "segment", "training", "size", "cost", "fold"]
                   + [f"oof_{f}" for f in SIZE_FORMS])
        for i, u in enumerate(sl.units):
            w.writerow([u.faction, u.key, u.unit_class, cs.segment(u), u.training, f"{up.size_of(u, final.size):g}",
                        u.cost, int(results["F0"][0].oof_fold[i])]
                       + [f"{results[f][0].oof[i]:.3f}" if np.isfinite(results[f][0].oof[i]) else "" for f in SIZE_FORMS])
    (OUT / f"size_summary_{dataset}_{arm}.json").write_text(json.dumps({
        "dataset": dataset, "arm": arm, "kappa": kappa,
        "mae": {f: [r.mean("mae"), r.se("mae")] for f, (r, _) in results.items()},
        "mape": {f: r.mean("mape") for f, (r, _) in results.items()},
        "params": {f: r.params for f, (r, _) in results.items()},
        "fitted": {f: x["fitted"] for f, (_, x) in results.items()},
        "bands": {f: x["bands"] for f, (_, x) in results.items()}}, indent=2, default=float), encoding="utf-8")
    up.log(f"size {dataset} {arm}: done", started)


# --- Commanders (step 2d) ------------------------------------------------------------

def commander_phase(seeds: int, started: float) -> None:
    """The commander model FS7 (commander_model.py: a commander's price from its regular
    unit's true price P, the general's stat bonuses and stars) on AC pairs: refitted by LAD on
    AC with each pair in its regular unit's fold, and the ToW coefficients applied unchanged."""
    import build_commander_pairs as bcp
    import commander_model as cm
    pairs_csv = OUT / "ac_commander_pairs.csv"
    OUT.mkdir(parents=True, exist_ok=True)
    bcp.build_pairs(pairs_csv, scope=ac_scope, side=ac_side)
    c = cm.Pairs(pairs_csv)
    fold_of: dict[tuple[str, str], int] = {}
    for arm in up.ARMS:
        sl = common.load_pickle(ckpt.slice_path("ac", arm, seeds))
        for k, (_, test) in enumerate(sl.plan.folds, 1):
            for i in test:
                fold_of[(sl.units[i].faction, sl.units[i].key)] = k
    fold = np.array([fold_of.get((r["faction_key"], r["regular_unit_key"]), 0) for r in c.rows])
    X, names = cm.design(c, c.true_p)
    y = c.cost
    ok = np.isfinite(X).all(axis=1) & np.isfinite(y)
    oof = np.full(c.n, np.nan)
    for k in range(1, 6):
        train, test = ok & (fold != k) & (fold > 0), ok & (fold == k)
        oof[test] = X[test] @ cm.lad(X[train], y[train])
    with open(up.ROOT / "analysis" / "output" / "commander_model_coefficients.csv", encoding="utf-8") as fh:
        tow = {r["term"]: float(r["coefficient"]) for r in csv.DictReader(fh) if r["model"] == "given true P"}
    transfer = X @ np.array([tow[n] for n in names])
    full = cm.lad(X[ok], y[ok])
    tested = np.isfinite(oof)
    ratio = np.median(y[ok] / c.true_p[ok])
    summary = {"pairs": c.n, "scored": int(tested.sum()),
               "refit_cv": cm.metrics(y[tested], oof[tested]),
               "tow_coefficients": cm.metrics(y[tested], transfer[tested]),
               "ratio_baseline": cm.metrics(y[tested], ratio * c.true_p[tested]), "median_ratio": float(ratio),
               "coefficients_ac": dict(zip(names, full.tolist())), "coefficients_tow": tow}
    (OUT / "ac_commanders.json").write_text(json.dumps(summary, indent=2, default=float), encoding="utf-8")
    with open(OUT / "ac_commander_oof.csv", "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["faction_key", "commander_unit_key", "regular_unit_key", "arm", "fold", "regular_price",
                    "commander_price", "oof_refit", "tow_coefficients"])
        for i, r in enumerate(c.rows):
            w.writerow([r["faction_key"], r["commander_unit_key"], r["regular_unit_key"], r["arm"], fold[i],
                        r["regular_price"], r["commander_price"], f"{oof[i]:.3f}" if np.isfinite(oof[i]) else "",
                        f"{transfer[i]:.3f}"])
    up.log(f"commanders: {c.n} AC pairs; refit CV MAE {summary['refit_cv']['mae']:.2f}, ToW coefficients "
           f"{summary['tow_coefficients']['mae']:.2f}, ratio baseline {summary['ratio_baseline']['mae']:.2f}", started)


# --- Report phase: every table from the phases' outputs ---------------------------------

MODEL_LABEL = {"plain": "committed form: free factor per corps number", "fixed8N": "fixed 8/N, no army × class",
               "jfc": "**adopted form**: 8/N × army × class (nested κ)", "v0": "adopted form, κ fixed",
               "v0p": "+ size power per class", "v4": "V4: formula + size power per class"}
SIZE_LABEL = {"F0": "one size power (adopted)", "F1": "size power per class", "F2": "+ size-band multipliers",
              "F3": "one knot in the power", "F4": "size power per training level", "F5": "per-class power + bands",
              "F6": "bands per class"}


def read_oof(path: Path) -> list[dict[str, str]]:
    with open(path, encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def col(rows: list[dict[str, str]], key: str) -> np.ndarray:
    return np.array([float(r[key]) if r.get(key, "") not in ("", None) else np.nan for r in rows])


def err_stats(cost: np.ndarray, pred: np.ndarray) -> tuple[float, float, int]:
    ok = np.isfinite(pred)
    e = np.abs(pred[ok] - cost[ok])
    return float(e.mean()), float(np.mean(e / cost[ok]) * 100), int(ok.sum())


def report_phase(started: float) -> None:
    L = ["# AC unit pricing — results tables", "",
         "Generated by `python analysis/ac_pricing.py --phase report` from the phase outputs in "
         "`analysis/output/ac/`. MAE in gold (mean over 5 folds ± SE), MAPE in %. ToW figures are the committed "
         "ToW + Custom runs (`analysis/.cache/class_structure`), same model forms.", ""]
    # 1. Model forms per arm.
    rows = []
    tow_ref = {}
    for arm in up.ARMS:
        s = json.loads((OUT / f"ac_summary_{arm}.json").read_text(encoding="utf-8"))
        for key in ("V0", "V4"):
            path = ckpt.class_structure(f"{arm}_{key}")
            if path.exists():
                tow_ref[(arm, key)] = common.load_pickle(path)[0].mean("mae")
        for key, (mae, se) in s["mae"].items():
            ref = {"jfc": tow_ref.get((arm, "V0")), "v0": tow_ref.get((arm, "V0")), "v4": tow_ref.get((arm, "V4"))}.get(key)
            rows.append([arm, s["units"], MODEL_LABEL.get(key, key), f"{mae:.2f} ± {se:.2f}", f"{s['mape'][key]:.2f}",
                         s["params"][key], f"{ref:.2f}" if ref else ""])
    L += ["## 1. Model forms on AC (CV, 500-seed fold plan)", ""]
    L += up.table(["arm", "AC units", "model", "MAE", "MAPE %", "params", "ToW MAE, same form"], rows)
    # 2. Corps number: the free per-N factors of the committed form against 8/N.
    L += ["", "## 2. Corps number: free factor per N (committed form) against the fixed 8/N", ""]
    for arm in up.ARMS:
        s = json.loads((OUT / f"ac_summary_{arm}.json").read_text(encoding="utf-8"))
        levels = {int(float(k)): v for k, v in s["rating_levels"].items()}
        if not levels:
            continue
        ns = np.array(sorted(levels))
        m = np.array([levels[n] for n in ns])
        gamma = -np.polyfit(np.log(ns / up.REF_RATING), np.log(m), 1)[0]
        L += [f"**{arm}**: fitted m_N ∝ N^−γ with γ = {gamma:.3f} (8/N means γ = 1).", ""]
        L += up.table(["N"] + [str(n) for n in ns], [["free factor"] + [f"{v:.3f}" for v in m],
                                                      ["8/N"] + [f"{up.REF_RATING / n:.3f}" for n in ns]]) + [""]
    # 3. AC-only corps hold-out and 4. ToW → AC transfer.
    hold_rows, transfer_rows, corps_rows = [], [], []
    names = {}
    with up.DATA_CSV.open(encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            names.setdefault(r["faction_key"], r["army_corps_name"])
    for arm in up.ARMS:
        rows_ = read_oof(OUT / f"ac_oof_{arm}.csv")
        cost = col(rows_, "cost")
        only = np.array([r["ac_only"] == "1" for r in rows_])
        for key, cv_key in (("holdout_v0", "oof_jfc"), ("holdout_v4", "oof_v4")):
            h = col(rows_, key)
            cvp = col(rows_, cv_key)
            a, b = err_stats(cost[only], h[only]), err_stats(cost[only], cvp[only])
            hold_rows.append([arm, key.split("_")[1], int(only.sum()), f"{a[0]:.2f}", f"{a[1]:.2f}",
                              f"{b[0]:.2f}", f"{b[1]:.2f}"])
        t = col(rows_, "transfer_from_tow")
        j = col(rows_, "oof_jfc")
        transfer_rows.append([arm, "all", len(rows_), f"{err_stats(cost, t)[0]:.2f}", f"{err_stats(cost, j)[0]:.2f}",
                              f"×{np.median(cost / t):.3f}"])
        classes = np.array([r["unit_class"] for r in rows_])
        for cls in sorted(set(classes.tolist())):
            m = classes == cls
            transfer_rows.append(["", cls, int(m.sum()), f"{err_stats(cost[m], t[m])[0]:.2f}",
                                  f"{err_stats(cost[m], j[m])[0]:.2f}", f"×{np.median(cost[m] / t[m]):.3f}"])
        h = col(rows_, "holdout_v0")
        fac = np.array([r["faction_key"] for r in rows_])
        for f in sorted(set(fac[only].tolist())):
            m = fac == f
            corps_rows.append([names.get(f, f), arm, int(m.sum()), f"{err_stats(cost[m], h[m])[0]:.1f}",
                               f"{np.median((cost[m] - h[m]) / h[m]) * 100:+.1f}%"])
    L += ["## 3. The 17 AC-only corps, unseen", "",
          "Fitted on the 221 AC corps that have a ToW copy, then applied to the 17 that don't (their army × class "
          "cells fall back to 1, i.e. the pure 8/N stat formula). Compared with the same rows' ordinary CV predictions, "
          "where their own army's other units are in training.", ""]
    L += up.table(["arm", "model", "units", "hold-out MAE", "hold-out MAPE %", "CV MAE (own army seen)", "CV MAPE %"],
                  hold_rows)
    L += ["", "Per AC-only corps (adopted form, hold-out; median residual + = model too cheap):", ""]
    L += up.table(["corps", "arm", "units", "MAE", "median residual"], sorted(corps_rows))
    L += ["", "## 4. One pricing rule? The adopted form fitted on ToW + Custom, applied to AC", "",
          "AC army × class cells are unseen, so this is the ToW stat formula × 8/N. *AC ÷ ToW rule* is the median "
          "ratio of the AC price to that prediction: the AC premium (or discount) the ToW rule misses.", ""]
    L += up.table(["arm", "class", "units", "MAE, ToW rule", "MAE, AC fit (CV)", "AC ÷ ToW rule"], transfer_rows)
    # 5. Generals.
    staff = json.loads((OUT / "ac_staff.json").read_text(encoding="utf-8"))
    L += ["", "## 5. Generals", "",
          f"- **Staff generals** ({staff['generals']}): T3 refitted on AC gives b = {staff['t3_b']:.2f}, "
          f"q = {staff['t3_q']:.3f} (ToW: 76.55, 1.39). 0★ costs: "
          + ", ".join(f"{n} at {c} gold" for c, n in staff["zero_star_costs"].items()) + "."]
    for name, run in staff.get("runs", {}).items():
        L += [f"  - staff CV `{name}`: MAE {run['mae']:.2f}, MAPE {run['mape']:.2f}%"]
    cmd_path = OUT / "ac_commanders.json"
    if cmd_path.exists():
        cmd = json.loads(cmd_path.read_text(encoding="utf-8"))
        L += [f"- **Combat-general versions** ({cmd['pairs']} pairs, {cmd['scored']} scored): the commander model "
              f"FS7 given the true regular price, refitted on AC — CV MAE {cmd['refit_cv']['mae']:.2f} "
              f"(MAPE {cmd['refit_cv']['mape']:.2f}%); with the ToW coefficients unchanged — MAE "
              f"{cmd['tow_coefficients']['mae']:.2f}; a plain ratio ×{cmd['median_ratio']:.3f} — MAE "
              f"{cmd['ratio_baseline']['mae']:.2f}."]
    # 6. Size forms.
    L += ["", "## 6. Unit size: forms compared (same folds, same base)", ""]
    for dataset in ("ac", "tow"):
        for arm in up.ARMS:
            path = OUT / f"size_summary_{dataset}_{arm}.json"
            if not path.exists():
                continue
            s = json.loads(path.read_text(encoding="utf-8"))
            base = s["mae"]["F0"][0]
            L += [f"### {dataset.upper()} {arm}", ""]
            L += up.table(["form", "what", "MAE", "Δ vs F0", "MAPE %", "params", "fitted"],
                          [[f, SIZE_LABEL[f], f"{v[0]:.2f} ± {v[1]:.2f}", f"{v[0] - base:+.2f}", f"{s['mape'][f]:.2f}",
                            s["params"][f], json.dumps(s["fitted"][f])[:80]] for f, v in s["mae"].items()])
            rows_ = read_oof(OUT / f"size_oof_{dataset}_{arm}.csv")
            size = col(rows_, "size")
            cost = col(rows_, "cost")
            kind = "guns" if arm == "artillery" else "n"
            bands = sorted({band_of(x, kind) for x in size}, key=lambda b: float(b.split("-")[0].rstrip("+")))
            band = np.array([band_of(x, kind) for x in size])
            band_rows = []
            for f in s["mae"]:
                p = col(rows_, f"oof_{f}")
                line = [f]
                for b in bands:
                    m = (band == b) & np.isfinite(p)
                    line.append(f"{np.median((cost[m] - p[m]) / p[m]) * 100:+.1f}%" if m.sum() >= 5 else "")
                band_rows.append(line)
            L += ["", "Median out-of-fold residual by size band (+ = model too cheap; counts: "
                  + ", ".join(f"{b} {int((band == b).sum())}" for b in bands) + "):", ""]
            L += up.table(["form"] + bands, band_rows) + [""]
    # 7. Blind study comparison, on identical rows and folds.
    blind_oof = BLIND / "out" / "oof_predictions.csv"
    if blind_oof.exists():
        blind = {(r["faction_key"], r["unit_key"]): r for r in read_oof(blind_oof)}
        blind_hold = {(r["faction_key"], r["unit_key"]): r for r in read_oof(BLIND / "out" / "holdout_predictions.csv")}
        rows, hold_rows = [], []
        for arm in up.ARMS:
            ours = {(r["faction_key"], r["unit_key"]): r for r in read_oof(OUT / f"ac_oof_{arm}.csv")}
            size = {(r["faction_key"], r["unit_key"]): r for r in read_oof(OUT / f"size_oof_ac_{arm}.csv")}
            keys = [k for k in ours if k in blind and ours[k]["oof_jfc"] and k in size]
            cost = np.array([float(ours[k]["cost"]) for k in keys])
            s = json.loads((OUT / f"size_summary_ac_{arm}.json").read_text(encoding="utf-8"))
            best = min(s["mae"], key=lambda f: s["mae"][f][0])
            preds = {"blind M1": [blind[k]["pred_M1"] for k in keys], "blind M2 (army-blind)": [blind[k]["pred_M2"] for k in keys],
                     "ours: adopted form": [ours[k]["oof_jfc"] for k in keys], "ours: V4": [ours[k]["oof_v4"] for k in keys],
                     f"ours: best size form ({best})": [size[k][f"oof_{best}"] for k in keys]}
            for name, p in preds.items():
                mae, mape, n = err_stats(cost, np.array([float(x) for x in p]))
                rows.append([arm, name, n, f"{mae:.2f}", f"{mape:.2f}"])
            hk = [k for k in ours if k in blind_hold and ours[k]["holdout_v0"]]
            hc = np.array([float(ours[k]["cost"]) for k in hk])
            for name, p in (("blind M1", [blind_hold[k]["pred_M1"] for k in hk]),
                            ("ours: adopted form", [ours[k]["holdout_v0"] for k in hk]),
                            ("ours: V4", [ours[k]["holdout_v4"] for k in hk])):
                mae, mape, n = err_stats(hc, np.array([float(x) for x in p]))
                hold_rows.append([arm, name, n, f"{mae:.2f}", f"{mape:.2f}"])
        L += ["", "## 7. Blind study (`analysis/ac_blind/`), same rows and folds", ""]
        L += up.table(["arm", "model", "scored units", "MAE", "MAPE %"], rows)
        L += ["", "Unseen-army test (fitted without the 17 AC-only corps, predicting them):", ""]
        L += up.table(["arm", "model", "units", "MAE", "MAPE %"], hold_rows)
    (OUT / "ac_pricing_results.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    up.log(f"report → {(OUT / 'ac_pricing_results.md').relative_to(up.ROOT)}", started)


# --- Price database (step 5): one row per AC card ------------------------------------

def database_phase(started: float) -> None:
    """analysis/output/ac/ac_price_database.csv: every AC card (units, commander versions, staff
    generals; all 238 corps, AC-only corps flagged) with
      - its list price and rebate-effective prices (analysis/ac_discounts.py),
      - out-of-fold model prices: the adopted form (jfc) and the arm's best size form (step 3),
        the commander model refitted on AC (commanders), T3 refitted on AC (staff generals),
      - its ToW price where a ToW copy exists (experiments/ (analysis branch) ac_natural_experiment.py pairs), or the
        estimated ToW-equivalent price with its band for the 17 AC-only corps (model-based)."""
    disc = read_oof(OUT / "ac_discounts.csv")
    pred_adopted: dict[tuple[str, str], str] = {}
    pred_size: dict[tuple[str, str], str] = {}
    size_form: dict[str, str] = {}
    for arm in up.ARMS:
        for r in read_oof(OUT / f"ac_oof_{arm}.csv"):
            pred_adopted[(r["faction_key"], r["unit_key"])] = r["oof_jfc"]
        s = json.loads((OUT / f"size_summary_ac_{arm}.json").read_text(encoding="utf-8"))
        best = min(s["mae"], key=lambda f: s["mae"][f][0])
        size_form[arm] = best
        for r in read_oof(OUT / f"size_oof_ac_{arm}.csv"):
            pred_size[(r["faction_key"], r["unit_key"])] = r[f"oof_{best}"]
    cmd = {(r["faction_key"], r["commander_unit_key"]): r["oof_refit"] for r in read_oof(OUT / "ac_commander_oof.csv")}
    staff = json.loads((OUT / "ac_staff.json").read_text(encoding="utf-8"))
    tow = {(r["ac_faction_key"], r["ac_unit_key"]): r for r in read_oof(OUT / "natural_experiment_pairs.csv")}
    eq = {(r["faction_key"], r["unit_key"]): r for r in read_oof(OUT / "ac_only_tow_equivalent.csv")}
    only = ac_only_factions()
    stars = {}
    with up.DATA_CSV.open(encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            if r["faction_kind"] == "army_corps":
                stars[(r["faction_key"], r["unit_key"])] = int(up.num(r["command_stars"]))
    header = ["faction_key", "army_corps_name", "corps_number", "ac_only_corps", "unit_key", "kind", "unit_class",
              "list_price", "brigade_effective_price", "division_effective_price", "brigade_rebate_pct",
              "division_rebate_pct", "support_division", "pred_adopted_oof", "pred_best_size_form_oof",
              "best_size_form", "pred_general_oof", "tow_faction_key", "tow_corps_number", "tow_price",
              "tow_equivalent_own_n", "tow_equivalent_own_n_low", "tow_equivalent_own_n_high", "tow_equivalent_n8"]
    n_tow = n_eq = 0
    with open(OUT / "ac_price_database.csv", "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        for d in disc:
            key = (d["faction_key"], d["unit_key"])
            arm = common.ARM_SHORT.get(d["unit_key"].split("_")[1], "")
            general = ""
            if d["kind"] == "commander":
                general = cmd.get(key, "")
            elif d["kind"] == "staff":
                s_ = stars.get(key, 0)
                general = f"{staff['t3_b'] * s_ ** staff['t3_q'] * up.REF_RATING / int(d['corps_number']):.3f}" if s_ else "1"
            t = tow.get(key)
            e = eq.get(key)
            n_tow += t is not None
            n_eq += e is not None
            w.writerow([d["faction_key"], d["army_corps_name"], d["corps_number"], int(d["faction_key"] in only),
                        d["unit_key"], d["kind"], d["unit_class"], d["list_price"], d["brigade_effective_price"],
                        d["division_effective_price"], d["brigade_rebate_pct"], d["division_rebate_pct"],
                        d["support_division"], pred_adopted.get(key, ""), pred_size.get(key, ""),
                        size_form.get(arm, "") if key in pred_size else "", general,
                        t["tow_faction_key"] if t else "", t["n_tow"] if t else "", t["p_tow"] if t else "",
                        e["tow_eq_own_n"] if e else "", e["tow_eq_own_n_low"] if e else "",
                        e["tow_eq_own_n_high"] if e else "", e["tow_eq_n8"] if e else ""])
    up.log(f"price database: {len(disc)} AC cards, {n_tow} with a ToW price, {n_eq} with a ToW-equivalent estimate; "
           f"best size forms {size_form} → {(OUT / 'ac_price_database.csv').relative_to(up.ROOT)}", started)


BLIND = common.ANALYSIS / "ac_blind"


def blind_data_phase(seeds: int, started: float) -> None:
    """The blind study's data: every AC row of the analysis dataset (all columns), the
    corps number, and the folds this script uses — so the blind models are scored on the
    identical folds. Regular units carry their arm slice's fold; a combat-general version
    takes its regular unit's fold (as commander_model.py does); staff generals the staff
    slice's fold. `corps_holdout` marks the 17 AC-only corps (the unseen-corps test)."""
    fold: dict[tuple[str, str], int] = {}
    for arm in up.ARMS:
        path = ckpt.slice_path("ac", arm, seeds)
        if not path.exists():
            raise SystemExit(f"{path.name} missing: run --phase model --arm {arm} first")
        sl = common.load_pickle(path)
        for (train, test), k in zip(sl.plan.folds, range(1, 6)):
            for i in test:
                fold[(sl.units[i].faction, sl.units[i].key)] = k
    # Staff generals: unit_pricing's staff fold plan scores only a subset (identical
    # generals are grouped and tested once), so the blind data gets its own partition —
    # generals with the same stars and corps number share a fold, groups dealt round-robin
    # in a fixed shuffled order.
    _, staff = ac_units()
    ratings = up.load_ratings()
    groups = sorted({(g.stars, g.rating) for g in staff})
    order = np.random.default_rng(0).permutation(len(groups))
    group_fold = {groups[j]: 1 + rank % 5 for rank, j in enumerate(order)}
    for g in staff:
        fold[(g.faction, g.key)] = group_fold[(g.stars, g.rating)]
    only = ac_only_factions()
    (BLIND / "data").mkdir(parents=True, exist_ok=True)
    with up.DATA_CSV.open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        rows = [r for r in reader if r["faction_kind"] == "army_corps"]
        columns = list(reader.fieldnames or [])
    n_fold = 0
    with open(BLIND / "data" / "ac_units.csv", "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(columns + ["corps_number", "fold", "corps_holdout"])
        for r in rows:
            key = (r["faction_key"], r["unit_key"])
            k = fold.get(key) or fold.get((r["faction_key"], re.sub(r"_com_\d+$", "", r["unit_key"])))
            n_fold += k is not None
            w.writerow([r[c] for c in columns] + [ratings[r["faction_key"]], k or "", int(r["faction_key"] in only)])
    up.log(f"blind data: {len(rows)} AC rows, {n_fold} with a fold → {(BLIND / 'data').relative_to(up.ROOT)}", started)


# --- Main ----------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--phase", choices=("model", "staff", "size", "commanders", "blind-data", "database", "report"), required=True)
    parser.add_argument("--dataset", choices=("ac", "tow"), default="ac", help="size phase: AC or ToW + Custom units")
    parser.add_argument("--arm", choices=up.ARMS)
    parser.add_argument("--seeds", type=int, default=500)
    parser.add_argument("--workers", type=int, default=up.WORKERS)
    parser.add_argument("--fresh", action="store_true")
    args = parser.parse_args()
    up.configure(workers=max(1, args.workers))
    started = time.time()
    if args.phase == "model":
        if not args.arm:
            raise SystemExit("--phase model needs --arm")
        model_phase(args.arm, args.seeds, args.fresh, started)
    elif args.phase == "staff":
        staff_phase(args.fresh, args.seeds, started)
    elif args.phase == "size":
        if not args.arm:
            raise SystemExit("--phase size needs --arm")
        size_phase(args.dataset, args.arm, args.seeds, args.fresh, started)
    elif args.phase == "commanders":
        commander_phase(args.seeds, started)
    elif args.phase == "database":
        database_phase(started)
    elif args.phase == "blind-data":
        blind_data_phase(args.seeds, started)
    else:
        report_phase(started)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
