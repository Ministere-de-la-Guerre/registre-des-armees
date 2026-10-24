"""Data diagnostics reported alongside the model (eastern calibres, firearm range overlap).

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from typing import Sequence

import numpy as np

from pricing.data import Unit


# --- Data diagnostics ---------------------------------------------------------

LB_PER = {"funt": 0.9028, "okka": 2.828}   # Russian funt 409.5 g; Ottoman oka 1.2829 kg
SHELL_WORDS = ("yedinorog", "howitz", "haubit", "obus", "humbara", "qhādhif", "unicorn")


def eastern_calibre_rows(units: Sequence[Unit]) -> list[list[object]]:
    """Name calibre in its native unit vs the projectile the game fires.

    Flags a round shot whose pounder rating is more than 1.5× (or under 0.67×)
    the name's calibre converted to pounds, and a shell fired by a gun whose name
    gives a calibre but doesn't call it a howitzer or unicorn."""
    found: Counter = Counter()
    for u in units:
        if u.arm != "artillery":
            continue
        name = u.name
        m = (re.search(r"(\d+(?:\.\d+)?)-?\s*funt", name) or re.search(r"(\d+(?:\.\d+)?)\s*okka", name)
             or re.search(r"(\d+)\s*pewend", name) or re.search(r"iy[aā]r\s*(\d+)", name))
        if not m:
            continue
        unit = ("funt" if "funt" in name else "okka" if "okka" in name else "pewend" if "pewend" in name else "‘iyār")
        found[(unit, m.group(1), u.projectile, u.values["proj_damage"], u.weapon,
               any(w in name.lower() for w in SHELL_WORDS))] += 1
    rows = []
    for (unit, value, projectile, damage, weapon, named_shell), count in sorted(
            found.items(), key=lambda t: (t[0][0], float(t[0][1]))):
        lb = float(value) * LB_PER[unit] if unit in LB_PER else None
        flag = ""
        shot = re.match(r"cannon_(\d+)_pounder_shot", projectile)
        if shot and lb:
            ratio = int(shot.group(1)) / lb
            if ratio > 1.5 or ratio < 0.67:
                flag = f"⚠ fires a {shot.group(1)}-pdr shot (×{ratio:.1f} the name calibre)"
        if "shell" in projectile and not named_shell:
            flag = ("howitzer weapon; the name just doesn't say so" if "howitzer" in weapon
                    else "⚠ fires a shell, but neither name nor weapon is a howitzer/unicorn")
        rows.append([f"{value} {unit}", f"{lb:.1f}" if lb else "—", f"`{weapon}`", f"`{projectile}`",
                     f"{damage:g}", count, flag])
    return rows


def firearm_range_overlap(units: Sequence[Unit]) -> dict[str, float]:
    ranged = [u for u in units if u.values["range"] > 0]
    by_firearm: dict[str, set] = defaultdict(set)
    by_range: dict[float, set] = defaultdict(set)
    for u in ranged:
        by_firearm[u.firearm].add(u.values["range"])
        by_range[u.values["range"]].add(u.firearm)
    r = np.array([u.values["range"] for u in ranged])
    firearms = np.array([u.firearm for u in ranged])
    within = sum(float(((r[firearms == f] - r[firearms == f].mean()) ** 2).sum()) for f in set(firearms.tolist()))
    total = float(((r - r.mean()) ** 2).sum())
    return {
        "firearms": len(by_firearm), "ranges": len(by_range),
        "ranges_per_firearm_max": max(len(v) for v in by_firearm.values()),
        "firearms_per_range_max": max(len(v) for v in by_range.values()),
        "single_range_firearms": sum(len(v) == 1 for v in by_firearm.values()),
        "eta2": 1 - within / total if total else float("nan"),
    }
