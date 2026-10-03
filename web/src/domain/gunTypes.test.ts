import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { makeUnit } from "../test/factories";
import { gunArm, gunTypeLabel, gunTypeSortKey } from "./gunTypes";

const CSV = resolve(process.cwd(), "..", "data", "generated", "ntw3_army_builder_units.csv");

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Every distinct weapon_key of an artillery card or a combat general leading guns. */
function artilleryWeaponKeys(): string[] {
  const [head, ...rows] = readFileSync(CSV, "utf-8").replace(/^\u{FEFF}/u, "").split(/\r?\n/).filter(Boolean);
  const cols = splitCsvLine(head);
  const cls = cols.indexOf("unit_class");
  const key = cols.indexOf("unit_key");
  const weapon = cols.indexOf("weapon_key");
  const keys = new Set<string>();
  for (const row of rows) {
    const f = splitCsvLine(row);
    const w = f[weapon];
    if (!w) continue;
    const isGunKey = /^(ott_|siege_)?(cannon|howitzer|unicorn|mortar|rocket)/i.test(w);
    if (f[cls].startsWith("artillery") || (f[key].includes("_com_") && isGunKey)) keys.add(w);
  }
  return [...keys].sort();
}

const NATIONS = /\b(France|Britain|Austria|Prussia|Russia|Ottoman|Spain|Sweden|horse)\b/i;

describe("gunTypeLabel", () => {
  it("labels the documented examples", () => {
    expect(gunTypeLabel("cannon_6_pounder_France")).toBe("6-pdr cannon");
    expect(gunTypeLabel("cannon_6_pounder_horse_Russia")).toBe("6-pdr cannon");
    expect(gunTypeLabel("cannon_12_pounder")).toBe("12-pdr cannon");
    expect(gunTypeLabel("howitzer_7_pounder")).toBe("7-pdr howitzer");
    expect(gunTypeLabel("howitzer_6_In_France")).toBe("6-in howitzer");
    expect(gunTypeLabel("unicorn_10_pounder_Russia")).toBe("10-pdr unicorn");
    expect(gunTypeLabel("cannon_6_pounder_Britain_Shrapnel")).toBe("6-pdr shrapnel cannon");
    expect(gunTypeLabel("rockets_fixed")).toBe("Rockets");
    expect(gunTypeLabel("mortar_8_In")).toBe("8-in mortar");
  });

  it("merges nation and horse variants of one calibre", () => {
    expect(gunTypeLabel("cannon_6_pounder_horse_Prussia")).toBe(gunTypeLabel("cannon_6_pounder"));
  });

  it("gives every artillery weapon key in the CSV a clean, non-fallback label", () => {
    const keys = artilleryWeaponKeys();
    expect(keys.length).toBeGreaterThan(30);
    for (const k of keys) {
      const label = gunTypeLabel(k);
      expect(label, k).not.toMatch(/_/);
      expect(label, k).not.toMatch(NATIONS);
      // A recognised key always names its weapon kind.
      expect(label, k).toMatch(/cannon|howitzer|unicorn|mortar|rockets/i);
    }
  });

  it("humanises a key it cannot read instead of showing it raw", () => {
    expect(gunTypeLabel("mystery_gun")).toBe("Mystery gun");
  });

  it("sorts by ascending calibre, unsized last", () => {
    const keys = ["rockets_fixed", "cannon_12_pounder", "cannon_6_pounder_France", "cannon_3_pounder"];
    const sorted = [...keys].sort((a, b) => {
      const [ca, la] = gunTypeSortKey(a);
      const [cb, lb] = gunTypeSortKey(b);
      return ca - cb || la.localeCompare(lb);
    });
    expect(sorted).toEqual(["cannon_3_pounder", "cannon_6_pounder_France", "cannon_12_pounder", "rockets_fixed"]);
  });
});

describe("gunArm", () => {
  it("maps artillery classes to their arm", () => {
    expect(gunArm(makeUnit({ unitClass: "artillery_foot" }))).toBe("foot");
    expect(gunArm(makeUnit({ unitClass: "artillery_horse" }))).toBe("horse");
    expect(gunArm(makeUnit({ unitClass: "artillery_fixed" }))).toBe("fixed");
  });

  it("uses the led unit's class for a combat general", () => {
    const g = makeUnit({ unitClass: "general", isGeneral: true, generalKind: "combat", underlyingUnitClass: "artillery_horse" });
    expect(gunArm(g)).toBe("horse");
    const cav = makeUnit({ unitClass: "general", isGeneral: true, generalKind: "combat", underlyingUnitClass: "cavalry_heavy" });
    expect(gunArm(cav)).toBeNull();
  });

  it("is null for infantry and staff generals", () => {
    expect(gunArm(makeUnit({ unitClass: "infantry_line" }))).toBeNull();
    expect(gunArm(makeUnit({ unitClass: "general", isGeneral: true, generalKind: "staff", underlyingUnitClass: "general" }))).toBeNull();
  });
});
