import { useEffect, useMemo, useRef, useState } from "react";
import { Builder } from "./components/Builder";
import { CorpsSelect, type CorpsUiState } from "./components/CorpsSelect";
import { FactionOfflineButton } from "./components/FactionOfflineButton";
import { OfflinePanel } from "./components/OfflinePanel";
import { ReplayScreen } from "./components/ReplayScreen";
import { UpdateToast } from "./components/UpdateToast";
import { loadCorpsIndex, loadFaction } from "./data/load";
import { applyUpdate, isWebTarget, registerPwa } from "./pwa";
import { isCoarsePointer, isTabletTouch, useCoarsePointer } from "./components/useCoarsePointer";
import type { CorpsEntry, CorpsIndex, FactionRoster } from "./domain/types";
import type { SavedBuild } from "./state/saves";
import { type ReplaySession, emptyReplaySession } from "./state/replayBuild";

export default function App() {
  const [index, setIndex] = useState<CorpsIndex | null>(null);
  const [selected, setSelected] = useState<CorpsEntry | null>(null);
  const [roster, setRoster] = useState<FactionRoster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingRoster, setLoadingRoster] = useState(false);
  // Corps-selection state persists across builder visits (scroll + filters).
  const [corpsUi, setCorpsUi] = useState<CorpsUiState>({ search: "", side: "all", acOnly: false, towOnly: false });
  const corpsScroll = useRef(0);
  // Which of the two entry screens is showing behind the builder: the corps
  // picker or the replay build checker. `pendingSaved` seeds the builder when an
  // army is opened from a replay; `returnToReplay` sends Back there afterwards.
  const [screen, setScreen] = useState<"corps" | "replay">("corps");
  const [pendingSaved, setPendingSaved] = useState<SavedBuild | null>(null);
  const [returnToReplay, setReturnToReplay] = useState(false);
  // The loaded replay lives here, not in ReplayScreen, so visiting the builder
  // (which unmounts that screen) does not discard the parsed file.
  const [replaySession, setReplaySession] = useState<ReplaySession>(emptyReplaySession);

  // PWA plumbing (web target only; a no-op inside the Electron desktop app).
  const [needRefresh, setNeedRefresh] = useState(false);
  const [showOffline, setShowOffline] = useState(false);
  const web = isWebTarget();

  // Touch-only collapsible chrome: a chevron tab hides the top bars (brand +
  // faction controls) so the unit grid can own the viewport, then re-expands them.
  // Never rendered on desktop / Electron (fine pointer). Defaults to collapsed in
  // short landscape (where the bars otherwise eat the screen), expanded in portrait.
  const coarse = useCoarsePointer();
  // iPads report a fine pointer (see isTabletTouch), so `coarse` misses them. This
  // flag is stable per session and only extends the touch header-scroller to iPad;
  // the rest of the mobile chrome deliberately still keys off `coarse`.
  const tabletTouch = useMemo(() => isTabletTouch(), []);
  const [chromeCollapsed, setChromeCollapsed] = useState(
    () => isCoarsePointer() && window.matchMedia("(orientation: landscape) and (max-height: 500px)").matches,
  );

  useEffect(() => {
    loadCorpsIndex()
      .then(setIndex)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    registerPwa({ onNeedRefresh: () => setNeedRefresh(true) });
  }, []);

  // factionKey → display name, for the offline panel's downloaded-factions list.
  const factionName = useMemo(() => {
    const map = new Map<string, string>();
    for (const side of index?.sides ?? [])
      for (const theatre of side.theatres) for (const corps of theatre.corps) map.set(corps.factionKey, corps.name);
    return (key: string) => map.get(key) ?? key;
  }, [index]);

  // Every distinct faction key in the corps picker — the set the "Download all"
  // offline action loops over.
  const allFactionKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const side of index?.sides ?? [])
      for (const theatre of side.theatres) for (const corps of theatre.corps) keys.add(corps.factionKey);
    return [...keys];
  }, [index]);

  const openCorps = (entry: CorpsEntry, saved: SavedBuild | null = null) => {
    setSelected(entry);
    setRoster(null);
    setError(null);
    setPendingSaved(saved);
    setLoadingRoster(true);
    loadFaction(entry.factionKey)
      .then(setRoster)
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingRoster(false));
  };

  /** Open one army out of a replay in the full builder, then come back here. */
  const openFromReplay = (entry: CorpsEntry, saved: SavedBuild) => {
    setReturnToReplay(true);
    openCorps(entry, saved);
  };

  const back = () => {
    setSelected(null);
    setRoster(null);
    setPendingSaved(null);
    setScreen(returnToReplay ? "replay" : "corps");
    setReturnToReplay(false);
  };

  const builderActive = !!(selected && roster);
  const collapsed = coarse && builderActive && chromeCollapsed;

  return (
    <div className={`app${collapsed ? " chrome-collapsed" : ""}${tabletTouch ? " tablet-touch" : ""}`}>
      {coarse && builderActive && (
        <button
          type="button"
          className="chrome-toggle"
          aria-expanded={!chromeCollapsed}
          aria-label={chromeCollapsed ? "Show controls" : "Hide controls"}
          onClick={() => setChromeCollapsed((c) => !c)}
        >
          {chromeCollapsed ? "▾ Controls" : "▴ Hide"}
        </button>
      )}
      <div className="topbar">
        <span className="brand">⚜ Registre des Armées</span>
        <span className="topbar-sub" style={{ fontSize: 12, opacity: 0.8 }}>NTW3 Army Builder</span>
        <span className="spacer" />
        {selected && <span style={{ fontSize: 12, opacity: 0.85 }}>{selected.name}</span>}
        {!selected && screen === "corps" && (
          <button
            className="btn ghost small"
            onClick={() => setScreen("replay")}
            title="Read army builds from a replay — beta feature, still being tested"
          >
            ⛊ Replay builds <span className="tag beta">Beta</span>
          </button>
        )}
        {web && roster && <FactionOfflineButton roster={roster} />}
        {web && (
          <button className="btn ghost small" onClick={() => setShowOffline(true)} title="Offline & storage">
            ⤓ Offline
          </button>
        )}
      </div>

      {error && <div className="error-box">⚠ {error}</div>}

      {!selected && screen === "replay" && (
        <ReplayScreen
          corpsIndex={index}
          session={replaySession}
          onSessionChange={setReplaySession}
          onBack={() => setScreen("corps")}
          onOpenInBuilder={openFromReplay}
        />
      )}

      {!selected && screen === "corps" && !error &&
        (index ? (
          <CorpsSelect
            index={index}
            ui={corpsUi}
            onUiChange={setCorpsUi}
            initialScroll={corpsScroll.current}
            onScrollChange={(v) => {
              corpsScroll.current = v;
            }}
            onSelect={(entry) => openCorps(entry)}
          />
        ) : (
          <div className="loading">Loading corps…</div>
        ))}

      {selected && loadingRoster && <div className="loading">Loading {selected.name}…</div>}

      {selected && roster && (
        <Builder
          roster={roster}
          postFlag={selected.postSelectionFlag ?? selected.flag}
          onBack={back}
          initialSaved={pendingSaved}
        />
      )}

      {showOffline && (
        <OfflinePanel
          onClose={() => setShowOffline(false)}
          factionName={factionName}
          allFactionKeys={allFactionKeys}
        />
      )}
      {needRefresh && <UpdateToast onReload={applyUpdate} onDismiss={() => setNeedRefresh(false)} />}
    </div>
  );
}
