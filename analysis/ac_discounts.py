"""Formation rebates of Army Corps (AC) armies: per-card and per-corps effective prices.

Why this exists
---------------
An AC army's price is not the sum of its cards' list prices. The game's frontend Lua
(`source/original lua files/ntw3.lua`, `NTW3.ArmyPrice` -> `NTW3.AC_DivisionBrigade_Bonus`)
subtracts a rebate for every brigade or division whose whole roster is selected:
``floor(Cost / 100 * (NbUnits - 1))``, with Cost = sum of cap x MPCost and NbUnits =
sum of cap over the group's *full roster* (generals excluded). Completing a group of
total cap n therefore takes (n - 1)% off that group's roster cost. A unit's list price
overstates what it costs in a build that completes its group, so the AC pricing study
(analysis/AC_STUDY_PLAN.md, steps 1 and 5) needs the effective price beside the list
price. The rule itself is written up in analysis/AC_DISCOUNT_RULES.md.

App rules, not a re-implementation
----------------------------------
Every rebate here comes from the app's own Python port of the rules,
`tools/army_builder_rules.py` (build_roster_totals, group_discount, support_divisions,
calculate_army_cost, check_known_limits), so the numbers are the ones the app shows.
The app adds rules the Lua does not have: support divisions earn nothing, and Davout's
1812 corps keeps brigade rebates for the non-artillery brigades of its support
division. The recruit-order affordability rule (web/src/state/build.ts affordableSubset)
is ported below only to decide whether a group can be completed at all.

The Lua's own view
------------------
The Lua reads the division and brigade from the ``ACDV<d>B<b>`` tag in each card's
localised description (`NTW3.AC_DivisionBrigade_Locate`). The builder fills gaps the
tags leave (inferred support divisions, commander variants inheriting their base
unit's placement, verified overrides), and the app then uses those placements. This
script re-reads the tags straight from `source/tables/` (land units + localisation),
parses them the way the Lua does, rebuilds the Lua's roster totals, and flags every
card whose rebate differs between the Lua and the app (``lua_differs``). These are
for in-game verification; the app is not changed.

Outputs (analysis/output/ac/)
-----------------------------
  ac_discounts.csv        one row per AC card: regular units, combat-general
                          (commander) variants and staff generals, all 238 corps.
                          Commanders carry their own placement's group values: they
                          count toward completion but are not in the roster totals.
                          Staff generals carry no group.
  ac_corps_discounts.csv  one row per AC corps: discount potential.

``has_tow_copy``: some Theatre-of-War unit key, with its ``_tow_<n>`` component
removed, equals this AC key (ToW commander keys put ``_tow_<n>`` before ``_com_<m>``).

Self-checks (check(), which raises ValueError; a summary is printed): row counts; Lua tags parse and match the
builder's ``localisation_tag`` placements; independent group totals equal
build_roster_totals; every eligible group, selected in full (every roster copy), makes
calculate_army_cost return exactly the stated rebate, and one copy short does not
complete it; a commander can stand in for a copy (>= 200 sampled groups); full-corps
selections; the verified 5 645-gold test build; the Lua's float floor equals the
integer floor on every Lua group; the affordability replay agrees with the analytic
reachability test.

Run from the repo root (numpy not needed):

    py -3.13 analysis/ac_discounts.py
"""

from __future__ import annotations

import csv
import itertools
import math
import random
import re
import statistics
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

ROOT = common.ROOT
sys.path.insert(0, str(ROOT))
from tools import army_builder_rules as abr  # noqa: E402

UNITS_CSV = common.BUILDER_CSV
CATALOG_CSV = common.CATALOG_CSV
LAND_UNITS_TSV = common.SOURCE_TABLES / "ntw3_land_units.tsv"
LOCALISATION_TSV = common.SOURCE_TABLES / "localisation.loc.tsv"
OUT = common.AC_OUT

# web/src/rules/rules.ts MAX_BUILD_COST (the Python port has no such constant).
MAX_BUILD_COST = common.BUDGET


def check(condition: object, detail: object = None) -> None:
    """A self-check on the data or the rules port. Unlike assert it also runs under `python -O`; a
    failure raises ValueError with the detail (the failing line is in the traceback)."""
    if not condition:
        raise ValueError("self-check failed" + ("" if detail is None else f": {detail}"))

# Expected sizes (analysis/AC_STUDY_PLAN.md, "Verification" 3).
EXPECTED_COUNTS = {"unit": 7205, "commander": 5628, "staff": 283}
EXPECTED_CORPS = 238

# The fully tagged support divisions the app denies a rebate the Lua grants
# (AC_STUDY_PLAN.md "What we already know"); recomputed and compared below.
EXPECTED_TAGGED_SUPPORT = {
    ("ntw3_ac_a11_x5_117", 7),
    ("ntw3_ac_a11_x5_123", 4),
    ("ntw3_ac_a11_x7_126", 3),
    ("ntw3_ac_a11_x7_126", 7),
    ("ntw3_ac_b17_x7_281", 7),
}

SAMPLE_SEED = 20261010
COMMANDER_SAMPLE = 200


# --- Data ------------------------------------------------------------------------


@dataclass(frozen=True)
class Card:
    """One AC card: the rules engine's UnitCard plus the columns it does not keep."""

    rule: abr.UnitCard
    army_corps_name: str
    is_commander_variant: bool

    @property
    def kind(self) -> str:
        if not self.rule.is_general:
            return "unit"
        return "staff" if abr.classify_general(self.rule) == "staff" else "commander"


@dataclass(frozen=True)
class Group:
    """A brigade or division as the app sees it (app placements)."""

    division: int
    brigade: int | None  # None for a division
    cap_total: int  # n: the copies needed to complete it
    roster_cost: int  # sum of cap x list price over the full roster
    eligible: bool  # the app credits a rebate when it is complete
    rebate: int  # app rebate in gold (0 when not eligible)
    caps_ok: bool  # the full roster passes the app's card limits
    reachable: bool  # caps_ok and affordable under the recruit-order rule
    unreachable_reason: str

    @property
    def rebate_pct(self) -> float:
        return 100.0 * self.rebate / self.roster_cost if self.roster_cost else 0.0


def read_tsv(path: Path) -> list[dict[str, str]]:
    """The game-table exports: a header row, then a ``#table;version`` row."""
    csv.field_size_limit(1 << 30)
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle, delimiter="\t", quoting=csv.QUOTE_NONE)
        header = next(reader)
        next(reader)
        return [dict(zip(header, row)) for row in reader]


def load_cards() -> list[Card]:
    """Every AC row of the app's unit CSV, through abr.load_unit_cards (which also
    resolves cap groups, so commanders know their base unit's class)."""
    rule_cards = abr.load_unit_cards(UNITS_CSV)
    with UNITS_CSV.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    check(len(rows) == len(rule_cards))
    cards: list[Card] = []
    for row, rule in zip(rows, rule_cards):
        check((row["unit_key"], row["faction_key"]) == (rule.unit_key, rule.faction_key))
        if "_ac_" not in rule.faction_key:
            continue
        cards.append(
            Card(
                rule=rule,
                army_corps_name=row["army_corps_name"],
                is_commander_variant=row["is_commander_variant"] == "true",
            )
        )
    return cards


def tow_copied_keys() -> set[str]:
    """AC unit keys that have a Theatre-of-War copy (ToW key minus ``_tow_<n>``)."""
    with UNITS_CSV.open(encoding="utf-8-sig", newline="") as handle:
        return {
            re.sub(r"_tow_\d+", "", row["unit_key"], count=1)
            for row in csv.DictReader(handle)
            if row["faction_key"].startswith("ntw3_tow_")
        }


def lua_locate(description: str) -> tuple[int, int] | None:
    """`NTW3.AC_DivisionBrigade_Locate` (ntw3.lua 441-450): find "ACDV", take the rest
    of the description, explode on "B" (gmatch "[^B]+", empty pieces dropped) and
    tonumber the first two pieces. Returns (0, 0) when there is no tag, None when
    the Lua's tonumber would fail (it never does in the shipped data)."""
    position = description.find("ACDV")
    if position < 0:
        return 0, 0
    pieces = re.findall(r"[^B]+", description[position + 4:])
    try:
        return int(pieces[0].strip()), int(pieces[1].strip())
    except (IndexError, ValueError):
        return None


def lua_tags(unit_keys: Iterable[str]) -> dict[str, tuple[int, int]]:
    """The ACDV tag the Lua sees for each unit, from the game's own tables. The
    description lookup mirrors localisation_value in
    tools/build_ntw3_army_builder_database.py (last duplicate key wins, as there)."""
    land_units = {row["key"]: row for row in read_tsv(LAND_UNITS_TSV)}
    localisation = {row["key"]: row["text"] for row in read_tsv(LOCALISATION_TSV)}
    tags: dict[str, tuple[int, int]] = {}
    for unit_key in unit_keys:
        unit = land_units[unit_key]
        raw = unit.get("unit_description_text", "").strip()
        candidates: list[str] = []
        if raw and raw != "-":
            candidates += [raw, f"unit_description_texts_description_text_{raw}"]
        candidates.append(f"unit_description_texts_description_text_{unit_key}")
        description = ""
        for candidate in dict.fromkeys(candidates):
            text = localisation.get(candidate, "")
            if text.strip():
                description = text
                break
        tag = lua_locate(description)
        check(tag is not None, f"{unit_key}: the Lua could not parse its ACDV tag")
        regex = re.search(r"ACDV(\d+)B(\d+)", description)
        check(tag == ((int(regex.group(1)), int(regex.group(2))) if regex else (0, 0)))
        tags[unit_key] = tag
    return tags


# --- Rules helpers ----------------------------------------------------------------


def copies(cards: Iterable[abr.UnitCard]) -> list[abr.UnitCard]:
    """Every roster copy: each card repeated cap times."""
    return [card for card in cards for _ in range(card.cap)]


def lua_price_cut(cost: int, n_units: int) -> int:
    """`NTW3.AC_DivisionBrigade_PriceCut` (ntw3.lua 476-478) in IEEE doubles, as Lua 5.1."""
    return math.floor(cost / 100 * (n_units - 1))


def affordable_prefix(
    order: Sequence[abr.UnitCard], corps: Sequence[abr.UnitCard], faction: str
) -> list[abr.UnitCard]:
    """Port of affordableSubset (web/src/state/build.ts 327-335): a card is affordable
    when the discounted total so far plus its list price stays within 10 000."""
    affordable: list[abr.UnitCard] = []
    for card in order:
        current = abr.calculate_army_cost(affordable, corps, faction).final_cost
        if current + card.mp_cost > MAX_BUILD_COST:
            break
        affordable.append(card)
    return affordable


def best_brigade_order(
    brigades: Sequence[tuple[int, int]],
) -> tuple[tuple[int, ...], int] | None:
    """For a division whose brigades (list cost, app rebate) are taken one brigade at a
    time, the brigade order minimising the peak running total. The peak occurs when a
    brigade's last card is checked: list so far minus rebates of the brigades already
    complete (that brigade's own rebate is credited only after the check). Returns
    (order, peak), or None for an empty division. Under 10 000 at list price every
    order fits (rebates only lower the running total), so only the natural order
    is scored there."""
    natural = [tuple(range(len(brigades)))]
    fits_anyway = sum(cost for cost, _ in brigades) <= MAX_BUILD_COST
    orders = natural if fits_anyway else itertools.permutations(range(len(brigades)))
    best: tuple[tuple[int, ...], int] | None = None
    for order in orders:
        spent = credited = peak = 0
        for index in order:
            cost, rebate = brigades[index]
            spent += cost
            peak = max(peak, spent - credited)
            credited += rebate
        if best is None or peak < best[1]:
            best = (order, peak)
    return best


# --- Per-corps computation ----------------------------------------------------------


@dataclass
class CorpsResult:
    faction: str
    corps: tuple[abr.UnitCard, ...]
    support: set[int]
    divisions: dict[int, Group]
    brigades: dict[tuple[int, int], Group]
    brigade_orders: dict[int, tuple[tuple[int, int], ...]]
    lua_divisions: dict[int, tuple[int, int]]  # division -> (cost, n)
    lua_brigades: dict[tuple[int, int], tuple[int, int]]


def caps_check(
    selection: list[abr.UnitCard], corps: Sequence[abr.UnitCard], faction: str
) -> tuple[bool, str]:
    limits = abr.check_known_limits(selection, faction, recruitable_cards=corps)
    reasons = sorted({v.rule.split(":")[0] for v in limits.violations})
    return limits.valid, "+".join(reasons)


def analyse_corps(
    faction: str, corps: tuple[abr.UnitCard, ...], tags: dict[str, tuple[int, int]]
) -> CorpsResult:
    support = abr.support_divisions(corps, faction)
    app_divisions, app_brigades = abr.build_roster_totals(corps, faction)

    # Independent totals over every placed regular card (app placements), so that
    # ineligible (support) groups still show their size and cost.
    raw_div: dict[int, list[abr.UnitCard]] = defaultdict(list)
    raw_brig: dict[tuple[int, int], list[abr.UnitCard]] = defaultdict(list)
    for card in corps:
        if card.is_general or card.placement is None:
            continue
        d, b = card.placement.division_id, card.placement.brigade_id
        raw_div[d].append(card)
        raw_brig[(d, b)].append(card)

    def roster_of(members: list[abr.UnitCard], key: tuple[int, int] | int) -> list[abr.UnitCard]:
        # Davout's orphan brigades count only their non-artillery cards; for every
        # other eligible group the app totals equal the raw totals (asserted below).
        if isinstance(key, tuple) and key in app_brigades and key[0] in support:
            return [c for c in members if not abr._is_artillery(c)]
        return members

    brigades: dict[tuple[int, int], Group] = {}
    for key, members in sorted(raw_brig.items()):
        eligible = key in app_brigades
        roster = roster_of(members, key)
        cost = sum(c.cap * c.mp_cost for c in roster)
        n = sum(c.cap for c in roster)
        if eligible:
            total = app_brigades[key]
            check((total.roster_cost, total.required_count) == (cost, n), (faction, key))
        rebate = abr.group_discount(abr.GroupTotal(cost, n)) if eligible else 0
        caps_ok, reason = caps_check(copies(roster), corps, faction)
        affordable = cost <= MAX_BUILD_COST
        if not affordable:
            reason = "+".join(filter(None, [reason, "cost"]))
        brigades[key] = Group(key[0], key[1], n, cost, eligible, rebate, caps_ok,
                              caps_ok and affordable, reason)
    check(set(app_brigades) <= set(brigades))

    divisions: dict[int, Group] = {}
    brigade_orders: dict[int, tuple[tuple[int, int], ...]] = {}
    for d, members in sorted(raw_div.items()):
        eligible = d in app_divisions
        cost = sum(c.cap * c.mp_cost for c in members)
        n = sum(c.cap for c in members)
        if eligible:
            total = app_divisions[d]
            check((total.roster_cost, total.required_count) == (cost, n), (faction, d))
        rebate = abr.group_discount(abr.GroupTotal(cost, n)) if eligible else 0
        caps_ok, reason = caps_check(copies(members), corps, faction)
        keys = [k for k in sorted(brigades) if k[0] == d]
        found = best_brigade_order(
            [(brigades[k].roster_cost, brigades[k].rebate) for k in keys]
        )
        check(found is not None)
        order, peak = found
        brigade_orders[d] = tuple(keys[i] for i in order)
        affordable = peak <= MAX_BUILD_COST
        if not affordable:
            reason = "+".join(filter(None, [reason, "cost"]))
        divisions[d] = Group(d, None, n, cost, eligible, rebate, caps_ok,
                             caps_ok and affordable, reason)
    check(set(app_divisions) <= set(divisions))

    # The Lua's roster (ntw3.lua 480-505): non-general cards, own ACDV tag, d>0, b>0.
    lua_div: dict[int, list[int]] = defaultdict(lambda: [0, 0])
    lua_brig: dict[tuple[int, int], list[int]] = defaultdict(lambda: [0, 0])
    for card in corps:
        if card.is_general:
            continue
        d, b = tags[card.unit_key]
        if d > 0 and b > 0:
            for total in (lua_div[d], lua_brig[(d, b)]):
                total[0] += card.cap * card.mp_cost
                total[1] += card.cap
    return CorpsResult(
        faction, corps, support, divisions, brigades, brigade_orders,
        {d: (c, n) for d, (c, n) in lua_div.items()},
        {k: (c, n) for k, (c, n) in lua_brig.items()},
    )


# --- Output rows --------------------------------------------------------------------


def fmt_bool(value: bool) -> str:
    return "true" if value else "false"


def fmt_num(value: float | None, digits: int) -> str:
    return "" if value is None else f"{value:.{digits}f}"


CARD_COLUMNS = [
    "faction_key", "army_corps_name", "corps_number", "unit_key", "kind", "unit_class",
    "list_price", "unit_cap", "division", "brigade", "support_division",
    "brigade_cap_total", "brigade_roster_cost", "brigade_rebate", "brigade_rebate_pct",
    "brigade_effective_price",
    "division_cap_total", "division_roster_cost", "division_rebate", "division_rebate_pct",
    "division_effective_price",
    "lua_differs", "has_tow_copy",
    # Extras: provenance, eligibility, reachability and the Lua's own values.
    "base_unit_key", "underlying_unit_class", "placement_source",
    "brigade_eligible", "brigade_reachable", "division_eligible", "division_reachable",
    "lua_division", "lua_brigade", "lua_brigade_rebate", "lua_division_rebate", "lua_note",
]

CORPS_COLUMNS = [
    "faction_key", "name", "corps_number", "side", "has_tow_copy",
    "n_regular_cards", "n_commander_cards", "n_divisions", "n_brigades",
    "n_ineligible_divisions", "n_ineligible_brigades",
    "total_roster_cost", "eligible_roster_cost",
    "full_corps_rebate", "full_corps_rebate_pct", "full_corps_rebate_pct_of_total",
    "best_division_rebate_pct", "best_reachable_division_rebate_pct", "mean_brigade_rebate_pct",
    "n_reachable_eligible_divisions", "n_eligible_divisions", "n_lua_differs_cards",
]


def group_fields(group: Group | None, list_price: int, prefix: str) -> dict[str, str]:
    if group is None:
        return {f"{prefix}_{k}": "" for k in
                ("cap_total", "roster_cost", "rebate", "rebate_pct", "effective_price",
                 "eligible", "reachable")}
    effective = (
        list_price * (1 - group.rebate / group.roster_cost) if group.eligible else None
    )
    return {
        f"{prefix}_cap_total": str(group.cap_total),
        f"{prefix}_roster_cost": str(group.roster_cost),
        f"{prefix}_rebate": str(group.rebate),
        f"{prefix}_rebate_pct": fmt_num(group.rebate_pct, 4),
        f"{prefix}_effective_price": fmt_num(effective, 2),
        f"{prefix}_eligible": fmt_bool(group.eligible),
        f"{prefix}_reachable": fmt_bool(group.reachable),
    }


def card_row(
    card: Card, result: CorpsResult, tag: tuple[int, int], corps_number: int,
    has_copy: bool,
) -> dict[str, str]:
    rule = card.rule
    placement = rule.placement
    brigade = division = None
    if placement is not None:
        brigade = result.brigades.get((placement.division_id, placement.brigade_id))
        division = result.divisions.get(placement.division_id)
        check(brigade is not None and division is not None, (rule.faction_key, rule.unit_key))

    # The Lua's rebates for this card: its own tag, the Lua roster, the float floor.
    lua_d, lua_b = tag
    lua_brigade_rebate = lua_division_rebate = 0
    if lua_d > 0 and lua_b > 0:
        check(lua_d in result.lua_divisions and (lua_d, lua_b) in result.lua_brigades,
              f"{rule.unit_key}: the Lua would index a missing roster group")
        lua_brigade_rebate = lua_price_cut(*result.lua_brigades[(lua_d, lua_b)])
        lua_division_rebate = lua_price_cut(*result.lua_divisions[lua_d])
    app_brigade_rebate = brigade.rebate if brigade else 0
    app_division_rebate = division.rebate if division else 0
    differs = (app_brigade_rebate, app_division_rebate) != (
        lua_brigade_rebate, lua_division_rebate
    )
    note = ""
    if differs:
        if card.kind == "commander" and (lua_d, lua_b) == (0, 0) and placement is not None:
            note = "commander_untagged_in_game"
        elif placement is not None and placement.division_id in result.support and lua_d > 0:
            note = "tagged_support_division"
        else:
            raise ValueError(f"unexplained Lua/app difference: {rule.unit_key}")

    row = {
        "faction_key": rule.faction_key,
        "army_corps_name": card.army_corps_name,
        "corps_number": str(corps_number),
        "unit_key": rule.unit_key,
        "kind": card.kind,
        "unit_class": rule.unit_class,
        "list_price": str(rule.mp_cost),
        "unit_cap": str(rule.cap),
        "division": str(placement.division_id) if placement else "",
        "brigade": str(placement.brigade_id) if placement else "",
        "support_division": fmt_bool(
            placement is not None and placement.division_id in result.support
        ),
        "lua_differs": fmt_bool(differs),
        "has_tow_copy": fmt_bool(has_copy),
        "base_unit_key": rule.cap_group_key,
        "underlying_unit_class": rule.underlying_unit_class or "",
        "placement_source": rule.placement_source,
        "lua_division": str(lua_d) if lua_d else "",
        "lua_brigade": str(lua_b) if lua_b else "",
        "lua_brigade_rebate": str(lua_brigade_rebate),
        "lua_division_rebate": str(lua_division_rebate),
        "lua_note": note,
    }
    row.update(group_fields(brigade, rule.mp_cost, "brigade"))
    row.update(group_fields(division, rule.mp_cost, "division"))
    return row


def write_csv(path: Path, columns: list[str], rows: list[dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        for row in rows:
            writer.writerow({column: row[column] for column in columns})


# --- Self-checks --------------------------------------------------------------------


def check_group_selections(results: dict[str, CorpsResult]) -> int:
    """Every eligible group, selected in full, earns exactly its stated rebate; one
    copy short, it is not completed. Returns the number of groups checked."""
    checked = 0
    for faction, result in results.items():
        corps = result.corps
        members_of_brigade: dict[tuple[int, int], list[abr.UnitCard]] = defaultdict(list)
        for card in corps:
            if not card.is_general and card.placement is not None:
                members_of_brigade[
                    (card.placement.division_id, card.placement.brigade_id)
                ].append(card)
        for key, group in result.brigades.items():
            if not group.eligible:
                continue
            members = members_of_brigade[key]
            if key[0] in result.support:  # Davout's orphan brigades
                members = [c for c in members if not abr._is_artillery(c)]
            selection = copies(members)
            price = abr.calculate_army_cost(selection, corps, faction)
            check(price.normal_discount == group.rebate, (faction, key))
            check(price.base_cost == group.roster_cost)
            check(len(price.completed_groups) == 1)
            short = abr.calculate_army_cost(selection[:-1], corps, faction)
            check(short.normal_discount == 0, (faction, key))
            checked += 1
        for d, group in result.divisions.items():
            if not group.eligible:
                continue
            selection = copies(
                c for k in sorted(members_of_brigade) if k[0] == d
                for c in members_of_brigade[k]
            )
            price = abr.calculate_army_cost(selection, corps, faction)
            check(price.normal_discount == group.rebate, (faction, d))
            check([(g.group_type, g.division_id) for g in price.completed_groups] == [
                ("division", d)
            ])
            short = abr.calculate_army_cost(selection[:-1], corps, faction)
            check(all(g.group_type == "brigade" for g in short.completed_groups))
            checked += 1
    return checked


def check_commander_substitution(results: dict[str, CorpsResult]) -> int:
    """A combat-general variant can replace one copy of its base unit and still
    complete the group (it counts toward completion, not toward the roster)."""
    candidates: list[tuple[str, tuple[int, int], abr.UnitCard]] = []
    for faction, result in results.items():
        for card in result.corps:
            if card.is_general and card.placement is not None and card.unit_key != card.cap_group_key:
                key = (card.placement.division_id, card.placement.brigade_id)
                group = result.brigades.get(key)
                if group is not None and group.eligible and key[0] not in result.support:
                    candidates.append((faction, key, card))
    rng = random.Random(SAMPLE_SEED)
    # One commander per group, then a seeded sample of at least COMMANDER_SAMPLE groups.
    by_group: dict[tuple[str, tuple[int, int]], abr.UnitCard] = {}
    for faction, key, card in candidates:
        by_group.setdefault((faction, key), card)
    sample = rng.sample(sorted(by_group), min(len(by_group), max(COMMANDER_SAMPLE, 250)))
    checked = 0
    for faction, key in sample:
        result = results[faction]
        commander = by_group[(faction, key)]
        members = [
            c for c in result.corps
            if not c.is_general and c.placement is not None
            and (c.placement.division_id, c.placement.brigade_id) == key
        ]
        selection = copies(members)
        index = next(
            (i for i, c in enumerate(selection) if c.unit_key == commander.cap_group_key), None
        )
        if index is None:  # the commander's base unit sits in another brigade
            continue
        selection[index] = commander
        price = abr.calculate_army_cost(selection, result.corps, faction)
        check(price.normal_discount == result.brigades[key].rebate, (faction, key))
        checked += 1
    check(checked >= COMMANDER_SAMPLE, checked)
    return checked


def check_reachability(results: dict[str, CorpsResult]) -> tuple[int, int]:
    """For eligible divisions whose list cost exceeds 10 000 but which the analytic
    test calls affordable, replay the recruit-order rule on the best brigade order
    and confirm every card is affordable and the division completes. Also replay
    every affordable eligible brigade and division up to the 10 000 line."""
    replayed = over_line = 0
    for faction, result in results.items():
        for d, group in result.divisions.items():
            if not (group.eligible and group.caps_ok):
                continue
            order: list[abr.UnitCard] = []
            for key in result.brigade_orders[d]:
                order += copies(
                    c for c in result.corps
                    if not c.is_general and c.placement is not None
                    and (c.placement.division_id, c.placement.brigade_id) == key
                )
            affordable = affordable_prefix(order, result.corps, faction)
            fits = len(affordable) == len(order)
            check(fits == group.reachable, (faction, d, group))
            if fits:
                final = abr.calculate_army_cost(order, result.corps, faction)
                check(final.normal_discount == group.rebate)
            replayed += 1
            over_line += group.roster_cost > MAX_BUILD_COST
    return replayed, over_line


def check_5645_example() -> tuple[int, int]:
    """tools/tests/test_army_builder_rules.py test_verified_5645_example, verbatim,
    and its real-data analogue (7. Garde impériale, division 4 brigade 2)."""
    faction = "ntw3_ac_test_x5_001"

    def card(key: str, *, cost: int, cap: int = 1, brigade: int = 1,
             general: bool = False) -> abr.UnitCard:
        return abr.UnitCard(
            unit_key=key, faction_key=faction,
            unit_class="general" if general else "infantry_line",
            men_raw=80 if general else 100, placement=abr.Placement(1, brigade),
            mp_cost=cost, cap=cap, is_general=general,
        )

    roster = [
        card("roster_a", cost=1003, cap=2),
        card("roster_b", cost=807, cap=2),
        card("roster_c", cost=384, cap=4),
        card("other_brigade", cost=100, brigade=2),
    ]
    selected = [card(f"selected_{i}", cost=c)
                for i, c in enumerate([1003, 1003, 807, 807, 384, 384, 772])]
    selected.append(card("tagged_general", cost=845, general=True))
    result = abr.calculate_army_cost(selected, roster, faction)
    check((result.base_cost, result.normal_discount, result.final_cost) == (6005, 360, 5645))
    group = result.completed_groups[0]
    check((group.group_type, group.roster_cost, group.required_count) == ("brigade", 5156, 8))
    return result.final_cost, group.discount


def check_real_example(results: dict[str, CorpsResult]) -> tuple[int, int, int]:
    """The same brigade in the data: 7. Garde impériale (ntw3_ac_a11_x5_130) ACDV4B2,
    Fusiliers-grenadiers 1003 x2, Fusiliers-chasseurs 807 x2, Flanqueurs-chasseurs
    384 x4. A legal build: one Fusiliers-grenadiers copy replaced by the Pierre
    Bodelin commander variant (845, also ACDV4B2)."""
    faction = "ntw3_ac_a11_x5_130"
    result = results[faction]
    group = result.brigades[(4, 2)]
    check((group.roster_cost, group.cap_total, group.rebate) == (5156, 8, 360))
    by_key = {c.unit_key: c for c in result.corps}
    selection = [
        by_key["ntw3_inf_grena_130_999_0565"],
        by_key["ntw3_inf_grena_130_999_0565_com_0301"],
        *[by_key["ntw3_inf_light_130_999_1320"]] * 2,
        *[by_key["ntw3_inf_skirm_130_999_4805"]] * 4,
    ]
    check(abr.check_known_limits(selection, faction, recruitable_cards=result.corps).valid)
    price = abr.calculate_army_cost(selection, result.corps, faction)
    check((price.base_cost, price.normal_discount, price.final_cost) == (4998, 360, 4638))
    return price.base_cost, price.normal_discount, price.final_cost


# --- Summary statistics -------------------------------------------------------------


def describe(values: Sequence[float]) -> str:
    if not values:
        return "n=0"
    ordered = sorted(values)
    q = statistics.quantiles(ordered, n=4) if len(ordered) > 1 else [ordered[0]] * 3
    return (f"n={len(ordered)}  min {ordered[0]:.2f}  q1 {q[0]:.2f}  median {q[1]:.2f}  "
            f"q3 {q[2]:.2f}  max {ordered[-1]:.2f}  mean {statistics.fmean(ordered):.2f}")


def main() -> None:
    cards = load_cards()
    kinds = Counter(card.kind for card in cards)
    factions = sorted({card.rule.faction_key for card in cards})
    print(f"AC cards: {dict(kinds)}  corps: {len(factions)}")
    check(dict(kinds) == EXPECTED_COUNTS, kinds)
    check(len(factions) == EXPECTED_CORPS)
    check(all((c.kind == "commander") == c.is_commander_variant for c in cards))
    check(not any(abr.is_german_states(f) for f in factions))

    with CATALOG_CSV.open(encoding="utf-8-sig", newline="") as handle:
        catalog = {row["faction_key"]: row for row in csv.DictReader(handle)}
    copied = tow_copied_keys()

    # Lua tags straight from the game tables, checked against the builder's
    # localisation_tag placements.
    tags = lua_tags(card.rule.unit_key for card in cards)
    for card in cards:
        rule = card.rule
        tag = tags[rule.unit_key]
        if rule.placement_source == "localisation_tag":
            check(rule.placement is not None)
            check(tag == (rule.placement.division_id, rule.placement.brigade_id))
        elif rule.placement_source == "reserve_support_division":
            check(tag[0] == 0)  # ACDV0B* or untagged: the Lua ignores both
        else:
            check(tag == (0, 0), (rule.unit_key, rule.placement_source))
    print("Lua tags: parsed for every card; equal to the builder's localisation_tag placements")

    by_faction: dict[str, list[abr.UnitCard]] = defaultdict(list)
    for card in cards:
        by_faction[card.rule.faction_key].append(card.rule)
    results = {
        f: analyse_corps(f, tuple(by_faction[f]), tags) for f in factions
    }

    # Lua float floor against the app's integer floor, on every Lua group.
    lua_groups = [g for r in results.values()
                  for g in (*r.lua_divisions.values(), *r.lua_brigades.values())]
    float_mismatch = [g for g in lua_groups if lua_price_cut(*g) != g[0] * (g[1] - 1) // 100]
    check(not float_mismatch, float_mismatch)
    print(f"Lua float floor == integer floor on all {len(lua_groups)} Lua groups")

    # (n - 1)% consequence, up to the floor.
    for result in results.values():
        for group in (*result.brigades.values(), *result.divisions.values()):
            if group.eligible:
                check(group.cap_total - 1 - 100 / group.roster_cost < group.rebate_pct)
                check(group.rebate_pct <= group.cap_total - 1 + 1e-9)

    # --- per-card rows
    card_rows: list[dict[str, str]] = []
    for card in cards:
        rule = card.rule
        corps_number = int(catalog[rule.faction_key]["display_rating"])
        card_rows.append(card_row(
            card, results[rule.faction_key], tags[rule.unit_key], corps_number,
            rule.unit_key in copied,
        ))
    check(len(card_rows) == sum(EXPECTED_COUNTS.values()))

    # --- per-corps rows
    corps_rows: list[dict[str, str]] = []
    rows_by_faction: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in card_rows:
        rows_by_faction[row["faction_key"]].append(row)
    for faction in factions:
        result = results[faction]
        info = catalog[faction]
        eligible_div = [g for g in result.divisions.values() if g.eligible]
        orphan = [g for k, g in result.brigades.items()
                  if g.eligible and k[0] not in {x.division for x in eligible_div}]
        eligible_brig = [g for g in result.brigades.values() if g.eligible]
        total_cost = sum(c.cap * c.mp_cost for c in result.corps if not c.is_general)
        eligible_cost = sum(g.roster_cost for g in (*eligible_div, *orphan))
        full_rebate = sum(g.rebate for g in (*eligible_div, *orphan))
        # Full-corps selection: every roster copy of every placed regular card.
        everything = copies(c for c in result.corps
                            if not c.is_general and c.placement is not None)
        price = abr.calculate_army_cost(everything, result.corps, faction)
        check(price.normal_discount == full_rebate, faction)
        rows = rows_by_faction[faction]
        corps_rows.append({
            "faction_key": faction,
            "name": info["army_corps_name"],
            "corps_number": info["display_rating"],
            "side": info["side"],
            "has_tow_copy": fmt_bool(any(r["has_tow_copy"] == "true" for r in rows)),
            "n_regular_cards": str(sum(r["kind"] == "unit" for r in rows)),
            "n_commander_cards": str(sum(r["kind"] == "commander" for r in rows)),
            "n_divisions": str(len(result.divisions)),
            "n_brigades": str(len(result.brigades)),
            "n_ineligible_divisions": str(sum(not g.eligible for g in result.divisions.values())),
            "n_ineligible_brigades": str(sum(not g.eligible for g in result.brigades.values())),
            "total_roster_cost": str(total_cost),
            "eligible_roster_cost": str(eligible_cost),
            "full_corps_rebate": str(full_rebate),
            "full_corps_rebate_pct": fmt_num(
                100 * full_rebate / eligible_cost if eligible_cost else None, 4),
            "full_corps_rebate_pct_of_total": fmt_num(
                100 * full_rebate / total_cost if total_cost else None, 4),
            "best_division_rebate_pct": fmt_num(
                max((g.rebate_pct for g in eligible_div), default=None), 4),
            "best_reachable_division_rebate_pct": fmt_num(
                max((g.rebate_pct for g in eligible_div if g.reachable), default=None), 4),
            "mean_brigade_rebate_pct": fmt_num(
                statistics.fmean(g.rebate_pct for g in eligible_brig) if eligible_brig else None, 4),
            "n_reachable_eligible_divisions": str(sum(g.reachable for g in eligible_div)),
            "n_eligible_divisions": str(len(eligible_div)),
            "n_lua_differs_cards": str(sum(r["lua_differs"] == "true" for r in rows)),
        })

    write_csv(OUT / "ac_discounts.csv", CARD_COLUMNS, card_rows)
    write_csv(OUT / "ac_corps_discounts.csv", CORPS_COLUMNS, corps_rows)
    print(f"wrote {OUT / 'ac_discounts.csv'} ({len(card_rows)} rows)")
    print(f"wrote {OUT / 'ac_corps_discounts.csv'} ({len(corps_rows)} rows)")

    # --- self-checks on the rules engine
    groups_checked = check_group_selections(results)
    print(f"full-group selections: {groups_checked} eligible groups, rebate exact, "
          f"one copy short never completes")
    check(groups_checked >= 200)
    subs = check_commander_substitution(results)
    print(f"commander stand-in: {subs} sampled brigades still complete with the same rebate")
    replayed, over_line = check_reachability(results)
    print(f"affordability replay: {replayed} eligible divisions within the card limits "
          f"({over_line} above 10 000 at list price) agree with the analytic test")
    final, rebate = check_5645_example()
    print(f"5 645 test build: rebate {rebate}, final {final}")
    base, rebate, final = check_real_example(results)
    print(f"real-data analogue (7. Garde impériale d4 b2 with Bodelin): "
          f"base {base} - rebate {rebate} = {final}")
    print(f"full-corps selections: {len(factions)} corps, rebate == sum of group rebates")

    # --- ToW copies
    corps_with_units = [r for r in corps_rows if int(r["n_regular_cards"]) > 0]
    unit_rows = [r for r in card_rows if r["kind"] == "unit"]
    no_copy = [r for r in corps_with_units
               if not any(u["has_tow_copy"] == "true" for u in rows_by_faction[r["faction_key"]]
                          if u["kind"] == "unit")]
    whole = [r for r in corps_with_units
             if all(u["has_tow_copy"] == "true" for u in rows_by_faction[r["faction_key"]]
                    if u["kind"] == "unit")]
    no_copy_units = sum(int(r["n_regular_cards"]) for r in no_copy)
    print(f"ToW copies: {len(whole)} corps copied whole, {len(no_copy)} AC-only corps "
          f"({no_copy_units} regular units); {len(corps_rows) - len(corps_with_units)} corps "
          f"have no regular units at all")
    check(len(no_copy) == 17 and no_copy_units == 612)
    check(len(whole) + len(no_copy) == len(corps_with_units))
    check(sum(r["has_tow_copy"] == "true" for r in unit_rows) == 7205 - 612)

    # --- Lua / app disagreements, group level
    print("\nLua/app disagreements (groups):")
    tagged_support: set[tuple[str, int]] = set()
    for faction, result in results.items():
        for d, (cost, n) in sorted(result.lua_divisions.items()):
            app = result.divisions.get(d)
            app_rebate = app.rebate if app else 0
            if lua_price_cut(cost, n) != app_rebate:
                tagged_support.add((faction, d))
                brig = [(k[1], lua_price_cut(*v), result.brigades[k].rebate,
                         result.brigades[k].caps_ok)
                        for k, v in sorted(result.lua_brigades.items()) if k[0] == d]
                print(f"  {faction} {catalog[faction]['army_corps_name']}: division {d} "
                      f"n={n} cost={cost} Lua {lua_price_cut(cost, n)} app {app_rebate} "
                      f"caps_ok={app.caps_ok if app else None} "
                      f"({app.unreachable_reason if app else ''}); brigades "
                      f"(b, Lua, app, caps_ok): {brig}")
    check(tagged_support == EXPECTED_TAGGED_SUPPORT, tagged_support)
    notes = Counter(r["lua_note"] for r in card_rows if r["lua_differs"] == "true")
    print(f"  cards with lua_differs: {dict(notes)}")

    # --- distributions
    eligible_brigades = [g for r in results.values() for g in r.brigades.values() if g.eligible]
    eligible_divisions = [g for r in results.values() for g in r.divisions.values() if g.eligible]
    full_pct = [float(r["full_corps_rebate_pct"]) for r in corps_rows if r["full_corps_rebate_pct"]]
    full_pct_total = [float(r["full_corps_rebate_pct_of_total"])
                      for r in corps_rows if r["full_corps_rebate_pct_of_total"]]
    print("\nRebate distributions (% of the group's roster cost):")
    print(f"  brigades (eligible):   {describe([g.rebate_pct for g in eligible_brigades])}")
    print(f"  divisions (eligible):  {describe([g.rebate_pct for g in eligible_divisions])}")
    print(f"  full corps (eligible): {describe(full_pct)}")
    print(f"  full corps (of all regular roster cost): {describe(full_pct_total)}")
    print(f"  brigades (eligible, reachable):  "
          f"{describe([g.rebate_pct for g in eligible_brigades if g.reachable])}")
    print(f"  divisions (eligible, reachable): "
          f"{describe([g.rebate_pct for g in eligible_divisions if g.reachable])}")
    print(f"  brigade n:  {describe([g.cap_total for g in eligible_brigades])}")
    print(f"  division n: {describe([g.cap_total for g in eligible_divisions])}")
    print(f"  brigades with n = 1 (0% rebate): {sum(g.cap_total == 1 for g in eligible_brigades)}")
    print(f"  best division per corps: {describe([float(r['best_division_rebate_pct']) for r in corps_rows if r['best_division_rebate_pct']])}")
    print(f"  best reachable division per corps: {describe([float(r['best_reachable_division_rebate_pct']) for r in corps_rows if r['best_reachable_division_rebate_pct']])}")
    print(f"  mean brigade per corps:  {describe([float(r['mean_brigade_rebate_pct']) for r in corps_rows if r['mean_brigade_rebate_pct']])}")
    unit_brigade_pct = [float(r["brigade_rebate_pct"]) for r in unit_rows
                        if r["brigade_eligible"] == "true"]
    unit_division_pct = [float(r["division_rebate_pct"]) for r in unit_rows
                         if r["division_eligible"] == "true"]
    print(f"  per regular card, brigade: {describe(unit_brigade_pct)}")
    print(f"  per regular card, division: {describe(unit_division_pct)}")
    ineligible_units = Counter(
        "no placement" if not r["division"] else
        ("support division" if r["support_division"] == "true" else "eligible")
        for r in unit_rows
    )
    print(f"  regular cards by rebate status: {dict(ineligible_units)}")

    reach_div = Counter((g.reachable, g.unreachable_reason) for g in eligible_divisions)
    reach_brig = Counter((g.reachable, g.unreachable_reason) for g in eligible_brigades)
    print(f"\nReachability of eligible divisions: {dict(reach_div)}")
    print(f"Reachability of eligible brigades:  {dict(reach_brig)}")

    ranked = sorted((r for r in corps_rows if r["full_corps_rebate_pct"]),
                    key=lambda r: float(r["full_corps_rebate_pct"]))
    print("\nSmallest full-corps rebate %:")
    for r in ranked[:5]:
        print(f"  {r['full_corps_rebate_pct']:>8}  {r['faction_key']}  {r['name']}  "
              f"(rebate {r['full_corps_rebate']} of {r['eligible_roster_cost']})")
    print("Largest full-corps rebate %:")
    for r in ranked[-5:][::-1]:
        print(f"  {r['full_corps_rebate_pct']:>8}  {r['faction_key']}  {r['name']}  "
              f"(rebate {r['full_corps_rebate']} of {r['eligible_roster_cost']})")
    big = sorted(eligible_divisions, key=lambda g: g.rebate_pct)
    print(f"Largest division rebate: {big[-1]}")
    owners = {id(g): f for f, r in results.items() for g in r.divisions.values()}
    print(f"  in {owners[id(big[-1])]}")
    no_groups = [r["faction_key"] for r in corps_rows if not r["full_corps_rebate_pct"]]
    print(f"Corps with no eligible group: {len(no_groups)}: "
          f"{[catalog[f]['army_corps_name'] for f in no_groups]}")
    print("\nAll self-checks passed.")


if __name__ == "__main__":
    main()
