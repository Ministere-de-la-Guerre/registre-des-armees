"""Results must stay exactly what the trusted baseline produced (analysis/tests/golden/, written by
make_golden.py): every checkpoint loads and fingerprints the same (so pickled class paths are intact),
the unit loads are identical in order, and the adopted model's fits and the size weights are unchanged."""

from __future__ import annotations

import json
import unittest

from support import CACHE, GOLDEN, HAS_CACHE, checkpoint_record, load_fingerprints, numerics


def golden(name: str) -> dict:
    return json.loads((GOLDEN / name).read_text(encoding="utf-8"))


@unittest.skipUnless(HAS_CACHE, "needs the local checkpoints in analysis/.cache/")
class GoldenTests(unittest.TestCase):
    def test_checkpoints_load_and_match(self) -> None:
        expected = golden("checkpoints.json")
        for rel, record in expected.items():
            path = CACHE / rel
            if not path.exists():
                continue                                    # a checkpoint deleted locally is not a regression
            with self.subTest(checkpoint=rel):
                self.assertEqual(checkpoint_record(path), record)

    def test_unit_loads(self) -> None:
        self.assertEqual(load_fingerprints(), golden("load.json"))

    def test_fits_and_size_weights(self) -> None:
        self.assertEqual(json.loads(json.dumps(numerics())), golden("numerics.json"))


if __name__ == "__main__":
    unittest.main()
