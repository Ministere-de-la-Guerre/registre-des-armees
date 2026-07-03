import { useState } from "react";
import { assetUrl } from "../data/assets";
import { CLASS_LABELS } from "../domain/labels";
import type { UnitCard } from "../domain/types";

const ABBR: Record<string, string> = {
  infantry_line: "Line",
  infantry_light: "Light",
  infantry_grenadiers: "Gren",
  infantry_skirmishers: "Skirm",
  infantry_militia: "Militia",
  infantry_irregulars: "Irreg",
  cavalry_heavy: "Hvy Cav",
  cavalry_light: "Lt Cav",
  cavalry_lancers: "Lancer",
  cavalry_standard: "Cav",
  cavalry_missile: "Cav",
  artillery_foot: "Foot Art",
  artillery_horse: "Horse Art",
  artillery_fixed: "Fixed Art",
  general: "General",
};

export interface MedallionProps {
  card: UnitCard;
  qty?: number;
  /** Copies taken across the shared cap group (base + combat-general variants);
   *  drives the cap badge so every group member shows the group's usage. Defaults
   *  to `qty` when not supplied. */
  capCount?: number;
  selected?: boolean;
  inStaffSlot?: boolean;
  dimmed?: boolean;
  blocked?: boolean;
  /** Selecting this unit would push the build past the 10,000 cost ceiling — its
   *  cost is shown red as a warning (selection is still allowed). */
  overBudget?: boolean;
  /** This unit belongs to a source corps beyond the 4 the game rolls together (or
   *  selecting it would add a 5th). Framed red as a soft warning; still allowed. */
  overCorps?: boolean;
  atCap?: boolean;
  hideName?: boolean;
  /** Show the speed/movement code (e.g. L4) as a badge in the top-left corner.
   *  Used in the build tray where the cap badge is hidden. */
  showSpeed?: boolean;
  onClick?: () => void;
  onContextMenu?: () => void;
  onHover?: (card: UnitCard, anchor: DOMRect) => void;
  onHoverEnd?: () => void;
}

/** Oval unit portrait used in the grid, build tray, and details modal. */
export function Medallion({
  card,
  qty = 0,
  capCount,
  selected = false,
  inStaffSlot = false,
  dimmed = false,
  blocked = false,
  overBudget = false,
  overCorps = false,
  atCap = false,
  hideName = false,
  showSpeed = false,
  onClick,
  onContextMenu,
  onHover,
  onHoverEnd,
}: MedallionProps) {
  const [failed, setFailed] = useState(false);
  const icon = assetUrl(card.icon);
  const badge = assetUrl(card.guerrillaBadge);
  // A general occupying the staff slot is tracked separately from instance qty,
  // so count it as one taken to show e.g. 1/1 instead of 0/1 once selected.
  const capShown = inStaffSlot ? Math.max(capCount ?? qty, 1) : capCount ?? qty;

  return (
    <div
      className={`medallion${selected ? " selected" : ""}${inStaffSlot ? " staff" : ""}${
        dimmed ? " dimmed" : ""
      }${blocked ? " blocked" : ""}${overBudget ? " overbudget" : ""}${overCorps ? " overcorps" : ""}${atCap ? " atcap" : ""}${
        hideName ? " tray-mini" : ""
      }`}
      role="button"
      tabIndex={0}
      aria-pressed={selected || inStaffSlot}
      aria-label={`${card.name}. ${CLASS_LABELS[card.unitClass] ?? card.unitClass}. Cost ${card.cost}. ${
        selected || inStaffSlot ? `Selected${qty > 1 ? `, quantity ${qty}` : ""}` : "Not selected"
      }. Enter to add, Delete to remove, i for details.`}
      onClick={onClick}
      onContextMenu={(e) => {
        if (onContextMenu) {
          e.preventDefault();
          onContextMenu();
        }
      }}
      onMouseEnter={(e) => onHover?.(card, e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => onHoverEnd?.()}
      onFocus={(e) => onHover?.(card, e.currentTarget.getBoundingClientRect())}
      onBlur={() => onHoverEnd?.()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        } else if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          onContextMenu?.();
        } else if (e.key === "i") {
          e.preventDefault();
          onContextMenu?.();
        }
      }}
    >
      {/* Men count and the cap/qty badge sit above the frame (own stacking
          context) so the oval's overflow clip never hides them. */}
      {card.finalMen != null && <span className="men">{card.finalMen}</span>}
      {showSpeed && card.speedCode && (
        <span className="speed" title={`Speed ${card.speedCode}`}>{card.speedCode}</span>
      )}
      {card.groupCap > 0 && !hideName ? (
        <span className={`qty cap${atCap ? " full" : ""}`} title={`${capShown} of ${card.groupCap} taken`}>
          {capShown}/{card.groupCap}
        </span>
      ) : qty > 1 ? (
        <span className="qty">{qty}</span>
      ) : selected && qty <= 1 && !hideName ? (
        // No checkmark in the tray — being in the tray already means selected.
        <span className="checkmark" aria-hidden>✓</span>
      ) : null}
      <div
        className="oval"
        title={overCorps ? "From a 5th+ army corps — the game rolls only 4 together" : undefined}
      >
        {icon && !failed ? (
          <img className="icon" src={icon} alt="" loading="lazy" onError={() => setFailed(true)} />
        ) : (
          <div className="fallback" aria-hidden>
            {ABBR[card.unitClass] ?? card.unitClass}
          </div>
        )}
        {card.isGeneral && card.commandStars ? (
          <span className="stars" title={`${card.commandStars} command stars`}>
            ★{card.commandStars}
          </span>
        ) : null}
        {badge && <img className="guerrilla" src={badge} alt="Guerrilla deployment" loading="lazy" />}
        <span className="coststrip">
          <span className={`cost${overBudget ? " over" : ""}`} title={overBudget ? "Selecting this would exceed the 10,000 cost limit" : undefined}>
            {card.cost.toLocaleString()}
          </span>
        </span>
      </div>
      {!hideName && <div className="name" title={card.name}>{card.name}</div>}
    </div>
  );
}
