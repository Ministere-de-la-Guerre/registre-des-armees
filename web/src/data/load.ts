// Validation + normalization layer.
//
// Fetches the generated browser JSON and converts it into the versioned domain
// models. The raw JSON shape is treated as untrusted: unknown fields are
// ignored and missing fields fall back to safe defaults, so a slightly newer or
// older generated dataset never crashes the UI.

import { dataUrl } from "./assets";
import {
  type CorpsEntry,
  type CorpsIndex,
  type CorpsSide,
  type CorpsTheatre,
  type FactionRoster,
  type GeneralKind,
  type UnitAbilities,
  type UnitCard,
  type UnitStats,
} from "../domain/types";
import {
  compareTowSourceCorpsIds,
  isTowFactionKey,
  towBrigadeIndexOf,
  towSourceCorpsIdOf,
} from "../domain/tow";

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function bool(v: unknown): boolean {
  return v === true;
}

function normalizeStats(raw: Record<string, unknown> | undefined): UnitStats {
  const s = raw ?? {};
  return {
    accuracy: num(s.accuracy),
    reloadSkill: num(s.reloadSkill),
    ammo: num(s.ammo),
    firearm: strOrNull(s.firearm),
    morale: num(s.morale),
    meleeAttack: num(s.meleeAttack),
    meleeDefense: num(s.meleeDefense),
    chargeBonus: num(s.chargeBonus),
  };
}

function normalizeAbilities(raw: Record<string, unknown> | undefined): UnitAbilities {
  const a = raw ?? {};
  return {
    canFormSquare: bool(a.canFormSquare),
    hasStamina: bool(a.hasStamina),
    isShockResistant: bool(a.isShockResistant),
    canInspire: bool(a.canInspire),
    hasGuerrillaDeployment: bool(a.hasGuerrillaDeployment),
    canPlaceStakes: bool(a.canPlaceStakes),
    canPlaceMines: bool(a.canPlaceMines),
    scaresEnemies: bool(a.scaresEnemies),
    canBuildBarricades: bool(a.canBuildBarricades),
  };
}

function normalizeCard(raw: Record<string, unknown>): UnitCard | null {
  const unitKey = str(raw.unitKey);
  const factionKey = str(raw.factionKey);
  if (!unitKey || !factionKey) return null;
  const cost = num(raw.cost);
  const cap = num(raw.cap);
  if (cost === null || cap === null) return null;
  const groupCap = num(raw.groupCap);

  const division = num(raw.division);
  const brigade = num(raw.brigade);

  return {
    unitKey,
    factionKey,
    armyCorpsName: str(raw.armyCorpsName),
    name: str(raw.name),
    unitClass: str(raw.unitClass),
    menRaw: num(raw.menRaw),
    menDisplay: num(raw.menDisplay),
    finalMen: num(raw.finalMen),
    speedCode: strOrNull(raw.speedCode),
    placement: division !== null && brigade !== null ? { division, brigade } : null,
    towSourceCorpsId: towSourceCorpsIdOf(unitKey),
    divisionBrigadeCode: strOrNull(raw.divisionBrigadeCode),
    cost,
    cap,
    groupCap: groupCap ?? cap,
    range: num(raw.range),
    commandStars: num(raw.commandStars),
    isGeneral: bool(raw.isGeneral),
    isCommanderVariant: bool(raw.isCommanderVariant),
    generalKind: (raw.generalKind as GeneralKind) ?? null,
    capGroupKey: str(raw.capGroupKey) || unitKey,
    baseUnitKey: str(raw.baseUnitKey) || str(raw.capGroupKey) || unitKey,
    underlyingUnitClass: str(raw.underlyingUnitClass) || str(raw.unitClass),
    guns: num(raw.guns),
    gunType: strOrNull(raw.gunType),
    rosterIndex: num(raw.rosterIndex) ?? 0,
    placementSource: strOrNull(raw.placementSource),
    icon: strOrNull(raw.icon),
    commandStarStrip: strOrNull(raw.commandStarStrip),
    guerrillaBadge: strOrNull(raw.guerrillaBadge),
    stats: normalizeStats(raw.stats as Record<string, unknown>),
    abilities: normalizeAbilities(raw.abilities as Record<string, unknown>),
  };
}

function withTowPlacements(cards: UnitCard[], factionKey: string): UnitCard[] {
  if (!isTowFactionKey(factionKey)) return cards;
  const sourceIds = [...new Set(cards.map((c) => c.towSourceCorpsId).filter((v): v is string => v !== null))]
    .sort(compareTowSourceCorpsIds);
  const divisions = new Map(sourceIds.map((id, index) => [id, index + 1]));
  return cards.map((card) => {
    if (card.towSourceCorpsId === null) return card;
    const division = divisions.get(card.towSourceCorpsId);
    if (division === undefined) return card;
    return {
      ...card,
      placement: { division, brigade: towBrigadeIndexOf(card) },
      placementSource: "tow_source_corps",
    };
  });
}

function strOrNum(v: unknown): string | number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return typeof v === "string" ? v : "";
}

function normalizeCorpsEntry(raw: unknown): CorpsEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const factionKey = str(r.factionKey);
  if (!factionKey) return null;
  return {
    factionKey,
    name: str(r.name),
    displayYear: strOrNum(r.displayYear),
    displayRating: strOrNum(r.displayRating),
    order: num(r.order) ?? 0,
    flag: strOrNull(r.flag),
    postSelectionFlag: strOrNull(r.postSelectionFlag),
    isArmyCorps: bool(r.isArmyCorps),
    cardCount: num(r.cardCount) ?? 0,
  };
}

/** Normalize the corps index like normalizeCard does for units: drop malformed
 *  records instead of blind-casting, so one bad field in corps-index.json can't
 *  throw inside a render-phase useMemo and blank the whole app (white screen). */
function normalizeCorpsIndex(raw: unknown): CorpsIndex {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const sidesRaw = Array.isArray(r.sides) ? r.sides : [];
  const sides: CorpsSide[] = sidesRaw.map((s): CorpsSide => {
    const so = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    const theatresRaw = Array.isArray(so.theatres) ? so.theatres : [];
    const theatres: CorpsTheatre[] = theatresRaw.map((t): CorpsTheatre => {
      const to = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
      const corpsRaw = Array.isArray(to.corps) ? to.corps : [];
      const corps = corpsRaw
        .map(normalizeCorpsEntry)
        .filter((c): c is CorpsEntry => c !== null);
      return { theatre: str(to.theatre), corps };
    });
    return { side: str(so.side), theatres };
  });
  return { schemaVersion: num(r.schemaVersion) ?? 0, sides };
}

export async function loadCorpsIndex(): Promise<CorpsIndex> {
  const res = await fetch(dataUrl("corps-index.json"));
  if (!res.ok) throw new Error(`Failed to load corps index (${res.status})`);
  return normalizeCorpsIndex(await res.json());
}

export async function loadFaction(factionKey: string): Promise<FactionRoster> {
  const res = await fetch(dataUrl(`factions/${factionKey}.json`));
  if (!res.ok) throw new Error(`Failed to load roster for ${factionKey} (${res.status})`);
  const raw = (await res.json()) as Record<string, unknown>;
  const faction = str(raw.factionKey) || factionKey;
  const cards = Array.isArray(raw.cards)
    ? (raw.cards as Record<string, unknown>[])
        .map(normalizeCard)
        .filter((c): c is UnitCard => c !== null)
    : [];
  return {
    schemaVersion: num(raw.schemaVersion) ?? 0,
    factionKey: faction,
    armyCorpsName: str(raw.armyCorpsName),
    cards: withTowPlacements(cards, faction),
  };
}
