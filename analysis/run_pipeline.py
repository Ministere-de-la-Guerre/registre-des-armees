"""Regenerate the in-app optimiser's data from the game data alone, in one command.

From data/generated/ntw3_units_analysis.csv (tools/build_analysis_dataset.py) to the three files the app ships:
  data/generated/ntw3_optimiser_values.csv        every valued card, per value mode
  data/generated/ntw3_optimiser_params.json       staff-general rule and command correction per pool
  data/generated/ntw3_optimiser_army_values.csv   every army's best-build value per mode (team suggestion)

Every step caches its fits in analysis/.cache/ (gitignored), so an interrupted run resumes where it stopped:
run the same command again. Steps in one stage run in parallel. Intermediate outputs go to analysis/output/
(gitignored). Times are for a 16-thread PC with the default worker counts; the whole run takes a few hours.

    py -3.13 analysis/run_pipeline.py                 # everything
    py -3.13 analysis/run_pipeline.py --from team     # resume from a stage (see STAGES)
    py -3.13 analysis/run_pipeline.py --workers 4     # fewer worker processes per step

Then, for the app: py -3.13 tools/build_web_data.py, and for its parity fixture
py -3.13 analysis/export_optimiser_values.py --fixture (docs/HANDOFF.md §4.6).
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable


def stages(workers: int) -> list[tuple[str, list[list[str]]]]:
    """(stage name, commands run in parallel). Commands are argument lists after `python`."""
    w = str(workers)
    third = str(max(1, workers // 3))
    return [
        ("dataset", [["tools/build_analysis_dataset.py"]]),                                   # seconds
        ("base", [["analysis/unit_pricing.py", "--workers", w],                              # ~35 min
                  ["analysis/class_structure.py"],                                          # ~40 min
                  ["analysis/build_commander_pairs.py"],                                    # seconds
                  ["analysis/ac_discounts.py"]]),                                           # ~1 min
        ("commanders", [["analysis/commander_model.py"]]),                                  # ~1 min
        ("ac", [["analysis/ac_pricing.py", "--phase", "model", "--arm", arm, "--workers", third]
                for arm in ("infantry", "cavalry", "artillery")]),                          # up to ~90 min
        ("ac-staff", [["analysis/ac_pricing.py", "--phase", "staff"],
                      ["analysis/ac_pricing.py", "--phase", "commanders"]]),                # minutes
        ("team", [["analysis/team_values.py", "--workers", w]]),                            # ~5 min
        ("builds", [["analysis/ac_builds.py"],                                              # ~6 min
                    ["analysis/ac_builds.py", "--no-rebates", "--versions", "sb", "full", "noise"]]),
        ("search", [["analysis/team_search.py"]]),                                          # ~2 min
        ("export", [["analysis/export_optimiser_values.py"]]),                              # ~15 s
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--workers", type=int, default=6, help="worker processes per step (default 6)")
    parser.add_argument("--from", dest="start", default=None, help="first stage to run (default: the first)")
    args = parser.parse_args()
    plan = stages(args.workers)
    names = [n for n, _ in plan]
    if args.start and args.start not in names:
        raise SystemExit(f"unknown stage {args.start!r}; stages: {', '.join(names)}")
    started = time.time()
    for name, commands in plan[names.index(args.start) if args.start else 0:]:
        print(f"[{time.time() - started:6.0f}s] stage {name}: " + " | ".join(" ".join(c) for c in commands), flush=True)
        procs = [subprocess.Popen([PY, *c], cwd=ROOT) for c in commands]
        codes = [p.wait() for p in procs]
        if any(codes):
            failed = [" ".join(c) for c, code in zip(commands, codes) if code]
            raise SystemExit(f"stage {name} failed: {failed}; fix it and resume with --from {name}")
    print(f"[{time.time() - started:6.0f}s] done: the three files are in data/generated/", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
