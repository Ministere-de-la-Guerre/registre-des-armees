// HiGHS for tests under Node: the `highs` package with its .wasm passed as bytes,
// so the test does not depend on how the loader locates the file.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import highsLoader from "highs";
import { type LpSolver, solverFromHighs } from "../state/solveLp";

let solver: Promise<LpSolver> | null = null;

/** A shared HiGHS-backed solver (loaded once per test file). */
export function nodeSolver(): Promise<LpSolver> {
  solver ??= (async () => {
    const require = createRequire(import.meta.url);
    const wasmBinary = readFileSync(require.resolve("highs/runtime"));
    return solverFromHighs(await highsLoader({ wasmBinary }));
  })();
  return solver;
}
