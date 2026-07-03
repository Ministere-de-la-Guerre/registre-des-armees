// Offline & storage panel (web/PWA only). Three jobs, per the mobile plan:
//   1. surface + request persistent storage (iOS evicts idle site data),
//   2. show which factions are downloaded for offline use and let them be freed,
//   3. export / import the whole save set as a file (the durable backup).
import { useEffect, useRef, useState } from "react";
import { loadFaction } from "../data/load";
import { BuildRepository, exportAllBuilds, importAllBuilds } from "../state/saves";
import {
  downloadAllFactionsOffline,
  isStoragePersisted,
  listOfflineFactions,
  offlineSupported,
  removeFactionOffline,
  requestPersistentStorage,
  storageEstimate,
  type DownloadAllProgress,
  type StorageUsage,
} from "../state/offline";

interface OfflinePanelProps {
  onClose: () => void;
  factionName: (key: string) => string;
  /** Every distinct faction key, for the "Download all" offline action. */
  allFactionKeys: string[];
}

interface DownloadAllState {
  progress: DownloadAllProgress;
  cancelRequested: boolean;
}

function mb(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function OfflinePanel({ onClose, factionName, allFactionKeys }: OfflinePanelProps) {
  const repoRef = useRef<BuildRepository>();
  if (!repoRef.current) repoRef.current = new BuildRepository();
  const repo = repoRef.current;

  const [persisted, setPersisted] = useState(false);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [offlineFactions, setOfflineFactions] = useState<string[]>([]);
  const [saveCount, setSaveCount] = useState(repo.list().length);
  const [status, setStatus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [downloadAll, setDownloadAll] = useState<DownloadAllState | null>(null);
  const cancelRef = useRef(false);

  const refresh = () => {
    void isStoragePersisted().then(setPersisted);
    void storageEstimate().then(setUsage);
    void listOfflineFactions().then((f) => setOfflineFactions(f.sort()));
    setSaveCount(repo.list().length);
  };

  useEffect(refresh, [repo]);

  const keepOnDevice = async () => {
    const ok = await requestPersistentStorage();
    setPersisted(ok);
    setStatus(ok ? "Storage will be kept on this device." : "The browser declined persistent storage.");
  };

  const freeFaction = async (key: string) => {
    await removeFactionOffline(key);
    setOfflineFactions((prev) => prev.filter((k) => k !== key));
  };

  const remaining = allFactionKeys.filter((k) => !offlineFactions.includes(k)).length;

  const startDownloadAll = async () => {
    cancelRef.current = false;
    setStatus(null);
    // Persist first: without it iOS can evict the whole cache we're about to fill.
    await requestPersistentStorage().then(setPersisted);
    setDownloadAll({ progress: { index: 0, total: allFactionKeys.length, factionKey: "" }, cancelRequested: false });
    const result = await downloadAllFactionsOffline(allFactionKeys, loadFaction, {
      onProgress: (progress) => setDownloadAll((s) => ({ progress, cancelRequested: s?.cancelRequested ?? false })),
      shouldCancel: () => cancelRef.current,
    });
    setDownloadAll(null);
    refresh();
    const parts = [`${result.downloaded} downloaded`];
    if (result.skipped) parts.push(`${result.skipped} already offline`);
    if (result.failed.length)
      parts.push(`${result.failed.length} failed (${result.failed.map((f) => factionName(f.factionKey)).join(", ")})`);
    setStatus(`${result.cancelled ? "Cancelled — " : "Done — "}${parts.join(", ")}.`);
  };

  const requestCancel = () => {
    cancelRef.current = true;
    setDownloadAll((s) => (s ? { ...s, cancelRequested: true } : s));
  };

  const doExport = () => {
    downloadJson(`registre-saves-${new Date().toISOString().slice(0, 10)}.json`, exportAllBuilds(repo));
    setStatus(`Exported ${saveCount} saved build${saveCount === 1 ? "" : "s"}.`);
  };

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const summary = importAllBuilds(repo, await file.text());
    if (!summary) {
      setStatus("That file couldn't be read as a saves backup.");
      return;
    }
    setSaveCount(repo.list().length);
    setStatus(`Imported ${summary.imported} build${summary.imported === 1 ? "" : "s"}${summary.skipped ? `, skipped ${summary.skipped}` : ""}.`);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 style={{ color: "var(--gold-bright)" }}>Offline &amp; storage</h3>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          {!offlineSupported() && (
            <p className="rot-note">Offline caching isn't available in this browser.</p>
          )}

          <div className="section-title">On-device storage</div>
          <p className="rot-note">
            {usage ? (
              <>
                Using <strong>{mb(usage.usage)}</strong>
                {usage.quota ? <> of about {mb(usage.quota)} available</> : null}.
              </>
            ) : (
              "Storage estimate unavailable."
            )}
          </p>
          <div className="offline-row">
            <span className={persisted ? "tag good" : "tag"}>{persisted ? "Kept on device" : "Evictable"}</span>
            {!persisted && (
              <button className="btn small" onClick={keepOnDevice}>
                Keep on device
              </button>
            )}
          </div>

          {offlineSupported() && allFactionKeys.length > 0 && (
            <>
              <div className="section-title">Download everything</div>
              {downloadAll ? (
                <div className="download-all-run">
                  <p className="rot-note">
                    Faction {downloadAll.progress.index} / {downloadAll.progress.total}
                    {downloadAll.progress.factionKey ? ` — ${factionName(downloadAll.progress.factionKey)}` : ""}
                    {downloadAll.progress.perFaction
                      ? ` · ${Math.round(
                          (downloadAll.progress.perFaction.done / Math.max(1, downloadAll.progress.perFaction.total)) * 100,
                        )}%`
                      : ""}
                  </p>
                  <div className="download-bar">
                    <div
                      className="download-bar-fill"
                      style={{ width: `${Math.round((downloadAll.progress.index / Math.max(1, downloadAll.progress.total)) * 100)}%` }}
                    />
                  </div>
                  <button className="btn small" onClick={requestCancel} disabled={downloadAll.cancelRequested}>
                    {downloadAll.cancelRequested ? "Finishing current…" : "Cancel"}
                  </button>
                </div>
              ) : (
                <>
                  <p className="rot-note">
                    Make every faction usable offline in one go — {remaining} of {allFactionKeys.length} still to
                    download. This is a large download (all unit icons for every corps) and may take several minutes;
                    factions already saved are skipped, so you can safely stop and resume.
                  </p>
                  <button className="btn small" onClick={() => void startDownloadAll()} disabled={remaining === 0}>
                    {remaining === 0 ? "✓ All factions offline" : `Download all factions (${remaining})`}
                  </button>
                </>
              )}
            </>
          )}

          <div className="section-title">Downloaded factions</div>
          {offlineFactions.length === 0 ? (
            <p className="rot-note">
              None yet. Open a faction and use “Save offline” to make it usable without a connection.
            </p>
          ) : (
            <ul className="offline-list">
              {offlineFactions.map((key) => (
                <li key={key} className="offline-item">
                  <span>{factionName(key)}</span>
                  <button className="btn ghost small" onClick={() => void freeFaction(key)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="section-title">Saved builds backup</div>
          <p className="rot-note">
            {saveCount} saved build{saveCount === 1 ? "" : "s"} on this device. Export a copy to keep them safe or move
            them to another device.
          </p>
          <div className="modal-actions">
            <button className="btn small" onClick={doExport} disabled={saveCount === 0}>
              Export saves…
            </button>
            <button className="btn small" onClick={() => fileRef.current?.click()}>
              Import saves…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              onChange={onImportFile}
            />
          </div>

          {status && <p className="rot-note" style={{ color: "var(--gold-bright)" }}>{status}</p>}
        </div>
      </div>
    </div>
  );
}
