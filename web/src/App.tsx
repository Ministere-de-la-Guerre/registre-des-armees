import { useEffect, useRef, useState } from "react";
import { Builder } from "./components/Builder";
import { CorpsSelect, type CorpsUiState } from "./components/CorpsSelect";
import { loadCorpsIndex, loadFaction } from "./data/load";
import type { CorpsEntry, CorpsIndex, FactionRoster } from "./domain/types";

export default function App() {
  const [index, setIndex] = useState<CorpsIndex | null>(null);
  const [selected, setSelected] = useState<CorpsEntry | null>(null);
  const [roster, setRoster] = useState<FactionRoster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingRoster, setLoadingRoster] = useState(false);
  // Corps-selection state persists across builder visits (scroll + filters).
  const [corpsUi, setCorpsUi] = useState<CorpsUiState>({ search: "", side: "all", acOnly: false });
  const corpsScroll = useRef(0);

  useEffect(() => {
    loadCorpsIndex()
      .then(setIndex)
      .catch((e) => setError(String(e)));
  }, []);

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

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">⚜ Registre des Armées</span>
        <span style={{ fontSize: 12, opacity: 0.8 }}>NTW3 Army Builder</span>
        <span className="spacer" />
        {selected && <span style={{ fontSize: 12, opacity: 0.85 }}>{selected.name}</span>}
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
    </div>
  );
}
