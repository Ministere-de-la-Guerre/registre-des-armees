import type { UnitCard } from "../domain/types";
import { MAX_TOTAL_UNIT_CARDS } from "../rules/rules";
import type { BuildState, BuildSummary as Summary, RosterIndex } from "../state/build";
import { Medallion } from "./Medallion";

/** The build tray: the staff slot (commander), then one medallion per selected
 *  copy in a single line, padded with empty slots up to the 31-card maximum. Each
 *  copy is independently removable (right-click). Running totals live in the top
 *  bar; only the Clear-build action remains here. Mirrors the game's unit bar. */
export function BottomTray({
  index,
  build,
  summary,
  onRemoveInstance,
  onClearStaff,
  onClearBuild,
  onAutoGenerals,
  autoGeneralsDisabled,
  onResetGenerals,
  resetGeneralsDisabled,
  isOverCorps,
  onDetails,
  onHover,
  onHoverEnd,
}: {
  index: RosterIndex;
  build: BuildState;
  summary: Summary;
  /** Flags a selected copy whose source corps is beyond the 4-corps roll (TOW). */
  isOverCorps: (card: UnitCard) => boolean;
  onRemoveInstance: (instanceId: string) => void;
  onClearStaff: () => void;
  onClearBuild: () => void;
  onAutoGenerals: () => void;
  autoGeneralsDisabled: boolean;
  onResetGenerals: () => void;
  resetGeneralsDisabled: boolean;
  onDetails: (card: UnitCard) => void;
  onHover: (card: UnitCard, anchor: DOMRect) => void;
  onHoverEnd: () => void;
}) {
  const { totalCards } = summary;
  const staffCard = build.staffSlotUnitKey ? index.byKey.get(build.staffSlotUnitKey) : undefined;

  const instances = build.instances
    .map((inst) => ({ inst, card: index.byKey.get(inst.unitKey) }))
    .filter((e): e is { inst: { id: string; unitKey: string }; card: UnitCard } => Boolean(e.card));

  // The staff slot counts toward the 31-card limit; the single line shows the
  // remaining copies plus empty slots so the whole army fits one row.
  const emptyCount = Math.max(0, MAX_TOTAL_UNIT_CARDS - totalCards);
  const hasBuild = build.instances.length > 0 || build.staffSlotUnitKey !== null;

  return (
    <div className="tray">
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
              onClick={() => onDetails(staffCard)}
              onContextMenu={onClearStaff}
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
            onClick={() => onDetails(card)}
            onContextMenu={() => onRemoveInstance(inst.id)}
            onHover={onHover}
            onHoverEnd={onHoverEnd}
          />
        ))}
        {Array.from({ length: emptyCount }).map((_, i) => (
          <span className="empty-oval" key={i} aria-hidden />
        ))}
      </div>

      <div className="totals">
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
