"""The most cost-effective legal build for every ToW / Custom army.

"Value" is normative: what the game's average pricing rule would charge for a
card's stats in a reference army. That is the per-class model V4 at corps number
8, imperial/coalition at the reference, and no army × unit-class adjustment.
Commander cards are valued by the commander model (given the true regular price)
applied to their unit's normative value, also at corps 8. A card whose actual
price is below its value gives more stats per gold than the game's own average
rule; a build's value ÷ cost is its cost-effectiveness.

For each army an integer programme maximises total value under the game's limits
for Theatre-of-War and Custom armies (tools/army_builder_rules.py; no brigade or
division discounts outside Army Corps):

- exactly one staff general and at most one combat general (commander card), as
  the user specified (October 2026). The staff general is valued by the global
  general price rule T3 at corps 8 (76.55·stars^1.39, 1 without stars; no army
  modifier) plus a hand-set command correction (see M_REF / COMMAND_LAMBDA below:
  stars count for more in large, low-morale builds; C-class generals get a small
  nudge and a priced melee bonus), and chosen by the optimiser among all the
  army's staff generals — except in the "top staff" build, which takes the
  highest-star one, valued by T3 alone;
- by default 31 cards in total *including* the staff general, i.e. at most 30
  units; `--max-cards N` sets a lower cap (the user's micro cap: more units are
  harder to control, which no price captures), written to files suffixed _max<N>.
  The 31 is the game's limit as the
  app counts it (web/src/state/build.ts expandBuild puts the staff-slot card into
  the list that checkKnownLimits caps at MAX_TOTAL_UNIT_CARDS = 31; the game's
  Lua only states NTW3.MaxUnits() = 31). The app also lets a combat general take
  the staff slot; these builds always use a staff general there;
- 10 000 funds;
- foot artillery ≤ 2, horse artillery ≤ 1 (2 for a cavalry-only corps), heavy
  cavalry ≤ 10; a commander counts as its unit's class;
- each unit's `unit_cap`, shared by its commander versions;
- at most one general per unit;
- build 4 only ("four corps"): units from at most 4 source corps, as one
  Theatre-of-War roll offers (NTW3AC.ToWFarmycorps, max_ac = 4). A unit's source
  corps is the 4th part of its key (web/src/domain/tow.ts towSourceCorpsIdOf); the
  staff general's corps counts too, so the optimiser chooses the staff general
  jointly. Custom armies have no source corps and are unaffected.

Two builds per army:
- **max value:** no composition rule;
- **balanced:** at least 4 cavalry cards and 2 artillery cards, where the army
  has them.

**Size-harmonised values.** V4's errors depend on unit size (it overprices small
and very large units and is much noisier there), so before optimising, each
unit's value is corrected by a reference-batch ComBat harmonisation across size
strata (harmonise_by_size; report §5). Two versions: full (each size stratum's
bias and excess noise removed) and noise-only (only the noise removed; the
systematic size discount may be real value). Units above 240 models
take part and are flagged; both pricing models overprice them by ~25–70%
(PRICING_MODEL_REPORT.md §5).

**Not checked:** a ToW army's roll. Its units come from several source corps on
a rotation, so a build may need a specific time window (the app's "Generate
times" finds it).

Inputs: committed outputs, analysis/commander_model_coefficients.csv, the
class_structure checkpoints. Outputs: analysis/output/cost_effective_builds.md
and cost_effective_builds.csv (full size harmonisation), and the same with the
suffix _noise_only (noise-only harmonisation).

    python analysis/cost_effective_builds.py                  # the game's 31 cards
    python analysis/cost_effective_builds.py --max-cards 20   # a micro cap: ≤ 20 cards with the staff general
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp

sys.path.insert(0, str(Path(__file__).resolve().parent))
import checkpoints as ckpt  # noqa: E402
import common  # noqa: E402
import unit_pricing as up  # noqa: E402
from pricing.final import FINAL  # noqa: E402
from class_structure import segmented, with_class_p  # noqa: E402
from commander_model import Pairs, design as commander_design  # noqa: E402

OUT = common.OUTPUT
BUDGET, MAX_CARDS, MAX_FOOT_ART, MAX_HEAVY_CAV = 10_000, 31, 2, 10
MAX_UNITS = MAX_CARDS - 1          # the staff general takes one of the 31 cards (as the app counts)
MAX_ROLL_CORPS = 4                 # NTW3AC.ToWFarmycorps: max_ac = 4


def source_corps(unit_key: str) -> str | None:
    """A ToW card's source corps (web/src/domain/tow.ts towSourceCorpsIdOf); None for Custom armies."""
    return unit_key.split("_")[3] if "_tow_" in unit_key else None
BIG_UNIT_MODELS = 240
NORM_FACTION = "__reference__"

# Command correction for builds 1, 2 and 4 (hand-set, October 2026). The price rule T3 charges
# a staff general for his stars only, but the user's game experience is that command stars
# matter more in a large, low-morale army (more units close to routing, more models to rally),
# and that a C-class (cavalry-speed) general is worth more than a standard one of the same
# stars: he reaches more of the line, and some have a fighting bodyguard. Neither is priced:
# C-class generals cost what T3 predicts from their stars (ratio 0.93–1.00). So it is set by hand:
#
#   general value = (T3(stars) + λ·stars·D) · (1 + σ·[C class]) + melee bodyguard bonus,
#   D = Σ over the build's units of models · (M_REF − morale)₊     (the morale deficit)
#
# Calibration anchors, given by the user: in [1806] 10. Preußen the 2★ general (Kalckreuth)
# must be better value per gold than any unit in his build, and in [1815] 6. Napoli the
# optimiser must almost always take Murat (5★, C4). `python analysis/cost_effective_builds.py
# --calibrate` finds, per valuation, the smallest λ for the first and checks the second, which
# that λ already meets; λ is that minimum rounded up to the next 0.0005 for margin. The anchor
# depends on the unit values (Kalckreuth must beat the army's best unit per gold), hence one λ
# per size version (COMMAND_LAMBDA). σ is only a nudge, as the user asked: at
# equal stars (equal price within an army) take the C-class general — C1, C2 and C4 included,
# which have no combat stats. Trading stars for speed is left for later; σ may need adjusting.
# The melee bonus is not hand-set: it is the cavalry model's price for a 16-model bodyguard with
# the C3 combat stats minus with the standard general's (bodyguard_melee_bonus).
M_REF = 10.0              # user's choice: just above the typical build's men-weighted morale (7.8)
COMMAND_LAMBDA = {        # gold per star per unit of D, per size version (calibrated minimum, see above)
    "full": 0.0045,       # 0.00439
    "noise": 0.0035,      # 0.00302
    "off": 0.0025,        # 0.00229, unharmonised values
}
SPEED_BONUS = 0.02        # σ: a 2% nudge for C-class speed (may need further adjustment)
STANDARD_GENERAL_MELEE = 3.0   # every L1 staff general: melee attack 3, defence 9, charge 0, morale 12
CALIBRATION_ARMIES = {"lambda": ("ntw3_tow_b06_x8_009", "ntw3_gen_staff_036_2_0069_tow_009"),   # Kalckreuth
                      "speed": ("ntw3_tow_c14_x8_030", "ntw3_gen_staff_158_5_0519_tow_030")}    # Murat


@dataclass(frozen=True)
class Command:
    """The command correction's parameters (see above)."""
    lam: float
    speed: float
    melee: float
    m_ref: float = M_REF

    def deficit(self, card: dict) -> float:
        """A card's contribution to the morale deficit D: models × morale points below m_ref."""
        return card["models"] * max(0.0, self.m_ref - card["morale"])

    def slope(self, g: dict) -> float:
        """Gold the general gains per unit of D."""
        return self.lam * g["stars"] * (1.0 + self.speed * g["fast"])

    def constant(self, g: dict) -> float:
        """The general's value at D = 0."""
        return g["value"] * (1.0 + self.speed * g["fast"]) + self.melee * g["melee"]

    def value(self, g: dict, chosen: list[tuple[dict, int]]) -> float:
        return self.constant(g) + self.slope(g) * sum(self.deficit(c) * k for c, k in chosen)


def staff_value_rule() -> tuple[float, float]:
    """(b, q) of the global staff-general rule T3 (analysis/output/coefficients.csv)."""
    with open(OUT / "coefficients.csv", encoding="utf-8") as fh:
        t3 = {r["feature"].split(" ")[0]: float(r["coefficient"]) for r in csv.DictReader(fh)
              if r["model"] == "staff" and r["slice"] == "merged" and r["variant"] == "T3"}
    return t3["b"], t3["q"]


def staff_value(stars: int, b: float, q: float) -> float:
    """Normative value of a staff general at corps 8: b·stars^q, 1 gold without stars."""
    return b * stars ** q if stars > 0 else 1.0


def normative_values(units: list[up.Unit]) -> dict[tuple[str, str], float]:
    """V4's price for each regular unit at corps 8, coalition side, no army × class cell."""
    out = {}
    for arm in ("infantry", "cavalry", "artillery"):
        arm_units = up.slice_units(units, arm, "merged")
        kappa = common.load_pickle(ckpt.tow_kappa_path(arm))
        run, p_of = common.load_pickle(ckpt.tow_v4_path(arm))
        spec = up.joint_fclass_spec(FINAL[arm], kappa)
        d3 = segmented(up.design_for(spec, arm_units, arm), arm_units)
        norm = [replace(u, rating=up.REF_RATING, side="coalition", faction=NORM_FACTION) for u in arm_units]
        data = with_class_p(up.data_for(spec, norm), norm, spec, p_of)
        values = up.predict_total(run.full, d3, data, np.arange(len(norm)))
        out.update({(u.faction, u.key): float(v) for u, v in zip(arm_units, values)})
    return out


# Size harmonisation (October 2026). V4's out-of-fold errors are U-shaped in unit size within
# every infantry class: it overprices small (60–80 models, ×1.19 for line) and large units
# (200–240, ×1.34; >240, ×1.31) and underprices the mid-sized bulk (100–120, ×0.97), because one
# size power per class cannot follow the game's price curve and the fit is anchored on the
# ~2 600 mid-sized units. It is also noisier at the extremes (80% range 0.95–1.56 at 200–240
# vs 0.91–1.01 at 100–120). Unharmonised, the optimiser read that misfit as bargains and almost
# never picked mid-sized infantry. A spline refit would absorb the size effect entirely; the
# user wants to still see whether extreme sizes are better value, so instead the errors are
# harmonised across size strata as batch effects, ComBat-style (Johnson, Li & Rabinovic 2007,
# reference-batch variant): each stratum's mean error (bias) and spread (reliability) are
# estimated with empirical-Bayes shrinkage and mapped onto the arm's mid-sized bulk, keeping
# every unit's order within its stratum on the model error. The removed per-stratum effects are
# reported (cost_effective_builds.md §5). Applied to the whole size range, units
# above 240 models included (user's choice). Cavalry and artillery barely move: their errors
# show no size pattern.
#
# Two versions are produced (user's choice, October 2026), because the systematic size discount
# that full harmonisation removes may be real battle value rather than model error.
# - "full": remove each stratum's bias and its excess noise → cost_effective_builds.md/.csv;
# - "noise": remove only the excess noise (the fake bargains of an unreliable stratum) and keep
#   each stratum's systematic discount → cost_effective_builds_noise_only.md/.csv.
# ("bias", removing the bias only, is used just to split the replay check.)
SIZE_HARMONISATION = True                          # False: one unharmonised version ("off"), as before
SIZE_VERSIONS = {"full": "", "noise": "_noise_only"}   # mode → output-name suffix
SIZE_LABEL = {"full": "full harmonisation", "noise": "noise-only harmonisation", "off": "no harmonisation"}
SIZE_STRATA = {"infantry": (40, 60, 80, 100, 120, 160, 200, 240),     # stratum edges, in models
               "cavalry": (40, 60, 80, 100, 120, 160, 200, 240),
               "artillery": (2, 3, 4, 5)}                            # in guns, V4's size for artillery
MIN_STRATUM = 5           # smaller strata merge into their neighbour toward the middle


def harmonise_by_size(units: list[up.Unit], value: dict[tuple[str, str], float],
                      table: list[dict] | None = None, mode: str = "full",
                      oof: dict[tuple[str, str], tuple[float, float, float]] | None = None
                      ) -> dict[tuple[str, str], float]:
    """Normative values with V4's size-stratum bias and excess noise removed (see above).

    Per arm, r = log(true price ÷ V4 out-of-fold prediction) (price_database.csv) is standardised
    as Z = (r − α)/σ, with α the arm's mean and σ its pooled within-stratum SD. In each stratum b,
    the mean γ_b and variance δ²_b of Z get ComBat's priors (normal for γ, inverse gamma for δ²,
    by moments across the arm's strata) and posterior estimates γ*_b, δ*_b.

    Reference-batch ComBat (Zhang, Jenkins & Johnson 2018): every stratum is mapped onto the arm's
    largest stratum R — the mid-sized bulk the model is fitted to — which itself stays exactly as
    the model values it: r* = α + σ·(γ*_R + (Z − γ*_b)·δ*_R/δ*_b), value* = value · exp(r − r*).
    A stratum the model overprices loses that bias, and a noisy stratum's deviations shrink to the
    bulk's size. (Plain ComBat would rescale to the pooled SD, which the noisy extremes inflate,
    and so would *expand* the reliable mid-sized strata's deviations ~1.7×, inventing bargains.)
    Within a stratum r* is increasing in r, so units keep their order on the residual. Units
    without a usable out-of-fold prediction (10 missing, 3 single-gun batteries predicted ≤ 0)
    keep their value. If `table` is given, one row per stratum is appended to it for the report.

    `mode` picks what is removed: "full" (bias and excess noise, the formula above), "noise"
    (spread only: r* = α + σ·(γ*_b + (Z − γ*_b)·δ*_R/δ*_b), keeping the stratum's own shrunk
    mean) or "bias" (location only: r* = α + σ·(γ*_R + Z − γ*_b)).

    `oof` = {(faction, unit): (size, true price, out-of-fold prediction)} replaces the ToW
    price database as the error source — analysis/team_values.py passes AC's own V4 errors."""
    if mode not in ("full", "noise", "bias"):
        raise ValueError(f"unknown harmonisation mode {mode!r}")
    if oof is None:
        oof = {}
        with open(OUT / "price_database.csv", encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                if r["kind"] == "regular" and r["pred_v4"] not in ("", "nan") and float(r["pred_v4"]) > 0:
                    oof[(r["faction_key"], r["unit_key"])] = (float(r["size"]), float(r["true_price"]),
                                                              float(r["pred_v4"]))
    out = dict(value)
    for arm, edges in SIZE_STRATA.items():
        rows = [(u, oof[(u.faction, u.key)]) for u in units if u.arm == arm and (u.faction, u.key) in oof]
        size = np.array([s for _, (s, _, _) in rows])
        r = np.log(np.array([t / p for _, (_, t, p) in rows]))
        stratum = np.searchsorted(np.array(edges, dtype=float), size, side="right")
        stratum = _merge_small_strata(stratum)
        ids = sorted(set(stratum.tolist()))
        alpha = float(r.mean())
        gamma_hat = {b: float((r[stratum == b] - alpha).mean()) for b in ids}
        sigma = float(np.sqrt(np.mean([(x - alpha - gamma_hat[b]) ** 2 for x, b in zip(r, stratum)])))
        z = (r - alpha) / sigma
        n = {b: int((stratum == b).sum()) for b in ids}
        g = np.array([z[stratum == b].mean() for b in ids])
        d2 = np.array([z[stratum == b].var(ddof=1) for b in ids])
        g_bar, tau2 = float(g.mean()), float(g.var(ddof=1))
        m, s2 = float(d2.mean()), float(d2.var(ddof=1))
        a_prior, b_prior = (2 * s2 + m * m) / s2, (m * s2 + m ** 3) / s2
        g_star, d2_star = {}, {}
        for i, b in enumerate(ids):
            zb, gs, ds = z[stratum == b], g[i], d2[i]
            for _ in range(1000):
                gs_new = (n[b] * tau2 * g[i] + ds * g_bar) / (n[b] * tau2 + ds)
                ds_new = (b_prior + 0.5 * float(((zb - gs_new) ** 2).sum())) / (n[b] / 2 + a_prior - 1)
                done = abs(gs_new - gs) < 1e-10 and abs(ds_new - ds) < 1e-10
                gs, ds = gs_new, ds_new
                if done:
                    break
            g_star[b], d2_star[b] = gs, ds
        ref = max(ids, key=lambda b: n[b])
        location = {b: g_star[b] if mode == "noise" else g_star[ref] for b in ids}
        scale = {b: 1.0 if mode == "bias" else float(np.sqrt(d2_star[ref] / d2_star[b])) for b in ids}
        r_star = np.array([alpha + sigma * (location[b] + (zi - g_star[b]) * scale[b]) for zi, b in zip(z, stratum)])
        factor = np.exp(r - r_star)
        for (u, _), f in zip(rows, factor):
            out[(u.faction, u.key)] = value[(u.faction, u.key)] * float(f)
        if table is not None:
            for b in ids:
                members = np.flatnonzero(stratum == b)
                table.append({"arm": arm, "sizes": f"{size[members].min():g}–{size[members].max():g}", "n": n[b],
                              "reference": b == ref, "side": (b > ref) - (b < ref),
                              "raw_ratio": float(np.median(np.exp(-r[members]))),     # model ÷ true, raw
                              "bias": float(np.exp(-sigma * (g_star[b] - g_star[ref]))),  # removed, vs the reference
                              "spread": float(np.sqrt(d2_star[b] / d2_star[ref])),   # error SD ÷ the reference's
                              "factor": float(np.median(factor[members])),
                              "keys": {(rows[j][0].faction, rows[j][0].key) for j in members}})
    return out


def _merge_small_strata(stratum: np.ndarray) -> np.ndarray:
    """Relabel strata with fewer than MIN_STRATUM units into the neighbour toward the middle."""
    stratum = stratum.copy()
    while True:
        ids = sorted(set(stratum.tolist()))
        counts = {b: int((stratum == b).sum()) for b in ids}
        small = [b for b in ids if counts[b] < MIN_STRATUM]
        if not small or len(ids) == 1:
            return stratum
        b = small[0]
        k = ids.index(b)
        middle = len(ids) / 2
        target = ids[k + 1] if (k < middle and k + 1 < len(ids)) or k == 0 else ids[k - 1]
        stratum[stratum == b] = target


def bodyguard_melee_bonus() -> float:
    """What V4 charges for the C3 combat generals' bodyguard stats (melee attack 14, defence 28,
    charge 4, morale 18) over a standard general's (3, 9, 0, 12), at corps 8, coalition.

    The bodyguard is priced as a 16-model C3 cavalry unit: the general's own row supplies every
    stat the model reads, and a C3 unit of the class supplies class and tags. It is priced once as
    light and once as standard cavalry (the classes such generals' armies field), and the mean is
    used; the two differ by ~60 gold, which the report states. A single replaced row barely moves
    the design's centring, so this is the model's marginal price for those stats."""
    with up.DATA_CSV.open(encoding="utf-8-sig", newline="") as fh:
        gen = next(r for r in csv.DictReader(fh) if r["unit_key"].startswith("ntw3_gen_staff")
                   and up.num(r["melee_attack"]) > STANDARD_GENERAL_MELEE)
    arm = "cavalry"
    arm_units = up.slice_units(up.load(up.load_ratings())[0], arm, "merged")
    kappa = common.load_pickle(ckpt.tow_kappa_path(arm))
    run, p_of = common.load_pickle(ckpt.tow_v4_path(arm))
    spec = up.joint_fclass_spec(FINAL[arm], kappa)
    diffs = []
    for cls in ("cavalry_light", "cavalry_standard"):
        i = next(j for j, u in enumerate(arm_units) if u.unit_class == cls and u.speed == "C3")
        def stat(c: str, v: float) -> float:            # the general's own value where his row has one
            raw = gen.get(c, "")
            if raw in ("true", "false"):
                return 1.0 if raw == "true" else 0.0
            return up.num(raw) if raw else v
        base = {c: stat(c, v) for c, v in arm_units[i].values.items()}
        prices = []
        for ma, md, ch, mor in ((14, 28, 4, 18), (STANDARD_GENERAL_MELEE, 9, 0, 12)):
            us = list(arm_units)
            us[i] = replace(arm_units[i], key="__bodyguard__", n=16.0,
                            values=dict(base, melee_attack=ma, melee_defense=md, charge_bonus=ch, morale=mor))
            d3 = segmented(up.design_for(spec, us, arm), us)
            norm = [replace(u, rating=up.REF_RATING, side="coalition", faction=NORM_FACTION) for u in us]
            data = with_class_p(up.data_for(spec, norm), norm, spec, p_of)
            prices.append(float(up.predict_total(run.full, d3, data, np.array([i]))[0]))
        diffs.append(prices[0] - prices[1])
    return float(np.mean(diffs))


def commander_values(base_value: dict[tuple[str, str], float]) -> tuple[Pairs, np.ndarray]:
    """Commander model (given the true regular price) at the unit's normative value, corps 8, coalition."""
    c = Pairs()
    with open(OUT / "commander_model_coefficients.csv", encoding="utf-8") as fh:
        coef = {r["term"]: float(r["coefficient"]) for r in csv.DictReader(fh) if r["model"] == "given true P"}
    P = np.array([base_value[(r["faction_key"], r["regular_unit_key"])] for r in c.rows])
    c.corps = np.full(c.n, float(up.REF_RATING))
    c.imperial = np.zeros(c.n)
    X, names = commander_design(c, P)
    return c, np.maximum(1.0, X @ np.array([coef[n] for n in names]))


def load_cards(started: float | None = None, size_table: list[dict] | None = None, size_mode: str = "full"):
    """Every recruitable card of every ToW / Custom army with its normative value.

    Returns (by_faction, staff_of, top_star, army_of):
    - by_faction[f]: unit and commander cards (dicts with key, base, name, cls, arm, cost, value,
      value_raw, value_debiased, value_full, size_side, models, men, morale, cap, corps, kind).
      `value` is size-harmonised in `size_mode` ("full" or "noise"; none if SIZE_HARMONISATION is
      off), a commander's through its regular unit's. `value_raw` is unharmonised;
      `value_debiased` has only the stratum bias removed and `value_full` both bias and noise
      (for the replay check's decomposition); `size_side` is −1 / 0 / +1 for a unit (or a
      commander's unit) in a stratum below / at / above the reference;
    - staff_of[f]: the army's staff generals (key, name, cost, stars, corps, value = T3, fast =
      1 for a C-class speed tag, melee = 1 for a bodyguard with combat stats);
    - top_star[f]: its highest-star staff general (cheapest on a tie);
    - army_of[f]: (army_corps_name, corps number, side).
    Shared by this script and experiments/ (analysis branch) two_compartment.py."""
    started = time.time() if started is None else started
    units, staff, _, _ = up.load(up.load_ratings())
    caps, morale, fast, melee = {}, {}, {}, {}
    with up.DATA_CSV.open(encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            k = (r["faction_key"], r["unit_key"])
            caps[k] = int(up.num(r["unit_cap"]))
            morale[k] = up.num(r["morale"])
            fast[k] = int(r["speed_code"].startswith("C"))
            melee[k] = int(up.num(r["melee_attack"]) > STANDARD_GENERAL_MELEE)
    raw = normative_values(units)
    side: dict[tuple[str, str], int] = {}
    if SIZE_HARMONISATION:
        strata: list[dict] = []
        value = harmonise_by_size(units, raw, strata, size_mode)
        debiased = harmonise_by_size(units, raw, mode="bias")
        full = value if size_mode == "full" else harmonise_by_size(units, raw, mode="full")
        side = {k: t["side"] for t in strata for k in t["keys"]}
        if size_table is not None:
            size_table += strata
    else:
        value = debiased = full = raw
    pairs, cmd_value = commander_values(value)
    cmd = {name: commander_values(v)[1] for name, v in (("raw", raw), ("debiased", debiased), ("full", full))}
    up.log(f"normative values: {len(value)} regular units, {pairs.n} commanders"
           f"{f', size-harmonised ({size_mode})' if SIZE_HARMONISATION else ''}", started)

    by_faction: dict[str, list[dict]] = defaultdict(list)
    for u in units:
        k = (u.faction, u.key)
        by_faction[u.faction].append({"kind": "unit", "key": u.key, "base": u.key, "name": u.name, "cls": u.unit_class,
                                      "arm": u.arm, "cost": u.cost, "value": value[k], "value_raw": raw[k],
                                      "value_debiased": debiased[k], "value_full": full[k], "size_side": side.get(k, 0),
                                      "models": u.n, "men": 2 * u.n, "morale": morale[(u.faction, u.key)],
                                      "cap": caps[(u.faction, u.key)], "corps": source_corps(u.key)})
    for i, r in enumerate(pairs.rows):
        by_faction[r["faction_key"]].append({"kind": "commander", "key": r["commander_unit_key"], "base": r["regular_unit_key"],
                                             "name": r["commander_name"], "cls": r["unit_class"], "arm": r["arm"],
                                             "cost": float(r["commander_price"]), "value": float(cmd_value[i]),
                                             "value_raw": float(cmd["raw"][i]),
                                             "value_debiased": float(cmd["debiased"][i]),
                                             "value_full": float(cmd["full"][i]),
                                             "size_side": side.get((r["faction_key"], r["regular_unit_key"]), 0),
                                             "models": float(r["commander_men"]) / 2, "men": float(r["commander_men"]),
                                             "morale": morale[(r["faction_key"], r["commander_unit_key"])],
                                             "cap": caps[(r["faction_key"], r["regular_unit_key"])],
                                             "corps": source_corps(r["regular_unit_key"])})
    b_staff, q_staff = staff_value_rule()
    staff_of: dict[str, list[dict]] = defaultdict(list)
    for g in staff:
        staff_of[g.faction].append({"key": g.key, "name": g.name, "cost": g.cost, "stars": g.stars,
                                    "corps": source_corps(g.key), "value": staff_value(g.stars, b_staff, q_staff),
                                    "fast": fast[(g.faction, g.key)], "melee": melee[(g.faction, g.key)]})
    top_star = {f: min(gs, key=lambda g: (-g["stars"], g["cost"], g["key"])) for f, gs in staff_of.items()}
    army_of = {u.faction: (u.corps, u.rating, u.side) for u in units}
    return by_faction, staff_of, top_star, army_of


VARIANTS = ("max value", "balanced", "runner-up", "top staff", "four corps")


def army_builds(cards: list[dict], staff: list[dict], top: dict, command: Command | None,
                variants: tuple[str, ...] = VARIANTS, max_cards: int = MAX_CARDS):
    """Yield (variant, chosen, general) for one army.

    - runner-up: the best max-value build other than the best one — at least one copy fewer
      among the best build's cards, so it differs in at least one unit;
    - top staff: the max-value build with the army's highest-star staff general, valued by T3
      (no command correction: the user asked for it in builds 1, 2 and 4 only);
    - four corps: units from at most 4 source corps.
    Elsewhere the staff general is valued by `command` and chosen jointly with the units."""
    cavalry_only = not any(c["arm"] == "infantry" for c in cards)
    best_counts = None
    for variant in variants:
        options = [top] if variant == "top staff" else staff
        sol = solve(cards, options, cavalry_only, "max value" if variant in ("top staff", "four corps") else variant,
                    exclude=best_counts if variant == "runner-up" else None,
                    max_corps=MAX_ROLL_CORPS if variant == "four corps" else None, score_staff=True,
                    command=None if variant == "top staff" else command, max_cards=max_cards)
        if sol is None:
            continue
        chosen, general = sol
        if variant == "max value":
            position = {id(c): j for j, c in enumerate(cards)}
            best_counts = [(position[id(c)], k) for c, k in chosen]
        yield variant, chosen, general


def calibrate(by_faction, staff_of, top_star, melee: float) -> tuple[float, float]:
    """The smallest λ and σ meeting the user's two anchors (bisection; both are monotone in practice).

    λ: in Preußen 10, Kalckreuth's corrected value per gold ≥ every unit's in his max-value build
       (the general forced in, σ irrelevant there: no C-class general in that army).
    σ: given λ, Napoli's optimiser takes Murat in every corrected build (1, 2 and 4); ~0 means λ
       alone already does it, so this anchor does not set σ (SPEED_BONUS is a hand-set nudge)."""
    def bisect(ok, hi: float, steps: int = 30) -> float:
        lo = 0.0
        while not ok(hi):
            lo, hi = hi, hi * 2
        for _ in range(steps):
            mid = (lo + hi) / 2
            lo, hi = (lo, mid) if ok(mid) else (mid, hi)
        return hi

    f, key = CALIBRATION_ARMIES["lambda"]
    kalck = next(g for g in staff_of[f] if g["key"] == key)

    def kalck_ok(lam: float) -> bool:
        chosen, g = solve(by_faction[f], [kalck], False, "max value", score_staff=True,
                          command=Command(lam, 0.0, melee))
        return g["value"] / g["cost"] >= max(c["value"] / c["cost"] for c, _ in chosen)

    lam = bisect(kalck_ok, 0.01)
    f, key = CALIBRATION_ARMIES["speed"]

    def murat_ok(speed: float) -> bool:
        return all(g["key"] == key for v, _, g in army_builds(by_faction[f], staff_of[f], top_star[f],
                                                              Command(lam, speed, melee)) if v != "top staff")

    return lam, bisect(murat_ok, 0.25)


def size_replay_check(by_faction: dict[str, list[dict]], mode: str) -> tuple[list[list[str]], dict]:
    """Do the size effects the harmonisation removes pay off in battle? Ladder replays.

    Per army, paper surplus S = Σ (value − cost) ÷ 1 000 over its unit and commander cards: raw,
    as valued in this version (`mode`), and fully harmonised. What full harmonisation removes,
    S_raw − S_full, is split two ways: into the stratum *bias* part (raw − bias-removed value) and
    the *noise* part (the rest), and into units smaller / larger than the reference stratum.
    Logistic regressions of winning on the fixed time split of the blind study
    (analysis/build_blind/data: armies.csv, split.json), with its controls: the faction's shrunk
    win rate (100 pseudo-games; leave-one-match-out for training armies) and the pre-game expected
    score E recovered from the rating change (K ≈ 24), fitted on rated training armies and held at
    its mean for prediction. If extreme sizes really are better value than their price says, the
    removed parts carry positive coefficients.
    Returns (table rows: model, the S coefficients ± SE, test AUC and log-loss; {term: (β, SE)}
    from the decomposition fits, plus "ll_base", the faction + skill test log-loss)."""
    from sklearn.metrics import log_loss, roc_auc_score
    card = {(f, c["key"]): c for f, cs in by_faction.items() for c in cs}
    data = common.LADDER_REPLAY_DATA
    cut = json.loads((data / "split.json").read_text(encoding="utf-8"))["cut_played_at"]
    with open(data / "armies.csv", encoding="utf-8") as fh:
        armies = [a for a in csv.DictReader(fh) if a["result"] in ("win", "loss")]
    train = [a for a in armies if a["played_at"] < cut]
    wins, games, match_fac = Counter(), Counter(), defaultdict(Counter)
    for a in train:
        games[a["faction_key"]] += 1
        wins[a["faction_key"]] += a["result"] == "win"
        match_fac[a["match_id"]][(a["faction_key"], a["result"] == "win")] += 1
    p_all = sum(wins.values()) / sum(games.values())

    def row(a: dict) -> tuple[list[float], int, bool, bool]:
        f, is_train = a["faction_key"], a["played_at"] < cut
        w, g = wins[f], games[f]
        if is_train:                                    # leave this match out
            g -= sum(k for (ff, _), k in match_fac[a["match_id"]].items() if ff == f)
            w -= match_fac[a["match_id"]][(f, True)]
        p = (w + 100 * p_all) / (g + 100)
        cs = [card[(f, k)] for k in a["unit_keys"].split() if (f, k) in card]
        s = lambda field, keep=lambda c: True: sum(c[field] - c["cost"] for c in cs if keep(c)) / 1000  # noqa: E731
        removed = lambda keep: s("value_raw", keep) - s("value_full", keep)                             # noqa: E731
        y = int(a["result"] == "win")
        rated = a["player_rating_change"] != ""
        e = 0.5
        if rated:
            d = float(a["player_rating_change"]) / 24
            e = min(0.95, max(0.05, 1 - d if y else -d))
        return [np.log(p / (1 - p)), np.log(e / (1 - e)), s("value_raw"), s("value"), s("value_full"),
                s("value_raw") - s("value_debiased"), s("value_debiased") - s("value_full"),
                removed(lambda c: c["size_side"] < 0), removed(lambda c: c["size_side"] > 0)], y, is_train, rated

    rows = [row(a) for a in armies]
    X = np.array([r[0] for r in rows])
    y = np.array([r[1] for r in rows])
    tr = np.array([r[2] and r[3] for r in rows])
    te = np.array([not r[2] for r in rows])

    def fit(cols: list[int]) -> tuple[np.ndarray, np.ndarray]:
        A = np.column_stack([np.ones(tr.sum()), X[tr][:, cols]])
        beta = np.zeros(A.shape[1])
        for _ in range(50):                              # Newton–Raphson, unpenalised
            p = 1 / (1 + np.exp(-A @ beta))
            H = A.T @ (A * (p * (1 - p))[:, None])
            step = np.linalg.solve(H, A.T @ (y[tr] - p))
            beta += step
            if np.abs(step).max() < 1e-10:
                break
        return beta, np.sqrt(np.diag(np.linalg.inv(H)))

    names = {2: "S_raw", 3: f"S ({SIZE_LABEL[mode]})", 4: "S_full", 5: "bias part", 6: "noise part",
             7: "smaller-unit part", 8: "larger-unit part"}
    fits = [("faction + skill", [], None), ("+ raw surplus", [2], None),
            (f"+ surplus as valued here ({SIZE_LABEL[mode]})", [3], None),
            ("+ fully harmonised surplus + removed bias part", [4, 5], "bias"),
            ("+ … + removed bias part + removed noise part", [4, 5, 6], "bias+noise"),
            ("+ fully harmonised surplus + removed part, smaller / larger units", [4, 7, 8], "sides")]
    out, key = [], {"sd_bias": float(X[tr][:, 5].std())}
    for label, extra, tag in fits:
        cols = [0, 1] + extra
        beta, se = fit(cols)
        Xt = X[te][:, cols].copy()
        Xt[:, 1] = X[tr][:, 1].mean()                   # skill held at its training mean
        p = 1 / (1 + np.exp(-(beta[0] + Xt @ beta[1:])))
        ll = log_loss(y[te], p)
        terms = "; ".join(f"{names[c]} {beta[i + 1]:+.3f} ± {se[i + 1]:.3f}" for i, c in enumerate(cols) if c in names)
        out.append([label, terms or "—", f"{roc_auc_score(y[te], p):.4f}", f"{ll:.5f}"])
        if not extra:
            key["ll_base"] = ll
        if tag:
            key[tag] = {names[c]: (float(beta[i + 1]), float(se[i + 1])) for i, c in enumerate(cols) if c >= 5}
            key[f"ll_{tag}"] = ll
    return out, key


def card_cap(text: str) -> int:
    """argparse type for --max-cards: 2 … 31."""
    n = int(text)
    if not 2 <= n <= MAX_CARDS:
        raise argparse.ArgumentTypeError(f"must be 2–{MAX_CARDS} (cards including the staff general)")
    return n


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--max-cards", type=card_cap, default=MAX_CARDS, metavar="N",
                        help=f"cap the build at N cards including the staff general (2–{MAX_CARDS}; default "
                             f"{MAX_CARDS}, the game's limit). Fewer cards = less micro, which prices don't "
                             f"capture. A cap writes its own files, suffixed _max<N>.")
    parser.add_argument("--calibrate", action="store_true",
                        help="print the smallest λ (and σ) meeting the general correction's anchors, per size "
                             "version, at the game's 31 cards, then exit")
    args = parser.parse_args()
    started = time.time()
    melee = bodyguard_melee_bonus()
    up.log(f"bodyguard melee bonus: {melee:.0f} gold", started)
    versions = list(SIZE_VERSIONS.items()) if SIZE_HARMONISATION else [("off", "")]
    cap_suffix = f"_max{args.max_cards}" if args.max_cards < MAX_CARDS else ""
    for mode, suffix in versions:
        if args.calibrate:
            by_faction, staff_of, top_star, _ = load_cards(started, size_mode=mode)
            lam, speed = calibrate(by_faction, staff_of, top_star, melee)
            print(f"[{mode}] COMMAND_LAMBDA ≥ {lam:.6f}   SPEED_BONUS ≥ {speed:.4f}   (M_REF {M_REF}, melee {melee:.0f})")
        else:
            run_version(mode, suffix + cap_suffix, melee, started, args.max_cards)
    return 0


def run_version(mode: str, suffix: str, melee: float, started: float, max_cards: int = MAX_CARDS) -> None:
    """Builds 1–4 for every army on one valuation (`mode`), at most `max_cards` cards including the
    staff general, written to cost_effective_builds{suffix}.*.

    The general correction's λ is the one calibrated at the game's 31 cards: the anchors are a
    property of the valuation, so a micro cap leaves the generals' worth unchanged."""
    size_table: list[dict] = []
    by_faction, staff_of, top_star, army_of = load_cards(started, size_table, mode)
    command = Command(COMMAND_LAMBDA[mode], SPEED_BONUS, melee)
    value = None                                   # kept for write_outputs' signature
    results, big_units = [], []
    raw_picks: Counter = Counter()                 # max-value builds on unharmonised values, for §5
    for faction, cards in sorted(by_faction.items(), key=lambda t: army_of[t[0]]):
        big_units += [(army_of[faction][0], c) for c in cards if c["kind"] == "unit" and c["models"] > BIG_UNIT_MODELS]
        if SIZE_HARMONISATION:
            raw_cards = [dict(c, value=c["value_raw"]) for c in cards]
            for _, chosen, _ in army_builds(raw_cards, staff_of[faction], top_star[faction], command, ("max value",),
                                            max_cards):
                raw_picks.update({(faction, c["base"]): k for c, k in chosen})
        for variant, chosen, general in army_builds(cards, staff_of[faction], top_star[faction], command,
                                                    max_cards=max_cards):
            cost = sum(c["cost"] * k for c, k in chosen) + general["cost"]
            val = sum(c["value"] * k for c, k in chosen) + general["value"]
            arms = Counter()
            for c, k in chosen:
                arms[c["arm"]] += k
            results.append({"faction": faction, "army": army_of[faction][0], "N": army_of[faction][1],
                            "side": army_of[faction][2], "variant": variant, "cost": cost, "value": val,
                            "efficiency": val / cost, "cards": sum(k for _, k in chosen),
                            "arms": arms, "men": sum(c["men"] * k for c, k in chosen), "chosen": chosen,
                            "staff": general,
                            "corps": sorted({c["corps"] for c, _ in chosen if c["corps"]} | ({general["corps"]} - {None})),
                            "slot": f"{general['name']} ({general['cost']} gold, {general['stars']}★)"})
        up.log(f"{army_of[faction][0][:40]:40} done", started)

    replay = ([], {})
    if SIZE_HARMONISATION and common.LADDER_REPLAY_DATA.exists():
        replay = size_replay_check(by_faction, mode)
    elif SIZE_HARMONISATION:
        up.log(f"replay cross-check skipped: {common.LADDER_REPLAY_DATA} not present (optional)", started)
    write_outputs(results, big_units, value, by_faction, started, command, max_cards=max_cards,
                  size=(size_table, raw_picks, replay), mode=mode, suffix=suffix)


def solve(cards: list[dict], staff_options: list[dict], cavalry_only: bool, variant: str,
          exclude: list[tuple[int, int]] | None = None, max_corps: int | None = None, *,
          score_key: str = "value", score_staff: bool = False, n_cards: int | None = None,
          min_spend: float = 0.0, command: Command | None = None, max_cards: int = MAX_CARDS):
    """MILP: integer copies of each regular card, 0/1 per commander card, 0/1 per staff-general
    option (exactly one is taken), and with `max_corps` a 0/1 per source corps (at most that
    many used; every taken card and the staff general must come from a used corps).
    `max_cards` caps the cards *including* the staff general, as the game counts its 31 (the
    user's micro cap, see MAX_CARDS_ARG); the default is the game's own limit.
    `exclude` = (card index, copies) of a build to rule out: at least one copy fewer among its cards.
    Maximises Σ card[score_key] (plus the staff general's own score_key when `score_staff`);
    `n_cards` fixes the number of cards including the staff general; `min_spend` puts a floor
    under the total cost (experiments/ (analysis branch) two_compartment.py uses both).
    `command` values the staff general by the command correction instead (Command.value), which
    depends on the build's morale deficit D: per staff option a continuous w ≤ D and w ≤ D_max·z
    carries D into the objective only for the general taken (exact, since w is maximised).
    Returns (chosen cards with copies, the staff general) or None; with `command` the returned
    general is a copy whose "value" is his corrected value in this build ("t3" keeps T3)."""
    n, m = len(cards), len(staff_options)
    corps = sorted({c["corps"] for c in cards if c["corps"]} | {g["corps"] for g in staff_options if g["corps"]}) \
        if max_corps else []
    if not 2 <= max_cards <= MAX_CARDS:
        raise ValueError(f"max_cards must be 2…{MAX_CARDS} (the staff general and at least one unit)")
    max_units = max_cards - 1                       # the staff general takes one card
    n_w = m if command else 0
    nv = n + m + len(corps) + n_w
    ub = np.array([float(min(c["cap"] if c["cap"] > 0 else max_units, max_units)) if c["kind"] == "unit" else 1.0
                   for c in cards] + [1.0] * (m + len(corps)))
    deficit = np.array([command.deficit(c) for c in cards]) if command else np.zeros(n)
    d_max = float(np.sort(deficit * ub[:n])[-max_units:].sum()) if command else 0.0   # D of ≤ max_units units
    staff_score = [-(command.constant(g) if command else g[score_key] if score_staff else 0.0) + 1e-6 * g["cost"]
                   for g in staff_options]
    c_obj = np.array([-c[score_key] + 1e-6 * c["cost"] for c in cards] + staff_score + [0.0] * len(corps)
                     + ([-command.slope(g) for g in staff_options] if command else []))
    ub = np.concatenate([ub, np.full(n_w, d_max)])
    integrality = np.concatenate([np.ones(nv - n_w), np.zeros(n_w)])
    rows, lo, hi = [], [], []

    def add(coeffs: dict[int, float], low: float, high: float) -> None:
        row = np.zeros(nv)
        for j, v in coeffs.items():
            row[j] = v
        rows.append(row)
        lo.append(low)
        hi.append(high)

    staff = range(n, n + m)
    cmd = [j for j, c in enumerate(cards) if c["kind"] == "commander"]
    add({**{j: c["cost"] for j, c in enumerate(cards)}, **{n + i: g["cost"] for i, g in enumerate(staff_options)}},
        min_spend, BUDGET)
    add({j: 1.0 for j in range(n)}, 0, max_units)          # units + the staff general ≤ max_cards (game: 31)
    add({j: 1.0 for j in staff}, 1, 1)                      # exactly one staff general
    if n_cards is not None:
        add({j: 1.0 for j in range(n)}, n_cards - 1, n_cards - 1)   # exactly n_cards with the staff general
    if corps:
        col = {cid: n + m + i for i, cid in enumerate(corps)}
        add({col[cid]: 1.0 for cid in corps}, 0, max_corps)  # at most max_corps source corps
        for j, c in enumerate(cards):
            if c["corps"]:
                add({j: 1.0, col[c["corps"]]: -ub[j]}, -np.inf, 0)   # a card only from a used corps
        for i, g in enumerate(staff_options):
            if g["corps"]:
                add({n + i: 1.0, col[g["corps"]]: -1.0}, -np.inf, 0)
    if cmd:
        add({j: 1.0 for j in cmd}, 0, 1)                    # at most one combat general among the units
    for cls, cap in (("artillery_foot", MAX_FOOT_ART), ("artillery_horse", 2 if cavalry_only else 1), ("cavalry_heavy", MAX_HEAVY_CAV)):
        idx = [j for j, c in enumerate(cards) if c["cls"] == cls]
        if idx:
            add({j: 1.0 for j in idx}, 0, cap)
    groups: dict[str, list[int]] = defaultdict(list)
    for j, c in enumerate(cards):
        groups[c["base"]].append(j)
    for base, idx in groups.items():
        cap = cards[idx[0]]["cap"]
        if cap > 0 and len(idx) > 1:
            add({j: 1.0 for j in idx}, 0, cap)
        g_cmd = [j for j in idx if cards[j]["kind"] == "commander"]
        if len(g_cmd) > 1:
            add({j: 1.0 for j in g_cmd}, 0, 1)        # one general per unit
    if variant == "balanced":
        for arm, minimum in (("cavalry", 4), ("artillery", 2)):
            idx = [j for j, c in enumerate(cards) if c["arm"] == arm]
            if idx:
                add({j: 1.0 for j in idx}, min(minimum, sum(ub[j] for j in idx)), MAX_CARDS)
    if exclude:
        add({j: 1.0 for j, _ in exclude}, 0, sum(k for _, k in exclude) - 1)
    w0 = n + m + len(corps)
    for i in range(n_w):
        add({w0 + i: 1.0, **{j: -deficit[j] for j in range(n) if deficit[j] > 0}}, -np.inf, 0)   # w ≤ D
        add({w0 + i: 1.0, n + i: -d_max}, -np.inf, 0)                                             # w ≤ D_max·z
    res = milp(c_obj, constraints=LinearConstraint(np.array(rows), lo, hi), integrality=integrality,
               bounds=Bounds(np.zeros(nv), ub), options={"time_limit": 60})
    if res.x is None:
        return None
    x = np.round(res.x[:w0]).astype(int)
    chosen = [(cards[j], int(x[j])) for j in range(n) if x[j] > 0]
    general = next(staff_options[i] for i in range(m) if x[n + i])
    if command:
        general = {**general, "t3": general["value"], "value": command.value(general, chosen),
                   "deficit": sum(command.deficit(c) * k for c, k in chosen)}
    return sorted(chosen, key=lambda t: -t[0]["value"] * t[1]), general


def command_section(results, command: Command) -> list[str]:
    """§4 of the report: the staff-general command correction and what it picks."""
    corrected = [r for r in results if r["variant"] != "top staff"]
    deficits = np.array([r["staff"]["deficit"] for r in corrected])
    p10, p50, p90 = np.percentile(deficits, [10, 50, 90])
    L = ["", "## 4. Staff general: the command correction (hand-set)", "",
         "The price rule charges a staff general for his stars only. In builds 1, 2 and 4 (*max value*, *balanced* / "
         "*runner-up*, *four corps*) his value is raised by two things the price rule ignores:", "",
         f"**value = (T3(stars) + λ · stars · D) × (1 + σ · [C class]) + melee bonus**, with "
         f"**D = Σ models × ({command.m_ref:g} − morale)₊** over the build's units (commander cards included).", "",
         f"- **λ = {command.lam:g} gold per star per unit of D.** This is a judgement call, not an estimate. The user's "
         "experience is that command stars hold a large, low-morale army together.",
         "  - **Calibration:** in *[1806] 10. Preußen* the 2★ Kalckreuth must be better value per gold than every "
         "unit in his build. λ is the smallest value that achieves this on this version's unit values (§5), "
         "rounded up to the next 0.0005 for margin. The bar moves with the unit values, so each size version has "
         "its own λ.",
         "  - **Check:** at that λ, *[1815] 6. Napoli* takes Murat (5★) in every corrected build, as the user expects.",
         f"  - **Size:** D across these builds is {p10:,.0f} / {p50:,.0f} / {p90:,.0f} (10th / 50th / 90th "
         f"percentile), so a star gains {command.lam * p10:.0f} / {command.lam * p50:.0f} / "
         f"{command.lam * p90:.0f} gold. For scale, T3 is 77 gold for 1★, 717 for 5★ and 1 623 for 9★.",
         f"- **σ = {command.speed:g}, a nudge for C-class generals (speed tags C1–C5).** They move at cavalry speed "
         "and reach more of the line, but cost exactly what T3 charges for their stars. σ only makes the optimiser "
         "prefer a C-class general when the stars are equal. Trading stars for speed is not modelled yet.",
         "  - **σ may need further adjustment.** It is a placeholder, not a calibrated value.",
         f"- **Melee bonus = {command.melee:.0f} gold**, for the 13 C3 generals whose bodyguard fights (melee "
         "14 / 28, charge 4, morale 18; Mamluk, Ottoman and Persian armies). This is not hand-set: it is what the "
         "cavalry model V4 charges for those stats over a standard general's (3 / 9 / 0 / 12), on a 16-model C3 "
         "unit. Priced as light cavalry it is ≈ 174 gold, as standard cavalry ≈ 114; the mean is used.", "",
         "Because D rewards low-morale mass, the correction also tilts the *units* toward large, shaky ones whenever "
         "a starred general is in the build.", "",
         "**Staff general per army** (*max value* build; ⚡ = C class):", ""]
    rows = []
    for r in sorted((r for r in corrected if r["variant"] == "max value"), key=lambda r: r["army"]):
        g = r["staff"]
        four = next((x["staff"] for x in corrected if x["faction"] == r["faction"] and x["variant"] == "four corps"), None)
        rows.append([r["army"], f"{g['name']}{' ⚡' if g['fast'] else ''}", g["stars"], g["cost"], f"{g['t3']:.0f}",
                     f"{g['value']:.0f}", f"{g['deficit']:,.0f}",
                     "same" if four is None or four["key"] == g["key"] else f"{four['name']} ({four['stars']}★)"])
    L += up.table(["army", "staff general", "★", "cost", "T3", "corrected value", "D", "four corps"], rows)
    return L


def size_section(results, size, mode: str, cap: str = "") -> list[str]:
    """§5 of the report: what the size harmonisation removed, what it changed, and the replay check."""
    table, raw_picks, (replay, key) = size
    if not table:
        return []
    picks: Counter = Counter()
    for r in results:
        if r["variant"] == "max value":
            picks.update({(r["faction"], c["base"]): k for c, k in r["chosen"]})
    other = {"full": ("noise-only", f"cost_effective_builds_noise_only{cap}.md"),
             "noise": ("full harmonisation", f"cost_effective_builds{cap}.md")}[mode]
    what = {"full": "Both are removed in this version: each stratum's bias, and its deviations scaled to the "
                    "reference's spread.",
            "noise": "Only the noise is removed in this version: each stratum keeps its own (shrunk) mean error, the "
                     "systematic size discount, and only its deviations are scaled to the reference's spread."}[mode]
    L = ["", f"## 5. Size harmonisation of normative value ({SIZE_LABEL[mode]})", "",
         "The pricing model V4 errs systematically with unit size. Within every infantry class it overprices small "
         "and large units and slightly underprices the mid-sized bulk it is fitted to, and it is several times "
         "noisier at the extremes. Without harmonisation the optimiser picks the extremes and rarely mid-sized "
         "infantry (the raw picks per card in the table below).", "",
         "**Method: reference-batch ComBat** (Johnson, Li & Rabinovic 2007; Zhang, Jenkins & Johnson 2018).",
         "- The model's out-of-fold error r = log(true ÷ predicted price) is treated like a batch effect, with size "
         "strata as the batches.",
         "- For each stratum, its mean error (*bias*) and its error spread (*noise*) are estimated with "
         "empirical-Bayes shrinkage. Small strata, such as the 17 units above 240 models, borrow strength from the "
         "rest.",
         "- Each stratum is mapped onto the arm's largest stratum (the reference, marked R), whose units keep exactly "
         "their model value. A unit keeps its place within its stratum on the model error.",
         f"- {what}",
         f"- There are two versions, because the systematic size discount may be real value; the other one "
         f"is {other[0]}, in `{other[1]}`.",
         "- Applied to the whole size range, units above 240 models included. The CSV keeps the raw value "
         "(`value_raw_each`) beside the one the builds use.", "",
         "**Reading the table:**",
         "- *model ÷ true*: the raw median error. Above 1, the model charges more than the game: a paper bargain.",
         "- *bias*: the stratum's shrunk systematic error relative to the reference "
         + ("(removed in this version)." if mode == "full" else "(kept in this version)."),
         "- *noise*: the stratum's error SD ÷ the reference's. 4 means the model is four times less reliable there, "
         "so a unit's deviation counts a quarter as much.",
         "- *factor*: the median value multiplier in this version.",
         "- *picks/card*: copies taken in the max-value builds per card in the stratum, raw values → this version.", ""]
    rows = []
    for t in table:
        keys = t["keys"]
        rows.append([t["arm"], t["sizes"] + (" (R)" if t["reference"] else ""), t["n"], f"{t['raw_ratio']:.3f}",
                     f"{t['bias']:.3f}", f"{t['spread']:.2f}", f"{t['factor']:.3f}",
                     f"{sum(raw_picks[k] for k in keys) / len(keys):.3f} → {sum(picks[k] for k in keys) / len(keys):.3f}"])
    L += up.table(["arm", "size (models; guns for artillery)", "units", "model ÷ true", "bias", "noise",
                   "factor", "picks/card"], rows)
    if not replay:
        return L + ["", "*Replay cross-check skipped: the ladder replay data (analysis/build_blind/data) is not "
                    "present. It is an optional check; no value in this report depends on it.*", ""]
    fmt = lambda t: f"{t[0]:+.2f} ± {t[1]:.2f} (z {t[0] / t[1]:.1f})"  # noqa: E731
    bias, both, sides = key["bias"]["bias part"], key["bias+noise"], key["sides"]
    L += ["", "**Replay cross-check: does what full harmonisation removes pay off in battle?** Ladder games on the "
          "blind study's fixed time split, with faction and skill controls. S is an army's paper surplus "
          "Σ(value − cost) ÷ 1 000 over its cards; coefficients are logits per 1 000 gold (± SE). The removed part "
          "S_raw − S_full is split into the strata's systematic *bias* and their excess *noise*, and into units "
          "smaller and larger than the reference stratum.", ""]
    L += up.table(["model", "surplus terms (training fit)", "test AUC", "test log-loss"], replay)
    real = bias[0] > 2 * bias[1]
    L += ["", "**What it says about size:**",
          f"- **The removed bias {'predicts' if real else 'does not clearly predict'} winning:** {fmt(bias)} per "
          f"1 000 gold; test log-loss {key['ll_base']:.5f} → {key['ll_bias']:.5f} with it.",
          f"- **With both parts in:** bias {fmt(both['bias part'])}, noise {fmt(both['noise part'])}.",
          f"- **By size side:** smaller units {fmt(sides['smaller-unit part'])}, larger units "
          f"{fmt(sides['larger-unit part'])}.",
          ("- **Reading:** where the game's price curve charges small and large units less than the bulk's size "
           "curve implies, those units seem to be worth the difference in battle. So the systematic size discount "
           "looks like real value rather than model error. That is the case for the noise-only version; the case "
           "for full harmonisation is that it prices every size by the game's own average rule." if real else
           "- **Reading:** the replays give no clear sign that the systematic size discount is real battle value, "
           "which favours full harmonisation."),
          "- **Caveats:** this is observational. Skill is controlled through the rating change, but players who "
          "choose extreme units may differ in ways the rating doesn't capture, and the user regards the replays as "
          f"biased. Effect size: one SD of the bias part is {key['sd_bias']:.2f} thousand gold, i.e. "
          f"{bias[0] * key['sd_bias']:+.2f} logit (≈ {25 * bias[0] * key['sd_bias']:+.0f} percentage points of win "
          "probability near 50%).", ""]
    return L


def write_outputs(results, big_units, value, by_faction, started, command: Command,
                  size=([], Counter(), ([], {})), mode: str = "off", suffix: str = "",
                  max_cards: int = MAX_CARDS) -> None:
    best = [r for r in results if r["variant"] == "max value"]
    best.sort(key=lambda r: -r["efficiency"])
    cap = f"_max{max_cards}" if max_cards < MAX_CARDS else ""
    size_note = {
        "full": "> - **Values are size-harmonised, fully (§5).** The pricing model's errors depend on unit size: it "
                "overprices small and very large units and is much noisier there. That size bias and the excess noise "
                "are removed before optimising, so a unit's size no longer makes it look like a bargain. The "
                f"noise-only version is in `cost_effective_builds_noise_only{cap}.md`.",
        "noise": "> - **Values are size-harmonised, noise only (§5).** The pricing model is much noisier for small "
                 "and very large units; that excess noise (the fake bargains) is removed before optimising, but each "
                 "size's systematic discount is kept, treating it as possible real value. The fully harmonised "
                 f"version is in `cost_effective_builds{cap}.md`.",
        "off": "> - **Values are not size-harmonised.** The pricing model overprices small and very large units, so "
               "they can look like bargains."}[mode]
    card_rule = (f"- 31 cards in total *including* the staff general, i.e. {MAX_CARDS - 1} units, as the app counts it "
                 "(`web/src/state/build.ts`: the staff-slot card is part of the 31);" if not cap else
                 f"- **at most {max_cards} cards *including* the staff general ({max_cards - 1} units): a micro cap "
                 f"set by the user** (`--max-cards {max_cards}`), below the game's 31. More units are harder to "
                 "control, which no price captures, so this caps the army's size rather than its cost;")
    title_cap = f", at most {max_cards} cards" if cap else ""
    L = [f"# The most cost-effective build for every ToW / Custom army ({SIZE_LABEL[mode]}{title_cap})", "",
         "Generated by `analysis/cost_effective_builds.py`. **Value** is normative: what the game's average pricing "
         "rule charges for a card's stats in a reference army, i.e. the per-class model V4 at corps number 8 with no "
         "army × unit-class adjustment; commanders valued by the commander model on that value. **Efficiency** = "
         "total value ÷ total cost: 1.00 means the build gets exactly the stats its price buys under the average "
         "rule, 1.20 means 20% more.", "",
         "Each build is the build with the most total value under these rules:",
         "",
         "- one staff general and at most one combat general. The staff general is valued like a card and chosen by "
         "the optimiser: the global general price rule (T3 at corps 8: 76.55·stars^1.39, 1 gold without stars, no "
         "army modifier) plus the hand-set command correction of §4, which raises his worth in large, low-morale "
         "builds and favours C-class (fast) generals; the *top staff* build instead takes the army's highest-star "
         "general, valued by T3 alone;",
         card_rule,
         "- 10 000 funds, including the staff general;",
         "- the artillery and heavy-cavalry caps, and each unit's cap.",
         "",
         "*cards* counts the units, not the staff general.", "",
         "> **How to read this.**",
         ">",
         "> - **A higher corps number makes everything cheaper.** Price scales with 8/N, so armies with a high "
         "number come out more efficient by construction; whether the game balances that elsewhere is not in the data.",
         "> - **Value is stats as the game prices them, not battle power.** Mass and morale may matter more in "
         "battle than the price rule says (see the HRE discussion).",
         size_note,
         f"> - **Units above {BIG_UNIT_MODELS} models take part and are flagged (†).** The model's raw error there is "
         "~25–70%, and they are listed with raw and used values in §3.",
         "> - **A ToW army's roll is not checked.** A build may need a specific time window, which the app's "
         "\"Generate times\" finds.",
         "> - **Expect some winner's curse.** The optimiser picks the cards that look most underpriced, and part of "
         "that is model error (a few % per unit), so true efficiencies are somewhat lower than shown, more so for "
         "single-unit picks than for the army ranking. Harmonisation reduces this where the model is least "
         "reliable.", "",
         "## 1. All armies, ranked by efficiency (max-value build)", ""]
    rows = []
    for r in best:
        bal = next((x for x in results if x["faction"] == r["faction"] and x["variant"] == "balanced"), None)
        rows.append([r["army"], r["N"], r["side"], f"{r['efficiency']:.3f}", f"{r['efficiency'] * up.REF_RATING / r['N']:.3f}",
                     f"{bal['efficiency']:.3f}" if bal else "—",
                     f"{r['value']:,.0f}", f"{r['cost']:,.0f}", r["cards"],
                     f"{r['arms']['infantry']}/{r['arms']['cavalry']}/{r['arms']['artillery']}", f"{r['men']:,.0f}"])
    L += up.table(["army", "N", "side", "efficiency", "vs own rating", "balanced", "value", "cost", "cards",
                   "inf/cav/art", "men"], rows)
    L += ["", "- *efficiency*: stats per gold against a corps-8 reference. This is what 10 000 gold actually buys; "
          "a high corps number helps, because price scales with 8/N.",
          "- *vs own rating*: the same build's value measured at the army's own corps number (efficiency × N/8). "
          "This removes the 8/N effect and shows how well the army is priced *for its rating*: its army × class "
          "adjustments and the bargains in its roster. The best build is the same under both measures.",
          "- *balanced*: the best build with at least 4 cavalry and 2 artillery cards.", ""]
    neutral = sorted(best, key=lambda r: -r["efficiency"] * up.REF_RATING / r["N"])
    L += ["**Best priced for their rating** (vs own rating, top 10): " + "; ".join(
        f"{r['army']} {r['efficiency'] * up.REF_RATING / r['N']:.3f}" for r in neutral[:10]) + ".", "",
          "**Worst priced for their rating** (bottom 5): " + "; ".join(
        f"{r['army']} {r['efficiency'] * up.REF_RATING / r['N']:.3f}" for r in neutral[-5:]) + ".", "",
          "## 2. The builds", "",
          "Per army: the max-value build, then the balanced one if it differs. `×k` = copies; value/cost per card in "
          "brackets.", ""]
    for r in best:
        for v in ("max value", "balanced"):
            x = next((y for y in results if y["faction"] == r["faction"] and y["variant"] == v), None)
            if x is None:
                continue
            if v == "balanced" and sorted((c["key"], k) for c, k in x["chosen"]) == sorted((c["key"], k) for c, k in r["chosen"]):
                L += ["*(balanced build: the same)*", ""]
                continue
            L += [f"### {r['army']} — {v}: efficiency {x['efficiency']:.3f}, cost {x['cost']:,.0f}, "
                  f"value {x['value']:,.0f}, {x['cards']} cards, {x['men']:,.0f} men", "",
                  f"Staff general: {x['slot']}.", ""]
            L += [f"- {c['name']} ×{k} ({c['cost']:.0f} gold, value {c['value']:.0f}, ×{c['value'] / c['cost']:.2f})"
                  + (" — combat general" if c["kind"] == "commander" else "")
                  + (f" † over {BIG_UNIT_MODELS} models" if c["models"] > BIG_UNIT_MODELS else "")
                  for c, k in x["chosen"]]
            L += [""]
    L += [f"## 3. Units above {BIG_UNIT_MODELS} models (flagged)", "",
          "The pricing model overprices units this size, by up to ~70% for the largest, and is far less reliable "
          f"there. The raw value shows that; the value the builds use is after {SIZE_LABEL[mode]} (§5).", ""]
    L += up.table(["army", "unit", "men", "cost", "raw model value", "value used"],
                  [[a, c["name"], f"{c['men']:.0f}", f"{c['cost']:.0f}",
                    f"{c['value_raw']:.0f} (×{c['value_raw'] / c['cost']:.2f})",
                    f"{c['value']:.0f} (×{c['value'] / c['cost']:.2f})"]
                   for a, c in sorted(big_units, key=lambda t: -t[1]["men"])])
    L += command_section(results, command)
    L += size_section(results, size, mode, cap)
    L += ["", f"*Runtime {time.time() - started:.0f} s.*", ""]
    (OUT / f"cost_effective_builds{suffix}.md").write_text("\n".join(L), encoding="utf-8")
    with open(OUT / f"cost_effective_builds{suffix}.csv", "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["army_corps_name", "faction_key", "variant", "card", "unit_key", "kind", "unit_class", "copies",
                    "cost_each", "value_each", "value_per_cost", "value_raw_each", "staff_key", "staff_name", "staff_cost",
                    "staff_stars", "staff_value", "morale_deficit", "source_corps"])
        for x in results:
            g = x["staff"]
            for c, k in x["chosen"]:
                w.writerow([x["army"], x["faction"], x["variant"], c["name"], c["key"], c["kind"], c["cls"], k,
                            f"{c['cost']:.0f}", f"{c['value']:.1f}", f"{c['value'] / c['cost']:.3f}",
                            f"{c['value_raw']:.1f}",
                            g["key"], g["name"], g["cost"], g["stars"], f"{g['value']:.1f}",
                            f"{g['deficit']:.0f}" if "deficit" in g else "", " ".join(x["corps"])])
    up.log(f"done → analysis/output/cost_effective_builds{suffix}.md, cost_effective_builds{suffix}.csv", started)


if __name__ == "__main__":
    raise SystemExit(main())
