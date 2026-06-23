import { useEffect, useMemo, useState } from "react";
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
import { orderBrigadeCards } from "../state/ordering";
import { type BuildConfig, type LoadResult, type SavedBuild, isDirty } from "../state/saves";
import { BottomTray } from "./BottomTray";
import { BuilderGrid, type DivisionGroup, type GroupMeta, type MedallionHandlers } from "./BuilderGrid";
import { DetailsPanel } from "./DetailsPanel";
import { FilterPanel } from "./FilterPanel";
import { Medallion } from "./Medallion";
import { RotationModal } from "./RotationModal";
import { SaveLoadBar } from "./SaveLoadBar";
import { Tooltip } from "./Tooltip";

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
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [density, setDensity] = useState<"comfortable" | "compact">("compact");
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [detail, setDetail] = useState<UnitCard | null>(null);
  const [hovered, setHovered] = useState<{ card: UnitCard; anchor: DOMRect } | null>(null);
  const [loadedSaved, setLoadedSaved] = useState<SavedBuild | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [rotationOpen, setRotationOpen] = useState(false);

  useEffect(() => {
    setBuild(emptyBuild());
    setFilters(defaultFilters());
    setLoadedSaved(null);
    setHovered(null);
  }, [roster.factionKey]);

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
    qtyOf,
    groupQtyOf: groupQty,
    atCapOf,
    onAdd: tryAdd,
    onDetails: setDetail,
    onHover: (card, anchor) => setHovered({ card, anchor }),
    onHoverEnd: () => setHovered(null),
  };

  // --- organizational grouping ---
  const { staffGenerals, divisions, unplaced } = useMemo(() => {
    const visible = roster.cards.filter((c) => !isHiddenByGeneralSwitch(c, filters));
    const staffGenerals: UnitCard[] = [];
    const divMap = new Map<number, Map<number, UnitCard[]>>();
    const unplaced: UnitCard[] = [];
    for (const c of visible) {
      if (c.isGeneral && c.generalKind === "staff") {
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
  }, [roster.cards, filters]);

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
    () => roster.cards.filter((c) => matchesCard(c, filters) && !isHiddenByGeneralSwitch(c, filters)).length,
    [roster.cards, filters],
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
          <div className="hstat" title="Selected unit cards able to form square">
            <div className="lbl">Squares</div>
            <div className="val">{summary.totalSquares}</div>
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
        <button
          className="btn small"
          onClick={() => setRotationOpen(true)}
          title="When can I recruit each selected combat general? (in-game rotation times)"
        >
          ⏱ General times
        </button>
        <button className="btn small" onClick={() => setFiltersOpen((o) => !o)}>
          {filtersOpen ? "Hide filters" : "Filters"}
        </button>
        <button className="btn small" onClick={() => setDensity((d) => (d === "comfortable" ? "compact" : "comfortable"))}>
          {density === "comfortable" ? "Compact" : "Comfortable"}
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
            divisionMeta={divisionMeta}
            brigadeMeta={brigadeMeta}
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
