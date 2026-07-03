import type { FactionRoster, UnitCard } from "../domain/types";

/** Build a fully-formed UnitCard for tests; override any field via `partial`. */
export function makeUnit(partial: Partial<UnitCard> = {}): UnitCard {
  const unitKey = partial.unitKey ?? "u";
  const base: UnitCard = {
    unitKey,
    factionKey: "ntw3_ac_test_x5_001",
    armyCorpsName: "",
    name: "Test Unit",
    unitClass: "infantry_line",
    menRaw: 160,
    menDisplay: 80,
    finalMen: 80,
    speedCode: "L3",
    placement: { division: 1, brigade: 1 },
    towSourceCorpsId: null,
    divisionBrigadeCode: "ACDV1B1",
    cost: 500,
    cap: 1,
    groupCap: 1,
    range: 100,
    commandStars: null,
    isGeneral: false,
    isCommanderVariant: false,
    generalKind: null,
    capGroupKey: unitKey,
    baseUnitKey: unitKey,
    underlyingUnitClass: "infantry_line",
    rosterIndex: 0,
    placementSource: "localisation_tag",
    icon: null,
    commandStarStrip: null,
    guerrillaBadge: null,
    stats: { accuracy: 50, reloadSkill: 40, morale: 8, meleeAttack: 10, meleeDefense: 12, chargeBonus: 6 },
    abilities: {
      canFormSquare: true,
      hasStamina: false,
      isShockResistant: false,
      canInspire: false,
      hasGuerrillaDeployment: false,
      canPlaceStakes: false,
      canPlaceMines: false,
      scaresEnemies: false,
      canBuildBarricades: false,
    },
  };
  return { ...base, ...partial, stats: { ...base.stats, ...partial.stats }, abilities: { ...base.abilities, ...partial.abilities } };
}

export function makeRoster(cards: UnitCard[], factionKey = "ntw3_ac_test_x5_001"): FactionRoster {
  return { schemaVersion: 1, factionKey, armyCorpsName: "Test Corps", cards };
}
