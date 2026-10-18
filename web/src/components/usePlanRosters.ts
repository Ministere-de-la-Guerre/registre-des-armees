import { useCallback, useEffect, useRef, useState } from "react";
import { loadFaction } from "../data/load";
import type { FactionRoster } from "../domain/types";

export type RosterLoad =
  | { status: "loading" }
  | { status: "ready"; roster: FactionRoster }
  | { status: "error"; error: string };

/** Rosters for the corps a plan uses, loaded on demand (once `enabled`) and kept for
 *  as long as the caller lives — so the host (App) can own the cache and leaving the
 *  planner for the builder and back costs no reload. `ensure(key)` returns the roster
 *  itself (the team suggestion optimises armies that are not in the plan yet); it shares
 *  the same requests, so nothing is fetched twice. A failed request is not cached: the
 *  next `ensure(key)` fetches again (a transient network failure must not break that
 *  army until a reload). The automatic plan loading skips a failed key until
 *  `retry(key)`, so a missing file can't loop; its `loads` entry shows the error. */
export function usePlanRosters(factionKeys: readonly string[], enabled: boolean) {
  const [loads, setLoads] = useState<ReadonlyMap<string, RosterLoad>>(() => new Map());
  const requests = useRef(new Map<string, Promise<FactionRoster>>());
  const failed = useRef(new Set<string>());

  const ensure = useCallback((key: string): Promise<FactionRoster> => {
    let request = requests.current.get(key);
    if (!request) {
      setLoads((m) => new Map(m).set(key, { status: "loading" }));
      const fresh = loadFaction(key);
      request = fresh;
      requests.current.set(key, fresh);
      // Both handlers sit on the request itself, ahead of any caller's, so a caller that retries
      // as soon as its await rejects already finds the failed request evicted.
      fresh.then(
        (roster) => {
          failed.current.delete(key);
          setLoads((m) => new Map(m).set(key, { status: "ready", roster }));
        },
        (e) => {
          if (requests.current.get(key) === fresh) requests.current.delete(key);
          failed.current.add(key);
          setLoads((m) => new Map(m).set(key, { status: "error", error: String(e) }));
        },
      );
    }
    return request;
  }, []);

  const retry = useCallback((key: string) => {
    failed.current.delete(key);
    requests.current.delete(key);
    ensure(key).catch(() => undefined);              // the failure is in `loads`
  }, [ensure]);

  const keysSignature = factionKeys.join("|");
  useEffect(() => {
    if (!enabled) return;
    for (const key of keysSignature ? keysSignature.split("|") : []) {
      if (!requests.current.has(key) && !failed.current.has(key)) ensure(key).catch(() => undefined);
    }
  }, [enabled, keysSignature, ensure]);

  return { loads, retry, ensure };
}
