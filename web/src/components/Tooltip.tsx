import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ABILITY_KEYS, ABILITY_LABELS, type UnitCard } from "../domain/types";
import { classLabel } from "../domain/labels";

interface Row {
  k: string;
  v: number | null;
}

/** Brief stats overview. Two presentations from one body:
 *  - "hover" (desktop): follows the anchored medallion, clamped to the viewport,
 *    non-interactive (pointer-events: none).
 *  - "peek" (touch): a bottom-anchored popover that never clips off-screen, with a
 *    "Full details" action (DetailsPanel is otherwise orphaned once long-press
 *    stops opening it) and tap/scroll/outside-tap dismissal. */
export function Tooltip({
  card,
  anchor,
  blockReason,
  variant = "hover",
  onFullDetails,
  onDismiss,
}: {
  card: UnitCard;
  anchor: DOMRect;
  blockReason?: string | null;
  variant?: "hover" | "peek";
  onFullDetails?: () => void;
  onDismiss?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const peek = variant === "peek";
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.left, top: anchor.bottom + 8 });

  // Peek placement: the card is normally bottom-anchored, but a unit in the lower
  // half of the screen would sit behind it — and the two-tap model needs a *second*
  // tap on that same unit to select it. When the peeked unit is in the lower half,
  // spawn the card in the upper half instead so the unit stays reachable for an
  // immediate second tap without dragging the card out of the way.
  const atTop = peek && anchor.top + anchor.height / 2 > window.innerHeight / 2;

  // Peek drag: the card is bottom-anchored, so a unit in the bottom rows sits
  // behind it — and the two-tap model needs a *second* tap on that same unit to
  // select it. The drag handle lets the player slide the card off the unit (as an
  // offset from its default bottom-centered spot) and then tap through to it. The
  // offset resets whenever a different unit is peeked, so each card opens in place.
  const [drag, setDrag] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const dragState = useRef<{ id: number; lastX: number; lastY: number } | null>(null);
  useEffect(() => setDrag({ dx: 0, dy: 0 }), [card]);

  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragState.current = { id: e.pointerId, lastX: e.clientX, lastY: e.clientY };
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const st = dragState.current;
    const el = ref.current;
    if (!st || st.id !== e.pointerId || !el) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const edge = 44; // keep at least this much of the card reachable on every side
    let ddx = e.clientX - st.lastX;
    let ddy = e.clientY - st.lastY;
    ddx = Math.max(edge - r.right, Math.min(window.innerWidth - edge - r.left, ddx));
    ddy = Math.max(edge - r.bottom, Math.min(window.innerHeight - edge - r.top, ddy));
    st.lastX = e.clientX;
    st.lastY = e.clientY;
    setDrag((d) => ({ dx: d.dx + ddx, dy: d.dy + ddy }));
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragState.current?.id === e.pointerId) dragState.current = null;
  };

  useLayoutEffect(() => {
    if (peek) return; // peek is CSS-positioned (bottom-centered), no measuring needed.
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
  }, [anchor, card, peek]);

  // Peek dismissal: tap outside it, or scroll anywhere. (Tapping the card itself is
  // handled by onClick below.) Listeners attach on the next frame so the very
  // gesture that opened the card doesn't immediately close it.
  useEffect(() => {
    if (!peek || !onDismiss) return;
    let armed = false;
    const arm = requestAnimationFrame(() => (armed = true));
    const onPointerDown = (e: PointerEvent) => {
      if (!armed) return;
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      // A tap on a grid/tray medallion is owned by the two-tap model (act on the
      // primed unit, or re-peek a different one) — dismissing here would clear the
      // prime out from under that tap's click, so the "add" never fires and the
      // card just flickers. Let the medallion handle its own taps; only truly
      // outside taps (empty space, buttons, chrome) dismiss the peek.
      if (e.target instanceof Element && e.target.closest(".medallion")) return;
      onDismiss();
    };
    const onScroll = () => armed && onDismiss();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      cancelAnimationFrame(arm);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [peek, onDismiss]);

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
    <div
      ref={ref}
      className={`tooltip${peek ? " peek" : ""}${atTop ? " peek-top" : ""}`}
      style={
        peek
          ? { transform: `translate(calc(-50% + ${drag.dx}px), ${drag.dy}px)` }
          : { left: pos.left, top: pos.top }
      }
      role="tooltip"
      // Tapping the card itself dismisses it (in addition to the outside/scroll
      // listeners); guard so a tap on the "Full details" button doesn't double-fire.
      onClick={peek ? () => onDismiss?.() : undefined}
    >
      {peek && (
        <div
          className="tt-drag"
          // Slide the card without dismissing it; stop the tap from bubbling to the
          // card's dismiss handler so a grab-and-release doesn't close it.
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onClick={(e) => e.stopPropagation()}
          aria-hidden="true"
        >
          <span className="tt-grip" />
        </div>
      )}
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
      {peek ? (
        <div className="tt-actions">
          <button
            type="button"
            className="btn small"
            onClick={(e) => {
              e.stopPropagation();
              onFullDetails?.();
            }}
          >
            Full details
          </button>
        </div>
      ) : (
        <div className="tt-hint">Left-click to add · right-click for full details</div>
      )}
    </div>
  );
}
