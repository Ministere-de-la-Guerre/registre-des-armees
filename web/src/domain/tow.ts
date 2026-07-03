import type { UnitCard } from "./types";

const TOW_RE = /_tow_(\d+)(?:_|$)/;

export function isTowFactionKey(factionKey: string): boolean {
  return factionKey.includes("_tow_");
}

export function towIdOf(unitKey: string): string | null {
  return TOW_RE.exec(unitKey)?.[1] ?? null;
}

export function towSourceCorpsIdOf(unitKey: string): string | null {
  if (!towIdOf(unitKey)) return null;
  return unitKey.split("_")[3] || null;
}

function towClassOf(card: Pick<UnitCard, "unitClass" | "underlyingUnitClass" | "generalKind">): string {
  return card.generalKind === "combat" ? card.underlyingUnitClass : card.unitClass;
}

export function towBrigadeIndexOf(cardOrClass: Pick<UnitCard, "unitClass" | "underlyingUnitClass" | "generalKind"> | string): number {
  if (typeof cardOrClass !== "string" && cardOrClass.generalKind === "staff") return 1;
  const unitClass = typeof cardOrClass === "string" ? cardOrClass : towClassOf(cardOrClass);
  switch (unitClass) {
    case "cavalry_heavy": return 2;
    case "cavalry_standard": return 3;
    case "cavalry_light": return 4;
    case "cavalry_lancers": return 5;
    case "cavalry_missile": return 6;
    case "infantry_grenadiers": return 7;
    case "infantry_light": return 8;
    case "infantry_skirmishers": return 9;
    case "infantry_line": return 10;
    case "infantry_militia":
    case "infantry_irregulars":
      return 11;
    case "artillery_foot": return 12;
    case "artillery_horse": return 13;
    case "artillery_fixed": return 14;
    default: return 99;
  }
}

// Display labels for the fixed TOW brigade sequence (see towBrigadeIndexOf).
// Used by the combined-corps view, where each brigade type becomes its own row.
const TOW_BRIGADE_LABELS: Record<number, string> = {
  1: "Command",
  2: "Heavy Cavalry",
  3: "Cavalry",
  4: "Light Cavalry",
  5: "Lancers",
  6: "Missile Cavalry",
  7: "Grenadiers",
  8: "Light Infantry",
  9: "Skirmishers",
  10: "Line Infantry",
  11: "Militia & Irregulars",
  12: "Foot Artillery",
  13: "Horse Artillery",
  14: "Fixed Artillery",
  99: "Other",
};

export function towBrigadeLabel(brigade: number): string {
  return TOW_BRIGADE_LABELS[brigade] ?? `Brigade ${brigade}`;
}

export function compareTowSourceCorpsIds(a: string, b: string): number {
  const na = Number.parseInt(a, 10);
  const nb = Number.parseInt(b, 10);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}
