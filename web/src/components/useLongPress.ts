import { useRef } from "react";

// Long-press → right-click parity for touch. Desktop is untouched: the handlers
// ignore mouse pointers entirely, so a mouse still uses the native contextmenu
// and click. On touch/pen, a ~450 ms hold (cancelled by movement or scroll)
// fires the callback the same code path right-click uses.
//
// Android Chrome ALSO synthesizes a `contextmenu` on long-press, so the caller
// must dedupe: after this hook fires, `wasRecent()` is true briefly, and the
// caller swallows both the synthetic contextmenu and the trailing click.
export interface LongPress {
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
  };
  /** True if a long-press fired in the last ~700 ms (for click/contextmenu dedupe). */
  wasRecent: () => boolean;
}

export function useLongPress(
  onLongPress: (() => void) | undefined,
  opts: { ms?: number; moveTolerance?: number } = {},
): LongPress {
  const ms = opts.ms ?? 450;
  const tol = opts.moveTolerance ?? 10;
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const firedAt = useRef(0);

  const clear = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!onLongPress || (e.pointerType !== "touch" && e.pointerType !== "pen")) return;
    start.current = { x: e.clientX, y: e.clientY };
    clear();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      firedAt.current = Date.now();
      onLongPress();
    }, ms);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (timer.current === null || !start.current) return;
    if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > tol) clear();
  };

  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp: clear, onPointerCancel: clear },
    wasRecent: () => Date.now() - firedAt.current < 700,
  };
}
