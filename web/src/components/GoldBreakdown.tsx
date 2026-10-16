import { useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MAX_BUILD_COST } from "../rules/rules";
import type { BuildState, BuildSummary, RosterIndex } from "../state/build";
import { planStats } from "../state/planStats";
import { SHARE_LABELS, plural, shareSegments, speedEntries } from "../state/planSummary";
import { HeaderPopover } from "./HeaderPopover";
import { PlanDetailsModal } from "./PlanDetailsModal";

/** The header's Gold stat: cost against the cap, a bar of where the gold goes by arm,
 *  and — on click — the per-arm breakdown with each arm's speed mix. The same
 *  share/speed tallies Ordre de Bataille uses for a team, run on this one build. */
export function GoldBreakdown({ index, build, summary }: { index: RosterIndex; build: BuildState; summary: BuildSummary }) {
  const [open, setOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const stats = useMemo(() => planStats([{ index, build }]), [index, build]);
  const segments = shareSegments(stats.share);
  const staff = stats.share.staff;
  const { baseCost, appliedDiscount, finalCost } = summary.price;
  const over = finalCost > MAX_BUILD_COST;
  const room = Math.abs(MAX_BUILD_COST - finalCost).toLocaleString();
  const barLabel = segments.some((s) => s.gold > 0)
    ? segments.map((s) => `${SHARE_LABELS[s.arm]} ${s.goldPct}%`).join(", ")
    : "No units yet";

  return (
    <>
      <button
        ref={buttonRef}
        className="hstat gold-stat"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        title="Where the gold goes, by arm"
      >
        <span className="lbl">
          <span>Gold</span>
          <span className={over ? "over-text" : undefined}>{over ? `${room} over` : `${room} left`}</span>
        </span>
        <span className="val">
          <span className={`cost${over ? " over" : ""}`}>{finalCost.toLocaleString()}</span>
          <span className="of">/ {MAX_BUILD_COST.toLocaleString()}</span>
          <span className="caret" aria-hidden>
            ▾
          </span>
        </span>
        <ShareBar segments={segments} label={barLabel} />
      </button>
      {open && (
        <HeaderPopover id={panelId} anchorRef={buttonRef} onClose={() => setOpen(false)} width={430} align="end" label="Gold breakdown" className="gold-pop">
          <div className="gold-pop-head">
            <strong>Gold breakdown</strong>
            <span className="head-pop-note">listed prices</span>
          </div>
          <ShareBar segments={segments} label={barLabel} big />
          <div className="gold-pop-rows">
            {segments.map((s) => {
              const speeds = speedEntries(s.bySpeed);
              const extra = s.arm === "artillery" && stats.guns.total > 0 ? ` · ${plural(stats.guns.total, "gun")}` : "";
              return (
                <div className="gold-pop-row" key={s.arm}>
                  <span className={`sw ${s.arm}`} aria-hidden />
                  <span className="name">
                    <span>{SHARE_LABELS[s.arm]}</span>
                    {speeds.map(([tag, n]) => (
                      <span className="spd" key={tag}>
                        {tag} ×{n}
                      </span>
                    ))}
                  </span>
                  <span className="gold">{s.gold.toLocaleString()}</span>
                  <span className="pct">{s.goldPct}%</span>
                  <span className="sub">
                    {plural(s.cards, "card")} · {s.men.toLocaleString()} men{extra}
                  </span>
                </div>
              );
            })}
            {staff.cards > 0 && (
              <div className="gold-pop-row">
                <span className="sw staff" aria-hidden />
                <span className="name">
                  <span>Staff general</span>
                </span>
                <span className="gold">{staff.gold.toLocaleString()}</span>
                <span className="pct" />
              </div>
            )}
          </div>
          <div className="gold-pop-totals">
            {appliedDiscount > 0 && (
              <>
                <span>Listed</span>
                <span className="gold">{baseCost.toLocaleString()}</span>
                <span>Formation discounts</span>
                <span className="gold discount">−{appliedDiscount.toLocaleString()}</span>
              </>
            )}
            <strong>Cost</strong>
            <strong className={`cost${over ? " over" : ""}`}>{finalCost.toLocaleString()}</strong>
          </div>
          <div className="head-pop-note">
            {over ? `${room} over` : `${room} left`} of {MAX_BUILD_COST.toLocaleString()}
          </div>
          <button className="btn small" style={{ alignSelf: "flex-start" }} 
            onClick={() => {
              // Hand over to the modal; the panel would otherwise sit above its backdrop.
              setOpen(false);
              setDetailsOpen(true);
            }}
          >
            Full details…
          </button>
        </HeaderPopover>
      )}
      {/* Portaled: this component sits inside the header's touch swipe-scroller, whose
          descendant rules (and older iOS fixed-in-scroller quirks) would reach the modal. */}
      {detailsOpen &&
        createPortal(
          <PlanDetailsModal stats={stats} title="Build details" onClose={() => setDetailsOpen(false)} />,
          buttonRef.current?.closest(".app") ?? document.body,
        )}
    </>
  );
}

function ShareBar({ segments, label, big = false }: { segments: ReturnType<typeof shareSegments>; label: string; big?: boolean }) {
  return (
    <span className={`gold-share${big ? " big" : ""}`} role="img" aria-label={label}>
      {segments
        .filter((s) => s.gold > 0)
        .map((s) => (
          <span key={s.arm} className={`seg ${s.arm}`} style={{ flexGrow: s.gold }} />
        ))}
    </span>
  );
}
