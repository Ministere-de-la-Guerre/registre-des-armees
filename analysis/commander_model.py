"""Commander model, combined models, and a price database for every unit.

Three models end up side by side:

1. **Base unit models** (unchanged): the adopted model (`unit_pricing.py`, run FC)
   and the per-class model V4 (`class_structure.py`), for regular units; staff
   generals use T3.
2. **Commander model given the true regular price**: the commander blind study's
   best model (`analysis/commander_blind/REPORT.md`, 26 parameters), fitted by
   least absolute deviation on the actual price P of each commander's regular
   counterpart.
3. **Combined models** for commanders whose regular price is itself predicted:
   the same 26-parameter form, but *refitted on the base model's predicted P*, so
   its parameters compensate for the base model's systematic errors. Fitted once
   per base model; the better one is the headline combined model. Shown beside
   the naive chain (model 2's parameters applied to a predicted P).

Validation: every commander takes its regular counterpart's fold (the committed
500-seed splits). Base-model predictions are out-of-fold. Commander parameters for
fold k are fitted only on commanders outside fold k; for the combined models
they are fitted on those commanders' out-of-fold predicted P (stacking).
Counterparts pinned to train have no out-of-fold prediction; their commanders
only ever train and get no out-of-fold prediction either. So every prediction in
the database comes from models that never saw that unit's price.

Inputs: analysis/commander_blind/data/pairs.csv (build_commander_pairs.py), the
committed analysis/output/oof_predictions.csv, the class_structure checkpoint
(analysis/.cache/class_structure/) for V4.
Outputs (analysis/output/):
  commander_model_report.md       models, coefficients, accuracy
  commander_model_coefficients.csv
  price_database.csv               one row per unit: true price and every prediction

    python analysis/commander_model.py
"""

from __future__ import annotations

import csv
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy import sparse
from scipy.optimize import linprog

sys.path.insert(0, str(Path(__file__).resolve().parent))
import checkpoints as ckpt  # noqa: E402
import common  # noqa: E402
import unit_pricing as up  # noqa: E402
from pricing.final import FINAL  # noqa: E402

OUT = common.OUTPUT
PAIRS = common.COMMANDER_PAIRS
ARMS = common.ARMS


# --- The commander blind study's best model (FS7), as a function of P ----------

class Pairs:
    """Column arrays of pairs.csv, in file order."""

    def __init__(self, path: Path | None = None) -> None:
        with (PAIRS if path is None else path).open(encoding="utf-8", newline="") as fh:
            self.rows = list(csv.DictReader(fh))
        f = lambda k: np.array([float(r[k]) if r[k] != "" else np.nan for r in self.rows])  # noqa: E731
        self.n = len(self.rows)
        self.true_p = f("regular_price")
        self.cost = f("commander_price")
        self.stars = f("command_stars")
        self.corps = f("corps_number")
        self.arm = np.array([r["arm"] for r in self.rows])
        self.imperial = np.array([r["side"] == "imperial" for r in self.rows], float)
        self.men_r = f("regular_men")
        self.ratio = f("commander_men") / self.men_r
        self.reg = {k: f("regular_" + k) for k in ("morale", "melee_defense", "charge_bonus", "accuracy", "reload_skill")}
        self.com = {k: f("commander_" + k) for k in self.reg}
        self.d = {k: self.com[k] - self.reg[k] for k in self.reg}


def design(c: Pairs, P: np.ndarray) -> tuple[np.ndarray, list[str]]:
    """FS7 from analysis/commander_blind/src/final.py, with the regular price P as an input."""
    inf, cav, art = ((c.arm == a).astype(float) for a in ARMS)
    d, com, reg = c.d, c.com, c.reg
    size = P * (c.ratio - 1)
    cols = {
        "a[infantry]·P": P * inf, "a[cavalry]·P": P * cav, "a[artillery]·P": P * art,
        "b[infantry]": inf, "b[cavalry]": cav, "b[artillery]": art,
        "P·Δmorale": P * d["morale"], "P·Δmelee_defense": P * d["melee_defense"], "P·Δcharge": P * d["charge_bonus"],
        "P·Δaccuracy": P * d["accuracy"], "P·Δreload": P * d["reload_skill"],
        "men·Δmorale": c.men_r * d["morale"],
        "g[infantry, cavalry]·P·(r−1)": size * (1 - art), "g[artillery]·P·(r−1)": size * art,
        "P·Δ(charge²)": P * (com["charge_bonus"] ** 2 - reg["charge_bonus"] ** 2),
        "P·Δ(reload²)": P * (com["reload_skill"] ** 2 - reg["reload_skill"] ** 2),
        "P·N·Δmorale": P * c.corps * d["morale"],
        "men·Δ(morale²)": c.men_r * (com["morale"] ** 2 - reg["morale"] ** 2),
        "men·Δreload": c.men_r * d["reload_skill"],
        "k[infantry]·s": c.stars * inf, "k[cavalry]·s": c.stars * cav, "k[artillery]·s": c.stars * art,
        "c[infantry]·N·s": c.corps * c.stars * inf, "c[cavalry]·N·s": c.corps * c.stars * cav,
        "c[artillery]·N·s": c.corps * c.stars * art,
        "imperial": c.imperial,
    }
    return np.column_stack(list(cols.values())), list(cols)


def lad(X: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Least-absolute-deviation fit by linear programming (as the blind study)."""
    n, p = X.shape
    eye = sparse.identity(n, format="csr")
    A = sparse.hstack([sparse.csr_matrix(X), sparse.csr_matrix(-X), eye, -eye], format="csr")
    res = linprog(np.r_[np.zeros(2 * p), np.ones(2 * n)], A_eq=A, b_eq=y, bounds=(0, None), method="highs")
    if not res.success:
        raise RuntimeError(res.message)
    return res.x[:p] - res.x[p:2 * p]


def metrics(y: np.ndarray, pred: np.ndarray) -> dict[str, float]:
    ok = np.isfinite(pred)
    err = np.abs(pred[ok] - y[ok])
    return {"n": int(ok.sum()), "mae": float(err.mean()), "medape": float(np.median(err / y[ok]) * 100),
            "mape": float(np.mean(err / y[ok]) * 100)}


def main() -> int:
    started = time.time()
    units, staff, _, _ = up.load(up.load_ratings())
    with open(OUT / "oof_predictions.csv", encoding="utf-8") as fh:
        committed = list(csv.DictReader(fh))
    merged = {(r["model"], r["faction_key"], r["unit_key"]): r for r in committed if r["slice"] == "merged"}

    # Base models: out-of-fold (and full-fit) predictions of every regular unit.
    regular: dict[tuple[str, str], dict] = {}
    for arm in ARMS:
        sl = up.make_slice(arm, "merged", up.slice_units(units, arm, "merged"), 500)
        v4_run, p_of_class = common.load_pickle(ckpt.tow_v4_path(arm))
        for i, u in enumerate(sl.units):
            r = merged[(arm, u.faction, u.key)]
            fc = float(r["oof_final_faction_class"] or "nan")
            regular[(u.faction, u.key)] = {"unit": u, "arm": arm, "fold": int(r["fold"] or 0) if np.isfinite(fc) else 0,
                                           "FC": fc, "V4": float(v4_run.oof[i])}
        up.log(f"{arm:9} base-model predictions loaded", started)

    c = Pairs()
    keys = [(r["faction_key"], r["regular_unit_key"]) for r in c.rows]
    missing = [k for k in keys if k not in regular]
    if missing:
        raise SystemExit(f"{len(missing)} commanders without a regular unit in the merged slices, e.g. {missing[0]}")
    fold = np.array([regular[k]["fold"] for k in keys])
    p_hat = {b: np.array([regular[k][b] for k in keys]) for b in ("FC", "V4")}
    y = c.cost
    tested = fold > 0

    def cv(p_train: np.ndarray, p_test: np.ndarray) -> np.ndarray:
        """CV over the counterpart folds: fit on design(p_train) of the training commanders, predict design(p_test)."""
        pred = np.full(c.n, np.nan)
        X_train, _ = design(c, p_train)
        X_test, _ = design(c, p_test)
        for k in range(1, up.N_SPLITS + 1):
            tr = fold != k
            if not np.isfinite(X_train[tr]).all():
                raise SystemExit("training commanders without a regular-price prediction")
            beta = lad(X_train[tr], y[tr])
            pred[fold == k] = np.maximum(1.0, X_test[fold == k] @ beta)
        return pred

    preds: dict[str, np.ndarray] = {}
    preds["given true P"] = cv(c.true_p, c.true_p)
    up.log(f"commander model given true P: CV MAE {metrics(y[tested], preds['given true P'][tested])['mae']:.2f}", started)
    for b in ("FC", "V4"):
        p_train = np.where(np.isfinite(p_hat[b]), p_hat[b], c.true_p)   # pinned (train-only) rows: their true price
        preds[f"naive chain, {b}"] = cv(c.true_p, p_hat[b])
        preds[f"combined, {b}"] = cv(p_train, p_hat[b])
        up.log(f"{b}: naive chain {metrics(y[tested], preds[f'naive chain, {b}'][tested])['mae']:.2f}, "
               f"combined {metrics(y[tested], preds[f'combined, {b}'][tested])['mae']:.2f}", started)
    best_base = min(("FC", "V4"), key=lambda b: metrics(y[tested], preds[f"combined, {b}"][tested])["mae"])

    # Full-data fits (coefficients).
    names = design(c, c.true_p)[1]
    coef = {"given true P": lad(design(c, c.true_p)[0], y)}
    for b in ("FC", "V4"):
        coef[f"combined, {b}"] = lad(design(c, np.where(np.isfinite(p_hat[b]), p_hat[b], c.true_p))[0], y)

    # ---- Database: every regular unit, staff general and commander.
    db: list[dict] = []
    for (faction, key), r in regular.items():
        u = r["unit"]
        db.append({"kind": "regular", "arm": r["arm"], "unit_key": key, "unit_name": u.name, "faction_key": faction,
                   "army_corps_name": u.corps, "corps_number": u.rating, "side": u.side, "unit_class": u.unit_class,
                   "stars": "", "size": up.size_of(u, FINAL[r["arm"]].size), "true_price": u.cost, "fold": r["fold"] or "",
                   "pred_adopted": r["FC"], "pred_v4": r["V4"], "pred_given_true_regular_price": np.nan,
                   "regular_counterpart_key": "", "regular_counterpart_price": ""})
    for g in staff:
        s = merged.get(("staff", g.faction, g.key))
        oof = float(s["oof_final"]) if s and s["oof_final"] else np.nan
        db.append({"kind": "staff general", "arm": "staff", "unit_key": g.key, "unit_name": g.name, "faction_key": g.faction,
                   "army_corps_name": g.corps, "corps_number": g.rating, "side": g.side, "unit_class": "general_staff",
                   "stars": g.stars, "size": 16, "true_price": g.cost, "fold": s["fold"] if s else "",
                   "pred_adopted": oof, "pred_v4": oof, "pred_given_true_regular_price": np.nan,
                   "regular_counterpart_key": "", "regular_counterpart_price": ""})
    for i, r in enumerate(c.rows):
        u = regular[keys[i]]["unit"]
        db.append({"kind": "commander", "arm": r["arm"], "unit_key": r["commander_unit_key"], "unit_name": r["commander_name"],
                   "faction_key": r["faction_key"], "army_corps_name": r["army_corps_name"],
                   "corps_number": int(r["corps_number"]), "side": r["side"], "unit_class": r["unit_class"],
                   "stars": int(r["command_stars"]),
                   "size": (float(r["commander_guns"]) if r["arm"] == "artillery" else float(r["commander_men"]) / 2),
                   "true_price": int(float(r["commander_price"])), "fold": fold[i] or "",
                   "pred_adopted": preds["combined, FC"][i], "pred_v4": preds["combined, V4"][i],
                   "pred_given_true_regular_price": preds["given true P"][i],
                   "regular_counterpart_key": r["regular_unit_key"], "regular_counterpart_price": u.cost})
    cell = lambda v: "" if isinstance(v, float) and not np.isfinite(v) else (f"{v:.2f}" if isinstance(v, float) else v)  # noqa: E731
    with open(OUT / "price_database.csv", "w", encoding="utf-8", newline="") as fh:
        fields = list(db[0])
        w = csv.writer(fh)
        w.writerow(fields + ["error_adopted", "error_v4", "error_given_true_regular_price"])
        for row in db:
            errs = [row[k] - row["true_price"] if np.isfinite(row[k]) else np.nan
                    for k in ("pred_adopted", "pred_v4", "pred_given_true_regular_price")]
            w.writerow([cell(row[k]) for k in fields] + [cell(float(e)) for e in errs])

    # ---- Accuracy over every unit kind.
    kinds = defaultdict(lambda: defaultdict(list))
    for row in db:
        for k in ("pred_adopted", "pred_v4", "pred_given_true_regular_price"):
            if np.isfinite(row[k]):
                kinds[(row["kind"], row["arm"])][k].append((row["true_price"], row[k]))
    acc_rows = []
    for (kind, arm), d in sorted(kinds.items(), key=lambda t: (["regular", "commander", "staff general"].index(t[0][0]), t[0][1])):
        line = [kind, arm]
        for k in ("pred_adopted", "pred_v4", "pred_given_true_regular_price"):
            if d.get(k):
                t, p = np.array(d[k]).T
                m = metrics(t, p)
                line.append(f"{m['mae']:.1f} ({m['medape']:.1f}%)")
            else:
                line.append("—")
        line.insert(2, len(d["pred_adopted"]))
        acc_rows.append(line)
    total = []
    for k in ("pred_adopted", "pred_v4"):
        t, p = np.array([(row["true_price"], row[k]) for row in db if np.isfinite(row[k])]).T
        m = metrics(t, p)
        total.append(f"{m['mae']:.1f} ({m['medape']:.1f}%), {m['n']} units")

    # ---- Report.
    L = ["# Commander model, combined models and price database", "",
         "Generated by `analysis/commander_model.py`. Commanders take their regular counterpart's fold; base-model "
         "predictions are out-of-fold; commander parameters for fold k are fitted without fold k. "
         f"{int(tested.sum())} of {c.n} commanders are tested (the rest lead units pinned to train). MAE in gold, "
         "median absolute % error in brackets.", "",
         "## 1. Commander models", "",
         "All use the commander blind study's best form (26 parameters, `analysis/commander_blind/REPORT.md`), fitted "
         "by least absolute deviation. They differ only in the regular price P they are fitted and applied with.", ""]
    rows = []
    labels = {"given true P": "**Commander model given the true regular price** (fitted and applied on true P)",
              "naive chain, FC": "Naive chain, adopted base: true-P parameters applied to the predicted P",
              "combined, FC": "**Combined, adopted base**: refitted on the predicted P",
              "naive chain, V4": "Naive chain, V4 base",
              "combined, V4": "**Combined, V4 base**: refitted on the predicted P"}
    for key, label in labels.items():
        m = metrics(y[tested], preds[key][tested])
        per_arm = [f"{metrics(y[tested & (c.arm == a)], preds[key][tested & (c.arm == a)])['mae']:.1f}" for a in ARMS]
        rows.append([label, f"{m['mae']:.2f}", f"{m['medape']:.2f}%"] + per_arm)
    L += up.table(["model", "CV MAE", "median APE", "infantry", "cavalry", "artillery"], rows)
    L += ["", "- **Refitting on the predicted P** lets the commander parameters absorb the base model's systematic "
          "errors. Compare each combined row with its naive chain.",
          "- **It gains little (about 0.7 gold).** The base models' errors are mostly specific to each unit "
          "(an army's own price for a unit class, a one-off price), not systematic. A commander inherits its "
          "regular unit's error, scaled by ≈ 0.9, and no refit of the commander parameters can remove that. "
          "The combined error is therefore close to the base model's error on regular units. Most of the gap to "
          "the *given true P* row is the regular-unit error.",
          f"- **Headline combined model:** the {'V4' if best_base == 'V4' else 'adopted'} base.", "",
          "## 2. Coefficients (full-data fits)", "",
          "The combined models are fitted on out-of-fold predicted P (stacking). Commanders of pinned units use their "
          "true price. Notation as in the blind study: Δx = commander stat − regular stat; men = regular men; "
          "r = commander men ÷ regular men; N = corps number; s = stars.", ""]
    L += up.table(["term", "given true P", "combined, adopted base", "combined, V4 base"],
                  [[f"`{n}`"] + [f"{coef[k][j]:.6g}" for k in ("given true P", "combined, FC", "combined, V4")]
                   for j, n in enumerate(names)])
    L += ["", "## 3. Every unit: the price database", "",
          "`analysis/output/price_database.csv` has one row per unit: regular units, staff generals and commanders. "
          "Each row carries the true price and the out-of-fold prediction of each model. A regular unit's "
          "`pred_adopted` / `pred_v4` come from the base models. A commander's come from the combined models; its "
          "`pred_given_true_regular_price` comes from the commander model given its regular unit's actual price. "
          "Staff generals use T3 in both columns. Rows pinned to train have no prediction.", ""]
    L += up.table(["kind", "arm", "units", "adopted (+ combined)", "V4 (+ combined)", "commander given true regular price"],
                  acc_rows)
    L += ["", f"**All units together:** adopted pipeline {total[0]}; V4 pipeline {total[1]}.", "",
          f"*Runtime {time.time() - started:.0f} s.*", ""]
    (OUT / "commander_model_report.md").write_text("\n".join(L), encoding="utf-8")
    with open(OUT / "commander_model_coefficients.csv", "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["model", "term", "coefficient"])
        for k in ("given true P", "combined, FC", "combined, V4"):
            for n, b in zip(names, coef[k]):
                w.writerow([k.replace("FC", "adopted base").replace("V4", "V4 base"), n, f"{b:.10g}"])
    up.log("done → commander_model_report.md, commander_model_coefficients.csv, price_database.csv", started)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
