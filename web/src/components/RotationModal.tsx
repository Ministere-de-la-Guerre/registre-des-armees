import { useEffect, useMemo, useState } from "react";
import type { FactionRoster } from "../domain/types";
import type { BuildState, RosterIndex } from "../state/build";
import {
  combatPool,
  combatSelectCount,
  findRotation,
  findRotationCover,
  findStaffRotation,
  offeredCombatKeys,
  offeredStaffKeys,
  rotationApplies,
  staffPool,
  windowStart,
} from "../state/rotation";
import { defaultStorageAdapter } from "../state/storage";
import { fmtDateTime, fmtRel, useRollClock, windowRange } from "./rollTimeFormat";
import { DirectionBadge } from "./DirectionBadge";

type RotationView = "combined" | "individual";
const VIEW_KEY = "rda.rotationView";
function readRotationView(): RotationView {
  return defaultStorageAdapter().read(VIEW_KEY) === "individual" ? "individual" : "combined";
}

/** Popup that groups the selected combat & staff generals into the fewest in-game
 *  windows ("time rolls") that together offer them all — since a single window
 *  lets you recruit every general it happens to roll. Ties are broken toward the
 *  tightest cluster of windows, then the cluster nearest the current local time. */
export function RotationModal({
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

  // One reference clock for every row: searches follow `searchNow` (moves when the
  // window rolls over), relative times follow `now` (ticks each minute).
  const { now, searchNow } = useRollClock();
  const combat = useMemo(() => combatPool(roster.cards), [roster.cards]);
  const staff = useMemo(() => staffPool(roster.cards), [roster.cards]);
  const applies = rotationApplies(roster.factionKey);
  const combatCount = useMemo(
    () => (applies ? combatSelectCount(roster.factionKey) : 0),
    [applies, roster.factionKey],
  );

  // Combined (fewest windows) vs individual (one row per general). Persisted so the
  // choice sticks across corps and reloads; combined is the default.
  const [view, setView] = useState<RotationView>(readRotationView);
  const chooseView = (v: RotationView) => {
    setView(v);
    defaultStorageAdapter().write(VIEW_KEY, v);
  };

  // Generals to time: each distinct combat general in the build, plus the
  // staff-slot commander — both are offered on the same windowed roll (the staff
  // pool is shuffled independently and offers exactly one per window).
  const selected = useMemo(() => {
    const seen = new Set<string>();
    const out: { unitKey: string; name: string; kind: "combat" | "staff" }[] = [];
    for (const inst of build.instances) {
      const c = index.byKey.get(inst.unitKey);
      if (c && c.isGeneral && c.generalKind === "combat" && !seen.has(c.unitKey)) {
        seen.add(c.unitKey);
        out.push({ unitKey: c.unitKey, name: c.name, kind: "combat" });
      }
    }
    if (build.staffSlotUnitKey) {
      const c = index.byKey.get(build.staffSlotUnitKey);
      if (c && c.isGeneral && c.generalKind === "staff" && !seen.has(c.unitKey)) {
        out.push({ unitKey: c.unitKey, name: c.name, kind: "staff" });
      }
    }
    return out;
  }, [build.instances, build.staffSlotUnitKey, index]);

  // Combat and staff are rolled together in the same window, so cover them jointly:
  // a window offers whichever combat generals it rolls plus the staff commander (+
  // any rotating staff pick). One pass finds the fewest windows covering the lot.
  const meta = useMemo(() => new Map(selected.map((g) => [g.unitKey, g])), [selected]);
  const cover = useMemo(() => {
    if (!applies || selected.length === 0) return { groups: [], unreachable: [] };
    const offeredAt = (d: Date): string[] => [
      ...offeredCombatKeys(roster.factionKey, combat, d),
      ...offeredStaffKeys(staff, roster.armyCorpsName, d),
    ];
    return findRotationCover(offeredAt, selected.map((g) => g.unitKey), searchNow);
  }, [applies, selected, combat, staff, searchNow, roster.factionKey, roster.armyCorpsName]);

  // Individual view: one row per general with its own nearest/next/previous times,
  // ordered by that nearest time so generals offered in the same window sit together.
  const rows = useMemo(() => {
    if (!applies) return [];
    const withResult = selected.map((g) => ({
      ...g,
      result:
        g.kind === "combat"
          ? findRotation(combat, combatCount, g.unitKey, searchNow)
          : findStaffRotation(staff, roster.armyCorpsName, g.unitKey, searchNow),
    }));
    // Sort by nearest window time (generals never offered sink to the bottom).
    const rank = (t: Date | null) => (t ? t.getTime() : Number.POSITIVE_INFINITY);
    return withResult
      .map((r, i) => ({ r, i }))
      .sort((a, b) => rank(a.r.result.closest) - rank(b.r.result.closest) || a.i - b.i)
      .map(({ r }) => r);
  }, [applies, selected, combat, staff, combatCount, searchNow, roster.armyCorpsName]);

  // Verification readout: what the game offers in this corps right now.
  const offeredNow = useMemo(() => {
    if (!applies) return null;
    return {
      window: windowRange(windowStart(searchNow)),
      combat: offeredCombatKeys(roster.factionKey, combat, searchNow).map((k) => index.byKey.get(k)?.name ?? k),
      staff: offeredStaffKeys(staff, roster.armyCorpsName, searchNow).map((k) => index.byKey.get(k)?.name ?? k),
    };
  }, [applies, roster.factionKey, roster.armyCorpsName, combat, staff, searchNow, index]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal rot-modal"
        role="dialog"
        aria-modal="true"
        aria-label="General rotation"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h3 style={{ color: "var(--gold-bright)" }}>General rotation</h3>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              {view === "combined"
                ? "The fewest local-time windows that together offer every selected combat & staff general"
                : "Nearest local time you can recruit each selected combat & staff general"}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          {applies && selected.length > 0 && (
            <div className="rot-seg" role="tablist" aria-label="Rotation view">
              <button
                role="tab"
                aria-selected={view === "combined"}
                className={view === "combined" ? "on" : ""}
                onClick={() => chooseView("combined")}
                title="Group the selection into the fewest in-game windows that cover it"
              >
                Fewest windows
              </button>
              <button
                role="tab"
                aria-selected={view === "individual"}
                className={view === "individual" ? "on" : ""}
                onClick={() => chooseView("individual")}
                title="One row per general, ordered so ones offered at the same time sit together"
              >
                Per general
              </button>
            </div>
          )}
          <button className="btn small" onClick={onClose} aria-label="Close rotation">
            ✕
          </button>
        </div>

        <div className="modal-body">
          {!applies ? (
            <div className="rot-note">
              This corps does not use the rotating combat-general pool — its roster is fixed.
            </div>
          ) : selected.length === 0 ? (
            <div className="rot-note">
              No combat or staff generals are in your build yet. Add a combat general (or use “Auto
              combat general”) and/or set a corps commander, then reopen this to see when each one is
              offered in game.
            </div>
          ) : view === "combined" ? (
            <>
              {cover.groups.length > 1 && (
                <div className="rot-note" style={{ marginBottom: 10 }}>
                  Your selection can't be recruited in a single window — here are the {cover.groups.length}{" "}
                  windows that cover it in the fewest visits.
                </div>
              )}
              <ul className="rot-list">
                {cover.groups.map((g, i) => (
                  <li key={g.window.getTime()} className="rot-row">
                    <div className="rot-name">
                      {cover.groups.length > 1 && <span className="rot-kind">Roll {i + 1}</span>}
                      {g.direction === "now" ? (
                        <>Offered now · this window {windowRange(g.window)}</>
                      ) : (
                        <>
                          {fmtDateTime(g.window)} · {windowRange(g.window)}
                        </>
                      )}
                      <DirectionBadge dir={g.direction} />
                      {g.direction !== "now" && (
                        <span className="rot-rel">({fmtRel(g.window, now)})</span>
                      )}
                    </div>
                    <ul className="rot-gens">
                      {g.keys.map((key) => {
                        const m = meta.get(key);
                        return (
                          <li key={key} className="rot-gen">
                            <span className={`rot-kind ${m?.kind ?? "combat"}`}>{m?.kind ?? "combat"}</span>
                            {m?.name ?? key}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
              {cover.unreachable.length > 0 && (
                <div className="rot-when rot-never" style={{ marginTop: 10 }}>
                  Not offered in this corps's rotation:{" "}
                  {cover.unreachable.map((k) => meta.get(k)?.name ?? k).join(" · ")}
                </div>
              )}
            </>
          ) : (
            <ul className="rot-list">
              {rows.map((r, i) => {
                // Flag the first row of each shared-time run so same-time generals
                // read as one visually connected group.
                const prev = i > 0 ? rows[i - 1].result.closest : null;
                const groupedWithPrev =
                  prev != null && r.result.closest != null && prev.getTime() === r.result.closest.getTime();
                return (
                  <li key={r.unitKey} className={`rot-row${groupedWithPrev ? " rot-row-cont" : ""}`}>
                    <div className="rot-name">
                      <span className={`rot-kind ${r.kind}`}>{r.kind}</span>
                      {r.name}
                      <DirectionBadge dir={r.result.closestDirection} />
                    </div>
                    {r.result.closest ? (
                      <div className="rot-when">
                        <div className="rot-closest">
                          {r.result.closestDirection === "now" ? (
                            <>Offered now · this window {windowRange(r.result.closest)}</>
                          ) : (
                            <>
                              {fmtDateTime(r.result.closest)} · {windowRange(r.result.closest)}
                              <span className="rot-rel"> ({fmtRel(r.result.closest, now)})</span>
                            </>
                          )}
                        </div>
                        <div className="rot-alt">
                          {r.result.next && r.result.closestDirection !== "now" && (
                            <span>Next: {fmtDateTime(r.result.next)} ({fmtRel(r.result.next, now)})</span>
                          )}
                          {r.result.prev && (
                            <span>Previous: {fmtDateTime(r.result.prev)} ({fmtRel(r.result.prev, now)})</span>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="rot-when rot-never">Not found in the rotation for this corps.</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {offeredNow && (
            <details className="rot-debug">
              <summary>Offered right now ({offeredNow.window})</summary>
              <div className="rot-debug-body">
                <div>
                  <strong>Combat generals:</strong>{" "}
                  {offeredNow.combat.length ? offeredNow.combat.join(" · ") : "—"}
                </div>
                <div>
                  <strong>Staff general:</strong>{" "}
                  {offeredNow.staff.length ? offeredNow.staff.join(" · ") : "—"}
                </div>
                <p className="rot-disclaimer">
                  Times use this PC's local clock (the game reads the same), and the rotation repeats
                  every year. Calibrated against in-game windows; this list should match the corps's
                  current in-game combat-general pool.
                </p>
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
