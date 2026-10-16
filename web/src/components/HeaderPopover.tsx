import { type CSSProperties, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

/** A panel dropped from a builder-header button (Gold breakdown, Pick rates).
 *
 *  Portaled to the .app root and positioned from the anchor's rect, so neither the
 *  header's overflow nor its touch swipe-scroller can clip it — and the .app-level
 *  `.tablet-touch` rules still reach it. On touch the CSS turns it into a bottom sheet,
 *  matching the Load menu. Outside pointer-down and Escape close it.
 *
 *  Keyboard: opening moves focus to the panel's first control (the portal puts it at
 *  the end of the DOM, so Tab from the anchor would never reach it); Escape hands focus
 *  back to the anchor. The anchor should carry `aria-controls={id}`.
 */
export function HeaderPopover({
  id,
  anchorRef,
  onClose,
  width,
  align = "start",
  label,
  className = "",
  children,
}: {
  id: string;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  width: number;
  /** "start": left edges line up; "end": right edges do. Clamped to the window either way. */
  align?: "start" | "end";
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Callers pass an inline onClose; read it through a ref so the listeners subscribe once.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const w = Math.min(width, window.innerWidth - 16);
      const want = align === "end" ? r.right - w : r.left;
      setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(want, window.innerWidth - w - 8)), width: w });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchorRef, align, width]);

  // Once, after the first placement: until then the panel is visibility:hidden, and a
  // hidden element can't take focus.
  const focused = useRef(false);
  useEffect(() => {
    if (!pos || focused.current) return;
    focused.current = true;
    panelRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
  }, [pos]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element;
      // A modal opened from the panel (Full details…) is outside it, but is not a dismissal.
      if (target.closest?.(".modal-backdrop")) return;
      if (!anchorRef.current?.contains(target) && !panelRef.current?.contains(target)) onCloseRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".modal-backdrop")) return;
      onCloseRef.current();
      anchorRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [anchorRef]);

  const host = anchorRef.current?.closest(".app") ?? document.body;
  return createPortal(
    <div
      id={id}
      ref={panelRef}
      className={`head-pop ${className}`}
      role="dialog"
      aria-label={label}
      style={
        {
          "--pop-top": `${pos?.top ?? 0}px`,
          "--pop-left": `${pos?.left ?? 0}px`,
          "--pop-w": `${pos?.width ?? width}px`,
          visibility: pos ? undefined : "hidden",
        } as CSSProperties
      }
    >
      {children}
    </div>,
    host,
  );
}
