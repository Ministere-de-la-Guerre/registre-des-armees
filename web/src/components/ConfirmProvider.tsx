import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ConfirmContext, type ConfirmFn, type ConfirmOptions } from "./useConfirm";
import { isTabletTouch, useCoarsePointer } from "./useCoarsePointer";

interface Pending {
  opts: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        // A newer question supersedes an unanswered one, which counts as declined.
        pendingRef.current?.resolve(false);
        const next = { opts, resolve };
        pendingRef.current = next;
        setPending(next);
      }),
    [],
  );

  const settle = useCallback((ok: boolean) => {
    const p = pendingRef.current;
    if (!p) return;
    pendingRef.current = null;
    setPending(null);
    p.resolve(ok);
  }, []);

  useEffect(
    () => () => {
      pendingRef.current?.resolve(false);
      pendingRef.current = null;
    },
    [],
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && <ConfirmDialog opts={pending.opts} onSettle={settle} />}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({ opts, onSettle }: { opts: ConfirmOptions; onSettle: (ok: boolean) => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const coarse = useCoarsePointer();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onSettle(false);
      } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
        // Focus on a button: its own click handles Enter. Anywhere else, confirm.
        e.preventDefault();
        onSettle(true);
      }
    };
    // Deferred a tick: a dialog opened from an Enter keypress (a name prompt's
    // submit) is mounted while that very keystroke is still being dispatched, and
    // would otherwise take focus and the key's default action, answering itself.
    const timer = setTimeout(() => {
      confirmRef.current?.focus();
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
      if (previous && previous.isConnected) previous.focus();
    };
  }, [onSettle]);

  const modal = (
    <div className="modal-backdrop" onMouseDown={() => onSettle(false)}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={opts.title ?? "Confirm"}
        style={{ maxWidth: 420 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {opts.title && (
          <div className="modal-head">
            <strong>{opts.title}</strong>
          </div>
        )}
        <div className="modal-body">
          <div style={{ fontSize: 14 }}>{opts.message}</div>
          <div className="modal-actions" style={{ marginTop: 12, justifyContent: "flex-end" }}>
            <button className="btn small" onClick={() => onSettle(false)}>
              {opts.cancelLabel ?? "Cancel"}
            </button>
            <button
              ref={confirmRef}
              className="btn small primary"
              style={opts.danger ? { background: "var(--bad-deep)", borderColor: "var(--bad)" } : undefined}
              onClick={() => onSettle(true)}
            >
              {opts.confirmLabel ?? "OK"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  // Same touch portal rule as NamePromptModal.
  return coarse || isTabletTouch() ? createPortal(modal, document.body) : modal;
}
