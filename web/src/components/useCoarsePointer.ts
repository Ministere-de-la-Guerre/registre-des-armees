import { useEffect, useState } from "react";

// Shared touch-device signal: `(hover: none) and (pointer: coarse)` — true on
// phones/tablets, false on desktop mice AND on the Electron desktop build (which
// reports `hover: hover` / `pointer: fine`). Every touch-vs-desktop behavior fork
// (tooltip trigger, tap semantics, collapsible chrome) reads from here so the
// detection lives in exactly one place and desktop stays byte-identical.
const mql =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(hover: none) and (pointer: coarse)")
    : null;

// Phone-only signal: a coarse pointer AND a viewport whose *shorter* side is
// phone-sized (≤600px in either orientation). Tablets (min side ≥ ~768px) and
// desktop are excluded. Used where phones need a different default from tablets
// (e.g. the filter drawer starting collapsed). The shorter side is orientation-
// stable, so this is safe to read once.
const phoneMql =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(
        "(hover: none) and (pointer: coarse) and (max-width: 600px), (hover: none) and (pointer: coarse) and (max-height: 600px)",
      )
    : null;

/** Non-reactive read for module/one-shot use (pointer type is stable per session). */
export function isCoarsePointer(): boolean {
  return mql?.matches ?? false;
}

/** True on phones only (coarse pointer + phone-sized shorter viewport side),
 *  excluding tablets and desktop. */
export function isPhone(): boolean {
  return phoneMql?.matches ?? false;
}

/** Reactive variant for components that must re-render if the signal ever flips. */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(isCoarsePointer);
  useEffect(() => {
    if (!mql) return;
    const onChange = () => setCoarse(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return coarse;
}
