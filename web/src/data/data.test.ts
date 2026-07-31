// Data-build parity tests. These read the generated browser JSON under
// web/public/data (run `npm run build:data` first). They mirror the Python
// suite's data assertions and the spec's TOW-inclusion requirement
// (docs/TOW_ARMY_BUILDS.md).

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFaction } from "./load";
import { emptyBuild, indexRoster, makeInstanceId, summarize } from "../state/build";
import type { BuildState } from "../state/build";

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

  it("includes ToW factions and ToW unit variants", () => {
    const factionFiles = readdirSync(resolve(DATA_DIR, "factions"));
    const towFiles = factionFiles.filter((f) => f.startsWith("ntw3_tow_"));
    // ToW factions are now their own rosters.
    expect(towFiles.length).toBeGreaterThan(0);
    // Their cards carry _tow_ unit keys and drop the (inert) ACDV placement, so
    // the web layer can lay them out as one long list of arm/class brigades.
    for (const file of towFiles.slice(0, 25)) {
      const roster = readJson(`factions/${file}`) as {
        cards: { unitKey: string; division: number | null; brigade: number | null }[];
      };
      expect(roster.cards.length).toBeGreaterThan(0);
      expect(roster.cards.every((c) => c.unitKey.includes("_tow_"))).toBe(true);
      expect(roster.cards.every((c) => c.division === null && c.brigade === null)).toBe(true);
    }
    const version = readJson("data-version.json") as { towRows: number };
    expect(version.towRows).toBeGreaterThan(0);
  });

  it("corps index splits Theatres of War sides (not as AC)", () => {
    const index = readJson("corps-index.json") as {
      sides: { side: string; theatres: { corps: { factionKey: string; isArmyCorps: boolean }[] }[] }[];
    };
    const towSides = index.sides.filter((s) => s.side.startsWith("tow_"));
    expect(towSides.map((s) => s.side)).toEqual([
      "tow_french_imperial",
      "tow_coalition",
    ]);
    const corps = towSides.flatMap((s) => s.theatres).flatMap((t) => t.corps);
    expect(corps.length).toBeGreaterThan(0);
    // ToW corps are not discount-eligible army corps.
    expect(corps.every((c) => c.factionKey.startsWith("ntw3_tow_") && !c.isArmyCorps)).toBe(true);
    expect(towSides[0].theatres.flatMap((t) => t.corps).every((c) => /^ntw3_tow_[ac]/.test(c.factionKey))).toBe(true);
    expect(towSides[1].theatres.flatMap((t) => t.corps).every((c) => c.factionKey.startsWith("ntw3_tow_b"))).toBe(true);
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

  // Real-roster pricing through the app's own path (loadFaction -> summarize), not
  // the rules-unit factories: 13. Davout / I.C (1812 Russia) is the corps whose
  // support-division sapper + skirmisher brigades discount as a set. Verified in game.
  it("13. Davout (1812) prices the sapper + skirmisher support brigades as a set", async () => {
    const roster = await loadFactionFromDisk("ntw3_ac_a11_x5_117");
    const index = indexRoster(roster);
    const byName = (needle: string): string => {
      const hit = roster.cards.filter((c) => !c.isGeneral && c.name.includes(needle));
      expect(hit, needle).toHaveLength(1);
      return hit[0].unitKey;
    };
    const davout = roster.cards.find((c) => c.isGeneral && c.generalKind === "staff")!;
    const sapper = byName("Sapeurs [G4]");
    const tirailleur = byName("Tirailleurs [S2]");
    const withUnits = (...keys: string[]): BuildState => ({
      ...emptyBuild(),
      staffSlotUnitKey: davout.unitKey,
      instances: keys.map((unitKey) => ({ id: makeInstanceId(), unitKey })),
    });

    // Davout + 2 Sapeurs + 6 Tirailleurs: 600 + 552 + 1110 = 2262 base, minus
    // floor(552*1/100)=5 and floor(1110*5/100)=55 -> 2202.
    const full = summarize(index, withUnits(...Array<string>(2).fill(sapper), ...Array<string>(6).fill(tirailleur)));
    expect(full.price.baseCost).toBe(2262);
    expect(full.price.appliedDiscount).toBe(60);
    expect(full.price.finalCost).toBe(2202);

    // Either brigade alone earns nothing.
    const skirmishersOnly = summarize(index, withUnits(...Array<string>(6).fill(tirailleur)));
    expect(skirmishersOnly.price.finalCost).toBe(skirmishersOnly.price.baseCost);
    const sappersOnly = summarize(index, withUnits(...Array<string>(2).fill(sapper)));
    expect(sappersOnly.price.finalCost).toBe(sappersOnly.price.baseCost);
  });
});

/** loadFaction() fetches; in tests serve the generated JSON straight off disk. */
async function loadFactionFromDisk(factionKey: string) {
  const body = readFileSync(resolve(DATA_DIR, "factions", `${factionKey}.json`), "utf-8");
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(body, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    return await loadFaction(factionKey);
  } finally {
    globalThis.fetch = original;
  }
}
