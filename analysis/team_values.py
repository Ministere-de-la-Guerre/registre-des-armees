"""Per-card value scales for the AC build optimiser and the 4-corps team study.

Step A1 of analysis/TEAM_OPTIMISER_PLAN.md. A card's *normative value* is what the game's
average pricing rule charges for its stats in a reference army (corps 8, coalition, no army ×
class factor); value ÷ price is its cost-effectiveness. Three versions, so the user can toggle:

  sb     the size-band model: the adopted form with a free multiplier per class × size band
         (form F6 of analysis/ac_pricing.py, the AC study's best size curve). The thin top
         band (240+ models: 13 AC / 17 ToW units, where F6 overshot) is merged into 180+.
  full   V4 at corps 8 with full size harmonisation (cost_effective_builds.harmonise_by_size)
  noise  the same with noise-only harmonisation (keeps each size's systematic discount)

AC and ToW/Custom teams never mix (ntw3.lua Factions_Errors), so each pool needs one internally
consistent scale, not a shared one: AC cards are valued by the AC fits (analysis/ac_pricing.py
checkpoints), ToW/Custom cards by the ToW fits (class_structure / ac_pricing ToW checkpoints).
AC harmonisation uses AC's own V4 out-of-fold errors. Combat-general versions: the commander
model (given the regular unit's value) with each pool's own coefficients. Staff generals are
valued by the optimisers (T3 + the command correction), not here.

The user suspects the size bands absorb the real size effect, as full harmonisation does. This
script tests it: per size stratum, how far each version moves values from the raw V4 value; and,
optionally (only with ladder replay data present), whether what `sb` removes from raw value predicts winning
— as the part full harmonisation removes did (+0.44 ± 0.16 logit per 1 000 gold).

Outputs (analysis/output/teams/): values_ac.csv, values_tow_sb.csv, value_bases.md, sb_cv.json.

    py -3.13 analysis/team_values.py [--workers 4]
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from dataclasses import replace
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ac_pricing as ap  # noqa: E402
import class_structure as cs  # noqa: E402
import commander_model as cm  # noqa: E402
import cost_effective_builds as ceb  # noqa: E402
import checkpoints as ckpt  # noqa: E402
import common  # noqa: E402
import unit_pricing as up  # noqa: E402
from pricing.final import FINAL  # noqa: E402

OUT = common.TEAMS_OUT
CACHE = ckpt.TEAMS_DIR
SEEDS = common.DEFAULT_SEEDS
SB_BANDS_N = common.SB_BANDS_N               # models; 240+ merged into 180+
VERSIONS = ("sb", "full", "noise")


def cached(name: str, compute):
    """A team-study checkpoint (analysis/checkpoints.py teams), computed and saved if missing."""
    return common.cached(ckpt.teams(name), compute)


def reference(units: list[up.Unit]) -> list[up.Unit]:
    """The same units in the reference army: corps 8, coalition, an unseen faction (factor 1)."""
    return [replace(u, rating=up.REF_RATING, side="coalition", faction=ceb.NORM_FACTION) for u in units]


def slice_of(dataset: str, arm: str) -> up.Slice:
    """The cached units and fold plan of an arm (ac_pricing's slices, AC or ToW)."""
    return common.load_pickle(ckpt.slice_path(dataset, arm))


kappa_of = ckpt.kappa_of


def v4_raw_and_oof(dataset: str, arm: str, units: list[up.Unit],
                   fitted: tuple[up.CVRun, dict[str, float]] | None = None) -> tuple[dict, dict]:
    """V4 at corps 8 for every unit, and its out-of-fold errors as harmonise_by_size wants them.
    `fitted` = (run, size powers) of another V4 fit (experiments/ (analysis branch) size_weighting.py); None = the cached one."""
    run, p_of = fitted if fitted is not None else common.load_pickle(ckpt.v4_path(dataset, arm))
    spec = run.spec
    design = cs.segmented(up.design_for(spec, units, arm), units)
    ref = reference(units)
    data = cs.with_class_p(up.data_for(spec, ref), ref, spec, p_of)
    raw = up.predict_total(run.full, design, data, np.arange(len(units)))
    value = {(u.faction, u.key): float(v) for u, v in zip(units, raw)}
    oof = {(u.faction, u.key): (up.size_of(u, spec.size), float(u.cost), float(run.oof[i]))
           for i, u in enumerate(units) if np.isfinite(run.oof[i]) and run.oof[i] > 0}
    return value, oof


def sb_values(dataset: str, arm: str, units: list[up.Unit], folds) -> tuple[dict, dict]:
    """The size-band model (F6, top band merged): CV metrics and the value at corps 8."""
    base = up.joint_fclass_spec(FINAL[arm], kappa_of(dataset, arm))
    run, extra = cached(f"sb_{dataset}_{arm}",
                        lambda: ap.size_form_run("F6", base, units, folds, arm, bands=common.SB_BANDS))
    banded = ap.with_bands(units, base.size, per_class=True, bands=common.SB_BANDS)
    design = up.design_for(run.spec, banded, arm)
    ref = reference(banded)
    pred = up.predict_total(run.full, design, up.data_for(run.spec, ref), np.arange(len(units)))
    metrics = {"mae": run.mean("mae"), "se": run.se("mae"), "mape": run.mean("mape"), "bands": extra["bands"]}
    return {(u.faction, u.key): float(v) for u, v in zip(units, pred)}, metrics


def commander_values(pairs_csv: Path | None, coefficients: dict[str, float] | None,
                     base: dict[tuple[str, str], float]) -> dict[tuple[str, str], float]:
    """The commander model at the regular unit's value (corps 8, coalition), per commander card.
    `pairs_csv` None = the ToW pairs; `coefficients` None = the ToW "given true P" fit."""
    c = cm.Pairs(pairs_csv)
    if coefficients is None:
        with open(ceb.OUT / "commander_model_coefficients.csv", encoding="utf-8") as fh:
            coefficients = {r["term"]: float(r["coefficient"]) for r in csv.DictReader(fh) if r["model"] == "given true P"}
    keep = [i for i, r in enumerate(c.rows) if (r["faction_key"], r["regular_unit_key"]) in base]
    P = np.array([base.get((r["faction_key"], r["regular_unit_key"]), np.nan) for r in c.rows])
    c.corps = np.full(c.n, float(up.REF_RATING))
    c.imperial = np.zeros(c.n)
    X, names = cm.design(c, P)
    value = np.maximum(1.0, X @ np.array([coefficients[n] for n in names]))
    return {(c.rows[i]["faction_key"], c.rows[i]["commander_unit_key"]): float(value[i]) for i in keep}


# --- The size-effect test ---------------------------------------------------------------

def stratum_table(units_by_arm: dict[str, list[up.Unit]], vals: dict[str, dict]) -> list[list[str]]:
    rows = []
    for arm, units in units_by_arm.items():
        kind = "guns" if arm == "artillery" else "n"
        band = np.array([ap.band_of(up.size_of(u, kind), kind) for u in units])
        keys = [(u.faction, u.key) for u in units]
        raw = np.array([vals["raw"][k] for k in keys])
        for b in sorted(set(band.tolist()), key=lambda s: float(s.split("-")[0].rstrip("+"))):
            idx = np.flatnonzero(band == b)
            rows.append([arm, b, len(idx)] + [
                f"×{np.median(np.array([vals[v][keys[i]] for i in idx]) / raw[idx]):.3f}" for v in VERSIONS])
    return rows


def replay_test(cards: dict[tuple[str, str], dict], versions: tuple[str, ...] = VERSIONS) -> list[list[str]]:
    """Ladder replays (blind-study split and controls, as cost_effective_builds.size_replay_check):
    does the part a version removes from raw value predict winning?"""
    data = common.LADDER_REPLAY_DATA
    cut = json.loads((data / "split.json").read_text(encoding="utf-8"))["cut_played_at"]
    with open(data / "armies.csv", encoding="utf-8") as fh:
        armies = [a for a in csv.DictReader(fh) if a["result"] in ("win", "loss")]
    from collections import Counter, defaultdict
    train = [a for a in armies if a["played_at"] < cut]
    wins, games, match_fac = Counter(), Counter(), defaultdict(Counter)
    for a in train:
        games[a["faction_key"]] += 1
        wins[a["faction_key"]] += a["result"] == "win"
        match_fac[a["match_id"]][(a["faction_key"], a["result"] == "win")] += 1
    p_all = sum(wins.values()) / sum(games.values())
    X, y, tr = [], [], []
    for a in armies:
        f, is_train = a["faction_key"], a["played_at"] < cut
        w, g = wins[f], games[f]
        if is_train:
            g -= sum(k for (ff, _), k in match_fac[a["match_id"]].items() if ff == f)
            w -= match_fac[a["match_id"]][(f, True)]
        p = (w + 100 * p_all) / (g + 100)
        cs_ = [cards[(f, k)] for k in a["unit_keys"].split() if (f, k) in cards]
        s = {v: sum(c[v] - c["cost"] for c in cs_) / 1000 for v in ("raw",) + versions}
        yy = int(a["result"] == "win")
        rated = a["player_rating_change"] != ""
        e = 0.5
        if rated:
            d = float(a["player_rating_change"]) / 24
            e = min(0.95, max(0.05, 1 - d if yy else -d))
        X.append([np.log(p / (1 - p)), np.log(e / (1 - e))] + [s[v] for v in versions] + [s["raw"] - s[v] for v in versions])
        y.append(yy)
        tr.append(is_train and rated)
    X, y, tr = np.array(X), np.array(y), np.array(tr)
    rows = []
    for i, v in enumerate(versions):
        cols = [0, 1, 2 + i, 2 + len(versions) + i]
        A = np.column_stack([np.ones(tr.sum()), X[tr][:, cols]])
        beta = np.zeros(A.shape[1])
        for _ in range(50):
            p = 1 / (1 + np.exp(-A @ beta))
            H = A.T @ (A * (p * (1 - p))[:, None])
            step = np.linalg.solve(H, A.T @ (y[tr] - p))
            beta += step
            if np.abs(step).max() < 1e-10:
                break
        se = np.sqrt(np.diag(np.linalg.inv(H)))
        rows.append([v, f"{beta[3]:+.3f} ± {se[3]:.3f}", f"{beta[4]:+.3f} ± {se[4]:.3f} (z {beta[4] / se[4]:.1f})",
                     f"{X[tr][:, 2 + len(versions) + i].std():.3f}"])
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    up.configure(workers=max(1, args.workers))
    started = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {}
    tables: dict[str, list] = {}
    for dataset in ("ac", "tow"):
        vals: dict[str, dict] = {v: {} for v in ("raw",) + VERSIONS}
        units_by_arm = {}
        metrics = {}
        oof_all: dict = {}
        for arm in up.ARMS:
            sl = slice_of(dataset, arm)
            units = sl.units
            units_by_arm[arm] = units
            raw, oof = v4_raw_and_oof(dataset, arm, units)
            vals["raw"].update(raw)
            oof_all.update(oof)
            sb, metrics[arm] = sb_values(dataset, arm, units, sl.plan.folds)
            vals["sb"].update(sb)
            up.log(f"{dataset} {arm}: {len(units)} units; sb CV MAE {metrics[arm]['mae']:.2f}", started)
        # Harmonisation runs over every arm at once (harmonise_by_size loops over the arms itself).
        all_units = [u for units in units_by_arm.values() for u in units]
        for mode in ("full", "noise"):
            vals[mode] = ceb.harmonise_by_size(all_units, vals["raw"], mode=mode, oof=oof_all)
        report[dataset] = metrics
        tables[dataset] = stratum_table(units_by_arm, vals)
        # Commander versions, each pool's own commander model.
        if dataset == "ac":
            coef = json.loads((ap.OUT / "ac_commanders.json").read_text(encoding="utf-8"))["coefficients_ac"]
            cmd = {v: commander_values(ap.OUT / "ac_commander_pairs.csv", coef, vals[v]) for v in ("raw",) + VERSIONS}
            with open(OUT / "values_ac.csv", "w", encoding="utf-8", newline="") as fh:
                w = csv.writer(fh)
                w.writerow(["faction_key", "unit_key", "kind"] + [f"value_{v}" for v in ("raw",) + VERSIONS])
                for k in sorted(vals["raw"]):
                    w.writerow([k[0], k[1], "unit"] + [f"{vals[v][k]:.3f}" for v in ("raw",) + VERSIONS])
                for k in sorted(cmd["raw"]):
                    w.writerow([k[0], k[1], "commander"] + [f"{cmd[v][k]:.3f}" for v in ("raw",) + VERSIONS])
            up.log(f"ac values: {len(vals['raw'])} units, {len(cmd['raw'])} commanders → values_ac.csv", started)
        else:
            cmd_sb = commander_values(None, None, vals["sb"])
            with open(OUT / "values_tow_sb.csv", "w", encoding="utf-8", newline="") as fh:
                w = csv.writer(fh)
                w.writerow(["faction_key", "unit_key", "kind", "value_sb"])
                for k in sorted(vals["sb"]):
                    w.writerow([k[0], k[1], "unit", f"{vals['sb'][k]:.3f}"])
                for k in sorted(cmd_sb):
                    w.writerow([k[0], k[1], "commander", f"{cmd_sb[k]:.3f}"])
            # Replay test on ToW cards (units + commanders), costs from the cards.
            tow_cards = {}
            cmd_all = {v: commander_values(None, None, vals[v]) for v in ("raw",) + VERSIONS}
            for arm, units in units_by_arm.items():
                for u in units:
                    k = (u.faction, u.key)
                    tow_cards[k] = {"cost": float(u.cost), **{v: vals[v][k] for v in ("raw",) + VERSIONS}}
            with open(cm.PAIRS, encoding="utf-8") as fh:
                for r in csv.DictReader(fh):
                    k = (r["faction_key"], r["commander_unit_key"])
                    if all(k in cmd_all[v] for v in ("raw",) + VERSIONS):
                        tow_cards[k] = {"cost": float(r["commander_price"]), **{v: cmd_all[v][k] for v in ("raw",) + VERSIONS}}
            if common.LADDER_REPLAY_DATA.exists():
                tables["replay"] = replay_test(tow_cards)
                up.log("tow sb values → values_tow_sb.csv; replay test done", started)
            else:
                up.log(f"tow sb values → values_tow_sb.csv; replay test skipped: {common.LADDER_REPLAY_DATA} "
                       "not present (optional)", started)
    (OUT / "sb_cv.json").write_text(json.dumps(report, indent=2, default=float), encoding="utf-8")
    L = ["# Value bases for the AC optimiser and the team study", "",
         "Generated by `analysis/team_values.py`. Values at corps 8, coalition, no army × class factor. "
         "`sb` = size bands per class (F6, 240+ merged into 180+); `full` / `noise` = V4 with full / noise-only "
         "size harmonisation; raw = V4 unharmonised.", "",
         "## Size-band model, cross-validated (same 500-seed folds as the AC study)", ""]
    L += up.table(["pool", "arm", "MAE", "MAPE %"], [[d.upper(), a, f"{m['mae']:.2f} ± {m['se']:.2f}", f"{m['mape']:.2f}"]
                                                     for d, ms in report.items() for a, m in ms.items()])
    for d in ("ac", "tow"):
        L += ["", f"## How far each version moves values from raw V4, by size stratum ({d.upper()}; median ratio)", ""]
        L += up.table(["arm", "size", "units"] + list(VERSIONS), tables[d])
    L += ["", "## Does what each version removes predict winning? (ToW ladder replays)", "",
          "Logistic regression of winning on the faction's win rate, the pre-game rating gap, the army's surplus "
          "S = Σ(value − cost)/1 000 in that version, and the part the version removes from raw value, "
          "S_raw − S_version. Logits per 1 000 gold ± SE; the blind study's split and controls.", ""]
    if tables.get("replay"):
        L += up.table(["version", "S (version)", "S_raw − S_version", "sd of the removed part"], tables["replay"])
    else:
        L += ["*Skipped: the ladder replay data (analysis/build_blind/data) is not present. It is an optional "
              "check; no value in this file depends on it.*"]
    (OUT / "value_bases.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    up.log(f"done → {(OUT / 'value_bases.md').relative_to(up.ROOT)}", started)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
