/** Header control for the pick-rate overlay: one button that opens a small panel
 *  holding the on/off switch and the season choice. The season picker used to sit in
 *  the header permanently, which pushed Save/Load off the right edge of the bar.
 */
import { useId, useRef, useState } from "react";
import { HeaderPopover } from "../../components/HeaderPopover";
import { seasonVersion } from "./load";
import type { PickRatesApi } from "./usePickRates";

export function PickRatesMenu({ pickRates }: { pickRates: PickRatesApi }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const seasons = pickRates.index?.seasons ?? [];
  const current = seasons.find((s) => s.id === pickRates.seasonId) ?? null;
  // Every season so far was played on one release; say it once rather than per row.
  const versions = new Set(seasons.map(seasonVersion));
  const sharedVersion = versions.size === 1 ? seasonVersion(seasons[0]) : null;

  return (
    <>
      <button
        ref={buttonRef}
        className={`btn small pr-menu-btn${pickRates.show ? " on" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        title={
          pickRates.show && current
            ? `Pick rates on: ${current.label} (${current.battles.toLocaleString()} battles)`
            : "Show how often real players field each unit, from recorded battle replays"
        }
      >
        Pick rates <span className="tag beta">Beta</span>
        <span className="caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <HeaderPopover id={panelId} anchorRef={buttonRef} onClose={() => setOpen(false)} width={290} label="Pick rates" className="pr-menu">
          <label className="pr-menu-toggle">
            <input type="checkbox" checked={pickRates.show} onChange={(e) => pickRates.setShow(e.target.checked)} />
            Show pick rates on units
          </label>
          <div className="head-pop-note">How often real players field each unit, from recorded battle replays.</div>
          {pickRates.show && pickRates.loading && <div className="head-pop-note">Loading…</div>}
          {pickRates.show && seasons.length > 1 && (
            <fieldset className="pr-menu-seasons">
              <legend>Season</legend>
              {seasons.map((s) => (
                <label key={s.id} className="pr-menu-season">
                  <input
                    type="radio"
                    name="pick-rate-season"
                    checked={s.id === pickRates.seasonId}
                    onChange={() => pickRates.setSeasonId(s.id)}
                  />
                  <span>{s.label}</span>
                  <span className="pr-menu-season-meta">
                    {s.battles.toLocaleString()} battles{sharedVersion ? "" : ` · ${seasonVersion(s)}`}
                  </span>
                </label>
              ))}
              {sharedVersion && <div className="head-pop-note">Recorded on {sharedVersion}</div>}
            </fieldset>
          )}
        </HeaderPopover>
      )}
    </>
  );
}
