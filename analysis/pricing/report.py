"""The markdown report, unit_pricing_report.md: every table and paragraph of a full run.

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

from collections import Counter, defaultdict

import numpy as np

from common import ARMS, table
from pricing import config
from pricing.constants import (
    DEV_CORPS, EXTRA_ABILITIES, FINE_P_HALF, FINE_P_STEP, FINE_STAT_HALF, FINE_STAT_STEP, MIN_POWER, NUMERIC,
    POLAND, P_WINDOW, RATE_SCALE, REF_RATING, SIDES)
from pricing.data import Unit
from pricing.formatting import describe_factors, f1, f2, f3, pct_resid, pm, spearman
from pricing.cv import PREVIOUS_FINAL, full_fit_prices, size_of
from pricing.search import ARTILLERY_CAL_KEYS
from pricing.fclass import FCLASS_FORM, FCLASS_LABEL, fclass_multiplier
from pricing.staff import STAFF_RATING_NAMES, staff_full
from pricing.diagnostics import eastern_calibre_rows, firearm_range_overlap
from pricing.results import Results


# --- Report -------------------------------------------------------------------

def corps_resid_stats(res: Results, key: str, min_units: int = 20):
    """Per corps (merged slices, three arms pooled): units, mean/median resid %, share above."""
    per: dict[str, list[float]] = defaultdict(list)
    for arm in ARMS:
        sl = res.slices[(arm, "merged")]
        r = pct_resid(np.array([u.cost for u in sl.units], float), sl.runs[key].oof)
        for u, value in zip(sl.units, r):
            if np.isfinite(value):
                per[u.faction].append(float(value))
    return [(f, len(v), float(np.mean(v)), float(np.median(v)), float(np.mean(np.array(v) > 0) * 100))
            for f, v in per.items() if len(v) >= min_units]


def bargains(res: Results, arm: str) -> tuple[list[dict], list[dict]]:
    """Top 10 by absolute and by relative funds saved: model price − actual.
    Out-of-fold predictions (full-fit for the few units pinned to train),
    identical (name, corps, cost) rows merged, non-positive predictions skipped."""
    sl = res.slices[(arm, "merged")]
    run = sl.runs["final"]
    full = full_fit_prices(run, sl.units, arm)
    groups: dict[tuple, dict] = {}
    for i, u in enumerate(sl.units):
        pinned = not np.isfinite(run.oof[i])
        pred = float(full[i] if pinned else run.oof[i])
        if pred <= 0:
            continue
        key = (u.name, u.corps, u.cost, round(pred))
        item = groups.setdefault(key, {"unit": u, "pred": pred, "pinned": pinned, "count": 0})
        item["count"] += 1
    items = list(groups.values())
    for item in items:
        item["saved"] = item["pred"] - item["unit"].cost
        item["rel"] = item["saved"] / item["pred"] * 100
    return (sorted(items, key=lambda t: -t["saved"])[:10], sorted(items, key=lambda t: -t["rel"])[:10])


def power_key_order(res: "Results") -> list[str]:
    """Every exponent key used by any arm's adopted variant (coarse or fine):
    additive stats in NUMERIC order, then shooting / calibre keys."""
    used = set()
    for pw in res.powers.values():
        used |= set(pw.full_powers)
        if pw.fine:
            used |= set(pw.fine.full_powers)
    return [k for k in NUMERIC if k in used] + sorted(used - set(NUMERIC))


def fclass_report(res: Results, top: int = 8) -> list[str]:
    """Section 10b: the adopted faction × unit-class modifier."""
    variant, loss = FCLASS_FORM
    L = [f"### Faction × unit-class modifier ({FCLASS_LABEL[variant]}{', LAD loss' if loss == 'lad' else ''})", "",
         "From the blind study (branch `blind-pricing-study`; tested in `blind_ideas_report.md`): NTW3 prices look "
         "hand-set per corps *per unit class*, which one faction modifier per arm cannot capture. "
         + ("Here each faction × class cell multiplies the final model × faction modifier, shrunk towards 1 "
            "(stats fitted first, unchanged). " if variant == "RFC" else
            f"Here the free rating levels are replaced by the divisor {REF_RATING}/N and each faction × class cell "
            "is a multiplier fitted jointly with the stat coefficients. ")
         + "A cell's ridge pull is κ pseudo-units of average price at 1; κ is chosen by inner CV inside each outer "
           "training fold (an unseen cell falls back to its faction / to 1).", ""]
    rows = []
    for (arm, side), fc in res.fclass.items():
        sl = res.slices[(arm, side)]
        rf = sl.runs["RF"]
        diff = np.array([a["mae"] - b["mae"] for a, b in zip(fc.run.fold_metrics, rf.fold_metrics)])
        rows.append([arm, side, pm(rf, "mae", f1), pm(fc.run, "mae", f1), pm(fc.run, "mape", f1),
                     f"{diff.mean():+.2f} ± {diff.std(ddof=1) / np.sqrt(len(diff)):.2f}",
                     ", ".join(f"{k:g}" for k in fc.kappas), f"{fc.full_kappa:g}", fc.run.fallbacks])
    L += table(["arm", "side", "MAE + per-arm m_f", "MAE + faction × class", "MAPE %", "Δ vs m_f (paired SE)",
                "κ per fold", "κ full fit", "test rows in unseen cells"], rows)
    L += [""]
    for arm in ARMS:
        fc = res.fclass.get((arm, "merged"))
        if not fc:
            continue
        sl = res.slices[(arm, "merged")]
        cells: dict[str, list[Unit]] = defaultdict(list)
        for u in sl.units:
            cells[f"{u.faction}|{u.unit_class}"].append(u)
        ranked = sorted((fclass_multiplier(fc.run.full, us[0]), us[0].corps, us[0].unit_class, len(us))
                        for us in cells.values())
        L += [f"**{arm}** — most extreme cells, army multiplier relative to the plain {REF_RATING}/N rule "
              f"(full-data fit, κ = {fc.full_kappa:g}):", ""]
        L += table(["corps", "unit class", "units", "multiplier"],
                   [[c, uc, n, f"×{m:.3f}"] for m, c, uc, n in ranked[:top] + ranked[-top:]])
        L += [""]
    return L


def report_lines(res: Results) -> list[str]:
    L: list[str] = []
    add = L.append
    slices, ratings = res.slices, res.ratings
    add("# Unit-pricing model — ToW + Custom")
    add("")
    add("Generated by `analysis/unit_pricing.py` from `data/generated/ntw3_units_analysis.csv` and the corps "
        f"ratings in `army_corps_catalog.csv`. {res.n_seeds} split seeds searched per slice; run time "
        f"{res.elapsed / 60:.0f} min.")
    add("")
    add("**Structure.** `price = M × size^p × (b0 + Σ β_j·stat_j^(a_j) + flags + categoricals) + c`. The parts:")
    add("")
    add("- **size** is models (men_raw / 2) for infantry and cavalry, and **guns** for artillery.")
    add("- **p** is profiled by cross-validation.")
    add("- **a_j** are per-stat powers, fitted inside each training fold.")
    add("- **M** is a product of factors.")
    add("- **c** is a flat per-unit constant, outside the multiplier.")
    add("")
    add("Corps rating, training level, drill set, packing (`rank_depth`) and side are each searched "
        "in three placements: out of the model, in β·x, or as a factor of M.")
    add("")
    add("**Residual sign.** `resid % = (actual − predicted) / predicted`. Positive means the game charges more "
        "than the model.")
    add("")

    # ---- Summary
    add("## Summary")
    add("")
    add("Merged slices, mean over the 5 out-of-fold splits, shown as MAPE % / MAE gold. *Previous* is the last "
        "run's final model (models, p = 1, linear stats), refitted here on the same folds.")
    add("")
    rows = []
    has_fc = "FC" in slices[(ARMS[0], "merged")].runs
    for arm in ARMS:
        sl = slices[(arm, "merged")]
        b, f_, r_, s_ = sl.runs["baseline"], sl.runs["final"], sl.runs["RF"], sl.runs["RFs"]
        shown = (b, res.regression[arm], f_, r_, s_) + ((sl.runs["FC"],) if has_fc else ())
        rows.append([arm] + [f"{f1(run.mean('mape'))}% / {f1(run.mean('mae'))}" for run in shown] +
                    [f3(f_.mean("r2")), f"`{res.final[arm].describe()}`"])
    L += table(["arm", "baseline", "previous", "final", "final + per-arm faction", "final + shared faction"] +
               ([f"{FCLASS_LABEL[FCLASS_FORM[0]]}" + (" (LAD)" if FCLASS_FORM[1] == "lad" else "")] if has_fc else []) +
               ["R² final", "final structure"], rows)
    add("")
    ss = res.staff_slices["merged"]
    add(f"Staff generals (merged): {res.staff_head} MAE "
        f"{f1(ss.runs[res.staff_head].mean('mae'))}, with faction modifier MAE "
        f"{f1(ss.runs['TF' + res.staff_head[1]].mean('mae'))}.")
    add("")

    # ---- 1. Population & checks
    add("## 1. Population and data checks")
    add("")
    counts = Counter((u.arm, u.side) for u in res.units)
    rows = [[arm, counts[(arm, "imperial")], counts[(arm, "coalition")],
             counts[(arm, "imperial")] + counts[(arm, "coalition")]] for arm in ARMS]
    rows.append(["staff generals", sum(g.side == "imperial" for g in res.staff),
                 sum(g.side == "coalition" for g in res.staff), len(res.staff)])
    L += table(["arm", "imperial", "coalition", "merged"], rows)
    add("")
    add(f"- Scope: ToW + Custom, excluding dev corps ({', '.join(sorted(DEV_CORPS))}) and `artillery_fixed`. "
        "Custom `france` and `denmark` count as imperial; the other customs as coalition.")
    add("- **Traits and abilities in β·x:** the 9 description flags plus `guard_mode`, `skirmish` and "
        "`can_snipe`. Counts: " +
        ", ".join(f"`{a}` {sum(u.values[a] > 0 for u in res.units)}" for a in EXTRA_ABILITIES + ("pike_square",)) + ".")
    add(f"- Speed is read from each unit name's tag. It disagrees with the pipeline `speed_code` on "
        f"{len(res.tag_mismatches)} rows: " +
        ", ".join(f"`{u.key}` `[{u.raw_tag}]` vs `{u.speed_code}`" for u in res.tag_mismatches) +
        ". Camels carry `is_camel`; GS is folded into S.")
    crew = {cls: sorted({round(u.n / u.guns, 4) for u in res.units if u.unit_class == cls})
            for cls in ("artillery_foot", "artillery_horse")}
    add(f"- Artillery crew per gun is fixed by type: foot {crew['artillery_foot']}, horse "
        f"{crew['artillery_horse']}. That is why artillery is sized by guns.")
    add("")
    add("### Eastern artillery calibre — name vs what the game fires")
    add("")
    L += table(["name calibre", "≈ lb", "weapon", "projectile fired", "damage", "units", "note"],
               eastern_calibre_rows(res.units))
    add("")
    add("### Firearm vs range")
    add("")
    for arm in ("infantry", "cavalry"):
        o = firearm_range_overlap([u for u in res.units if u.arm == arm])
        add(f"- **{arm}**: {o['firearms']} firearms, {o['ranges']} distinct ranges, at most "
            f"{o['ranges_per_firearm_max']} range per firearm. Firearm explains **{o['eta2']:.1%}** of the "
            "variance in range, so the two can't be told apart.")
    add("")

    # ---- 2. Split quality
    add("## 2. Split quality — 5 × 80/20, stratified, coverage-guaranteed, faction-balanced")
    add("")
    rows = []
    for (arm, side), sl in slices.items():
        p = sl.plan
        cov = ", ".join(f"{fam} {b1}/{tot}" + ("" if mn == tot else f" (min {mn})")
                        for fam, (b1, mn, tot) in sl.coverage.items())
        lo, med, hi = p.balance_spread
        rows.append([arm, side, p.seed, p.violations_before_repair, len(p.repairs),
                     f"{lo:.0%} / {med:.0%} / {hi:.0%}", ", ".join(f"`{x}`" for x in p.pinned) or "—", cov])
    L += table(["arm", "side", "seed", "violations", "repairs", "faction test share fold 1",
                "pinned to train (not validated)", "levels in both sets, fold 1"], rows)
    add("")
    for (arm, side), sl in slices.items():
        for line in sl.plan.repairs:
            add(f"- Repair, {arm} / {side}: {line}")
    add("")

    # ---- 3. Regression check
    add("## 3. Fitter regression check")
    add("")
    add("The generalised fitter (size power and stat powers set to 1, size = models) must reproduce the "
        "previous run's final merged CV MAE on the same folds.")
    add("")
    L += table(["arm", "structure", "previous run", "reproduced", "match"],
               [[arm, f"`{PREVIOUS_FINAL[arm][0].describe()}`", f"{PREVIOUS_FINAL[arm][1]:.4f}",
                 f"{res.regression[arm].mean('mae'):.4f}",
                 "yes" if abs(res.regression[arm].mean("mae") - PREVIOUS_FINAL[arm][1]) < 0.001 else "**NO**"]
                for arm in ARMS])
    add("")

    # ---- 4. Size power
    add("## 4. Size power — how price scales with unit size")
    add("")
    if res.linear:
        add("**Fully linear run** (`--linear`): size = models for every arm (artillery too), p = 1, and linear "
            "stats. No size-power profile or stat powers are fitted. This reproduces the model as it stood before "
            "size and stat powers were introduced.")
    else:
        add("Last run's final structure with `size^p`, CV MAE for each p (every 0.10 shown). The bold cell is "
            "each curve's minimum, and a † marks p values within one SE of it. Artillery is profiled with both "
            "guns and models as the size.")
    add("")
    for arm, pr in ({} if res.linear else res.profiles).items():
        keys = list(pr.curves)
        header = ["p"] + [f"{'guns' if k == 'guns' else 'models'}{', + c' if c else ''}" for k, c in keys]
        minima = {key: min(curve, key=lambda t: t[1]) for key, curve in pr.curves.items()}
        rows = []
        for i, p in enumerate(config.settings.p_grid):
            if round(p * 100) % 10:
                continue
            row = [f"{p:.1f}"]
            for key in keys:
                _, mae, _ = pr.curves[key][i]
                best_p, best_mae, best_se = minima[key]
                cell = f1(mae)
                if p == best_p:
                    cell = f"**{cell}**"
                elif mae <= best_mae + best_se:
                    cell += " †"
                row.append(cell)
            rows.append(row)
        add(f"### {arm}")
        add("")
        add("Minimum per curve: " + "; ".join(
            f"{'guns' if k == 'guns' else 'models'}{' + c' if c else ''}: p = {minima[(k, c)][0]:g}, "
            f"MAE {f1(minima[(k, c)][1])}" for k, c in keys) + ".")
        add("")
        L += table(header, rows)
        add("")
        add(f"Chosen: size = **{'guns' if pr.best_size == 'guns' else 'models'}**, p* = **{pr.best_p:g}**. After "
            f"the structure re-search, p was re-profiled on the new headline: **p = "
            f"{res.reprofiles[arm].best_p:g}** (MAE {f1(res.reprofiles[arm].best_mae)}).")
        add("")

    # ---- 5. Structure search
    add("## 5. Structure search" + ("" if res.linear else " with the size power"))
    add("")
    add("Every combination of placements, each with and without `c`" +
        (" (size = models, p = 1)." if res.linear else ", at each arm's size and p*.") +
        " The headline is the model with the fewest parameters within one SE of the best.")
    add("")
    for arm, s in res.search.items():
        add(f"### {arm} — {len(s.runs)} models")
        add("")
        add(f"Best: `{s.best.spec.describe()}`, MAE {pm(s.best, 'mae', f1)} (SE {f2(s.best.se('mae'))}). "
            f"Headline: `{s.headline.spec.describe()}`, MAE {pm(s.headline, 'mae', f1)}, {s.headline.params} parameters.")
        add("")
        rows = []
        for var, places in s.placement.items():
            best_where = min(places, key=lambda k: places[k])
            rows.append([var] + [f"**{f1(places[w])}**" if w == best_where else f1(places[w])
                                 for w in ("out", "linear", "mult")])
        L += table(["variable", "out", "linear (in β·x)", "multiplicative (in M)"], rows)
        add("")
        rows = [[rank, f"`{run.spec.describe()}`" + (" **(headline)**" if run is s.headline else ""), run.params,
                 pm(run, "mae", f1), f1(run.mean("mape")), f3(run.mean("r2"))]
                for rank, run in enumerate(s.runs[:10], 1)]
        L += table(["rank", "structure", "params", "MAE (gold)", "MAPE %", "R²"], rows)
        if s.headline not in s.runs[:10]:
            add("")
            add(f"(Headline ranks {s.runs.index(s.headline) + 1}.)")
        add("")

    # ---- 6. Ablations
    add("## 6. Linear-part ablations on the headline")
    add("")
    rows = []
    for arm, items in res.ablations.items():
        for group, label, run, accepted, head in items:
            rows.append([arm, group, label, f1(head.mean("mae")), f1(run.mean("mae")),
                         f"{run.mean('mae') - head.mean('mae'):+.2f}", f2(head.se("mae")),
                         "**kept**" if accepted else "—"])
    L += table(["arm", "group", "option", "MAE headline", "MAE option", "Δ", "1 SE", "verdict"], rows)
    add("")

    # ---- 7. Stat powers
    add("## 7. Shooting, firearm / calibre representation, and stat powers")
    add("")
    if res.linear:
        add("Not fitted in the fully linear run: every stat enters β·x linearly.")
        add("")
    if res.variants:
        add("**Variants.** These change only how shooting and the firearm/calibre information enter β·x; "
            "everything else is the headline structure. Each is scored with its exponents fitted by nested "
            "coarse descent: the shooting-product exponents, the gun fire-rate exponent, the calibre exponent, "
            "the remaining additive stat powers, and p. **F0·SH0 is the current model.**")
        add("")
        add("- **F (infantry/cavalry):** F0 range; F1 firearm one-hot, with range dropped (each firearm has "
            "one range).")
        add("- **F (artillery):** F0 range + projectile damage + gun reload; F1 calibre = (damage/100)^a with "
            "the shot type, range and gun reload dropped; F2 cannon-type (projectile) one-hot.")
        add("- **SH:** SH0 accuracy, ammo and reload_skill additive; SH1 one shooting column "
            f"`Π (stat/100)^a × ({RATE_SCALE:g} / gun reload time)^a_rate`, so the crew's reload skill and the "
            "gun's intrinsic fire rate are separate factors; SH2 the same with one shooting slope per firearm "
            "or cannon type (artillery F1: calibre inside the product).")
        add("- Melee attack, defence and charge stay additive, like morale.")
        add("")
        add("**Adoption rule — summation is the default.** A shooting product is probably not how the game "
            "implements shooting, so:")
        add("")
        add("1. A product variant (SH1/SH2) is **eligible** only if it beats the summation variant with the same "
            "firearm/calibre representation (its F·SH0) by more than one SE.")
        add("2. An eligible variant replaces F0·SH0, the current model, only if it beats it by more than one SE.")
        add("3. Among those within one SE of the best, summation is preferred, then the fewest parameters.")
        add("")
        add("Cavalry error is already low (about 7.7% MAPE), so cavalry stays as it is unless a variant clears "
            "this bar.")
        add("")
        for arm, items in res.variants.items():
            current = items[0]
            rows = []
            for v in items:
                rows.append([f"`{v.key}`", v.label, f1(v.power.base.mean("mae")), pm(v.power.nested, "mae", f1),
                             f"{v.mean() - current.mean():+.2f}", f2(current.se()), f1(v.power.nested.mean("mape")),
                             v.params, v.unseen or "—",
                             "—" if v.key.endswith("SH0") else ("yes" if v.eligible else "no"),
                             "**adopted**" if v.adopted else ""])
            add(f"### {arm}")
            add("")
            L += table(["variant", "shape", "MAE, exponents = 1", "MAE nested (exponents fitted)", "Δ vs F0·SH0",
                        "1 SE (F0·SH0)", "MAPE nested", "params", "test rows with unseen levels",
                        "product beats its summation by > 1 SE", ""], rows)
            add("")
            keys = sorted({k for v in items for k in v.power.full_powers} - set(NUMERIC)) + \
                [k for k in NUMERIC if any(k in v.power.full_powers for v in items)]
            rows = [[f"`{k}`"] + [f"{v.power.full_powers[k]:g}" if k in v.power.full_powers else "—" for v in items]
                    for k in keys]
            rows.append(["size power p"] + [f"{v.power.full_p:g}" for v in items])
            add("Full-data exponents per variant (coarse grid; `shoot:rate` = gun fire-rate exponent, "
                "`cal:damage` = calibre exponent):")
            add("")
            L += table(["exponent"] + [f"`{v.key}`" for v in items], rows)
            add("")
            detail = res.variant_detail.get(arm, {})
            if "firearm" in detail:
                fd = detail["firearm"]
                add(f"Firearm coefficients in the best F1 variant (`{fd['variant']}`, full-data fit, gold per "
                    f"size unit^p, reference firearm `{fd['reference']}`):")
                add("")
                L += table(["column", "coefficient"], [[f"`{n}`", f"{c:+.4g}"] for n, c in fd["rows"]])
                add("")
            if "calibre" in detail:
                cd = detail["calibre"]
                add(f"Calibre curve in the best F1 variant (`{cd['variant']}`): calibre term = "
                    f"{cd['beta']:+.4g} × (damage/100)^{cd['a']:g}, in gold per gun^p, added to β·x. The shot "
                    "type's own coefficient sets each family's level.")
                add("")
                L += table(["projectile", "shot type", "damage", "calibre term"],
                           [[f"`{p}`", s, f"{d:g}", f"{t:+.1f}"] for p, s, d, t in cd["rows"]])
                add("")
            if "cannon" in detail:
                kd = detail["cannon"]
                add(f"Cannon-type coefficients in the best F2 variant (`{kd['variant']}`, reference "
                    f"`{kd['reference']}`):")
                add("")
                L += table(["column", "coefficient"], [[f"`{n}`", f"{c:+.4g}"] for n, c in kd["rows"]])
                add("")
        cal = config.settings.artillery_cal
        if cal != "auto":
            add(f"**Artillery was restricted** (`--artillery-cal {cal}`): only F0 and "
                f"{ARTILLERY_CAL_KEYS[cal]} were screened, so this run fixes the calibre representation "
                "rather than choosing it.")
            add("")
        add("The adopted variant then goes through the stat-power comparison and fine search below.")
        add("")
    if res.powers:
        add(f"For each numeric stat, a power from {list(config.settings.power_grid)}, plus the size power p within ±{P_WINDOW}, is "
            "fitted by coordinate descent on the **training rows of each fold**, and that fold's test rows are then "
            "scored. The CV is therefore honest about the extra flexibility. The powers are kept only if they beat "
            "linear stats by more than one SE.")
        add("")
        rows = []
        for arm, pw in res.powers.items():
            rows.append([arm, pm(pw.base, "mae", f1), pm(pw.nested, "mae", f1),
                         f"{pw.nested.mean('mae') - pw.base.mean('mae'):+.2f}", f2(pw.base.se("mae")),
                         f1(pw.base.mean("mape")), f1(pw.nested.mean("mape")), "**kept**" if pw.kept else "not kept"])
        L += table(["arm", "MAE linear stats", "MAE stat powers (nested)", "Δ", "1 SE", "MAPE linear", "MAPE powers",
                    "verdict"], rows)
        add("")
        add("Fitted powers: *full* is the descent on all rows; the fold range shows how stable each power is across "
            "the 5 training folds.")
        add("")
        rows = []
        for stat in power_key_order(res) + ["size power p"]:
            row = [stat]
            for arm, pw in res.powers.items():
                if stat == "size power p":
                    folds = [p for _, p in pw.fold_powers]
                    full = pw.full_p
                else:
                    if stat not in pw.full_powers:
                        row.append("—")
                        continue
                    folds = [powers.get(stat, 1.0) for powers, _ in pw.fold_powers]
                    full = pw.full_powers[stat]
                row.append(f"{full:g} ({min(folds):g} … {max(folds):g})")
            rows.append(row)
        L += table(["stat"] + [f"{arm}: full (folds)" for arm in res.powers], rows)
        add("")

    if any(pw.fine for pw in res.powers.values()):
        add("### 7b. Fine power search")
        add("")
        add(f"Starting from each fold's coarse powers, every stat power is refined in steps of {FINE_STAT_STEP} within "
            f"±{FINE_STAT_STEP * FINE_STAT_HALF:g}, and p in steps of {FINE_P_STEP} within ±{FINE_P_STEP * FINE_P_HALF:g}. "
            "A window re-centres when its best value sits on an edge, so powers stuck at the coarse grid's limits "
            f"(0.25, 3) can move, down to a floor of {MIN_POWER}. This is nested inside each training fold again. "
            "**Decision rule:** powers are kept only if the better of coarse or fine beats linear stats by more "
            "than one SE, and then whichever of the two is lower.")
        add("")
        add("**Note on cavalry.** Cavalry error is already low, about 7.7% MAPE with linear stats. If neither the "
            "coarse nor the fine search beats linear stats by more than one SE, the power hypothesis is **dropped "
            "for cavalry**, and cavalry stays linear in its stats.")
        add("")
        rows = []
        for arm, pw in res.powers.items():
            fine = pw.fine
            se = pw.base.se("mae")
            rows.append([arm, f1(pw.base.mean("mae")), f1(pw.nested.mean("mae")), f1(fine.nested.mean("mae")),
                         f"{fine.nested.mean('mae') - pw.nested.mean('mae'):+.2f}",
                         f"{min(fine.nested.mean('mae'), pw.nested.mean('mae')) - pw.base.mean('mae'):+.2f}",
                         f2(se), f1(fine.nested.mean("mape")), f"**{fine.choice}**"])
        L += table(["arm", "MAE linear stats", "MAE coarse (nested)", "MAE fine (nested)", "fine − coarse",
                    "best powers − linear", "1 SE (linear)", "MAPE fine", "choice"], rows)
        add("")
        add("Fine powers (full-data refinement, with the range across the 5 training folds). Coarse full-data "
            "values in brackets.")
        add("")
        rows = []
        for stat in power_key_order(res) + ["size power p"]:
            row = [stat]
            for arm, pw in res.powers.items():
                fine = pw.fine
                if stat == "size power p":
                    full, folds, coarse = fine.full_p, [p for _, p in fine.fold_powers], pw.full_p
                elif stat in fine.full_powers:
                    full = fine.full_powers[stat]
                    folds = [powers.get(stat, 1.0) for powers, _ in fine.fold_powers]
                    coarse = pw.full_powers.get(stat, 1.0)
                else:
                    row.append("—")
                    continue
                row.append(f"{full:g} ({min(folds):g} … {max(folds):g}) [{coarse:g}]")
            rows.append(row)
        L += table(["stat"] + [f"{arm}: fine (folds) [coarse]" for arm in res.powers], rows)
        add("")
        add("**Local CV curves.** Each power is varied over its fine window around the full-data fine solution, "
            "with the others held there, and the power 1 / p = 1 is also scored. *Within 1 SE* is the span of "
            "values whose CV MAE is within one SE of that curve's minimum. A wide span means the exponent is "
            "poorly pinned down. *Edge* means the span reaches the window edge, so the best value may lie "
            "further out. The curves hold the other powers at full-data values, so they are slightly "
            "optimistic: read them for shape, not accuracy.")
        add("")
        for arm, pw in res.powers.items():
            add(f"#### {arm}")
            add("")
            rows = []
            for prof in pw.fine.profiles:
                rows.append([prof["name"], f"{prof['center']:g}", f"{prof['best']:g}", f1(prof["best_mae"]),
                             f"{prof['lo']:g} … {prof['hi']:g}", "yes" if prof["edge"] else "—",
                             f1(prof["at_center"]), f1(prof["at_linear"]),
                             f"{prof['at_linear'] - prof['best_mae']:+.2f}"])
            L += table(["power", "fine value", "CV-best", "CV MAE", "within 1 SE", "edge", "MAE at fine value",
                        "MAE at 1 (linear)", "linear − best"], rows)
            add("")

    # ---- 8. Final accuracy
    add("## 8. Final model — accuracy on every slice")
    add("")
    rows = []
    for (arm, side), sl in slices.items():
        b, fin, rf, rfs = sl.runs["baseline"], sl.runs["final"], sl.runs["RF"], sl.runs["RFs"]
        fc = sl.runs.get("FC")
        rows.append([arm, side, pm(b, "mae", f1), pm(fin, "mae", f1), pm(fin, "mape", f1), pm(fin, "r2", f3),
                     f1(rf.mean("mae")), f1(rfs.mean("mae")), pm(fc, "mae", f1) if fc else "—",
                     f1(fin.full.c) if fin.spec.const else "—", fin.full.iterations])
    L += table(["arm", "side", "baseline MAE", "final MAE", "MAPE %", "R²", "+ per-arm m_f MAE",
                "+ shared m_f MAE", "faction × class MAE", "c (gold/unit)", "ALS iterations"], rows)
    add("")
    rows = []
    for (arm, side), sl in slices.items():
        run = sl.runs["final"]
        oof = run.oof[np.isfinite(run.oof)]
        worst = int(np.nanargmin(run.oof))
        u = sl.units[worst]
        rows.append([arm, side, int((oof <= 0).sum()), int((oof < 20).sum()),
                     f"{u.unit_class}, {u.n:g} models / {u.guns:g} guns, cost {u.cost} → {run.oof[worst]:.1f}"])
    add("**Where the model breaks down** (out-of-fold predictions):")
    add("")
    L += table(["arm", "side", "predictions ≤ 0", "predictions < 20", "lowest prediction"], rows)
    add("")
    add("### Packing vs unit size")
    add("")
    rows = []
    for arm, p in res.packing.items():
        for label, run, note in p["runs"]:
            rows.append([arm, f"{p['corr']:+.3f}", label, pm(run, "mae", f1), note or "—"])
    L += table(["arm", "corr(rank_depth, models)", "variant", "MAE (gold)", "fitted multiplier"], rows)
    add("")

    # ---- 9. Coefficients
    add("## 9. Final model — coefficients")
    add("")
    add("Refit on all rows of each slice. Price = M × size^p × (b0 + β·f(x)) + c. β is in gold per size "
        "unit^p; where a stat has a power, its column is (stat / 100)^power.")
    add("")
    for arm in ARMS:
        runs = {side: slices[(arm, side)].runs["final"] for side in SIDES}
        names: list[str] = []
        for side in SIDES:
            for name in runs[side].names:
                if name not in names:
                    names.append(name)
        spec = res.final[arm]
        add(f"### {arm} — `{spec.describe()}`")
        add("")
        add("Reference levels (merged): " + ", ".join(f"{k} = `{v}`" for k, v in runs["merged"].references.items()))
        add("")
        rows = [["(b0)"] + [f2(runs[side].full.b0) for side in SIDES]]
        for name in names:
            label = f"`{name}`" + (f" ^{spec.power_of(name):g}" if spec.power_of(name) != 1.0 else "")
            rows.append([label] + [f2(runs[side].coef(name)) if name in runs[side].names else "—" for side in SIDES])
        if spec.const:
            rows.append(["c (gold per unit)"] + [f1(runs[side].full.c) for side in SIDES])
        L += table(["feature", "imperial", "coalition", "merged"], rows)
        add("")
        for side in SIDES:
            add(f"- Multipliers ({side}): {describe_factors(runs[side].full)}")
        add("")

    # ---- 10. Faction modifier
    add("## 10. Faction modifier — what's left once the final model is in")
    add("")
    rows = []
    for (arm, side), sl in slices.items():
        fin, rf, rfs = sl.runs["final"], sl.runs["RF"], sl.runs["RFs"]
        best = min((fin, rf, rfs), key=lambda run: run.mean("mae"))
        rows.append([arm, side] + [f"**{f1(run.mean('mae'))}**" if run is best else f1(run.mean("mae"))
                                   for run in (fin, rf, rfs)])
    L += table(["arm", "side", "MAE final", "MAE + per-arm m_f", "MAE + shared m_f"], rows)
    add("")
    stats = corps_resid_stats(res, "final")
    groups: dict[int, list[float]] = defaultdict(list)
    for f, _, _, median, _ in stats:
        groups[ratings[f]].append(median)
    rho = spearman([ratings[f] for f, *_ in stats], [median for _, _, _, median, _ in stats])
    add(f"**Is rating absorbed?** Spearman ρ(rating, corps median residual) = **{rho:+.2f}**.")
    add("")
    shared = res.shared_m["merged"]
    resid_of = {f: median for f, _, _, median, _ in stats}
    mods: dict[str, dict[str, float]] = defaultdict(dict)
    for arm in ARMS:
        for faction, m in slices[(arm, "merged")].runs["RF"].full.faction_m.items():
            mods[faction][arm] = m
    unit_count = Counter(u.faction for u in res.units)
    corps_of = {u.faction: u.corps for u in res.units}
    side_of_f = {u.faction: u.side for u in res.units}
    add("**Faction modifiers** (merged, full-data fit, sorted by shared `m_f`):")
    add("")
    rows = []
    for f in sorted(shared, key=lambda f: (-shared[f], f)):
        median = resid_of.get(f, float("nan"))
        rows.append([corps_of[f] + (" **(7. Poland)**" if f == POLAND else ""), f"`{f}`", ratings[f], side_of_f[f],
                     unit_count[f], f"**{shared[f]:.3f}**"] + [f"{mods[f][a]:.3f}" if a in mods[f] else "—" for a in ARMS] +
                    [f"{median:+.1f}%" if np.isfinite(median) else "—"])
    L += table(["corps", "faction", "rating", "side", "units", "shared m_f", "m_f infantry", "m_f cavalry",
                "m_f artillery", "median OOF resid (final)"], rows)
    add("")
    by_side = {s: [m for f, m in shared.items() if side_of_f[f] == s] for s in ("imperial", "coalition")}
    add("Shared `m_f` by side: " + ", ".join(f"{s} mean {np.mean(v):.3f}" for s, v in by_side.items()) + ".")
    add("")
    if res.fclass:
        L += fclass_report(res)

    # ---- 11. Transfer
    add("## 11. Transfer — one formula for both sides? (final model, side dropped)")
    add("")
    rows = []
    for (arm, direction), m in res.transfer.items():
        rows.append([arm, direction, f1(m["mae"]), f1(m["in_side_mae"]), f1(m["mape"]), f1(m["in_side_mape"]),
                     m["affected"], ", ".join(str(x) for x in m["unseen_ratings"]) or "—"])
    L += table(["arm", "direction", "MAE", "in-side CV MAE", "MAPE %", "in-side CV MAPE %",
                "test rows hit by unseen levels", "ratings absent from train"], rows)
    add("")

    # ---- 12. Poland
    add("## 12. 7. Poland (`ntw3_tow_c08_x8_048`)")
    add("")
    rows = [[arm, side, p["n"], f1(p["with"].mean("mae")), f1(p["without"].mean("mae")),
             f"{p['median_resid']:+.1f}%", f"{p['share_over']:.0f}%"] for (arm, side), p in res.poland.items()]
    L += table(["arm", "side", "Poland units", "MAE with", "MAE without", "Poland median resid %",
                "share above model"], rows)
    add("")
    if POLAND in shared:
        ranked = sorted(shared.values())
        rank = sum(v < shared[POLAND] for v in ranked) + 1
        peers = [shared[f] for f in shared if ratings[f] == ratings[POLAND] and f != POLAND]
        add(f"Poland's shared modifier: **{shared[POLAND]:.3f}**, rank {rank} of {len(ranked)} (1 = cheapest "
            f"relative to the model); rating-{ratings[POLAND]} peers {min(peers):.3f} … {max(peers):.3f}. Per arm: " +
            ", ".join(f"{a} {mods[POLAND][a]:.3f}" for a in ARMS if a in mods[POLAND]) + ".")
        add("")

    # ---- 13. Cost-effective units
    add("## 13. Cost-effective units")
    add("")
    add("Funds saved = the final model's fair price minus the actual price. The fair price is out-of-fold, "
        "and full-fit (†) for the few units pinned to train. Rating, side and the other multipliers are "
        "already part of the fair price, so these are bargains on top of the normal rating discount. "
        "Faction modifiers are deliberately left out, so corps that are cheap across the board show up. "
        "Identical rows are merged.")
    add("")
    for arm in ARMS:
        size_label = "guns" if res.final[arm].size == "guns" else "models"
        mape = slices[(arm, "merged")].runs["final"].mean("mape")
        top_abs, top_rel = bargains(res, arm)
        for title, items, bold in (("absolute", top_abs, "saved"), ("relative", top_rel, "rel")):
            add(f"### {arm} — {title} (typical model error {mape:.1f}%)")
            add("")
            rows = []
            for i, it in enumerate(items, 1):
                u = it["unit"]
                name = u.name.replace("|", "/") + (f" (×{it['count']})" if it["count"] > 1 else "") + (" †" if it["pinned"] else "")
                saved = f"{it['saved']:+,.0f}"
                rel = f"{it['rel']:.0f}%"
                rows.append([i, name, f"{u.corps} ({u.rating})", f"{size_of(u, res.final[arm].size):g}", f"{u.cost:,}",
                             f"{it['pred']:,.0f}", f"**{saved}**" if bold == "saved" else saved,
                             f"**{rel}**" if bold == "rel" else rel])
            L += table(["#", "unit", "corps (rating)", size_label, "cost", "model", "saved", "saved %"], rows)
            add("")

    # ---- 14. Staff
    add("## 14. Staff generals")
    add("")
    add(f"T3 (from the blind study, see `blind_ideas_report.md`): a starred general costs b·stars^q·({REF_RATING}/r), "
        "one without stars 1 gold; q on a 0.005 grid, b by least squares, fitted on starred generals.")
    add("")
    rows = []
    for side, ss_ in res.staff_slices.items():
        for key, run in ss_.runs.items():
            tag = " **(headline)**" if key == res.staff_head else ""
            rows.append([side, run.label + tag, pm(run, "mae", f1), pm(run, "mape", f1), pm(run, "r2", f3)])
    L += table(["side", "model", "MAE (gold)", "MAPE % (starred)", "R²"], rows)
    add("")
    merged = res.staff_slices["merged"]
    coef, _, _ = staff_full(merged.gens, res.staff_head)
    add(f"{res.staff_head} full-data fit (merged): " +
        ", ".join(f"{n} = {c:+.4g}" for n, c in zip(STAFF_RATING_NAMES[res.staff_head], coef)) + ".")
    add("")

    add("## 15. Next step: commander variants")
    add("")
    add("Commander variants (a general attached to a unit, `unit_class = general`, about 42% of ToW + Custom rows) "
        "are outside this model. The blind study (branch `blind-pricing-study`) prices them in a second stage from "
        "the regular price of the unit they lead: `price ≈ max(1, a·p_reg + b(stars)·10/N)`, one global set of 7 "
        "coefficients (a ≈ 0.9; b ≈ −60, −30, +20, +65, +120 for 0–4 stars), optionally with a per-army premium; "
        "in its CV that cut commander-row error from about 51 to 39 gold. With this model as stage 1 it is the "
        "immediate next extension.")
    add("")

    add("## 16. Follow-ups")
    add("")
    add("- `resolve_speed` in `tools/build_ntw3_army_builder_database.py` mislabels the camels as `L1`, and "
        "two other units are off by a tier against their name tags.")
    add("- The Ottoman 5-okka gun fires the 24-pdr shot (section 1); worth checking against the mod's weapon tables.")
    add("- `search_results.csv` lists every searched structure. `oof_predictions.csv` carries out-of-fold "
        "predictions plus the final model's full-fit prediction, for hand checks against `coefficients.csv`.")
    return L
