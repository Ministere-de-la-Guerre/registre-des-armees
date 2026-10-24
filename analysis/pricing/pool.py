"""The worker pool for the nested power searches.

Part of the pricing package split out of unit_pricing.py (analysis/REFACTOR_PLAN.md);
import it through unit_pricing, which re-exports the public names."""

from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor
from dataclasses import replace
from typing import Callable, Sequence

from pricing import config
from pricing.config import Settings


# --- Parallel workers ---------------------------------------------------------
#
# The nested power searches run one independent descent per outer fold plus one
# on all rows; those jobs go to a process pool. Each job is a pure function of
# its arguments, so results are identical to a serial run. Workers are spawned
# fresh (Windows), so the whole Settings object is copied into them, and a
# worker never opens a pool of its own (workers=1). A pool started under old
# settings is shut down whenever configure() changes one, so it never computes
# with stale values.

_POOL: ProcessPoolExecutor | None = None


def _init_worker(settings: Settings) -> None:
    config.install(replace(settings, workers=1))


def _shutdown_pool(old: Settings, new: Settings) -> None:
    global _POOL
    if _POOL is not None and replace(old, out_dir=new.out_dir) != new:
        _POOL.shutdown()
        _POOL = None


config.on_change(_shutdown_pool)


def _call(job: tuple) -> object:
    fn, args = job
    return fn(*args)


def parallel_map(fn: Callable, jobs: Sequence[tuple]) -> list:
    """[fn(*job) for job in jobs], on the worker pool when the workers setting is > 1."""
    global _POOL
    workers = config.settings.workers
    if workers <= 1 or len(jobs) <= 1:
        return [fn(*job) for job in jobs]
    if _POOL is None:
        _POOL = ProcessPoolExecutor(workers, initializer=_init_worker, initargs=(config.settings,))
    return list(_POOL.map(_call, [(fn, tuple(job)) for job in jobs]))
