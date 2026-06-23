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
}

export interface FactionRoster {
  schemaVersion: number;
  factionKey: string;
  armyCorpsName: string;
  cards: UnitCard[];
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
  custom: "Custom Armies",
  shared: "Theatres of War",
};
