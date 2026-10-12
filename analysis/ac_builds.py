"""The most cost-effective build for every Army Corps (AC), formation rebates included.

Step A2 of analysis/TEAM_OPTIMISER_PLAN.md. As analysis/cost_effective_builds.py does for
Theatre-of-War and Custom armies, an integer programme finds the build with the most normative
value (analysis/team_values.py: `sb`, `full` or `noise`) — but an AC army also earns the
game's formation rebates (ntw3.lua AC_DivisionBrigade_Bonus; analysis/AC_DISCOUNT_RULES.md):
completing a brigade or a whole division whose roster cap total is n takes (n − 1)% of its full
roster price off. So the optimiser can choose to complete groups when the rebate buys more value.

Integer programme (scipy.optimize.milp, HiGHS), per corps:
  x_j   copies of each unit; 0/1 per combat-general version; 0/1 per staff general (exactly one)
  c_g   0/1 per rebate-earning brigade and division (tools/army_builder_rules.build_roster_totals:
        support divisions earn nothing, the Davout exception keeps its brigades)
  completion   Σ x over the group's placed cards ≥ n_g · c_g   (combat generals count, as in the Lua)
  division     c_brigade + c_division ≤ 1   (a full division replaces its brigades' rebates)
  budget       Σ list price · x − Σ rebate_g · c_g ≤ 10 000
  cards ≤ 31 incl. the staff general; combat generals ≤ the corps' cap (9 − the key's x-digit,
  rules.ts generalCaps) and ≤ 1 per unit; unit caps shared with commander versions; foot
  artillery ≤ 2, horse artillery ≤ 1 (2 for a cavalry-only corps), heavy cavalry ≤ 10.
  objective    Σ value · x + the staff general's value (T3 refitted on AC + the command
               correction of cost_effective_builds.Command, linearised the same way).

The app charges rebates only for groups completed by cards that were each affordable at list
price when recruited (web/src/state/build.ts affordableSubset: a card must fit at list price on
top of the total so far, crediting only rebates already earned). That rule is in the programme:
- the completed groups are recruited in a fixed order ≺ (group_order_key), a division brigade by
  brigade (largest brigade rebate first), then the loose cards;
- q_g ≥ Σ list price · x over the group's cards − M_g(1 − c_g) is the list cost of completed g;
- at each group's completing card: staff + Σ_{h≺g}(q_h − rebate_h·c_h) + q_g − credit_g·c_g ≤
  10 000, where credit_d is what a division's own brigades have already earned by its last card
  (Σ brigade rebates − the smallest); cards inside a group cost less than that step, and loose
  cards always fit once the final cost is ≤ 10 000.
≺ sorts by rebate − credit, descending: swapping two neighbours a, b with r_a − c_a ≤ r_b − c_b
never raises the higher of their completion steps, because a group's list cost is at least its
rebate (an exchange argument), so ≺ is the best order for any set of completed groups.
Every solution is then put in that recruit order (staff general first, as the app's recruitOrder
does) and replayed with analysis/ac_discounts.affordable_prefix and the rules engine. The one
step the rows don't see is a division's inner brigade step when a brigade's rebate exceeds the
next brigade's list cost; a build that fails the replay is cut (no-good on its completed groups)
and the programme re-solved — a safety net that should not fire.

A fourth version, `price`, needs no price model at all (the user's suggestion): a card's value is
its own list price, so the optimiser buys the most face value the 10 000 can reach once rebates are
taken off — in effect the build that squeezes the most out of the formation rebates. Face values
are whole gold, so a tie-break worth under 1 gold in total (1e-5 × the size-band value) picks,
among equal face values, the build the size-band model rates highest. No command correction.
Face value is in each corps' own price scale (price ∝ 1/N), so it ranks builds within a corps,
not corps against each other; the team search uses the model versions for that.

Outputs (analysis/output/teams/): ac_builds_<version>.csv (one row per card, in recruit order)
and ac_build_summary_<version>.csv (one row per corps); `--no-rebates` writes *_norebate.csv.

    py -3.13 analysis/ac_builds.py [--versions sb full noise price] [--max-cards 31]
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import ac_discounts as acd  # noqa: E402
import cost_effective_builds as ceb  # noqa: E402
import common  # noqa: E402
import unit_pricing as up  # noqa: E402
from tools import army_builder_rules as abr  # noqa: E402

OUT = common.TEAMS_OUT
BUILDER_CSV = common.BUILDER_CSV
BUDGET = common.BUDGET
MAX_CUTS = 30
# λ per value version (gold per star per unit of morale deficit; cost_effective_builds). The
# size-band version is a "quality" scale like full harmonisation (team_values.py), so it uses
# full's calibration.
LAMBDA = {"sb": ceb.COMMAND_LAMBDA["full"], "full": ceb.COMMAND_LAMBDA["full"], "noise": ceb.COMMAND_LAMBDA["noise"]}
VERSIONS = ("sb", "full", "noise", "price")
# German Campaign 1813 (both sides) is still being built in the mod: only work-in-progress corps
# (user, 2026-10-10). Left out of the builds and the team study.
WIP_THEATRES = common.WIP_THEATRES
MIP_GAP = 1e-6            # relative MIP gap of the model versions; the app's optimiser uses the same
MIP_GAP_FACE = 1e-8       # `price` (the app's "Formation discount only"): whole-gold face values
PRICE_TIEBREAK = 1e-5     # `price` version: × size-band value, < 1 gold over a whole build


def load_inputs():
    """Rules cards per AC faction, per-card values per version, per-card morale/models/stars."""
    catalog = abr.UnitCatalog.from_csv(BUILDER_CSV)
    values: dict[str, dict[tuple[str, str], float]] = defaultdict(dict)
    with open(OUT / "values_ac.csv", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            for v in ("sb", "full", "noise"):
                values[v][(r["faction_key"], r["unit_key"])] = float(r[f"value_{v}"])
    extra: dict[tuple[str, str], dict] = {}
    names, ratings = {}, up.load_ratings()
    with up.DATA_CSV.open(encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            if r["faction_kind"] != "army_corps":
                continue
            names[r["faction_key"]] = r["army_corps_name"]
            extra[(r["faction_key"], r["unit_key"])] = {
                "morale": up.num(r["morale"]), "models": up.num(r["men_raw"]) / 2,
                "stars": int(up.num(r["command_stars"])), "fast": int(r["speed_code"].startswith("C")),
                "melee": int(up.num(r["melee_attack"]) > ceb.STANDARD_GENERAL_MELEE)}
    for f in {f for (f, _) in values["sb"]}:
        for c in catalog.cards_for_faction(f):
            if (f, c.unit_key) in values["sb"]:
                values["price"][(f, c.unit_key)] = c.mp_cost + PRICE_TIEBREAK * values["sb"][(f, c.unit_key)]
    staff_fit = json.loads((up.ROOT / "analysis" / "output" / "ac" / "ac_staff.json").read_text(encoding="utf-8"))
    return catalog, values, extra, names, ratings, (staff_fit["t3_b"], staff_fit["t3_q"])


def solve_corps(faction: str, catalog: abr.UnitCatalog, value: dict, extra: dict, t3: tuple[float, float],
                command: ceb.Command, max_cards: int, fix: dict[int, int] | None = None,
                face_value: bool = False, rebates: bool = True) -> dict | None:
    """The best legal build of one corps, or None. `fix` pins group binaries (index → 0/1) for the
    brute-force check over group completions; `face_value` values the staff general at its list
    price (the `price` version); `rebates=False` ignores formation rebates (the counterfactual
    that measures what they are worth; the engine still prices the build as the game would)."""
    roster = list(catalog.cards_for_faction(faction))
    units = [c for c in roster if (faction, c.unit_key) in value and c.unit_class != "artillery_fixed"]
    staff = [c for c in roster if abr.classify_general(c) == "staff"]
    if not units or not staff:
        return None
    divisions, brigades = abr.build_roster_totals(roster, faction)
    groups = [("d", d, None, abr.group_discount(t), t.required_count) for d, t in sorted(divisions.items())] + \
             [("b", d, b, abr.group_discount(t), t.required_count) for (d, b), t in sorted(brigades.items())]
    groups = [g for g in groups if g[3] > 0] if rebates else []
    n, m, k = len(units), len(staff), len(groups)
    brigade_rebate = {(g[1], g[2]): g[3] for g in groups if g[0] == "b"}
    credit = [division_credit(g, brigade_rebate) for g in groups]
    rank = sorted(range(k), key=lambda gi: group_order_key(groups[gi], credit[gi]))
    combat_cap = abr.general_caps(faction).combat
    horse_max = abr.horse_artillery_max(roster, faction)
    b, q = t3
    t3_value = [b * extra[(faction, s.unit_key)]["stars"] ** q if extra[(faction, s.unit_key)]["stars"] else 1.0
                for s in staff]
    staff_g = [{"value": s.mp_cost + PRICE_TIEBREAK * t3_value[i] if face_value else t3_value[i],
                "stars": extra[(faction, s.unit_key)]["stars"], "fast": extra[(faction, s.unit_key)]["fast"],
                "melee": extra[(faction, s.unit_key)]["melee"]} for i, s in enumerate(staff)]
    deficit = np.array([command.deficit(extra[(faction, c.unit_key)]) for c in units])
    is_cmd = np.array([abr.classify_general(c) == "combat" for c in units])
    cap_of = {}
    for c in units:
        cap_of.setdefault(c.cap_group_key, c.group_cap if c.group_cap is not None else c.cap)
    ub = np.array([1.0 if is_cmd[j] else float(min(max_cards - 1, cap_of[c.cap_group_key] or max_cards - 1))
                   for j, c in enumerate(units)])
    d_max = float(np.sort(deficit * ub)[-(max_cards - 1):].sum())
    # Columns: x (n) | z (m) | c (k) | w (m) | q (k)
    q0 = n + m + k + m
    nv = q0 + k
    cost = np.array([c.mp_cost for c in units], float)
    scost = np.array([s.mp_cost for s in staff], float)
    obj = np.concatenate([
        -np.array([value[(faction, c.unit_key)] for c in units]) + 1e-6 * cost,
        -np.array([command.constant(g) for g in staff_g]) + 1e-6 * scost,
        np.zeros(k),
        -np.array([command.slope(g) for g in staff_g]),
        np.zeros(k)])
    rows, lo, hi = [], [], []

    def add(coef: dict[int, float], low: float, high: float) -> None:
        row = np.zeros(nv)
        for j, v in coef.items():
            row[j] = v
        rows.append(row)
        lo.append(low)
        hi.append(high)

    add({**{j: cost[j] for j in range(n)}, **{n + i: scost[i] for i in range(m)},
         **{n + m + g: -groups[g][3] for g in range(k)}}, -np.inf, BUDGET)
    add({**{j: 1.0 for j in range(n)}, **{n + i: 1.0 for i in range(m)}}, 0, max_cards)
    add({n + i: 1.0 for i in range(m)}, 1, 1)
    if is_cmd.any():
        add({j: 1.0 for j in range(n) if is_cmd[j]}, 0, combat_cap)
    by_group = defaultdict(list)
    for j, c in enumerate(units):
        by_group[c.cap_group_key].append(j)
    for key, idx in by_group.items():
        if cap_of[key] > 0 and len(idx) > 1:
            add({j: 1.0 for j in idx}, 0, cap_of[key])
        gens = [j for j in idx if is_cmd[j]]
        if len(gens) > 1:
            add({j: 1.0 for j in gens}, 0, 1)
    for cls, cap in (("artillery_foot", 2), ("artillery_horse", horse_max), ("cavalry_heavy", 10)):
        idx = [j for j, c in enumerate(units) if abr._capped_class_of(c) == cls]
        if idx:
            add({j: 1.0 for j in idx}, 0, cap)
    members = [[j for j, c in enumerate(units) if in_group(c, kind, d, bri)] for kind, d, bri, _, _ in groups]
    big_m = [float(sum(cost[j] * ub[j] for j in members[g])) for g in range(k)]
    for g, (_, _, _, _, need) in enumerate(groups):
        add({**{j: 1.0 for j in members[g]}, n + m + g: -float(need)}, 0, np.inf)
        add({q0 + g: 1.0, **{j: -cost[j] for j in members[g]}, n + m + g: -big_m[g]}, -big_m[g], np.inf)
    for pos, g in enumerate(rank):                                # affordability at each completing card
        coef = {n + i: scost[i] for i in range(m)}
        for h in rank[:pos]:
            coef[q0 + h] = 1.0
            coef[n + m + h] = -float(groups[h][3])
        coef[q0 + g] = 1.0
        coef[n + m + g] = -float(credit[g])
        add(coef, -np.inf, BUDGET)
    div_col = {d: n + m + g for g, (kind, d, _, _, _) in enumerate(groups) if kind == "d"}
    for g, (kind, d, _, _, _) in enumerate(groups):
        if kind == "b" and d in div_col:
            add({n + m + g: 1.0, div_col[d]: 1.0}, -np.inf, 1)
    w0 = n + m + k
    for i in range(m):
        add({w0 + i: 1.0, **{j: -deficit[j] for j in range(n) if deficit[j] > 0}}, -np.inf, 0)
        add({w0 + i: 1.0, n + i: -d_max}, -np.inf, 0)
    bounds_ub = np.concatenate([ub, np.ones(m), np.ones(k), np.full(m, d_max), np.array(big_m)])
    bounds_lb = np.zeros(nv)
    for g, v in (fix or {}).items():
        bounds_lb[n + m + g] = bounds_ub[n + m + g] = v
    integrality = np.concatenate([np.ones(n + m + k), np.zeros(m + k)])

    cuts = 0
    while True:
        res = milp(obj, constraints=LinearConstraint(np.array(rows), lo, hi), integrality=integrality,
                   bounds=Bounds(bounds_lb, bounds_ub), options={"time_limit": 60, "mip_rel_gap": MIP_GAP_FACE if face_value else MIP_GAP})
        if res.x is None:
            return None
        x = np.round(res.x).astype(int)
        chosen = [(units[j], int(x[j])) for j in range(n) if x[j] > 0]
        general = staff[int(np.flatnonzero(x[n:n + m])[0])]
        completed = [groups[g] for g in range(k) if x[n + m + g]]
        order = recruit_order(general, chosen, completed, brigade_rebate)
        selected = order[1:] + order[:1]                          # instances first, staff slot last (expandBuild)
        price = abr.calculate_army_cost(selected, roster, faction)
        affordable = acd.affordable_prefix(order, roster, faction)
        limits = abr.check_known_limits(selected, faction, staff_slot_index=len(selected) - 1, recruitable_cards=roster)
        if len(affordable) == len(order) and price.final_cost <= BUDGET and limits.valid:
            break
        if cuts >= MAX_CUTS or not completed:
            return None
        cols = [n + m + g for g in range(k) if x[n + m + g]]
        add({**{c: 1.0 for c in cols}, **{n + m + g: -1.0 for g in range(k) if not x[n + m + g]}},
            -np.inf, len(cols) - 1)
        cuts += 1
    unit_value = sum(value[(faction, c.unit_key)] * cnt for c, cnt in chosen)
    gi = staff.index(general)
    d_build = sum(command.deficit(extra[(faction, c.unit_key)]) * cnt for c, cnt in chosen)
    g_value = command.constant(staff_g[gi]) + command.slope(staff_g[gi]) * d_build
    total_value = unit_value + g_value
    claimed = int(sum(c.mp_cost * cnt for c, cnt in chosen) + general.mp_cost - sum(g[3] for g in completed))
    return {"order": order, "price": price, "value": total_value, "general_value": g_value,
            "chosen": chosen, "general": general, "staff_g": staff_g[gi], "t3_value": t3_value[gi],
            "completed": completed, "cuts": cuts, "claimed_cost": claimed, "objective": -float(res.fun),
            "groups": groups, "pattern": tuple(int(v) for v in x[n + m:n + m + k]), "combat": int(sum(cnt for c, cnt in chosen if abr.classify_general(c) == "combat"))}


def in_group(card: abr.UnitCard, kind: str, division: int, brigade: int | None) -> bool:
    """Whether a card counts towards a group: placed in its division (and brigade, for a brigade).
    Combat generals carry their unit's placement and count, as in the Lua."""
    return (card.placement is not None and card.placement.division_id == division
            and (kind == "d" or card.placement.brigade_id == brigade))


def division_credit(group: tuple, brigade_rebate: dict[tuple[int, int], int]) -> int:
    """Rebate a division's own brigades have earned by the time its last card is taken, when it is
    recruited brigade by brigade, largest brigade rebate first: all but the smallest. 0 for a brigade."""
    kind, division = group[0], group[1]
    inside = [r for (d, _), r in brigade_rebate.items() if d == division] if kind == "d" else []
    return sum(inside) - min(inside) if inside else 0


def group_order_key(group: tuple, credit: int) -> tuple:
    """≺, the recruit order of completed groups: rebate − credit descending (see the module
    docstring), then division before brigade, division id, brigade id. web/src/state/acOptimiser.ts
    compareRebateGroups sorts the same way; keep the two identical or parity breaks on ties."""
    kind, division, brigade, rebate, _ = group
    return (-(rebate - credit), 0 if kind == "d" else 1, division, brigade or 0)


def recruit_order(general: abr.UnitCard, chosen: list[tuple[abr.UnitCard, int]], completed: list,
                  brigade_rebate: dict[tuple[int, int], int]) -> list[abr.UnitCard]:
    """Staff general first (the app recruits the staff slot first); then each completed group in ≺
    order — a division brigade by brigade: its cards outside rebate brigades first, then its rebate
    brigades largest rebate first — members by descending price; then the loose cards."""
    pool = [c for c, cnt in chosen for _ in range(cnt)]
    order = [general]
    completed = sorted(completed, key=lambda g: group_order_key(g, division_credit(g, brigade_rebate)))
    for kind, d, bri, _, _ in completed:
        members = [c for c in pool if in_group(c, kind, d, bri)]
        for c in members:
            pool.remove(c)
        if kind == "d":
            def segment(c: abr.UnitCard, d: int = d) -> tuple:
                key = (d, c.placement.brigade_id)
                return (1, -brigade_rebate[key], key[1]) if key in brigade_rebate else (0, 0, 0)
            members.sort(key=lambda c: (segment(c), -c.mp_cost))
        else:
            members.sort(key=lambda c: -c.mp_cost)
        order += members
    return order + sorted(pool, key=lambda c: -c.mp_cost)


def check(version: str, catalog, values, extra, t3, command, max_cards: int, started: float) -> None:
    face = version == "price"
    """Verification (plan A2): every build re-prices in the rules engine at or below the MILP's own
    cost (below only when a group the MILP did not count happens to complete too), and on small
    corps the optimum equals the best over every allowed pattern of group completions."""
    import itertools
    faction_list = sorted({f for (f, _) in values if not common.is_wip(f)})
    lower, equal, small = 0, 0, []
    for f in faction_list:
        res = solve_corps(f, catalog, values, extra, t3, command, max_cards, face_value=face)
        if res is None:
            continue
        final = res["price"].final_cost
        assert final <= res["claimed_cost"] <= BUDGET, (f, final, res["claimed_cost"])
        equal += final == res["claimed_cost"]
        lower += final < res["claimed_cost"]
        if 2 <= len(res["groups"]) <= 6:
            small.append((len(res["groups"]), f, res))
    up.log(f"check {version}: rules engine = MILP cost on {equal} corps, lower on {lower} (an extra group "
           f"completed for free); none above", started)
    for _, f, res in sorted(small, key=lambda t: (-t[0], t[1]))[:3]:
        groups = res["groups"]
        div_of = {gi: g[1] for gi, g in enumerate(groups) if g[0] == "d"}
        best, best_pattern = -np.inf, None
        for pattern in itertools.product((0, 1), repeat=len(groups)):
            if any(pattern[gi] and pattern[di] for gi, g in enumerate(groups) if g[0] == "b"
                   for di, d in div_of.items() if d == g[1]):
                continue
            r = solve_corps(f, catalog, values, extra, t3, command, max_cards, fix=dict(enumerate(pattern)),
                            face_value=face)
            if r is not None and r["objective"] > best + 1e-6:
                best, best_pattern = r["objective"], pattern
        ok = abs(best - res["objective"]) < 1e-3
        up.log(f"  brute force {f}: {len(groups)} groups, {2 ** len(groups)} patterns; best {best:.2f} "
               f"{best_pattern} vs MILP {res['objective']:.2f} {res['pattern']} → {'OK' if ok else 'MISMATCH'}", started)
        assert ok, f


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--versions", nargs="+", default=list(VERSIONS), choices=VERSIONS)
    parser.add_argument("--max-cards", type=int, default=31)
    parser.add_argument("--check", action="store_true", help="verify the builds instead of writing them")
    parser.add_argument("--no-rebates", action="store_true", help="optimise as if formation rebates did not exist")
    args = parser.parse_args()
    started = time.time()
    catalog, values, extra, names, ratings, t3 = load_inputs()
    melee = ceb.bodyguard_melee_bonus()
    sb_command = ceb.Command(LAMBDA["sb"], ceb.SPEED_BONUS, melee)

    def value_sb(f: str, res: dict) -> float:
        """The same build on the size-band scale, so the versions compare on one ruler."""
        g = {**res["staff_g"], "value": res["t3_value"]}
        d = sum(sb_command.deficit(extra[(f, c.unit_key)]) * k for c, k in res["chosen"])
        return sum(values["sb"][(f, c.unit_key)] * k for c, k in res["chosen"]) + sb_command.constant(g) +             sb_command.slope(g) * d

    factions = sorted({f for (f, _) in values["sb"] if not common.is_wip(f)})
    OUT.mkdir(parents=True, exist_ok=True)
    for version in args.versions:
        face = version == "price"
        tag = "_norebate" if args.no_rebates else ""
        command = ceb.Command(0.0, 0.0, 0.0) if face else ceb.Command(LAMBDA[version], ceb.SPEED_BONUS, melee)
        if args.check:
            check(version, catalog, values[version], extra, t3, command, args.max_cards, started)
            continue
        summary, lines = [], []
        for f in factions:
            res = solve_corps(f, catalog, values[version], extra, t3, command, args.max_cards, face_value=face,
                              rebates=not args.no_rebates)
            if res is None:
                summary.append([f, names.get(f, f), ratings.get(f, ""), common.theatre_of(f), "", "", "", "", "", "", "", "",
                                "", "no legal build"])
                continue
            p = res["price"]
            if face:
                res["value"] = p.base_cost                        # drop the sub-gold tie-break
            summary.append([f, names[f], ratings[f], common.theatre_of(f), len(res["order"]), p.base_cost,
                            p.applied_discount, p.final_cost, f"{res['value']:.1f}",
                            f"{res['value'] / p.final_cost:.4f}", f"{value_sb(f, res):.1f}", len(res["completed"]),
                            res["combat"],
                            f"{res['order'][0].unit_key} ({res['cuts']} cuts)"])
            for pos, c in enumerate(res["order"]):
                v = c.mp_cost if face else values[version].get((f, c.unit_key), res["general_value"])
                lines.append([f, version, pos, c.unit_key, c.mp_cost, f"{v:.1f}"])
        with open(OUT / f"ac_build_summary_{version}{tag}.csv", "w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["faction_key", "army_corps_name", "corps_number", "theatre", "cards", "list_cost", "rebate",
                        "final_cost", "value", "efficiency", "value_sb", "groups_completed", "combat_generals", "staff (cuts)"])
            w.writerows(summary)
        with open(OUT / f"ac_builds_{version}{tag}.csv", "w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["faction_key", "version", "recruit_position", "unit_key", "list_price", "value"])
            w.writerows(lines)
        built = sum(1 for s in summary if s[4] != "")
        up.log(f"{version}: {built} of {len(factions)} AC corps built → ac_build_summary_{version}{tag}.csv", started)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
