// Team statistics for the Ordre de Bataille planner: per-army summaries plus the
// whole-team totals and breakdowns. Pure; the UI feeds it the armies whose roster
// has loaded (null for an empty or not-yet-loaded slot) and renders the result.

import { type GunArm, GUN_ARMS, gunArm, gunTypeLabel, gunTypeSortKey } from "../domain/gunTypes";
import { isTowFactionKey } from "../domain/tow";
import type { UnitCard } from "../domain/types";
import { MAX_BUILD_COST } from "../rules/rules";
import { type BuildState, type BuildSummary, type RosterIndex, combatCapOf, summarize } from "./build";
import { LEGACY_TOW_MAX_SOURCE_CORPS, towCorpsCeiling } from "./towRoll";

export interface PlanArmyInput {
  index: RosterIndex;
  build: BuildState;
}

export const CAVALRY_KEYS = ["light", "line", "lancers", "heavy", "missile"] as const;
export const INFANTRY_KEYS = ["line", "light", "grenadiers", "skirmishers", "militia", "irregulars"] as const;
export type CavalryKey = (typeof CAVALRY_KEYS)[number];
export type InfantryKey = (typeof INFANTRY_KEYS)[number];

export const CAVALRY_LABELS: Record<CavalryKey, string> = {
  light: "Light",
  line: "Line",
  lancers: "Lancers",
  heavy: "Heavy",
  missile: "Missile",
};
export const INFANTRY_LABELS: Record<InfantryKey, string> = {
  line: "Line",
  light: "Light",
  grenadiers: "Grenadiers",
  skirmishers: "Skirmishers",
  militia: "Militia",
  irregulars: "Irregulars",
};

export interface ArmyStats {
  summary: BuildSummary;
  combatGens: number;
  combatCap: number;
  /** ToW builds only: distinct source corps against the roll limit; null otherwise. */
  towCorps: { count: number; max: number; over: boolean } | null;
}

/** Cards per speed tag (`UnitCard.speedCode`, e.g. "C3"), cards without one skipped. */
export type SpeedMix = Record<string, number>;

/** Cards and men of one class across the team; `byArmy[i]` = cards in slot i. */
export interface ClassTally {
  cards: number;
  men: number;
  byArmy: number[];
  bySpeed: SpeedMix;
}

export interface ClassBreakdown<K extends string> {
  byClass: Record<K, ClassTally>;
  totalCards: number;
  totalMen: number;
}

export interface GunTally {
  guns: number;
  batteries: number;
  byArmy: number[];
  /** Batteries (not guns) per speed tag. */
  bySpeed: SpeedMix;
}

export interface GunTypeRow extends GunTally {
  arm: GunArm;
  label: string;
}

export const ABILITY_STAT_KEYS = ["stakes", "mines", "guerrilla", "stamina", "shockResistant"] as const;
export type AbilityStatKey = (typeof ABILITY_STAT_KEYS)[number];

export const ABILITY_STAT_LABELS: Record<AbilityStatKey, string> = {
  stakes: "Stakes",
  mines: "Mines",
  guerrilla: "Guerrilla deployment",
  stamina: "Stamina",
  shockResistant: "Shock resistant",
};

export interface ArmShare {
  cards: number;
  men: number;
  /** Listed card prices (`UnitCard.cost`), before any brigade/division discount. */
  gold: number;
}

export interface PlanWarning {
  slotIndex: number;
  message: string;
}

export interface PlanStats {
  /** Same length as the input; null where the slot is empty / not loaded. */
  perArmy: (ArmyStats | null)[];
  /** Number of armies actually present (the budget scales with it). */
  armies: number;
  men: number;
  cards: number;
  cost: number;
  budget: number;
  combatGens: number;
  squares: number;
  /** Sum of the per-army Squares denominators (infantry other than skirmishers). */
  infantryForSquares: number;
  cavalry: ClassBreakdown<CavalryKey>;
  infantry: ClassBreakdown<InfantryKey>;
  guns: {
    total: number;
    byArm: Record<GunArm, GunTally>;
    /** Sorted arm (foot, horse, fixed), then calibre. */
    byType: GunTypeRow[];
  };
  abilities: Record<AbilityStatKey, { cards: number; byArmy: number[] }>;
  share: { infantry: ArmShare; cavalry: ArmShare; artillery: ArmShare; staff: ArmShare };
  warnings: PlanWarning[];
}

/** A combat general counts as the unit he leads; everything else as itself. */
function effectiveClass(c: UnitCard): string {
  return c.isGeneral && c.generalKind === "combat" ? c.underlyingUnitClass || c.unitClass : c.unitClass;
}

function emptyTally(slots: number): ClassTally {
  return { cards: 0, men: 0, byArmy: new Array<number>(slots).fill(0), bySpeed: {} };
}

function emptyBreakdown<K extends string>(keys: readonly K[], slots: number): ClassBreakdown<K> {
  const byClass = {} as Record<K, ClassTally>;
  for (const k of keys) byClass[k] = emptyTally(slots);
  return { byClass, totalCards: 0, totalMen: 0 };
}

function cavalryKey(cls: string): CavalryKey | null {
  if (cls === "cavalry_standard") return "line";
  const key = cls.replace(/^cavalry_/, "");
  return cls.startsWith("cavalry_") && (CAVALRY_KEYS as readonly string[]).includes(key) ? (key as CavalryKey) : null;
}

function infantryKey(cls: string): InfantryKey | null {
  const key = cls.replace(/^infantry_/, "");
  return cls.startsWith("infantry_") && (INFANTRY_KEYS as readonly string[]).includes(key) ? (key as InfantryKey) : null;
}

/** Count one card under its own speed tag (a combat general keeps his own, not the unit's). */
function bumpSpeed(mix: SpeedMix, card: UnitCard): void {
  if (card.speedCode) mix[card.speedCode] = (mix[card.speedCode] ?? 0) + 1;
}

function addTo<K extends string>(b: ClassBreakdown<K>, key: K, slot: number, card: UnitCard, men: number): void {
  const t = b.byClass[key];
  bumpSpeed(t.bySpeed, card);
  t.cards += 1;
  t.men += men;
  t.byArmy[slot] += 1;
  b.totalCards += 1;
  b.totalMen += men;
}

export function planStats(armies: (PlanArmyInput | null)[]): PlanStats {
  const n = armies.length;
  const zeros = () => new Array<number>(n).fill(0);
  const cavalry = emptyBreakdown(CAVALRY_KEYS, n);
  const infantry = emptyBreakdown(INFANTRY_KEYS, n);
  const gunsByArm = Object.fromEntries(GUN_ARMS.map((a) => [a, { guns: 0, batteries: 0, byArmy: zeros(), bySpeed: {} }])) as Record<GunArm, GunTally>;
  const gunRows = new Map<string, GunTypeRow & { sortKey: [number, string] }>();
  const abilities = Object.fromEntries(ABILITY_STAT_KEYS.map((k) => [k, { cards: 0, byArmy: zeros() }])) as PlanStats["abilities"];
  const share = {
    infantry: { cards: 0, men: 0, gold: 0 },
    cavalry: { cards: 0, men: 0, gold: 0 },
    artillery: { cards: 0, men: 0, gold: 0 },
    staff: { cards: 0, men: 0, gold: 0 },
  };
  const perArmy: (ArmyStats | null)[] = [];
  const warnings: PlanWarning[] = [];
  const totals = { armies: 0, men: 0, cards: 0, cost: 0, combatGens: 0, squares: 0, infantryForSquares: 0, gunTotal: 0 };

  armies.forEach((army, slot) => {
    if (!army) {
      perArmy.push(null);
      return;
    }
    const summary = summarize(army.index, army.build);
    const combatGens = summary.limits.counts.combat_generals_against_cap ?? 0;
    const faction = army.index.roster.factionKey;
    const ceiling = isTowFactionKey(faction) ? towCorpsCeiling(army.build, army.index) : null;
    perArmy.push({
      summary,
      combatGens,
      combatCap: combatCapOf(faction),
      towCorps: ceiling && { count: ceiling.count, max: LEGACY_TOW_MAX_SOURCE_CORPS, over: ceiling.over },
    });

    totals.armies += 1;
    totals.men += summary.totalMen;
    totals.cards += summary.totalCards;
    totals.cost += summary.price.finalCost;
    totals.combatGens += combatGens;
    totals.squares += summary.totalSquares;
    totals.infantryForSquares += summary.totalInfantry;

    // The commander is part of expanded.cards, so he is counted like any card.
    for (const c of summary.expanded.cards) {
      const men = c.finalMen ?? 0;
      const cls = effectiveClass(c);
      const cav = cavalryKey(cls);
      const inf = infantryKey(cls);
      if (cav) {
        addTo(cavalry, cav, slot, c, men);
        share.cavalry.cards += 1;
        share.cavalry.men += men;
        share.cavalry.gold += c.cost;
      } else if (inf) {
        addTo(infantry, inf, slot, c, men);
        share.infantry.cards += 1;
        share.infantry.men += men;
        share.infantry.gold += c.cost;
      } else if (cls.startsWith("artillery")) {
        share.artillery.cards += 1;
        share.artillery.men += men;
        share.artillery.gold += c.cost;
      } else if (cls === "general") {
        share.staff.cards += 1;
        share.staff.men += men;
        share.staff.gold += c.cost;
      }

      const arm = gunArm(c);
      if (arm && c.guns && c.guns > 0) {
        const tally = gunsByArm[arm];
        tally.guns += c.guns;
        tally.batteries += 1;
        bumpSpeed(tally.bySpeed, c);
        tally.byArmy[slot] += c.guns;
        totals.gunTotal += c.guns;
        const label = c.gunType ? gunTypeLabel(c.gunType) : "Unknown guns";
        const rowKey = `${arm}|${label}`;
        let row = gunRows.get(rowKey);
        if (!row) {
          row = { arm, label, guns: 0, batteries: 0, byArmy: zeros(), bySpeed: {}, sortKey: c.gunType ? gunTypeSortKey(c.gunType) : [Number.MAX_SAFE_INTEGER, label] };
          gunRows.set(rowKey, row);
        }
        row.guns += c.guns;
        row.batteries += 1;
        bumpSpeed(row.bySpeed, c);
        row.byArmy[slot] += c.guns;
      }

      const a = c.abilities;
      const flags: Record<AbilityStatKey, boolean> = {
        stakes: a.canPlaceStakes,
        mines: a.canPlaceMines,
        guerrilla: a.hasGuerrillaDeployment,
        stamina: a.hasStamina,
        shockResistant: a.isShockResistant,
      };
      for (const k of ABILITY_STAT_KEYS) {
        if (!flags[k]) continue;
        abilities[k].cards += 1;
        abilities[k].byArmy[slot] += 1;
      }
    }

    const over = summary.price.finalCost - MAX_BUILD_COST;
    if (over > 0) warnings.push({ slotIndex: slot, message: `${over.toLocaleString()} over budget` });
    for (const message of summary.violationMessages) warnings.push({ slotIndex: slot, message });
  });

  const armOrder = (a: GunArm) => GUN_ARMS.indexOf(a);
  const byType = [...gunRows.values()]
    .sort((x, y) => armOrder(x.arm) - armOrder(y.arm) || x.sortKey[0] - y.sortKey[0] || x.sortKey[1].localeCompare(y.sortKey[1]))
    .map(({ sortKey: _sortKey, ...row }) => row);

  return {
    perArmy,
    armies: totals.armies,
    men: totals.men,
    cards: totals.cards,
    cost: totals.cost,
    budget: totals.armies * MAX_BUILD_COST,
    combatGens: totals.combatGens,
    squares: totals.squares,
    infantryForSquares: totals.infantryForSquares,
    cavalry,
    infantry,
    guns: { total: totals.gunTotal, byArm: gunsByArm, byType },
    abilities,
    share,
    warnings,
  };
}
