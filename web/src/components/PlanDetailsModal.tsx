import { useEffect, useRef } from "react";
import { GUN_ARMS, GUN_ARM_LABELS } from "../domain/gunTypes";
import {
  ABILITY_STAT_KEYS,
  ABILITY_STAT_LABELS,
  CAVALRY_KEYS,
  CAVALRY_LABELS,
  INFANTRY_KEYS,
  INFANTRY_LABELS,
  type ClassBreakdown,
  type PlanStats,
} from "../state/planStats";
import { SHARE_LABELS, plural, shareSegments, speedMix, warningText } from "../state/planSummary";

const batteries = (n: number) => plural(n, "battery", "batteries");

function Row({ label, value, speeds, sub = false }: { label: string; value: string; speeds?: Readonly<Record<string, number>>; sub?: boolean }) {
  return (
    <div className={`plan-row${sub ? " sub" : ""}`}>
      <span className="k">{label}</span>
      <span className="v">{value}</span>
      {speeds && <span className="by">{speedMix(speeds)}</span>}
    </div>
  );
}

function ClassSection<K extends string>({
  title,
  keys,
  labels,
  breakdown,
}: {
  title: string;
  keys: readonly K[];
  labels: Record<K, string>;
  breakdown: ClassBreakdown<K>;
}) {
  const present = keys.filter((k) => breakdown.byClass[k].cards > 0);
  return (
    <section className="plan-section">
      <h3>{title}</h3>
      {present.length === 0 ? (
        <div className="plan-empty-note">None.</div>
      ) : (
        <>
          {present.map((k) => {
            const t = breakdown.byClass[k];
            return <Row key={k} label={labels[k]} value={`${plural(t.cards, "card")} · ${t.men.toLocaleString()} men`} speeds={t.bySpeed} />;
          })}
          <div className="plan-row total">
            <span className="k">Total</span>
            <span className="v">
              {plural(breakdown.totalCards, "card")} · {breakdown.totalMen.toLocaleString()} men
            </span>
            <span className="by" />
          </div>
        </>
      )}
    </section>
  );
}

/** The team's breakdowns, behind the strip's Details button. Every row also shows its
 *  speed-tag mix ("C3 ×2 · C4 ×2"; batteries for guns). */
export function PlanDetailsModal({ stats, onClose }: { stats: PlanStats; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  // Take focus while open (and hand it back) so keys stop reaching the page behind.
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const shares = shareSegments(stats.share);
  const armsWithGuns = GUN_ARMS.filter((a) => stats.guns.byArm[a].guns > 0);
  const abilities = ABILITY_STAT_KEYS.filter((k) => stats.abilities[k].cards > 0);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal plan-details" role="dialog" aria-modal="true" aria-label="Team details" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong style={{ flex: 1, alignSelf: "center" }}>Team details</strong>
          <button ref={closeRef} className="btn small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          {stats.warnings.length > 0 && (
            <section className="plan-section">
              <h3>Warnings</h3>
              {stats.warnings.map((w, i) => (
                <div className="error-box notice" key={i}>
                  ⚠ {warningText(w)}
                </div>
              ))}
            </section>
          )}

          <section className="plan-section">
            <h3>Composition</h3>
            {shares.map((s) => (
              <div className="plan-row" key={s.arm}>
                <span className="k">{SHARE_LABELS[s.arm]}</span>
                <span className="v">
                  {plural(s.cards, "card")} · {s.men.toLocaleString()} men · {s.gold.toLocaleString()} gold ({s.goldPct}% of gold)
                </span>
                <span className="by" />
              </div>
            ))}
          </section>

          <ClassSection title="Cavalry" keys={CAVALRY_KEYS} labels={CAVALRY_LABELS} breakdown={stats.cavalry} />

          <section className="plan-section">
            <h3>Guns</h3>
            {armsWithGuns.length === 0 ? (
              <div className="plan-empty-note">No artillery.</div>
            ) : (
              <>
                {armsWithGuns.map((arm) => {
                  const t = stats.guns.byArm[arm];
                  return (
                    <div key={arm}>
                      <Row label={`${GUN_ARM_LABELS[arm]} artillery`} value={`${plural(t.guns, "gun")} · ${batteries(t.batteries)}`} speeds={t.bySpeed} />
                      {stats.guns.byType
                        .filter((r) => r.arm === arm)
                        .map((r) => (
                          <Row key={r.label} sub label={r.label} value={`${plural(r.guns, "gun")} · ${batteries(r.batteries)}`} speeds={r.bySpeed} />
                        ))}
                    </div>
                  );
                })}
                <div className="plan-row total">
                  <span className="k">Total</span>
                  <span className="v">{plural(stats.guns.total, "gun")}</span>
                  <span className="by" />
                </div>
              </>
            )}
          </section>

          <ClassSection title="Infantry" keys={INFANTRY_KEYS} labels={INFANTRY_LABELS} breakdown={stats.infantry} />

          <section className="plan-section">
            <h3>Squares</h3>
            <div className="plan-row">
              <span className="k">Cards able to form square</span>
              <span className="v">
                {stats.squares}/{stats.infantryForSquares}
              </span>
              <span className="by" />
            </div>
          </section>

          <section className="plan-section">
            <h3>Team abilities</h3>
            {abilities.length === 0 ? (
              <div className="plan-empty-note">None.</div>
            ) : (
              abilities.map((k) => (
                <Row key={k} label={ABILITY_STAT_LABELS[k]} value={plural(stats.abilities[k].cards, "card")} />
              ))
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
