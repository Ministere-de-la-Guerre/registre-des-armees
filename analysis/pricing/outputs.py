"""The output files: report, search results, coefficients, out-of-fold predictions.

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

import csv

import numpy as np

from pricing import config
from pricing.constants import GROUPING, MULT_CATEGORICAL, POWER_SCALE, RATE_SCALE, REF_RATING, SHAPE_DEFAULTS
from pricing.cv import full_fit_prices
from pricing.staff import STAFF_RATING_NAMES, staff_full
from pricing.results import Results
from pricing.report import report_lines


# --- Output -------------------------------------------------------------------

def write_outputs(res: Results) -> None:
    config.settings.out_dir.mkdir(parents=True, exist_ok=True)
    write_search(res)
    write_coefficients(res)
    write_oof(res)
    (config.settings.out_dir / "unit_pricing_report.md").write_text("\n".join(report_lines(res)) + "\n", encoding="utf-8")


def write_search(res: Results) -> None:
    with (config.settings.out_dir / "search_results.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\r\n")
        writer.writerow(["arm", "rank", "size", "p", "linear", "multiplicative", "const_c", "params", "mae_mean",
                         "mae_sd", "mape_mean", "r2_mean", "best", "headline"])
        for arm, s in res.search.items():
            for rank, run in enumerate(s.runs, 1):
                writer.writerow([arm, rank, run.spec.size, run.spec.p, " ".join(sorted(run.spec.linear)),
                                 " ".join(sorted(run.spec.mult)), int(run.spec.const), run.params,
                                 f"{run.mean('mae'):.4f}", f"{run.sd('mae'):.4f}", f"{run.mean('mape'):.4f}",
                                 f"{run.mean('r2'):.5f}", int(run is s.best), int(run is s.headline)])


def write_coefficients(res: Results) -> None:
    with (config.settings.out_dir / "coefficients.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\r\n")
        writer.writerow(["model", "slice", "variant", "feature", "coefficient", "note"])
        for (arm, side), sl in res.slices.items():
            for key in ("final", "RF", "FC"):
                if key not in sl.runs:
                    continue
                run = sl.runs[key]
                model, spec = run.full, run.spec
                refs = "reference levels: " + "; ".join(f"{k}={v}" for k, v in run.references.items())
                writer.writerow([arm, side, key, "size", spec.size, "models = men_raw/2" if spec.size == "n" else "guns"])
                writer.writerow([arm, side, key, "size power p", f"{spec.p:g}", "price ∝ size^p"])
                for shape_key in SHAPE_DEFAULTS:
                    writer.writerow([arm, side, key, f"shape {shape_key}", spec.shape_of(shape_key),
                                     "how shooting / firearm / calibre enter β·x (see SHAPE_DEFAULTS)"])
                for stat, a in spec.powers:
                    if stat.startswith("shoot:"):
                        note = (f"exponent inside shoot = Π (stat/{POWER_SCALE:g})^a × ({RATE_SCALE:g}/gun reload "
                                f"time)^a_rate; absent exponents are 1")
                    elif stat.startswith("cal:"):
                        source = "projectile damage" if stat == "cal:damage" else "range"
                        note = f"calibre column = ({source} / {POWER_SCALE:g})^power"
                    else:
                        note = f"the β column is (stat / {POWER_SCALE:g})^power"
                    writer.writerow([arm, side, key, f"stat power {stat}", f"{a:g}", note])
                writer.writerow([arm, side, key, "(intercept: per-size constant b0)", f"{model.b0:.10g}",
                                 spec.describe() + " | " + refs])
                for name, coef in zip(run.names, model.beta):
                    writer.writerow([arm, side, key, name, f"{coef:.10g}", "gold per size unit^p"])
                if spec.const:
                    writer.writerow([arm, side, key, "c (per unit, outside the multiplier)", f"{model.c:.10g}", "gold per unit"])
                if spec.fixed_rating:
                    writer.writerow([arm, side, key, "rating divisor", f"{REF_RATING}/rating",
                                     "fixed; scales the β part like a multiplier"])
                for var in sorted(spec.mult):
                    if var in MULT_CATEGORICAL:
                        note = (f"ridge κ = {spec.kappa:g}, no reference (unseen cell → 1)" if var in GROUPING
                                else f"reference {model.refs[var]}")
                        for level, m in sorted(model.levels[var].items(), key=lambda t: str(t[0])):
                            writer.writerow([arm, side, key, f"multiplier {var}={level}", f"{m:.10g}", note])
                    else:
                        writer.writerow([arm, side, key, f"multiplier {var} δ", f"{model.delta[var]:.10g}",
                                         f"m = 1 + δ·({var} − {model.refs[var]:g})"])
                for faction, m in sorted(model.faction_m.items()):
                    writer.writerow([arm, side, key, f"faction modifier {faction}", f"{m:.10g}",
                                     "per-arm; multiplies the scaled part"])
                for cell, m in sorted(model.fclass_m.items()):
                    writer.writerow([arm, side, key, f"faction×class modifier {cell}", f"{m:.10g}",
                                     f"residual, ridge κ = {spec.kappa:g}; multiplies faction modifier × scaled part"])
        for side, mods in res.shared_m.items():
            for faction, m in sorted(mods.items()):
                writer.writerow(["all arms", side, "RFs", f"faction modifier {faction}", f"{m:.10g}",
                                 "one per corps across arms; multiplies each arm's scaled part"])
        for side, ss in res.staff_slices.items():
            for form in ("T1", "T2", "T3"):
                coef, _, fm = staff_full(ss.gens, form)
                note = (f"cost = b·stars^q·({REF_RATING}/r); 1 without stars" if form == "T3"
                        else "cost = 1 + …; r − 8")
                for name, c in zip(STAFF_RATING_NAMES[form], coef):
                    writer.writerow(["staff", side, form, name, f"{c:.10g}", note])
                for faction, m in sorted(fm.items()):
                    writer.writerow(["staff", side, f"TF{form[1]}", f"faction modifier {faction}", f"{m:.10g}",
                                     "multiplies (cost − 1)"])


def write_oof(res: Results) -> None:
    with (config.settings.out_dir / "oof_predictions.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\r\n")
        writer.writerow(["model", "slice", "unit_key", "faction_key", "army_corps_name", "side", "rating",
                         "unit_class", "speed", "n_models", "guns", "cost", "fold",
                         "oof_final", "oof_final_faction", "oof_final_faction_shared", "oof_final_faction_class",
                         "resid_pct_final", "full_fit_pred_final"])
        cell = lambda v: "" if not np.isfinite(v) else f"{v:.3f}"   # NaN = pinned to train
        for (arm, side), sl in res.slices.items():
            fin, rf, rfs = sl.runs["final"], sl.runs["RF"], sl.runs["RFs"]
            fc = sl.runs.get("FC")
            full_pred = full_fit_prices(fin, sl.units, arm)
            for i, u in enumerate(sl.units):
                resid = (u.cost - fin.oof[i]) / fin.oof[i] * 100 if np.isfinite(fin.oof[i]) else np.nan
                writer.writerow([arm, side, u.key, u.faction, u.corps, u.side, u.rating, u.unit_class,
                                 "DR" if u.is_camel else u.speed, f"{u.n:g}", f"{u.guns:g}", u.cost,
                                 fin.oof_fold[i] or "", cell(fin.oof[i]), cell(rf.oof[i]), cell(rfs.oof[i]),
                                 cell(fc.oof[i]) if fc else "", cell(resid), f"{full_pred[i]:.3f}"])
        for side, ss in res.staff_slices.items():
            fold_of = np.zeros(len(ss.gens), int)
            for k, (_, test) in enumerate(ss.plan.folds):
                fold_of[test] = k + 1
            _, full_p, _ = staff_full(ss.gens, res.staff_head)
            rate, rf = ss.runs[res.staff_head], ss.runs[f"TF{res.staff_head[1]}"]
            for i, g in enumerate(ss.gens):
                resid = ((g.cost - rate.oof[i]) / rate.oof[i] * 100
                         if np.isfinite(rate.oof[i]) and rate.oof[i] else np.nan)
                writer.writerow(["staff", side, g.key, g.faction, g.corps, g.side, g.rating, "general_staff",
                                 f"stars={g.stars}", 16, "", g.cost, fold_of[i] or "",
                                 cell(rate.oof[i]), cell(rf.oof[i]), "", "", cell(resid), f"{full_p[i]:.3f}"])
