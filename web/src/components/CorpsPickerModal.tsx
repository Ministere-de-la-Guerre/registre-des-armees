import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { assetUrl } from "../data/assets";
import { matchesSearch } from "../domain/searchText";
import { type TeamKey, fitsTeam } from "../domain/teamRule";
import { type CorpsEntry, type CorpsIndex, SIDE_LABELS } from "../domain/types";
import { isTabletTouch, useCoarsePointer } from "./useCoarsePointer";

interface Group {
  side: string;
  theatre: string;
  corps: { entry: CorpsEntry; flat: number }[];
}

/** Compact "choose a corps" modal for the planner, so assigning a corps to a slot
 *  doesn't take the player off the planner. Searches the same way as the corps
 *  screen (accent-insensitive, any word order) over a slightly wider haystack:
 *  name, theatre, year and side. */
export function CorpsPickerModal({
  index,
  title,
  team,
  teamKeys,
  onPick,
  onClose,
}: {
  index: CorpsIndex;
  title: string;
  /** The team the other armies in the plan form, or null when this is the first army.
   *  Only corps that fit it are listed (see domain/teamRule.ts). */
  team: TeamKey | null;
  teamKeys: Map<string, TeamKey>;
  onPick: (entry: CorpsEntry) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const coarse = useCoarsePointer();
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const { groups, flatList } = useMemo(() => {
    const q = search.trim();
    const flatList: CorpsEntry[] = [];
    const groups: Group[] = [];
    for (const s of index.sides) {
      const sideLabel = SIDE_LABELS[s.side] ?? s.side;
      for (const t of s.theatres) {
        const corps: Group["corps"] = [];
        for (const c of t.corps) {
          if (team) {
            const key = teamKeys.get(c.factionKey);
            if (!key || !fitsTeam(team, key)) continue;
          }
          if (q && !matchesSearch(`${c.name} ${c.factionKey} ${t.theatre} ${c.displayYear} ${sideLabel}`, q)) continue;
          corps.push({ entry: c, flat: flatList.length });
          flatList.push(c);
        }
        if (corps.length > 0) groups.push({ side: sideLabel, theatre: t.theatre, corps });
      }
    }
    return { groups, flatList };
  }, [index, search, team, teamKeys]);

  // Keep the highlighted row in range and in view as the list or the keys change.
  const activeIdx = Math.min(active, Math.max(0, flatList.length - 1));
  useEffect(() => {
    listRef.current?.querySelector(".corps-pick-row.active")?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, flatList]);

  // Escape closes from anywhere in the dialog. Arrows and Enter drive the highlighted
  // row only from the search box: on the ✕ or a row, Enter must keep its native
  // click (close / pick that row), so it is left alone there.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.target !== searchRef.current) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = flatList.length;
      if (n > 0) setActive((activeIdx + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = flatList[activeIdx];
      if (entry) onPick(entry);
    }
  };

  let lastSide = "";
  const modal = (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal corps-picker"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => {
          e.stopPropagation();
          // A click on dead space would drop focus to <body>, outside the dialog,
          // where Escape and the arrows stop working: send it back to the search box.
          const t = e.target as HTMLElement;
          if (t !== searchRef.current && !t.closest("button")) {
            e.preventDefault();
            searchRef.current?.focus();
          }
        }}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <strong style={{ flex: 1, alignSelf: "center" }}>{title}</strong>
          <button className="btn small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="corps-pick-search">
          <input
            ref={searchRef}
            type="search"
            placeholder="Search name, theatre, year or side…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setActive(0);
            }}
            autoFocus
            aria-label="Search corps"
          />
        </div>
        {team && (
          <div className="corps-pick-team">
            Showing only armies that match your first army: <strong>{team.label}</strong>
          </div>
        )}
        <div className="corps-pick-list" ref={listRef}>
          {groups.length === 0 && <div className="plan-empty-note">No corps matches.</div>}
          {groups.map((g) => {
            const showSide = g.side !== lastSide;
            lastSide = g.side;
            return (
              <div key={`${g.side}/${g.theatre}`}>
                {showSide && <div className="corps-pick-side">{g.side}</div>}
                <div className="corps-pick-theatre">{g.theatre}</div>
                {g.corps.map(({ entry, flat }) => {
                  const flag = assetUrl(entry.flag);
                  return (
                    <button
                      key={entry.factionKey}
                      className={`corps-pick-row${flat === activeIdx ? " active" : ""}`}
                      onClick={() => onPick(entry)}
                      onMouseMove={() => flat !== activeIdx && setActive(flat)}
                    >
                      {flag ? <img className="flag" src={flag} alt="" loading="lazy" /> : <span className="flag missing" />}
                      <span className="name">{entry.name}</span>
                      <span className="meta">
                        {[entry.displayYear, entry.displayRating ? `rating ${entry.displayRating}` : ""].filter(Boolean).join(" · ")}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );

  // Portal on touch/tablet like NamePromptModal: iOS clips fixed descendants of the
  // planner's momentum-scrolling containers.
  return coarse || isTabletTouch() ? createPortal(modal, document.body) : modal;
}
