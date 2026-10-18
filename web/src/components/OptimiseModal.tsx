import { useCallback, useEffect } from "react";
import type { OptimiserMode } from "../domain/types";
import { MAX_TOTAL_UNIT_CARDS } from "../rules/rules";
import { isTowFactionKey } from "../domain/tow";
import { isArmyCorpsKey } from "../state/acOptimiser";
import { type OptimiseSettings, type OptimiseSummary, allowedModes, normaliseMode } from "../state/optimiser";

/** Shown under Quantity and Quality (here and in SuggestTeamModal): the names are only labels for
 *  how unit sizes are valued, not targets the optimiser aims for (the user's request). */
export const MODE_NAME_NOTE = "Quantity and Quality are just names for how unit sizes are valued: a Quantity build "
  + "won't necessarily have more cards or more very large or very small units, and a Quality build won't necessarily have fewer.";

const MODES: Record<OptimiserMode, { label: string; hint: string }> = {
  quantity: {
    label: "Quantity",
    hint: "Keeps the price discount of very small and very large units, treating it as possible real value rather than model error, so mass units are favoured.",
  },
  quality: {
    label: "Quality",
    hint: "Removes the pricing model's size bias, so a unit's size alone never makes it look like a bargain.",
  },
  // Army Corps "Quality" is the size-band model (mode key sizeBands); the user chose the
  // familiar label (2026-10-10). Like Quality elsewhere it takes out most of the size discount.
  sizeBands: {
    label: "Quality",
    hint: "Values units with the Army Corps size-band pricing model, which takes out most of the price discount of small and very large units, so size alone rarely makes a unit look like a bargain.",
  },
  formationDiscount: {
    label: "Formation discount only",
    hint: "Ignores unit stats: uses the game's own prices to field the most list value. Brigade and division discounts let an Army Corps field more than 10 000.",
  },
};

/** Settings and run button for the build optimiser (state/optimiser.ts). The result is
 *  applied to the build immediately by Builder; "Undo optimise" restores the build it
 *  replaced until the next edit. */
export function OptimiseModal({
  factionKey,
  settings,
  onSettings,
  filteredCount,
  filtersActive,
  busy,
  error,
  result,
  fallback,
  canUndo,
  onOptimise,
  onUndo,
  onClose,
}: {
  factionKey: string;
  settings: OptimiseSettings;
  onSettings: (next: OptimiseSettings) => void;
  /** Cards that pass the roster filters (what "Only filtered units" restricts to). */
  filteredCount: number;
  filtersActive: boolean;
  busy: boolean;
  error: string | null;
  result: OptimiseSummary | null;
  /** The Army Corps result was built without formation discounts (the optimiser's safety net). */
  fallback: boolean;
  canUndo: boolean;
  onOptimise: () => void;
  onUndo: () => void;
  onClose: () => void;
}) {
  // While a solve runs the modal stays open: closing it would leave the grid editable and the
  // result would land on top of whatever the player changed meanwhile.
  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  const set = <K extends keyof OptimiseSettings>(key: K, value: OptimiseSettings[K]) =>
    onSettings({ ...settings, [key]: value });
  const isTow = isTowFactionKey(factionKey);
  const isAc = isArmyCorpsKey(factionKey);
  const modes = allowedModes(factionKey);
  const mode = normaliseMode(settings.mode, factionKey);

  return (
    <div className="modal-backdrop" onClick={close}>
      <div
        className="modal opt-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Optimise build"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h3 style={{ color: "var(--gold-bright)" }}>Optimise build</h3>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              The most stats for 10 000 funds under the game's rules, as the game's average pricing rule values them
              {isAc ? " — brigade and division discounts included" : ""}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn small" onClick={close} disabled={busy} aria-label="Close optimiser">
            ✕
          </button>
        </div>

        <div className="modal-body">
          <label className="opt-field">
            <span className="opt-label">
              Max unit cards <b>{settings.maxCards}</b>
              <span className="opt-sub"> (staff general included; the game allows {MAX_TOTAL_UNIT_CARDS})</span>
            </span>
            <input
              type="range"
              min={2}
              max={MAX_TOTAL_UNIT_CARDS}
              step={1}
              value={settings.maxCards}
              onChange={(e) => set("maxCards", Number(e.target.value))}
            />
            <span className="opt-hint">Fewer cards are easier to micro; prices don't capture that.</span>
          </label>

          <div className="opt-field">
            <div className="tri">
              <span className="opt-label">Unit value</span>
              <span className="seg" role="group" aria-label="Unit value">
                {modes.map((m) => (
                  <button
                    key={m}
                    className={mode === m ? "on" : ""}
                    aria-pressed={mode === m}
                    onClick={() => set("mode", m)}
                  >
                    {MODES[m].label}
                  </button>
                ))}
              </span>
            </div>
            <span className="opt-hint">{MODES[mode].hint}</span>
            {mode !== "formationDiscount" && <span className="opt-hint">{MODE_NAME_NOTE}</span>}
          </div>

          <label className="opt-check">
            <input type="checkbox" checked={settings.remainder} onChange={(e) => set("remainder", e.target.checked)} />
            <span>
              Optimise remainder
              <span className="opt-hint">Keep the current build and fill the funds and cards left; off rebuilds the whole deck.</span>
            </span>
          </label>
          <label className="opt-check">
            <input type="checkbox" checked={settings.useFilters} onChange={(e) => set("useFilters", e.target.checked)} />
            <span>
              Only filtered units
              <span className="opt-hint">
                {filtersActive
                  ? `${filteredCount} cards pass the current filters (incl. Offered now and the corps roll).`
                  : "No filters set: every card is eligible."}
              </span>
            </span>
          </label>
          <label className="opt-check">
            <input type="checkbox" checked={settings.allowNoStaff} onChange={(e) => set("allowNoStaff", e.target.checked)} />
            <span>
              Allow no staff general
              <span className="opt-hint">Leave the staff slot empty when a unit is worth more.</span>
            </span>
          </label>
          {isTow && (
            <label className="opt-check">
              <input type="checkbox" checked={settings.singleRoll} onChange={(e) => set("singleRoll", e.target.checked)} />
              <span>
                Single roll (≤ 4 source corps)
                <span className="opt-hint">One in-game roll offers 4 corps, so the build can be fielded without changing the clock.</span>
              </span>
            </label>
          )}

          <div className="modal-actions opt-actions">
            <button className="btn" onClick={onOptimise} disabled={busy}>
              {busy ? "Optimising…" : "Optimise"}
            </button>
            {canUndo && (
              <button className="btn" onClick={onUndo} disabled={busy}>
                Undo optimise
              </button>
            )}
          </div>

          {error && (
            <div className="tow-warning" role="status">
              {error}
            </div>
          )}
          {result && !error && (
            <div className="opt-result" role="status">
              Applied: {result.cards} cards · {result.cost.toLocaleString()} gold
              {result.rebate > 0
                ? ` (list ${result.listCost.toLocaleString()} − discounts ${result.rebate.toLocaleString()}, `
                  + `${result.groupsCompleted} formation${result.groupsCompleted === 1 ? "" : "s"})`
                : ""}
              {" "}· value {Math.round(result.value).toLocaleString()} · efficiency {result.efficiency.toFixed(2)}
              {result.staffName ? ` · staff general ${result.staffName}` : " · no staff general"}
            </div>
          )}
          {result && !error && fallback && (
            <div className="tow-warning" role="status">
              No recruit order could earn the discounts of the best build in time, so this build ignores formation
              discounts. Try again with fewer filters or a different card cap.
            </div>
          )}
          <div className="opt-hint opt-foot">
            {mode === "formationDiscount"
              ? "Value is the cards' own list price: the build that gets the most out of the formation discounts, whatever the stats. "
              : "Value is what the game's average pricing rule charges for a card's stats (Registre des Armées analysis), "
                + "not battle power; generals get extra value in big, low-morale builds. "}
            {isAc && "Cards are added in an order the game accepts: each completed brigade or division before the rest, so every discount is earned."}
          </div>
        </div>
      </div>
    </div>
  );
}
