import { useEffect, useMemo, useRef, useState } from "react";
import { Builder } from "./components/Builder";
import { CorpsSelect, type CorpsUiState } from "./components/CorpsSelect";
import { FactionOfflineButton } from "./components/FactionOfflineButton";
import { OfflinePanel } from "./components/OfflinePanel";
import { UpdateToast } from "./components/UpdateToast";
import { loadCorpsIndex, loadFaction } from "./data/load";
import { applyUpdate, isWebTarget, registerPwa } from "./pwa";
import { isCoarsePointer, useCoarsePointer } from "./components/useCoarsePointer";
import type { CorpsEntry, CorpsIndex, FactionRoster } from "./domain/types";

export default function App() {
  const [index, setIndex] = useState<CorpsIndex | null>(null);
  const [selected, setSelected] = useState<CorpsEntry | null>(null);
  const [roster, setRoster] = useState<FactionRoster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingRoster, setLoadingRoster] = useState(false);
  // Corps-selection state persists across builder visits (scroll + filters).
  const [corpsUi, setCorpsUi] = useState<CorpsUiState>({ search: "", side: "all", acOnly: false, towOnly: false });
  const corpsScroll = useRef(0);

  // PWA plumbing (web target only; a no-op inside the Electron desktop app).
  const [needRefresh, setNeedRefresh] = useState(false);
  const [showOffline, setShowOffline] = useState(false);
  const web = isWebTarget();

  // Touch-only collapsible chrome: a chevron tab hides the top bars (brand +
  // faction controls) so the unit grid can own the viewport, then re-expands them.
  // Never rendered on desktop / Electron (fine pointer). Defaults to collapsed in
  // short landscape (where the bars otherwise eat the screen), expanded in portrait.
  const coarse = useCoarsePointer();
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

  const openCorps = (entry: CorpsEntry) => {
    setSelected(entry);
    setRoster(null);
    setError(null);
    setLoadingRoster(true);
    loadFaction(entry.factionKey)
      .then(setRoster)
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingRoster(false));
  };

  const back = () => {
    setSelected(null);
    setRoster(null);
  };

  const builderActive = !!(selected && roster);
  const collapsed = coarse && builderActive && chromeCollapsed;

  return (
    <div className={`app${collapsed ? " chrome-collapsed" : ""}`}>
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
        {web && roster && <FactionOfflineButton roster={roster} />}
        {web && (
          <button className="btn ghost small" onClick={() => setShowOffline(true)} title="Offline & storage">
            ⤓ Offline
          </button>
        )}
      </div>

      {error && <div className="error-box">⚠ {error}</div>}

      {!selected && !error &&
        (index ? (
          <CorpsSelect
            index={index}
            ui={corpsUi}
            onUiChange={setCorpsUi}
            initialScroll={corpsScroll.current}
            onScrollChange={(v) => {
              corpsScroll.current = v;
            }}
            onSelect={openCorps}
          />
        ) : (
          <div className="loading">Loading corps…</div>
        ))}

      {selected && loadingRoster && <div className="loading">Loading {selected.name}…</div>}

      {selected && roster && (
        <Builder roster={roster} postFlag={selected.postSelectionFlag ?? selected.flag} onBack={back} />
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
