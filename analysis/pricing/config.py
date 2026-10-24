"""The pricing model's runtime settings, in one object.

These used to be module globals of unit_pricing that scripts reassigned (`up.WORKERS = 4`). Once the
model is split into modules, such an assignment would silently stop reaching the code that reads it,
so settings now live here: code reads `config.settings.<name>` at call time (never `from config import
...`, which would copy a stale value), and callers change them only through `configure(...)`. The
worker pool hands the whole object to its processes (pricing/pool.py), so workers see the same values.

Defaults are exactly the values the committed results were computed with.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, fields, replace
from pathlib import Path
from typing import Callable

from common import OUTPUT


@dataclass(frozen=True)
class Settings:
    # Worker processes for the nested searches (--workers); 1 = serial.
    workers: int = max(1, min(6, (os.cpu_count() or 1) // 2))
    # Where unit_pricing's main writes its outputs (--out).
    out_dir: Path = OUTPUT
    # Size power profile: p from 0.40 to 2.40.
    p_grid: tuple[float, ...] = tuple(round(0.40 + 0.05 * i, 2) for i in range(41))
    # Stat-power coordinate descent: candidate powers per stat, and passes.
    power_grid: tuple[float, ...] = (0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0)
    max_passes: int = 4
    # Fine local refinement passes around the coarse powers.
    fine_passes: int = 3
    # PriceModel's alternating least squares: iteration cap and relative convergence tolerance.
    max_iter: int = 300
    tolerance: float = 1e-10
    # --artillery-cal: "auto" screens every calibre representation, else F0 plus the named one.
    artillery_cal: str = "auto"
    # Size-frequency row weights (experiments/ (analysis branch) size_weighting.py; unit_pricing.size_weights); None = off.
    size_weighting: dict | None = None


settings = Settings()
_listeners: list[Callable[[Settings, Settings], None]] = []


def configure(**changes) -> Settings:
    """Change settings by name (e.g. configure(workers=4, size_weighting={...})). Unknown names raise.
    Listeners (the worker pool) are told, so a pool started with old values is shut down."""
    global settings
    known = {f.name for f in fields(Settings)}
    unknown = sorted(set(changes) - known)
    if unknown:
        raise TypeError(f"unknown setting(s) {unknown}; known: {sorted(known)}")
    old, settings = settings, replace(settings, **changes)
    for listener in _listeners:
        listener(old, settings)
    return settings


def on_change(listener: Callable[[Settings, Settings], None]) -> None:
    _listeners.append(listener)


def install(new: Settings) -> None:
    """Replace the settings wholesale without notifying listeners (a worker process's initializer)."""
    global settings
    settings = new
