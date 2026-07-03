import { useEffect, useMemo } from "react";
import type { FactionRoster } from "../domain/types";
import { towCorpsNameMap } from "../domain/towCorpsNames";
import type { BuildState, RosterIndex } from "../state/build";
import {
  findTowBuildRollTime,
  towCombatGeneralKeysInBuild,
  towSourceCorpsIdsInBuild,
} from "../state/towRoll";
import { fmtDateTime, fmtRel, windowRange } from "./rollTimeFormat";
import { DirectionBadge } from "./DirectionBadge";

/** Theatres-of-War "Generate times" popup. Unlike the Corps roll menu (which
 *  times whatever corps you toggle on), this times the build you actually made:
 *  the nearest local window whose in-game roll offers every source corps your
 *  selected units come from AND every combat general you used. Opening the popup
 *  runs the search once against a single reference clock. */
export function TowGenerateModal({
  roster,
  index,
  build,
  onClose,
}: {
  roster: FactionRoster;
  index: RosterIndex;
  build: BuildState;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const names = useMemo(() => towCorpsNameMap(roster.cards), [roster.cards]);
  const corpsLabel = (id: string) => names.get(id) ?? `Corps ${id}`;
  const generalName = (key: string) => index.byKey.get(key)?.name ?? key;

  const targetCorps = useMemo(() => towSourceCorpsIdsInBuild(build, index), [build, index]);
  const targetGenerals = useMemo(() => towCombatGeneralKeysInBuild(build, index), [build, index]);

  // Captured once when the popup opens so the whole readout shares one clock.
  const now = useMemo(() => new Date(), []);
  const result = useMemo(
    () => (targetCorps.length ? findTowBuildRollTime(roster.cards, targetCorps, targetGenerals, now) : null),
    [roster.cards, targetCorps, targetGenerals, now],
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal rot-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Generate times"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h3 style={{ color: "var(--gold-bright)" }}>Generate times</h3>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              Nearest local time whose roll offers the corps &amp; combat generals your build uses
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn small" onClick={onClose} aria-label="Close generate times">
            ✕
          </button>
        </div>

        <div className="modal-body">
          {!result ? (
            <div className="rot-note">
              Your build has no Theatres-of-War units yet. Select the units you want from the grid, then
              reopen this to find the nearest in-game time that lets you recruit them.
            </div>
          ) : (
            <div className="tow-times">
              <div className="rot-row">
                <div className="rot-name">
                  Nearest window for {result.targetSourceCorpsIds.map(corpsLabel).join(" · ")}
                  <DirectionBadge dir={result.closestDirection} />
                </div>

                <div className="rot-when">
                  {result.closest ? (
                    <>
                      <div className="rot-closest">
                        {result.closestDirection === "now" ? (
                          <>Offered now · this window {windowRange(result.closest)}</>
                        ) : (
                          <>
                            {fmtDateTime(result.closest)} · {windowRange(result.closest)}
                            <span className="rot-rel"> ({fmtRel(result.closest, now)})</span>
                          </>
                        )}
                      </div>

                      {result.closestSourceCorpsIds && (
                        <div className="rot-alt" style={{ gap: "4px 8px" }}>
                          <span>
                            Roll:{" "}
                            {result.closestSourceCorpsIds.map((id) => {
                              const filler = !result.targetSourceCorpsIds.includes(id);
                              return (
                                <span key={id} className={filler ? "tow-filler" : "tow-picked"}>
                                  {corpsLabel(id)}
                                  {filler ? " (filler)" : ""}
                                  {"  "}
                                </span>
                              );
                            })}
                          </span>
                        </div>
                      )}

                      {result.targetCombatGeneralKeys.length > 0 && (
                        <div className="rot-alt" style={{ gap: "4px 8px" }}>
                          <span>Combat generals: {result.targetCombatGeneralKeys.map(generalName).join(" · ")}</span>
                        </div>
                      )}

                      <div className="rot-alt">
                        {result.next && result.closestDirection !== "future" && (
                          <span>
                            Next: {fmtDateTime(result.next)} ({fmtRel(result.next, now)})
                          </span>
                        )}
                        {result.prev && result.closestDirection !== "past" && (
                          <span>
                            Previous: {fmtDateTime(result.prev)} ({fmtRel(result.prev, now)})
                          </span>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="rot-note rot-never">
                      No window in the yearly rotation offers this whole build together.{" "}
                      {result.targetCombatGeneralKeys.length > 0
                        ? "Your combat generals can't all be rolled alongside these corps — try fewer combat generals or fewer corps."
                        : "Try selecting units from fewer corps."}
                    </div>
                  )}
                </div>
              </div>

              <p className="rot-disclaimer">
                Times use this PC's local clock (the game reads the same), and the roll repeats every year.
                Extra corps beyond your build are filler the game rolls alongside them.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
