// Data-build parity tests. These read the generated browser JSON under
// web/public/data (run `npm run build:data` first). They mirror the Python
// suite's data assertions and the spec's TOW-exclusion requirement.

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DATA_DIR = resolve(process.cwd(), "public", "data");

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(resolve(DATA_DIR, rel), "utf-8"));
}

describe("generated data", () => {
  it("Platov corps exposes every general without random rolls", () => {
    const roster = readJson("factions/ntw3_ac_b11_r5_189.json") as {
      cards: { unitKey: string; isGeneral: boolean }[];
    };
    const generals = roster.cards.filter((c) => c.isGeneral);
    const combat = generals.filter((c) => c.unitKey.includes("_com_"));
    const staff = generals.filter((c) => c.unitKey.includes("_gen_staff_"));
    expect(roster.cards).toHaveLength(63);
    expect(combat).toHaveLength(18);
    expect(staff).toHaveLength(1);
  });

  it("excludes all ToW factions and ToW unit variants", () => {
    const factionFiles = readdirSync(resolve(DATA_DIR, "factions"));
    // No ToW faction files.
    expect(factionFiles.some((f) => f.startsWith("ntw3_tow_"))).toBe(false);
    // Spot check a few rosters contain no _tow_ unit keys.
    for (const file of factionFiles.slice(0, 25)) {
      const roster = readJson(`factions/${file}`) as { cards: { unitKey: string }[] };
      expect(roster.cards.every((c) => !c.unitKey.includes("_tow_"))).toBe(true);
    }
    const version = readJson("data-version.json") as { excludedTow: number };
    expect(version.excludedTow).toBeGreaterThan(0);
  });

  it("corps index excludes the Theatres of War side", () => {
    const index = readJson("corps-index.json") as { sides: { side: string }[] };
    expect(index.sides.map((s) => s.side)).not.toContain("shared");
    expect(index.sides.length).toBeGreaterThan(0);
  });

  it("every army-corps non-general card has a placement", () => {
    const factionFiles = readdirSync(resolve(DATA_DIR, "factions")).filter((f) =>
      f.startsWith("ntw3_ac_"),
    );
    // Untagged combat unit with no support-division match. The game files give it no
    // ACDV tag, so the app surfaces it under "Other units"; documented here so the
    // placement check stays strict everywhere else.
    const UNPLACED_EXCEPTIONS = new Set(["ntw3_inf_line_290_999_7045"]);
    for (const file of factionFiles) {
      const roster = readJson(`factions/${file}`) as {
        cards: { unitKey: string; isGeneral: boolean; division: number | null }[];
      };
      const unplaced = roster.cards.filter(
        (c) => !c.isGeneral && c.division === null && !UNPLACED_EXCEPTIONS.has(c.unitKey),
      );
      expect(unplaced, file).toHaveLength(0);
    }
  });
});
