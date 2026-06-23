import { useEffect, useMemo } from "react";
import type { FactionRoster } from "../domain/types";
import type { BuildState, RosterIndex } from "../state/build";
import {
  type RotationResult,
  combatPool,
  combatSelectCount,
  findRotation,
  findStaffRotation,
  nextWindowStart,
  offeredCombatKeys,
  offeredStaffKeys,
  rotationApplies,
  staffPool,
  windowStart,
} from "../state/rotation";

function fmtDateTime(d: Date): string {
  return d.toLocaleString(undefined, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function fmtRel(target: Date, now: Date): string {
  const ms = target.getTime() - now.getTime();
  const past = ms < 0;
  const a = Math.abs(ms);
  const mins = Math.round(a / 60000);
  const hrs = Math.round(a / 3_600_000);
  const days = Math.round(a / 86_400_000);
  const s = mins < 60 ? `${mins} min` : hrs < 48 ? `${hrs} h` : `${days} days`;
  return past ? `${s} ago` : `in ${s}`;
}

/** A single window's local time range, e.g. "14:00 – 17:00". */
function windowRange(start: Date): string {
  return `${fmtTime(start)} – ${fmtTime(nextWindowStart(start))}`;
}

function DirectionBadge({ dir }: { dir: RotationResult["closestDirection"] }) {
  if (dir === "now") return <span className="rot-badge now">offered now</span>;
  if (dir === "future") return <span className="rot-badge future">upcoming</span>;
  if (dir === "past") return <span className="rot-badge past">most recent</span>;
  return null;
}

/** Popup listing, for every combat general currently in the build, the nearest
 *  local time (past or future) the game offers them in this corps's rotation. */
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

  // Captured once when the popup opens so every row shares one reference clock.
  const now = useMemo(() => new Date(), []);
  const combat = useMemo(() => combatPool(roster.cards), [roster.cards]);
  const staff = useMemo(() => staffPool(roster.cards), [roster.cards]);
  const applies = rotationApplies(roster.factionKey);
  const combatCount = useMemo(
    () => (applies ? combatSelectCount(roster.factionKey) : 0),
    [applies, roster.factionKey],
  );

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

  const rows = useMemo(
    () =>
      applies
        ? selected.map((g) => ({
            ...g,
            result:
              g.kind === "combat"
                ? findRotation(combat, combatCount, g.unitKey, now)
                : findStaffRotation(staff, roster.armyCorpsName, g.unitKey, now),
          }))
        : [],
    [applies, selected, combat, staff, combatCount, now, roster.armyCorpsName],
  );

  // Verification readout: what the game offers in this corps right now.
  const offeredNow = useMemo(() => {
    if (!applies) return null;
    return {
      window: windowRange(windowStart(now)),
      combat: offeredCombatKeys(roster.factionKey, combat, now).map((k) => index.byKey.get(k)?.name ?? k),
      staff: offeredStaffKeys(staff, roster.armyCorpsName, now).map((k) => index.byKey.get(k)?.name ?? k),
    };
  }, [applies, roster.factionKey, roster.armyCorpsName, combat, staff, now, index]);

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
            <h3 style={{ color: "var(--gold-bright)" }}>⏱ General rotation</h3>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              Nearest local time you can recruit each selected combat &amp; staff general
            </div>
          </div>
          <div style={{ flex: 1 }} />
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
          ) : (
            <ul className="rot-list">
              {rows.map((r) => (
                <li key={r.unitKey} className="rot-row">
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
              ))}
            </ul>
          )}

          {offeredNow && (
            <details className="rot-debug">
              <summary>Verify: offered right now ({offeredNow.window})</summary>
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
