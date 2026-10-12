"""The design matrix: numeric stats (optionally powered), flags, one-hots, splines and the
multiplicative factors, built for a Spec.

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Callable, Sequence

import numpy as np

from pricing.constants import (
    ABILITIES, EXTRA_ABILITIES, MIN_FLAG_ROWS, NUMERIC, POWER_SCALE, RATE_SCALE, REF_RATING, SHAPE_DEFAULTS,
    SHOOT_STATS)
from pricing.data import Unit
from pricing.spec import Spec


# --- Design matrix ------------------------------------------------------------

@dataclass
class Design:
    X: np.ndarray
    names: list[str]
    references: dict[str, str]   # categorical family -> reference (omitted) level
    dropped: list[str]           # candidate columns dropped as constant / too rare
    aliases: list[str] = field(default_factory=list)   # dropped as exact combinations of kept columns
    power_keys: list[str] = field(default_factory=list)   # exponents this design can fit


def most_common_level(levels: Sequence) -> object:
    counts = Counter(levels)
    return sorted(counts, key=lambda level: (-counts[level], str(level)))[0]


def prune_aliases(X: np.ndarray, names: Sequence[str]) -> tuple[np.ndarray, list[str], list[str]]:
    """Drop every column that is an exact linear combination of the constant and
    the columns kept before it, recording the identity it satisfies.

    The data has structural redundancies — artillery crew per gun is fixed by
    type (foot 10, horse 6), so guns/n is a function of the class; heavy cavalry
    are exactly the C1+C2 speeds; and so on. Pruning keeps OLS and every
    coefficient readable. Column order is the priority.
    """
    kept: list[int] = []
    kept_names: list[str] = []
    aliases: list[str] = []
    basis = [np.ones(len(X))]
    for j, name in enumerate(names):
        column = X[:, j]
        A = np.column_stack(basis)
        coef, *_ = np.linalg.lstsq(A, column, rcond=None)
        if np.abs(column - A @ coef).max() <= 1e-8 * max(1.0, float(np.abs(column).max())):
            terms = [f"{c:+.4g}·{n}" for c, n in zip(coef, ["1"] + kept_names) if abs(c) > 1e-8]
            aliases.append(f"`{name}` = " + " ".join(terms))
            continue
        basis.append(column)
        kept.append(j)
        kept_names.append(name)
    return X[:, kept], kept_names, aliases


def spline_knots(x: np.ndarray, df: int) -> np.ndarray:
    """df + 1 knots (boundary ones included) at unit-weighted quantiles of x; if
    heavy ties collapse them (338 batteries are 6-pdrs), quantiles of the distinct
    values are used instead."""
    knots = np.unique(np.quantile(x, np.linspace(0, 1, df + 1)))
    if len(knots) < df + 1:
        knots = np.quantile(np.unique(x), np.linspace(0, 1, df + 1))
    return knots


def natural_spline_basis(x: np.ndarray, knots: np.ndarray) -> np.ndarray:
    """Natural cubic spline basis (without the constant): x and K − 2 cubic terms,
    K = len(knots), so df = K − 1. Linear beyond the boundary knots, so it
    extrapolates sanely. Standard truncated-power construction:
    N_k = d_k − d_{K−1}, d_k(x) = ((x − ξ_k)³₊ − (x − ξ_K)³₊) / (ξ_K − ξ_k)."""
    K = len(knots)
    def d(k: int) -> np.ndarray:
        return (np.maximum(x - knots[k], 0) ** 3 - np.maximum(x - knots[-1], 0) ** 3) / (knots[-1] - knots[k])
    columns = [x] + [d(k) - d(K - 2) for k in range(K - 2)]
    return np.column_stack(columns)


def factor_values(units: Sequence[Unit], var: str) -> np.ndarray:
    if var == "rating":
        return np.array([u.rating for u in units])
    if var == "training":
        return np.array([u.training for u in units])
    if var == "drill":
        return np.array([u.drill for u in units])
    if var == "side":
        return np.array([u.side for u in units])
    if var == "rank_depth":
        return np.array([u.rank_depth for u in units], float)
    if var == "size":
        # Diagnostic only: a multiplier 1 + δ·(n − median) tests whether price
        # per model changes with unit size (rank_depth tracks n at r ≈ 0.97).
        return np.array([u.n for u in units], float)
    if var == "faction":
        return np.array([u.faction for u in units])
    if var == "fclass":
        return np.array([f"{u.faction}|{u.unit_class}" for u in units])
    if var == "uclass":
        return np.array([u.unit_class for u in units])
    raise KeyError(var)


def build_design(units: Sequence[Unit], arm: str, *, linear: frozenset[str] = frozenset(),
                 extras: frozenset[str] = frozenset(), powers: dict[str, float] | None = None,
                 const_inside: bool = False, use_gs: bool = False, shape: dict[str, str] | None = None,
                 class_linear: bool = True) -> Design:
    """Per-size feature matrix f(x). The per-size constant b0 is the regression
    intercept, not a column. `linear` holds the candidate variables placed in the
    linear part; `extras` the ablation features; `powers` the exponents — on
    additive numeric stats (key = stat), inside the shooting product (key =
    "shoot:<stat>", "shoot:rate", "shoot:damage") and on the artillery calibre
    column ("cal:damage"); `shape` how shooting and firearm/calibre enter (see
    SHAPE_DEFAULTS); `const_inside` adds a c/n column (coverage design only)."""
    powers = powers or {}
    shape = {**SHAPE_DEFAULTS, **(shape or {})}
    fire, cal, shoot = shape["fire"], shape["cal"], shape["shoot"]
    extras = set(extras)
    if fire == "firearm" and arm != "artillery":
        extras |= {"firearm", "no_range"}
    if arm == "artillery" and cal != "full":
        # Calibre / cannon type carry range and the gun's reload time.
        extras = (extras - {"damage", "proj_reload"}) | {"no_range"}
    shoot_stats = SHOOT_STATS[arm] if shoot != "additive" else ()
    columns: list[np.ndarray] = []
    names: list[str] = []
    dropped: list[str] = []
    references: dict[str, str] = {}
    power_keys: list[str] = []

    def add(values: np.ndarray, name: str) -> None:
        columns.append(np.asarray(values, float))
        names.append(name)

    def stat(column: str) -> np.ndarray:
        return np.array([u.values[column] for u in units], float)

    for column in NUMERIC:
        if (column == "range" and "no_range" in extras) or column in shoot_stats:
            continue
        values = stat(column)
        if np.ptp(values) == 0:
            dropped.append(f"{column} (constant)")
            continue
        a = powers.get(column, 1.0)
        add((values / POWER_SCALE) ** a if a != 1.0 else values, column)
        power_keys.append(column)

    flags = (("has_range",) if "no_range" not in extras else ()) + ABILITIES + EXTRA_ABILITIES
    if "pike_square" in extras:
        flags += ("pike_square",)
    for column in flags:
        values = np.array([u.values[column] for u in units])
        minority = int(min(values.sum(), len(values) - values.sum()))
        if minority < MIN_FLAG_ROWS:
            dropped.append(f"{column} ({minority} minority rows)")
            continue
        add(values, column)

    # Explicit traits are kept however rare (they are the point of the feature);
    # the split pins singleton levels to train and reports them as unvalidated.
    if arm == "cavalry":
        camel = np.array([1.0 if u.is_camel else 0.0 for u in units])
        if camel.any():
            add(camel, "is_camel")
    if arm == "infantry" and use_gs:
        gs = np.array([1.0 if u.is_gs else 0.0 for u in units])
        if gs.any():
            add(gs, "is_gs")

    families: list[tuple[str, Callable[[Unit], object]]] = [
        ("unit_class", lambda u: u.unit_class),
        # Camels carry is_camel instead of a speed level (all speed dummies 0).
        ("speed", lambda u: None if u.is_camel else u.speed),
    ]
    if not class_linear:
        families = families[1:]
    if "training" in linear:
        families.append(("training", lambda u: u.training))
    if "drill" in linear and arm == "infantry":
        families.append(("drill", lambda u: u.drill))
    if arm == "artillery" and shape["shot"] != "none":
        families.append(("shot", lambda u: u.shot))
    if arm == "artillery" and cal == "projectile":
        families.append(("projectile", lambda u: u.projectile))
    if "firearm" in extras:
        families.append(("firearm", lambda u: u.firearm))
    if "rating" in linear:
        families.append(("rating", lambda u: u.rating))
    if "side" in linear:
        families.append(("side", lambda u: u.side))
    for family, getter in families:
        levels = [getter(u) for u in units]
        present = [level for level in levels if level is not None]
        if len(set(present)) < 2:
            dropped.append(f"{family} (single level)")
            continue
        if family == "rating" and REF_RATING in present:
            reference = REF_RATING
        else:
            reference = most_common_level(present)
        references[family] = str(reference)
        for level in sorted(set(present) - {reference}, key=str):
            add(np.array([1.0 if value == level else 0.0 for value in levels]), f"{family}={level}")

    if "rank_depth" in linear:
        add(np.array([u.rank_depth for u in units]), "rank_depth")
    if "damage" in extras:
        add(np.array([u.values["proj_damage"] for u in units]), "projectile_damage")
    if "proj_reload" in extras:
        add(np.array([u.values["proj_reload"] for u in units]), "projectile_reload_time")

    if arm == "artillery" and cal == "calibre":
        add((stat("proj_damage") / POWER_SCALE) ** powers.get("cal:damage", 1.0), "calibre")
        power_keys.append("cal:damage")
    if arm == "artillery" and cal == "power2":
        add((stat("range") / POWER_SCALE) ** powers.get("cal:range", 1.0), "calibre_range")
        add((stat("proj_damage") / POWER_SCALE) ** powers.get("cal:damage", 1.0), "calibre_damage")
        power_keys += ["cal:range", "cal:damage"]
    if arm == "artillery" and cal in ("spline_r", "spline_d", "spline_rd", "poly2"):
        log_r, log_d = np.log(stat("range")), np.log(stat("proj_damage"))
        df = int(shape["cal_df"])
        if cal in ("spline_r", "spline_rd"):
            for j, column in enumerate(natural_spline_basis(log_r, spline_knots(log_r, df)).T):
                add(column, f"cal_r{j + 1}")
        if cal in ("spline_d", "spline_rd"):
            for j, column in enumerate(natural_spline_basis(log_d, spline_knots(log_d, df)).T):
                add(column, f"cal_d{j + 1}")
        if cal == "poly2":
            r, d = log_r - log_r.mean(), log_d - log_d.mean()
            for column, name in ((r, "cal_lr"), (d, "cal_ld"), (r * r, "cal_lr2"), (d * d, "cal_ld2"), (r * d, "cal_lrld")):
                add(column, name)

    if shoot_stats:
        # Shooting effectiveness compounded: accuracy, ammo and the crew's reload
        # skill multiply with the gun's intrinsic fire rate (independent of crew
        # skill). Not shifted: zero ammo or accuracy really means no shooting.
        product = np.ones(len(units))
        for column in shoot_stats:
            product *= (stat(column) / POWER_SCALE) ** powers.get(f"shoot:{column}", 1.0)
        reload_time = stat("proj_reload")
        rate = np.divide(RATE_SCALE, reload_time, out=np.zeros(len(units)), where=reload_time > 0)
        product *= rate ** powers.get("shoot:rate", 1.0)
        power_keys += [f"shoot:{column}" for column in shoot_stats] + ["shoot:rate"]
        by_type = None
        if shoot == "product_type":
            if arm == "artillery" and cal == "calibre":
                product *= (stat("proj_damage") / POWER_SCALE) ** powers.get("shoot:damage", 1.0)
                power_keys.append("shoot:damage")
            elif arm == "artillery" and cal == "projectile":
                by_type = ("projectile", [u.projectile for u in units])
            elif "firearm" in extras:
                by_type = ("firearm", [u.firearm for u in units])
        if by_type:
            family, levels = by_type
            for level in sorted(set(levels)):
                add(product * np.array([1.0 if value == level else 0.0 for value in levels]), f"shoot×{family}={level}")
        else:
            add(product, "shoot")

    if arm == "artillery":
        # Crew per gun is fixed by type, so guns/n is a function of the class and
        # this column is always aliased (reported) — kept for the identity.
        add(np.array([u.guns / u.n for u in units]), "guns_per_model")
    if const_inside:
        add(np.array([1.0 / u.n for u in units]), "per_unit_const")

    X = np.column_stack(columns) if columns else np.zeros((len(units), 0))
    X, names, aliases = prune_aliases(X, names)
    # An exponent is fittable only while its column survived alias pruning.
    shooting_kept = any(name == "shoot" or name.startswith("shoot×") for name in names)
    cal_columns = {"cal:damage": ("calibre", "calibre_damage"), "cal:range": ("calibre_range",)}
    power_keys = [k for k in power_keys
                  if (k.startswith("shoot:") and shooting_kept)
                  or (k in cal_columns and any(c in names for c in cal_columns[k]))
                  or k in names]
    return Design(X=X, names=names, references=references, dropped=dropped, aliases=aliases, power_keys=power_keys)


def design_for(spec: Spec, units: Sequence[Unit], arm: str) -> Design:
    return build_design(units, arm, linear=spec.linear, extras=spec.extras, powers=dict(spec.powers),
                        shape=dict(spec.shape), class_linear="uclass" not in spec.mult)
