import { useEffect, useRef } from "react";
import type { UnitCard } from "../domain/types";

/** Warns that the just-selected unit's uniform is bugged in the game itself.
 *  Shown by Builder the first time a bugged-uniform regiment is added to a build
 *  (see domain/buggedUniforms). The unit is still added — this is an advisory. */
export function BuggedUniformModal({ card, onClose }: { card: UnitCard; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Take focus while open, so the Enter/Space that added the unit from a focused
  // medallion can't keep adding copies behind the warning; hand it back on close.
  const ackRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ackRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  return (
    // Dismiss on backdrop mousedown (not click) so a drag that releases outside
    // the dialog doesn't close it.
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal bugged-uniform-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label="Bugged uniform warning"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h3 style={{ color: "var(--gold-bright)" }}>⚠ Bugged uniform — crashes the game</h3>
            <div style={{ fontSize: 12, opacity: 0.85 }}>Known NTW3 issue — not a problem with your build</div>
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn small" onClick={onClose} aria-label="Dismiss warning">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="tow-warning">
            <strong>{card.name}</strong> uses a uniform that is bugged in the game itself. Taking this unit into
            a battle will crash the game. The 23e léger of the 1811 (Spain) and 1814 (France) armies — and every
            unit that shares this uniform — is affected. This is a known issue with NTW3, not with this build.
          </div>
          <p style={{ margin: "12px 0 0", fontSize: 13, opacity: 0.9 }}>
            The unit has still been added so you can plan around it, but remove it before you play — don't field
            it in an actual battle.
          </p>
          <div className="modal-actions" style={{ marginTop: 14, marginBottom: 0, justifyContent: "flex-end" }}>
            <button ref={ackRef} className="btn" onClick={onClose}>
              Got it
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
