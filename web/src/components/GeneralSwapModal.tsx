import { useEffect, useState } from "react";
import { assetUrl } from "../data/assets";
import { classLabel } from "../domain/labels";
import type { UnitCard } from "../domain/types";
import type { GeneralSwap, SwapOption } from "../state/build";
import { PICK_RATES_ENABLED } from "../features/pickRates/flag";
import type { ChooserRateRow, ChooserRates } from "../features/pickRates/suggest";
import { Medallion } from "./Medallion";

/** Choose which combat general leads one selected copy of a unit — or send it back to
 *  the plain unit. Opened from the ★ badge on a copy in the build tray, so a unit can
 *  be taken first and given its general later, without giving up the slot.
 *
 *  The swap keeps the copy's slot: a general variant *is* the unit under that officer,
 *  so the card count, the unit's shared cap and its class caps are all unchanged — only
 *  the cost and the combat-general cap move (see state/build.generalSwapFor). */
export function GeneralSwapModal({
  swap,
  combatCap,
  combatGensUsed,
  rates,
  onPick,
  onClose,
}: {
  swap: GeneralSwap;
  combatCap: number;
  combatGensUsed: number;
  /** Pick-rate numbers for this regiment (features/pickRates); absent = nothing extra. */
  rates?: ChooserRates | null;
  onPick: (unitKey: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const base = swap.plain?.card ?? swap.current;
  const left = Math.max(0, combatCap - combatGensUsed);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal gen-swap-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Combat general for ${base.name}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <Medallion card={swap.current} hideName />
          <div className="gen-swap-title">
            <h3 style={{ color: "var(--gold-bright)" }}>Combat general</h3>
            <div style={{ fontSize: 12, opacity: 0.9 }}>{base.name}</div>
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>
              {classLabel(base.unitClass)} · {combatGensUsed}/{combatCap} combat generals used ({left} left)
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <p className="gen-swap-intro">
            A combat general takes this unit’s slot rather than a new one — the same regiment, now led into
            battle by an officer. Pick one, or put the plain unit back.
          </p>
          {PICK_RATES_ENABLED && rates && (
            <p className="sg-legend">
              <span className="sg-dot all" /> gold = all builds · <span className="sg-dot like" /> azure = builds
              most like yours
            </p>
          )}
          <div className="swap-list">
            {swap.plain && (
              <SwapRow
                option={swap.plain}
                plain
                onPick={onPick}
                rates={rates ?? undefined}
                row={rates?.plain}
              />
            )}
            {swap.generals.map((option) => (
              <SwapRow
                key={option.card.unitKey}
                option={option}
                onPick={onPick}
                rates={rates ?? undefined}
                row={rates?.generals[option.card.unitKey]}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SwapRow({
  option,
  plain = false,
  onPick,
  rates,
  row,
}: {
  option: SwapOption;
  plain?: boolean;
  onPick: (unitKey: string) => void;
  rates?: ChooserRates;
  row?: ChooserRateRow;
}) {
  const { card, current, costDelta, blockedReason, overBudget } = option;
  const delta =
    costDelta === 0
      ? "same cost"
      : costDelta > 0
        ? `+${costDelta.toLocaleString()}`
        : `−${Math.abs(costDelta).toLocaleString()}`;

  return (
    <button
      type="button"
      className={`swap-row${current ? " current" : ""}${blockedReason ? " blocked" : ""}${
        PICK_RATES_ENABLED && rates && row ? " sg-rated" : ""
      }`}
      disabled={current || blockedReason !== null}
      onClick={() => onPick(card.unitKey)}
    >
      <Portrait card={card} />
      <span className="swap-text">
        <span className="swap-name">{plain ? "No general — the plain unit" : card.name}</span>
        <span className="swap-sub">
          {plain
            ? "The regiment on its own, as you first selected it."
            : `${card.commandStars ? `★${card.commandStars} command · ` : ""}${card.finalMen ?? "—"} men`}
        </span>
        {PICK_RATES_ENABLED && rates && row && <RateBars rates={rates} row={row} plain={plain} />}
        {blockedReason && <span className="swap-block">{blockedReason}</span>}
      </span>
      <span className="swap-cost">
        <span className={`cost${overBudget && !current ? " over" : ""}`}>{card.cost.toLocaleString()}</span>
        <span className={`swap-delta${costDelta > 0 ? " up" : costDelta < 0 ? " down" : ""}`}>
          {current ? "Current" : delta}
        </span>
      </span>
    </button>
  );
}

/** The two thin bars under a row's sub-line: all recorded builds (gold) and the builds
 *  most like the player's (azure). Texts are fixed wording, see docs/PICK_RATES.md. */
function RateBars({ rates, row, plain }: { rates: ChooserRates; row: ChooserRateRow; plain: boolean }) {
  const { regB, M } = rates;
  const pct = (n: number, d: number) => `${d > 0 ? Math.min(100, (100 * n) / d).toFixed(1) : 0}%`;
  const allText = plain
    ? `No general in ${row.all.toLocaleString()} of ${regB.toLocaleString()} builds with this regiment`
    : `Picked in ${row.all.toLocaleString()} of ${regB.toLocaleString()} builds with this regiment`;
  return (
    <span className="sg-rates">
      <span className="sg-rate-label">All builds</span>
      <span className="sg-rate-line">
        <span className="sg-rate-track gold">
          <span style={{ width: pct(row.all, regB) }} />
        </span>
        <span className="sg-rate-text">{allText}</span>
      </span>
      {row.like !== null && M !== null && M > 0 && (
        <>
          <span className="sg-rate-label">Like yours</span>
          <span className="sg-rate-line">
            <span className="sg-rate-track azure">
              <span style={{ width: pct(row.like, M) }} />
            </span>
            <span className="sg-rate-text">
              {row.like} of {M} similar builds
            </span>
          </span>
        </>
      )}
    </span>
  );
}

/** Round portrait for a row. Deliberately not a Medallion: this one lives inside the
 *  row's own <button>, so it must be inert markup (no nested control) — and the row
 *  spells out the stats a medallion's badges would otherwise repeat. */
function Portrait({ card }: { card: UnitCard }) {
  const [failed, setFailed] = useState(false);
  const icon = assetUrl(card.icon);
  return (
    <span className="swap-portrait" aria-hidden>
      {icon && !failed ? (
        <img src={icon} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="swap-portrait-fallback">{classLabel(card.unitClass)}</span>
      )}
    </span>
  );
}
