import { useEffect, useRef } from "react";

// Long-press → right-click parity for touch. Desktop is untouched: the handlers
// ignore mouse pointers entirely, so a mouse still uses the native contextmenu
// and click. On touch/pen, a ~450 ms hold (cancelled by movement or scroll)
// fires the callback the same code path right-click uses. (The iOS callout /
// Android image sheet / text selection a hold would otherwise raise is suppressed
// in CSS on .medallion.)
//
// The browser still fires its own events for that same press: Android Chrome
// synthesizes a `contextmenu` while the finger is down, and every browser fires a
// `click` when it lifts — however long it was held. So the caller must dedupe:
// once this hook fires, `suppressing()` stays true for the rest of the press and a
// short grace after release, and the caller swallows both.
export interface LongPress {
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
  };
  /** True from the moment a long-press fires until shortly after that press is
   *  released (for click/contextmenu dedupe). */
  suppressing: () => boolean;
}

/** How long after releasing a long-press its trailing click is still swallowed. */
const RELEASE_GRACE_MS = 400;

export function useLongPress(
  onLongPress: (() => void) | undefined,
  opts: { ms?: number; moveTolerance?: number } = {},
): LongPress {
  const ms = opts.ms ?? 450;
  const tol = opts.moveTolerance ?? 10;
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  // The press that fired is still down (no release seen yet).
  const held = useRef(false);
  // After release: swallow events until this time.
  const suppressUntil = useRef(0);

  const clear = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  // Never fire into an unmounted component (e.g. a tray copy removed mid-press).
  useEffect(() => clear, []);

  const onPointerDown = (e: React.PointerEvent) => {
    // A new press (of any pointer) ends an earlier one whose release we never saw,
    // e.g. a finger that slid off the element before lifting.
    held.current = false;
    if (!onLongPress || (e.pointerType !== "touch" && e.pointerType !== "pen")) return;
    start.current = { x: e.clientX, y: e.clientY };
    clear();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      held.current = true;
      onLongPress();
    }, ms);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (timer.current === null || !start.current) return;
    if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > tol) clear();
  };

  const release = () => {
    clear();
    if (held.current) {
      held.current = false;
      suppressUntil.current = Date.now() + RELEASE_GRACE_MS;
    }
  };

  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp: release, onPointerCancel: release },
    suppressing: () => held.current || Date.now() < suppressUntil.current,
  };
}
