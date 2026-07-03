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
  blockReason,
}: {
  card: UnitCard;
  anchor: DOMRect;
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

  // Stat order depends on what the unit actually does. Combat generals report their
  // underlying unit class so they read like the unit they lead.
  const cls = card.underlyingUnitClass || card.unitClass;
  const s = card.stats;
  const shoots = card.range !== null; // has a ranged weapon
  let rows: Row[];
  if (cls.startsWith("artillery")) {
    rows = [
      { k: "Range", v: card.range },
      { k: "Accuracy", v: s.accuracy },
      { k: "Melee def", v: s.meleeDefense },
      { k: "Morale", v: s.morale },
    ];
  } else if (cls.startsWith("cavalry") && !shoots) {
    // Melee cavalry (no firearm).
    rows = [
      { k: "Melee atk", v: s.meleeAttack },
      { k: "Charge", v: s.chargeBonus },
      { k: "Melee def", v: s.meleeDefense },
      { k: "Morale", v: s.morale },
    ];
  } else {
    // Infantry, skirmishers, and ranged cavalry — anything that shoots but isn't artillery.
    rows = [
      { k: "Range", v: card.range },
      { k: "Accuracy", v: s.accuracy },
      { k: "Reload", v: s.reloadSkill },
      { k: "Melee atk", v: s.meleeAttack },
      { k: "Melee def", v: s.meleeDefense },
      { k: "Morale", v: s.morale },
    ];
  }
  rows = rows.filter((r) => r.v !== null);

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
