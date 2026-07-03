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
  const rootRef = useRef<HTMLDivElement>(null);

  // Dismiss the Load menu on a tap/click outside it or Escape. On touch the menu
  // is a bottom sheet whose trigger button can be scrolled out of the header, so
  // this is the reliable way to close it (and it tidies the desktop dropdown too).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // In-app name prompt. Electron does not support window.prompt(), so naming a
  // build (Save As / Rename) must go through this modal instead.
  const [namePrompt, setNamePrompt] = useState<{
    title: string;
    submitLabel: string;
    onSubmit: (value: string) => void;
  } | null>(null);
  const [nameValue, setNameValue] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  const askName = (opts: { title: string; initial: string; submitLabel: string; onSubmit: (value: string) => void }) => {
    setNameValue(opts.initial);
    setNamePrompt({ title: opts.title, submitLabel: opts.submitLabel, onSubmit: opts.onSubmit });
  };
  const closeNamePrompt = () => setNamePrompt(null);
  const submitNamePrompt = () => {
    const value = nameValue.trim();
    if (!value) return;
    const handler = namePrompt?.onSubmit;
    setNamePrompt(null);
    handler?.(value);
  };

  useEffect(() => {
    if (namePrompt) nameInputRef.current?.focus();
  }, [namePrompt]);

  const refresh = () => setSaves(repo.list());
  useEffect(refresh, [repo]);

  // Only surface builds saved for the corps currently open.
  const corpsSaves = saves.filter((s) => s.factionKey === roster.factionKey);

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
    askName({
      title: "Save build as",
      initial: loaded ? `${loaded.name} (copy)` : roster.armyCorpsName,
      submitLabel: "Save",
      onSubmit: saveAsName,
    });
  };

  const saveAsName = (name: string) => {
    // Scope the duplicate-name check to this corps so the same name can exist
    // independently under another corps (each loads its own build).
    const existing = repo.findByName(name, current.factionKey);
    if (existing) {
      if (!window.confirm(`A build named “${name}” already exists for this corps. Overwrite it?`)) return;
      const saved = buildToSaved(current, { id: existing.id, name: existing.name, createdAt: existing.createdAt });
      if (persistAndReport(repo.save(saved), `Overwrote “${saved.name}”.`)) onSaved(saved);
      return;
    }
    const saved = buildToSaved(current, { name });
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
    <div ref={rootRef} style={{ display: "flex", gap: 6, alignItems: "center", position: "relative" }}>
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
          {corpsSaves.length === 0 ? (
            <div style={{ padding: 10, fontSize: 13, color: "var(--text-soft)" }}>No saved builds for this corps yet.</div>
          ) : (
            corpsSaves.map((s) => (
              <div className="saves-row" key={s.id}>
                <div style={{ flex: 1, fontSize: 13 }}>
                  <strong>{s.name}</strong>
                  <div style={{ fontSize: 11, color: "var(--text-soft)" }}>
                    {s.armyCorpsName || s.factionKey} · {new Date(s.updatedAt).toLocaleString()}
                  </div>
                </div>
                <button className="btn small" onClick={() => doLoad(s)}>Load</button>
                <button
                  className="btn small"
                  onClick={() =>
                    askName({
                      title: "Rename build",
                      initial: s.name,
                      submitLabel: "Rename",
                      onSubmit: (n) => {
                        persistAndReport(repo.rename(s.id, n), `Renamed to “${n}”.`);
                        if (loaded?.id === s.id) onSaved({ ...s, name: n });
                      },
                    })
                  }
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
      {namePrompt && (
        <div className="modal-backdrop" onMouseDown={closeNamePrompt}>
          <div
            className="modal"
            style={{ maxWidth: 420 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <strong>{namePrompt.title}</strong>
            </div>
            <div className="modal-body">
              <input
                ref={nameInputRef}
                type="text"
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitNamePrompt();
                  else if (e.key === "Escape") closeNamePrompt();
                }}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "8px 10px",
                  fontSize: 14,
                  background: "var(--bg-2)",
                  color: "var(--text)",
                  border: "1px solid var(--line-2)",
                  borderRadius: 6,
                }}
              />
              <div className="modal-actions" style={{ marginTop: 12, justifyContent: "flex-end" }}>
                <button className="btn small" onClick={closeNamePrompt}>
                  Cancel
                </button>
                <button className="btn small primary" onClick={submitNamePrompt} disabled={!nameValue.trim()}>
                  {namePrompt.submitLabel}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
