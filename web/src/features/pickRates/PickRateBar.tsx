/** The pick-rate mark under a grid medallion, and the provenance chip for the header.
 *
 *  The three "no number" cases get visibly different marks on purpose — a never-picked
 *  unit is a finding and must not look like missing data. See docs/PICK_RATES.md.
 */
import {
  CONFIDENCE_LABEL,
  TIER_LABEL,
  buildsLabel,
  confidenceOf,
  longLabel,
  shortLabel,
  tierOf,
} from "./pickRates";
import type { CorpsPickRates, PickRateSeason, SeasonSummary, UnitPickRate } from "./types";

export function PickRateBar({
  rate,
  thresholds,
}: {
  rate: UnitPickRate;
  /** Needed to tier the mark; without it every rate draws in the neutral colour. */
  thresholds?: PickRateSeason["thresholds"];
}) {
  // Colour tier, red -> green. Null on a sample too thin to colour, in which case the
  // mark stays neutral. Colour is redundant with the bar length and the fraction beside
  // it, and the ramp's lightness rises monotonically, so the order survives greyscale
  // and red-green colour blindness.
  const tier = thresholds ? tierOf(rate, thresholds) : null;
  const tierClass = tier ? ` t-${tier}` : "";
  const tierTitle = tier ? ` · ${TIER_LABEL[tier]}` : "";

  if (rate.kind === "data") {
    const pct = (100 * rate.builds) / rate.n;
    return (
      <div className="pickrate" title={`${longLabel(rate)}${tierTitle}`}>
        <div className={`pr-track${tierClass}`}>
          <div className="pr-fill" style={{ width: `${pct.toFixed(1)}%` }} />
        </div>
        <div className={`pr-text${tierClass}`}>{shortLabel(rate)}</div>
      </div>
    );
  }
  if (rate.kind === "never") {
    return (
      <div className="pickrate" title={`${longLabel(rate)} of this corps`}>
        <div className={`pr-track never${tierClass}`}>
          <div className="pr-fill" />
        </div>
        <div className={`pr-text never${tierClass}`}>{shortLabel(rate)}</div>
      </div>
    );
  }
  const why =
    rate.kind === "unplayed"
      ? "This corps doesn't appear in the selected dataset."
      : rate.kind === "out-of-scope"
        ? "This corps isn't covered by the selected dataset."
        : "The unit roster has changed since this dataset was recorded, so nothing can be said about this card.";
  return (
    <div className="pickrate" title={`${longLabel(rate)}. ${why}`}>
      <div className="pr-track nodata" />
      <div className="pr-text nodata">{shortLabel(rate)}</div>
    </div>
  );
}

/** Sample size + provenance for the corps on screen. The confidence sits next to the
 *  number, never in a corner — a "100%" read without its n is the whole failure mode. */
export function PickRateChip({
  corps,
  summary,
  loading,
}: {
  corps: CorpsPickRates | null;
  summary: SeasonSummary | null;
  loading: boolean;
}) {
  if (loading && !corps) return <span className="pr-chip">Loading pick rates…</span>;
  if (!corps) return null;

  const n = corps.kind === "data" ? corps.n : corps.kind === "unplayed" ? 0 : null;
  const tone = corps.kind === "out-of-scope" ? "none" : confidenceOf(n);
  const headline =
    corps.kind === "out-of-scope"
      ? "not covered"
      : corps.kind === "unplayed"
        ? "no battles recorded"
        : buildsLabel(corps.n);

  return (
    <span className={`pr-chip ${tone}`} title={summary ? `${summary.label} · ${summary.patch} · recorded ${summary.recorded}` : undefined}>
      <span className="pr-dot" aria-hidden />
      <b>{headline}</b>
      {corps.kind === "data" && <span className="pr-conf"> · {CONFIDENCE_LABEL[tone]}</span>}
      {summary && (
        <span className="pr-src">
          {" "}
          · {summary.label}, {summary.battles} battles
        </span>
      )}
    </span>
  );
}

/** Shown above the grid when the selected corps has nothing to say — each absence
 *  spelled out, because "why is this empty?" is otherwise the first question. */
export function PickRateNotice({ corps, minSample }: { corps: CorpsPickRates | null; minSample: number }) {
  if (!corps) return null;
  if (corps.kind === "out-of-scope")
    return (
      <div className="pr-notice scope">
        <b>Not covered by this dataset.</b> {corps.note} Pick rates aren't available for this corps —
        that's a limit of the dataset, not a sign that nobody plays it.
      </div>
    );
  if (corps.kind === "unplayed")
    return (
      <div className="pr-notice unplayed">
        <b>No battles recorded for this corps.</b> It's in scope for this dataset but doesn't appear in
        any collected battle, so nothing can be said about its units either way.
      </div>
    );
  if (corps.n < minSample)
    return (
      <div className="pr-notice thin">
        <b>Very thin sample — {buildsLabel(corps.n)}.</b> Counts are shown, percentages are not: a
        percentage off {buildsLabel(corps.n)} would imply a precision this sample can't support.
      </div>
    );
  return null;
}
