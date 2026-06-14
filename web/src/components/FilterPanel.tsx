import { useMemo, useState } from "react";
import { ABILITY_KEYS, ABILITY_LABELS, type UnitCard } from "../domain/types";
import { classLabel } from "../domain/labels";
import {
  BROAD_CATEGORY_LABELS,
  type BroadCategory,
  CLASS_FIELDS,
  type ClassFieldId,
  type FilterState,
  GLOBAL_FIELDS,
  type GlobalFieldId,
  SPEED_FAMILIES,
  STAT_CLASSES,
  STAT_CLASS_LABELS,
  type StatClass,
  type Tri,
  defaultFilters,
  isFilterActive,
  speedOrderIndex,
  statClassOf,
} from "../state/filters";
import { DualRange } from "./DualRange";

function toggleInArray<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

type Bounds = Partial<Record<string, { min: number; max: number }>>;

export function FilterPanel({
  filters,
  onChange,
  cards,
  matchCount,
  totalCount,
}: {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  cards: UnitCard[];
  matchCount: number;
  totalCount: number;
}) {
  const [statTab, setStatTab] = useState<StatClass>("infantry");

  const { classes, divisions, brigades, speeds, globalBounds, classBounds } = useMemo(() => {
    const cl = new Set<string>();
    const dv = new Set<number>();
    const br = new Set<number>();
    const sp = new Set<string>();
    const globalBounds: Bounds = {};
    const classBounds: Record<StatClass, Bounds> = { infantry: {}, cavalry: {}, artillery: {} };
    const grow = (b: Bounds, id: string, v: number | null) => {
      if (v === null) return;
      const cur = b[id] ?? { min: v, max: v };
      cur.min = Math.min(cur.min, v);
      cur.max = Math.max(cur.max, v);
      b[id] = cur;
    };
    for (const c of cards) {
      cl.add(c.unitClass);
      if (c.placement) {
        dv.add(c.placement.division);
        br.add(c.placement.brigade);
      }
      if (c.speedCode) sp.add(c.speedCode);
      for (const f of GLOBAL_FIELDS) grow(globalBounds, f.id, f.get(c));
      const sc = statClassOf(c);
      if (sc) for (const f of CLASS_FIELDS) grow(classBounds[sc], f.id, f.get(c));
    }
    return {
      classes: [...cl].sort(),
      divisions: [...dv].sort((a, b) => a - b),
      brigades: [...br].sort((a, b) => a - b),
      speeds: [...sp].sort((a, b) => speedOrderIndex(a) - speedOrderIndex(b)),
      globalBounds,
      classBounds,
    };
  }, [cards]);

  const setGlobal = (id: GlobalFieldId, lo: number | null, hi: number | null) =>
    onChange({ ...filters, numeric: { ...filters.numeric, [id]: { min: lo, max: hi } } });

  const setClassStat = (sc: StatClass, id: ClassFieldId, lo: number | null, hi: number | null) =>
    onChange({
      ...filters,
      classStats: { ...filters.classStats, [sc]: { ...filters.classStats[sc], [id]: { min: lo, max: hi } } },
    });

  const cb = classBounds[statTab];

  return (
    <div>
      <div className="switch-row" style={{ marginBottom: 8 }}>
        <strong style={{ color: "var(--gold-bright)" }}>Filters</strong>
        <span className="match-count" style={{ fontSize: 12 }}>
          {matchCount}/{totalCount} match
        </span>
      </div>
      <button
        className="btn small"
        style={{ width: "100%", marginBottom: 8 }}
        disabled={!isFilterActive(filters)}
        onClick={() => onChange({ ...defaultFilters(), showCombatGenerals: filters.showCombatGenerals })}
      >
        Clear / reset filters
      </button>

      <div className="filter-section">
        <input
          type="search"
          placeholder="Search name or unit key…"
          value={filters.search}
          style={{ width: "100%" }}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
        />
      </div>

      <div className="filter-section">
        <h4>Category</h4>
        <div className="chip-wrap">
          {(Object.keys(BROAD_CATEGORY_LABELS) as BroadCategory[]).map((cat) => (
            <button
              key={cat}
              className={`chip${filters.categories.includes(cat) ? " on" : ""}`}
              onClick={() => onChange({ ...filters, categories: toggleInArray(filters.categories, cat) })}
            >
              {BROAD_CATEGORY_LABELS[cat]}
            </button>
          ))}
        </div>
      </div>

      <div className="filter-section">
        <h4>Unit class</h4>
        <div className="chip-wrap">
          {classes.map((c) => (
            <button
              key={c}
              className={`chip${filters.classes.includes(c) ? " on" : ""}`}
              onClick={() => onChange({ ...filters, classes: toggleInArray(filters.classes, c) })}
            >
              {classLabel(c)}
            </button>
          ))}
        </div>
      </div>

      {speeds.length > 0 && (
        <div className="filter-section">
          <h4>Speed / movement</h4>
          {SPEED_FAMILIES.map((family) => {
            // Show the whole family row (e.g. L1–L6) when the army has any of it; codes
            // the army lacks are shown disabled. Entirely-absent families are skipped
            // so the rows below shift up.
            if (!family.some((s) => speeds.includes(s))) return null;
            return (
              <div className="chip-wrap speed-row" key={family[0]}>
                {family.map((s) => {
                  const present = speeds.includes(s);
                  return (
                    <button
                      key={s}
                      className={`chip${filters.speeds.includes(s) ? " on" : ""}${present ? "" : " off"}`}
                      disabled={!present}
                      onClick={() => onChange({ ...filters, speeds: toggleInArray(filters.speeds, s) })}
                    >
                      {s}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {(divisions.length > 0 || brigades.length > 0) && (
        <div className="filter-section">
          <h4>Division</h4>
          <div className="chip-wrap">
            {divisions.map((d) => (
              <button
                key={d}
                className={`chip${filters.divisions.includes(d) ? " on" : ""}`}
                onClick={() => onChange({ ...filters, divisions: toggleInArray(filters.divisions, d) })}
              >
                Div {d}
              </button>
            ))}
          </div>
          <h4 style={{ marginTop: 10 }}>Brigade</h4>
          <div className="chip-wrap">
            {brigades.map((b) => (
              <button
                key={b}
                className={`chip${filters.brigades.includes(b) ? " on" : ""}`}
                onClick={() => onChange({ ...filters, brigades: toggleInArray(filters.brigades, b) })}
              >
                Brig {b}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="filter-section">
        <h4>General stats</h4>
        {GLOBAL_FIELDS.map((f) => {
          const b = globalBounds[f.id];
          if (!b || b.max <= b.min) return null;
          return (
            <DualRange
              key={f.id}
              label={f.label}
              min={b.min}
              max={b.max}
              valueMin={filters.numeric[f.id].min}
              valueMax={filters.numeric[f.id].max}
              onChange={(lo, hi) => setGlobal(f.id, lo, hi)}
            />
          );
        })}
      </div>

      <div className="filter-section">
        <h4>Combat stats by class</h4>
        <div className="chip-wrap" style={{ marginBottom: 8 }}>
          {STAT_CLASSES.map((sc) => {
            const active = CLASS_FIELDS.some((f) => {
              const r = filters.classStats[sc][f.id];
              return r.min !== null || r.max !== null;
            });
            return (
              <button
                key={sc}
                className={`chip${statTab === sc ? " on" : ""}`}
                onClick={() => setStatTab(sc)}
                title={active ? "Has active filters" : undefined}
              >
                {STAT_CLASS_LABELS[sc]}
                {active ? " •" : ""}
              </button>
            );
          })}
        </div>
        {CLASS_FIELDS.map((f) => {
          const b = cb[f.id];
          if (!b || b.max <= b.min) return null;
          return (
            <DualRange
              key={`${statTab}:${f.id}`}
              label={f.label}
              min={b.min}
              max={b.max}
              valueMin={filters.classStats[statTab][f.id].min}
              valueMax={filters.classStats[statTab][f.id].max}
              onChange={(lo, hi) => setClassStat(statTab, f.id, lo, hi)}
            />
          );
        })}
      </div>

      <div className="filter-section">
        <h4>Abilities</h4>
        {ABILITY_KEYS.map((k) => (
          <div className="tri" key={k}>
            <span>{ABILITY_LABELS[k]}</span>
            <span className="seg">
              {(["any", "yes", "no"] as Tri[]).map((t) => (
                <button
                  key={t}
                  className={filters.abilities[k] === t ? "on" : ""}
                  onClick={() => onChange({ ...filters, abilities: { ...filters.abilities, [k]: t } })}
                >
                  {t}
                </button>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
