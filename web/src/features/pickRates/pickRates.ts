/** Pure pick-rate logic: resolving a corps / unit to one of the states, and deciding
 *  how loudly a number has to be qualified.
 *
 *  Every consumer (grid overlay, details panel, any future ranked view) goes through
 *  these two functions, so the states cannot drift apart between views. DOM-free and
 *  fully unit-tested — see pickRates.test.ts.
 *
 *  The states exist because "no number" has four different meanings and showing them
 *  the same way would be a lie in three of the four cases. In particular a unit that
 *  is IN a well-sampled corps and was picked by nobody is the strongest signal the
 *  dataset carries, and must never render as a blank. See docs/PICK_RATES.md.
 */
import type {
  Confidence,
  CorpsPickRates,
  PickRateSeason,
  RegimentRollup,
  UnitPickRate,
} from "./types";

/** Buckets overstate on a small sample; withhold the label below this many builds. */
export const MIN_SAMPLE_FOR_BUCKET = 10;

export function corpsPickRates(season: PickRateSeason | null, factionKey: string): CorpsPickRates | null {
  if (!season) return null;
  const entry = season.corps[factionKey];
  if (!entry) return { kind: "out-of-scope", note: season.scope?.note ?? "" };
  if (!entry.n) return { kind: "unplayed", corpsName: entry.name };
  return {
    kind: "data",
    n: entry.n,
    players: entry.players ?? 0,
    corpsName: entry.name,
    units: entry.units ?? {},
    regiments: entry.regiments ?? {},
  };
}

/** Whether the corpus was computed against the same unit roster the app is showing.
 *  When it wasn't, a missing unit might simply be newer than the corpus, so its
 *  absence cannot be read as "never picked". */
export function rosterMatches(season: PickRateSeason | null, appVersion: Record<string, number> | null): boolean {
  if (!season?.unitDataVersion || !appVersion) return false;
  const a = season.unitDataVersion;
  return Object.keys(a).every((k) => a[k] === appVersion[k]);
}

/** Turn a raw {builds, copies} record into a rate against the corps' sample. */
function rateFrom(
  record: { b: number; t: number } | undefined,
  n: number,
  opts: { rosterMatches: boolean; minSampleForPercent: number },
): UnitPickRate {
  if (!record) return opts.rosterMatches ? { kind: "never", n } : { kind: "unknown" };
  return {
    kind: "data",
    builds: record.b,
    n,
    pct: n >= opts.minSampleForPercent ? (100 * record.b) / n : null,
    copies: record.b > 0 ? record.t / record.b : 0,
  };
}

/** The rate for ONE CARD, keyed by its exact unit key.
 *
 *  Per card, not per regiment: the builder draws a separate medallion for the plain
 *  unit and for each commander variant, and those are different picks. "84e de ligne"
 *  fielded in 14 of 38 builds says nothing about how often "Macdonald (Grenadiers du
 *  84e)" is taken — in the Season 10 corpus that is 1 of 38. Showing the regiment's
 *  number on the general's tile overstates it by an order of magnitude.
 *
 *  Staff generals and commander variants need no special case: they are cards like any
 *  other and the corpus records them by exact key. Use regimentRollup() for the
 *  "this regiment, all variants" figure. */
export function unitPickRate(
  corps: CorpsPickRates | null,
  unitKey: string,
  opts: { rosterMatches: boolean; minSampleForPercent: number },
): UnitPickRate | null {
  if (!corps) return null;
  if (corps.kind === "out-of-scope") return { kind: "out-of-scope" };
  if (corps.kind === "unplayed") return { kind: "unplayed" };

  return rateFrom(corps.units[unitKey], corps.n, opts);
}

/** The rate for a whole REGIMENT — the plain unit plus every commander variant —
 *  expressed in the same shape, so a medallion can show either. */
export function regimentPickRate(
  corps: CorpsPickRates | null,
  baseUnitKey: string,
  opts: { rosterMatches: boolean; minSampleForPercent: number },
): UnitPickRate | null {
  if (!corps) return null;
  if (corps.kind === "out-of-scope") return { kind: "out-of-scope" };
  if (corps.kind === "unplayed") return { kind: "unplayed" };
  return rateFrom(corps.regiments[baseUnitKey], corps.n, opts);
}

/** What a medallion should show, given what the grid is currently displaying.
 *
 *  With combat generals VISIBLE each card carries its own number, because each is a
 *  separate pick. With them HIDDEN their tiles are gone, so folding their builds into
 *  the plain unit's tile is the only way the displayed number stays a true count of how
 *  often that regiment was fielded — otherwise every officer-led build silently
 *  disappears from the grid. */
export function cardPickRate(
  corps: CorpsPickRates | null,
  keys: { unitKey: string; baseUnitKey: string },
  opts: { rosterMatches: boolean; minSampleForPercent: number; combineVariants: boolean },
): UnitPickRate | null {
  return opts.combineVariants
    ? regimentPickRate(corps, keys.baseUnitKey || keys.unitKey, opts)
    : unitPickRate(corps, keys.unitKey, opts);
}

/** The regiment behind a card, across the plain unit and every commander variant.
 *  Null unless the corps has a real sample — the card-level state already explains why
 *  there is nothing to show. */
export function regimentRollup(
  corps: CorpsPickRates | null,
  baseUnitKey: string,
): RegimentRollup | null {
  if (!corps || corps.kind !== "data") return null;
  const record = corps.regiments[baseUnitKey];
  if (!record) return null;
  return { builds: record.b, n: corps.n, officerBuilds: record.c };
}

export function confidenceOf(n: number | null): Confidence {
  if (n === null || n <= 0) return "none";
  if (n < 5) return "very-thin";
  if (n < 10) return "thin";
  if (n < 20) return "moderate";
  return "solid";
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  none: "no data",
  "very-thin": "very thin",
  thin: "thin",
  moderate: "moderate",
  solid: "solid",
};

/** `n` builds, worded. One place decides, so "1 builds" cannot reappear. */
export const buildsLabel = (n: number) => `${n} build${n === 1 ? "" : "s"}`;

/** The short string shown under a medallion.
 *
 *  The fraction, never the percentage: the bar beside it already encodes the rate
 *  visually, so printing both is redundant *and* too wide for a compact 62px tile.
 *  The fraction is also the self-limiting half — "2/3" cannot be misread as precise
 *  the way "67%" can. The exact percentage lives in the details panel and tooltip. */
export function shortLabel(rate: UnitPickRate): string {
  switch (rate.kind) {
    case "data":
      return `${rate.builds}/${rate.n}`;
    case "never":
      return `0/${rate.n}`;
    case "unplayed":
      return "no battles";
    case "out-of-scope":
      return "not covered";
    case "unknown":
      return "no data";
  }
}

/** The full sentence for the details panel and tooltips, where there is room to be
 *  explicit and the percentage can be stated with its sample beside it. */
export function longLabel(rate: UnitPickRate): string {
  switch (rate.kind) {
    case "data":
      return rate.pct === null
        ? `Picked in ${rate.builds} of ${buildsLabel(rate.n)}`
        : `Picked in ${rate.builds} of ${buildsLabel(rate.n)} (${Math.round(rate.pct)}%)`;
    case "never":
      return `Never picked — 0 of ${buildsLabel(rate.n)}`;
    case "unplayed":
      return "No battles recorded for this corps";
    case "out-of-scope":
      return "This corps isn't covered by the selected dataset";
    case "unknown":
      return "No data — the roster changed after this dataset was recorded";
  }
}

/** Colour tiers for the medallion mark, red -> green.
 *
 *  The breakpoints are NOT evenly spaced across 0-100%, on purpose. In the Season 10
 *  corpus the median card that gets picked at all sits at 20%, and only 3% of cards
 *  ever reach 85% — because a brigade offers six units and you take two, so most cards
 *  cannot be picked often even when they are good. An even 0-100 ramp would therefore
 *  paint ~80% of every roster red and carry almost no information. These breakpoints
 *  come from the observed distribution instead, so the middle of the scale lands on the
 *  middle of the data.
 *
 *  The top break is read from the season's own `autoInclude` threshold rather than
 *  written twice, so the colour and the bucket label can never disagree. */
export type Tier =
  | "never"
  | "fringe"
  | "situational"
  | "common"
  | "popular"
  | "core"
  | "auto-include"
  | null;

/** Lower bound (percent of builds) for each tier below auto-include. */
const TIER_BREAKS: { tier: Exclude<Tier, null | "never" | "auto-include">; min: number }[] = [
  { tier: "core", min: 55 },
  { tier: "popular", min: 35 },
  { tier: "common", min: 20 },
  { tier: "situational", min: 10 },
  { tier: "fringe", min: 0 },
];

export const TIER_LABEL: Record<NonNullable<Tier>, string> = {
  never: "never picked",
  fringe: "fringe",
  situational: "situational",
  common: "common",
  popular: "popular",
  core: "core pick",
  "auto-include": "auto-include",
};

/** The tier a mark should be drawn in, or null when the sample is too thin to colour.
 *
 *  Gated on the same sample size as the percentage itself: if we are unwilling to state
 *  a percentage, we must not imply one with colour either. */
export function tierOf(rate: UnitPickRate, thresholds: PickRateSeason["thresholds"]): Tier {
  if (rate.kind === "never") return rate.n >= thresholds.minSampleForPercent ? "never" : null;
  if (rate.kind !== "data" || rate.n < thresholds.minSampleForPercent) return null;
  const pct = (100 * rate.builds) / rate.n;
  if (pct >= thresholds.autoInclude) return "auto-include";
  return TIER_BREAKS.find((t) => pct >= t.min)?.tier ?? "fringe";
}

export type Bucket = "auto-include" | "contested" | "rare" | "never" | null;

/** Bucket label, or null when the sample is too thin for one to be honest. */
export function bucketOf(rate: UnitPickRate, thresholds: PickRateSeason["thresholds"]): Bucket {
  if (rate.kind === "never") return rate.n >= MIN_SAMPLE_FOR_BUCKET ? "never" : null;
  if (rate.kind !== "data" || rate.n < MIN_SAMPLE_FOR_BUCKET) return null;
  const pct = (100 * rate.builds) / rate.n;
  if (pct >= thresholds.autoInclude) return "auto-include";
  if (pct >= thresholds.contested) return "contested";
  return "rare";
}
