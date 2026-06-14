import { useEffect, useMemo, useRef, useState } from "react";
import type { FactionRoster } from "../domain/types";
import {
  BuildRepository,
  type CurrentBuild,
  type LoadResult,
  type SavedBuild,
  buildToSaved,
  exportBuildJson,
  importBuildJson,
  resolveSavedBuild,
} from "../state/saves";

export function SaveLoadBar({
  roster,
  current,
  loaded,
  dirty,
  onLoaded,
  onSaved,
  onMessage,
}: {
  roster: FactionRoster;
  current: CurrentBuild;
  loaded: SavedBuild | null;
  dirty: boolean;
  onLoaded: (result: LoadResult, saved: SavedBuild) => void;
  onSaved: (saved: SavedBuild) => void;
  onMessage: (msg: string) => void;
}) {
  const repo = useMemo(() => new BuildRepository(), []);
  const [saves, setSaves] = useState<SavedBuild[]>([]);
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = () => setSaves(repo.list());
  useEffect(refresh, [repo]);

  const persistAndReport = (result: { ok: boolean; error?: string }, okMsg: string) => {
    refresh();
    onMessage(result.ok ? okMsg : `Not saved: ${result.error ?? "storage error"}.`);
    return result.ok;
  };

  // Save changes to the currently loaded build (or Save As when none loaded).
  const doSave = () => {
    if (!loaded) {
      doSaveAs();
      return;
    }
    const saved = buildToSaved(current, { id: loaded.id, name: loaded.name, createdAt: loaded.createdAt });
    if (persistAndReport(repo.save(saved), `Saved “${saved.name}”.`)) onSaved(saved);
  };

  const doSaveAs = () => {
    const name = window.prompt("Name this build:", loaded ? `${loaded.name} (copy)` : roster.armyCorpsName);
    if (!name || !name.trim()) return;
    const existing = repo.findByName(name);
    if (existing) {
      if (!window.confirm(`A build named “${name}” already exists. Overwrite it?`)) return;
      const saved = buildToSaved(current, { id: existing.id, name: existing.name, createdAt: existing.createdAt });
      if (persistAndReport(repo.save(saved), `Overwrote “${saved.name}”.`)) onSaved(saved);
      return;
    }
    const saved = buildToSaved(current, { name: name.trim() });
    if (persistAndReport(repo.save(saved), `Saved “${saved.name}”.`)) onSaved(saved);
  };

  const doLoad = (saved: SavedBuild) => {
    if (saved.factionKey !== roster.factionKey) {
      onMessage(`“${saved.name}” is for a different corps. Open that corps first.`);
      return;
    }
    if (dirty && !window.confirm("Discard unsaved changes and load this build?")) return;
    onLoaded(resolveSavedBuild(saved, roster), saved);
    setOpen(false);
  };

  const doExport = () => {
    const saved = buildToSaved(current, { id: loaded?.id, name: loaded?.name ?? roster.armyCorpsName, createdAt: loaded?.createdAt });
    const blob = new Blob([exportBuildJson(saved)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${saved.name.replace(/[^\w-]+/g, "_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const saved = importBuildJson(String(reader.result));
      if (!saved) {
        onMessage("Import failed: not a valid build file.");
        return;
      }
      persistAndReport(repo.save(saved), `Imported “${saved.name}”.`);
      if (saved.factionKey === roster.factionKey) onLoaded(resolveSavedBuild(saved, roster), saved);
      else onMessage(`Imported “${saved.name}” for another corps. Open it to load.`);
    };
    reader.readAsText(file);
  };

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", position: "relative" }}>
      <button className={`btn small ${dirty ? "primary" : ""}`} onClick={doSave} title={loaded ? "Save changes" : "Save"}>
        {dirty ? "Save*" : "Save"}
      </button>
      <button className="btn small" onClick={doSaveAs}>
        Save As
      </button>
      <button className="btn small" onClick={() => { refresh(); setOpen((o) => !o); }}>
        Load ▾
      </button>
      <button className="btn small" onClick={doExport}>
        Export
      </button>
      <button className="btn small" onClick={() => fileRef.current?.click()}>
        Import
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) doImport(f);
          e.target.value = "";
        }}
      />
      {open && (
        <div className="saves-menu">
          {!repo.persistent && (
            <div className="saves-warning">Storage unavailable — saves will not persist this session.</div>
          )}
          {saves.length === 0 ? (
            <div style={{ padding: 10, fontSize: 13, color: "var(--text-soft)" }}>No saved builds yet.</div>
          ) : (
            saves.map((s) => (
              <div className="saves-row" key={s.id}>
                <div style={{ flex: 1, fontSize: 13 }}>
                  <strong>{s.name}</strong>
                  <div style={{ fontSize: 11, color: "var(--text-soft)" }}>
                    {s.armyCorpsName || s.factionKey} · {new Date(s.updatedAt).toLocaleString()}
                    {s.factionKey !== roster.factionKey ? " · other corps" : ""}
                  </div>
                </div>
                <button className="btn small" onClick={() => doLoad(s)}>Load</button>
                <button
                  className="btn small"
                  onClick={() => {
                    const n = window.prompt("Rename build:", s.name);
                    if (n && n.trim()) {
                      persistAndReport(repo.rename(s.id, n.trim()), `Renamed to “${n.trim()}”.`);
                      if (loaded?.id === s.id) onSaved({ ...s, name: n.trim() });
                    }
                  }}
                >
                  Rename
                </button>
                <button
                  className="btn small"
                  onClick={() => {
                    const { result } = repo.duplicate(s.id);
                    persistAndReport(result, `Duplicated “${s.name}”.`);
                  }}
                >
                  Duplicate
                </button>
                <button
                  className="btn small"
                  onClick={() => {
                    if (window.confirm(`Delete “${s.name}”?`)) persistAndReport(repo.remove(s.id), `Deleted “${s.name}”.`);
                  }}
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
