import { useRef, useState } from "react";
import { assetUrl } from "../data/assets";
import { CLASS_LABELS } from "../domain/labels";
import type { UnitCard } from "../domain/types";
import { isCoarsePointer } from "./useCoarsePointer";
import { useLongPress } from "./useLongPress";

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
  /** Touch grid only: this is the "primed" unit — its stat card has been shown by a
   *  first tap, so the next tap adds it. Draws a highlight ring. Always false on
   *  desktop (which has no two-tap model). */
  primed?: boolean;
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
  /** Force the speed/movement code (e.g. L4) badge in the build tray, where the
   *  cap badge is hidden. The grid shows the speed pill too (under the cap badge),
   *  driven by `!hideName` rather than this flag. */
  showSpeed?: boolean;
  onClick?: (anchor?: DOMRect) => void;
  onContextMenu?: () => void;
  onHover?: (card: UnitCard, anchor: DOMRect) => void;
  onHoverEnd?: () => void;
  /** Touch peek: show the simplified stat card. On coarse-pointer devices this
   *  replaces one of the two gestures (see `peekOn`); it is inert on desktop,
   *  where hover already shows the same card and right-click opens full details. */
  onPeek?: (card: UnitCard, anchor: DOMRect) => void;
  /** Which touch gesture opens the peek card. Grid medallions peek on long-press
   *  (tap adds); tray medallions peek on tap (long-press removes). Default
   *  "longpress" matches the grid, the common case. */
  peekOn?: "tap" | "longpress";
  /** Tray only: open the combat-general swap for this selected copy. Renders a small
   *  ★ badge on the portrait; the badge owns its own taps, so the medallion's own
   *  gestures (details/peek, remove) are untouched. */
  onSwapGeneral?: () => void;
  /** The copy this medallion shows is currently led by a combat general (lights the
   *  ★ badge). */
  ledByGeneral?: boolean;
}

/** Oval unit portrait used in the grid, build tray, and details modal. */
export function Medallion({
  card,
  qty = 0,
  capCount,
  selected = false,
  inStaffSlot = false,
  primed = false,
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
  onPeek,
  peekOn = "longpress",
  onSwapGeneral,
  ledByGeneral = false,
}: MedallionProps) {
  const [failed, setFailed] = useState(false);
  const coarse = isCoarsePointer();
  // The peek stat card needs the tapped medallion's on-screen position so it can
  // spawn clear of the unit (upper half when the unit is low on the screen). Read
  // it from the root at gesture time — it's always in its final position by then.
  const rootRef = useRef<HTMLDivElement>(null);
  const anchorRect = () => rootRef.current?.getBoundingClientRect() ?? new DOMRect();
  // Touch model. On desktop (fine pointer) the hook ignores mouse pointers, so a
  // long-press never fires and right-click/hover behave exactly as before.
  //   • Grid: no `onPeek` is passed, so tap = onClick and long-press = onContextMenu.
  //     The Builder wires those (on coarse pointers) to its two-tap model: first tap
  //     primes + peeks, second tap adds; long-press removes a copy. Peeking is driven
  //     from the Builder, not from here.
  //   • Tray (peekOn "tap"): tap = the simplified stat card; long-press keeps the
  //     right-click action (remove/clear).
  const peekActive = coarse && !!onPeek;
  const longPressAction = peekActive && peekOn === "longpress" ? () => onPeek!(card, anchorRect()) : onContextMenu;
  const longPress = useLongPress(longPressAction);
  const icon = assetUrl(card.icon);
  const badge = assetUrl(card.guerrillaBadge);
  // A general occupying the staff slot is tracked separately from instance qty,
  // so count it as one taken to show e.g. 1/1 instead of 0/1 once selected.
  const capShown = inStaffSlot ? Math.max(capCount ?? qty, 1) : capCount ?? qty;

  return (
    <div
      className={`medallion${selected ? " selected" : ""}${inStaffSlot ? " staff" : ""}${
        primed ? " primed" : ""
      }${dimmed ? " dimmed" : ""}${blocked ? " blocked" : ""}${overBudget ? " overbudget" : ""}${overCorps ? " overcorps" : ""}${atCap ? " atcap" : ""}${
        hideName ? " tray-mini" : ""
      }`}
      ref={rootRef}
      role="button"
      tabIndex={0}
      aria-pressed={selected || inStaffSlot}
      aria-label={`${card.name}. ${CLASS_LABELS[card.unitClass] ?? card.unitClass}. Cost ${card.cost}. ${
        selected || inStaffSlot ? `Selected${qty > 1 ? `, quantity ${qty}` : ""}` : "Not selected"
      }. Enter to add, Delete to remove, i for details.`}
      {...longPress.handlers}
      onClick={() => {
        // Swallow the click the browser fires right after a touch long-press.
        if (longPress.wasRecent()) return;
        // On touch, a tray medallion's tap opens the peek card instead of its
        // desktop click action (which is "show full details").
        if (peekActive && peekOn === "tap") {
          onPeek!(card, anchorRect());
          return;
        }
        onClick?.(anchorRect());
      }}
      onContextMenu={(e) => {
        if (!onContextMenu) return;
        e.preventDefault();
        // On Android a long-press also synthesizes contextmenu; the hook already
        // fired the callback, so ignore the duplicate.
        if (longPress.wasRecent()) return;
        onContextMenu();
      }}
      // Desktop hover shows the stat card. On touch a tap synthesizes a
      // `mouseenter`, which would pop that same card on every select — gate the
      // hover path off on coarse pointers (touch uses the explicit peek gesture
      // instead). Desktop mice keep hover-shows-tooltip.
      onMouseEnter={(e) => !coarse && onHover?.(card, e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => !coarse && onHoverEnd?.()}
      // On touch, a tap focuses the medallion — firing this would pop the hover
      // card on every select. Gate the focus-tooltip path off on coarse pointers;
      // desktop keyboard users (fine pointer) keep focus-shows-tooltip.
      onFocus={(e) => !coarse && onHover?.(card, e.currentTarget.getBoundingClientRect())}
      onBlur={() => !coarse && onHoverEnd?.()}
      onKeyDown={(e) => {
        // Only keys aimed at the medallion itself — never ones typed on a child
        // control (the ★ swap badge), which owns its own Enter/Space.
        if (e.target !== e.currentTarget) return;
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
      {/* Speed/movement pill, top-left. Shown in the build tray (showSpeed) and in
          the grid, where it stacks directly under the cap badge (see the
          `:not(.tray-mini) .speed` rule). Hidden in the modal head (hideName). */}
      {card.speedCode && (showSpeed || !hideName) && (
        <span className="speed" title={`Speed ${card.speedCode}`}>{card.speedCode}</span>
      )}
      {/* The build tray (showSpeed) mirrors the desktop tray: speed badge only,
          no cap/qty/checkmark clutter. The cap badge stays in the grid, where
          showSpeed is off — it sits directly above the grid's speed pill. */}
      {card.groupCap > 0 && !hideName && !showSpeed ? (
        <span className={`qty cap${atCap ? " full" : ""}`} title={`${capShown} of ${card.groupCap} taken`}>
          {capShown}/{card.groupCap}
        </span>
      ) : qty > 1 ? (
        <span className="qty">{qty}</span>
      ) : selected && qty <= 1 && !hideName && !showSpeed ? (
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
        {/* Combat-general swap badge (build tray only). It rides on the portrait — like
            the guerrilla badge, but bottom-left — so it stays on the oval whether or not
            the medallion also draws a name under it. It swallows its own pointer events,
            so pressing it never runs the medallion's own click/long-press action. */}
        {onSwapGeneral && (
          <button
            type="button"
            className={`gen-swap${ledByGeneral ? " on" : ""}`}
            aria-label={
              ledByGeneral
                ? `Change or remove the combat general leading ${card.name}`
                : `Give ${card.name} a combat general`
            }
            title={
              ledByGeneral
                ? "Change or remove this unit's combat general"
                : "Swap this unit for a combat general leading it"
            }
            // Pointer events must not reach the medallion — they would arm its long-press
            // (remove a copy). Keys must NOT be stopped: React dispatches from the root, so
            // stopping a key here would also stop it reaching the document listeners that
            // close modals on Escape. The medallion's onKeyDown ignores keys from children.
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSwapGeneral();
            }}
          >
            ★
          </button>
        )}
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
