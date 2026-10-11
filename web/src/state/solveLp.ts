// LP solving for the build optimiser (state/optimiser.ts).
//
// The optimiser writes its integer programme as CPLEX LP text and hands it to an
// `LpSolver`. In the app that is HiGHS compiled to WebAssembly (the `highs` npm
// package — the same solver `scipy.optimize.milp` uses in the Python analysis, so
// the app and analysis/cost_effective_builds.py agree), run in a Web Worker
// (state/optimiser.worker.ts) because a solve blocks its thread. Tests call
// `highs` directly under Node through `solverFromHighs`.

/** Wall-clock cap per solve, in seconds. Typical solves take well under a second. */
export const OPTIMISER_TIME_LIMIT_S = 10;

export interface LpSolution {
  /** HiGHS model status, e.g. "Optimal", "Infeasible", "Time limit reached". */
  status: string;
  /** Primal value per column name; empty when the solver found no solution. */
  columns: Record<string, number>;
}

/** Per-solve overrides of HIGHS_OPTIONS. Unset fields keep HiGHS's own defaults (relative MIP gap
 *  1e-4, as scipy's milp in analysis/cost_effective_builds.py); the Army Corps optimiser asks for a
 *  tighter gap, as analysis/ac_builds.py does. */
export interface SolveOptions {
  /** Wall-clock cap in seconds (default OPTIMISER_TIME_LIMIT_S). */
  timeLimit?: number;
  /** Relative MIP gap at which HiGHS stops. */
  mipRelGap?: number;
}

export type LpSolver = (lp: string, options?: SolveOptions) => Promise<LpSolution>;

/** The part of a loaded `highs` module the optimiser uses. */
export interface HighsLike {
  solve(problem: string, options?: Record<string, unknown>): {
    Status: string;
    /** Per column; infeasible results carry no `Primal`, so it is read defensively. */
    Columns?: Record<string, unknown>;
  };
}

/** Options for every solve: quiet, time-limited. */
export const HIGHS_OPTIONS = { output_flag: false, time_limit: OPTIMISER_TIME_LIMIT_S } as const;

/** HiGHS options for one solve: HIGHS_OPTIONS with the request's overrides. */
export function highsOptions(options: SolveOptions = {}): Record<string, unknown> {
  return {
    ...HIGHS_OPTIONS,
    ...(options.timeLimit !== undefined ? { time_limit: Math.max(0.1, options.timeLimit) } : {}),
    ...(options.mipRelGap !== undefined ? { mip_rel_gap: options.mipRelGap } : {}),
  };
}

/** One solve with a loaded HiGHS instance (worker and tests share this). */
export function solveWithHighs(highs: HighsLike, lp: string, options?: SolveOptions): LpSolution {
  const result = highs.solve(lp, highsOptions(options));
  const columns: Record<string, number> = {};
  for (const [name, col] of Object.entries(result.Columns ?? {})) {
    const primal = (col as { Primal?: unknown } | null)?.Primal;
    if (typeof primal === "number" && Number.isFinite(primal)) columns[name] = primal;
  }
  return { status: result.Status, columns };
}

/** An `LpSolver` over an already loaded HiGHS instance (synchronous underneath). */
export function solverFromHighs(highs: HighsLike): LpSolver {
  return (lp, options) => Promise.resolve(solveWithHighs(highs, lp, options));
}

// --- the app's solver: one lazily started worker, requests matched by id ----------

type WorkerReply = { id: number; solution: LpSolution } | { id: number; error: string };

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (s: LpSolution) => void; reject: (e: Error) => void }>();

function failAll(message: string): void {
  for (const { reject } of pending.values()) reject(new Error(message));
  pending.clear();
  worker = null;
}

function startWorker(): Worker {
  const w = new Worker(new URL("./optimiser.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (event: MessageEvent<WorkerReply>) => {
    const reply = event.data;
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    if ("error" in reply) request.reject(new Error(reply.error));
    else request.resolve(reply.solution);
  };
  w.onerror = (event) => {
    failAll(`The optimiser could not start (${event.message || "worker error"}).`);
    w.terminate();
  };
  return w;
}

/** Thrown into pending solves by cancelSolves(). */
export class SolveCancelled extends Error {
  constructor() {
    super("The optimisation was cancelled.");
    this.name = "SolveCancelled";
  }
}

function request(lp: string, options?: SolveOptions): Promise<LpSolution> {
  return new Promise<LpSolution>((resolve, reject) => {
    worker ??= startWorker();
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, lp, options });
  });
}

/** The app's `LpSolver`: HiGHS in a Web Worker, started on first use and kept for later solves.
 *  A solve that fails inside the worker (the WebAssembly runtime can abort after many solves; the
 *  worker then reloads it) is retried once; a cancelled one is not. */
export const workerSolver: LpSolver = async (lp, options) => {
  try {
    return await request(lp, options);
  } catch (error) {
    if (error instanceof SolveCancelled) throw error;
    return request(lp, options);
  }
};

/** Stop every running solve: the worker is terminated (a solve cannot be interrupted inside
 *  WebAssembly) and pending requests reject with SolveCancelled. The next solve starts a new one. */
export function cancelSolves(): void {
  const w = worker;
  for (const { reject } of pending.values()) reject(new SolveCancelled());
  pending.clear();
  worker = null;
  w?.terminate();
}
