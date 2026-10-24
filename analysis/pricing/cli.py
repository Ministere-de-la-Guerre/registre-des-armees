"""unit_pricing's command line: the full run, phase by phase.

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

import argparse
import sys
import time
from dataclasses import replace
from pathlib import Path

import numpy as np

from common import ARMS, CATALOG_CSV, DATA_CSV, ROOT, log
import pricing
from pricing import config
from pricing.config import configure
from pricing.constants import ABLATIONS, CATEGORICAL, POLAND, SIDES, SIZE_KINDS
from pricing.data import load, load_ratings
from pricing.spec import Spec, with_powers
from pricing.design import design_for
from pricing.model import metrics
from pricing.splits import group_ids, restrict, unidentified
from pricing.formatting import pct_resid
from pricing.cv import (
    PREVIOUS_FINAL, cv_baseline, cv_spec, data_for, fit_on, make_slice, predict_total, rich_design, side_spec,
    slice_units)
from pricing.search import (
    ARTILLERY_CAL_KEYS, PowerResult, VariantResult, nested_fine, profile_p, screen_variants, structure_search,
    variant_details)
from pricing.fclass import FCLASS_FORM, FclassResult, fclass_cv, shared_faction_runs
from pricing.staff import make_staff_slice, staff_coverage, staff_cv
from pricing.results import Results
from pricing.outputs import write_outputs


# --- Main ---------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=pricing.__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seeds", type=int, default=500, help="split seeds to search (default 500)")
    parser.add_argument("--linear", action="store_true",
                        help="fully linear run: size = models, p = 1, linear stats (no size or stat powers)")
    parser.add_argument("--out", type=Path, default=None, help="output directory (default analysis/output)")
    parser.add_argument("--artillery-cal", choices=["auto", *ARTILLERY_CAL_KEYS], default="auto",
                        help="artillery calibre representations to screen: all (auto), or only F0 plus this one")
    parser.add_argument("--workers", type=int, default=config.settings.workers,
                        help="worker processes for the nested power searches "
                             f"(default {config.settings.workers}; 1 = serial)")
    args = parser.parse_args()
    if args.out is not None:
        configure(out_dir=args.out.resolve())
    configure(artillery_cal=args.artillery_cal, workers=args.workers)
    started = time.time()

    for path in (DATA_CSV, CATALOG_CSV):
        if not path.exists():
            print(f"missing {path} — run tools/build_analysis_dataset.py first", file=sys.stderr)
            return 1
    ratings = load_ratings()
    units, staff, unparsed, unrated = load(ratings)
    if unparsed or unrated:
        print(f"unparseable speed tags {unparsed[:3]} / corps without rating {unrated}", file=sys.stderr)
        return 1
    tag_mismatches = [u for u in units if u.raw_tag != u.speed_code]
    log(f"loaded {len(units)} regular units, {len(staff)} staff generals", started)

    slices = {(arm, side): make_slice(arm, side, slice_units(units, arm, side), args.seeds)
              for arm in ARMS for side in SIDES}

    # 1. Regression check: last run's finals (models, p = 1, linear stats).
    regression = {}
    for arm in ARMS:
        spec, _ = PREVIOUS_FINAL[arm]
        regression[arm] = cv_spec(spec, slices[(arm, "merged")].units, slices[(arm, "merged")].plan.folds, arm,
                                  full_fit=False)
        log(f"regression {arm:9} MAE {regression[arm].mean('mae'):.4f} (previous {PREVIOUS_FINAL[arm][1]})", started)

    # 2. Size power profile on last run's final structure, with and without c.
    # In --linear mode the "profile" is the single point size = models, p = 1.
    kinds_for = (lambda arm: ("n",)) if args.linear else (lambda arm: SIZE_KINDS[arm])
    grid = (1.0,) if args.linear else config.settings.p_grid
    profiles = {}
    for arm in ARMS:
        spec, _ = PREVIOUS_FINAL[arm]
        profiles[arm] = profile_p(spec, slices[(arm, "merged")], kinds_for(arm), (False, True), grid)
        pr = profiles[arm]
        log(f"profile   {arm:9} best size={pr.best_size} p={pr.best_p} c={pr.best_const} MAE {pr.best_mae:.2f}", started)

    # 3. Structure re-search with each arm's size and p*, then re-profile p.
    search, reprofiles, headline = {}, {}, {}
    for arm in ARMS:
        pr = profiles[arm]
        search[arm] = structure_search(slices[(arm, "merged")], pr.best_size, pr.best_p)
        head = search[arm].headline.spec
        reprofiles[arm] = profile_p(head, slices[(arm, "merged")], (pr.best_size,), (head.const,), grid)
        headline[arm] = replace(head, p=reprofiles[arm].best_p)
        log(f"search    {arm:9} {len(search[arm].runs)} models; headline [{headline[arm].describe()}] "
            f"MAE {reprofiles[arm].best_mae:.2f}", started)

    # 3b. Linear-part ablations on the headline.
    ablations: dict[str, list] = {}
    pre_power: dict[str, Spec] = {}
    for arm in ARMS:
        sl = slices[(arm, "merged")]
        head = cv_spec(headline[arm], sl.units, sl.plan.folds, arm, full_fit=False)
        accepted: frozenset[str] = frozenset()
        ablations[arm] = []
        for group, options in ABLATIONS[arm].items():
            runs = [(label, cv_spec(replace(headline[arm], extras=extras), sl.units, sl.plan.folds, arm,
                                    full_fit=False, label=label)) for label, extras in options]
            label, best = min(runs, key=lambda t: t[1].mean("mae"))
            keep = best.mean("mae") < head.mean("mae") - head.se("mae")
            for lab, run in runs:
                ablations[arm].append((group, lab, run, keep and lab == label, head))
            if keep:
                accepted |= best.spec.extras
        pre_power[arm] = replace(headline[arm], extras=accepted)

    # 4. Shape variants (firearm/calibre representation × shooting cluster), each
    #    with stat powers fitted by nested coarse descent; then the fine search on
    #    the adopted variant.
    powers: dict[str, PowerResult] = {}
    variants: dict[str, list[VariantResult]] = {}
    variant_detail: dict[str, dict] = {}
    final: dict[str, Spec] = dict(pre_power) if args.linear else {}
    for arm in ARMS if not args.linear else ():
        sl = slices[(arm, "merged")]
        variants[arm] = screen_variants(pre_power[arm], sl, lambda m: log(m, started))
        adopted = next(v for v in variants[arm] if v.adopted)
        variant_detail[arm] = variant_details(variants[arm], sl)
        pw = powers[arm] = adopted.power
        spec = adopted.spec
        log(f"adopted   {arm:9} {adopted.label} (nested {pw.nested.mean('mae'):.2f})", started)
        # 4b. Fine local refinement around the adopted variant's coarse powers, nested again.
        pw.fine = nested_fine(spec, sl, pw)
        fine = pw.fine
        if fine.choice == "fine":
            final[arm] = with_powers(spec, fine.full_powers, fine.full_p)
        elif fine.choice == "coarse":
            final[arm] = with_powers(spec, pw.full_powers, pw.full_p)
        else:
            final[arm] = spec
        log(f"fine      {arm:9} fine nested {fine.nested.mean('mae'):.2f} → choice {fine.choice}; "
            f"final [{final[arm].describe()}]", started)

    # 5. Final model on every slice, baseline, faction modifiers (+ faction × class).
    fclass: dict[tuple[str, str], FclassResult] = {}
    for arm in ARMS:
        for side in SIDES:
            sl = slices[(arm, side)]
            spec = final[arm] if side == "merged" else side_spec(final[arm])
            sl.runs["baseline"] = cv_baseline(sl.units, sl.plan.folds)
            sl.runs["final"] = cv_spec(spec, sl.units, sl.plan.folds, arm, label="final model")
            sl.runs["RF"] = cv_spec(replace(spec, faction=True), sl.units, sl.plan.folds, arm,
                                    label="final × per-arm faction modifier")
            if FCLASS_FORM:
                variant, loss = FCLASS_FORM
                fc = fclass_cv(variant, replace(spec, loss=loss), sl.units, sl.plan.folds, arm)
                sl.runs["FC"], fclass[(arm, side)] = fc.run, fc
    shared_m: dict[str, dict[str, float]] = {}
    for side in SIDES:
        runs, shared_m[side] = shared_faction_runs(slices, side, final)
        for arm in ARMS:
            slices[(arm, side)].runs["RFs"] = runs[arm]
    log("final models and faction modifiers done" + (
        "; faction × class " + ", ".join(f"{arm} {slices[(arm, 'merged')].runs['FC'].mean('mae'):.2f}" for arm in ARMS)
        if FCLASS_FORM else ""), started)

    # 5b. Packing vs unit size on the final model.
    packing: dict[str, dict] = {}
    for arm in ARMS:
        sl = slices[(arm, "merged")]
        spec = final[arm]
        rd = np.array([u.rank_depth for u in sl.units])
        n = np.array([u.n for u in sl.units])
        packing_variants = [("final model", spec), ("+ size multiplier", replace(spec, mult=spec.mult | {"size"}))]
        if "rank_depth" in spec.mult | spec.linear:
            no_rd = replace(spec, mult=spec.mult - {"rank_depth"}, linear=spec.linear - {"rank_depth"})
            packing_variants.append(("rank_depth removed", no_rd))
        else:
            packing_variants.append(("+ rank_depth multiplier", replace(spec, mult=spec.mult | {"rank_depth"})))
        runs = []
        for label, variant in packing_variants:
            run = cv_spec(variant, sl.units, sl.plan.folds, arm, label=label)
            note = "; ".join(f"δ_{v} = {run.full.delta[v]:+.4f} (ref {run.full.refs[v]:g})"
                             for v in ("rank_depth", "size") if v in variant.mult)
            runs.append((label, run, note))
        packing[arm] = {"corr": float(np.corrcoef(rd, n)[0, 1]), "runs": runs}

    # 6. 7. Poland: same folds minus Poland's rows, on the final model.
    poland: dict[tuple[str, str], dict] = {}
    for arm in ARMS:
        for side in ("imperial", "merged"):
            sl = slices[(arm, side)]
            keep = np.array([u.faction != POLAND for u in sl.units])
            if keep.all():
                continue
            kept = [u for u, k in zip(sl.units, keep) if k]
            rich = rich_design(kept, arm)
            plan = restrict(sl.plan, keep, rich.X, sl.groups[keep], rich.names)
            spec = final[arm] if side == "merged" else side_spec(final[arm])
            without = cv_spec(spec, kept, plan.folds, arm, label="without Poland")
            with_run = sl.runs["final"]
            resid = pct_resid(np.array([u.cost for u in sl.units], float)[~keep], with_run.oof[~keep])
            resid = resid[np.isfinite(resid)]
            poland[(arm, side)] = {"with": with_run, "without": without, "n": int((~keep).sum()),
                                   "median_resid": float(np.median(resid)),
                                   "share_over": float(np.mean(resid > 0) * 100)}

    # 7. Transfer: imperial → coalition and back, final model (side dropped), merged columns.
    transfer: dict[tuple[str, str], dict] = {}
    for arm in ARMS:
        spec = side_spec(final[arm])
        merged = slices[(arm, "merged")]
        design, d = design_for(spec, merged.units, arm), data_for(spec, merged.units)
        sides = np.array([u.side for u in merged.units])
        for source, target in (("imperial", "coalition"), ("coalition", "imperial")):
            train, test = np.flatnonzero(sides == source), np.flatnonzero(sides == target)
            model = fit_on(spec, design, d, train)
            pred = predict_total(model, design, d, test)
            bad = unidentified(design.X, train, test)
            affected = np.any(design.X[test][:, bad] != design.X[train][0, bad], axis=1) if bad.any() \
                else np.zeros(len(test), bool)
            for var in spec.mult & set(CATEGORICAL):
                affected |= ~np.isin(d.fvals[var][test], list(model.levels[var]))
            m = metrics(d.cost[test], pred, d.size[test])
            m["affected"] = int(affected.sum())
            m["unidentified"] = [design.names[j] for j in np.flatnonzero(bad)]
            m["unseen_ratings"] = sorted(set(d.fvals["rating"][test].tolist()) - set(d.fvals["rating"][train].tolist()))
            in_side = slices[(arm, target)].runs["final"]
            m["in_side_mae"], m["in_side_mape"] = in_side.mean("mae"), in_side.mean("mape")
            transfer[(arm, f"{source} → {target}")] = m

    # 8. Staff generals.
    staff_slices = {side: make_staff_slice(side, [g for g in staff if side == "merged" or g.side == side], args.seeds)
                    for side in SIDES}
    staff_head = min(("T1", "T2", "T3"), key=lambda k: staff_slices["merged"].runs[k].mean("mae"))
    staff_poland: dict[str, dict] = {}
    for side in ("imperial", "merged"):
        ss = staff_slices[side]
        keep = np.array([g.faction != POLAND for g in ss.gens])
        kept = [g for g, k in zip(ss.gens, keep) if k]
        C, names = staff_coverage(kept)
        plan = restrict(ss.plan, keep, C, group_ids(C, [0] * len(kept)), names)
        runs = staff_cv(kept, plan.folds)
        cost = np.array([g.cost for g in ss.gens], float)
        staff_poland[side] = {"n": int((~keep).sum()), "key": staff_head,
                              "with_mae": ss.runs[staff_head].mean("mae"), "without_mae": runs[staff_head].mean("mae"),
                              "resid": float(np.nanmean(cost[~keep] - ss.runs[staff_head].oof[~keep]))}

    res = Results(units, staff, slices, regression, profiles, search, reprofiles, ablations, powers, final, packing,
                  poland, transfer, staff_slices, staff_head, staff_poland, tag_mismatches, ratings, args.seeds, shared_m,
                  linear=args.linear, variants=variants, variant_detail=variant_detail, fclass=fclass)
    res.elapsed = time.time() - started
    write_outputs(res)
    out_dir = config.settings.out_dir
    log(f"done → {out_dir.relative_to(ROOT) if out_dir.is_relative_to(ROOT) else out_dir}", started)
    return 0
