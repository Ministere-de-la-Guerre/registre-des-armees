import { useLayoutEffect, useRef, useState } from "react";
import { ABILITY_KEYS, ABILITY_LABELS, type UnitCard } from "../domain/types";
import { classLabel } from "../domain/labels";

interface Row {
  k: string;
  v: number | null;
}

/** Brief stats overview shown on hover/focus. Clamped to stay within the viewport. */
export function Tooltip({
  card,
  anchor,
  qtyInBuild = 0,
  blockReason,
}: {
  card: UnitCard;
  anchor: DOMRect;
  qtyInBuild?: number;
  blockReason?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.left, top: anchor.bottom + 8 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    let left = anchor.left + anchor.width / 2 - width / 2;
    let top = anchor.bottom + margin;
    if (top + height > window.innerHeight - margin) top = anchor.top - height - margin;
    if (top < margin) top = margin;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    setPos({ left, top });
  }, [anchor, card]);

  const rows: Row[] = [
    { k: "Cap", v: card.groupCap > 0 ? card.groupCap : null },
    { k: "In build", v: card.groupCap > 0 ? qtyInBuild : null },
    { k: "Cap left", v: card.groupCap > 0 ? Math.max(0, card.groupCap - qtyInBuild) : null },
    { k: "Men", v: card.finalMen },
    { k: "Range", v: card.range },
    { k: "Accuracy", v: card.stats.accuracy },
    { k: "Reload", v: card.stats.reloadSkill },
    { k: "Morale", v: card.stats.morale },
    { k: "Melee atk", v: card.stats.meleeAttack },
    { k: "Melee def", v: card.stats.meleeDefense },
    { k: "Charge", v: card.stats.chargeBonus },
    { k: "Stars", v: card.commandStars },
  ].filter((r) => r.v !== null);

  const abilities = ABILITY_KEYS.filter((k) => card.abilities[k]);

  return (
    <div ref={ref} className="tooltip" style={{ left: pos.left, top: pos.top }} role="tooltip">
      <h5>{card.name}</h5>
      <div className="tt-sub">
        {classLabel(card.unitClass)}
        {card.isGeneral && card.generalKind ? ` · ${card.generalKind} general` : ""} ·{" "}
        <span className="cost">{card.cost.toLocaleString()}</span>
      </div>
      <div className="tt-grid">
        {rows.map((r) => (
          <div key={r.k} style={{ display: "contents" }}>
            <span className="k">{r.k}</span>
            <span className="v">{r.v}</span>
          </div>
        ))}
      </div>
      {abilities.length > 0 && (
        <div className="tt-abils">
          {abilities.map((k) => (
            <span className="tag" key={k}>
              {ABILITY_LABELS[k]}
            </span>
          ))}
        </div>
      )}
      {blockReason && <div className="tt-block">⚠ {blockReason}</div>}
      <div className="tt-hint">Left-click to add · right-click for full details</div>
    </div>
  );
}
