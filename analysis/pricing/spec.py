"""Spec, the description of one candidate model (size kind and power, stat powers, which variables
are multiplicative, shape options).

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

from dataclasses import dataclass, replace

from pricing.pickling import pickled_as_unit_pricing
from pricing.constants import GROUPING, REF_RATING, SHAPE_DEFAULTS


# --- Model specification ------------------------------------------------------

@pickled_as_unit_pricing
@dataclass(frozen=True)
class Spec:
    """One model. `linear` / `mult` hold candidate variables; `const` adds c
    outside the multiplier; `extras` are linear-part ablation features; `size`
    is "n" (models) or "guns"; `p` the size power; `powers` per-stat powers as
    sorted (stat, a) pairs (absent = 1); `faction` adds a faction modifier.

    Blind-study options (defaults leave the model unchanged): `fixed_rating`
    replaces the free rating levels by the divisor REF_RATING / rating (drop
    "rating" from mult); "faction" / "fclass" in `mult` fit those groupings jointly
    with ridge strength `kappa`; `fclass = "residual"` adds a faction × unit_class
    modifier after the faction modifier, shrunk towards it with `kappa`; `loss =
    "lad"` fits least absolute deviation on total price by IRLS."""
    linear: frozenset[str] = frozenset()
    mult: frozenset[str] = frozenset()
    const: bool = False
    extras: frozenset[str] = frozenset()
    size: str = "n"
    p: float = 1.0
    powers: tuple[tuple[str, float], ...] = ()
    faction: bool = False
    shape: tuple[tuple[str, str], ...] = ()      # non-default SHAPE_DEFAULTS entries
    fixed_rating: bool = False
    fclass: str = "none"                         # "none" | "residual"
    kappa: float = 0.0
    loss: str = "ls"                             # "ls" | "lad"

    def power_of(self, stat: str) -> float:
        return dict(self.powers).get(stat, 1.0)

    def shape_of(self, key: str) -> str:
        return dict(self.shape).get(key, SHAPE_DEFAULTS[key])

    def describe(self) -> str:
        lin = ", ".join(sorted(self.linear)) or "—"
        size = "models" if self.size == "n" else "guns"
        mul = " × ".join([f"{size}^{self.p:g}"] + sorted(self.mult))
        parts = [f"β·x + [{lin}]", f"× {mul}"]
        if self.const:
            parts.append("+ c")
        # Artillery calibre / cannon-type shapes replace these extras (build_design drops them).
        shown = self.extras - ({"damage", "proj_reload"} if self.shape_of("cal") != "full" else set())
        if shown:
            parts.append("extras: " + ", ".join(sorted(shown)))
        if self.shape:
            parts.append("shape: " + ", ".join(f"{k}={v}" for k, v in self.shape))
        bent = [f"{s}^{a:g}" for s, a in self.powers if a != 1.0]
        if bent:
            parts.append("stat powers: " + ", ".join(bent))
        if self.fixed_rating:
            parts.append(f"rating fixed ({REF_RATING}/N)")
        if self.mult & set(GROUPING) or self.fclass != "none":
            parts.append(f"κ={self.kappa:g}")
        if self.fclass == "residual":
            parts.append("+ residual faction×class")
        if self.loss != "ls":
            parts.append(f"loss {self.loss}")
        return " ".join(parts)


def with_powers(spec: Spec, powers: dict[str, float], p: float) -> Spec:
    return replace(spec, powers=tuple(sorted((s, a) for s, a in powers.items() if a != 1.0)), p=p)
