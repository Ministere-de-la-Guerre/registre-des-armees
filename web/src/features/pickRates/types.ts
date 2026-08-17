/** Shapes of the generated pick-rate dataset (tools/build_pick_rates.py).
 *  See docs/PICK_RATES.md for the schema and how the absence states are encoded. */

export interface SeasonSummary {
  id: string;
  label: string;
  /** Game build the corpus was recorded on, e.g. "NTW3 1.3.0 (Build 2081)". */
  patch: string;
  battles: number;
  armies: number;
  players: number;
  corpsWithData: number;
  corpsInScope: number;
  recorded: string;
  file: string;
}

export interface PickRateIndex {
  schemaVersion: number;
  defaultSeason: string | null;
  seasons: SeasonSummary[];
}

/** One card's record, keyed by EXACT unit key. Counts only — averages are derived, so
 *  the file stays integers. */
export interface UnitRecord {
  /** Builds of this corps that contained at least one copy of this exact card. */
  b: number;
  /** Total copies of this exact card fielded across those builds. */
  t: number;
}

/** A regiment rolled up across all its cards (plain unit + every commander variant).
 *  Answers "how often is this regiment fielded at all", which the per-card number
 *  deliberately does not. */
export interface RegimentRecord {
  b: number;
  t: number;
  /** Builds where the regiment was led by a commander variant. */
  c: number;
}

export interface CorpsRecord {
  name: string;
  /** Builds of this corps in the corpus. 0 = in scope but never played. */
  n: number;
  players?: number;
  /** Keyed by EXACT unitKey. Zero-pick cards are OMITTED — see unitPickRate(). */
  units?: Record<string, UnitRecord>;
  /** Keyed by baseUnitKey (capGroupKey). */
  regiments?: Record<string, RegimentRecord>;
}

export interface PickRateSeason {
  schemaVersion: number;
  id: string;
  label: string;
  patch: string;
  corpus: { battles: number; armies: number; players: number; recorded: string };
  /** What this dataset is allowed to speak about; a corps outside it is reported as
   *  out-of-scope rather than as "no data". */
  scope: { corpsTypes: string[]; note: string };
  /** Unit-DB stamp the corpus was computed against. */
  unitDataVersion: Record<string, number>;
  thresholds: { minSampleForPercent: number; autoInclude: number; contested: number; rare: number };
  corps: Record<string, CorpsRecord>;
}

/** Why a corps has no numbers — three genuinely different absences, plus the case
 *  where it does have them. Never collapse these; see docs/PICK_RATES.md. */
export type CorpsPickRates =
  | { kind: "out-of-scope"; note: string }
  | { kind: "unplayed"; corpsName: string }
  | {
      kind: "data";
      n: number;
      players: number;
      corpsName: string;
      units: Record<string, UnitRecord>;
      regiments: Record<string, RegimentRecord>;
    };

export type UnitPickRate =
  /** Real numbers. `pct` is null when the sample is too small to state one. */
  | { kind: "data"; builds: number; n: number; pct: number | null; copies: number }
  /** Fielded by nobody, in a corps with a real sample — a finding, not a gap. */
  | { kind: "never"; n: number }
  /** The roster moved on since the corpus was recorded, so absence proves nothing. */
  | { kind: "unknown" }
  | { kind: "out-of-scope" }
  | { kind: "unplayed" };

export type Confidence = "none" | "very-thin" | "thin" | "moderate" | "solid";

/** The regiment behind a card, across all its variants. Null when the corps has no
 *  usable sample (the card-level state already says why). */
export interface RegimentRollup {
  builds: number;
  n: number;
  /** Builds in which the regiment was led by a commander variant. */
  officerBuilds: number;
}
