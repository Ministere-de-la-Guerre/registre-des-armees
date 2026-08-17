"""Extract the exact army builds from an NTW3 (Napoleon: Total War) .replay file.

Framing: every string in the replay is `0x0E <uint16 LE char count> <UTF-16LE chars>`.
The battle-setup block near the end of the file lists, per army corps, the ordered
unit keys, then (in a second pass) the localised display names in the same order.
Those keys are byte-identical to the `unit_key`s in the generated unit database, so
a parsed army maps straight onto a build.

Faithful port of web/src/domain/replay.ts — KEEP THE TWO IN PARITY. The TS module is
the reference implementation (it ships in the app and carries the vitest suite); this
one exists so the offline Python tooling reads replays exactly the same way.

Usage: python3 tools/replay_parser.py <file.replay> [--json]
"""
from __future__ import annotations

import json
import re
import sys
from dataclasses import asdict, dataclass, field

STRING_TAG = 0x0E

#: `ntw3_ac_a11_x5_117` / `ntw3_ac_a11_r5_131` — the letter before the slot count is
#: the corps *type* (`x` line, `r` reserve cavalry), so it must not be pinned.
ARMY_KEY_RE = re.compile(r"^ntw3_(?:ac|tow)_[a-z]\d{2}_[a-z]\d+_(\d+)$")
FLAG_RE = re.compile(r"^data\\ui\\flags\\", re.I)
UNIT_PREFIXES = ("ntw3_inf_", "ntw3_cav_", "ntw3_art_", "ntw3_nav_", "ntw3_gen_")
CORPS_NAME_RE = re.compile(r"^\d+\.\s")
#: `Officer Name (Regiment) [C4]` | `Regiment [L4]` — the tier tag is always last.
DISPLAY_NAME_RE = re.compile(
    r"^(?:(?P<officer>[^()]+?)\s*\((?P<inner>.+)\)|(?P<plain>.+?))\s*\[(?P<tier>[A-Z]\d)\]$"
)
#: The 3-digit regiment number embedded in a unit key, e.g. …_163_**043**_1366.
REGIMENT_NO_RE = re.compile(r"^ntw3_\w+?_\d+_(\d{3})_")
#: Numbers the key writes as one run but the name splits apart, so the name's own
#: digit runs never spell the key's number. Two kinds occur:
#:   - formations raised from several parents — `1./4.`, `3e/4e`, `1er/2e`,
#:     `9-ya/10ya`, `No. 2/2` — keyed by concatenation (1 and 4 -> `014`);
#:   - Ottoman calibres — `1.5 okka` keyed `015`.
#: Both are digit groups joined by a tight separator: an optional ordinal suffix or
#: hyphen, then a `.` or `/`. The separator admits no whitespace, so two merely
#: adjacent numbers ("6-Pfünder 'Berchem/Roys'") never pair up.
COMPOSITE_NO_RE = re.compile(r"\d+(?:[a-zA-Z-]{0,3}[./]{1,2}\d+)+")

#: Typographic punctuation that legitimately appears in localised unit names.
_QUOTES = {0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D}


def _plausible(text: str) -> bool:
    """Reject candidates that decoded as text but are really binary.

    A uint32 field (tag 0x03) can contain a 0x0E byte, which looks like a string tag
    and starts a UTF-16 read on the wrong byte. Such reads pair a data byte with an
    ASCII byte and land in CJK/Hangul/PUA; genuine strings are Latin (plus
    Cyrillic/Greek headroom for eastern factions) and mostly plain ASCII.
    """
    ascii_n = 0
    for ch in text:
        o = ord(ch)
        if 0x20 <= o <= 0x7E:
            ascii_n += 1
        elif 0xA0 <= o <= 0x04FF or o in _QUOTES:
            pass
        else:
            return False
    return ascii_n * 2 >= len(text)


def read_strings(blob: bytes) -> list[str]:
    """Every well-formed tagged string in the file, in order."""
    out: list[str] = []
    i, n = 0, len(blob)
    while i + 3 <= n:
        if blob[i] != STRING_TAG:
            i += 1
            continue
        count = int.from_bytes(blob[i + 1 : i + 3], "little")
        end = i + 3 + count * 2
        if count == 0 or end > n:
            i += 1
            continue
        try:
            text = blob[i + 3 : end].decode("utf-16-le")
        except UnicodeDecodeError:
            i += 1
            continue
        if not _plausible(text):
            i += 1  # step one byte: the real record may start just after a false tag
            continue
        out.append(text)
        i = end
    return out


@dataclass
class Unit:
    """One recruited unit copy."""

    key: str  #: joins directly onto the unit database's unit_key
    name: str = ""  #: localised name straight from the replay ("" if self-check failed)
    regiment: str = ""  #: regiment part of the display name, officer stripped
    officer: str = ""  #: attached combat general, when this copy is a `_com_` variant
    tier: str = ""  #: class+tier tag, e.g. L4 / S3 / C4 / F5 / H1 / G2
    is_commander: bool = False


@dataclass
class Army:
    army_key: str  #: army-corps key; doubles as the app's faction_key
    corps_id: str
    side: str
    player: str = ""
    corps_name: str = ""
    flag: str = ""
    #: None (not "") when the corps fielded no staff general, matching staffKey in
    #: web/src/domain/replay.ts. A handful of builds really do skip the staff slot.
    staff_key: str | None = None
    general: str = ""
    units: list[Unit] = field(default_factory=list)


@dataclass
class Battle:
    game_build: str = ""
    map: str = ""
    victory_condition: str = ""
    wind: str = ""
    armies: list[Army] = field(default_factory=list)
    #: Non-fatal integrity notes (e.g. an army whose names failed the self-check).
    warnings: list[str] = field(default_factory=list)


def split_display_name(name: str) -> tuple[str, str, str]:
    """'Samuel Hawker (14th Light Dragoons) [C4]' -> (officer, regiment, tier)."""
    m = DISPLAY_NAME_RE.match(name.strip())
    if not m:
        return "", name.strip(), ""
    if m.group("plain") is not None:
        return "", m.group("plain").strip(), m.group("tier")
    return m.group("officer").strip(), m.group("inner").strip(), m.group("tier")


def _is_unit_key(s: str) -> bool:
    return s.startswith(UNIT_PREFIXES)


def _blocks(strings: list[str]) -> list[tuple[str, list[str]]]:
    """Split the string stream into (army_key, block) runs at each army-key marker, so
    trailing footer strings can never bleed from one army into the next."""
    starts = [i for i, s in enumerate(strings) if ARMY_KEY_RE.match(s)]
    out = []
    for n, i in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(strings)
        out.append((strings[i], strings[i + 1 : end]))
    return out


def _unpad(n: str) -> str:
    return n.lstrip("0") or "0"


def _key_regiment_no(key: str) -> str | None:
    """The regiment number a unit key claims, or None when it carries none
    (999 marks an un-numbered formation)."""
    m = REGIMENT_NO_RE.match(key)
    if not m or m.group(1) == "999":
        return None
    return _unpad(m.group(1))


def _name_regiment_nos(regiment: str) -> set[str]:
    """Every regiment number a display name can legitimately be claiming: each of its
    digit runs, plus the concatenation behind any `1./4.`-style composite."""
    out = {_unpad(n) for n in re.findall(r"\d+", regiment)}
    for composite in COMPOSITE_NO_RE.findall(regiment):
        out.add(_unpad("".join(re.findall(r"\d+", composite))))
    return out


def alignment_errors(army: Army) -> list[str]:
    """Self-check: the regiment number in a unit key must appear in that unit's
    display name. Catches any off-by-one in the key<->name pairing."""
    bad: list[str] = []
    for i, u in enumerate(army.units):
        n = _key_regiment_no(u.key)
        if n is None or not u.name:
            continue
        if n not in _name_regiment_nos(u.regiment):
            bad.append(f"#{i + 1} {u.key} -> {u.regiment}")
    return bad


def names_misaligned(army: Army) -> bool:
    """Whether the mismatches add up to a genuine shift, which is the only thing worth
    throwing a whole corps' names away for. An off-by-one lands *every* later name on
    the wrong unit, so it trips many units at once; a single mismatch is nearly always
    one name the self-check cannot read rather than a pairing bug — unless it is the
    corps' only checkable unit, which leaves nothing to corroborate it either way."""
    bad = alignment_errors(army)
    if not bad:
        return False
    checkable = sum(1 for u in army.units if u.name and _key_regiment_no(u.key) is not None)
    return len(bad) >= 2 or len(bad) == checkable


def parse(blob: bytes) -> Battle:
    strings = read_strings(blob)
    battle = Battle()

    for s in strings:
        if not battle.game_build and s.startswith("Napoleon: Total War"):
            battle.game_build = s
        elif not battle.map and s.startswith("BattleTerrain/Presets/"):
            parts = [p for p in s.split("/") if p]
            battle.map = parts[-1] if parts else ""
        elif not battle.victory_condition and s.startswith("BATTLE_SETUP_VICTORY_CONDITION_"):
            battle.victory_condition = s
        elif not battle.wind and s.startswith("wind_level_"):
            battle.wind = s

    by_key: dict[str, Army] = {}
    for army_key, body in _blocks(strings):
        army = by_key.get(army_key)
        if army is None:
            # --- key block: [staff][player][unit keys…][player][corps name][flag]
            m = ARMY_KEY_RE.match(army_key)
            army = Army(
                army_key=army_key,
                corps_id=m.group(1) if m else "",
                side=army_key.split("_")[2] if len(army_key.split("_")) > 2 else "",
            )
            by_key[army_key] = army
            battle.armies.append(army)
            # The FIRST key in the block is the commander slot, whatever key sits in
            # it. The role is positional, not a property of the key: the game lets a
            # player put a *combat* general in command (and then field the corps' own
            # staff general as an ordinary unit), which reading the `ntw3_gen_staff_`
            # prefix would get exactly backwards.
            commander_taken = False
            for s in body:
                if FLAG_RE.match(s):
                    army.flag = s
                    break
                if _is_unit_key(s):
                    if not commander_taken:
                        commander_taken = True
                        army.staff_key = s
                    else:
                        army.units.append(Unit(key=s, is_commander="_com_" in s))
                elif CORPS_NAME_RE.match(s):
                    army.corps_name = s
                elif not army.player:
                    army.player = s
            continue

        # --- name block: [player][flag][general][unit display names…]
        start = next((i for i, s in enumerate(body) if FLAG_RE.match(s)), -1)
        if start < 0 or start + 1 >= len(body):
            continue
        army.general = body[start + 1]
        names = body[start + 2 :]
        for u, s in zip(army.units, names):  # zip stops at the shorter of the two
            u.name = s
            u.officer, u.regiment, u.tier = split_display_name(s)
        # If the pairing failed its self-check, drop the names rather than show a
        # regiment (or worse, an officer) against the wrong unit. Keys stay valid.
        if names_misaligned(army):
            bad = alignment_errors(army)
            battle.warnings.append(
                f"{army.corps_name or army.army_key}: display names discarded "
                f"({len(bad)} misaligned, e.g. {bad[0]})."
            )
            for u in army.units:
                u.name = u.regiment = u.officer = u.tier = ""

    return battle


def main() -> None:
    path = sys.argv[1]
    with open(path, "rb") as handle:
        battle = parse(handle.read())

    if "--json" in sys.argv:
        print(json.dumps(asdict(battle), indent=2, ensure_ascii=False))
        return

    print(f"# {path}")
    for label in ("game_build", "map", "victory_condition", "wind"):
        print(f"{label:18s} {getattr(battle, label)}")
    for w in battle.warnings:
        print(f"!! {w}")
    for a in battle.armies:
        print(f"\n{'=' * 78}\n{a.corps_name or a.army_key}   [{a.army_key}]  side {a.side}")
        print(f"  player   : {a.player or '(AI / unassigned)'}")
        print(f"  general  : {a.general}   [{a.staff_key}]")
        print(f"  units    : {len(a.units)}")
        for i, u in enumerate(a.units, 1):
            tag = f"[{u.tier}]" if u.tier else ""
            off = f"  <- {u.officer}" if u.officer else ""
            print(f"   {i:2d}. {u.regiment or u.key:<62.62s} {tag:5s}{off}")
            print(f"       {u.key}")


if __name__ == "__main__":
    main()
