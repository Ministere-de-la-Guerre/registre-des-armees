"""Coverage-guaranteed, faction-balanced 80/20 fold plans (SplitPlan) and their search.

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Sequence

import numpy as np

from pricing.pickling import pickled_as_unit_pricing
from pricing.constants import MIN_BALANCE_ROWS, N_SPLITS, TEST_SHARE


# --- Coverage-guaranteed, faction-balanced 80/20 splits -----------------------

Fold = tuple[np.ndarray, np.ndarray]   # (train indices, test indices)


@pickled_as_unit_pricing
@dataclass
class SplitPlan:
    seed: int
    folds: list[Fold]
    pinned: list[str]          # coverage columns whose single minority group is pinned to train
    n_pinned_rows: int
    violations_before_repair: int
    repairs: list[str]
    balance_max: float         # max |test share − 20%| over balance keys with ≥ MIN_BALANCE_ROWS
    balance_spread: tuple[float, float, float]   # min / median / max test share, fold 1


def group_ids(C: np.ndarray, extra: Sequence[object]) -> np.ndarray:
    """Rows with identical coverage features (and identical `extra`) share a group,
    so a duplicate unit can never sit in train and test at once."""
    seen: dict[tuple, int] = {}
    return np.array([
        seen.setdefault(tuple(np.round(row, 9)) + (key,), len(seen))
        for row, key in zip(C, extra)
    ])


def pinned_groups(C: np.ndarray, groups: np.ndarray, names: Sequence[str]) -> tuple[set[int], list[str]]:
    """A 0/1 column whose minority value lives in a single group can never be in
    both train and test; pin that group to train in every fold."""
    pinned: set[int] = set()
    labels: list[str] = []
    for j, name in enumerate(names):
        column = C[:, j]
        if not np.isin(column, (0.0, 1.0)).all():
            continue
        for value in (0.0, 1.0):
            holders = set(groups[column == value].tolist())
            if len(holders) == 1 and len(set(groups.tolist())) > 1:
                pinned |= holders
                labels.append(name if value == 1.0 else f"{name} (=0)")
    return pinned, labels


def assign_folds(strata: np.ndarray, balance: np.ndarray, groups: np.ndarray,
                 eligible: np.ndarray, seed: int) -> np.ndarray:
    """Stratified, grouped, faction-interleaved fold assignment.

    Groups are ordered by (stratum, balance key, seeded random key) and dealt
    round-robin into the folds from a seeded offset. Every stratum is a
    consecutive run, so each stratum is spread across folds with counts differing
    by at most one; inside a stratum each balance key (faction) is also a
    consecutive run, so it is spread the same way. Same guarantees as sklearn's
    StratifiedGroupKFold for this data (almost every group is a single unit), at
    a cost of milliseconds rather than a second per split.
    """
    rng = np.random.default_rng(seed)
    unique = np.unique(groups[eligible])
    first_row = {g: i for i, g in reversed(list(enumerate(groups))) if eligible[i]}
    random_key = dict(zip(unique.tolist(), rng.permutation(len(unique)).tolist()))
    order = sorted(unique.tolist(), key=lambda g: (
        strata[first_row[g]], balance[first_row[g]], random_key[g]))
    offset = int(rng.integers(N_SPLITS))
    fold_of_group = {g: (offset + position) % N_SPLITS for position, g in enumerate(order)}
    fold = np.full(len(groups), -1)
    for i in np.flatnonzero(eligible):
        fold[i] = fold_of_group[groups[i]]
    return fold


def unidentified(C: np.ndarray, train: np.ndarray, test: np.ndarray) -> np.ndarray:
    """Columns constant in train but taking another value in test — their
    coefficient is undefined, so those test predictions would be arbitrary."""
    lo, hi = C[train].min(axis=0), C[train].max(axis=0)
    constant = lo == hi
    return constant & ((C[test].min(axis=0) != lo) | (C[test].max(axis=0) != hi))


def folds_from(fold: np.ndarray) -> list[Fold]:
    everything = np.arange(len(fold))
    out = []
    for k in range(N_SPLITS):
        test = np.flatnonzero(fold == k)
        out.append((np.setdiff1d(everything, test), test))   # pinned rows (-1) always train
    return out


def balance_scores(folds: list[Fold], balance: np.ndarray) -> tuple[float, float, tuple[float, float, float]]:
    totals = Counter(balance.tolist())
    big = [key for key, total in totals.items() if total >= MIN_BALANCE_ROWS]
    worst, sse = 0.0, 0.0
    fold1_shares: list[float] = []
    for k, (_, test) in enumerate(folds):
        in_test = Counter(balance[test].tolist())
        for key, total in totals.items():
            share = in_test.get(key, 0) / total
            sse += total * (share - TEST_SHARE) ** 2
            if key in big:
                worst = max(worst, abs(share - TEST_SHARE))
                if k == 0:
                    fold1_shares.append(share)
    spread = (min(fold1_shares), float(np.median(fold1_shares)), max(fold1_shares)) if fold1_shares else (0, 0, 0)
    return worst, sse, spread


def repair(folds: list[Fold], C: np.ndarray, groups: np.ndarray, names: Sequence[str]) -> tuple[list[Fold], list[str]]:
    log: list[str] = []
    fixed: list[Fold] = []
    for k, (train, test) in enumerate(folds):
        train, test = train.copy(), test.copy()
        while True:
            bad = np.flatnonzero(unidentified(C, train, test))
            if bad.size == 0:
                break
            j = bad[0]
            constant = C[train, j][0]
            movers = set(groups[test][C[test, j] != constant].tolist())
            move = np.isin(groups[test], list(movers))
            log.append(f"fold {k + 1}: moved {int(move.sum())} row(s) to train for `{names[j]}`")
            train = np.sort(np.concatenate([train, test[move]]))
            test = test[~move]
        fixed.append((train, test))
    return fixed, log


def search_splits(C: np.ndarray, names: Sequence[str], strata: np.ndarray, balance: np.ndarray,
                  groups: np.ndarray, n_seeds: int, extra_pinned: set[int] | None = None) -> SplitPlan:
    """Try `n_seeds` assignments; keep the one with zero coverage violations and
    the most uniform spread of `balance` keys across test folds. `extra_pinned`
    groups are always trained on too (experiments/ (analysis branch) extreme_pinning.py)."""
    pinned, pinned_labels = pinned_groups(C, groups, names)
    if extra_pinned:
        pinned = pinned | extra_pinned
        pinned_labels = pinned_labels + [f"{len(extra_pinned)} extra group(s)"]
    eligible = ~np.isin(groups, list(pinned))
    best: tuple | None = None
    for seed in range(n_seeds):
        folds = folds_from(assign_folds(strata, balance, groups, eligible, seed))
        violations = sum(int(unidentified(C, tr, te).sum()) for tr, te in folds)
        worst, sse, spread = balance_scores(folds, balance)
        score = (violations, round(worst, 9), sse)
        if best is None or score < best[0]:
            best = (score, seed, folds, spread)
    (violations, worst, _), seed, folds, spread = best
    folds, log = repair(folds, C, groups, names) if violations else (folds, [])
    return SplitPlan(
        seed=seed, folds=folds, pinned=sorted(set(pinned_labels)),
        n_pinned_rows=int((~eligible).sum()), violations_before_repair=violations,
        repairs=log, balance_max=worst, balance_spread=spread,
    )


def restrict(plan: SplitPlan, keep: np.ndarray, C: np.ndarray, groups: np.ndarray,
             names: Sequence[str]) -> SplitPlan:
    """The same folds with some rows removed (the Poland-excluded runs), re-checked
    for coverage and repaired if removing rows broke it."""
    new_index = -np.ones(len(keep), int)
    new_index[keep] = np.arange(int(keep.sum()))
    folds = [(new_index[tr[keep[tr]]], new_index[te[keep[te]]]) for tr, te in plan.folds]
    violations = sum(int(unidentified(C, tr, te).sum()) for tr, te in folds)
    folds, log = repair(folds, C, groups, names) if violations else (folds, [])
    return SplitPlan(
        seed=plan.seed, folds=folds, pinned=plan.pinned, n_pinned_rows=plan.n_pinned_rows,
        violations_before_repair=violations, repairs=log,
        balance_max=plan.balance_max, balance_spread=plan.balance_spread,
    )
