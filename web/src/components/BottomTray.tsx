import { useState } from "react";
import type { UnitCard } from "../domain/types";
import { MAX_TOTAL_UNIT_CARDS } from "../rules/rules";
import type { BuildState, BuildSummary as Summary, RosterIndex } from "../state/build";
import { Medallion } from "./Medallion";
import { useCoarsePointer } from "./useCoarsePointer";

interface TrayProps {
  index: RosterIndex;
  build: BuildState;
  summary: Summary;
  /** Flags a selected copy whose source corps is beyond the 4-corps roll (TOW). */
  isOverCorps: (card: UnitCard) => boolean;
  onRemoveInstance: (instanceId: string) => void;
  /** True when this unit has a combat general in the roster — i.e. the selected copy
   *  can be swapped for (or, if it already is one, out of) a general leading it. */
  canSwapGeneral: (card: UnitCard) => boolean;
  /** Open the combat-general chooser for one selected copy. */
  onSwapGeneral: (instanceId: string) => void;
  onClearStaff: () => void;
  onClearBuild: () => void;
  onAutoGenerals: () => void;
  autoGeneralsDisabled: boolean;
  onResetGenerals: () => void;
  resetGeneralsDisabled: boolean;
  /** Export the build as a single-line image (clipboard on desktop, save on touch). */
  onExportImage: () => void;
  exportDisabled: boolean;
  onDetails: (card: UnitCard) => void;
  onHover: (card: UnitCard, anchor: DOMRect) => void;
  onHoverEnd: () => void;
  /** Touch peek: tap a tray medallion → simplified stat card (inert on desktop). */
  onPeek: (card: UnitCard, anchor: DOMRect) => void;
  /** TOW-only "Corps N/4" roll stat for the collapsed touch strip; null otherwise. */
  corpsStat: { count: number; max: number; over: boolean } | null;
  /** Locate mode: clicking a unit here finds it in the grid instead of opening details. */
  locating: boolean;
  onToggleLocate: () => void;
  onLocate: (card: UnitCard) => void;
}

/** The build tray: the staff slot (commander), then one medallion per selected
 *  copy in a single line, padded with empty slots up to the 31-card maximum. Each
 *  copy is independently removable (right-click). Running totals live in the top
 *  bar; only the Clear-build action remains here. Mirrors the game's unit bar.
 *
 *  On touch devices this instead collapses to a slim summary strip that expands
 *  into a scrollable bottom sheet (see TouchTray); desktop is untouched. */
export function BottomTray(props: TrayProps) {
  const coarse = useCoarsePointer();
  return coarse ? <TouchTray {...props} /> : <DesktopTray {...props} />;
}

function DesktopTray({
  index,
  build,
  summary,
  onRemoveInstance,
  canSwapGeneral,
  onSwapGeneral,
  onClearStaff,
  onClearBuild,
  onAutoGenerals,
  autoGeneralsDisabled,
  onResetGenerals,
  resetGeneralsDisabled,
  onExportImage,
  exportDisabled,
  isOverCorps,
  onDetails,
  onHover,
  onHoverEnd,
  locating,
  onToggleLocate,
  onLocate,
}: TrayProps) {
  const { totalCards } = summary;
  const staffCard = build.staffSlotUnitKey ? index.byKey.get(build.staffSlotUnitKey) : undefined;

  const instances = build.instances
    .map((inst) => ({ inst, card: index.byKey.get(inst.unitKey) }))
    .filter((e): e is { inst: { id: string; unitKey: string }; card: UnitCard } => Boolean(e.card));

  // The staff slot counts toward the 31-card limit; the single line shows the
  // remaining copies plus empty slots so the whole army fits one row.
  const emptyCount = Math.max(0, MAX_TOTAL_UNIT_CARDS - totalCards);
  const hasBuild = build.instances.length > 0 || build.staffSlotUnitKey !== null;
  // Removing a copy unmounts its medallion without a mouseleave, which would leave
  // its hover card stuck on screen — so end the hover first.
  const removeInstance = (id: string) => {
    onHoverEnd();
    onRemoveInstance(id);
  };
  const clearStaff = () => {
    onHoverEnd();
    onClearStaff();
  };
  // Left-click: details, or in locate mode, find the unit in the grid.
  const activate = (card: UnitCard) => (locating ? onLocate(card) : onDetails(card));
  const activateLabel = locating ? "find it in the grid" : "show details";

  return (
    <div className={`tray${locating ? " locating" : ""}`}>
      {/* The commander rides in the same flex row as the unit slots so its portrait
          is always exactly one slot wide, at any resolution. The label and the
          divider that follows keep it visually set apart as its own staff slot. */}
      <div className="slots" aria-label="Selected units">
        <div className="staff-cell">
          <span className="slot-label">Commander</span>
          {staffCard ? (
            <Medallion
              card={staffCard}
              inStaffSlot
              hideName
              onClick={() => activate(staffCard)}
              activateLabel={activateLabel}
              onContextMenu={clearStaff}
              onRemove={clearStaff}
              onDetails={() => onDetails(staffCard)}
              onHover={onHover}
              onHoverEnd={onHoverEnd}
            />
          ) : (
            <span className="empty-oval" title="“Set commander” on any general" aria-hidden />
          )}
        </div>
        <span className="staff-div" aria-hidden />
        {instances.map(({ inst, card }) => (
          <Medallion
            key={inst.id}
            card={card}
            selected
            hideName
            showSpeed
            overCorps={isOverCorps(card)}
            onClick={() => activate(card)}
            activateLabel={activateLabel}
            onContextMenu={() => removeInstance(inst.id)}
            onRemove={() => removeInstance(inst.id)}
            onDetails={() => onDetails(card)}
            onHover={onHover}
            onHoverEnd={onHoverEnd}
            onSwapGeneral={canSwapGeneral(card) ? () => onSwapGeneral(inst.id) : undefined}
            ledByGeneral={card.isGeneral && card.generalKind === "combat"}
          />
        ))}
        {Array.from({ length: emptyCount }).map((_, i) => (
          <span className="empty-oval" key={i} aria-hidden />
        ))}
      </div>

      <div className="totals">
        <button
          className={`btn small locate-unit${locating ? " gold" : ""}`}
          aria-pressed={locating}
          disabled={!hasBuild && !locating}
          onClick={onToggleLocate}
          title="Show where your units sit in their corps: turn on, then click a unit in this bar to jump to it"
        >
          <span>Locate</span> <span>{locating ? "on" : "units"}</span>
        </button>
        <button
          className="btn small auto-generals"
          disabled={autoGeneralsDisabled}
          onClick={onAutoGenerals}
          title="Upgrade selected units to combat generals where it lowers the build's cost (cost-reducing generals can complete a formation for its discount)"
        >
          <span>Auto</span> <span>generals</span>
        </button>
        <button
          className="btn small reset-generals"
          disabled={resetGeneralsDisabled}
          onClick={onResetGenerals}
          title="Replace every combat general with the plain unit it leads (the commander is left in place)"
        >
          <span>Reset</span> <span>generals</span>
        </button>
        <button
          className="btn small export-image"
          disabled={exportDisabled}
          onClick={onExportImage}
          title="Copy the whole build as a single-line image to your clipboard"
        >
          <span>Copy</span> <span>image</span>
        </button>
        <button
          className="btn small clear-build"
          disabled={!hasBuild}
          onClick={onClearBuild}
          title="Remove every card and clear the staff slot"
        >
          <span>Clear</span> <span>build</span>
        </button>
      </div>
    </div>
  );
}

/** Phone/tablet tray: a slim summary strip that expands into a scrollable bottom
 *  sheet. Only actual selections are drawn (at readable grid size), never the 31
 *  empty placeholders — the strip's N/31 count carries that. */
function TouchTray({
  index,
  build,
  summary,
  onRemoveInstance,
  canSwapGeneral,
  onSwapGeneral,
  onClearStaff,
  onClearBuild,
  onAutoGenerals,
  autoGeneralsDisabled,
  onResetGenerals,
  resetGeneralsDisabled,
  onExportImage,
  exportDisabled,
  isOverCorps,
  onDetails,
  onPeek,
  corpsStat,
  locating,
  onToggleLocate,
  onLocate,
}: TrayProps) {
  const [expanded, setExpanded] = useState(false);
  const { totalCards } = summary;
  const staffCard = build.staffSlotUnitKey ? index.byKey.get(build.staffSlotUnitKey) : undefined;
  const instances = build.instances
    .map((inst) => ({ inst, card: index.byKey.get(inst.unitKey) }))
    .filter((e): e is { inst: { id: string; unitKey: string }; card: UnitCard } => Boolean(e.card));
  const hasBuild = build.instances.length > 0 || build.staffSlotUnitKey !== null;
  // In locate mode a tap closes the sheet and jumps the grid to the unit; the
  // stat-card peek is switched off so the tap reaches onClick.
  const activate = (card: UnitCard) => {
    if (!locating) return onDetails(card);
    setExpanded(false);
    onLocate(card);
  };
  const activateLabel = locating ? "find it in the grid" : "show details";
  const peek = locating ? undefined : onPeek;

  return (
    <>
      {/* Collapsed strip: the running numbers the player needs at a glance. Tapping
          it (or the chevron) toggles the sheet; adding a unit updates the numbers
          here rather than auto-expanding. */}
      <button
        type="button"
        className="tray-strip"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        <span className="tray-stat">
          <span className="cost">{summary.price.finalCost.toLocaleString()}</span>
        </span>
        <span className="tray-stat">
          <b className={totalCards > MAX_TOTAL_UNIT_CARDS ? "over" : undefined}>{totalCards}</b>/
          {MAX_TOTAL_UNIT_CARDS} cards
        </span>
        {corpsStat && (
          <span className="tray-stat">
            <b className={corpsStat.over ? "over" : undefined}>{corpsStat.count}</b>/{corpsStat.max} corps
          </span>
        )}
        {/* Broken limits (see the header banner, which collapsed chrome hides). */}
        {summary.violationMessages.length > 0 && (
          <span className="tray-stat" title={summary.violationMessages.join("\n")}>
            <b className="over">⚠ {summary.violationMessages.length}</b>{" "}
            limit{summary.violationMessages.length === 1 ? "" : "s"}
          </span>
        )}
        <span className="tray-strip-chevron" aria-hidden>
          {expanded ? "▾" : "▴"}
        </span>
      </button>

      {expanded && (
        <div className="tray-sheet-backdrop" onClick={() => setExpanded(false)}>
          <div className="tray-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Selected units">
            <div className="tray-sheet-head">
              <button type="button" className="tray-sheet-handle" aria-label="Collapse" onClick={() => setExpanded(false)}>
                <span className="tray-strip-grip" aria-hidden />
              </button>
            </div>
            <div className="tray-sheet-grid" aria-label="Selected units">
              <div className="tray-sheet-staff">
                <span className="slot-label">Commander</span>
                {staffCard ? (
                  <Medallion
                    card={staffCard}
                    inStaffSlot
                    onClick={() => activate(staffCard)}
                    activateLabel={activateLabel}
                    onContextMenu={onClearStaff}
                    onRemove={onClearStaff}
                    onDetails={() => onDetails(staffCard)}
                    onPeek={peek}
                    peekOn="tap"
                  />
                ) : (
                  <span className="empty-oval" title="“Set commander” on any general" aria-hidden />
                )}
              </div>
              {instances.map(({ inst, card }) => (
                <Medallion
                  key={inst.id}
                  card={card}
                  selected
                  showSpeed
                  overCorps={isOverCorps(card)}
                  onClick={() => activate(card)}
                  activateLabel={activateLabel}
                  onContextMenu={() => onRemoveInstance(inst.id)}
                  onRemove={() => onRemoveInstance(inst.id)}
                  onDetails={() => onDetails(card)}
                  onPeek={peek}
                  peekOn="tap"
                  onSwapGeneral={canSwapGeneral(card) ? () => onSwapGeneral(inst.id) : undefined}
                  ledByGeneral={card.isGeneral && card.generalKind === "combat"}
                />
              ))}
              {!hasBuild && <p className="tray-sheet-empty">No units yet — tap a unit in the grid to add it.</p>}
            </div>
            {locating && <p className="tray-sheet-empty">Tap a unit to find it in the grid.</p>}
            <div className="tray-sheet-actions">
              <button
                className={`btn locate-unit${locating ? " gold" : ""}`}
                aria-pressed={locating}
                disabled={!hasBuild && !locating}
                onClick={onToggleLocate}
              >
                {locating ? "Locate: on" : "Locate units"}
              </button>
              <button className="btn auto-generals" disabled={autoGeneralsDisabled} onClick={onAutoGenerals}>
                Auto generals
              </button>
              <button className="btn reset-generals" disabled={resetGeneralsDisabled} onClick={onResetGenerals}>
                Reset generals
              </button>
              <button className="btn export-image" disabled={exportDisabled} onClick={onExportImage}>
                Save image
              </button>
              <button className="btn clear-build" disabled={!hasBuild} onClick={onClearBuild}>
                Clear build
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
