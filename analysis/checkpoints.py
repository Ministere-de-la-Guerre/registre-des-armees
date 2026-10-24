"""Every analysis checkpoint's file name, in one place.

Checkpoints are pickles in analysis/.cache/ (gitignored) holding hours of model fits. Their names are
part of the contract between scripts — class_structure writes V4 and cost_effective_builds reads it —
so they are built only here. Never bump a version here to "refresh" results: that silently orphans every
existing checkpoint (and three scripts used to hard-code the class_structure names).
"""

from __future__ import annotations

from pathlib import Path

from common import CACHE_ROOT, DEFAULT_SEEDS, load_pickle

AC_DIR = CACHE_ROOT / "ac"                       # analysis/ac_pricing.py
CLASS_STRUCTURE_DIR = CACHE_ROOT / "class_structure"
TEAMS_DIR = CACHE_ROOT / "teams"                 # analysis/team_values.py, team_search.py
SIZE_WEIGHTING_DIR = CACHE_ROOT / "size_weighting"
AC_VERSION = 1
CLASS_STRUCTURE_VERSION = 2


def ac(name: str) -> Path:
    """ac_pricing's checkpoints: v1_<name>.pkl, names usually tagged s<seeds>_<arm>_…"""
    return AC_DIR / f"v{AC_VERSION}_{name}.pkl"


def class_structure(name: str) -> Path:
    """class_structure's checkpoints (V0–V4 per arm, κ per arm): v2_<arm>_<variant>.pkl."""
    return CLASS_STRUCTURE_DIR / f"v{CLASS_STRUCTURE_VERSION}_{name}.pkl"


def teams(name: str) -> Path:
    return TEAMS_DIR / f"{name}.pkl"


def size_weighting(name: str) -> Path:
    return SIZE_WEIGHTING_DIR / f"{name}.pkl"



# --- the named checkpoints scripts read from each other -------------------------------------------------


def slice_path(dataset: str, arm: str, seeds: int = DEFAULT_SEEDS) -> Path:
    """The fold plan and units of an arm: AC data, or the ToW + Custom data ("tow")."""
    return ac(f"s{seeds}_{arm}_slice" if dataset == "ac" else f"s{seeds}_tow_{arm}_slice")


def ac_jfc_path(arm: str, seeds: int = DEFAULT_SEEDS) -> Path:
    return ac(f"s{seeds}_{arm}_jfc")


def ac_v4_path(arm: str, seeds: int = DEFAULT_SEEDS) -> Path:
    return ac(f"s{seeds}_{arm}_v4")


def tow_v4_path(arm: str) -> Path:
    return class_structure(f"{arm}_V4")


def tow_kappa_path(arm: str) -> Path:
    return class_structure(f"{arm}_kappa")


def v4_path(dataset: str, arm: str) -> Path:
    """The per-class model V4: (CVRun, size power per class)."""
    return ac_v4_path(arm) if dataset == "ac" else tow_v4_path(arm)


def sb_path(dataset: str, arm: str) -> Path:
    """team_values' size-band model (F6 with 240+ merged): (CVRun, extra)."""
    return teams(f"sb_{dataset}_{arm}")


def tow_builds_path(version: str) -> Path:
    """team_search's one-roll ToW / Custom builds per value version."""
    return teams(f"tow_builds_v2_{version}")


def kappa_of(dataset: str, arm: str) -> float:
    """The adopted model's ridge κ for an arm: AC from the AC fclass CV, ToW from class_structure."""
    if dataset == "ac":
        return load_pickle(ac_jfc_path(arm)).full_kappa
    return load_pickle(tow_kappa_path(arm))
