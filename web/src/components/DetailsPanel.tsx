import { useEffect } from "react";
import { ABILITY_KEYS, ABILITY_LABELS, type UnitCard } from "../domain/types";
import { classLabel } from "../domain/labels";
import { Medallion } from "./Medallion";

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
  onClose,
}: {
  card: UnitCard;
  inStaffSlot?: boolean;
  onSetCommander?: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

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
          <button className="btn small" onClick={onClose} aria-label="Close details">
            ✕
          </button>
        </div>
        <div className="modal-body">
          {onSetCommander && (
            <div className="modal-actions">
              <button className={`btn small ${inStaffSlot ? "gold" : "primary"}`} onClick={onSetCommander}>
                {inStaffSlot ? "★ Remove from staff slot" : "★ Set as corps commander (staff slot)"}
              </button>
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
            <StatRow k="Morale" v={card.stats.morale} />
            <StatRow k="Melee attack" v={card.stats.meleeAttack} />
            <StatRow k="Melee defence" v={card.stats.meleeDefense} />
            <StatRow k="Charge bonus" v={card.stats.chargeBonus} />
          </div>
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
