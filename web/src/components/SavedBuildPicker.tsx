import { useEffect, useMemo, useState } from "react";
import { matchesSearch } from "../domain/searchText";
import { BuildRepository, type SavedBuild } from "../state/saves";

/** Pick one of the player's saved builds, from any corps (newest first). The caller
 *  decides what picking means — the planner copies it into a slot. */
export function SavedBuildPicker({
  corpsName,
  onPick,
  onClose,
}: {
  /** Display name for a faction key (the corps index's name, else the saved one). */
  corpsName: (build: SavedBuild) => string;
  onPick: (build: SavedBuild) => void;
  onClose: () => void;
}) {
  const repo = useMemo(() => new BuildRepository(), []);
  const builds = useMemo(() => repo.list(), [repo]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const q = search.trim();
  const shown = useMemo(
    () => (q ? builds.filter((b) => matchesSearch(`${b.name} ${corpsName(b)}`, q)) : builds),
    [builds, q, corpsName],
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal plan-picker" role="dialog" aria-modal="true" aria-label="Load saved build" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong style={{ flex: 1, alignSelf: "center" }}>Load saved build</strong>
          <button className="btn small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <input
            type="search"
            placeholder="Search build name or corps…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
            style={{ width: "100%", marginBottom: 10 }}
          />
          {!repo.persistent && (
            <div className="saves-warning">Storage unavailable — no saved builds can be listed this session.</div>
          )}
          {shown.length === 0 ? (
            <div className="plan-empty-note">
              {builds.length === 0 ? "You have no saved builds yet. Save one from the builder." : "No saved build matches."}
            </div>
          ) : (
            shown.map((b) => (
              <div className="saves-row" key={b.id}>
                <div style={{ flex: 1, fontSize: 13, minWidth: 0 }}>
                  <strong>{b.name}</strong>
                  <div style={{ fontSize: 11, color: "var(--text-soft)" }}>
                    {corpsName(b)} · {b.instances.length + (b.staffSlotUnitKey ? 1 : 0)} cards ·{" "}
                    {new Date(b.updatedAt).toLocaleDateString()}
                  </div>
                </div>
                <button className="btn small primary" onClick={() => onPick(b)}>
                  Use
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
