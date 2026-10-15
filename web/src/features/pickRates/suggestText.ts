import type { UnitCard } from "../../domain/types";
import type { Suggestions, SuggestUnavailable } from "./suggest";

/** Plain-text helpers for the suggestions sheet (kept out of SuggestPanel.tsx so that
 *  file only exports components). */
/** One-line reason shown instead of the rows. */
export function unavailableMessage(r: SuggestUnavailable): string {
  switch (r.kind) {
    case "off":
      return "Pick rates are switched off or still loading — suggestions need them.";
    case "out-of-scope":
      return "This corps is outside the recorded dataset, so there is nothing to suggest.";
    case "unplayed":
      return "No battles recorded for this corps yet.";
    case "thin":
      return `Only ${r.n} recorded build${r.n === 1 ? "" : "s"} — suggestions need 15.`;
    case "roster-changed":
      return "The unit roster has changed since this dataset was recorded.";
    case "no-builds":
      return "This dataset has no build lists — rebuild it.";
  }
}

/** "¤ 52e de ligne 'Les Vaillants' [L3]" -> "52e de ligne". */
export function regimentShortName(card: UnitCard): string {
  return card.name
    .replace(/^¤\s*/, "")
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .replace(/\s*['‘’“"][^'‘’”"]*['‘’”"]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const mp = (n: number) => `${n < 0 ? "−" : "+"}${Math.abs(n).toLocaleString()} MP`;

export function basisLine(s: Suggestions, seasonLabel: string): string {
  return s.emptyBuild || s.sharedPct === null
    ? `Most-picked in this corps · ${s.n} recorded builds · ${seasonLabel}`
    : `The ${s.K} recorded builds of this corps closest to yours share ${s.sharedPct}% of your regiments · ${seasonLabel}`;
}

/** 2 -> "2nd", 3 -> "3rd", 4 -> "4th", 11 -> "11th". */
export function ordinal(n: number): string {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}
