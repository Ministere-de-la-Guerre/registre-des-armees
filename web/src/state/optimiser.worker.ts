// Web Worker for the build optimiser: runs HiGHS (WebAssembly) off the main thread,
// because a solve blocks its thread for up to a second or two. Receives LP text,
// answers with the solution (state/solveLp.ts workerSolver is the client).
//
// The .wasm is imported as a URL so Vite fingerprints it and the PWA precaches it
// (vite.config.ts globPatterns "**/*.wasm"); the Electron app:// scheme serves it as
// application/wasm (electron/main.cjs MIME map).

import highsLoader from "highs";
import wasmUrl from "highs/runtime?url";
import { type HighsLike, type SolveOptions, solveWithHighs } from "./solveLp";

interface SolveRequest {
  id: number;
  lp: string;
  options?: SolveOptions;
}

// tsconfig.app.json types the app with the DOM lib; narrow `self` to what a worker uses.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SolveRequest>) => void) | null;
  postMessage(message: unknown): void;
};

let highs: Promise<HighsLike> | null = null;

scope.onmessage = async (event) => {
  const { id, lp, options } = event.data;
  try {
    highs ??= highsLoader({ locateFile: () => wasmUrl });
    scope.postMessage({ id, solution: solveWithHighs(await highs, lp, options) });
  } catch (error) {
    highs = null; // a failed load is retried on the next request
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
