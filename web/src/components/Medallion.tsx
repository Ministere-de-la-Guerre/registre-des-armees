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
  atCap?: boolean;
  hideName?: boolean;
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
  atCap = false,
  hideName = false,
  onClick,
  onContextMenu,
  onHover,
  onHoverEnd,
}: MedallionProps) {
  const [failed, setFailed] = useState(false);
  const icon = assetUrl(card.icon);
  const badge = assetUrl(card.guerrillaBadge);
  const capShown = capCount ?? qty;

  return (
    <div
      className={`medallion${selected ? " selected" : ""}${inStaffSlot ? " staff" : ""}${
        dimmed ? " dimmed" : ""
      }${blocked ? " blocked" : ""}${atCap ? " atcap" : ""}${hideName ? " tray-mini" : ""}`}
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
      <div className="oval">
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
          <span className="cost">{card.cost.toLocaleString()}</span>
        </span>
      </div>
      {!hideName && <div className="name" title={card.name}>{card.name}</div>}
    </div>
  );
}
