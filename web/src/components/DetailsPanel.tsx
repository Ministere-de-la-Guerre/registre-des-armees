import { useEffect, useRef } from "react";
import { ABILITY_KEYS, ABILITY_LABELS, type UnitCard } from "../domain/types";
import { classLabel } from "../domain/labels";
import { Medallion } from "./Medallion";
import { PICK_RATES_ENABLED } from "../features/pickRates/flag";
import { bucketOf, longLabel } from "../features/pickRates/pickRates";
import type { PickRateSeason, RegimentRollup, UnitPickRate } from "../features/pickRates/types";

function StatRow({ k, v }: { k: string; v: number | string | null }) {
  return (
    <div className="stat">
      <span className="k">{k}</span>
      <span className="v">{v === null || v === "" ? "—" : v}</span>
    </div>
  );
}

/** Full stats + abilities for a unit. Opened by right-clicking a unit. */
export function DetailsPanel({
  card,
  inStaffSlot,
  onSetCommander,
  setCommanderBlockedReason = null,
  onRecruitAsUnit,
  recruitBlockedReason = null,
  onClose,
  pickRate = null,
  pickRateRegiment = null,
  pickRateCombined = false,
  pickRateSeason = null,
}: {
  card: UnitCard;
  inStaffSlot?: boolean;
  onSetCommander?: () => void;
  /** Why this general can't take the staff slot right now (a hard limit the result
   *  would break); disables the button. Null when allowed, or when clearing the slot. */
  setCommanderBlockedReason?: string | null;
  /** Recruit this card as an ordinary unit rather than putting it in the staff slot.
   *  Offered for staff generals, which the grid otherwise only ever routes to the
   *  commander slot — the game allows fielding one as a normal unit (real replays do
   *  it, with a combat general commanding instead). */
  onRecruitAsUnit?: () => void;
  /** Why recruiting is currently impossible (cap reached, etc.); disables the button. */
  recruitBlockedReason?: string | null;
  onClose: () => void;
  /** Optional feature (features/pickRates): null when off or still loading. */
  pickRate?: UnitPickRate | null;
  /** The regiment behind this card, across all its variants. */
  pickRateRegiment?: RegimentRollup | null;
  /** Whether `pickRate` is already the combined (unit + generals) figure, which it is
   *  when combat generals are hidden. Only the wording changes — the headline must
   *  always name the same number the medallion shows. */
  pickRateCombined?: boolean;
  pickRateSeason?: PickRateSeason | null;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Take focus while open so keys stop reaching whatever opened the panel (a focused
  // medallion would otherwise take Enter/Space as "add"), and hand it back on close.
  // The close button, not an action: a stray Enter should never change the build.
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const abilities = ABILITY_KEYS.filter((k) => card.abilities[k]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={card.name} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <Medallion card={card} hideName />
          <div>
            <h3 style={{ color: "var(--gold-bright)" }}>{card.name}</h3>
            <div style={{ fontSize: 12, opacity: 0.9 }}>
              {classLabel(card.unitClass)}
              {card.isGeneral && card.generalKind ? ` · ${card.generalKind} general` : ""}
              {card.isCommanderVariant ? " · commander variant" : ""}
            </div>
            <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>{card.unitKey}</div>
          </div>
          <div style={{ flex: 1 }} />
          <button ref={closeRef} className="btn small" onClick={onClose} aria-label="Close details">
            ✕
          </button>
        </div>
        <div className="modal-body">
          {(onSetCommander || onRecruitAsUnit) && (
            <div className="modal-actions">
              {onSetCommander && (
                <button
                  className={`btn small ${inStaffSlot ? "gold" : "primary"}`}
                  onClick={onSetCommander}
                  disabled={!!setCommanderBlockedReason}
                  title={setCommanderBlockedReason ?? undefined}
                >
                  {inStaffSlot ? "★ Remove from staff slot" : "★ Set as corps commander (staff slot)"}
                </button>
              )}
              {onRecruitAsUnit && (
                <button
                  className="btn small"
                  onClick={onRecruitAsUnit}
                  disabled={!!recruitBlockedReason}
                  title={recruitBlockedReason ?? "Add this general to the build as an ordinary unit"}
                >
                  + Recruit as a unit
                </button>
              )}
            </div>
          )}
          <div className="stat-grid">
            <StatRow k="Cost" v={card.cost.toLocaleString()} />
            <StatRow k="Unit cap" v={card.groupCap > 0 ? card.groupCap : "∞"} />
            <StatRow k="Men" v={card.finalMen} />
            <StatRow k="Class" v={classLabel(card.unitClass)} />
            <StatRow k="Division / Brigade" v={card.divisionBrigadeCode ?? "—"} />
            <StatRow k="Speed code" v={card.speedCode} />
            <StatRow k="Command stars" v={card.commandStars} />
            <StatRow k="Range" v={card.range} />
            <StatRow k="Accuracy" v={card.stats.accuracy} />
            <StatRow k="Reload skill" v={card.stats.reloadSkill} />
            {/* Melee units and generals carry 0 rounds: show a dash, not "0". */}
            <StatRow k="Ammo" v={card.stats.ammo || null} />
            <StatRow k="Morale" v={card.stats.morale} />
            <StatRow k="Melee attack" v={card.stats.meleeAttack} />
            <StatRow k="Melee defence" v={card.stats.meleeDefense} />
            <StatRow k="Charge bonus" v={card.stats.chargeBonus} />
          </div>
          {/* Full width below the grid: firearm names run long ("Land Pattern (aka
              Brown Bess)"), too long for a half-width cell at phone width. */}
          {card.stats.firearm && (
            <div className="stat stat-wide">
              <span className="k">Firearm</span>
              <span className="v">{card.stats.firearm}</span>
            </div>
          )}
          {PICK_RATES_ENABLED && pickRate && (
            <>
              <div className="section-title">
                Pick rate{pickRateSeason ? ` · ${pickRateSeason.label}` : ""}
              </div>
              <div className="stat-grid">
                <StatRow
                  k={pickRateCombined ? "This unit + its generals" : "This card"}
                  v={longLabel(pickRate)}
                />
                {pickRate.kind === "data" && (
                  <StatRow k="Copies when picked" v={pickRate.copies.toFixed(2)} />
                )}
                {/* The other question — shown only when it isn't already the headline,
                    so the panel never states the same number twice under two names. */}
                {pickRateRegiment && !pickRateCombined && (
                  <StatRow
                    k="This regiment (all variants)"
                    v={`${pickRateRegiment.builds} of ${pickRateRegiment.n}`}
                  />
                )}
                {pickRateRegiment && pickRateRegiment.officerBuilds > 0 && (
                  <StatRow
                    k="…led by an officer"
                    v={`${pickRateRegiment.officerBuilds} of ${pickRateRegiment.builds}`}
                  />
                )}
                {pickRateSeason && bucketOf(pickRate, pickRateSeason.thresholds) && (
                  <StatRow k="Bucket" v={bucketOf(pickRate, pickRateSeason.thresholds)} />
                )}
              </div>
            </>
          )}
          <div className="section-title">Abilities</div>
          {abilities.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>No special abilities listed.</div>
          ) : (
            <div className="ability-list">
              {abilities.map((k) => (
                <span className="tag" key={k} style={{ color: "var(--ink)" }}>
                  {ABILITY_LABELS[k]}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
