"""Shared foundations of the analysis scripts: paths, logging, markdown tables, CSV writing, atomic
checkpoint caching, game constants and the size-band definitions.

Everything here is plain and dependency-free (no pricing model), so every script — the pricing package
included — can import it. Values are exactly the ones the scripts used before they were gathered here;
changing one changes results.
"""

from __future__ import annotations

import csv
import pickle
import time
from pathlib import Path
from typing import Callable, Iterable, Sequence, TypeVar

T = TypeVar("T")

# --- paths ----------------------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
ANALYSIS = ROOT / "analysis"
OUTPUT = ANALYSIS / "output"
CACHE_ROOT = ANALYSIS / ".cache"
GENERATED = ROOT / "data" / "generated"
DATA_CSV = GENERATED / "ntw3_units_analysis.csv"
CATALOG_CSV = GENERATED / "army_corps_catalog.csv"
BUILDER_CSV = GENERATED / "ntw3_army_builder_units.csv"
SOURCE_TABLES = ROOT / "source" / "tables"     # the game's own database export (TSV)
TEAMS_OUT = OUTPUT / "teams"                   # team study, AC builds, optimiser inputs
AC_OUT = OUTPUT / "ac"                         # AC pricing study and the AC formation discounts
COMMANDER_PAIRS = ANALYSIS / "commander_blind" / "data" / "pairs.csv"   # build_commander_pairs.py
# ToW ladder-replay data (armies.csv, split.json) for two optional report checks; no shipped value uses it.
# When the folder is absent the checks are skipped (cost_effective_builds, team_values).
LADDER_REPLAY_DATA = ANALYSIS / "build_blind" / "data"

# --- game constants -------------------------------------------------------------------------------
BUDGET = 10_000            # funds per army
MAX_CARDS = 31             # cards per army, staff general included (NTW3.MaxUnits)
ARMS = ("infantry", "cavalry", "artillery")
ARM_SHORT = {"inf": "infantry", "cav": "cavalry", "art": "artillery"}
DEFAULT_SEEDS = 500        # fold-plan seeds of every committed analysis checkpoint
# German Campaign 1813 (both sides) is still being built in the mod and holds only work-in-progress
# corps (the user, 2026-10-10): left out of the AC builds, the team study and the optimiser data.
WIP_THEATRES = frozenset({"a16", "b16"})


def theatre_of(faction_key: str) -> str:
    """An Army Corps' theatre code, the faction key's third part (ntw3_ac_a11_x5_117 → a11)."""
    return faction_key.split("_")[2]


def is_wip(faction_key: str) -> bool:
    return "_ac_" in faction_key and theatre_of(faction_key) in WIP_THEATRES


# --- size bands -------------------------------------------------------------------------------------
# Five different band sets, each tied to the analysis that uses it; they are deliberately NOT merged
# (results depend on them). Models for infantry / cavalry, guns for artillery.
AC_STUDY_BANDS = {"n": (40, 60, 80, 100, 140, 180, 240), "guns": (2, 3, 4, 5)}   # ac_pricing F6, [lo, hi)
SB_BANDS_N = (40, 60, 80, 100, 140, 180)          # team_values' size-band values: 240+ merged into 180+
SB_BANDS = {"n": SB_BANDS_N, "guns": AC_STUDY_BANDS["guns"]}
CLASS_STRUCTURE_BANDS = (0, 40, 60, 80, 100, 140, 180, 240, 1000)   # class_structure residual table, (lo, hi]
HARMONISATION_STRATA = {"infantry": (40, 60, 80, 100, 120, 160, 200, 240),   # cost_effective_builds
                        "cavalry": (40, 60, 80, 100, 120, 160, 200, 240),
                        "artillery": (2, 3, 4, 5)}
SIZE_WEIGHT_BANDS = {"n": (40, 60, 80, 100, 140, 180, 240), "guns": (2, 3, 4, 5)}   # size_weighting

# --- output helpers ---------------------------------------------------------------------------------


def log(message: str, started: float) -> None:
    print(f"[{time.time() - started:5.0f}s] {message}", flush=True)


def table(header: Sequence[str], rows: Sequence[Sequence[object]]) -> list[str]:
    """A markdown table as lines."""
    out = ["| " + " | ".join(header) + " |", "| " + " | ".join("---" for _ in header) + " |"]
    out += ["| " + " | ".join(str(c) for c in row) + " |" for row in rows]
    return out


def write_csv(path: Path, header: Sequence[str], rows: Iterable[Sequence[object]]) -> None:
    """UTF-8 CSV with the csv module's default line endings (as every script wrote them)."""
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        w.writerows(rows)


def read_csv(path: Path) -> list[dict[str, str]]:
    with open(path, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


# --- checkpoints ------------------------------------------------------------------------------------


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write via a temporary file and rename, so an interrupted run never leaves half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def save_pickle(path: Path, value: object) -> None:
    atomic_write_bytes(path, pickle.dumps(value))


def load_pickle(path: Path):
    return pickle.loads(path.read_bytes())


def cached(path: Path, compute: Callable[[], T], fresh: bool = False) -> T:
    """The checkpoint at `path`, or compute it, save it atomically and return it."""
    if path.exists() and not fresh:
        return load_pickle(path)
    value = compute()
    save_pickle(path, value)
    return value
