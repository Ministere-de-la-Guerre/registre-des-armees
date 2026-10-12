"""Write the golden snapshots the analysis tests compare against (analysis/tests/golden/).

Run ONLY on code whose results you trust (the refactor baseline was commit 32c6fd63): the tests then
prove later code reproduces them exactly. Needs the local checkpoints in analysis/.cache/ (gitignored).

- checkpoints.json: every checkpoint's type, a fingerprint (SHA-256 of the loaded object pickled again,
  which also pins every class's pickled module path) and its headline number (CV MAE or κ);
- load.json: SHA-256 of the ToW and AC unit / staff loads, in load order (fold assignment depends on it);
- numerics.json: exact training SSE of the adopted model on each ToW slice, and the size-weight arrays.

    py -3.13 analysis/tests/make_golden.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import support  # noqa: E402,F401  (puts analysis/ on the path)
from support import CACHE, GOLDEN, checkpoint_record, load_fingerprints, numerics  # noqa: E402


def main() -> int:
    GOLDEN.mkdir(parents=True, exist_ok=True)
    records = {p.relative_to(CACHE).as_posix(): checkpoint_record(p) for p in sorted(CACHE.rglob("*.pkl"))}
    (GOLDEN / "checkpoints.json").write_text(json.dumps(records, indent=1, sort_keys=True), encoding="utf-8")
    (GOLDEN / "load.json").write_text(json.dumps(load_fingerprints(), indent=1), encoding="utf-8")
    (GOLDEN / "numerics.json").write_text(json.dumps(numerics(), indent=1), encoding="utf-8")
    print(f"golden: {len(records)} checkpoints, loads, numerics → {GOLDEN}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
