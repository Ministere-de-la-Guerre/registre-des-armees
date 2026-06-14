"""Source-backed NTW3 army-builder pricing and known roster limits."""

from __future__ import annotations

import csv
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping, Sequence


ACDV_RE = re.compile(r"^ACDV(?P<division>\d+)B(?P<brigade>\d+)$")
TRAILING_DIGITS_RE = re.compile(r"(?P<number>\d+)$")
COMMANDER_SUFFIX_RE = re.compile(r"_com_\d+$")

MAX_TOTAL_UNIT_CARDS = 31
MAX_FOOT_ARTILLERY = 2
MAX_HORSE_ARTILLERY = 1
MAX_HEAVY_CAVALRY = 10
MAX_BRIGADE_SLOTS_PER_DIVISION = 7


class RuleDataError(ValueError):
    """Raised when required source data cannot be parsed without guessing."""


@dataclass(frozen=True)
class Placement:
    division_id: int
    brigade_id: int


@dataclass(frozen=True)
class UnitCard:
    unit_key: str
    faction_key: str
    unit_class: str
    men_raw: int | None
    placement: Placement | None
    mp_cost: int
    cap: int
    is_general: bool
    men_display: int | None = None

    @classmethod
    def from_csv_row(cls, row: Mapping[str, str]) -> "UnitCard":
        unit_key = row.get("unit_key", "").strip()
        faction_key = row.get("faction_key", "").strip()
        if not unit_key or not faction_key:
            raise RuleDataError("Unit rows require unit_key and faction_key.")

        unit_class = row.get("unit_class", "").strip()
        is_general = _parse_bool(row.get("is_general", ""))
        if is_general != (unit_class.casefold() == "general"):
            raise RuleDataError(
                f"{unit_key}: is_general disagrees with unit_class={unit_class!r}."
            )

        return cls(
            unit_key=unit_key,
            faction_key=faction_key,
            unit_class=unit_class,
            men_raw=_optional_int(row.get("men_raw", ""), "men_raw", unit_key),
            placement=parse_placement(row.get("division_brigade_code", "")),
            mp_cost=_required_int(row.get("base_mp_cost", ""), "base_mp_cost", unit_key),
            cap=_required_int(row.get("unit_cap", ""), "unit_cap", unit_key),
            is_general=is_general,
            men_display=_optional_int(row.get("men_display", ""), "men_display", unit_key),
        )

    @property
    def final_men_count(self) -> int | None:
        if self.is_general and "_gen_staff_" in self.unit_key:
            return 16
        return self.men_display

    @property
    def cap_group_key(self) -> str:
        """Return the underlying unit key used for shared unit-cap accounting."""
        return COMMANDER_SUFFIX_RE.sub("", self.unit_key)


@dataclass(frozen=True)
class GroupTotal:
    roster_cost: int = 0
    required_count: int = 0

    def add(self, card: UnitCard) -> "GroupTotal":
        return GroupTotal(
            roster_cost=self.roster_cost + card.cap * card.mp_cost,
            required_count=self.required_count + card.cap,
        )


@dataclass(frozen=True)
class CompletedGroup:
    group_type: str
    division_id: int
    brigade_id: int | None
    roster_cost: int
    required_count: int
    selected_count: int
    discount: int


@dataclass(frozen=True)
class PriceResult:
    faction_key: str
    base_cost: int
    normal_discount: int
    applied_discount: int
    final_cost: int
    german_states: bool
    completed_groups: tuple[CompletedGroup, ...]


@dataclass(frozen=True)
class GeneralCaps:
    staff: int
    combat: int


@dataclass(frozen=True)
class LimitViolation:
    rule: str
    actual: int
    maximum: int


@dataclass(frozen=True)
class LimitCheck:
    counts: Mapping[str, int]
    violations: tuple[LimitViolation, ...]

    @property
    def valid(self) -> bool:
        return not self.violations


def _parse_bool(value: str) -> bool:
    normalized = value.strip().casefold()
    if normalized == "true":
        return True
    if normalized == "false":
        return False
    raise RuleDataError(f"Expected true/false, got {value!r}.")


def _required_int(value: str, field: str, unit_key: str) -> int:
    try:
        parsed = int(value.strip())
    except (AttributeError, ValueError) as exc:
        raise RuleDataError(f"{unit_key}: invalid {field} value {value!r}.") from exc
    if parsed < 0:
        raise RuleDataError(f"{unit_key}: {field} cannot be negative.")
    return parsed


def _optional_int(value: str, field: str, unit_key: str) -> int | None:
    if not value or not value.strip():
        return None
    return _required_int(value, field, unit_key)


def parse_placement(code: str) -> Placement | None:
    code = code.strip()
    if not code:
        return None
    match = ACDV_RE.fullmatch(code)
    if not match:
        raise RuleDataError(f"Invalid division placement code {code!r}.")
    return Placement(int(match.group("division")), int(match.group("brigade")))


def load_unit_cards(csv_path: str | Path) -> list[UnitCard]:
    with Path(csv_path).open(newline="", encoding="utf-8-sig") as handle:
        return [UnitCard.from_csv_row(row) for row in csv.DictReader(handle)]


def build_roster_totals(
    recruitable_cards: Iterable[UnitCard], faction_key: str
) -> tuple[dict[int, GroupTotal], dict[tuple[int, int], GroupTotal]]:
    divisions: dict[int, GroupTotal] = defaultdict(GroupTotal)
    brigades: dict[tuple[int, int], GroupTotal] = defaultdict(GroupTotal)

    for card in recruitable_cards:
        if card.faction_key != faction_key or card.is_general or card.placement is None:
            continue
        division = card.placement.division_id
        brigade = card.placement.brigade_id
        divisions[division] = divisions[division].add(card)
        brigades[(division, brigade)] = brigades[(division, brigade)].add(card)

    return dict(divisions), dict(brigades)


def group_discount(total: GroupTotal) -> int:
    if total.required_count <= 0:
        return 0
    return total.roster_cost * (total.required_count - 1) // 100


def is_german_states(faction_key: str) -> bool:
    parts = faction_key.split("_")
    return len(parts) >= 4 and "g" in parts[3]


def calculate_army_cost(
    selected_cards: Sequence[UnitCard],
    recruitable_cards: Iterable[UnitCard],
    faction_key: str,
) -> PriceResult:
    for card in selected_cards:
        if card.faction_key != faction_key:
            raise RuleDataError(
                f"Selected card {card.unit_key} belongs to {card.faction_key}, not {faction_key}."
            )

    base_cost = sum(card.mp_cost for card in selected_cards)
    if "_ac_" not in faction_key:
        return PriceResult(faction_key, base_cost, 0, 0, base_cost, False, ())

    divisions, brigades = build_roster_totals(recruitable_cards, faction_key)
    selected_divisions: Counter[int] = Counter()
    selected_brigades: Counter[tuple[int, int]] = Counter()
    for card in selected_cards:
        if card.placement is None:
            continue
        division = card.placement.division_id
        brigade = card.placement.brigade_id
        selected_divisions[division] += 1
        selected_brigades[(division, brigade)] += 1

    completed: list[CompletedGroup] = []
    for division_id in sorted(divisions):
        division_total = divisions[division_id]
        division_selected = selected_divisions[division_id]
        if division_selected >= division_total.required_count:
            discount = group_discount(division_total)
            completed.append(
                CompletedGroup(
                    "division", division_id, None, division_total.roster_cost,
                    division_total.required_count, division_selected, discount,
                )
            )
            continue

        for division_brigade in sorted(brigades):
            brigade_division, brigade_id = division_brigade
            if brigade_division != division_id:
                continue
            brigade_total = brigades[division_brigade]
            brigade_selected = selected_brigades[division_brigade]
            if brigade_selected >= brigade_total.required_count:
                discount = group_discount(brigade_total)
                completed.append(
                    CompletedGroup(
                        "brigade", division_id, brigade_id, brigade_total.roster_cost,
                        brigade_total.required_count, brigade_selected, discount,
                    )
                )

    normal_discount = sum(group.discount for group in completed)
    german_states = is_german_states(faction_key)
    applied_discount = normal_discount * 3 // 2 if german_states else normal_discount
    return PriceResult(
        faction_key=faction_key,
        base_cost=base_cost,
        normal_discount=normal_discount,
        applied_discount=applied_discount,
        final_cost=base_cost - applied_discount,
        german_states=german_states,
        completed_groups=tuple(completed),
    )


def classify_general(card: UnitCard) -> str | None:
    if not card.is_general:
        return None
    if card.men_raw is None:
        raise RuleDataError(f"{card.unit_key}: general classification requires raw Men.")
    return "staff" if card.men_raw in {32, 122} else "combat"


def general_caps(faction_key: str) -> GeneralCaps:
    if "_ac_" not in faction_key and "_tow_" not in faction_key:
        return GeneralCaps(staff=1, combat=1)

    parts = faction_key.split("_")
    if len(parts) < 4:
        raise RuleDataError(f"Faction key {faction_key!r} has no fourth component.")
    match = TRAILING_DIGITS_RE.search(parts[3])
    if not match:
        raise RuleDataError(
            f"Faction key {faction_key!r} fourth component has no trailing digits."
        )
    combat_cap = 9 - int(match.group("number"))
    if combat_cap < 0:
        raise RuleDataError(f"Faction key {faction_key!r} produces a negative combat cap.")
    return GeneralCaps(staff=1, combat=combat_cap)


def ac_selection_general_maxima(faction_key: str) -> GeneralCaps:
    """Return the separate automatic AC general-pool maxima from NTW3AC.ACgenerals."""
    if "_ac_" not in faction_key:
        raise RuleDataError("AC selection maxima apply only to faction keys containing '_ac_'.")
    caps = general_caps(faction_key)
    return GeneralCaps(staff=caps.staff, combat=caps.combat + 2)


def check_known_limits(
    selected_cards: Sequence[UnitCard],
    faction_key: str,
    *,
    ac_selection_behavior: bool = False,
    staff_slot_index: int | None = None,
) -> LimitCheck:
    counts = Counter(card.unit_class for card in selected_cards)
    counts["total_cards"] = len(selected_cards)
    counts["staff_generals"] = 0
    counts["combat_generals"] = 0
    counts["combat_generals_against_cap"] = 0
    counts["staff_slot_occupants"] = 0

    if staff_slot_index is not None:
        if not 0 <= staff_slot_index < len(selected_cards):
            raise RuleDataError("staff_slot_index is outside the selected-card list.")
        staff_slot_card = selected_cards[staff_slot_index]
        if staff_slot_card.faction_key != faction_key:
            raise RuleDataError("The staff-slot card must belong to the selected faction.")
        if not staff_slot_card.is_general:
            raise RuleDataError("Only a General-class card can occupy the staff slot.")

    for index, card in enumerate(selected_cards):
        classification = classify_general(card)
        if classification == "staff":
            counts["staff_generals"] += 1
            counts["staff_slot_occupants"] += 1
        elif classification == "combat":
            counts["combat_generals"] += 1
            if index == staff_slot_index:
                counts["staff_slot_occupants"] += 1
            else:
                counts["combat_generals_against_cap"] += 1

    caps = (
        ac_selection_general_maxima(faction_key)
        if ac_selection_behavior
        else general_caps(faction_key)
    )
    maxima = {
        "total_cards": MAX_TOTAL_UNIT_CARDS,
        "artillery_foot": MAX_FOOT_ARTILLERY,
        "artillery_horse": MAX_HORSE_ARTILLERY,
        "cavalry_heavy": MAX_HEAVY_CAVALRY,
        "staff_slot_occupants": caps.staff,
        "combat_generals_against_cap": caps.combat,
    }
    violations = [
        LimitViolation(rule, counts[rule], maximum)
        for rule, maximum in maxima.items()
        if counts[rule] > maximum
    ]

    cap_groups: dict[tuple[str, str], list[UnitCard]] = defaultdict(list)
    for card in selected_cards:
        cap_groups[(card.faction_key, card.cap_group_key)].append(card)
    for (card_faction, group_key), cards in sorted(cap_groups.items()):
        positive_caps = [card.cap for card in cards if card.cap > 0]
        if not positive_caps:
            continue
        maximum = min(positive_caps)
        count = len(cards)
        rule = f"unit_cap:{card_faction}:{group_key}"
        counts[rule] = count
        if count > maximum:
            violations.append(LimitViolation(rule, count, maximum))

    # A unit may be led by at most one combat general, even across different
    # commander variants of the same base unit (the shared cap group). The unit's
    # own cap may permit several copies, but only one of them can carry a general.
    combat_general_groups: dict[tuple[str, str], int] = defaultdict(int)
    for card in selected_cards:
        if classify_general(card) == "combat":
            combat_general_groups[(card.faction_key, card.cap_group_key)] += 1
    for (card_faction, group_key), count in sorted(combat_general_groups.items()):
        rule = f"combat_general_max:{card_faction}:{group_key}"
        counts[rule] = count
        if count > 1:
            violations.append(LimitViolation(rule, count, 1))

    return LimitCheck(dict(counts), tuple(violations))


class UnitCatalog:
    def __init__(self, cards: Iterable[UnitCard]):
        self.cards = tuple(cards)
        self._by_faction_and_key: dict[tuple[str, str], UnitCard] = {}
        self._by_faction: dict[str, list[UnitCard]] = defaultdict(list)
        for card in self.cards:
            identity = (card.faction_key, card.unit_key)
            if identity in self._by_faction_and_key:
                raise RuleDataError(f"Duplicate recruitable row for {identity!r}.")
            self._by_faction_and_key[identity] = card
            self._by_faction[card.faction_key].append(card)

    @classmethod
    def from_csv(cls, csv_path: str | Path) -> "UnitCatalog":
        return cls(load_unit_cards(csv_path))

    def resolve_selection(self, faction_key: str, unit_keys: Sequence[str]) -> list[UnitCard]:
        selected: list[UnitCard] = []
        for unit_key in unit_keys:
            try:
                selected.append(self._by_faction_and_key[(faction_key, unit_key)])
            except KeyError as exc:
                raise RuleDataError(
                    f"No recruitable row for {unit_key!r} in faction {faction_key!r}."
                ) from exc
        return selected

    def cards_for_faction(self, faction_key: str) -> tuple[UnitCard, ...]:
        """Return every recruitable card without random candidate filtering."""
        return tuple(self._by_faction.get(faction_key, ()))

    def calculate(self, faction_key: str, unit_keys: Sequence[str]) -> PriceResult:
        return calculate_army_cost(
            self.resolve_selection(faction_key, unit_keys), self.cards, faction_key
        )
