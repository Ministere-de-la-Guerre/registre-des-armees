// Topbar "Save offline" control for the currently open faction (web/PWA only).
// Pulls the faction JSON + its icons into the Cache API so the whole build flow
// works with no connection. Shows progress while downloading and a ✓ once cached.
import { useEffect, useState } from "react";
import type { FactionRoster } from "../domain/types";
import { downloadFactionOffline, isFactionOffline, offlineSupported } from "../state/offline";

type State = "checking" | "idle" | "saving" | "saved" | "error";

export function FactionOfflineButton({ roster }: { roster: FactionRoster }) {
  const [state, setState] = useState<State>("checking");
  const [pct, setPct] = useState(0);

  useEffect(() => {
    let alive = true;
    setState("checking");
    isFactionOffline(roster.factionKey)
      .then((saved) => {
        if (alive) setState(saved ? "saved" : "idle");
      })
      .catch(() => {
        // Cache API refused (quota / storage blocked): don't wedge the button at
        // "checking" — offer the save, which reports its own error if it fails.
        if (alive) setState("idle");
      });
    return () => {
      alive = false;
    };
  }, [roster.factionKey]);

  if (!offlineSupported()) return null;

  const save = async () => {
    setState("saving");
    setPct(0);
    try {
      const res = await downloadFactionOffline(roster, ({ done, total }) =>
        setPct(total ? Math.round((done / total) * 100) : 100),
      );
      setState(res.ok ? "saved" : "error");
    } catch {
      // downloadFactionOffline is written never to reject, but guard anyway so an
      // unexpected throw can't pin the button disabled at "Saving …" forever.
      setState("error");
    }
  };

  const label =
    state === "saved"
      ? "✓ Offline"
      : state === "saving"
        ? `Saving ${pct}%`
        : state === "error"
          ? "Retry offline"
          : "⤓ Save offline";

  return (
    <button
      className={`btn small${state === "saved" ? " gold" : ""}`}
      onClick={save}
      disabled={state === "saving" || state === "checking"}
      title="Download this faction for offline use"
    >
      {label}
    </button>
  );
}
