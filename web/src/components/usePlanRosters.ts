import { useCallback, useEffect, useRef, useState } from "react";
import { loadFaction } from "../data/load";
import type { FactionRoster } from "../domain/types";

export type RosterLoad =
  | { status: "loading" }
  | { status: "ready"; roster: FactionRoster }
  | { status: "error"; error: string };

/** Rosters for the corps a plan uses, loaded on demand (once `enabled`) and kept for
 *  as long as the caller lives — so the host (App) can own the cache and leaving the
 *  planner for the builder and back costs no reload. A failed load stays failed until
 *  `retry(key)`, so a missing file can't loop. `ensure(key)` returns the roster itself
 *  (the team suggestion optimises armies that are not in the plan yet); it shares the
 *  same requests, so nothing is fetched twice. */
export function usePlanRosters(factionKeys: readonly string[], enabled: boolean) {
  const [loads, setLoads] = useState<ReadonlyMap<string, RosterLoad>>(() => new Map());
  const requests = useRef(new Map<string, Promise<FactionRoster>>());

  const ensure = useCallback((key: string): Promise<FactionRoster> => {
    let request = requests.current.get(key);
    if (!request) {
      setLoads((m) => new Map(m).set(key, { status: "loading" }));
      request = loadFaction(key);
      requests.current.set(key, request);
      request
        .then((roster) => setLoads((m) => new Map(m).set(key, { status: "ready", roster })))
        .catch((e) => setLoads((m) => new Map(m).set(key, { status: "error", error: String(e) })));
    }
    return request;
  }, []);

  const retry = useCallback((key: string) => {
    requests.current.delete(key);
    ensure(key).catch(() => undefined);              // the failure is in `loads`
  }, [ensure]);

  const keysSignature = factionKeys.join("|");
  useEffect(() => {
    if (!enabled) return;
    for (const key of keysSignature ? keysSignature.split("|") : []) {
      if (!requests.current.has(key)) ensure(key).catch(() => undefined);
    }
  }, [enabled, keysSignature, ensure]);

  return { loads, retry, ensure };
}
