// In-app build optimiser for Theatre-of-War, Custom and Army Corps armies.
//
// Finds the build with the most *normative value* — what the game's average pricing
// rule would charge for the cards' stats — under the game's build rules and the
// user's settings. It is the integer programme of analysis/cost_effective_builds.py
// `solve()` (the analysis's "max value" build, and with Single roll its "four corps"
// build), re-implemented here so the app can run it; for Army Corps it adds the
// formation rebates and the recruit-order rule of analysis/ac_builds.py `solve_corps()`
// (state/acOptimiser.ts). The parity test (optimiser.parity.test.ts) checks both
// reproduce the Python optima.
//
// Values are data, not computed here (the app cannot run the pricing models): each
// card's `optimiserValue` comes from analysis/export_optimiser_values.py through
// tools/build_web_data.py, one number per value mode of its army's pool —
//   - "quantity" (all armies): noise-only size harmonisation. Only the model's excess
//                 noise at extreme sizes is removed and each size's systematic discount
//                 is kept, treating it as possible real value rather than model error;
//   - "quality" (ToW / Custom): full size harmonisation. The pricing model overprices
//                 small and very large units; that size bias is removed, so size alone
//                 never looks like a bargain;
//   - "sizeBands" (Army Corps): the AC study's size-band model, which fits the size
//                 curve per class directly (the user chose it over Quality for AC).
// "formationDiscount" (Army Corps only) needs no model: a card is worth its own list
// price, so the optimiser fields the most list value the funds reach once the formation
// rebates are taken off (analysis/ac_builds.py `price`); the size-band value breaks ties.
// Staff generals are valued here: the pool's staff price rule T3 = b·stars^q (1 gold
// without stars) plus the analysis's hand-set command correction — stars are worth
// λ·stars·D more, D = Σ models·(mRef − morale)₊ over the build's units (a big,
// shaky army needs command), ×(1 + σ) for a C-class (cavalry-speed) general, plus a
// priced bonus for a fighting bodyguard. D depends on the build, so each staff option
// carries an auxiliary w ≤ D, w ≤ D_max·z (exact because w is maximised).
//
// Rules, as the app enforces them (rules/rules.ts checkKnownLimits): at most 31 cards
// including the staff slot (the user may cap lower), 10 000 funds (after formation
// rebates for Army Corps), one staff general, the corps' combat-general cap (1 for ToW
// and Custom; 9 − the key's digit for Army Corps), each cap group's cap shared with its
// combat-general versions and at most one combat general per group, foot artillery ≤ 2,
// horse artillery ≤ 1 (2 for a cavalry-only corps), heavy cavalry ≤ 10, counted by
// cappedClassOf. With Single roll, a ToW build draws on at most 4 source corps, staff
// general included — all one roll offers (state/towRoll.ts LEGACY_TOW_MAX_SOURCE_CORPS;
// NTW3AC.ToWFarmycorps).

import type { FactionRoster, OptimiserMode, OptimiserParams, UnitCard } from "../domain/types";
import { isTowFactionKey } from "../domain/tow";
import {
  MAX_BUILD_COST,
  MAX_FOOT_ARTILLERY,
  MAX_HEAVY_CAVALRY,
  MAX_TOTAL_UNIT_CARDS,
  cappedClassOf,
  generalCaps,
  horseArtilleryMax,
} from "../rules/rules";
import {
  type RebateGroup,
  acBuildEarnsItsRebates,
  brigadeRebates,
  inGroup,
  isArmyCorpsKey,
  orderAcCards,
  rebateGroups,
} from "./acOptimiser";
import {
  type BuildState,
  type RosterIndex,
  combatGeneralsAgainstCap,
  expandBuild,
  makeInstanceId,
  priceBuild,
} from "./build";
import { type LpSolver, type SolveOptions, OPTIMISER_TIME_LIMIT_S } from "./solveLp";
import { LEGACY_TOW_MAX_SOURCE_CORPS } from "./towRoll";

export interface OptimiseSettings {
  /** Cards including the staff slot, 2 … 31 (the game's limit). Fewer = less micro. */
  maxCards: number;
  /** Which valuation (see the header); only the army's allowedModes apply. */
  mode: OptimiserMode;
  /** Keep the current build and fill the remaining funds and cards, instead of rebuilding. */
  remainder: boolean;
  /** Only pick cards that pass the roster filters (the caller passes the candidate list). */
  useFilters: boolean;
  /** Let the optimiser leave the staff slot empty when a unit is worth more. */
  allowNoStaff: boolean;
  /** ToW only: at most 4 source corps, so one roll offers the whole build. */
  singleRoll: boolean;
}

export const DEFAULT_OPTIMISE_SETTINGS: OptimiseSettings = {
  maxCards: MAX_TOTAL_UNIT_CARDS,
  mode: "quantity",
  remainder: false,
  useFilters: true,
  allowNoStaff: false,
  singleRoll: true,
};

/** The modes an army's pool offers: ToW / Custom Quantity and Quality; Army Corps Quantity,
 *  Size bands (labelled "Quality" in the app) and "Formation discount only" (the user's
 *  choices, 2026-10-10). */
export function allowedModes(factionKey: string): OptimiserMode[] {
  return isArmyCorpsKey(factionKey) ? ["quantity", "sizeBands", "formationDiscount"] : ["quantity", "quality"];
}

/** `mode` if the army offers it, else Quantity (settings persist across armies in the Builder). */
export function normaliseMode(mode: OptimiserMode, factionKey: string): OptimiserMode {
  return allowedModes(factionKey).includes(mode) ? mode : "quantity";
}

/** Tie-break weight: among equal-value builds prefer the cheaper (as the Python optimiser). */
const COST_TIE_BREAK = 1e-6;
/** "Formation discount only": among builds of equal list value prefer the one the size-band
 *  model rates highest — under 1 gold over a whole build (analysis/ac_builds.py PRICE_TIEBREAK). */
const FACE_TIE_BREAK = 1e-5;
/** Relative MIP gaps for Army Corps, as analysis/ac_builds.py (MIP_GAP, MIP_GAP_FACE). ToW and
 *  Custom keep HiGHS's default 1e-4, as cost_effective_builds.py does. */
const AC_MIP_GAP = 1e-6;
const AC_MIP_GAP_FACE = 1e-8;
/** The rebate safety net (acOptimiser.ts): at most this many cuts and this much time in all. */
export const MAX_REBATE_CUTS = 5;
export const OPTIMISE_TIME_BUDGET_S = 30;

type Column =
  | { name: string; kind: "unit"; card: UnitCard }
  | { name: string; kind: "staff"; card: UnitCard }
  | { name: string; kind: "corps"; corps: string }
  | { name: string; kind: "command"; staff: string }
  | { name: string; kind: "group"; group: RebateGroup }
  | { name: string; kind: "groupCost"; group: RebateGroup };

export interface OptimiseProblem {
  objective: string;
  /** Constraint rows, ` cN: … <= rhs`; cuts are appended at render time. */
  rows: string[];
  bounds: string[];
  integers: string[];
  columns: Column[];
  /** The part of the current build that is kept (empty unless remainder mode). */
  fixed: BuildState;
  settings: OptimiseSettings;
  params: OptimiserParams;
  /** Army Corps: the rebate groups the programme may complete (≺ order); null otherwise. */
  groups: RebateGroup[] | null;
}

export interface OptimiseSummary {
  cards: number;
  /** What the build costs: list prices less the formation rebates it earns (Army Corps). */
  cost: number;
  /** Σ list prices. */
  listCost: number;
  /** Formation rebates earned (0 outside Army Corps). */
  rebate: number;
  /** Brigades and divisions completed that earn a rebate. */
  groupsCompleted: number;
  value: number;
  efficiency: number;
  staffName: string | null;
}

export type OptimiseOutcome =
  | { ok: true; build: BuildState; summary: OptimiseSummary; status: string; cuts: number; fallback?: "noRebates" }
  | { ok: false; error: string };

// --- valuation -----------------------------------------------------------------

/** A card's value in `mode`, or null when it has none (not valued, or not in this pool). */
export function cardValue(card: UnitCard, mode: OptimiserMode): number | null {
  const v = card.optimiserValue;
  if (!v) return null;
  if (mode === "formationDiscount") return card.cost + FACE_TIE_BREAK * (v.sizeBands ?? 0);
  return v[mode] ?? null;
}

/** Morale deficit a card adds to D: models × morale points below mRef. */
export function moraleDeficit(card: UnitCard, params: OptimiserParams): number {
  const models = (card.menRaw ?? 0) / 2;
  const morale = card.stats.morale ?? params.mRef;
  return models * Math.max(0, params.mRef - morale);
}

function staffTerms(card: UnitCard, params: OptimiserParams, mode: OptimiserMode): { constant: number; slope: number } {
  const stars = card.commandStars ?? 0;
  const t3 = stars > 0 ? params.t3B * stars ** params.t3Q : 1;
  // Formation discount only: the general is worth his list price, no command correction.
  if (mode === "formationDiscount") return { constant: card.cost + FACE_TIE_BREAK * t3, slope: 0 };
  const speed = 1 + params.speedBonus * (card.speedCode?.startsWith("C") ? 1 : 0);
  const melee = (card.stats.meleeAttack ?? 0) > params.standardGeneralMelee ? params.meleeBonus : 0;
  return { constant: t3 * speed + melee, slope: (params.lambda[mode] ?? 0) * stars * speed };
}

/** A staff general's value in a build whose units have morale deficit `deficit`. */
export function staffGeneralValue(card: UnitCard, params: OptimiserParams, mode: OptimiserMode, deficit: number): number {
  const { constant, slope } = staffTerms(card, params, mode);
  return constant + slope * deficit;
}

/** Totals of a whole build as the optimiser values it (cards include the staff slot), priced
 *  as the app prices it (priceBuild: Army Corps rebates earned in recruit order). */
export function buildValue(index: RosterIndex, build: BuildState, params: OptimiserParams,
                           mode: OptimiserMode): OptimiseSummary {
  const line = build.instances.map((i) => index.byKey.get(i.unitKey)).filter((c): c is UnitCard => !!c);
  const slot = build.staffSlotUnitKey ? index.byKey.get(build.staffSlotUnitKey) ?? null : null;
  const deficit = line.reduce((d, c) => d + moraleDeficit(c, params), 0);
  let value = line.reduce((v, c) => v + (cardValue(c, mode) ?? 0), 0);
  if (slot) {
    value += slot.generalKind === "staff" ? staffGeneralValue(slot, params, mode, deficit) : cardValue(slot, mode) ?? 0;
  }
  const price = priceBuild(index, build);
  return { cards: line.length + (slot ? 1 : 0), cost: price.finalCost, listCost: price.baseCost,
           rebate: price.baseCost - price.finalCost,
           // Formations that earn something (a one-card group "completes" with a 0 discount).
           groupsCompleted: price.completedGroups.filter((g) => g.discount > 0).length, value,
           efficiency: price.finalCost > 0 ? value / price.finalCost : 0,
           staffName: slot?.generalKind === "staff" ? slot.name : null };
}

// --- LP text -------------------------------------------------------------------

function num(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}

/** `coef name` terms, one per line (LP format allows continuation lines). Every row the
 *  optimiser writes has at least one column; a zero coefficient is kept as `+ 0 name`
 *  so the column still exists. */
function terms(entries: [number, string][]): string {
  return entries.map(([c, n]) => `${c < 0 ? "-" : "+"} ${num(Math.abs(c))} ${n}`).join("\n   ");
}

/** The programme as CPLEX LP text, with any rebate cuts (` kN: …` rows) appended. */
export function renderOptimiseLp(problem: OptimiseProblem, cuts: readonly string[] = []): string {
  return [
    "Maximize",
    ` obj: ${problem.objective}`,
    "Subject To",
    ...problem.rows,
    ...cuts,
    "Bounds",
    ...problem.bounds,
    "Generals",
    ...problem.integers.map((c) => ` ${c}`),
    "End",
    "",
  ].join("\n");
}

// --- problem -------------------------------------------------------------------

/** Build the integer programme, or explain why no build can be made. `candidates` are
 *  the cards the optimiser may add (the filtered list, or the whole roster).
 *  `rebates: false` leaves the Army Corps rebate groups out (the safety net's fallback). */
export function buildOptimiseProblem(
  roster: FactionRoster,
  index: RosterIndex,
  current: BuildState,
  candidates: readonly UnitCard[],
  settings: OptimiseSettings,
  { rebates = true }: { rebates?: boolean } = {},
): { problem: OptimiseProblem } | { error: string } {
  const params = roster.optimiser;
  if (!params) return { error: "No optimiser data for this army." };
  const mode = normaliseMode(settings.mode, roster.factionKey);
  const ac = isArmyCorpsKey(roster.factionKey);
  const maxCards = Math.max(2, Math.min(MAX_TOTAL_UNIT_CARDS, Math.round(settings.maxCards)));
  const fixed: BuildState = settings.remainder ? current : { instances: [], staffSlotUnitKey: null };
  const fixedCards = expandBuild(index, fixed).cards;
  const fixedLine = fixed.instances.map((i) => index.byKey.get(i.unitKey)).filter((c): c is UnitCard => !!c);
  const fixedSlot = fixed.staffSlotUnitKey ? index.byKey.get(fixed.staffSlotUnitKey) ?? null : null;

  // What the kept part costs: its list prices, less (Army Corps) the rebates it earns itself.
  const fixedCost = ac ? priceBuild(index, fixed).finalCost : fixedCards.reduce((s, c) => s + c.cost, 0);
  const funds = MAX_BUILD_COST - fixedCost;
  const slots = maxCards - fixedCards.length;
  if (funds <= 0) return { error: "The current build already uses all 10 000 funds." };
  if (slots <= 0) return { error: `The current build already has ${fixedCards.length} cards (cap ${maxCards}).` };

  // What the kept part already uses of every limit.
  const groupUsed = new Map<string, number>();
  const groupGeneralUsed = new Map<string, number>();
  const classUsed = new Map<string, number>();
  for (const c of fixedCards) {
    groupUsed.set(c.capGroupKey, (groupUsed.get(c.capGroupKey) ?? 0) + 1);
    if (c.generalKind === "combat") groupGeneralUsed.set(c.capGroupKey, (groupGeneralUsed.get(c.capGroupKey) ?? 0) + 1);
    const cls = cappedClassOf(c);
    classUsed.set(cls, (classUsed.get(cls) ?? 0) + 1);
  }
  const combatLeft = generalCaps(roster.factionKey).combat - combatGeneralsAgainstCap(index, fixed);
  const staffInBuild = fixedCards.some((c) => c.generalKind === "staff");
  const fixedDeficit = fixedLine.reduce((d, c) => d + moraleDeficit(c, params), 0);
  // A kept staff general's command still grows with the units added: slope × their deficit.
  const keptSlope = fixedSlot?.generalKind === "staff" ? staffTerms(fixedSlot, params, mode).slope : 0;

  // Unit columns: valued, non-staff candidates with room left in their group.
  const candidateSet = new Set(candidates.map((c) => c.unitKey));
  const columns: Column[] = [];
  const units: { col: string; card: UnitCard; ub: number; value: number }[] = [];
  for (const card of roster.cards) {
    const value = cardValue(card, mode);
    if (!candidateSet.has(card.unitKey) || card.generalKind === "staff" || value === null) continue;
    const groupRoom = card.groupCap > 0 ? card.groupCap - (groupUsed.get(card.capGroupKey) ?? 0) : slots;
    const isCombat = card.generalKind === "combat";
    if (isCombat && (combatLeft <= 0 || (groupGeneralUsed.get(card.capGroupKey) ?? 0) > 0)) continue;
    const ub = Math.min(isCombat ? 1 : slots, groupRoom, slots);
    if (ub <= 0) continue;
    const col = `x${units.length}`;
    units.push({ col, card, ub, value });
    columns.push({ name: col, kind: "unit", card });
  }

  // Staff options: only when the slot is free and no staff general is kept in the line.
  const needStaff = !fixedSlot && !staffInBuild;
  const staffCards = needStaff
    ? roster.cards.filter((c) => c.generalKind === "staff" && candidateSet.has(c.unitKey) && c.cost <= funds)
    : [];
  if (needStaff && !settings.allowNoStaff && staffCards.length === 0) {
    return { error: "No staff general passes the filters (or fits the funds): allow a build without one, or widen the filters." };
  }
  const staff = staffCards.map((card, i) => ({ col: `z${i}`, w: `w${i}`, card, ...staffTerms(card, params, mode) }));
  for (const s of staff) columns.push({ name: s.col, kind: "staff", card: s.card });
  if (!units.length && !staff.length) return { error: "No card passes the filters with room left in the build." };

  // Army Corps: the formation-rebate groups the build may still complete (acOptimiser.ts).
  const ubOf = new Map(units.map((u) => [u.card.unitKey, u.ub]));
  const groups = ac && rebates ? rebateGroups(roster.cards, roster.factionKey, fixedCards, (c) => ubOf.get(c.unitKey) ?? 0) : [];
  const groupCols = groups.map((group, k) => ({ group, g: `g${k}`, q: `q${k}`,
    members: units.filter((u) => inGroup(u.card, group)) }));

  const rows: string[] = [];
  let r = 0;
  const row = (entries: [number, string][], sense: "<=" | ">=" | "=", rhs: number) =>
    rows.push(` c${r++}: ${terms(entries)} ${sense} ${num(rhs)}`);

  row([...units.map((u): [number, string] => [u.card.cost, u.col]), ...staff.map((s): [number, string] => [s.card.cost, s.col]),
       ...groupCols.map((gc): [number, string] => [-gc.group.rebate, gc.g])],
      "<=", funds);
  row([...units.map((u): [number, string] => [1, u.col]), ...staff.map((s): [number, string] => [1, s.col])], "<=", slots);
  if (staff.length) row(staff.map((s): [number, string] => [1, s.col]), settings.allowNoStaff ? "<=" : "=", 1);
  const combat = units.filter((u) => u.card.generalKind === "combat");
  if (combat.length) row(combat.map((u): [number, string] => [1, u.col]), "<=", Math.max(0, combatLeft));

  const byGroup = new Map<string, typeof units>();
  for (const u of units) byGroup.set(u.card.capGroupKey, [...(byGroup.get(u.card.capGroupKey) ?? []), u]);
  for (const [group, members] of byGroup) {
    const cap = members[0].card.groupCap;
    if (cap > 0 && members.length > 1) {
      row(members.map((u): [number, string] => [1, u.col]), "<=", Math.max(0, cap - (groupUsed.get(group) ?? 0)));
    }
    const generals = members.filter((u) => u.card.generalKind === "combat");
    if (generals.length > 1) row(generals.map((u): [number, string] => [1, u.col]), "<=", 1);
  }

  const classCaps: [string, number][] = [
    ["artillery_foot", MAX_FOOT_ARTILLERY],
    ["artillery_horse", horseArtilleryMax(roster.cards, roster.factionKey)],
    ["cavalry_heavy", MAX_HEAVY_CAVALRY],
  ];
  for (const [cls, cap] of classCaps) {
    const members = units.filter((u) => cappedClassOf(u.card) === cls);
    if (members.length) row(members.map((u): [number, string] => [1, u.col]), "<=", Math.max(0, cap - (classUsed.get(cls) ?? 0)));
  }

  // Single roll: binary per source corps, at most 4, every card from an open corps.
  const corpsBounds: string[] = [];
  const corpsCols: string[] = [];
  if (settings.singleRoll && isTowFactionKey(roster.factionKey)) {
    const fixedCorps = new Set(fixedCards.map((c) => c.towSourceCorpsId).filter((v): v is string => !!v));
    if (fixedCorps.size > LEGACY_TOW_MAX_SOURCE_CORPS) {
      return { error: `The current build already draws on ${fixedCorps.size} source corps (one roll offers ${LEGACY_TOW_MAX_SOURCE_CORPS}).` };
    }
    const all = new Set([...fixedCorps, ...units.map((u) => u.card.towSourceCorpsId), ...staff.map((s) => s.card.towSourceCorpsId)]
      .filter((v): v is string => !!v));
    const colOf = new Map<string, string>();
    [...all].sort().forEach((corps, i) => {
      const col = `y${i}`;
      colOf.set(corps, col);
      corpsCols.push(col);
      columns.push({ name: col, kind: "corps", corps });
      corpsBounds.push(` ${fixedCorps.has(corps) ? 1 : 0} <= ${col} <= 1`);
    });
    row(corpsCols.map((c): [number, string] => [1, c]), "<=", LEGACY_TOW_MAX_SOURCE_CORPS);
    for (const u of units) {
      const y = u.card.towSourceCorpsId && colOf.get(u.card.towSourceCorpsId);
      if (y) row([[1, u.col], [-u.ub, y]], "<=", 0);
    }
    for (const s of staff) {
      const y = s.card.towSourceCorpsId && colOf.get(s.card.towSourceCorpsId);
      if (y) row([[1, s.col], [-1, y]], "<=", 0);
    }
  }

  // Command correction: w ≤ D (= fixed + Σ d·x) and w ≤ D_max·z for each staff option.
  const deficits = units.map((u) => moraleDeficit(u.card, params));
  const dMax = fixedDeficit + deficits.map((d, i) => d * units[i].ub).sort((a, b) => b - a).slice(0, slots)
    .reduce((s, d) => s + d, 0);
  const commandBounds: string[] = [];
  for (const s of staff) {
    if (s.slope === 0) continue;
    columns.push({ name: s.w, kind: "command", staff: s.card.unitKey });
    commandBounds.push(` 0 <= ${s.w} <= ${num(dMax)}`);
    row([[1, s.w], ...units.map((u, i): [number, string] => [-deficits[i], u.col])], "<=", fixedDeficit);
    row([[1, s.w], [-dMax, s.col]], "<=", 0);
  }

  // Army Corps rebates (acOptimiser.ts header): completion, a division replaces its brigades,
  // each completed group's list cost q, and affordability at each group's completing card.
  const groupBounds: string[] = [];
  const divisionCol = new Map(groupCols.filter((gc) => gc.group.kind === "division").map((gc) => [gc.group.division, gc.g]));
  for (const gc of groupCols) {
    const { group, g, q, members } = gc;
    const bigM = members.reduce((s, u) => s + u.card.cost * u.ub, 0);
    columns.push({ name: g, kind: "group", group }, { name: q, kind: "groupCost", group });
    groupBounds.push(` 0 <= ${g} <= 1`, ` 0 <= ${q} <= ${num(bigM)}`);
    row([...members.map((u): [number, string] => [1, u.col]), [-(group.required - group.kept), g]], ">=", 0);
    const division = group.kind === "brigade" ? divisionCol.get(group.division) : undefined;
    if (division) row([[1, g], [1, division]], "<=", 1);
    row([[1, q], ...members.map((u): [number, string] => [-u.card.cost, u.col]), [-bigM, g]], ">=", -bigM);
  }
  groupCols.forEach((gc, k) => {
    row([...staff.map((s): [number, string] => [s.card.cost, s.col]),
         ...groupCols.slice(0, k).flatMap((h): [number, string][] => [[1, h.q], [-h.group.rebate, h.g]]),
         [1, gc.q], [-gc.group.credit, gc.g]], "<=", funds);
  });

  const objective: [number, string][] = [
    ...units.map((u, i): [number, string] => [u.value + keptSlope * deficits[i] - COST_TIE_BREAK * u.card.cost, u.col]),
    ...staff.map((s): [number, string] => [s.constant - COST_TIE_BREAK * s.card.cost, s.col]),
    ...staff.filter((s) => s.slope !== 0).map((s): [number, string] => [s.slope, s.w]),
  ];

  return {
    problem: {
      objective: terms(objective),
      rows,
      bounds: [
        ...units.map((u) => ` 0 <= ${u.col} <= ${u.ub}`),
        ...staff.map((s) => ` 0 <= ${s.col} <= 1`),
        ...corpsBounds,
        ...commandBounds,
        ...groupBounds,
      ],
      integers: [...units.map((u) => u.col), ...staff.map((s) => s.col), ...corpsCols, ...groupCols.map((gc) => gc.g)],
      columns,
      fixed,
      settings: { ...settings, mode, maxCards },
      params,
      groups: ac ? groups : null,
    },
  };
}

// --- solution ------------------------------------------------------------------

const ARM_ORDER: Record<string, number> = { artillery: 0, cavalry: 1, infantry: 2 };

/** Turn the solver's column values into a build: the kept part, then the new cards (Army
 *  Corps: completed groups in recruit order first — acOptimiser.ts orderAcCards; then, and
 *  for every other army, artillery, cavalry, infantry, most valuable first), the chosen staff
 *  general in the slot. */
export function decodeOptimiseSolution(problem: OptimiseProblem, primal: Record<string, number>,
                                       index: RosterIndex): { build: BuildState; summary: OptimiseSummary } {
  const mode = problem.settings.mode;
  const picks: UnitCard[] = [];
  const completed: RebateGroup[] = [];
  let staffKey: string | null = null;
  for (const col of problem.columns) {
    const v = Math.round(primal[col.name] ?? 0);
    if (v <= 0) continue;
    if (col.kind === "unit") picks.push(...Array.from({ length: v }, () => col.card));
    else if (col.kind === "staff") staffKey = col.card.unitKey;
    else if (col.kind === "group") completed.push(col.group);
  }
  const armRank = (c: UnitCard) => ARM_ORDER[c.underlyingUnitClass.split("_")[0]] ?? 3;
  const looseOrder = (a: UnitCard, b: UnitCard) => armRank(a) - armRank(b)
    || (cardValue(b, mode) ?? 0) - (cardValue(a, mode) ?? 0)
    || a.unitKey.localeCompare(b.unitKey);
  const ordered = problem.groups
    ? orderAcCards(picks, completed, brigadeRebates(index.roster.cards, index.roster.factionKey), looseOrder)
    : [...picks].sort(looseOrder);
  const build: BuildState = {
    instances: [...problem.fixed.instances, ...ordered.map((card) => ({ id: makeInstanceId(), unitKey: card.unitKey }))],
    staffSlotUnitKey: problem.fixed.staffSlotUnitKey ?? staffKey,
  };
  return { build, summary: buildValue(index, build, problem.params, mode) };
}

/** No-good cut on a set of completed groups: that exact set may not be chosen again. */
function rebateCut(problem: OptimiseProblem, primal: Record<string, number>, k: number): string | null {
  const groupCols = problem.columns.filter((c) => c.kind === "group").map((c) => c.name);
  const on = groupCols.filter((name) => Math.round(primal[name] ?? 0) > 0);
  if (!on.length) return null;
  const entries: [number, string][] = groupCols.map((name) => [on.includes(name) ? 1 : -1, name]);
  return ` k${k}: ${terms(entries)} <= ${num(on.length - 1)}`;
}

const STATUS_MESSAGES: Record<string, string> = {
  Infeasible: "No legal build fits these settings.",
  "Primal infeasible or unbounded": "No legal build fits these settings.",
};

const TIME_LIMIT_NO_BUILD = "The solver hit its time limit before finding a build — try again, "
  + "or narrow the search with Only filtered units.";

/** HiGHS reports "Time limit reached" both with an incumbent and without one; without one it still
 *  returns every column, all at 0 (seen on ntw3_tow_b06_x8_009 at time limits of 0.001 s and 0.05 s).
 *  So a time-limited solution is usable only if some column is nonzero. */
function hasIncumbent(columns: Record<string, number>): boolean {
  return Object.values(columns).some((v) => Math.abs(v) > 1e-6);
}

function usable(status: string, columns: Record<string, number>): boolean {
  return status === "Optimal" || (status === "Time limit reached" && hasIncumbent(columns));
}

function failure(status: string): string {
  if (status === "Time limit reached") return TIME_LIMIT_NO_BUILD;
  return STATUS_MESSAGES[status] ?? `The solver stopped: ${status}.`;
}

/** A decoded build with no cards and no staff general is never a result (10 000 funds always buy
 *  something); it can only come from a solution without an incumbent. */
function emptyBuild(build: BuildState): boolean {
  return build.instances.length === 0 && !build.staffSlotUnitKey;
}

/** Build the programme, solve it with `solver`, and decode the result. For an Army Corps the
 *  build is re-priced as the app prices it; a rebate not earned in recruit order cuts that set
 *  of groups and solves again (at most MAX_REBATE_CUTS times within OPTIMISE_TIME_BUDGET_S),
 *  after which a build without formation rebates is returned and flagged. */
export async function optimiseBuild(
  roster: FactionRoster,
  index: RosterIndex,
  current: BuildState,
  candidates: readonly UnitCard[],
  settings: OptimiseSettings,
  solver: LpSolver,
): Promise<OptimiseOutcome> {
  const made = buildOptimiseProblem(roster, index, current, candidates, settings);
  if ("error" in made) return { ok: false, error: made.error };
  const problem = made.problem;
  if (!problem.groups) {
    const solution = await solver(renderOptimiseLp(problem));
    if (!usable(solution.status, solution.columns)) return { ok: false, error: failure(solution.status) };
    const { build, summary } = decodeOptimiseSolution(problem, solution.columns, index);
    if (emptyBuild(build)) return { ok: false, error: TIME_LIMIT_NO_BUILD };
    return { ok: true, build, summary, status: solution.status, cuts: 0 };
  }

  const started = Date.now();
  const options = (): SolveOptions => ({
    mipRelGap: problem.settings.mode === "formationDiscount" ? AC_MIP_GAP_FACE : AC_MIP_GAP,
    timeLimit: Math.min(OPTIMISER_TIME_LIMIT_S, OPTIMISE_TIME_BUDGET_S - (Date.now() - started) / 1000),
  });
  const cuts: string[] = [];
  for (;;) {
    const solution = await solver(renderOptimiseLp(problem, cuts), options());
    if (!usable(solution.status, solution.columns)) {
      if (!cuts.length) return { ok: false, error: failure(solution.status) };
      break;                                              // every rebate set left was cut: fall back
    }
    const { build, summary } = decodeOptimiseSolution(problem, solution.columns, index);
    if (emptyBuild(build)) return { ok: false, error: TIME_LIMIT_NO_BUILD };
    if (acBuildEarnsItsRebates(index, build)) return { ok: true, build, summary, status: solution.status, cuts: cuts.length };
    const cut = rebateCut(problem, solution.columns, cuts.length);
    if (!cut || cuts.length >= MAX_REBATE_CUTS || (Date.now() - started) / 1000 >= OPTIMISE_TIME_BUDGET_S - 1) break;
    cuts.push(cut);
  }

  // Fallback: the same programme without formation rebates, which can always be recruited.
  const plain = buildOptimiseProblem(roster, index, current, candidates, settings, { rebates: false });
  if ("error" in plain) return { ok: false, error: plain.error };
  const solution = await solver(renderOptimiseLp(plain.problem), { mipRelGap: options().mipRelGap });
  if (!usable(solution.status, solution.columns)) return { ok: false, error: failure(solution.status) };
  const { build, summary } = decodeOptimiseSolution(plain.problem, solution.columns, index);
  if (emptyBuild(build)) return { ok: false, error: TIME_LIMIT_NO_BUILD };
  return { ok: true, build, summary, status: solution.status, cuts: cuts.length, fallback: "noRebates" };
}

/** Where an optimiser run started, or where the builder is now. */
export interface OptimiseRunState {
  build: BuildState;
  factionKey: string;
  token: number;
}

/** A solve takes seconds; apply its result only if nothing moved meanwhile: the same run is still the
 *  latest, the builder still shows the same army, and the build is the very one the run started from
 *  (any edit replaces the BuildState object). Otherwise the result would overwrite the player's edits,
 *  or land on another roster, and "Undo optimise" would restore a stale build. */
export function optimiseResultStillApplies(start: OptimiseRunState, now: OptimiseRunState & { mounted: boolean }): boolean {
  return now.mounted && now.token === start.token && now.factionKey === start.factionKey && now.build === start.build;
}
