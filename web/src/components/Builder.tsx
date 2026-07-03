import { useCallback, useEffect, useMemo, useState } from "react";
import { assetUrl } from "../data/assets";
import type { FactionRoster, UnitCard } from "../domain/types";
import {
  MAX_BUILD_COST,
  MAX_TOTAL_UNIT_CARDS,
  buildRosterTotals,
  groupDiscount,
} from "../rules/rules";
import {
  type BuildState,
  addWouldExceedBudget,
  autoPickCombatGenerals,
  combatCapOf,
  effectiveCap,
  emptyBuild,
  evaluateAdd,
  groupQtyOf,
  hasCombatGeneralInstances,
  indexRoster,
  makeInstanceId,
  qtyOf as qtyOfBuild,
  resetCombatGenerals,
  staffSetWouldExceedBudget,
  summarize,
} from "../state/build";
import { type FilterState, defaultFilters, isFilterActive, isHiddenByGeneralSwitch, matchesCard } from "../state/filters";
import { combinedTowLayout, orderBrigadeCards } from "../state/ordering";
import { type BuildConfig, type LoadResult, type SavedBuild, isDirty } from "../state/saves";
import { BottomTray } from "./BottomTray";
import { BuilderGrid, type DivisionGroup, type GroupMeta, type MedallionHandlers } from "./BuilderGrid";
import { DetailsPanel } from "./DetailsPanel";
import { FilterPanel } from "./FilterPanel";
import { Medallion } from "./Medallion";
import { combatPool, offeredCombatKeys, offeredStaffKeys, rotationApplies, staffPool } from "../state/rotation";
import { LEGACY_TOW_MAX_SOURCE_CORPS, isCardOverCorpsCeiling, towCorpsCeiling } from "../state/towRoll";
import { compareTowSourceCorpsIds, isTowFactionKey, towBrigadeLabel } from "../domain/tow";
import { towCorpsFullNameMap } from "../domain/towCorpsNames";
import { RotationModal } from "./RotationModal";
import { TowRollModal } from "./TowRollModal";
import { TowGenerateModal } from "./TowGenerateModal";
import { SaveLoadBar } from "./SaveLoadBar";
import { Tooltip } from "./Tooltip";

// Shared empties for the combined-corps view, where the grid "divisions" are
// brigade types (no formation discounts — TOW earns none — so no group meta).
const EMPTY_DIVISION_META = new Map<number, GroupMeta>();
const EMPTY_BRIGADE_META = new Map<string, GroupMeta>();

// Roman numerals for the corps-roll breakdown chips (matches the Corps roll popup
// and the grid's division numbering).
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const roman = (n: number) => ROMAN[n] ?? String(n);

// TOW rosters open with combat generals hidden by default (the combined view
// focuses on staff + line units); every other roster shows them.
function defaultFiltersFor(factionKey: string): FilterState {
  return { ...defaultFilters(), showCombatGenerals: !isTowFactionKey(factionKey) };
}

// Every source-corps id present in a TOW roster (all corps enabled by default).
function allTowSourceCorpsIds(cards: readonly UnitCard[]): string[] {
  return [...new Set(cards.map((c) => c.towSourceCorpsId).filter((x): x is string => !!x))];
}

export function Builder({
  roster,
  postFlag,
  onBack,
}: {
  roster: FactionRoster;
  postFlag: string | null;
  onBack: () => void;
}) {
  const index = useMemo(() => indexRoster(roster), [roster]);
  const [build, setBuild] = useState<BuildState>(emptyBuild);
  const [filters, setFilters] = useState<FilterState>(() => defaultFiltersFor(roster.factionKey));
  const [density, setDensity] = useState<"comfortable" | "compact">("compact");
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [detail, setDetail] = useState<UnitCard | null>(null);
  const [hovered, setHovered] = useState<{ card: UnitCard; anchor: DOMRect } | null>(null);
  const [loadedSaved, setLoadedSaved] = useState<SavedBuild | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [rotationOpen, setRotationOpen] = useState(false);
  const [towRollOpen, setTowRollOpen] = useState(false);
  const [towGenerateOpen, setTowGenerateOpen] = useState(false);
  // Source-corps ids the player has enabled for a Theatres-of-War roster (≤4).
  // Only these corps' divisions render in the grid; null for non-TOW rosters, so
  // nothing is hidden. Defaults to the corps the game rolls right now.
  const isTow = isTowFactionKey(roster.factionKey);
  // Custom armies are the non-discount, non-TOW rosters (neither `_ac_` nor
  // `_tow_`). They already cap combat generals at 1 (rules.generalCaps) and always
  // render in the combined brigade-type layout — a custom army is one roster, so
  // "combining" just pools its units by brigade type like the TOW combined view.
  const isCustom = !isTow && !roster.factionKey.includes("_ac_");
  const [enabledCorps, setEnabledCorps] = useState<Set<string> | null>(null);
  // Combined-corps view (TOW only): merge every enabled corps into one, whose
  // "divisions" are brigade types pooled across corps. On by default; sticky
  // across corps switches within a session; harmless (unused) for non-TOW rosters.
  const [combinedTow, setCombinedTow] = useState(true);
  // Whether the grid uses the pooled brigade-type layout: always for custom
  // armies, and for TOW when the "Combine corps" toggle is on.
  const combinedView = isCustom || (isTow && combinedTow);

  useEffect(() => {
    setBuild(emptyBuild());
    setFilters(defaultFiltersFor(roster.factionKey));
    setLoadedSaved(null);
    setHovered(null);
    setTowRollOpen(false);
    setTowGenerateOpen(false);
    // Enable every source corps by default (the combined view pools them all;
    // >4 is over the game's roll size, which the header banner flags).
    setEnabledCorps(isTowFactionKey(roster.factionKey) ? new Set(allTowSourceCorpsIds(roster.cards)) : null);
  }, [roster.factionKey, roster.cards]);

  // Any number of corps may be enabled; enabling more than the game rolls at once
  // is allowed but flagged with a non-blocking warning (here and in the popup).
  const toggleCorps = useCallback((id: string, on: boolean) => {
    setEnabledCorps((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // TOW grid divisions are labelled by their commanding general's surname (the
  // army-corps name) instead of a Roman numeral; keyed by grid division number.
  const divisionNames = useMemo(() => {
    // Combined view (custom armies, or TOW with the toggle on): each grid
    // "division" is a brigade type, keyed by its brigade index, so label it by
    // brigade rather than by source-corps commander.
    if (combinedView) {
      const out = new Map<number, string>();
      for (const b of [...Array(15).keys()].slice(2)) out.set(b, towBrigadeLabel(b));
      out.set(99, towBrigadeLabel(99));
      return out;
    }
    if (!isTow) return undefined;
    const names = towCorpsFullNameMap(roster.cards);
    const out = new Map<number, string>();
    for (const c of roster.cards) {
      const name = c.towSourceCorpsId ? names.get(c.towSourceCorpsId) : undefined;
      if (c.placement && name) out.set(c.placement.division, name);
    }
    return out;
  }, [combinedView, isTow, roster.cards]);

  const tooManyCorps = isTow && enabledCorps != null && enabledCorps.size > LEGACY_TOW_MAX_SOURCE_CORPS;

  // id → { division number, full name } for every source corps in this TOW faction,
  // numbered like the Corps roll popup / grid (sorted by source-corps id).
  const towCorpsInfo = useMemo(() => {
    if (!isTow) return null;
    const names = towCorpsFullNameMap(roster.cards);
    const ids = [...new Set(roster.cards.map((c) => c.towSourceCorpsId).filter((x): x is string => !!x))].sort(
      compareTowSourceCorpsIds,
    );
    const map = new Map<string, { division: number; name: string }>();
    ids.forEach((id, i) => map.set(id, { division: i + 1, name: names.get(id) ?? `Corps ${id}` }));
    return map;
  }, [isTow, roster.cards]);

  // The roll constraint that actually matters: how many distinct source corps the
  // SELECTED units draw from (≤4 is rollable). Pure logic lives in state/towRoll.
  const towBuild = useMemo(() => (isTow ? towCorpsCeiling(build, index) : null), [isTow, build, index]);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 3500);
    return () => clearTimeout(t);
  }, [message]);

  const summary = useMemo(() => summarize(index, build), [index, build]);
  const combatCap = useMemo(() => combatCapOf(roster.factionKey), [roster.factionKey]);
  const combatGensUsed = summary.limits.counts.combat_generals_against_cap ?? 0;
  const config: BuildConfig = { density, showCombatGenerals: filters.showCombatGenerals };

  // Precompute the add-block reason for every card once per build change.
  const blockReasons = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const c of roster.cards) m.set(c.unitKey, evaluateAdd(index, build, c, combatCap)?.reason ?? null);
    return m;
  }, [index, build, combatCap, roster.cards]);

  // The 10,000 ceiling is soft: instead of blocking, we flag (red cost) any unit
  // whose selection would push the build's total past it. Computed once per build.
  const overBudgetCards = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const c of roster.cards) {
      const over = c.isGeneral && c.generalKind === "staff"
        ? staffSetWouldExceedBudget(index, build, c)
        : addWouldExceedBudget(index, build, c);
      m.set(c.unitKey, over);
    }
    return m;
  }, [index, build, roster.cards]);

  // --- selection helpers ---
  const qtyOf = (key: string) => qtyOfBuild(build, key);
  const groupQty = (card: UnitCard) => groupQtyOf(index, build, card.capGroupKey);
  const isSelected = (key: string) => qtyOf(key) > 0 || build.staffSlotUnitKey === key;
  const inStaffSlot = (key: string) => build.staffSlotUnitKey === key;
  // At cap when the whole shared cap group (base + combat-general variants) is full.
  const atCapOf = (card: UnitCard) => {
    const cap = effectiveCap(index, card);
    return cap > 0 && groupQty(card) >= cap;
  };
  const isDimmed = (card: UnitCard) => isFilterActive(filters) && !matchesCard(card, filters);
  const isBlocked = (card: UnitCard) => blockReasons.get(card.unitKey) != null;
  const isOverBudget = (card: UnitCard) => overBudgetCards.get(card.unitKey) === true;
  // Soft 4-corps ceiling (TOW): a card is "over" when its source corps is already
  // in the build beyond the first 4 rolled, or adding it would open a 5th corps.
  const isOverCorps = (card: UnitCard) => (towBuild ? isCardOverCorpsCeiling(card, towBuild) : false);

  const tryAdd = (card: UnitCard) => {
    const reason = blockReasons.get(card.unitKey);
    if (reason) {
      setMessage(reason);
      return;
    }
    setBuild((b) => ({ ...b, instances: [...b.instances, { id: makeInstanceId(), unitKey: card.unitKey }] }));
  };

  const removeInstance = (id: string) =>
    setBuild((b) => ({ ...b, instances: b.instances.filter((i) => i.id !== id) }));

  const toggleStaff = (card: UnitCard) => {
    // The cost ceiling is soft, so a commander can always be set (its cost just
    // shows red when it pushes the total over). Other slot rules are unaffected.
    setBuild((b) => {
      if (b.staffSlotUnitKey === card.unitKey) return { ...b, staffSlotUnitKey: null };
      return { ...b, instances: b.instances.filter((i) => i.unitKey !== card.unitKey), staffSlotUnitKey: card.unitKey };
    });
  };

  const clearStaff = () => setBuild((b) => ({ ...b, staffSlotUnitKey: null }));
  const clearBuild = () => {
    if (build.instances.length === 0 && !build.staffSlotUnitKey) return;
    setBuild(emptyBuild());
  };

  // Remove every selected unit (and the commander, if it belongs to this corps)
  // drawn from a single source corps — the one-click "trim this corps" action on
  // the over-4-corps warning chips.
  const removeCorps = (sourceCorpsId: string) => {
    const inCorps = (key: string | null) =>
      !!key && index.byKey.get(key)?.towSourceCorpsId === sourceCorpsId;
    const info = towCorpsInfo?.get(sourceCorpsId);
    setBuild((b) => ({
      instances: b.instances.filter((i) => !inCorps(i.unitKey)),
      staffSlotUnitKey: inCorps(b.staffSlotUnitKey) ? null : b.staffSlotUnitKey,
    }));
    setMessage(`Removed all units from ${info ? `${roman(info.division)} · ${info.name}` : `corps ${sourceCorpsId}`}.`);
  };

  // Upgrade units already in the build by swapping a plain copy for the combat
  // general of the same unit — the cheapest such swaps that fit the remaining cap,
  // leaving any existing combat generals in place. Never adds new units.
  const autoGeneralsAvailable = build.instances.length > 0 && combatGensUsed < combatCap;
  const autoCombatGenerals = () => {
    const { replacements } = autoPickCombatGenerals(index, build, combatCap);
    if (replacements.length === 0) {
      setMessage("No combat general would lower the build's cost.");
      return;
    }
    const swap = new Map(replacements.map((r) => [r.instanceId, r.generalUnitKey]));
    setBuild((b) => ({
      ...b,
      instances: b.instances.map((i) => (swap.has(i.id) ? { id: i.id, unitKey: swap.get(i.id)! } : i)),
    }));
    const n = replacements.length;
    setMessage(`Upgraded ${n} unit${n === 1 ? "" : "s"} with the cheapest combat general${n === 1 ? "" : "s"}.`);
  };

  // Swap every combat general back to the plain unit it leads (commander untouched).
  const resetGeneralsAvailable = hasCombatGeneralInstances(index, build);
  const resetCombatGeneralsHandler = () => {
    if (!resetGeneralsAvailable) return;
    setBuild((b) => resetCombatGenerals(index, b));
    setMessage("Reset combat generals to their base units.");
  };

  const handlers: MedallionHandlers = {
    isSelected,
    inStaffSlot,
    isDimmed,
    isBlocked,
    isOverBudget,
    isOverCorps,
    qtyOf,
    groupQtyOf: groupQty,
    atCapOf,
    onAdd: tryAdd,
    onDetails: setDetail,
    onHover: (card, anchor) => setHovered({ card, anchor }),
    onHoverEnd: () => setHovered(null),
  };

  // Set of general unitKeys offered in this corps's current local-time rotation
  // window. Computed only when the "Offered now" view toggle is on and the corps
  // uses the rotating pool; null otherwise (so no general is hidden by rotation).
  const supportsRotation = rotationApplies(roster.factionKey);
  const offeredNowKeys = useMemo(() => {
    if (!filters.onlyOfferedNow || !supportsRotation) return null;
    const now = new Date();
    return new Set<string>([
      ...offeredCombatKeys(roster.factionKey, combatPool(roster.cards), now),
      ...offeredStaffKeys(staffPool(roster.cards), roster.armyCorpsName, now),
    ]);
  }, [filters.onlyOfferedNow, supportsRotation, roster.cards, roster.factionKey, roster.armyCorpsName]);

  // A general is hidden when the "Offered now" toggle is on and it is not in the
  // current rotation window. Non-general units are never hidden by this toggle.
  const hiddenByRotation = useCallback(
    (c: UnitCard) => offeredNowKeys != null && c.isGeneral && !offeredNowKeys.has(c.unitKey),
    [offeredNowKeys],
  );

  // A TOW card is hidden when its source corps is not in the enabled roll. Only
  // affects display (the build state is untouched); non-TOW cards are unaffected.
  const hiddenByCorpsRoll = useCallback(
    (c: UnitCard) => enabledCorps != null && c.towSourceCorpsId != null && !enabledCorps.has(c.towSourceCorpsId),
    [enabledCorps],
  );

  // --- organizational grouping ---
  // Army-corps: staff generals are lifted out into a top "Staff" row; the rest
  // group by placement. Theatres-of-War instead keeps staff generals inside their
  // source-corps division (load.ts places them in brigade 1), so for TOW they fall
  // through to the placement grouping and no separate staff row is rendered.
  const { staffGenerals, divisions, unplaced } = useMemo(() => {
    const visible = roster.cards.filter(
      (c) => !isHiddenByGeneralSwitch(c, filters) && !hiddenByRotation(c) && !hiddenByCorpsRoll(c),
    );
    // Combined view (custom armies always; TOW when toggled): one corps, whose
    // "divisions" are the brigade types pooled across every unit (staff lifted to
    // the top row), each ordered by the normal price rule.
    if (combinedView) {
      const { staffGenerals, brigades } = combinedTowLayout(visible);
      const divisions: DivisionGroup[] = brigades.map((b) => ({
        division: b.brigade,
        brigades: [b],
      }));
      return { staffGenerals, divisions, unplaced: [] as UnitCard[] };
    }
    const staffGenerals: UnitCard[] = [];
    const divMap = new Map<number, Map<number, UnitCard[]>>();
    const unplaced: UnitCard[] = [];
    for (const c of visible) {
      if (!isTow && c.isGeneral && c.generalKind === "staff") {
        staffGenerals.push(c);
      } else if (c.placement) {
        const d = divMap.get(c.placement.division) ?? new Map<number, UnitCard[]>();
        const arr = d.get(c.placement.brigade) ?? [];
        arr.push(c);
        d.set(c.placement.brigade, arr);
        divMap.set(c.placement.division, d);
      } else {
        unplaced.push(c);
      }
    }
    const divisions: DivisionGroup[] = [...divMap.keys()]
      .sort((a, b) => a - b)
      .map((division) => ({
        division,
        brigades: [...divMap.get(division)!.keys()]
          .sort((a, b) => a - b)
          .map((brigade) => ({ brigade, cards: divMap.get(division)!.get(brigade)! })),
      }));
    return { staffGenerals, divisions, unplaced: orderBrigadeCards(unplaced) };
  }, [roster.cards, filters, hiddenByRotation, hiddenByCorpsRoll, isTow, combinedView]);

  const { divisionMeta, brigadeMeta } = useMemo(() => {
    const totals = buildRosterTotals(roster.cards, roster.factionKey);
    const completedDiv = new Map<number, number>();
    const completedBrig = new Map<string, number>();
    for (const g of summary.price.completedGroups) {
      if (g.groupType === "division") completedDiv.set(g.divisionId, g.discount);
      else completedBrig.set(`${g.divisionId}:${g.brigadeId}`, g.discount);
    }
    const selDiv = new Map<number, number>();
    const selBrig = new Map<string, number>();
    for (const c of summary.expanded.cards) {
      if (!c.placement) continue;
      selDiv.set(c.placement.division, (selDiv.get(c.placement.division) ?? 0) + 1);
      const bk = `${c.placement.division}:${c.placement.brigade}`;
      selBrig.set(bk, (selBrig.get(bk) ?? 0) + 1);
    }
    // A group counts as "complete" (green + discount badge) only when the price
    // actually credits its discount — i.e. it was completed by affordable units.
    // A group filled out only with over-budget units earns no discount, so it is
    // not shown as complete even though every slot is selected.
    const divisionMeta = new Map<number, GroupMeta>();
    for (const [div, total] of totals.divisions) {
      const selected = selDiv.get(div) ?? 0;
      divisionMeta.set(div, {
        required: total.requiredCount,
        selected,
        complete: completedDiv.has(div),
        discount: completedDiv.get(div) ?? groupDiscount(total),
      });
    }
    const brigadeMeta = new Map<string, GroupMeta>();
    for (const [bk, total] of totals.brigades) {
      const selected = selBrig.get(bk) ?? 0;
      brigadeMeta.set(bk, {
        required: total.requiredCount,
        selected,
        complete: completedBrig.has(bk),
        discount: completedBrig.get(bk) ?? groupDiscount(total),
      });
    }
    return { divisionMeta, brigadeMeta };
  }, [roster.cards, roster.factionKey, summary]);

  const matchCount = useMemo(
    () =>
      roster.cards.filter(
        (c) => matchesCard(c, filters) && !isHiddenByGeneralSwitch(c, filters) && !hiddenByRotation(c),
      ).length,
    [roster.cards, filters, hiddenByRotation],
  );

  const current = { build, config, factionKey: roster.factionKey, armyCorpsName: roster.armyCorpsName };
  const dirty = isDirty(current, loadedSaved);

  const applyLoaded = (result: LoadResult, saved: SavedBuild) => {
    setBuild(result.build);
    setDensity(result.config.density);
    setFilters((f) => ({ ...f, showCombatGenerals: result.config.showCombatGenerals }));
    setLoadedSaved(saved);
    if (result.missingKeys.length) setMessage(`Loaded “${saved.name}” — ${result.missingKeys.length} unknown unit(s) skipped.`);
    else setMessage(`Loaded “${saved.name}”.`);
  };

  const over = summary.totalCards > MAX_TOTAL_UNIT_CARDS;
  const overCost = summary.price.finalCost > MAX_BUILD_COST;

  return (
    <div className="builder">
      <div className="corps-header">
        <button className="btn small" onClick={onBack}>
          ← Corps
        </button>
        {postFlag && <img className="post-flag" src={assetUrl(postFlag) ?? undefined} alt="" />}
        <div className="titles">
          <h2>{roster.armyCorpsName || roster.factionKey}</h2>
          <div className="sub">
            {loadedSaved ? `${loadedSaved.name}${dirty ? " • unsaved changes" : ""}` : dirty ? "Unsaved build" : "New build"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, marginLeft: 16 }}>
          <div className="hstat">
            <div className="lbl">Cards</div>
            <div className={`val${over ? " over" : ""}`}>
              {summary.totalCards}/{MAX_TOTAL_UNIT_CARDS}
            </div>
          </div>
          <div className="hstat">
            <div className="lbl">Total men</div>
            <div className="val">{summary.totalMen.toLocaleString()}</div>
          </div>
          <div className="hstat" title="Combat generals selected against the corps cap (remaining you can still take)">
            <div className="lbl">Combat gens</div>
            <div className={`val${combatGensUsed > combatCap ? " over" : ""}`}>
              {combatGensUsed}/{combatCap}
              <span style={{ fontSize: 11, opacity: 0.7 }}> · {Math.max(0, combatCap - combatGensUsed)} left</span>
            </div>
          </div>
          {isTow && towBuild && (
            <div className="hstat" title="Distinct army corps your selected units draw from. The game rolls only 4 corps together, so a build spanning more can't come from a single roll (still allowed).">
              <div className="lbl">Corps</div>
              <div className={`val${towBuild.over ? " over" : ""}`}>
                {towBuild.count}/{LEGACY_TOW_MAX_SOURCE_CORPS}
              </div>
            </div>
          )}
          <div className="hstat" title="Selected unit cards able to form square, out of your total infantry (line, light, grenadiers, militia, irregulars; combat generals leading infantry count; skirmishers excluded)">
            <div className="lbl">Squares</div>
            <div className="val">
              {summary.totalSquares}/{summary.totalInfantry}
            </div>
          </div>
          <div className="hstat">
            <div className="lbl">Cost / {MAX_BUILD_COST.toLocaleString()}</div>
            <div className={`val cost${overCost ? " over" : ""}`}>{summary.price.finalCost.toLocaleString()}</div>
          </div>
          <div className="hstat" title="Gold still available before the cost limit">
            <div className="lbl">Gold left</div>
            <div className={`val cost${overCost ? " over" : ""}`}>
              {Math.max(0, MAX_BUILD_COST - summary.price.finalCost).toLocaleString()}
            </div>
          </div>
        </div>
        <span className="spacer" style={{ flex: 1 }} />
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
          <input
            type="checkbox"
            checked={filters.showCombatGenerals}
            onChange={(e) => setFilters((f) => ({ ...f, showCombatGenerals: e.target.checked }))}
          />
          Combat generals
        </label>
        {isTow && (
          <label
            style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}
            title="Merge every enabled corps into one: staff, then each brigade type (cavalry, infantry, artillery) pooled across corps and ordered by price"
          >
            <input
              type="checkbox"
              checked={combinedTow}
              onChange={(e) => setCombinedTow(e.target.checked)}
            />
            Combine corps
          </label>
        )}
        {supportsRotation && (
          <label
            style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}
            title="Show only the combat & staff generals the game offers in this corps right now (your local-time rotation window)"
          >
            <input
              type="checkbox"
              checked={filters.onlyOfferedNow}
              onChange={(e) => setFilters((f) => ({ ...f, onlyOfferedNow: e.target.checked }))}
            />
            Offered now
          </label>
        )}
        <button
          className="btn small"
          onClick={() => (isTow ? setTowGenerateOpen(true) : setRotationOpen(true))}
          title={
            isTow
              ? "Find the nearest in-game time whose roll lets you recruit the corps & combat generals your build uses"
              : "When can I recruit each selected combat general? (in-game rotation times)"
          }
        >
          Generate times
        </button>
        {isTow && (
          <button
            className="btn small"
            onClick={() => setTowRollOpen(true)}
            title="Choose which army corps show in the builder (the game rolls 4 at a time)"
          >
            Corps roll
          </button>
        )}
        <button className="btn small" onClick={() => setFiltersOpen((o) => !o)}>
          {filtersOpen ? "Hide filters" : "Filters"}
        </button>
        <SaveLoadBar
          roster={roster}
          current={current}
          loaded={loadedSaved}
          dirty={dirty}
          onLoaded={applyLoaded}
          onSaved={setLoadedSaved}
          onMessage={setMessage}
        />
      </div>

      {/* Build-based warning takes priority over the enabled-set one: it names the
          corps your selection actually spans (with per-corps counts), so you can
          see exactly what to trim to get back to a rollable 4. */}
      {towBuild?.over ? (
        <div className="tow-warning banner" role="status">
          ⚠ Your build draws from {towBuild.count} army corps — the game rolls only{" "}
          {LEGACY_TOW_MAX_SOURCE_CORPS} together, so this build can’t come from a single roll. Click a corps
          below to remove its units — clear {towBuild.count - LEGACY_TOW_MAX_SOURCE_CORPS} corp
          {towBuild.count - LEGACY_TOW_MAX_SOURCE_CORPS === 1 ? "" : "s"} to make it rollable.
          <span className="tow-corps-chips">
            {towBuild.order.map((id) => {
              const info = towCorpsInfo?.get(id);
              const over = !towBuild.kept.has(id);
              const label = info ? `${roman(info.division)} · ${info.name}` : id;
              return (
                <button
                  key={id}
                  type="button"
                  className={`tow-corps-chip${over ? " over" : ""}`}
                  onClick={() => removeCorps(id)}
                  title={`Remove all units from ${label}`}
                >
                  {label}
                  <span className="n">{towBuild.counts.get(id)}</span>
                </button>
              );
            })}
          </span>
        </div>
      ) : tooManyCorps ? (
        <div className="tow-warning banner" role="status">
          ⚠ {enabledCorps!.size} army corps enabled — the game only rolls {LEGACY_TOW_MAX_SOURCE_CORPS} at a
          time. This combination won’t appear together in a real in-game roll.
        </div>
      ) : null}

      <div className="stage">
        <div className={`filters-drawer${filtersOpen ? "" : " closed"}`}>
          <FilterPanel
            filters={filters}
            onChange={setFilters}
            cards={roster.cards}
            matchCount={matchCount}
            totalCount={roster.cards.length}
          />
        </div>

        <div className={`map density-${density}`}>
          <BuilderGrid
            staffGenerals={staffGenerals}
            divisions={divisions}
            divisionMeta={combinedView ? EMPTY_DIVISION_META : divisionMeta}
            brigadeMeta={combinedView ? EMPTY_BRIGADE_META : brigadeMeta}
            divisionNames={divisionNames}
            handlers={handlers}
            onStaffToggle={toggleStaff}
          />
          {unplaced.length > 0 && (
            <section className="division" aria-label="Other units">
              <div className="division-tag">
                <span className="dn">Other</span>
              </div>
              <div className="div-row">
                <div className="brig-group">
                  {unplaced.map((card) => (
                    <UnplacedMedallion key={card.unitKey} card={card} h={handlers} />
                  ))}
                </div>
              </div>
            </section>
          )}
        </div>
      </div>

      <BottomTray
        index={index}
        build={build}
        summary={summary}
        isOverCorps={isOverCorps}
        onRemoveInstance={removeInstance}
        onClearStaff={clearStaff}
        onClearBuild={clearBuild}
        onAutoGenerals={autoCombatGenerals}
        autoGeneralsDisabled={!autoGeneralsAvailable}
        onResetGenerals={resetCombatGeneralsHandler}
        resetGeneralsDisabled={!resetGeneralsAvailable}
        onDetails={setDetail}
        onHover={(c, a) => setHovered({ card: c, anchor: a })}
        onHoverEnd={() => setHovered(null)}
      />

      {hovered && !detail && (
        <Tooltip
          card={hovered.card}
          anchor={hovered.anchor}
          blockReason={blockReasons.get(hovered.card.unitKey) ?? null}
        />
      )}
      {detail && (
        <DetailsPanel
          card={detail}
          inStaffSlot={inStaffSlot(detail.unitKey)}
          onSetCommander={detail.isGeneral ? () => toggleStaff(detail) : undefined}
          onClose={() => setDetail(null)}
        />
      )}
      {rotationOpen && (
        <RotationModal index={index} roster={roster} build={build} onClose={() => setRotationOpen(false)} />
      )}
      {towRollOpen && enabledCorps && (
        <TowRollModal
          roster={roster}
          index={index}
          build={build}
          enabled={enabledCorps}
          onToggle={toggleCorps}
          onClose={() => setTowRollOpen(false)}
        />
      )}
      {towGenerateOpen && (
        <TowGenerateModal roster={roster} index={index} build={build} onClose={() => setTowGenerateOpen(false)} />
      )}
      {message && <div className="toast" role="status">{message}</div>}
    </div>
  );
}

function UnplacedMedallion({ card, h }: { card: UnitCard; h: MedallionHandlers }) {
  const blocked = h.isBlocked(card);
  return (
    <Medallion
      card={card}
      qty={h.qtyOf(card.unitKey)}
      capCount={h.groupQtyOf(card)}
      selected={h.isSelected(card.unitKey)}
      dimmed={h.isDimmed(card)}
      blocked={blocked}
      overBudget={h.isOverBudget(card)}
      atCap={h.atCapOf(card)}
      onClick={() => h.onAdd(card)}
      onContextMenu={() => h.onDetails(card)}
      onHover={h.onHover}
      onHoverEnd={h.onHoverEnd}
    />
  );
}
