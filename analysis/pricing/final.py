"""FINAL, the committed final model of each arm (analysis/output/coefficients.csv, 2026-10-05 run).

Every downstream study (AC pricing, class structure, commanders, team values, the optimiser data) starts
from these specs; the checkpointed fits in analysis/.cache/ were computed with them, so changing one
invalidates those results.

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

from pricing.spec import Spec

FINAL = {
    "infantry": Spec(mult=frozenset({"rating", "side"}), size="n", p=1.09, powers=tuple(sorted({
        "accuracy": 0.05, "ammo": 0.05, "charge_bonus": 0.05, "melee_attack": 1.4, "melee_defense": 1.15,
        "morale": 2.25, "range": 4.0, "reload_skill": 3.1}.items()))),
    "cavalry": Spec(mult=frozenset({"rank_depth", "rating"}), size="n", p=0.75),
    "artillery": Spec(mult=frozenset({"rating"}), const=True, size="guns", p=1.3,
                      extras=frozenset({"damage", "proj_reload"}),
                      shape=(("cal", "spline_r"), ("cal_df", "5")), powers=tuple(sorted({
                          "accuracy": 3.0, "charge_bonus": 0.25, "melee_attack": 2.5, "melee_defense": 3.0,
                          "morale": 3.0, "reload_skill": 2.0}.items()))),
}
