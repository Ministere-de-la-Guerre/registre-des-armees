import { useId } from "react";

/** Dual-thumb range slider. Reports `null` for a bound when it sits at the
 *  extreme (i.e. "no constraint"), so an untouched slider counts as inactive. */
export function DualRange({
  label,
  min,
  max,
  valueMin,
  valueMax,
  step = 1,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  valueMin: number | null;
  valueMax: number | null;
  step?: number;
  onChange: (lo: number | null, hi: number | null) => void;
}) {
  const id = useId();
  const lo = valueMin ?? min;
  const hi = valueMax ?? max;
  const span = max - min || 1;
  const leftPct = ((lo - min) / span) * 100;
  const rightPct = 100 - ((hi - min) / span) * 100;
  const active = valueMin !== null || valueMax !== null;

  const emit = (nextLo: number, nextHi: number) => {
    const clampedLo = Math.min(nextLo, nextHi);
    const clampedHi = Math.max(nextLo, nextHi);
    onChange(clampedLo <= min ? null : clampedLo, clampedHi >= max ? null : clampedHi);
  };

  if (max <= min) return null;

  return (
    <div className="dual">
      <div className="dual-head">
        <span>{label}</span>
        <span className={`dual-val${active ? " on" : ""}`}>
          {lo} – {hi}
        </span>
      </div>
      <div className="dual-track">
        <div className="dual-rail" />
        <div className="dual-fill" style={{ left: `${leftPct}%`, right: `${rightPct}%` }} />
        <input
          type="range"
          aria-label={`${label} minimum`}
          min={min}
          max={max}
          step={step}
          value={lo}
          onChange={(e) => emit(Number(e.target.value), hi)}
        />
        <input
          type="range"
          aria-label={`${label} maximum`}
          min={min}
          max={max}
          step={step}
          value={hi}
          onChange={(e) => emit(lo, Number(e.target.value))}
          id={id}
        />
      </div>
    </div>
  );
}
