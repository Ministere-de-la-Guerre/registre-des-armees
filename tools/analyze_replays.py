"""Turn a folder of .replay files into the CSVs tools/build_pick_rates.py consumes.

Every battle is parsed and checked. Two levels: a battle is dropped whole for
parse_error / naval / duplicate (excluded_battles.csv); otherwise it is accepted and each
army that is unverifiable / over budget / breaks a limit is dropped alone
(excluded_armies.csv), leaving its siblings counted normally.

    python3 tools/analyze_replays.py --replays data/clan_games_replays/season_8 \\
        --out reports/replay_stats/season-8

Battle reasons: parse_error, naval, duplicate. Army reasons (first match recorded):
unverifiable, over_budget, limit_violation. Checks apply to ALL armies (AC, TOW, custom);
narrowing to Army Corps is build_pick_rates.py's job. See docs/PICK_RATES.md.
"""
from __future__ import annotations

import argparse
import csv
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).parent))

from army_builder_rules import (  # noqa: E402
    RuleDataError, UnitCard, calculate_army_cost, check_known_limits, load_unit_cards,
)
from replay_parser import Army, Battle, parse  # noqa: E402

UNITS_CSV = ROOT / "data" / "generated" / "ntw3_army_builder_units.csv"
OUT_DEFAULT = ROOT / "reports" / "replay_stats"

#: Mirrors MAX_BUILD_COST in web/src/rules/rules.ts.
MAX_BUILD_COST = 10000

#: Naval clan games are a different game; their unit keys carry this prefix.
NAVAL_PREFIX = "ntw3_nav_"

BATTLE_REASONS = ("parse_error", "naval", "duplicate")
ARMY_REASONS = ("unverifiable", "over_budget", "limit_violation")


@dataclass
class Rosters:
    """Unit cards indexed the two ways the checks need them."""
    by_faction: dict[str, list[UnitCard]]
    lookup: dict[tuple[str, str], UnitCard]

    @classmethod
    def from_cards(cls, cards: Sequence[UnitCard]) -> "Rosters":
        by_faction: dict[str, list[UnitCard]] = defaultdict(list)
        for c in cards:
            by_faction[c.faction_key].append(c)
        return cls(dict(by_faction), {(c.faction_key, c.unit_key): c for c in cards})


@dataclass
class AcceptedArmy:
    index: int  #: original position in battle.armies; never renumbered after drops
    army: Army
    staff: UnitCard | None
    units: list[UnitCard]
    commanders: list[bool]  #: parallel to `units`
    final_cost: int = 0


@dataclass
class DroppedArmy:
    index: int
    army: Army
    reason: str
    detail: str


@dataclass
class Verdict:
    """Outcome for one battle. `reason` set = whole battle dropped; otherwise the battle
    is accepted with its kept armies, and rule-breaking armies listed in `dropped`."""
    reason: str = ""
    detail: str = ""
    armies: list[AcceptedArmy] = field(default_factory=list)
    dropped: list[DroppedArmy] = field(default_factory=list)

    @property
    def accepted(self) -> bool:
        return not self.reason


def fingerprint(battle: Battle) -> tuple:
    """Same game uploaded twice -> same fingerprint (order of armies irrelevant).

    Taken over ALL parsed armies, before any army is dropped, so two uploads still match
    when one army in them breaks a rule."""
    return (
        battle.map,
        tuple(sorted(
            (a.army_key, a.player, a.staff_key or "", tuple(u.key for u in a.units))
            for a in battle.armies
        )),
    )


def evaluate_army(index: int, a: Army, rosters: Rosters) -> AcceptedArmy | DroppedArmy:
    """Army-level rules: unverifiable, over_budget, limit_violation (in that order)."""
    roster = rosters.by_faction.get(a.army_key)
    if roster is None:
        return DroppedArmy(index, a, "unverifiable", f"{a.army_key} (no roster)")

    unresolved: list[str] = []
    staff = None
    units: list[UnitCard] = []
    commanders: list[bool] = []
    if a.staff_key:
        staff = rosters.lookup.get((a.army_key, a.staff_key))
        if staff is None:
            unresolved.append(a.staff_key)
        elif not staff.is_general:
            # The army fielded no staff general; the parser positionally read its first
            # unit as the staff slot. Put that card back as an ordinary unit copy.
            units.append(staff)
            commanders.append(False)
            staff = None
    for u in a.units:
        c = rosters.lookup.get((a.army_key, u.key))
        if c is None:
            unresolved.append(u.key)
        else:
            units.append(c)
            commanders.append(bool(u.is_commander))
    if unresolved:
        return DroppedArmy(index, a, "unverifiable", " ".join(sorted(set(unresolved))))

    selected = ([staff] if staff else []) + units
    cost = calculate_army_cost(selected, roster, a.army_key).final_cost
    if cost > MAX_BUILD_COST:
        return DroppedArmy(index, a, "over_budget", f"{cost} MP")
    try:
        check = check_known_limits(
            selected, a.army_key,
            staff_slot_index=0 if staff else None, recruitable_cards=roster,
        )
    except RuleDataError as exc:  # safety net: an army the rules engine cannot evaluate
        return DroppedArmy(index, a, "limit_violation", str(exc))
    if check.violations:
        rules = ", ".join(f"{v.rule} {v.actual}>{v.maximum}" for v in check.violations)
        return DroppedArmy(index, a, "limit_violation", rules)
    return AcceptedArmy(index, a, staff, units, commanders, cost)


def evaluate(battle: Battle, rosters: Rosters, seen: set[tuple]) -> Verdict:
    """Battle-level rules (naval, duplicate), then per-army rules on what is left."""
    if not battle.armies:
        return Verdict("naval", "no armies in battle")
    for a in battle.armies:
        if any(k.startswith(NAVAL_PREFIX) for k in [a.staff_key or "", *(u.key for u in a.units)]):
            return Verdict("naval", f"{NAVAL_PREFIX}* key in {a.army_key}")

    fp = fingerprint(battle)
    if fp in seen:
        return Verdict("duplicate", "identical to an earlier accepted battle")
    seen.add(fp)

    verdict = Verdict()
    for i, a in enumerate(battle.armies):
        r = evaluate_army(i, a, rosters)
        (verdict.dropped if isinstance(r, DroppedArmy) else verdict.armies).append(r)
    return verdict


def army_unit_rows(battle_id: str, r: AcceptedArmy) -> list[dict]:
    """One row per card copy; the staff general is slot 0 and never a commander."""
    key = r.army.army_key
    rows = []
    slot = 0
    if r.staff:
        rows.append(_row(battle_id, r.index, key, slot, r.staff, False, True))
        slot += 1
    for card, is_com in zip(r.units, r.commanders):
        rows.append(_row(battle_id, r.index, key, slot, card, is_com, False))
        slot += 1
    return rows


def _row(battle_id, index, army_key, slot, card, is_commander, is_staff) -> dict:
    return {
        "battle_id": battle_id, "army_index": index, "army_key": army_key, "slot": slot,
        "unit_key": card.unit_key, "base_unit_key": card.cap_group_key or card.unit_key,
        "is_commander": is_commander, "is_staff_slot": is_staff, "resolved": True,
    }


DATE_RES = [
    re.compile(r"\b\d{4}-\d{1,2}-\d{1,2}\b"),
    re.compile(r"\b\d{1,2}\.\d{1,2}\.\d{2,4}\b"),
    re.compile(r"\b\d{1,2}-\d{1,2}-\d{2}\b"),
]


def filename_dates(names: Sequence[str]) -> list[str]:
    found = []
    for n in names:
        for rx in DATE_RES:
            found += rx.findall(n)
    return found


def write_csv(path: Path, header: list[str], rows: Sequence[dict]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        w = csv.DictWriter(handle, fieldnames=header)
        w.writeheader()
        w.writerows(rows)


def analyze(replays: Sequence[Path], out: Path, rosters: Rosters, parse_fn=parse) -> dict:
    """Analyze one or more replay folders into `out`.

    One folder: battle_id is the file name. Several: `<folder>/<file>`, since the same file
    name can recur across seasons. Duplicate detection spans all folders in the run, so a
    game uploaded in two seasons counts once. Folders in the order given, files sorted."""
    files: list[Path] = []
    for folder in replays:
        files += sorted(folder.glob("*.replay"), key=lambda p: p.name)
    prefixed = len(replays) > 1
    seen: set[tuple] = set()
    battles, armies, units, excluded, excluded_armies = [], [], [], [], []
    for f in files:
        bid = f"{f.parent.name}/{f.name}" if prefixed else f.name
        try:
            battle = parse_fn(f.read_bytes())
        except Exception as exc:  # noqa: BLE001 - any parser failure excludes the file
            excluded.append({"battle_id": bid, "reason": "parse_error",
                             "detail": f"{type(exc).__name__}: {exc}"})
            continue
        v = evaluate(battle, rosters, seen)
        if not v.accepted:
            excluded.append({"battle_id": bid, "reason": v.reason, "detail": v.detail})
            continue
        battles.append({"battle_id": bid, "game_build": battle.game_build, "map": battle.map,
                        "victory_condition": battle.victory_condition, "wind": battle.wind,
                        "armies": len(v.armies)})
        for d in v.dropped:
            excluded_armies.append({"battle_id": bid, "army_index": d.index,
                                    "army_key": d.army.army_key, "player": d.army.player,
                                    "reason": d.reason, "detail": d.detail})
        for r in v.armies:
            a = r.army
            armies.append({"battle_id": bid, "army_index": r.index, "army_key": a.army_key,
                           "corps_name": a.corps_name, "player": a.player, "side": a.side,
                           "staff_key": a.staff_key or "", "units": len(r.units),
                           "final_cost": r.final_cost})
            units += army_unit_rows(bid, r)

    player_battles: dict[str, set[str]] = defaultdict(set)
    player_armies: Counter[str] = Counter()
    appear: Counter[tuple[str, str]] = Counter()
    corps_players: dict[tuple[str, str], set[str]] = defaultdict(set)
    for a in armies:
        appear[(a["army_key"], a["corps_name"])] += 1
        if a["player"]:
            player_battles[a["player"]].add(a["battle_id"])
            player_armies[a["player"]] += 1
            corps_players[(a["army_key"], a["corps_name"])].add(a["player"])
    players = [{"player": p, "battles": len(player_battles[p]), "armies": player_armies[p]}
               for p in sorted(player_armies)]
    popularity = [{"army_key": k, "corps_name": n, "appearances": c,
                   "distinct_players": len(corps_players[(k, n)])}
                  for (k, n), c in sorted(appear.items())]

    out.mkdir(parents=True, exist_ok=True)
    write_csv(out / "battles.csv", ["battle_id", "game_build", "map", "victory_condition", "wind", "armies"], battles)
    write_csv(out / "armies.csv", ["battle_id", "army_index", "army_key", "corps_name", "player",
                                   "side", "staff_key", "units", "final_cost"], armies)
    write_csv(out / "army_units.csv", ["battle_id", "army_index", "army_key", "slot", "unit_key",
                                       "base_unit_key", "is_commander", "is_staff_slot", "resolved"], units)
    write_csv(out / "players.csv", ["player", "battles", "armies"], players)
    write_csv(out / "corps_popularity.csv", ["army_key", "corps_name", "appearances", "distinct_players"], popularity)
    write_csv(out / "excluded_battles.csv", ["battle_id", "reason", "detail"], excluded)
    write_csv(out / "excluded_armies.csv", ["battle_id", "army_index", "army_key", "player",
                                            "reason", "detail"], excluded_armies)
    return {"files": files, "battles": battles, "armies": armies, "excluded": excluded,
            "excluded_armies": excluded_armies}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--replays", required=True, action="append", metavar="DIR",
                    help="folder of .replay files (non-recursive); repeat to combine seasons")
    ap.add_argument("--out", default=str(OUT_DEFAULT))
    args = ap.parse_args()

    rosters = Rosters.from_cards(load_unit_cards(UNITS_CSV))
    res = analyze([Path(r) for r in args.replays], Path(args.out), rosters)

    reasons = Counter(e["reason"] for e in res["excluded"])
    army_reasons = Counter(e["reason"] for e in res["excluded_armies"])
    in_scope = sum(1 for a in res["armies"] if a["army_key"].startswith("ntw3_ac_"))
    print(f"replays        {len(res['files'])}")
    print(f"accepted       {len(res['battles'])} battles, {len(res['armies'])} armies ({in_scope} ntw3_ac_)")
    print(f"dropped battles {len(res['excluded'])}  " + ", ".join(f"{r}={reasons.get(r, 0)}" for r in BATTLE_REASONS))
    for e in res["excluded"]:
        print(f"  {e['reason']:<15} {e['battle_id']}  {e['detail']}")
    print(f"dropped armies  {len(res['excluded_armies'])}  " + ", ".join(f"{r}={army_reasons.get(r, 0)}" for r in ARMY_REASONS))
    for e in res["excluded_armies"]:
        print(f"  {e['reason']:<15} {e['battle_id']}#{e['army_index']}  {e['army_key']}  {e['detail']}")
    dates = filename_dates([f.name for f in res["files"]])
    if dates:
        print(f"filename dates {len(dates)} found; min {min(dates, key=_date_sort)}, max {max(dates, key=_date_sort)}")
        print("  " + ", ".join(sorted(set(dates), key=_date_sort)))
    print(f"wrote          {args.out}")


def _date_sort(s: str) -> tuple:
    """Best-effort chronological key for the mixed filename date styles.

    ISO is y-m-d; the others are day-first unless the first number cannot be a day-of-
    month-sized month (>12 is impossible as a month, so it must be the day) or the
    second cannot be a month, in which case the order is month-first. 2-digit years are 20xx.
    """
    nums = [int(x) for x in re.split(r"[-.]", s)]
    if len(s.split("-")[0]) == 4:
        return tuple(nums)
    a, b, y = nums
    d, m = (b, a) if b > 12 else (a, b)
    return (y + 2000 if y < 100 else y, m, d)


if __name__ == "__main__":
    main()
