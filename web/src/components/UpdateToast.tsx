// Web-only "a new version is ready" prompt. Replaces electron-updater's restart
// dialog for the PWA: shown when the service worker has a waiting update.
interface UpdateToastProps {
  onReload: () => void;
  onDismiss: () => void;
  /** Defaults to the "update waiting" wording. */
  message?: string;
}

export function UpdateToast({ onReload, onDismiss, message = "A new version is available." }: UpdateToastProps) {
  return (
    <div className="pwa-toast" role="status" aria-live="polite">
      <span>{message}</span>
      <button className="btn gold small" onClick={onReload}>
        Reload
      </button>
      <button className="btn ghost small" onClick={onDismiss} aria-label="Dismiss">
        ✕
      </button>
    </div>
  );
}
