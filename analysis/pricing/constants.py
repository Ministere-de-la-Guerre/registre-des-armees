"""Fixed constants of the pricing model: dev corps, split sizes, the variable lists, ability and
shape options. Tunable settings are in pricing/config.py.

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

import re


# Dev/test corps: "1. Lordz", "Lordz", "0. Placeholder A/B". Prices of 500-9 500
# that no real roster uses.
DEV_CORPS = frozenset({"aaa_lordz", "austria", "saxony", "hannover"})
# Custom Armies have catalog side "custom"; these two count as imperial (Denmark
# confirmed by the user — allied to France 1807-1814). The rest are coalition.
IMPERIAL_CUSTOM = frozenset({"france", "denmark"})
# "[1809] 7. Polska, sojusznicy" — pricing suspected wrong; run with and without.
POLAND = "ntw3_tow_c08_x8_048"
# Wellesley in "[1809] 10. UK, España, Portugal" — known arbitrary price (8★ at
# 1 746 vs an 8★ median of 1 197). Kept as a valid datapoint, reported.

SIDES = ("imperial", "coalition", "merged")
N_SPLITS = 5
TEST_SHARE = 1 / N_SPLITS
MIN_FLAG_ROWS = 5         # drop a 0/1 trait whose minority value covers fewer rows
MIN_STRATUM_GROUPS = 5    # collapse unit_class × speed to unit_class below this
MIN_BALANCE_ROWS = 10     # smaller factions can't approach 20% and don't drive the max
REF_RATING = 8            # rating at which the rating multiplier is 1 (the median corps)
# The tunable settings (search grids, iteration limits, workers, output dir, artillery calibre, size
# weighting) live in pricing/config.py; change them with configure(...), read config.settings.<name>.

# Size kinds tried per arm (first = default).
SIZE_KINDS = {"infantry": ("n",), "cavalry": ("n",), "artillery": ("guns", "n")}
# Stat-power coordinate descent: a ± window for p around the profile's best.
P_WINDOW = 0.30
# Fine local refinement around the coarse powers: a ±half window at a fine step
# per coordinate, re-centred (up to MAX_RECENTRE times) when the best value
# lands on a window edge — so powers stuck at the coarse grid's limits can move.
FINE_STAT_STEP, FINE_STAT_HALF = 0.05, 10     # stats: ±0.50 in steps of 0.05
FINE_P_STEP, FINE_P_HALF = 0.01, 15           # size power: ±0.15 in steps of 0.01
MIN_POWER = 0.05
MAX_RECENTRE = 4
# Powered stat columns are (stat / POWER_SCALE)^a, keeping large exponents
# numerically tame; predictions are unchanged, only the coefficient's unit.
POWER_SCALE = 100.0

# Shape options for how shooting and firearm/calibre information enters β·x.
#   fire  (infantry, cavalry): "range" — the numeric range stat; "firearm" — a
#         firearm one-hot (each firearm has exactly one range, so it holds all of
#         range plus whatever else differs between firearms)
#   cal   (artillery): "full" — range + projectile damage + projectile reload;
#         "calibre" — (damage/100)^a_cal with the shot-type one-hot (damage is a
#         consistent calibre label; within round shot it tracks range at r 0.99
#         and gun reload at r 0.92); "projectile" — a cannon-type one-hot
#   shoot "additive" — accuracy, ammo, reload_skill as separate columns;
#         "product" — one column shoot = Π (stat/100)^a × rate^a_rate, where
#         rate = RATE_SCALE / projectile reload time is the gun's intrinsic fire
#         rate (independent of the crew's reload_skill); "product_type" — the same
#         with one shooting slope per firearm / cannon type (artillery "calibre":
#         calibre inside the product instead)
#   cal   smooth calibre functions of log range r and log damage d, replacing the
#         cannon-type one-hot (experiments/ (analysis branch) calibre_function.py): "power2" —
#         (range/100)^a_r + (damage/100)^a_d; "spline_r" / "spline_d" — a natural
#         cubic spline in r or d with `cal_df` degrees of freedom; "spline_rd" — both
#         splines; "poly2" — a quadratic surface in (r, d) with the interaction
#   shot  (artillery) "onehot" — shot-type one-hot; "none" — left out, letting a 2-D
#         calibre function separate howitzers / unicorns from round shot
SHAPE_DEFAULTS = {"fire": "range", "cal": "full", "shoot": "additive", "cal_df": "3", "shot": "onehot"}
SHOOT_STATS = {
    "infantry": ("accuracy", "ammo", "reload_skill"),
    "cavalry": ("accuracy", "ammo", "reload_skill"),
    "artillery": ("accuracy", "reload_skill"),     # artillery ammo is a constant 30
}
RATE_SCALE = 20.0          # fire rate = 20 / reload time: ≈ 1 for a musket (14-20 s)

NUMERIC = (
    "accuracy", "reload_skill", "ammo", "morale",
    "melee_attack", "melee_defense", "charge_bonus", "range",
)
# Traits and abilities shown in the description "Abilities:" line.
ABILITIES = (
    "can_form_square", "has_stamina", "is_shock_resistant", "can_inspire",
    "has_guerrilla_deployment", "can_place_stakes", "can_place_mines",
    "scares_enemies", "can_build_barricades",
)
# In-game abilities the description line omits — fixed in β·x (per the user).
EXTRA_ABILITIES = ("guard_mode", "skirmish", "can_snipe")

# Candidate variables for the structure search: categorical ones get a one-hot
# block (linear) or one free multiplier per level (multiplicative); rank_depth
# gets γ·rank_depth (linear) or 1 + δ·(rank_depth − median) (multiplicative).
CATEGORICAL = ("rating", "training", "drill", "side")
# Army-level price groupings (from the blind study, blind-pricing-study branch):
# one multiplier per faction (= army) and one per faction × unit_class cell, as
# NTW3 prices look hand-set per corps per unit class. Only ever multipliers, and
# fitted with a ridge pull towards 1 worth κ pseudo-units of average price, so
# they need no reference level and an unseen cell falls back to its faction's
# factor (then 1). Kept out of CATEGORICAL, which also drives linear placements.
GROUPING = ("faction", "fclass")
# "uclass" = unit class as a multiplier (reference = most common class), replacing
# its additive one-hot in β·x (analysis/class_structure.py).
MULT_CATEGORICAL = CATEGORICAL + GROUPING + ("uclass",)
CANDIDATES = {
    "infantry": ("rating", "training", "drill", "rank_depth", "side"),
    "cavalry": ("rating", "training", "rank_depth", "side"),
    "artillery": ("rating", "training", "rank_depth", "side"),
}
# Linear-part ablations: groups of mutually exclusive alternatives.
ABLATIONS = {
    "infantry": {
        "solid square": [("+ pike_square", frozenset({"pike_square"}))],
        "firearm vs range": [
            ("firearm instead of range", frozenset({"firearm", "no_range"})),
            ("firearm + range", frozenset({"firearm"})),
            ("range + firearm reload time", frozenset({"proj_reload"})),
        ],
    },
    "cavalry": {
        "firearm vs range": [
            ("firearm instead of range", frozenset({"firearm", "no_range"})),
            ("firearm + range", frozenset({"firearm"})),
        ],
    },
    "artillery": {
        "calibre": [
            ("+ projectile damage", frozenset({"damage"})),
            ("+ projectile damage + reload time", frozenset({"damage", "proj_reload"})),
        ],
    },
}
# The game's own speed class closes every unit name: "... [L4]". It is
# game-authored, so it beats the pipeline-derived speed_code (which mislabels
# camels as L1 — see resolve_speed in build_ntw3_army_builder_database.py).
SPEED_TAG_RE = re.compile(r"\[([A-Z]+)(\d*)\]\s*$")
