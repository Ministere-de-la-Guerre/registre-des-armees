import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FactionRoster } from "../domain/types";
import { useConfirm } from "./useConfirm";
import { NamePromptModal } from "./NamePromptModal";
import { isTabletTouch, useCoarsePointer } from "./useCoarsePointer";
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
import type { StorageResult } from "../state/storage";

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
  const confirm = useConfirm();
  const repo = useMemo(() => new BuildRepository(), []);
  // The latest props, for callbacks that continue after a confirm dialog or a file read.
  const latest = useRef({ current, dirty, roster, loaded });
  latest.current = { current, dirty, roster, loaded };
  const [saves, setSaves] = useState<SavedBuild[]>([]);
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const coarse = useCoarsePointer();
  // On touch/tablet the Load menu and the name prompt are fixed overlays that live
  // inside the header's momentum-scroll container. iOS clips position:fixed
  // descendants of a `-webkit-overflow-scrolling: touch` scroller, which hid them
  // entirely — so portal them to <body> to escape that clip. Desktop keeps them
  // inline (the dropdown is absolute-anchored to its button; byte-identical).
  const overlaysPortal = coarse || isTabletTouch();
  const renderOverlay = (node: ReactNode) => (overlaysPortal ? createPortal(node, document.body) : node);

  // Dismiss the Load menu on a tap/click outside it or Escape. On touch the menu
  // is a bottom sheet whose trigger button can be scrolled out of the header, so
  // this is the reliable way to close it (and it tidies the desktop dropdown too).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      // The menu may be portaled out of rootRef, so treat a tap inside either the
      // trigger row or the menu itself as "inside".
      const target = e.target as Element;
      // A confirm dialog opened from the menu is outside it, but is not a dismissal.
      if (target.closest?.(".modal-backdrop")) return;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="alertdialog"]')) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // In-app name prompt (Save As / Rename); see NamePromptModal for why not window.prompt.
  const [namePrompt, setNamePrompt] = useState<{
    title: string;
    initial: string;
    submitLabel: string;
    onSubmit: (value: string) => void;
  } | null>(null);

  const askName = (opts: { title: string; initial: string; submitLabel: string; onSubmit: (value: string) => void }) =>
    setNamePrompt(opts);

  const refresh = () => setSaves(repo.list());
  useEffect(refresh, [repo]);

  // Only surface builds saved for the corps currently open.
  const corpsSaves = saves.filter((s) => s.factionKey === roster.factionKey);

  const persistAndReport = (result: StorageResult, okMsg: string) => {
    refresh();
    onMessage(result.ok ? (result.warning ? `${okMsg} ${result.warning}` : okMsg) : `Not saved: ${result.error ?? "storage error"}.`);
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

  const saveAsName = async (name: string) => {
    // Scope the duplicate-name check to this corps so the same name can exist
    // independently under another corps (each loads its own build).
    const existing = repo.findByName(name, current.factionKey);
    if (existing) {
      if (!(await confirm({ message: `A build named “${name}” already exists for this corps. Overwrite it?`, confirmLabel: "Overwrite", danger: true }))) return;
      const saved = buildToSaved(latest.current.current, { id: existing.id, name: existing.name, createdAt: existing.createdAt });
      if (persistAndReport(repo.save(saved), `Overwrote “${saved.name}”.`)) onSaved(saved);
      return;
    }
    const saved = buildToSaved(current, { name });
    if (persistAndReport(repo.save(saved), `Saved “${saved.name}”.`)) onSaved(saved);
  };

  const doLoad = async (saved: SavedBuild) => {
    if (saved.factionKey !== roster.factionKey) {
      onMessage(`“${saved.name}” is for a different corps. Open that corps first.`);
      return;
    }
    if (dirty && !(await confirm({ message: "Discard unsaved changes and load this build?", confirmLabel: "Discard changes", danger: true }))) return;
    onLoaded(resolveSavedBuild(saved, latest.current.roster), saved);
    setOpen(false);
  };

  const doExport = () => {
    const saved = buildToSaved(current, { id: loaded?.id, name: loaded?.name ?? roster.armyCorpsName, createdAt: loaded?.createdAt });
    const blob = new Blob([exportBuildJson(saved)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${saved.name.replace(/[^\w-]+/g, "_")}.json`;
    // Append to the DOM and defer the revoke: clicking a detached anchor and
    // revoking synchronously is a no-op on some browsers (matches downloadBlob in
    // exportBuildImage.ts and OfflinePanel.downloadJson).
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  const doImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const saved = importBuildJson(String(reader.result));
      if (!saved) {
        onMessage("Import failed: not a valid build file.");
        return;
      }
      // Import upserts by id: re-importing an older export of a build you have
      // since edited and re-saved would silently clobber the newer stored save.
      // Confirm before overwriting an existing save (Save As confirms too).
      const existing = repo.get(saved.id);
      if (existing && !(await confirm({ message: `This will overwrite the saved build “${existing.name}” with the imported file. Continue?`, confirmLabel: "Overwrite", danger: true }))) {
        return;
      }
      // Importing into the open corps replaces the on-screen build, discarding
      // unsaved edits — confirm just like Load does.
      // Read the roster and dirty flag now: they may have changed during the dialog above.
      const loadsIntoCurrent = saved.factionKey === latest.current.roster.factionKey;
      if (loadsIntoCurrent && latest.current.dirty && !(await confirm({ message: "Discard unsaved changes and load the imported build?", confirmLabel: "Discard changes", danger: true }))) {
        return;
      }
      persistAndReport(repo.save(saved), `Imported “${saved.name}”.`);
      if (loadsIntoCurrent) onLoaded(resolveSavedBuild(saved, latest.current.roster), saved);
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
      {open &&
        renderOverlay(
        <div className="saves-menu" ref={menuRef}>
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
                      onSubmit: async (n) => {
                        // Guard against silently creating two saves that share a
                        // display name in this corps (Save As already checks this).
                        const clash = repo.findByName(n, s.factionKey);
                        if (clash && clash.id !== s.id && !(await confirm({ message: `Another build named “${n}” already exists for this corps. Keep both with the same name?`, confirmLabel: "Keep both" }))) {
                          return;
                        }
                        persistAndReport(repo.rename(s.id, n), `Renamed to “${n}”.`);
                        if (latest.current.loaded?.id === s.id) onSaved({ ...s, name: n });
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
                  onClick={async () => {
                    if (await confirm({ message: `Delete “${s.name}”?`, confirmLabel: "Delete", danger: true })) persistAndReport(repo.remove(s.id), `Deleted “${s.name}”.`);
                  }}
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>,
        )}
      {namePrompt && <NamePromptModal {...namePrompt} onClose={() => setNamePrompt(null)} />}
    </div>
  );
}
