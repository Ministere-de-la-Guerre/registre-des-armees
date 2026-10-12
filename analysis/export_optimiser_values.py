"""Export the cost-effective-builds valuation for the app's in-app optimiser.

The app's "Optimise" panel (web/src/state/optimiser.ts, and acOptimiser.ts for Army Corps)
solves the same integer programmes as analysis/cost_effective_builds.py solve() (Theatres of War
and Custom armies) and analysis/ac_builds.py solve_corps() (Army Corps, formation rebates and
recruit order included), in the browser with HiGHS. It cannot run the pricing models, so this
script ships what it needs as data.

Value modes (the app's names → the analysis versions):
- ToW / Custom: "quantity" = noise-only size harmonisation (the size discount is kept),
  "quality" = full harmonisation (the size bias is removed) — cost_effective_builds.py.
- Army Corps: "quantity" = noise-only harmonisation of the AC fits, "sizeBands" = the size-band
  model of the AC study (F6) — analysis/team_values.py. The user replaced Quality with Size bands
  for AC (2026-10-10). The third AC mode, "formationDiscount" (ac_builds.py `price`), values a card
  at its list price and needs no data beyond the size-band tie-break.
German Campaign 1813 (common.WIP_THEATRES) is work in progress in the mod and gets no values.

Files (data/generated/, committed; rebuilding needs the analysis outputs and .cache checkpoints):
- ntw3_optimiser_values.csv — every valued unit and commander card: faction_key, unit_key,
  value_quality, value_quantity, value_size_bands (blank where the army's pool has no such mode).
  Staff generals are not listed: the app values them from their stars (T3) plus the command
  correction, which depends on the build.
- ntw3_optimiser_params.json — {"pools": {"tow": {...}, "ac": {...}}}: per pool the staff rule T3
  (b, q; AC uses its own refit, analysis/output/ac/ac_staff.json), the command correction (m_ref,
  λ per mode, σ, melee bonus) and the standard general's melee attack.
- ntw3_optimiser_army_values.csv — every army's best-build value per mode (analysis/team_search.py
  army_values.csv: AC builds from ac_builds.py, ToW / Custom one-roll builds): the planner's
  "Suggest a team" ranks teams with it when nothing constrains the builds. AC rows also carry
  value_formation_discount, the "Formation discount only" team score face / 10 000 × N.
tools/build_web_data.py merges values and the pool's params into each faction JSON and the army
values into corps-index.json.

Parity with the Python optimisers (two stages, because the app-side fixture needs the cards
exactly as the app sees them, which only exist after the pipeline):
1. this script also writes analysis/output/optimiser_parity_python.json — Python's builds for a
   few armies in every mode;
2. after `python tools/build_web_data.py`, `--fixture` joins those builds with the generated
   faction files into web/src/state/__fixtures__/optimiser-parity.json, which
   web/src/state/optimiser.parity.test.ts checks the TypeScript optimiser against.

    py -3.13 analysis/export_optimiser_values.py              # values, params, army values, Python builds
    py -3.13 tools/build_web_data.py                          # → web/public/data (with values)
    py -3.13 analysis/export_optimiser_values.py --fixture    # → the app's parity fixture
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ac_builds as ab  # noqa: E402
import cost_effective_builds as ceb  # noqa: E402
import common  # noqa: E402
import unit_pricing as up  # noqa: E402

GENERATED = common.GENERATED
VALUES_CSV = GENERATED / "ntw3_optimiser_values.csv"
PARAMS_JSON = GENERATED / "ntw3_optimiser_params.json"
ARMY_VALUES_CSV = GENERATED / "ntw3_optimiser_army_values.csv"
TEAMS = common.TEAMS_OUT
PYTHON_BUILDS = ceb.OUT / "optimiser_parity_python.json"
FACTIONS = up.ROOT / "web" / "public" / "data" / "factions"
FIXTURE = up.ROOT / "web" / "src" / "state" / "__fixtures__" / "optimiser-parity.json"
# App mode → analysis version, per pool.
TOW_MODES = {"quality": "full", "quantity": "noise"}
AC_MODES = {"quantity": "noise", "sizeBands": "sb"}
MODE_COLUMN = {"quality": "value_quality", "quantity": "value_quantity", "sizeBands": "value_size_bands"}
# Army values also rank AC teams in "Formation discount only": team_search.py's `price` score,
# face / 10 000 × N of the best formation-discount build (no card values: a card is worth its price).
ARMY_MODE_COLUMN = {**MODE_COLUMN, "formationDiscount": "value_formation_discount"}
AC_ARMY_MODES = {**AC_MODES, "formationDiscount": "price"}
# Parity armies. ToW / Custom: a ToW army with a cheap 2★ anchor general, a ToW army anchored on
# Murat (C4), and a Custom army (no source corps). AC: Davout I.C 1812 (the support-division brigade
# exception), Bonaparte / Italie.C (the verified division-5 placement override) and Eugène / Italie
# (10 no-good cuts before the recruit-order rows went into the model).
PARITY_ARMIES = ("ntw3_tow_b06_x8_009", "ntw3_tow_c14_x8_030", "ntw3_hre")
AC_PARITY_ARMIES = ("ntw3_ac_a11_x5_117", "ntw3_ac_a03_x5_080", "ntw3_ac_a08_x5_242")
# Card fields the optimisers read (web/src/state/optimiser.ts, acOptimiser.ts, rules.ts pricing);
# the fixture keeps only these.
FIXTURE_FIELDS = ("unitKey", "factionKey", "unitClass", "underlyingUnitClass", "cost", "menRaw", "speedCode",
                  "commandStars", "isGeneral", "isCommanderVariant", "generalKind", "cap", "groupCap",
                  "capGroupKey", "baseUnitKey", "stats", "optimiserValue", "name", "division", "brigade",
                  "placementSource", "rosterIndex")


def tow_values(started: float, melee: float) -> tuple[dict, dict]:
    """ToW / Custom card values per mode, and Python's parity builds."""
    values: dict[tuple[str, str], dict[str, float]] = {}
    python_builds: dict[str, dict] = {}
    for mode, version in TOW_MODES.items():
        by_faction, staff_of, top_star, army_of = ceb.load_cards(started, size_mode=version)
        for f, cards in by_faction.items():
            for c in cards:
                values.setdefault((f, c["key"]), {})[mode] = c["value"]
        command = ceb.Command(ceb.COMMAND_LAMBDA[version], ceb.SPEED_BONUS, melee)
        for f in PARITY_ARMIES:
            for variant, chosen, general in ceb.army_builds(by_faction[f], staff_of[f], top_star[f], command,
                                                            ("max value", "four corps")):
                python_builds.setdefault(f, {})[f"{mode}/{variant}"] = {
                    "objective": sum(c["value"] * k for c, k in chosen) + general["value"],
                    "cost": sum(c["cost"] * k for c, k in chosen) + general["cost"],
                    "staff": general["key"],
                    "units": sorted([c["key"], k] for c, k in chosen)}
        up.log(f"ToW {mode} ({version}) values for {len(by_faction)} armies", started)
    missing = [k for k, v in values.items() if set(v) != set(TOW_MODES)]
    if missing:
        raise SystemExit(f"{len(missing)} ToW cards lack a value in one mode, e.g. {missing[:3]}")
    return values, python_builds


def ac_values() -> dict[tuple[str, str], dict[str, float]]:
    """AC card values per mode from analysis/team_values.py, WIP theatres left out."""
    values = {}
    with open(TEAMS / "values_ac.csv", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if common.is_wip(r["faction_key"]):
                continue
            values[(r["faction_key"], r["unit_key"])] = {mode: float(r[f"value_{version}"])
                                                         for mode, version in AC_MODES.items()}
    return values


def ac_python_builds(melee: float, started: float) -> dict[str, dict]:
    """ac_builds.solve_corps' build of each AC parity army in each app mode."""
    catalog, values, extra, _, _, t3 = ab.load_inputs()
    out: dict[str, dict] = {}
    for f in AC_PARITY_ARMIES:
        for mode, version in (*AC_MODES.items(), ("formationDiscount", "price")):
            face = version == "price"
            command = ceb.Command(0.0, 0.0, 0.0) if face else ceb.Command(ab.LAMBDA[version], ceb.SPEED_BONUS, melee)
            res = ab.solve_corps(f, catalog, values[version], extra, t3, command, 31, face_value=face)
            p = res["price"]
            out.setdefault(f, {})[f"{mode}/max value"] = {
                "objective": res["value"], "cost": p.final_cost, "listCost": p.base_cost,
                "rebate": p.applied_discount, "staff": res["general"].unit_key, "cuts": res["cuts"],
                "groups": sorted(f"{g.group_type}:{g.division_id}:{g.brigade_id or 0}" for g in p.completed_groups),
                "units": sorted([c.unit_key, k] for c, k in res["chosen"]),
                "order": [c.unit_key for c in res["order"]]}
        up.log(f"AC parity builds: {f}", started)
    return out


def params_block(t3: tuple[float, float], modes: dict[str, str], melee: float) -> dict:
    b, q = t3
    return {"t3_b": b, "t3_q": q, "m_ref": ceb.M_REF,
            "lambda": {mode: ceb.COMMAND_LAMBDA["full" if version == "sb" else version] for mode, version in modes.items()},
            "speed_bonus": ceb.SPEED_BONUS, "melee_bonus": melee,
            "standard_general_melee": ceb.STANDARD_GENERAL_MELEE}


def export(started: float) -> None:
    melee = ceb.bodyguard_melee_bonus()
    values, python_builds = tow_values(started, melee)
    ac = ac_values()
    overlap = set(values) & set(ac)
    if overlap:
        raise SystemExit(f"{len(overlap)} cards valued as both ToW and AC, e.g. {list(overlap)[:3]}")
    values.update(ac)
    python_builds.update(ac_python_builds(melee, started))

    builder_keys = set()
    with (GENERATED / "ntw3_army_builder_units.csv").open(encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            builder_keys.add((r["faction_key"], r["unit_key"]))
    unknown = [k for k in values if k not in builder_keys]
    if unknown:
        raise SystemExit(f"{len(unknown)} valued cards are not in the builder CSV, e.g. {unknown[:3]}")

    with VALUES_CSV.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["faction_key", "unit_key", *MODE_COLUMN.values()])
        for (f, k), v in sorted(values.items()):
            w.writerow([f, k, *(f"{v[mode]:.6f}" if mode in v else "" for mode in MODE_COLUMN)])

    staff_fit = json.loads((up.ROOT / "analysis" / "output" / "ac" / "ac_staff.json").read_text(encoding="utf-8"))
    PARAMS_JSON.write_text(json.dumps({
        "pools": {"tow": params_block(ceb.staff_value_rule(), TOW_MODES, melee),
                  "ac": params_block((staff_fit["t3_b"], staff_fit["t3_q"]), AC_MODES, melee)},
        "generated": date.today().isoformat(),
        "source": "analysis/export_optimiser_values.py (cost_effective_builds.py and ac_builds.py valuations)"},
        indent=2) + "\n", encoding="utf-8")

    with open(TEAMS / "army_values.csv", encoding="utf-8") as fh:
        armies = list(csv.DictReader(fh))
    with ARMY_VALUES_CSV.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["faction_key", *ARMY_MODE_COLUMN.values()])
        for r in sorted(armies, key=lambda r: r["faction_key"]):
            modes = AC_ARMY_MODES if r["kind"] == "ac" else TOW_MODES
            w.writerow([r["faction_key"], *(f"{float(r[f'value_{modes[mode]}']):.3f}" if mode in modes else ""
                                            for mode in ARMY_MODE_COLUMN)])

    PYTHON_BUILDS.write_text(json.dumps(python_builds, indent=2) + "\n", encoding="utf-8")
    up.log(f"{len(values)} cards in {len({f for f, _ in values})} armies → {VALUES_CSV.relative_to(up.ROOT)}; "
           f"params → {PARAMS_JSON.relative_to(up.ROOT)}; {len(armies)} army values → "
           f"{ARMY_VALUES_CSV.relative_to(up.ROOT)}; Python builds → {PYTHON_BUILDS.relative_to(up.ROOT)}", started)


def fixture(started: float) -> None:
    """Join Python's builds with the generated faction files into the app's parity fixture."""
    if not PYTHON_BUILDS.exists():
        raise SystemExit(f"run without --fixture first ({PYTHON_BUILDS.relative_to(up.ROOT)} is missing)")
    python_builds = json.loads(PYTHON_BUILDS.read_text(encoding="utf-8"))
    armies = {}
    for f, builds in python_builds.items():
        path = FACTIONS / f"{f}.json"
        if not path.exists():
            raise SystemExit(f"{path} is missing: run tools/build_web_data.py first")
        roster = json.loads(path.read_text(encoding="utf-8"))
        if "optimiser" not in roster:
            raise SystemExit(f"{path} has no optimiser params: rebuild it after exporting the values")
        armies[f] = {"optimiser": roster["optimiser"],
                     "cards": [{k: c[k] for k in FIXTURE_FIELDS if k in c} for c in roster["cards"]],
                     "python": builds}
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps({"generated": date.today().isoformat(),
                                   "source": "analysis/export_optimiser_values.py --fixture",
                                   "armies": armies}, separators=(",", ":"), ensure_ascii=False) + "\n",
                       encoding="utf-8")
    up.log(f"parity fixture for {len(armies)} armies → {FIXTURE.relative_to(up.ROOT)}", started)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--fixture", action="store_true",
                        help="only build the app's parity fixture (after tools/build_web_data.py)")
    args = parser.parse_args()
    started = time.time()
    fixture(started) if args.fixture else export(started)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
