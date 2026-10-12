"""Keep pickled classes loadable after the split of unit_pricing.py into this package.

The checkpoints in analysis/.cache/ (hours of fits) store ten classes as `unit_pricing.<Name>`, and pickle
finds a class again by that module path. Each of those classes carries @pickled_as_unit_pricing, so it
still reports module `unit_pricing` (which re-exports it): old checkpoints load, and new ones are written
exactly as before. Their fields must not change either (no renames, no new fields), or old pickles would
load with missing or stale attributes.
"""

from __future__ import annotations

from typing import TypeVar

T = TypeVar("T", bound=type)


def pickled_as_unit_pricing(cls: T) -> T:
    cls.__module__ = "unit_pricing"
    return cls
