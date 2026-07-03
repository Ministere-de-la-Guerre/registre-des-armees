import { useEffect, useMemo } from "react";
import type { FactionRoster } from "../domain/types";
import { compareTowSourceCorpsIds } from "../domain/tow";
import { towCorpsFullNameMap } from "../domain/towCorpsNames";
import type { BuildState, RosterIndex } from "../state/build";
import { LEGACY_TOW_MAX_SOURCE_CORPS, towSourceCorpsIdsInBuild } from "../state/towRoll";

// How many corps the game actually rolls at once. Selecting more is allowed
// (with a warning) but cannot occur together in a real in-game roll.
const ROLL_SIZE = LEGACY_TOW_MAX_SOURCE_CORPS;

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const roman = (n: number) => ROMAN[n] ?? String(n);

interface CorpsRow {
  id: string;
  division: number;
  name: string;
  units: number;
}

/** Popup for Theatres-of-War corps rolls. Each source corps is a whole division,
 *  named after its commanding staff general. The player enables the corps to keep
 *  in the builder (the game rolls four at a time; more is allowed with a warning);
 *  disabled corps disappear from the grid. Timing a specific roll lives on the
 *  header "Generate times" button, which times the build you actually made. */
export function TowRollModal({
  roster,
  index,
  build,
  enabled,
  onToggle,
  onClose,
}: {
  roster: FactionRoster;
  index: RosterIndex;
  build: BuildState;
  enabled: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const names = useMemo(() => towCorpsFullNameMap(roster.cards), [roster.cards]);

  // Every source corps in this faction, numbered to match the builder grid's
  // division labels (load.ts numbers divisions by sorted source-corps id).
  const corps = useMemo<CorpsRow[]>(() => {
    const counts = new Map<string, number>();
    for (const c of roster.cards) {
      if (c.towSourceCorpsId) counts.set(c.towSourceCorpsId, (counts.get(c.towSourceCorpsId) ?? 0) + 1);
    }
    const ids = [...counts.keys()].sort(compareTowSourceCorpsIds);
    return ids.map((id, i) => ({
      id,
      division: i + 1,
      name: names.get(id) ?? `Corps ${id}`,
      units: counts.get(id) ?? 0,
    }));
  }, [roster.cards, names]);

  const over = enabled.size > ROLL_SIZE;

  // Corps the current build actually draws units from — flagged in the list so
  // the player can see which toggles their selection depends on.
  const buildCorps = useMemo(() => towSourceCorpsIdsInBuild(build, index), [build, index]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal rot-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Corps roll"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h3 style={{ color: "var(--gold-bright)" }}>Corps roll</h3>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              Enable the army corps to keep · disabled corps leave the builder
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn small" onClick={onClose} aria-label="Close corps roll">
            ✕
          </button>
        </div>

        <div className="modal-body">
          {corps.length === 0 ? (
            <div className="rot-note">This faction has no Theatres-of-War corps to roll.</div>
          ) : (
            <>
              <ul className="tow-corps-list">
                {corps.map((c) => {
                  const on = enabled.has(c.id);
                  const usedInBuild = buildCorps.includes(c.id);
                  return (
                    <li key={c.id} className={`tow-corps-row${on ? " on" : ""}`}>
                      <label className="tow-corps-toggle">
                        <input type="checkbox" checked={on} onChange={(e) => onToggle(c.id, e.target.checked)} />
                        <span className="tow-corps-num">{roman(c.division)}</span>
                        <span className="tow-corps-name">{c.name}</span>
                        {usedInBuild && <span className="tow-corps-inbuild">in build</span>}
                        <span className="tow-corps-units">{c.units} units</span>
                      </label>
                    </li>
                  );
                })}
              </ul>

              <div className="tow-corps-foot">
                <span className={`tow-count${over ? " over" : ""}`}>{enabled.size} enabled</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 12, opacity: 0.85 }}>
                  Use “Generate times” to find when your build’s roll is offered
                </span>
              </div>

              {over && (
                <div className="tow-warning" role="status">
                  ⚠ {enabled.size} corps enabled — the game only rolls {ROLL_SIZE} at a time, so this
                  combination can’t appear together in a real in-game roll.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
