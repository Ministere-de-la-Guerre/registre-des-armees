"""Tests for the battle filtering in analyze_replays.py, on synthetic battles and a
hand-made card list (no .replay bytes involved)."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tools.analyze_replays import Rosters, analyze, army_unit_rows, evaluate
from tools.army_builder_rules import Placement, UnitCard
from tools.replay_parser import Army, Battle, Unit

FACTION = "ntw3_ac_test_x5_001"
OTHER = "ntw3_ac_test_x5_002"


def card(key: str, *, faction: str = FACTION, cls: str = "infantry_line", cost: int = 100,
         general: bool = False) -> UnitCard:
    return UnitCard(
        unit_key=key, faction_key=faction, unit_class=cls, men_raw=100,
        placement=Placement(1, 1), mp_cost=cost, cap=4, is_general=general, men_display=100,
    )


def rosters(*extra: UnitCard) -> Rosters:
    cards = [
        card("ntw3_gen_staff_001", cls="general", general=True, cost=0),
        card("ntw3_inf_line_001"),
        card("ntw3_inf_line_001_com_1", cost=120),
        card("ntw3_inf_line_002"),
        card("ntw3_inf_line_002", faction=OTHER),
        *extra,
    ]
    return Rosters.from_cards(cards)


def army(units: list[str], *, key: str = FACTION, player: str = "p1",
         staff: str | None = "ntw3_gen_staff_001") -> Army:
    return Army(army_key=key, corps_id="c", side="a", player=player, corps_name="Corps",
                staff_key=staff, units=[Unit(key=u, is_commander=u.endswith("_com_1")) for u in units])


def battle(*armies: Army, map_: str = "m") -> Battle:
    return Battle(game_build="b", map=map_, armies=list(armies))


class EvaluateTests(unittest.TestCase):
    def test_zero_armies_is_naval(self) -> None:
        self.assertEqual(evaluate(battle(), rosters(), set()).reason, "naval")

    def test_naval_key_is_naval(self) -> None:
        v = evaluate(battle(army(["ntw3_nav_ship_001"])), rosters(), set())
        self.assertEqual(v.reason, "naval")

    def dropped(self, v, reason: str) -> None:
        self.assertTrue(v.accepted)
        self.assertEqual([d.reason for d in v.dropped], [reason])

    def test_unresolved_key_drops_only_that_army(self) -> None:
        v = evaluate(battle(army(["ntw3_inf_line_999"]), army(["ntw3_inf_line_001"], player="b")), rosters(), set())
        self.dropped(v, "unverifiable")
        self.assertIn("ntw3_inf_line_999", v.dropped[0].detail)
        self.assertEqual([r.index for r in v.armies], [1])

    def test_key_from_another_faction_is_unverifiable(self) -> None:
        r = rosters(card("ntw3_inf_only_other", faction=OTHER))
        self.dropped(evaluate(battle(army(["ntw3_inf_only_other"])), r, set()), "unverifiable")

    def test_faction_without_roster_is_unverifiable(self) -> None:
        v = evaluate(battle(army([], key="custom_x", staff=None)), rosters(), set())
        self.dropped(v, "unverifiable")

    def test_over_budget_drops_army_keeps_siblings_and_battle(self) -> None:
        r = rosters(card("ntw3_inf_line_big", cost=10001))
        v = evaluate(battle(army(["ntw3_inf_line_001"], player="a"),
                            army(["ntw3_inf_line_big"], player="b"),
                            army(["ntw3_inf_line_002"], player="c")), r, set())
        self.dropped(v, "over_budget")
        self.assertEqual(v.dropped[0].index, 1)
        self.assertEqual(v.dropped[0].detail, "10001 MP")
        # indices are original positions, not renumbered
        self.assertEqual([a.index for a in v.armies], [0, 2])

    def test_duplicate_fingerprint(self) -> None:
        seen: set = set()
        first = evaluate(battle(army(["ntw3_inf_line_001"])), rosters(), seen)
        again = evaluate(battle(army(["ntw3_inf_line_001"])), rosters(), seen)
        self.assertTrue(first.accepted)
        self.assertEqual(again.reason, "duplicate")

    def test_duplicate_detected_even_with_over_budget_army(self) -> None:
        r = rosters(card("ntw3_inf_line_big", cost=10001))
        seen: set = set()
        make = lambda: battle(army(["ntw3_inf_line_001"], player="a"), army(["ntw3_inf_line_big"], player="b"))
        self.assertTrue(evaluate(make(), r, seen).accepted)
        self.assertEqual(evaluate(make(), r, seen).reason, "duplicate")

    def test_different_map_is_not_duplicate(self) -> None:
        seen: set = set()
        evaluate(battle(army(["ntw3_inf_line_001"])), rosters(), seen)
        other = evaluate(battle(army(["ntw3_inf_line_001"]), map_="elsewhere"), rosters(), seen)
        self.assertTrue(other.accepted)

    def test_non_general_staff_slot_becomes_ordinary_unit(self) -> None:
        v = evaluate(battle(army(["ntw3_inf_line_002"], staff="ntw3_inf_line_001")), rosters(), set())
        self.assertTrue(v.accepted)
        self.assertEqual(v.dropped, [])
        rows = army_unit_rows("f.replay", v.armies[0])
        self.assertEqual([r["unit_key"] for r in rows], ["ntw3_inf_line_001", "ntw3_inf_line_002"])
        self.assertFalse(any(r["is_staff_slot"] for r in rows))
        self.assertEqual(rows[0]["slot"], 0)

    def test_accepted_staff_row_is_slot_zero_with_cap_group_base(self) -> None:
        v = evaluate(battle(army(["ntw3_inf_line_001_com_1", "ntw3_inf_line_002"])), rosters(), set())
        self.assertTrue(v.accepted)
        rows = army_unit_rows("f.replay", v.armies[0])
        self.assertEqual(rows[0]["slot"], 0)
        self.assertIs(rows[0]["is_staff_slot"], True)
        self.assertIs(rows[0]["is_commander"], False)
        self.assertEqual(rows[1]["unit_key"], "ntw3_inf_line_001_com_1")
        self.assertEqual(rows[1]["base_unit_key"], "ntw3_inf_line_001")
        self.assertIs(rows[1]["is_commander"], True)
        self.assertIs(rows[1]["is_staff_slot"], False)

    def test_same_corps_twice_keeps_distinct_army_index(self) -> None:
        v = evaluate(battle(army(["ntw3_inf_line_001"], player="a"),
                            army(["ntw3_inf_line_002"], player="b")), rosters(), set())
        self.assertTrue(v.accepted)
        self.assertEqual([r.index for r in v.armies], [0, 1])
        rows = [row for r in v.armies for row in army_unit_rows("f.replay", r)]
        self.assertEqual({row["army_index"] for row in rows}, {0, 1})


class MultiFolderTests(unittest.TestCase):
    def test_same_file_name_gets_distinct_ids_and_cross_folder_duplicate_is_caught(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for d in ("season_a", "season_b"):
                (root / d).mkdir()
                (root / d / "same.replay").write_bytes(b"x")
            (root / "season_b" / "other.replay").write_bytes(b"y")
            parse_fn = lambda blob: battle(army(["ntw3_inf_line_001" if blob == b"x" else "ntw3_inf_line_002"]))
            res = analyze([root / "season_a", root / "season_b"], root / "out", rosters(), parse_fn)
            self.assertEqual([b["battle_id"] for b in res["battles"]],
                             ["season_a/same.replay", "season_b/other.replay"])
            self.assertEqual([(e["battle_id"], e["reason"]) for e in res["excluded"]],
                             [("season_b/same.replay", "duplicate")])

    def test_same_folder_name_in_two_places_fails_early(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for parent in ("x", "y"):
                (root / parent / "s8").mkdir(parents=True)
                (root / parent / "s8" / "g.replay").write_bytes(b"x")
            with self.assertRaisesRegex(ValueError, "distinct names.*s8"):
                analyze([root / "x" / "s8", root / "y" / "s8"], root / "out", rosters(),
                        lambda b: battle(army(["ntw3_inf_line_001"])))

    def test_single_folder_keeps_bare_file_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "s").mkdir()
            (root / "s" / "g.replay").write_bytes(b"x")
            res = analyze([root / "s"], root / "out", rosters(), lambda b: battle(army(["ntw3_inf_line_001"])))
            self.assertEqual(res["battles"][0]["battle_id"], "g.replay")


if __name__ == "__main__":
    unittest.main()
