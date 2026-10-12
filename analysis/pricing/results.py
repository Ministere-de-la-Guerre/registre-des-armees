"""Results, everything one unit_pricing run computes, as handed to the report and output writers.

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

from dataclasses import dataclass, field

from pricing.data import Staff, Unit
from pricing.spec import Spec
from pricing.cv import CVRun, Slice
from pricing.search import PowerResult, Profile, SearchResult
from pricing.staff import StaffSlice


# --- Results ------------------------------------------------------------------

@dataclass
class Results:
    units: list[Unit]
    staff: list[Staff]
    slices: dict[tuple[str, str], Slice]
    regression: dict[str, CVRun]
    profiles: dict[str, Profile]
    search: dict[str, SearchResult]
    reprofiles: dict[str, Profile]
    ablations: dict[str, list[tuple[str, str, CVRun, bool]]]   # arm -> (group, label, run, accepted)
    powers: dict[str, PowerResult]
    final: dict[str, Spec]
    packing: dict[str, dict]
    poland: dict[tuple[str, str], dict]
    transfer: dict[tuple[str, str], dict]
    staff_slices: dict[str, StaffSlice]
    staff_head: str
    staff_poland: dict[str, dict]
    tag_mismatches: list[Unit]
    ratings: dict[str, int]
    n_seeds: int
    shared_m: dict[str, dict[str, float]] = field(default_factory=dict)
    linear: bool = False
    variants: dict[str, list] = field(default_factory=dict)        # arm -> [VariantResult]
    variant_detail: dict[str, dict] = field(default_factory=dict)
    fclass: dict[tuple[str, str], "FclassResult"] = field(default_factory=dict)
    elapsed: float = 0.0
