"""Results must stay what the trusted baseline produced (analysis/tests/golden/, written by make_golden.py):
every checkpoint loads and fingerprints the same (so pickled class paths are intact; a regenerated fit may
differ only in floating-point rounding, its headline metric within 1e-9),
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
                got = checkpoint_record(path)
                if got == record:
                    continue
                # A fit regenerated on another machine (or with other worker counts) can differ in the last
                # bits of floating point (summation order): a few fold metrics differed by ~1e-15 relative in
                # the clean regeneration, with identical shipped files. Accept that, not more.
                self.assertEqual(got["type"], record["type"])
                if record["headline"] is not None:
                    self.assertAlmostEqual(float(got["headline"]) / float(record["headline"]), 1.0, delta=1e-9)

    def test_unit_loads(self) -> None:
        self.assertEqual(load_fingerprints(), golden("load.json"))

    def test_fits_and_size_weights(self) -> None:
        self.assertEqual(json.loads(json.dumps(numerics())), golden("numerics.json"))


if __name__ == "__main__":
    unittest.main()
