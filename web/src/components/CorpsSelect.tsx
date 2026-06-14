import { useLayoutEffect, useMemo, useRef } from "react";
import { assetUrl } from "../data/assets";
import { type CorpsEntry, type CorpsIndex, SIDE_LABELS } from "../domain/types";

export interface CorpsUiState {
  search: string;
  side: string;
  acOnly: boolean;
}

export function CorpsSelect({
  index,
  ui,
  onUiChange,
  initialScroll,
  onScrollChange,
  onSelect,
}: {
  index: CorpsIndex;
  ui: CorpsUiState;
  onUiChange: (next: CorpsUiState) => void;
  initialScroll: number;
  onScrollChange: (scrollTop: number) => void;
  onSelect: (entry: CorpsEntry) => void;
}) {
  const { search, side, acOnly } = ui;
  const setSearch = (search: string) => onUiChange({ ...ui, search });
  const setSide = (side: string) => onUiChange({ ...ui, side });
  const setAcOnly = (acOnly: boolean) => onUiChange({ ...ui, acOnly });

  const scrollRef = useRef<HTMLDivElement>(null);
  // Restore the previous scroll position after the (filtered) list has rendered.
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = initialScroll;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { sides, total, matched } = useMemo(() => {
    const q = search.trim().toLowerCase();
    let total = 0;
    let matched = 0;
    const sides = index.sides
      .filter((s) => side === "all" || s.side === side)
      .map((s) => ({
        ...s,
        theatres: s.theatres
          .map((t) => ({
            ...t,
            corps: t.corps.filter((c) => {
              total += 1;
              const ok =
                (!q || c.name.toLowerCase().includes(q) || c.factionKey.toLowerCase().includes(q)) &&
                (!acOnly || c.isArmyCorps);
              if (ok) matched += 1;
              return ok;
            }),
          }))
          .filter((t) => t.corps.length > 0),
      }))
      .filter((s) => s.theatres.length > 0);
    return { sides, total, matched };
  }, [index, search, side, acOnly]);

  return (
    <div className="corps-screen" ref={scrollRef} onScroll={(e) => onScrollChange(e.currentTarget.scrollTop)}>
      <div className="corps-toolbar">
        <h2 style={{ color: "var(--gold-bright)", fontSize: 20 }}>Choose an Army Corps</h2>
        <input
          type="search"
          placeholder="Search corps name or key…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ minWidth: 240 }}
        />
        <select value={side} onChange={(e) => setSide(e.target.value)} aria-label="Filter by side">
          <option value="all">All sides</option>
          {index.sides.map((s) => (
            <option key={s.side} value={s.side}>
              {SIDE_LABELS[s.side] ?? s.side}
            </option>
          ))}
        </select>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={acOnly} onChange={(e) => setAcOnly(e.target.checked)} />
          Discount-eligible (AC) only
        </label>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="match-count">
          {matched} of {total} corps
        </span>
      </div>

      {sides.map((s) => (
        <div className="side-block" key={s.side}>
          <h2 className="side-title">{SIDE_LABELS[s.side] ?? s.side}</h2>
          {s.theatres.map((t) => (
            <div className="theatre-block" key={t.theatre}>
              <div className="theatre-title">{t.theatre}</div>
              <div className="corps-grid">
                {t.corps.map((c) => (
                  <CorpsCard key={c.factionKey} entry={c} onSelect={() => onSelect(c)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function CorpsCard({ entry, onSelect }: { entry: CorpsEntry; onSelect: () => void }) {
  const flag = assetUrl(entry.flag);
  return (
    <button className="corps-card" onClick={onSelect}>
      {flag ? (
        <img className="flag" src={flag} alt="" loading="lazy" />
      ) : (
        <span className="flag missing">no flag</span>
      )}
      <span>
        <span className="corps-name">{entry.name}</span>
        <span className="corps-meta">
          {entry.isArmyCorps ? "Army Corps" : "Custom Army"}
          {entry.displayRating ? ` · rating ${entry.displayRating}` : ""}
          {entry.displayYear ? ` · ${entry.displayYear}` : ""} · {entry.cardCount} cards
        </span>
      </span>
    </button>
  );
}
