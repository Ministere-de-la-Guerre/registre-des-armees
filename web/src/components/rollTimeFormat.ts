// Shared local-time formatting for the roll/rotation popups (General times, Corps
// roll, TOW Generate times). All read the same windowed clock, so they present it
// identically.
import { useEffect, useState } from "react";
import { nextWindowStart, windowStart } from "../state/rotation";

export interface RollClock {
  /** Wall clock, refreshed every minute — for relative times ("in 2 h"). */
  now: Date;
  /** Reference time for the window searches. Moves only when the clock enters a
   *  new window, so an open popup re-runs its (year-long) search once per window
   *  rather than on every tick. */
  searchNow: Date;
}

function sameWindow(a: Date, b: Date): boolean {
  return windowStart(a).getTime() === windowStart(b).getTime();
}

/** Live clock for an open roll popup. Ticks on each minute boundary (window starts
 *  always sit on one) and when the page becomes visible again, e.g. after sleep. */
export function useRollClock(): RollClock {
  const [clock, setClock] = useState<RollClock>(() => {
    const d = new Date();
    return { now: d, searchNow: d };
  });

  useEffect(() => {
    const tick = () =>
      setClock((c) => {
        const d = new Date();
        return { now: d, searchNow: sameWindow(d, c.searchNow) ? c.searchNow : d };
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      // A little past the boundary so the new minute/window is already current.
      const ms = 60_000 - (Date.now() % 60_000) + 50;
      timer = setTimeout(() => {
        tick();
        schedule();
      }, ms);
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      tick();
      schedule(); // timers may have been throttled or frozen while hidden
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return clock;
}

export type RollDirection = "now" | "future" | "past" | null;

export function fmtDateTime(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function fmtRel(target: Date, now: Date): string {
  const ms = target.getTime() - now.getTime();
  const past = ms < 0;
  const a = Math.abs(ms);
  const mins = Math.round(a / 60000);
  const hrs = Math.round(a / 3_600_000);
  const days = Math.round(a / 86_400_000);
  const s = mins < 60 ? `${mins} min` : hrs < 48 ? `${hrs} h` : `${days} days`;
  return past ? `${s} ago` : `in ${s}`;
}

/** A single window's local time range, e.g. "14:00 – 17:00". */
export function windowRange(start: Date): string {
  return `${fmtTime(start)} – ${fmtTime(nextWindowStart(start))}`;
}
