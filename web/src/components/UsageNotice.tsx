// One-time, non-blocking notice that the app counts launches anonymously
// (src/analytics.ts). It informs; it does not ask — the opt-out lives in Settings.
interface UsageNoticeProps {
  onOk: () => void;
  onSettings: () => void;
}

export function UsageNotice({ onOk, onSettings }: UsageNoticeProps) {
  return (
    <div className="pwa-toast usage-notice" role="status" aria-live="polite">
      <span>Registre counts visits anonymously — no cookies, no ID, nothing about your builds.</span>
      <button className="btn ghost small" onClick={onSettings}>
        Settings
      </button>
      <button className="btn gold small" onClick={onOk}>
        OK
      </button>
    </div>
  );
}
