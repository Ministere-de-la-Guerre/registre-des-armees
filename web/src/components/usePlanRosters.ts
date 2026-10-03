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
 *  `retry(key)`, so a missing file can't loop. */
export function usePlanRosters(factionKeys: readonly string[], enabled: boolean) {
  const [loads, setLoads] = useState<ReadonlyMap<string, RosterLoad>>(() => new Map());
  const requested = useRef(new Set<string>());

  const load = useCallback((key: string) => {
    requested.current.add(key);
    setLoads((m) => new Map(m).set(key, { status: "loading" }));
    loadFaction(key)
      .then((roster) => setLoads((m) => new Map(m).set(key, { status: "ready", roster })))
      .catch((e) => setLoads((m) => new Map(m).set(key, { status: "error", error: String(e) })));
  }, []);

  const keysSignature = factionKeys.join("|");
  useEffect(() => {
    if (!enabled) return;
    for (const key of keysSignature ? keysSignature.split("|") : []) {
      if (!requested.current.has(key)) load(key);
    }
  }, [enabled, keysSignature, load]);

  return { loads, retry: load };
}
