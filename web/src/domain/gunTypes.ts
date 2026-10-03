// Labels and arm classification for artillery. The game's `weapon_key` names the
// gun ("cannon_6_pounder_horse_Russia", "howitzer_6_In_France", ...); the planner
// wants the calibre-and-type only, so the nation and the "horse" marker (which the
// arm already says) are dropped and Shrapnel variants are kept distinct.

import type { UnitCard } from "./types";

export type GunArm = "foot" | "horse" | "fixed";

export const GUN_ARMS: readonly GunArm[] = ["foot", "horse", "fixed"];

export const GUN_ARM_LABELS: Record<GunArm, string> = {
  foot: "Foot",
  horse: "Horse",
  fixed: "Fixed",
};

/** Which artillery arm a card fights as, from its *effective* class: a combat
 *  general counts as the unit he leads, so a general of a horse battery is horse.
 *  Null for anything that is not artillery (including staff generals). */
export function gunArm(card: Pick<UnitCard, "unitClass" | "underlyingUnitClass" | "isGeneral" | "generalKind">): GunArm | null {
  const cls = card.isGeneral && card.generalKind === "combat" ? card.underlyingUnitClass || card.unitClass : card.unitClass;
  switch (cls) {
    case "artillery_foot":
      return "foot";
    case "artillery_horse":
      return "horse";
    case "artillery_fixed":
      return "fixed";
    default:
      return null;
  }
}

interface ParsedGun {
  kind: string;
  /** Calibre value, or null for unsized weapons (rockets, "ott_howitzer"). */
  calibre: number | null;
  unit: "pdr" | "in" | null;
  shrapnel: boolean;
}

// Optional "ott_"/"siege_" prefix, the weapon kind, then an optional calibre such
// as "6_pounder" or "6_In". Whatever follows (nation, "horse", "Shrapnel") is
// inspected for the one flag that matters and otherwise ignored.
const GUN_KEY = /^(?:ott_|siege_)?(cannon|howitzer|unicorn|mortar|rockets?)(?:_(\d+)_(pounder|in))?(?:_|$)/i;

function parseGunType(weaponKey: string): ParsedGun | null {
  const m = GUN_KEY.exec(weaponKey.trim());
  if (!m) return null;
  return {
    kind: m[1].toLowerCase().replace(/s$/, ""),
    calibre: m[2] ? Number(m[2]) : null,
    unit: m[3] ? (m[3].toLowerCase() === "in" ? "in" : "pdr") : null,
    shrapnel: /(^|_)shrapnel(_|$)/i.test(weaponKey),
  };
}

/** Display label for a game weapon key: "6-pdr cannon", "7-pdr howitzer",
 *  "6-in howitzer", "10-pdr unicorn", "6-pdr shrapnel cannon", "Rockets", "Mortar".
 *  A key it cannot read is humanised (underscores removed) rather than shown raw. */
export function gunTypeLabel(weaponKey: string): string {
  const g = parseGunType(weaponKey);
  if (!g) {
    const plain = weaponKey.replace(/_/g, " ").trim();
    return plain ? plain.charAt(0).toUpperCase() + plain.slice(1) : "Unknown guns";
  }
  if (g.kind === "rocket") return "Rockets";
  const size = g.calibre === null ? "" : `${g.calibre}-${g.unit} `;
  const text = `${size}${g.shrapnel ? "shrapnel " : ""}${g.kind}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Sort key within an arm: ascending calibre, unsized weapons last, then by label. */
export function gunTypeSortKey(weaponKey: string): [number, string] {
  const g = parseGunType(weaponKey);
  return [g?.calibre ?? Number.MAX_SAFE_INTEGER, gunTypeLabel(weaponKey)];
}
