import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  evaluateSetCommander,
  fillDivision,
  generalSwapFor,
  groupQtyOf,
  hasCombatGeneralInstances,
  indexRoster,
  makeInstanceId,
  qtyOf as qtyOfBuild,
  resetCombatGenerals,
  staffGeneralAction,
  staffSetWouldExceedBudget,
  summarize,
  swapInstanceUnit,
  unitsWithCombatGenerals,
  withCommander,
} from "../state/build";
import { type FilterState, defaultFilters, isFilterActive, isHiddenByGeneralSwitch, matchesCard } from "../state/filters";
import { combinedTowLayout, orderBrigadeCards } from "../state/ordering";
import { type BuildConfig, type CurrentBuild, type LoadResult, type SavedBuild, isDirty, resolveSavedBuild } from "../state/saves";
import { BottomTray } from "./BottomTray";
import { BuilderGrid, type DivisionGroup, type GroupMeta, type MedallionHandlers } from "./BuilderGrid";
import { DetailsPanel } from "./DetailsPanel";
import { PICK_RATES_ENABLED } from "../features/pickRates/flag";
import { PickRateBar, PickRateChip, PickRateNotice } from "../features/pickRates/PickRateBar";
import { usePickRates } from "../features/pickRates/usePickRates";
import { FilterPanel } from "./FilterPanel";
import { Medallion } from "./Medallion";
import { combatPool, offeredCombatKeys, offeredStaffKeys, rotationApplies, staffPool } from "../state/rotation";
import { LEGACY_TOW_MAX_SOURCE_CORPS, isCardOverCorpsCeiling, towCorpsCeiling } from "../state/towRoll";
import { compareTowSourceCorpsIds, isTowFactionKey, towBrigadeLabel } from "../domain/tow";
import { towCorpsFullNameMap } from "../domain/towCorpsNames";
import { buggedUniformKey } from "../domain/buggedUniforms";
import { BuggedUniformModal } from "./BuggedUniformModal";
import { GeneralSwapModal } from "./GeneralSwapModal";
import { RotationModal } from "./RotationModal";
import { TowRollModal } from "./TowRollModal";
import { TowGenerateModal } from "./TowGenerateModal";
import { SaveLoadBar } from "./SaveLoadBar";
import { Tooltip } from "./Tooltip";
import { type DeliverResult, deliverImage, renderBuildImage, shareImageFile } from "./exportBuildImage";
import { isCoarsePointer, isPhone } from "./useCoarsePointer";

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
  initialSaved = null,
  onBuildChange,
  context,
}: {
  roster: FactionRoster;
  postFlag: string | null;
  onBack: () => void;
  /** Seed the build with an already-assembled army (e.g. one imported from a
   *  replay) instead of starting empty. Must be a stable reference — it is an
   *  effect dependency. Left unsaved, so the tray reads as having changes. */
  initialSaved?: SavedBuild | null;
  /** Report every edit of the build, so a host that owns the army (the Ordre de
   *  Bataille planner) can mirror it. Fired only for edits made after the seed is in
   *  place — never with the empty pre-seed build — and not for the seed itself. */
  onBuildChange?: (current: CurrentBuild) => void;
  /** Where this builder was opened from. Replaces the "← Corps" back label and the
   *  imported-from-replay wording with the host's own (e.g. "Army 2 of Plan"). */
  context?: { backLabel: string; label: string };
}) {
  const index = useMemo(() => indexRoster(roster), [roster]);
  const [build, setBuild] = useState<BuildState>(emptyBuild);
  const [filters, setFilters] = useState<FilterState>(() => defaultFiltersFor(roster.factionKey));
  const [density, setDensity] = useState<"comfortable" | "compact">("compact");
  // Filters start open on desktop/tablets but collapsed on phones, where the
  // drawer would otherwise bury the unit grid on first load (user can still open
  // it via the header "Filters" button).
  const [filtersOpen, setFiltersOpen] = useState(() => !isPhone());
  const [detail, setDetail] = useState<UnitCard | null>(null);
  const [hovered, setHovered] = useState<{ card: UnitCard; anchor: DOMRect } | null>(null);
  // Touch peek: the simplified stat card shown by long-press (grid) or tap (tray).
  // Separate from `hovered` (which is desktop-only) and from `detail` (full panel).
  const [peek, setPeek] = useState<{ card: UnitCard; anchor: DOMRect } | null>(null);
  // Touch grid two-tap model: the unit whose stat card a first tap has shown. While
  // it stays primed, a tap adds it (rather than re-peeking); tapping a different unit
  // moves the priming. Always null on desktop, which adds on the first click.
  const [primedKey, setPrimedKey] = useState<string | null>(null);
  // Bugged-uniform advisory: the card whose warning popup is currently open, and
  // the set of regiment keys already warned about (so re-adding copies of the same
  // 23e léger doesn't re-pop the modal). Both reset when the roster changes.
  const [buggedWarning, setBuggedWarning] = useState<UnitCard | null>(null);
  const [warnedBugged, setWarnedBugged] = useState<Set<string>>(() => new Set());
  // The selected copy whose combat-general chooser is open (★ badge in the tray).
  const [swapInstanceId, setSwapInstanceId] = useState<string | null>(null);
  const [loadedSaved, setLoadedSaved] = useState<SavedBuild | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [rotationOpen, setRotationOpen] = useState(false);
  // Optional pick-rate overlay (features/pickRates). Inert — and never fetches —
  // unless the build enabled the feature and the user switched it on.
  // When combat generals are hidden their medallions are gone, so their builds fold
  // into the plain unit's number rather than vanishing from the grid.
  const pickRates = usePickRates(roster.factionKey, !filters.showCombatGenerals);
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
  // Locate mode (tray "Locate units" button): the grid rings every unit in the build,
  // and clicking one in the tray scrolls the grid to it and flashes it. TOW shows
  // the separate corps while it is on, so each unit sits under its own corps.
  const [locating, setLocating] = useState(false);
  // The grid card being flashed; `seq` makes locating the same unit again a new
  // state, so the grid scrolls back to it even while the last flash is running.
  const [locateFlash, setLocateFlash] = useState<{ key: string; seq: number } | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  // Whether the grid uses the pooled brigade-type layout: always for custom
  // armies, and for TOW when the "Combine corps" toggle is on (unless locating).
  const combinedView = isCustom || (isTow && combinedTow && !locating);

  // Latest host props, read by effects that must not re-run when a host re-renders
  // with fresh closures (the seed effect below resets the whole builder).
  const hostRef = useRef({ onBuildChange, context, config: { density, showCombatGenerals: filters.showCombatGenerals } });
  useEffect(() => {
    hostRef.current = { onBuildChange, context, config: { density, showCombatGenerals: filters.showCombatGenerals } };
  });
  // The build the seed effect installed and the notify effect has not yet seen: until
  // the state catches up to it, `build` is still the pre-seed empty one.
  const pendingSeed = useRef<BuildState | null>(null);

  useEffect(() => {
    // A seeded army (imported from a replay) resolves through the same path as a
    // loaded save, so unknown keys drop out and get reported the same way.
    const seed = initialSaved?.factionKey === roster.factionKey ? initialSaved : null;
    const seeded = seed ? resolveSavedBuild(seed, roster) : null;
    const initialBuild = seeded ? seeded.build : emptyBuild();
    pendingSeed.current = initialBuild;
    setBuild(initialBuild);
    setFilters(defaultFiltersFor(roster.factionKey));
    setLoadedSaved(null);
    const skipped = seeded?.missingKeys.length ? ` — ${seeded.missingKeys.length} unknown unit(s) skipped` : "";
    const host = hostRef.current.context;
    setMessage(
      seed && seeded
        ? host
          ? `Opened “${seed.name}” from ${host.label}${skipped}.`
          : `Imported “${seed.name}”${skipped}. Not saved yet.`
        : null,
    );
    setHovered(null);
    setPeek(null);
    setPrimedKey(null);
    setBuggedWarning(null);
    setWarnedBugged(new Set());
    setSwapInstanceId(null);
    setTowRollOpen(false);
    setTowGenerateOpen(false);
    setLocating(false);
    setLocateFlash(null);
    // Enable every source corps by default (the combined view pools them all;
    // >4 is over the game's roll size, which the header banner flags).
    setEnabledCorps(isTowFactionKey(roster.factionKey) ? new Set(allTowSourceCorpsIds(roster.cards)) : null);
  }, [roster, initialSaved]);

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

  // The same for putting a general in the staff slot ("Set commander"): the commander
  // counts toward the 31 cards, its unit's shared cap, one-general-per-unit and the
  // class caps like any other card, so the route must not side-step them.
  const commanderBlockReasons = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const c of roster.cards) {
      if (c.isGeneral) m.set(c.unitKey, evaluateSetCommander(index, build, c)?.reason ?? null);
    }
    return m;
  }, [index, build, roster.cards]);

  // The 10,000 ceiling is soft: instead of blocking, we flag (red cost) any unit
  // whose selection would push the build's total past it. Computed once per build.
  const overBudgetCards = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const c of roster.cards) {
      // Ask the question the click will actually answer: a staff general whose click
      // recruits him is priced like any other unit, not like a commander swap.
      const over =
        c.isGeneral && c.generalKind === "staff" && staffGeneralAction(index, build, c) === "set-commander"
          ? staffSetWouldExceedBudget(index, build, c)
          : addWouldExceedBudget(summary.price, c);
      m.set(c.unitKey, over);
    }
    return m;
  }, [index, build, roster.cards, summary.price]);

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
  // Pick rate as a plain 0-100 number for the filter. Never-picked is a real 0;
  // anything the dataset cannot speak about is null and the filter leaves it alone.
  const pickRatePct = useCallback(
    (card: UnitCard): number | null => {
      const r = pickRates.rateOf(card.unitKey, card.baseUnitKey);
      if (!r) return null;
      if (r.kind === "never") return 0;
      if (r.kind !== "data") return null;
      return (100 * r.builds) / r.n;
    },
    [pickRates],
  );

  const isDimmed = (card: UnitCard) => isFilterActive(filters) && !matchesCard(card, filters, pickRatePct);
  const isBlocked = (card: UnitCard) => blockReasons.get(card.unitKey) != null;
  // Why a grid click on this card would be refused. A staff general's click sets the
  // commander or recruits him (staffGeneralAction), so it answers for whichever of the
  // two the click will actually do; every other card's click adds a copy.
  const gridBlockReason = (card: UnitCard): string | null =>
    card.isGeneral && card.generalKind === "staff" && staffGeneralAction(index, build, card) === "set-commander"
      ? (commanderBlockReasons.get(card.unitKey) ?? null)
      : (blockReasons.get(card.unitKey) ?? null);
  const isOverBudget = (card: UnitCard) => overBudgetCards.get(card.unitKey) === true;
  // Soft 4-corps ceiling (TOW): a card is "over" when its source corps is already
  // in the build beyond the first 4 rolled, or adding it would open a 5th corps.
  const isOverCorps = (card: UnitCard) => (towBuild ? isCardOverCorpsCeiling(card, towBuild) : false);

  // Pop the bugged-uniform advisory the first time a copy of one of the affected
  // 23e léger regiments (see domain/buggedUniforms) is added to this build.
  const maybeWarnBugged = (card: UnitCard) => {
    const key = buggedUniformKey(card);
    if (!key || warnedBugged.has(key)) return;
    setWarnedBugged((s) => new Set(s).add(key));
    setBuggedWarning(card);
  };

  const tryAdd = (card: UnitCard) => {
    const reason = blockReasons.get(card.unitKey);
    if (reason) {
      setMessage(reason);
      return;
    }
    setBuild((b) => ({ ...b, instances: [...b.instances, { id: makeInstanceId(), unitKey: card.unitKey }] }));
    maybeWarnBugged(card);
  };

  const removeInstance = (id: string) =>
    setBuild((b) => ({ ...b, instances: b.instances.filter((i) => i.id !== id) }));

  // Touch grid long-press = "deselect from the bar": drop the most recently added
  // copy of this unit, or clear the staff slot if the card is the current commander.
  // Repeat long-presses peel off further copies; a no-op if none are selected.
  const removeOneByKey = (key: string) =>
    setBuild((b) => {
      if (b.staffSlotUnitKey === key) return { ...b, staffSlotUnitKey: null };
      const idx = b.instances.map((i) => i.unitKey).lastIndexOf(key);
      if (idx < 0) return b;
      return { ...b, instances: b.instances.filter((_, i) => i !== idx) };
    });

  // Touch grid tap dispatcher. A first tap on a unit shows its stat card and primes
  // it; a second tap (and any after) runs its action — add, or set commander for a
  // staff general. Tapping a different unit re-primes that one instead.
  const primeOrAct = (card: UnitCard, act: (c: UnitCard) => void, anchor: DOMRect) => {
    if (primedKey === card.unitKey) {
      act(card);
    } else {
      setPrimedKey(card.unitKey);
      setPeek({ card, anchor });
    }
  };

  // Dismiss the touch peek and its two-tap prime together. The prime must never
  // outlive the stat card: if it did, the next tap on the same unit would run its
  // action (add / set commander) instead of re-peeking. Used for every path that
  // clears the peek without acting (scroll/outside-tap dismiss, opening full
  // details) so `primedKey` can't desync from `peek`.
  const dismissPeek = useCallback(() => {
    setPeek(null);
    setPrimedKey(null);
  }, []);

  const toggleStaff = (card: UnitCard) => {
    // The cost ceiling is soft, so a commander's cost never blocks it (it just shows
    // red when it pushes the total over) — but the hard limits do, exactly as for an
    // add: see evaluateSetCommander. Clearing the slot is always allowed.
    if (build.staffSlotUnitKey !== card.unitKey) {
      const reason = commanderBlockReasons.get(card.unitKey);
      if (reason) {
        setMessage(reason);
        return;
      }
    }
    setBuild((b) => (b.staffSlotUnitKey === card.unitKey ? { ...b, staffSlotUnitKey: null } : withCommander(b, card.unitKey)));
  };

  /** Left-click on a staff general in the grid.
   *
   *  The staff slot holds one card, so a plain "always toggle" click has nothing
   *  sensible to do once somebody else is commanding. What the click should mean
   *  depends on who that somebody is:
   *
   *    - slot empty, or holding this same card -> set / unset the commander;
   *    - another STAFF general commands        -> swap the commander, one click
   *      (only 16% of corps offer more than one, but swapping is the obvious intent);
   *    - a COMBAT general commands             -> the player has deliberately picked a
   *      non-standard commander, so clicking a staff general means "field it as an
   *      ordinary unit" — which the game allows (see docs/HANDOFF.md).
   *
   *  The details panel's "Recruit as a unit" remains the explicit route for the
   *  remaining case: recruiting a second staff general while one already commands.
   */
  const staffClick = (card: UnitCard) =>
    staffGeneralAction(index, build, card) === "recruit" ? tryAdd(card) : toggleStaff(card);

  const clearStaff = () => setBuild((b) => ({ ...b, staffSlotUnitKey: null }));
  const clearBuild = () => {
    if (build.instances.length === 0 && !build.staffSlotUnitKey) return;
    setBuild(emptyBuild());
    setPrimedKey(null);
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

  const toggleLocate = () => {
    setLocateFlash(null);
    setLocating(!locating);
    if (!locating)
      setMessage(`Locate: your units are ringed in the grid — ${coarse ? "tap" : "click"} one in the bar to jump to it.`);
  };

  // The grid card that stands for a build unit. With the "Combat generals" switch
  // off a combat general has no card of his own, so the plain unit he leads (same
  // brigade) stands in for him.
  const gridCardFor = useCallback(
    (card: UnitCard): UnitCard => (isHiddenByGeneralSwitch(card, filters) ? (index.byKey.get(card.baseUnitKey) ?? card) : card),
    [filters, index],
  );

  // Grid cards ringed in locate mode: every build unit's stand-in.
  const locatedKeys = useMemo(() => {
    if (!locating) return null;
    const keys = new Set<string>();
    for (const key of [build.staffSlotUnitKey, ...build.instances.map((i) => i.unitKey)]) {
      const card = key ? index.byKey.get(key) : undefined;
      if (card) keys.add(gridCardFor(card).unitKey);
    }
    return keys;
  }, [locating, build, index, gridCardFor]);

  // Find a build unit in the grid. A TOW unit whose corps is switched off in the
  // Corps roll menu has no grid card, so its corps is switched back on first; a
  // general outside the current rotation window is hidden by "Offered now".
  const locateUnit = (card: UnitCard) => {
    const target = gridCardFor(card);
    if (hiddenByRotation(target)) {
      setMessage(`${target.name} isn't offered in the current rotation window — turn off "Offered now" to see it.`);
      return;
    }
    const id = target.towSourceCorpsId;
    if (id && enabledCorps && !enabledCorps.has(id)) {
      toggleCorps(id, true);
      const info = towCorpsInfo?.get(id);
      setMessage(`Turned ${info ? `${roman(info.division)} · ${info.name}` : `corps ${id}`} back on to show this unit.`);
    }
    setLocateFlash((f) => ({ key: target.unitKey, seq: (f?.seq ?? 0) + 1 }));
  };

  // Scroll the located card into view once the grid has rendered it, and let the
  // flash run out. Every way the grid hides a card is handled above, so a missing
  // card should not happen; say so rather than scroll nowhere.
  useEffect(() => {
    if (!locateFlash) return;
    const frame = requestAnimationFrame(() => {
      const el = mapRef.current?.querySelector(`[data-unit-key="${CSS.escape(locateFlash.key)}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      else setMessage(`${index.byKey.get(locateFlash.key)?.name ?? "That unit"} isn't shown in the grid right now.`);
    });
    const timer = setTimeout(() => setLocateFlash(null), 2600);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [locateFlash, index]);

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
    setMessage(`Upgraded ${n} unit${n === 1 ? "" : "s"} with combat general${n === 1 ? "" : "s"} to lower the build's cost.`);
  };

  // Swap every combat general back to the plain unit it leads (commander untouched).
  const resetGeneralsAvailable = hasCombatGeneralInstances(index, build);
  const resetCombatGeneralsHandler = () => {
    if (!resetGeneralsAvailable) return;
    setBuild((b) => resetCombatGenerals(index, b));
    setMessage("Reset combat generals to their base units.");
  };

  // Per-unit combat general: take a unit now, give it a general later. The ★ badge on
  // a selected copy in the tray opens the chooser for that copy; picking a general
  // swaps it into the same slot (and picking the plain unit takes it back out).
  const unitsWithGenerals = useMemo(() => unitsWithCombatGenerals(index), [index]);
  const canSwapGeneral = useCallback(
    (card: UnitCard) => unitsWithGenerals.has(card.capGroupKey),
    [unitsWithGenerals],
  );
  const generalSwap = useMemo(
    () => (swapInstanceId ? generalSwapFor(index, build, swapInstanceId, combatCap) : null),
    [swapInstanceId, index, build, combatCap],
  );
  const applyGeneralSwap = (unitKey: string) => {
    if (!swapInstanceId) return;
    const card = index.byKey.get(unitKey);
    setBuild((b) => swapInstanceUnit(b, swapInstanceId, unitKey));
    setSwapInstanceId(null);
    if (!card) return;
    // The general variant carries the same (bugged) uniform as the unit it leads.
    maybeWarnBugged(card);
    setMessage(
      card.isGeneral && card.generalKind === "combat"
        ? `${card.name} now leads this unit.`
        : `${card.name} is back to a plain unit — its combat general was removed.`,
    );
  };

  // Export the build as a stretched-out single-line image (like the desktop unit
  // bar): copied to the clipboard on desktop, saved/shared to the device on touch.
  const hasBuild = build.instances.length > 0 || build.staffSlotUnitKey !== null;
  // A rendered image the share sheet refused because the tap that asked for it had
  // expired while it rendered (WebKit): offered back behind a fresh "Share" tap.
  const [pendingShare, setPendingShare] = useState<File | null>(null);
  const reportDelivery = (result: DeliverResult) => {
    if (result === "copied") setMessage("Build image copied to clipboard.");
    // A download can't be confirmed (an installed iOS web app silently drops it), so
    // say only that it was started.
    else if (result === "downloaded") setMessage("Build image download started.");
  };
  const exportImage = async () => {
    if (!hasBuild) return;
    setPendingShare(null);
    try {
      // Start rendering but hand the pending image to deliverImage straight away: the
      // clipboard write must begin inside this click, not after the render.
      const render = renderBuildImage(index, build, {
        title: roster.armyCorpsName || roster.factionKey,
        subtitle: `${summary.totalCards} cards · ${summary.totalMen.toLocaleString()} men · ${summary.price.finalCost.toLocaleString()} gold`,
      });
      const base = (roster.armyCorpsName || roster.factionKey).replace(/[^\w-]+/g, "_").slice(0, 60) || "build";
      const result = await deliverImage(render, `${base}.png`, isCoarsePointer());
      if (typeof result === "object") setPendingShare(result.retryShare);
      else reportDelivery(result);
    } catch {
      setMessage("Couldn't export the build image.");
    }
  };
  const sharePending = async () => {
    const file = pendingShare;
    if (!file) return;
    setPendingShare(null);
    try {
      reportDelivery(await shareImageFile(file));
    } catch {
      setMessage("Couldn't share the build image.");
    }
  };

  // Touch (phones/tablets) uses the two-tap grid model; desktop/Electron stays
  // byte-identical (tap = add, right-click = details). Pointer type is stable per
  // session, so a non-reactive read is safe.
  const coarse = isCoarsePointer();
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
    onAdd: coarse ? (card, anchor) => primeOrAct(card, tryAdd, anchor ?? new DOMRect()) : tryAdd,
    onDetails: coarse ? (card) => removeOneByKey(card.unitKey) : setDetail,
    // Keyboard shortcuts name their action outright on every device: "i" opens the
    // details, Delete drops a copy — whatever right-click / long-press mean here.
    onKeyDetails: setDetail,
    onKeyRemove: (card) => removeOneByKey(card.unitKey),
    isStaffBlocked: (card) => gridBlockReason(card) != null,
    onHover: (card, anchor) => setHovered({ card, anchor }),
    onHoverEnd: () => setHovered(null),
    isPrimed: (key) => primedKey === key,
    locateOf: (card) =>
      locateFlash?.key === card.unitKey ? "flash" : locatedKeys?.has(card.unitKey) ? "mark" : null,
    pickRateOf: (card) => {
      const rate = pickRates.rateOf(card.unitKey, card.baseUnitKey);
      return rate ? <PickRateBar rate={rate} thresholds={pickRates.season?.thresholds} /> : null;
    },
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

  // A TOW card is hidden when its source corps is not in the enabled roll —
  // staff generals included, since the game offers one only when his corps rolls.
  // Only affects display (the build state is untouched); non-TOW cards are unaffected.
  const hiddenByCorpsRoll = useCallback(
    (c: UnitCard) =>
      enabledCorps != null && c.towSourceCorpsId != null && !enabledCorps.has(c.towSourceCorpsId),
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

  // Counts exactly the cards the grid draws (same hiding rules as the layout above)
  // that also match the filters.
  const matchCount = useMemo(
    () =>
      roster.cards.filter(
        (c) =>
          matchesCard(c, filters, pickRatePct) &&
          !isHiddenByGeneralSwitch(c, filters) &&
          !hiddenByRotation(c) &&
          !hiddenByCorpsRoll(c),
      ).length,
    [roster.cards, filters, hiddenByRotation, hiddenByCorpsRoll, pickRatePct],
  );

  const current = { build, config, factionKey: roster.factionKey, armyCorpsName: roster.armyCorpsName };
  const dirty = isDirty(current, loadedSaved);

  // Tell the host about edits (see onBuildChange). `current` is rebuilt every render,
  // so key the effect on the pieces it is made of; the callback itself is read from
  // hostRef so a host re-render can neither re-fire this nor re-seed the builder.
  // Only the build (units + commander) triggers it: density and the combat-generals
  // toggle are view settings, so flipping them must not look like an edit to the host
  // (it would bump the slot's updatedAt and autosave for nothing).
  useEffect(() => {
    if (pendingSeed.current) {
      if (build !== pendingSeed.current) return; // still the pre-seed build
      pendingSeed.current = null; // the seed itself is not an edit
      return;
    }
    hostRef.current.onBuildChange?.({
      build,
      config: hostRef.current.config,
      factionKey: roster.factionKey,
      armyCorpsName: roster.armyCorpsName,
    });
  }, [build, roster.factionKey, roster.armyCorpsName]);

  const applyLoaded = (result: LoadResult, saved: SavedBuild) => {
    setBuild(result.build);
    setDensity(result.config.density);
    setFilters((f) => ({ ...f, showCombatGenerals: result.config.showCombatGenerals }));
    setLoadedSaved(saved);
    if (result.missingKeys.length) setMessage(`Loaded “${saved.name}” — ${result.missingKeys.length} unknown unit(s) skipped.`);
    else setMessage(`Loaded “${saved.name}”.`);
  };

  // "Take the whole division" (army-corps grid only: in the combined/TOW views a grid
  // "division" is a brigade-type pool or a source corps, not a discount formation).
  // Copies each division still lacks; the header button hides at 0.
  const divisionFillCounts = useMemo(() => {
    if (combinedView || isTow || !roster.factionKey.includes("_ac_")) return null;
    const m = new Map<number, number>();
    // Count what a click would really add, not the plan: a limit (artillery caps,
    // 31 cards) can leave copies no click will ever take, and the button should then
    // disappear rather than sit at "+ All 1" forever.
    for (const dv of divisions) m.set(dv.division, fillDivision(index, build, dv.division, combatCap).added.length);
    return m;
  }, [combinedView, isTow, roster.factionKey, divisions, index, build, combatCap]);
  const takeDivision = (division: number) => {
    const label = `Division ${roman(division)}`;
    const fill = fillDivision(index, build, division, combatCap);
    if (fill.added.length === 0) {
      setMessage(
        fill.blockedReasons.length
          ? `Couldn't add any units from ${label} — ${fill.blockedReasons.join(" ")}`
          : `${label} has no units missing.`,
      );
      return;
    }
    setBuild(fill.build);
    const n = fill.added.length;
    setMessage(
      n === fill.wanted
        ? `Added ${n} unit${n === 1 ? "" : "s"} from ${label}.`
        : `Added ${n} of ${fill.wanted} from ${label} — ${fill.blockedReasons.join(" ")}`,
    );
    const bugged = fill.added.find((c) => buggedUniformKey(c));
    if (bugged) maybeWarnBugged(bugged);
  };

  // Any open modal takes over from the stat cards: the touch peek (which sits above
  // the modal layer) is dismissed with its prime, and the hover card is dropped.
  const modalOpen =
    !!detail || !!buggedWarning || !!swapInstanceId || rotationOpen || towRollOpen || towGenerateOpen;
  useEffect(() => {
    if (!modalOpen) return;
    dismissPeek();
    setHovered(null);
  }, [modalOpen, dismissPeek]);

  const over = summary.totalCards > MAX_TOTAL_UNIT_CARDS;
  const overCost = summary.price.finalCost > MAX_BUILD_COST;

  return (
    <div className="builder">
      <div className="corps-header">
        <button className="btn small" onClick={onBack}>
          {context?.backLabel ?? "← Corps"}
        </button>
        {postFlag && <img className="post-flag" src={assetUrl(postFlag) ?? undefined} alt="" />}
        <div className="titles">
          <h2>{roster.armyCorpsName || roster.factionKey}</h2>
          <div className="sub">
            {loadedSaved
              ? `${context ? `${context.label} · ` : ""}${loadedSaved.name}${dirty ? " • unsaved changes" : ""}`
              : context
                ? context.label
                : dirty
                  ? "Unsaved build"
                  : "New build"}
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
              checked={combinedTow && !locating}
              disabled={locating}
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
        {/* Optional feature: absent entirely unless the build set VITE_PICK_RATES=1
            (the condition folds to a literal, so this is dropped at minify time). */}
        {PICK_RATES_ENABLED && pickRates.available && (
          <label
            style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}
            title="Show how often real players field each unit, from recorded battle replays"
          >
            <input
              type="checkbox"
              checked={pickRates.show}
              onChange={(e) => pickRates.setShow(e.target.checked)}
            />
            Pick rates <span className="tag beta">Beta</span>
          </label>
        )}
        {PICK_RATES_ENABLED && pickRates.show && (pickRates.index?.seasons.length ?? 0) > 1 && (
          <select
            className="btn small"
            value={pickRates.seasonId ?? ""}
            onChange={(e) => pickRates.setSeasonId(e.target.value)}
            title="Which recorded dataset the pick rates come from"
          >
            {pickRates.index!.seasons.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} — {s.patch}
              </option>
            ))}
          </select>
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
      {/* Rule breaks the add/commander checks can't prevent — a loaded or imported
          save, or a build from before a rule existed. The price above still stands,
          but the build could not be fielded as it is. */}
      {summary.violationMessages.length > 0 && (
        <div className="tow-warning banner build-violations" role="status">
          ⚠ This build breaks {summary.violationMessages.length === 1 ? "a limit" : `${summary.violationMessages.length} limits`}{" "}
          and can’t be fielded as is:
          <ul>
            {summary.violationMessages.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="stage">
        <div className={`filters-drawer${filtersOpen ? "" : " closed"}`}>
          <FilterPanel
            filters={filters}
            onChange={setFilters}
            cards={roster.cards}
            matchCount={matchCount}
            totalCount={roster.cards.length}
            showPickRate={PICK_RATES_ENABLED && pickRates.show && !!pickRates.season}
          />
        </div>

        <div className={`map density-${density}`} ref={mapRef}>
          {PICK_RATES_ENABLED && pickRates.show && (
            <div className="pr-header">
              <PickRateChip
                corps={pickRates.corps}
                summary={pickRates.index?.seasons.find((s) => s.id === pickRates.seasonId) ?? null}
                loading={pickRates.loading}
              />
              <PickRateNotice
                corps={pickRates.corps}
                minSample={pickRates.season?.thresholds.minSampleForPercent ?? 5}
              />
            </div>
          )}
          <BuilderGrid
            staffGenerals={staffGenerals}
            divisions={divisions}
            divisionMeta={combinedView ? EMPTY_DIVISION_META : divisionMeta}
            brigadeMeta={combinedView ? EMPTY_BRIGADE_META : brigadeMeta}
            divisionNames={divisionNames}
            handlers={handlers}
            onStaffToggle={coarse ? (card, anchor) => primeOrAct(card, staffClick, anchor ?? new DOMRect()) : staffClick}
            fillCounts={divisionFillCounts}
            onTakeDivision={takeDivision}
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
        canSwapGeneral={canSwapGeneral}
        onSwapGeneral={(id) => {
          // The badge swallows its own pointer events, so the peek card's
          // outside-tap dismissal never sees the press — close it here, or it would
          // hang over the chooser on touch.
          dismissPeek();
          setSwapInstanceId(id);
        }}
        onClearStaff={clearStaff}
        onClearBuild={clearBuild}
        onAutoGenerals={autoCombatGenerals}
        autoGeneralsDisabled={!autoGeneralsAvailable}
        onResetGenerals={resetCombatGeneralsHandler}
        resetGeneralsDisabled={!resetGeneralsAvailable}
        onExportImage={exportImage}
        exportDisabled={!hasBuild}
        onDetails={setDetail}
        onHover={(c, a) => setHovered({ card: c, anchor: a })}
        onHoverEnd={() => setHovered(null)}
        onPeek={(card, anchor) => {
          // A tray peek is not a grid prime; clear any lingering grid prime so a
          // later tap on that grid unit re-peeks rather than acting.
          setPrimedKey(null);
          setPeek({ card, anchor });
        }}
        corpsStat={isTow && towBuild ? { count: towBuild.count, max: LEGACY_TOW_MAX_SOURCE_CORPS, over: towBuild.over } : null}
        locating={locating}
        onToggleLocate={toggleLocate}
        onLocate={locateUnit}
      />

      {hovered && !modalOpen && !peek && (
        <Tooltip
          card={hovered.card}
          anchor={hovered.anchor}
          blockReason={gridBlockReason(hovered.card)}
        />
      )}
      {peek && !modalOpen && (
        <Tooltip
          card={peek.card}
          anchor={peek.anchor}
          variant="peek"
          blockReason={gridBlockReason(peek.card)}
          onFullDetails={() => {
            setDetail(peek.card);
            dismissPeek();
          }}
          onDismiss={dismissPeek}
        />
      )}
      {detail && (
        <DetailsPanel
          card={detail}
          inStaffSlot={inStaffSlot(detail.unitKey)}
          onSetCommander={detail.isGeneral ? () => toggleStaff(detail) : undefined}
          setCommanderBlockedReason={inStaffSlot(detail.unitKey) ? null : (commanderBlockReasons.get(detail.unitKey) ?? null)}
          // Staff generals are only ever routed to the commander slot by the grid, but
          // the game lets a corps field one as an ordinary unit (with a combat general
          // commanding instead) — real replays do exactly that. Offer the second path
          // here rather than overloading the grid click.
          onRecruitAsUnit={
            detail.isGeneral && detail.generalKind === "staff" && !inStaffSlot(detail.unitKey)
              ? () => {
                  tryAdd(detail);
                  setDetail(null);
                }
              : undefined
          }
          recruitBlockedReason={
            detail.isGeneral && detail.generalKind === "staff"
              ? (evaluateAdd(index, build, detail, combatCap)?.reason ?? null)
              : null
          }
          onClose={() => setDetail(null)}
          pickRate={pickRates.rateOf(detail.unitKey, detail.baseUnitKey)}
          pickRateCombined={pickRates.combineVariants}
          pickRateRegiment={pickRates.regimentOf(detail.baseUnitKey || detail.unitKey)}
          pickRateSeason={pickRates.season}
        />
      )}
      {generalSwap && (
        <GeneralSwapModal
          swap={generalSwap}
          combatCap={combatCap}
          combatGensUsed={combatGensUsed}
          onPick={applyGeneralSwap}
          onClose={() => setSwapInstanceId(null)}
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
      {buggedWarning && (
        <BuggedUniformModal card={buggedWarning} onClose={() => setBuggedWarning(null)} />
      )}
      {message && <div className="toast" role="status">{message}</div>}
      {pendingShare && (
        <div className="toast share-ready" role="dialog" aria-label="Share build image">
          <span>Build image ready.</span>
          <button type="button" className="btn small primary" onClick={sharePending}>
            Share
          </button>
          <button type="button" className="btn small" onClick={() => setPendingShare(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
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
      primed={h.isPrimed(card.unitKey)}
      dimmed={h.isDimmed(card)}
      blocked={blocked}
      overBudget={h.isOverBudget(card)}
      locate={h.locateOf?.(card)}
      atCap={h.atCapOf(card)}
      onClick={(anchor) => h.onAdd(card, anchor)}
      onContextMenu={() => h.onDetails(card)}
      onDetails={() => h.onKeyDetails(card)}
      onRemove={h.isSelected(card.unitKey) ? () => h.onKeyRemove(card) : undefined}
      onHover={h.onHover}
      onHoverEnd={h.onHoverEnd}
      pickRate={h.pickRateOf?.(card)}
    />
  );
}
