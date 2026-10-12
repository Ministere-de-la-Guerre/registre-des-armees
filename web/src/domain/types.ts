// Versioned TypeScript domain models.
//
// These are the *in-app* shapes the UI and rules engine work with. They are
// produced by the normalization layer (src/data/loadFaction.ts) from the raw
// generated JSON, and are intentionally independent from the on-disk JSON shape
// so the import format can evolve without rewriting the UI.

export const DOMAIN_SCHEMA_VERSION = 1;

export type GeneralKind = "staff" | "combat" | null;

export interface Placement {
  division: number;
  brigade: number;
}

export interface UnitStats {
  accuracy: number | null;
  reloadSkill: number | null;
  /** Rounds carried. 0 for melee units and generals without a gun. */
  ammo: number | null;
  /** The unit's firearm (musket / rifle / carbine) name; null when it has none
   *  (melee cavalry, unarmed generals, artillery). */
  firearm: string | null;
  morale: number | null;
  meleeAttack: number | null;
  meleeDefense: number | null;
  chargeBonus: number | null;
}

export interface UnitAbilities {
  canFormSquare: boolean;
  hasStamina: boolean;
  isShockResistant: boolean;
  canInspire: boolean;
  hasGuerrillaDeployment: boolean;
  canPlaceStakes: boolean;
  canPlaceMines: boolean;
  scaresEnemies: boolean;
  canBuildBarricades: boolean;
}

/** The boolean ability fields, for generic filter construction. */
export const ABILITY_KEYS = [
  "canFormSquare",
  "hasStamina",
  "isShockResistant",
  "canInspire",
  "hasGuerrillaDeployment",
  "canPlaceStakes",
  "canPlaceMines",
  "scaresEnemies",
  "canBuildBarricades",
] as const satisfies readonly (keyof UnitAbilities)[];

export const ABILITY_LABELS: Record<keyof UnitAbilities, string> = {
  canFormSquare: "Can form square",
  hasStamina: "Stamina",
  isShockResistant: "Shock resistant",
  canInspire: "Inspires",
  hasGuerrillaDeployment: "Guerrilla deployment",
  canPlaceStakes: "Stakes",
  canPlaceMines: "Mines",
  scaresEnemies: "Scares enemies",
  canBuildBarricades: "Barricades",
};

export interface UnitCard {
  unitKey: string;
  factionKey: string;
  armyCorpsName: string;
  name: string;
  unitClass: string;
  menRaw: number | null;
  menDisplay: number | null;
  /** Final in-game men count (staff generals always 16). */
  finalMen: number | null;
  speedCode: string | null;
  placement: Placement | null;
  /** TOW source army-corps id parsed from `_tow_` unit keys; null for AC/base rosters. */
  towSourceCorpsId: string | null;
  divisionBrigadeCode: string | null;
  cost: number;
  cap: number;
  /** Shared cap-group cap = the underlying (base) unit's cap. */
  groupCap: number;
  range: number | null;
  commandStars: number | null;
  isGeneral: boolean;
  isCommanderVariant: boolean;
  /** Precomputed staff/combat classification for display + visibility switch. */
  generalKind: GeneralKind;
  /** Underlying unit key used for shared cap accounting. */
  capGroupKey: string;
  /** Base unit key (commander suffix removed); equals capGroupKey. */
  baseUnitKey: string;
  /** Combat generals report their base unit's class for filters + ordering. */
  underlyingUnitClass: string;
  /** Guns in the battery (artillery cards and the combat generals leading them);
   *  null for everything else. Taken from the game's stats table, not recomputed. */
  guns: number | null;
  /** Game weapon key of those guns (e.g. `cannon_6_pounder_France`); null when `guns` is. */
  gunType: string | null;
  /** 0-based position in the source roster (CSV) order, before the display sort.
   *  The in-game combat-general rotation shuffles the general pool in this order,
   *  so the rotation predictor must sort the pool by this to reproduce the game. */
  rosterIndex: number;
  /** How the division/brigade placement was decided (provenance). */
  placementSource: string | null;
  icon: string | null;
  commandStarStrip: string | null;
  guerrillaBadge: string | null;
  stats: UnitStats;
  abilities: UnitAbilities;
  /** The in-app optimiser's normative value of this card in gold, per value mode (units and
   *  combat generals; absent for staff generals, which it values from their stars, and for
   *  armies without optimiser data). From analysis/export_optimiser_values.py via
   *  tools/build_web_data.py. */
  optimiserValue?: OptimiserValue | null;
}

/** A card's (or a whole best build's) normative value in gold at corps 8, per value mode of the
 *  analysis valuation. Each pool carries only its own modes:
 *  - ToW / Custom: `quantity` = noise-only size harmonisation (the size discount kept) and
 *    `quality` = full harmonisation (size bias removed);
 *  - Army Corps: `quantity` and `sizeBands` = the AC study's size-band model (the user replaced
 *    Quality with it for AC). */
export interface OptimiserValue {
  quantity: number;
  quality?: number;
  sizeBands?: number;
}

/** A mode with a value per card. */
export type ValueMode = keyof OptimiserValue;

/** The optimiser's modes: a value mode, or (Army Corps only) "formationDiscount" — a card is
 *  worth its own list price, so the optimiser fields the most list value the funds reach once
 *  the brigade and division discounts are taken off (analysis/ac_builds.py `price`). */
export type OptimiserMode = ValueMode | "formationDiscount";

/** An army's best-build value per optimiser mode, for ranking teams. Army Corps also carry
 *  `formationDiscount`: the team score of "Formation discount only", face / 10 000 × corps number
 *  (the build's list value per 10 000 funds, times N to cancel the 8/N rating factor in list
 *  prices, so armies compare; analysis/team_search.py). */
export interface ArmyValue extends OptimiserValue {
  formationDiscount?: number;
}

/** Parameters the optimiser needs to value staff generals (data/generated/ntw3_optimiser_params.json,
 *  the faction's pool block): the staff-general price rule T3 = b·stars^q (1 gold without stars;
 *  Army Corps use their own refit), and the hand-set command correction — λ·stars·D per value
 *  mode of the pool, D = Σ models·(mRef − morale)₊, a σ nudge for C-class generals and a priced
 *  bonus for a fighting bodyguard. */
export interface OptimiserParams {
  t3B: number;
  t3Q: number;
  mRef: number;
  lambda: OptimiserValue;
  speedBonus: number;
  meleeBonus: number;
  standardGeneralMelee: number;
}

export interface FactionRoster {
  schemaVersion: number;
  factionKey: string;
  armyCorpsName: string;
  cards: UnitCard[];
  /** Present only for armies the optimiser covers (ToW and Custom from schema 2, Army Corps
   *  from schema 3 — not the work-in-progress German Campaign 1813). */
  optimiser?: OptimiserParams | null;
}

// --- Corps index (theatre-grouped selection screen) --------------------------
export interface CorpsEntry {
  factionKey: string;
  name: string;
  displayYear: string | number;
  displayRating: string | number;
  order: number;
  flag: string | null;
  postSelectionFlag: string | null;
  isArmyCorps: boolean;
  cardCount: number;
  /** The army's best-build value per value mode at the default optimiser settings (31 cards, a
   *  staff general, one roll for ToW) — what the planner's team suggestion ranks with when
   *  nothing constrains the builds (analysis/team_search.py army_values.csv, schema ≥ 3;
   *  `formationDiscount` from schema 4). */
  bestBuildValue?: ArmyValue | null;
}

export interface CorpsTheatre {
  theatre: string;
  corps: CorpsEntry[];
}

export interface CorpsSide {
  side: string;
  theatres: CorpsTheatre[];
}

export interface CorpsIndex {
  schemaVersion: number;
  sides: CorpsSide[];
}

export const SIDE_LABELS: Record<string, string> = {
  empire: "Empire",
  coalition: "Coalition",
  tow_french_imperial: "Imperial (TOW)",
  tow_coalition: "Coalition (TOW)",
  custom: "Custom Armies",
};
