// Shared local-time formatting for the roll/rotation popups (General times, Corps
// roll, TOW Generate times). All read the same windowed clock, so they present it
// identically.
import { nextWindowStart } from "../state/rotation";

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
