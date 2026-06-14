// Validation + normalization layer.
//
// Fetches the generated browser JSON and converts it into the versioned domain
// models. The raw JSON shape is treated as untrusted: unknown fields are
// ignored and missing fields fall back to safe defaults, so a slightly newer or
// older generated dataset never crashes the UI.

import { dataUrl } from "./assets";
import {
  type CorpsIndex,
  type FactionRoster,
  type GeneralKind,
  type UnitAbilities,
  type UnitCard,
  type UnitStats,
} from "../domain/types";

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
    placementSource: strOrNull(raw.placementSource),
    icon: strOrNull(raw.icon),
    commandStarStrip: strOrNull(raw.commandStarStrip),
    guerrillaBadge: strOrNull(raw.guerrillaBadge),
    stats: normalizeStats(raw.stats as Record<string, unknown>),
    abilities: normalizeAbilities(raw.abilities as Record<string, unknown>),
  };
}

export async function loadCorpsIndex(): Promise<CorpsIndex> {
  const res = await fetch(dataUrl("corps-index.json"));
  if (!res.ok) throw new Error(`Failed to load corps index (${res.status})`);
  return (await res.json()) as CorpsIndex;
}

export async function loadFaction(factionKey: string): Promise<FactionRoster> {
  const res = await fetch(dataUrl(`factions/${factionKey}.json`));
  if (!res.ok) throw new Error(`Failed to load roster for ${factionKey} (${res.status})`);
  const raw = (await res.json()) as Record<string, unknown>;
  const cards = Array.isArray(raw.cards)
    ? (raw.cards as Record<string, unknown>[])
        .map(normalizeCard)
        .filter((c): c is UnitCard => c !== null)
    : [];
  return {
    schemaVersion: num(raw.schemaVersion) ?? 0,
    factionKey: str(raw.factionKey) || factionKey,
    armyCorpsName: str(raw.armyCorpsName),
    cards,
  };
}
