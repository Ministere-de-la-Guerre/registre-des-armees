// Human-readable labels for unit classes, shared across components.

export const CLASS_LABELS: Record<string, string> = {
  infantry_line: "Line Infantry",
  infantry_light: "Light Infantry",
  infantry_grenadiers: "Grenadiers",
  infantry_skirmishers: "Skirmishers",
  infantry_militia: "Militia",
  infantry_irregulars: "Irregulars",
  cavalry_heavy: "Heavy Cavalry",
  cavalry_light: "Light Cavalry",
  cavalry_lancers: "Lancers",
  cavalry_standard: "Cavalry",
  cavalry_missile: "Missile Cavalry",
  artillery_foot: "Foot Artillery",
  artillery_horse: "Horse Artillery",
  artillery_fixed: "Fixed Artillery",
  general: "General",
};

export function classLabel(unitClass: string): string {
  return CLASS_LABELS[unitClass] ?? unitClass;
}
