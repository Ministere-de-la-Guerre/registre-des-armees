"""The best 4-corps teams at a fixed points total (step A3 of analysis/TEAM_OPTIMISER_PLAN.md).

The lobby scores a team by its points: the sum of its armies' corps numbers N, the number that
opens each name (ntw3.lua Faction_Points / Factions_Points_Sums). Players agree a total T per team,
so the question is: at a given T, which four armies make the most value together?

Team rules (ntw3.lua Factions_Errors; web/src/domain/teamRule.ts):
- Army Corps: all four share one theatre code (the faction key's 3rd part, e.g. a11 — the side is
  part of it), no corps twice, no ToW or Custom army.
- Theatres of War + Custom Armies: one pool, all on one side. Custom armies take their nation's
  side (teamRule.ts CUSTOM_ARMY_SIDE; every real Custom army has a known one). The Lua does not
  forbid the same army twice here, so a repeats-allowed variant is reported next to distinct teams.
Teams of 3 corps are legal too; `--team-size 3` runs them (not reported this round).

Army values are each army's best build in each value version (analysis/team_values.py):
- AC: the analysis/ac_builds.py summaries (formation rebates included; *_norebate for the
  counterfactual without them);
- ToW / Custom: cost_effective_builds.army_builds' "four corps" build (one roll, the app's default),
  re-run here per version; `sb` swaps in team_values' size-band values. Cached in
  analysis/.cache/teams/.
Values are normative gold at corps 8, so armies compare within a pool.
AC also has `price`, the "Formation discount only" score (the user's, 2026-10-12): an army scores
face / 10 000 × N, the list value of its best formation-discount build (ac_builds.py `price`, which
maximises face value) per 10 000 funds, times its corps number. List prices carry the 8/N rating
factor, so × N cancels it and the score compares across corps; an army fielding exactly 10 000 of
list value scores N, so a team scoring above its points total T gains list value from discounts.

Per team: T = Σ N, total value, weakest member, cost. Per pool × T × version: the best team by total
and by weakest member (ties: the other criterion). Then what the report needs: balanced against
lopsided N at a fixed T, bargain corps, and what rebates and the value version change.

Outputs (analysis/output/teams/): teams_ac.csv, teams_tow.csv (every distinct team, per version),
best_teams.csv, value_per_point.csv, army_values.csv (each army's best build per version, for the
app's team suggestion), team_search.json and team_search.md (numbers for TEAM_BUILDS_REPORT.md).

    py -3.13 analysis/team_search.py [--team-size 4]
"""

from __future__ import annotations

import argparse
import csv
import itertools
import json
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from scipy.stats import spearmanr

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cost_effective_builds as ceb  # noqa: E402
import checkpoints as ckpt  # noqa: E402
import common  # noqa: E402
import unit_pricing as up  # noqa: E402

OUT = common.TEAMS_OUT
VERSIONS = ("sb", "full", "noise")
AC_ONLY = ("price",)        # AC-only version: the formation-discount score (see above)
# web/src/domain/teamRule.ts CUSTOM_ARMY_SIDE, real armies only (the rest are dev placeholders).
CUSTOM_SIDE = {"france": "imperial", "denmark": "imperial", "britain": "coalition", "ntw3_hre": "coalition",
               "piedmont_savoy": "coalition"}


@dataclass
class Army:
    faction: str
    name: str
    n: int
    pool: str                                        # AC: theatre code; ToW / Custom: side
    value: dict[str, float] = field(default_factory=dict)
    cost: dict[str, float] = field(default_factory=dict)


def load_ac() -> list[Army]:
    armies: dict[str, Army] = {}
    for v in VERSIONS:
        for tag in ("", "_norebate"):
            with open(OUT / f"ac_build_summary_{v}{tag}.csv", encoding="utf-8") as fh:
                for r in csv.DictReader(fh):
                    if not r["cards"]:
                        continue
                    a = armies.setdefault(r["faction_key"], Army(r["faction_key"], r["army_corps_name"],
                                                                 int(r["corps_number"]), r["theatre"]))
                    a.value[v + tag] = float(r["value"])
                    a.cost[v + tag] = float(r["final_cost"])
    with open(OUT / "ac_build_summary_price.csv", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if r["cards"] and r["faction_key"] in armies:
                a = armies[r["faction_key"]]
                a.value["face"] = float(r["list_cost"])
                a.value["price"] = float(r["list_cost"]) / common.BUDGET * a.n
                a.cost["price"] = float(r["final_cost"])
    return sorted(armies.values(), key=lambda a: a.faction)


def tow_builds(version: str, started: float) -> dict[str, dict]:
    """faction → {name, n, side, value, cost, cards [(key, copies)], staff} of its "four corps" build
    in `version` (checkpointed: analysis/checkpoints.py tow_builds_path)."""
    return common.cached(ckpt.tow_builds_path(version), lambda: compute_tow_builds(version, started))


def compute_tow_builds(version: str, started: float) -> dict[str, dict]:
    mode = "noise" if version == "noise" else "full"
    by_faction, staff_of, top_star, army_of = ceb.load_cards(started, size_mode=mode)
    if version == "sb":
        sb = {}
        with open(OUT / "values_tow_sb.csv", encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                sb[(r["faction_key"], r["unit_key"])] = float(r["value_sb"])
        for f, cards in by_faction.items():
            for c in cards:
                c["value"] = sb[(f, c["key"])]
    command = ceb.Command(ceb.COMMAND_LAMBDA[mode], ceb.SPEED_BONUS, ceb.bodyguard_melee_bonus())
    out = {}
    for f, cards in sorted(by_faction.items()):
        for _, chosen, general in ceb.army_builds(cards, staff_of[f], top_star[f], command, ("four corps",)):
            name, n, side = army_of[f]
            if f in CUSTOM_SIDE and CUSTOM_SIDE[f] != side:
                raise ValueError(f"{f}: side {side} differs from the app's CUSTOM_ARMY_SIDE {CUSTOM_SIDE[f]}")
            out[f] = {"name": name, "n": int(n), "side": side,
                      "value": sum(c["value"] * k for c, k in chosen) + general["value"],
                      "cost": sum(c["cost"] * k for c, k in chosen) + general["cost"],
                      "cards": [(c["key"], k) for c, k in chosen], "staff": general["key"]}
        up.log(f"tow {version}: {army_of[f][0][:40]}", started)
    return out


def load_tow(started: float) -> list[Army]:
    armies: dict[str, Army] = {}
    for v in VERSIONS:
        for f, b in tow_builds(v, started).items():
            a = armies.setdefault(f, Army(f, b["name"], b["n"], b["side"]))
            a.value[v], a.cost[v] = b["value"], b["cost"]
    return sorted(armies.values(), key=lambda a: a.faction)


@dataclass
class Teams:
    """Every team of one kind as arrays: member indices into `armies`, and per-team numbers."""
    armies: list[Army]
    pool: np.ndarray
    idx: np.ndarray
    t: np.ndarray
    spread: np.ndarray
    total: dict[str, np.ndarray]
    weakest: dict[str, np.ndarray]
    cost: dict[str, np.ndarray]


def enumerate_teams(armies: list[Army], k: int, repeats: bool, keys: tuple[str, ...]) -> Teams:
    by_pool: dict[str, list[int]] = defaultdict(list)
    for i, a in enumerate(armies):
        by_pool[a.pool].append(i)
    combos = itertools.combinations_with_replacement if repeats else itertools.combinations
    pools, rows = [], []
    for pool, members in sorted(by_pool.items()):
        for c in combos(members, k):
            pools.append(pool)
            rows.append(c)
    idx = np.array(rows, dtype=int).reshape(-1, k)
    n = np.array([a.n for a in armies], float)[idx]
    total, weakest, cost = {}, {}, {}
    for v in keys:
        val = np.array([a.value.get(v, np.nan) for a in armies])[idx]
        total[v], weakest[v] = val.sum(1), val.min(1)
        cost[v] = np.array([a.cost.get(v, np.nan) for a in armies])[idx].sum(1)
    return Teams(armies, np.array(pools), idx, n.sum(1).astype(int), n.std(1), total, weakest, cost)


def best_teams(teams: Teams, version: str, across_pools: bool) -> list[dict]:
    """Best team per (pool, T) — or per T over all pools — by total and by weakest member."""
    cells: dict[tuple, list[int]] = defaultdict(list)
    for i, (p, t) in enumerate(zip(teams.pool, teams.t)):
        cells[("*" if across_pools else p, int(t))].append(i)
    out = []
    tot, weak = teams.total[version], teams.weakest[version]
    for (p, t), rows in sorted(cells.items()):
        rows = np.array(rows)
        for crit, order in (("total", np.lexsort((weak[rows], tot[rows]))),
                            ("weakest", np.lexsort((tot[rows], weak[rows])))):
            i = rows[order[-1]]
            out.append({"scope": "all" if across_pools else "pool", "pool": teams.pool[i], "T": t, "criterion": crit, "version": version, "teams_in_cell": len(rows),
                        "members": " + ".join(teams.armies[j].name for j in teams.idx[i]),
                        "factions": "|".join(teams.armies[j].faction for j in teams.idx[i]),
                        "Ns": "+".join(str(teams.armies[j].n) for j in teams.idx[i]),
                        "total": round(float(tot[i]), digits(version)), "weakest": round(float(weak[i]), digits(version)),
                        "cost": round(float(teams.cost[version][i])),
                        "cell_median_total": round(float(np.median(tot[rows])), 1)})
    return out


def digits(version: str) -> int:
    """Decimals a version's values are written with: the formation-discount score is ~N, the rest gold."""
    return 3 if version in AC_ONLY else 1


def balance_test(teams: Teams, version: str) -> dict:
    """Within each (pool, T) cell: does a wider spread of N cost value? Value as % of the cell mean."""
    cells: dict[tuple, list[int]] = defaultdict(list)
    for i, (p, t) in enumerate(zip(teams.pool, teams.t)):
        cells[(p, int(t))].append(i)
    ds, dv, rhos, weights, best_below = [], [], [], [], []
    for rows in cells.values():
        if len(rows) < 3:
            continue
        rows = np.array(rows)
        s, v = teams.spread[rows], teams.total[version][rows]
        if np.ptp(s) == 0:
            continue
        ds.append(s - s.mean())
        dv.append(100 * (v / v.mean() - 1))
        rho = spearmanr(s, v).statistic
        if np.isfinite(rho):
            rhos.append(rho)
            weights.append(len(rows))
        best_below.append(s[np.argmax(v)] <= np.median(s))
    ds, dv = np.concatenate(ds), np.concatenate(dv)
    slope = float((ds * dv).sum() / (ds * ds).sum())
    return {"cells": len(best_below), "teams": int(len(ds)), "slope_pct_per_sd_N": round(slope, 3),
            "mean_spearman": round(float(np.average(rhos, weights=weights)), 3),
            "best_team_at_or_below_median_spread": round(float(np.mean(best_below)), 3)}


def value_curve(armies: list[Army], version: str) -> dict:
    """log value = a + b log N over armies, with pool effects: b < 1 means value is concave in N, so
    a balanced split of a fixed T beats a lopsided one, other things equal."""
    pools = sorted({a.pool for a in armies})
    x = np.array([[np.log(a.n)] + [a.pool == p for p in pools[1:]] + [1.0] for a in armies], float)
    y = np.log(np.array([a.value[version] for a in armies]))
    coef, *_ = np.linalg.lstsq(x, y, rcond=None)
    resid = y - x @ coef
    sigma2 = resid @ resid / (len(y) - x.shape[1])
    se = np.sqrt(np.diag(sigma2 * np.linalg.pinv(x.T @ x)))
    b = float(coef[0])
    # A worked example at T = 36: four 9s against 6 + 6 + 12 + 12, on the fitted curve alone.
    lopsided = (2 * 6 ** b + 2 * 12 ** b) / (4 * 9 ** b) - 1
    return {"b": round(b, 3), "se": round(float(se[0]), 3), "resid": dict(zip((a.faction for a in armies), resid)),
            "lopsided_6_6_12_12_vs_9x4_pct": round(100 * lopsided, 2)}


def bargains(armies: list[Army], curve: dict, top: int = 10) -> dict:
    ranked = sorted(armies, key=lambda a: -curve["resid"][a.faction])
    row = lambda a: {"army": a.name, "pool": a.pool, "N": a.n, "vs_curve_pct": round(100 * (np.exp(curve["resid"][a.faction]) - 1), 1)}
    return {"best": [row(a) for a in ranked[:top]], "worst": [row(a) for a in ranked[-top:][::-1]]}


def rank_shift(teams: Teams, a: str, b: str) -> dict:
    """How far two valuations of the same teams agree: Spearman of team totals overall, and the share
    of (pool, T) cells whose best team (by total, and by weakest) is the same."""
    ok = np.isfinite(teams.total[a]) & np.isfinite(teams.total[b])
    rho = spearmanr(teams.total[a][ok], teams.total[b][ok]).statistic
    same = {}
    for crit in ("total", "weakest"):
        ba = {(r["pool"], r["T"]): r["members"] for r in best_teams(teams, a, False) if r["criterion"] == crit}
        bb = {(r["pool"], r["T"]): r["members"] for r in best_teams(teams, b, False) if r["criterion"] == crit}
        multi = [c for c in ba if c in bb and sum(1 for p, t in zip(teams.pool, teams.t) if (p, t) == c) > 1]
        same[crit] = round(float(np.mean([ba[c] == bb[c] for c in multi])), 3) if multi else None
    return {"spearman_team_totals": round(float(rho), 4), "same_best_team_share": same}


def write_team_table(teams: Teams, path: Path, keys: tuple[str, ...]) -> None:
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["pool", "T", "Ns", "spread_sd", "members"] + [f"total_{v}" for v in keys] +
                   [f"weakest_{v}" for v in keys] + [f"cost_{v}" for v in keys])
        for i in range(len(teams.t)):
            w.writerow([teams.pool[i], int(teams.t[i]), "+".join(str(teams.armies[j].n) for j in teams.idx[i]),
                        f"{teams.spread[i]:.2f}", " | ".join(teams.armies[j].faction for j in teams.idx[i])] +
                       [f"{teams.total[v][i]:.{digits(v)}f}" for v in keys] +
                       [f"{teams.weakest[v][i]:.{digits(v)}f}" for v in keys] +
                       [f"{teams.cost[v][i]:.0f}" for v in keys])


def write_value_per_point(path: Path, curves: dict) -> None:
    """Every army's best-build value per point (value / N) in each version, ranked within its pool.
    Corps value is close to proportional to N (curve exponent b ≈ 1), so a team's total at a fixed
    T is close to T × the N-weighted mean of its members' value per point: this table is the rule
    of thumb behind the best teams."""
    rows = []
    for kind, armies in curves.items():
        rank: dict[str, int] = {}
        by_pool: dict[str, list[Army]] = defaultdict(list)
        for a in armies:
            by_pool[a.pool].append(a)
        for members in by_pool.values():
            for i, a in enumerate(sorted(members, key=lambda a: -a.value["sb"] / a.n)):
                rank[a.faction] = i + 1
        for a in armies:
            rows.append([kind, a.pool, a.faction, a.name, a.n, rank[a.faction], len(by_pool[a.pool])] +
                        [f"{a.value[v] / a.n:.1f}" for v in VERSIONS] +
                        [f"{a.value.get(v + '_norebate', float('nan')) / a.n:.1f}" for v in VERSIONS[:1]])
    rows.sort(key=lambda r: (r[0], r[1], r[5]))
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["kind", "pool", "faction_key", "army", "N", "rank_in_pool_sb", "armies_in_pool"] +
                   [f"value_per_point_{v}" for v in VERSIONS] + ["value_per_point_sb_norebate"])
        w.writerows(rows)


def write_army_values(path: Path, pools: dict[str, list[Army]]) -> None:
    """Every army's best-build value and final cost per version, one row per army: what the app's
    "Suggest a team" ranks teams with when nothing constrains the builds
    (analysis/export_optimiser_values.py ships it as data/generated/ntw3_optimiser_army_values.csv).
    AC rows are analysis/ac_builds.py's builds (rebates and recruit order included); ToW / Custom
    rows the one-roll ("four corps") builds. `value_price` / `cost_price` (AC only): the formation-discount
    score face / 10 000 × N and what that build spends after rebates (face − cost = the discount)."""
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["faction_key", "kind", "pool", "N"] + [f"value_{v}" for v in VERSIONS] +
                   [f"cost_{v}" for v in VERSIONS] + [f"value_{v}" for v in AC_ONLY] + [f"cost_{v}" for v in AC_ONLY])
        for kind, armies in pools.items():
            for a in armies:
                w.writerow([a.faction, kind, a.pool, a.n] + [f"{a.value[v]:.3f}" for v in VERSIONS] +
                           [f"{a.cost[v]:.0f}" for v in VERSIONS] +
                           [f"{a.value[v]:.3f}" if v in a.value else "" for v in AC_ONLY] +
                           [f"{a.cost[v]:.0f}" if v in a.cost else "" for v in AC_ONLY])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--team-size", type=int, default=4, choices=(3, 4))
    args = parser.parse_args()
    k, started = args.team_size, time.time()
    suffix = "" if k == 4 else f"_k{k}"
    ac, tow = load_ac(), load_tow(started)
    ac_keys = VERSIONS + tuple(v + "_norebate" for v in VERSIONS) + ("face",) + AC_ONLY
    kinds = {"ac": enumerate_teams(ac, k, False, ac_keys), "tow": enumerate_teams(tow, k, False, VERSIONS),
             "tow_repeats": enumerate_teams(tow, k, True, VERSIONS)}
    up.log(f"teams of {k}: AC {len(kinds['ac'].t)} over {len({a.pool for a in ac})} theatres; ToW/Custom "
           f"{len(kinds['tow'].t)} distinct, {len(kinds['tow_repeats'].t)} with repeats", started)
    write_team_table(kinds["ac"], OUT / f"teams_ac{suffix}.csv", ac_keys)
    write_team_table(kinds["tow"], OUT / f"teams_tow{suffix}.csv", VERSIONS)
    write_value_per_point(OUT / "value_per_point.csv", {"ac": ac, "tow": tow})
    write_army_values(OUT / "army_values.csv", {"ac": ac, "tow": tow})

    best = []
    for kind, teams in kinds.items():
        for v in VERSIONS + (AC_ONLY if kind == "ac" else ()):
            for across in (False, True):
                best += [{"kind": kind, **r} for r in best_teams(teams, v, across)]
    with open(OUT / f"best_teams{suffix}.csv", "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(best[0]))
        w.writeheader()
        w.writerows(best)

    results: dict = {"team_size": k, "counts": {kind: int(len(t.t)) for kind, t in kinds.items()},
                     "armies": {"ac": len(ac), "tow": len(tow)}}
    for kind, armies in (("ac", ac), ("tow", tow)):
        for v in VERSIONS:
            curve = value_curve(armies, v)
            results[f"{kind}_{v}"] = {"curve_b": curve["b"], "curve_se": curve["se"],
                                      "lopsided_6_6_12_12_vs_9x4_pct": curve["lopsided_6_6_12_12_vs_9x4_pct"],
                                      "balance": balance_test(kinds[kind], v), "bargains": bargains(armies, curve)}
    for v in VERSIONS:
        gain = np.array([a.value[v] / a.value[v + "_norebate"] - 1 for a in ac])
        results[f"rebates_{v}"] = {"corps_gain_median_pct": round(100 * float(np.median(gain)), 2),
                                   "corps_gain_p90_pct": round(100 * float(np.quantile(gain, 0.9)), 2),
                                   "corps_gain_max_pct": round(100 * float(gain.max()), 2),
                                   "corps_gaining_over_1pct": int((gain > 0.01).sum()),
                                   **rank_shift(kinds["ac"], v, v + "_norebate")}
    for kind in ("ac", "tow"):
        for a, b in (("sb", "full"), ("sb", "noise"), ("full", "noise")):
            results[f"versions_{kind}_{a}_vs_{b}"] = rank_shift(kinds[kind], a, b)
    (OUT / f"team_search{suffix}.json").write_text(json.dumps(results, indent=1, ensure_ascii=False), encoding="utf-8")
    write_summary(best, results, OUT / f"team_search{suffix}.md")
    up.log(f"done → teams_ac{suffix}.csv, teams_tow{suffix}.csv, best_teams{suffix}.csv, team_search{suffix}.json/.md",
           started)
    return 0


def write_summary(best: list[dict], results: dict, path: Path) -> None:
    """A plain dump of the headline tables; the written report is TEAM_BUILDS_REPORT.md."""
    L = [f"# Team search — teams of {results['team_size']} (generated by analysis/team_search.py)", "",
         f"Teams: {results['counts']}. Armies: {results['armies']}.", "",
         "Best team per points total T over every pool (AC: any theatre; ToW + Custom: either side), "
         "valued in `sb`; the `full` / `noise` columns say whether those versions pick the same team.", ""]
    across = {(r["kind"], r["criterion"], r["version"], r["T"]): r for r in best if r["scope"] == "all"}
    for kind, title in (("ac", "Army Corps"), ("tow", "ToW + Custom, distinct armies"),
                        ("tow_repeats", "ToW + Custom, repeats allowed")):
        for crit in ("total", "weakest"):
            L += [f"## {title}, best by {crit}", "", "| T | pool | Ns | team | total | weakest | full | noise |",
                  "|---|---|---|---|---|---|---|---|"]
            for (kd, cr, v, t), r in sorted(across.items(), key=lambda kv: kv[0][3]):
                if (kd, cr, v) != (kind, crit, "sb"):
                    continue
                other = [across.get((kind, crit, o, t)) for o in ("full", "noise")]
                same = ["same" if o and o["members"] == r["members"] else (o["members"] if o else "") for o in other]
                L.append(f"| {t} | {r['pool']} | {r['Ns']} | {r['members']} | {r['total']:.0f} | {r['weakest']:.0f} | "
                         f"{same[0]} | {same[1]} |")
            L.append("")
    L += ["## Numbers", "", "```json", json.dumps(results, indent=1, ensure_ascii=False), "```", ""]
    path.write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
