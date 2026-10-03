import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isTabletTouch, useCoarsePointer } from "./useCoarsePointer";

/** In-app name prompt. Electron does not support window.prompt(), so naming
 *  something (Save As / Rename) must go through this modal instead. Mount it only
 *  while a prompt is open: it takes `initial` once, on mount. */
export function NamePromptModal({
  title,
  initial,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: string;
  submitLabel: string;
  /** Called with the trimmed, non-empty name, after `onClose`. */
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const coarse = useCoarsePointer();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const name = value.trim();
    if (!name) return;
    onClose();
    onSubmit(name);
  };

  const modal = (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{title}</strong>
        </div>
        <div className="modal-body">
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              else if (e.key === "Escape") onClose();
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
            <button className="btn small" onClick={onClose}>
              Cancel
            </button>
            <button className="btn small primary" onClick={submit} disabled={!value.trim()}>
              {submitLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  // On touch/tablet the caller can sit inside a momentum-scroll container, and iOS
  // clips position:fixed descendants of one — so portal to <body> there (see
  // SaveLoadBar). Desktop keeps it inline.
  return coarse || isTabletTouch() ? createPortal(modal, document.body) : modal;
}
