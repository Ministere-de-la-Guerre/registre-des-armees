import { useEffect, useMemo } from "react";
import type { FactionRoster } from "../domain/types";
import { towCorpsNameMap } from "../domain/towCorpsNames";
import type { BuildState, RosterIndex } from "../state/build";
import {
  LEGACY_TOW_MAX_COMBAT_GENERALS,
  LEGACY_TOW_MAX_SOURCE_CORPS,
  findTowBuildRollTime,
  findTowCorpsCombinationTime,
  towCombatGeneralKeysInBuild,
  towSourceCorpsIdsInBuild,
} from "../state/towRoll";
import { fmtDateTime, fmtRel, useRollClock, windowRange } from "./rollTimeFormat";
import { DirectionBadge } from "./DirectionBadge";

/** Theatres-of-War "Generate times" popup. Unlike the Corps roll menu (which
 *  times whatever corps you toggle on), this times the build you actually made:
 *  the nearest local window whose in-game roll offers every source corps your
 *  selected units come from AND every combat general you used. The search re-runs
 *  whenever the local clock enters a new window. */
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

  // One clock for the whole readout: the search follows `searchNow` (moves when the
  // window rolls over), relative times follow `now` (ticks each minute).
  const { now, searchNow } = useRollClock();
  const result = useMemo(
    () => (targetCorps.length ? findTowBuildRollTime(roster.cards, targetCorps, targetGenerals, searchNow) : null),
    [roster.cards, targetCorps, targetGenerals, searchNow],
  );

  // Why no window fits, when none does: too many corps for one roll, too many
  // combat generals for one roll, corps that roll together but never with these
  // combat generals, or corps that never roll together at all.
  const noWindowReason = useMemo((): "corps-count" | "general-count" | "generals" | "corps" | null => {
    if (!result || result.closest) return null;
    if (targetCorps.length > LEGACY_TOW_MAX_SOURCE_CORPS) return "corps-count";
    if (targetGenerals.length > LEGACY_TOW_MAX_COMBAT_GENERALS) return "general-count";
    if (targetGenerals.length === 0) return "corps";
    const corpsOnly = findTowCorpsCombinationTime(roster.cards, targetCorps, searchNow, "contains");
    return corpsOnly.closest ? "generals" : "corps";
  }, [result, roster.cards, targetCorps, targetGenerals, searchNow]);

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
                      {noWindowReason === "corps-count"
                        ? `Your units come from ${result.targetSourceCorpsIds.length} corps, but a roll holds only ${LEGACY_TOW_MAX_SOURCE_CORPS} — select units from fewer corps.`
                        : noWindowReason === "general-count"
                          ? `Your build uses ${result.targetCombatGeneralKeys.length} combat generals, but a roll offers only ${LEGACY_TOW_MAX_COMBAT_GENERALS} — use fewer combat generals.`
                          : noWindowReason === "generals"
                            ? "These corps do roll together, but never alongside all of your combat generals — try fewer combat generals."
                            : "These corps never roll together — try units from a different set of corps."}
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
