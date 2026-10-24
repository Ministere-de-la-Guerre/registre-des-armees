import { describe, expect, it } from "vitest";
import { makeRoster, makeUnit } from "../../test/factories";
import { type BuildState, indexRoster, priceBuild } from "../../state/build";
import { normalizeCorpsBuilds } from "./load";
import { corpsPickRates } from "./pickRates";
import {
  MAX_SUGGESTIONS,
  type Suggestions,
  chooserRatesFor,
  suggestFor,
  suggestedGeneralAction,
} from "./suggest";
import type { CorpsPickRates, PickRateSeason } from "./types";

const FK = "ntw3_ac_test_x5_001";

const unit = (unitKey: string, cost: number, division: number, brigade: number, rosterIndex: number) =>
  makeUnit({
    unitKey, factionKey: FK, cost, cap: 1, groupCap: 1, capGroupKey: unitKey, baseUnitKey: unitKey,
    placement: { division, brigade }, rosterIndex,
  });
const combat = (unitKey: string, leads: string, cost: number, division: number, brigade: number, rosterIndex: number) =>
  makeUnit({
    unitKey, factionKey: FK, cost, cap: 1, groupCap: 1, capGroupKey: leads, baseUnitKey: leads,
    isGeneral: true, isCommanderVariant: true, generalKind: "combat", unitClass: "general",
    placement: { division, brigade }, rosterIndex,
  });

// Division 1 = a, c, d (2,800 each) + e (100): 8,500 face value. Completing it earns a
// 3% division discount (255), more than e itself costs -> adding e last is a NEGATIVE
// delta (-155). Division 2 = f, g, h (500 each) with combat generals over f and g.
const roster = () =>
  indexRoster(
    makeRoster(
      [
        unit("a", 2800, 1, 1, 0), unit("c", 2800, 1, 2, 1), unit("d", 2800, 1, 3, 2), unit("e", 100, 1, 4, 3),
        unit("f", 500, 2, 1, 4), unit("g", 500, 2, 2, 5), unit("h", 500, 2, 3, 6),
        combat("a_com", "a", 2800, 1, 1, 7), combat("f_com", "f", 600, 2, 1, 8), combat("g_com", "g", 600, 2, 2, 9),
        makeUnit({
          unitKey: "staff", factionKey: FK, cost: 100, isGeneral: true, generalKind: "staff", unitClass: "general",
          placement: null, capGroupKey: "staff", baseUnitKey: "staff", rosterIndex: 10,
        }),
      ],
      FK,
    ),
  );

const KEYS = ["a", "c", "d", "e", "f", "g", "h", "a_com", "f_com", "g_com", "staff", "zzz_unknown"];
const ix = (...names: string[]) => names.map((n) => KEYS.indexOf(n)).sort((x, y) => x - y);
const rep = <T,>(item: T, times: number): T[] => Array.from({ length: times }, () => item);

/** A "data" corps built from raw key lists, with consistent regiments/units counts. */
function corpsOf(
  builds: string[][],
  opts: { withBuilds?: boolean; n?: number } = {},
): CorpsPickRates {
  const units: Record<string, { b: number; t: number }> = {};
  const regiments: Record<string, { b: number; t: number; c: number }> = {};
  const capGroup = (k: string) => (k.endsWith("_com") ? k.slice(0, -4) : k);
  for (const b of builds) {
    for (const k of new Set(b)) {
      const copies = b.filter((x) => x === k).length;
      units[k] = { b: (units[k]?.b ?? 0) + 1, t: (units[k]?.t ?? 0) + copies };
    }
    for (const g of new Set(b.map(capGroup))) {
      const inReg = b.filter((k) => capGroup(k) === g);
      const r = (regiments[g] ??= { b: 0, t: 0, c: 0 });
      r.b += 1;
      r.t += inReg.length;
      if (inReg.some((k) => k.endsWith("_com"))) r.c += 1;
    }
  }
  return {
    kind: "data",
    n: opts.n ?? builds.length,
    players: 5,
    corpsName: "Test",
    units,
    regiments,
    builds: opts.withBuilds === false ? null : { keys: KEYS, builds: builds.map((b) => ix(...b)) },
  };
}

const bs = (unitKeys: string[], staff: string | null = null): BuildState => ({
  instances: unitKeys.map((unitKey, i) => ({ id: `i${i}`, unitKey })),
  staffSlotUnitKey: staff,
});

const run = (corps: CorpsPickRates | null, build: BuildState, combatCap = 1, rosterMatches = true) =>
  suggestFor({ corps, rosterMatches, index: roster(), build, combatCap });
const ok = (r: ReturnType<typeof run>): Suggestions => {
  expect(r.kind).toBe("ok");
  return r as Suggestions;
};

// 20 builds of a corps whose players mostly field division 1.
const MAIN = [
  ...rep(["a", "c", "d", "e", "f_com", "g"], 8),
  ...rep(["a", "c", "d", "e", "f", "g_com"], 6),
  ...rep(["a_com", "c", "d", "e", "h"], 6),
];

// 15 builds over three combat generals: f_com x6, g_com x5, a_com x4.
const GEN = [...rep(["c", "f_com"], 6), ...rep(["c", "g_com"], 5), ...rep(["c", "a_com"], 4)];

describe("unavailable states", () => {
  it("is off without corps data", () => {
    expect(run(null, bs([]))).toEqual({ kind: "off" });
  });
  it("reports out-of-scope and unplayed", () => {
    expect(run({ kind: "out-of-scope", note: "" }, bs([]))).toEqual({ kind: "out-of-scope" });
    expect(run({ kind: "unplayed", corpsName: "x" }, bs([]))).toEqual({ kind: "unplayed" });
  });
  it("is thin below 15 recorded builds", () => {
    expect(run(corpsOf(rep(["a", "c"], 14)), bs([]))).toEqual({ kind: "thin", n: 14 });
    expect(run(corpsOf(rep(["a", "c"], 15)), bs([])).kind).toBe("ok");
  });
  it("reports a changed roster", () => {
    expect(run(corpsOf(MAIN), bs([]), 1, false)).toEqual({ kind: "roster-changed" });
  });
  it("reports a season file without build lists", () => {
    expect(run(corpsOf(MAIN, { withBuilds: false }), bs([]))).toEqual({ kind: "no-builds" });
  });
});

describe("empty build", () => {
  it("uses every build as a neighbour and omits the shared percentage", () => {
    const s = ok(run(corpsOf(MAIN), bs([])));
    expect(s.emptyBuild).toBe(true);
    expect(s.K).toBe(20);
    expect(s.n).toBe(20);
    expect(s.sharedPct).toBeNull();
    expect(s.neighbours).toHaveLength(20);
    // corps-wide counts: a/c/d/e in all 20, ranked by k then corps-wide b then roster order.
    const top = s.units.map((u) => [u.card.unitKey, u.k]);
    expect(top).toEqual([["a", 20], ["c", 20], ["d", 20], ["e", 20], ["f", 14], ["g", 14], ["h", 6]]);
  });

  it("never offers the staff general as a unit and caps rows at 8", () => {
    const many = rep(["a", "c", "d", "e", "f", "g", "h", "staff"], 15);
    const s = ok(run(corpsOf(many), bs([])));
    expect(s.units.map((u) => u.card.unitKey)).not.toContain("staff");
    expect(s.units).toHaveLength(7);
    expect(MAX_SUGGESTIONS).toBe(8);
  });
});

describe("neighbour choice", () => {
  it("takes the 15 most similar builds, ties kept in original build order", () => {
    // Build 15 shares a with the user; builds 0-14 share nothing (similarity 0).
    const builds = [...rep(["f", "g"], 15), ["a", "c"]];
    const s = ok(run(corpsOf(builds), bs(["a"])));
    expect(s.K).toBe(15);
    expect(s.neighbours[0]).toEqual(ix("a", "c")); // most similar first
    // The zero-similarity tail is cut at the END of file order: build 14 is dropped.
    expect(s.neighbours).toHaveLength(15);
    expect(s.neighbours.slice(1)).toEqual(rep(ix("f", "g"), 14));
  });

  it("orders equal-similarity builds by original position", () => {
    // Builds 0..15: even ones {a,c}, odd ones {a,d}; both sim 1/2 with user {a}.
    const builds = Array.from({ length: 16 }, (_, i) => (i % 2 ? ["a", "d"] : ["a", "c"]));
    const s = ok(run(corpsOf(builds), bs(["a"])));
    expect(s.neighbours).toEqual(builds.slice(0, 15).map((b) => ix(...b)));
  });

  it("computes the shared percentage as mean |U∩R|/|U|", () => {
    // User {a, c}; 15 builds, 10 holding both, 5 holding only a  -> (10*1 + 5*.5)/15 = 83%.
    const builds = [...rep(["a", "c", "d"], 10), ...rep(["a", "e"], 5)];
    const s = ok(run(corpsOf(builds), bs(["a", "c"])));
    expect(s.sharedPct).toBe(83);
  });

  it("ignores unknown keys when building the sets", () => {
    const builds = rep(["a", "zzz_unknown"], 15);
    const s = ok(run(corpsOf(builds), bs(["a"])));
    expect(s.sharedPct).toBe(100);
  });
});

describe("units row", () => {
  it("lists regiments in at least two neighbours that the user lacks, with k", () => {
    const s = ok(run(corpsOf(MAIN), bs(["a", "c", "d"])));
    expect(s.units.map((u) => u.card.unitKey)).not.toEqual(expect.arrayContaining(["a", "c", "d"]));
    const byKey = Object.fromEntries(s.units.map((u) => [u.card.unitKey, u.k]));
    expect(byKey.e).toBe(15);
    expect(byKey.f).toBeGreaterThan(0);
  });

  it("requires a regiment to appear in at least two neighbours", () => {
    const builds = [...rep(["a", "c"], 14), ["a", "h"]];
    const s = ok(run(corpsOf(builds), bs(["a"])));
    expect(s.units.map((u) => u.card.unitKey)).toEqual(["c"]); // h only in one build
  });

  it("breaks k ties by corps-wide regiment count, then roster order", () => {
    // Neighbours = the 15 builds holding a. d and e tie on k; e is also in the
    // excluded builds (no 'a'), so it has the higher corps-wide count (11 vs 8).
    const builds = [...rep(["a", "d", "e"], 8), ...rep(["a", "c"], 7), ...rep(["e"], 3)];
    const s = ok(run(corpsOf(builds), bs(["a"])));
    expect(s.units.map((u) => [u.card.unitKey, u.k])).toEqual([["e", 8], ["d", 8], ["c", 7]]);
  });

  it("reports a negative cost change when the add completes a formation discount", () => {
    const idx = roster();
    const build = bs(["a", "c", "d"]);
    const before = priceBuild(idx, build).finalCost;
    const s = ok(run(corpsOf(MAIN), build));
    const e = s.units.find((u) => u.card.unitKey === "e")!;
    const after = priceBuild(idx, bs(["a", "c", "d", "e"])).finalCost;
    expect(e.costDelta).toBe(after - before);
    expect(e.costDelta).toBe(-155);
    expect(e.completesDiscount).toBe(true);
    expect(e.finalCost).toBe(after);
    expect(e.overBudget).toBe(false);
    expect(e.blockedReason).toBeNull();
    // A card that completes nothing is a plain positive delta.
    const f = s.units.find((u) => u.card.unitKey === "f")!;
    expect(f.costDelta).toBe(500);
    expect(f.completesDiscount).toBe(false);
  });

  it("flags over-budget as a soft warning without blocking", () => {
    const heavy = indexRoster(
      makeRoster([unit("a", 6000, 1, 1, 0), unit("c", 3900, 1, 2, 1), unit("e", 600, 2, 1, 2)], FK),
    );
    const corps: CorpsPickRates = {
      kind: "data", n: 15, players: 3, corpsName: "H", units: {}, regiments: {},
      builds: { keys: ["a", "c", "e"], builds: rep([0, 1, 2], 15) },
    };
    const r = suggestFor({ corps, rosterMatches: true, index: heavy, build: bs(["a", "c"]), combatCap: 1 });
    const e = (r as Suggestions).units[0];
    expect(e.card.unitKey).toBe("e");
    expect(e.overBudget).toBe(true);
    expect(e.blockedReason).toBeNull();
  });

  it("carries the hard-block reason from evaluateAdd", () => {
    const capped = indexRoster(makeRoster([unit("a", 100, 1, 1, 0), unit("c", 100, 1, 2, 1)], FK));
    // fill the build to 31 cards with a capped unit that is not 'c'... use total-cards rule
    const filler = Array.from({ length: 31 }, (_, i) => makeUnit({
      unitKey: `x${i}`, factionKey: FK, cost: 1, cap: 0, groupCap: 0, capGroupKey: `x${i}`, baseUnitKey: `x${i}`, rosterIndex: i + 2,
    }));
    const full = indexRoster(makeRoster([...capped.roster.cards, ...filler], FK));
    const corps: CorpsPickRates = {
      kind: "data", n: 15, players: 3, corpsName: "F", units: {}, regiments: {},
      builds: { keys: ["a", "c"], builds: rep([0, 1], 15) },
    };
    const build = bs(["a", ...filler.map((f) => f.unitKey)].slice(0, 31));
    const r = suggestFor({ corps, rosterMatches: true, index: full, build, combatCap: 1 }) as Suggestions;
    expect(r.units[0].card.unitKey).toBe("c");
    expect(r.units[0].blockedReason).toMatch(/full/i);
  });
});

describe("units row: extra copies", () => {
  // Cap-3 roster: x is a plain regiment (cap 3) with a combat general x_com; y is cap 3 too.
  const mk = (unitKey: string, rosterIndex: number, over = {}) =>
    makeUnit({
      unitKey, factionKey: FK, cost: 100, cap: 3, groupCap: 3, capGroupKey: unitKey, baseUnitKey: unitKey,
      placement: { division: 1, brigade: rosterIndex + 1 }, rosterIndex, ...over,
    });
  const idx3 = indexRoster(
    makeRoster(
      [
        mk("a", 0), mk("c", 1),
        mk("a_com", 2, { capGroupKey: "a", baseUnitKey: "a", isGeneral: true, isCommanderVariant: true, generalKind: "combat", unitClass: "general" }),
      ],
      FK,
    ),
  );
  const run3 = (builds: string[][], build: BuildState) => {
    const corps: CorpsPickRates = {
      kind: "data", n: builds.length, players: 5, corpsName: "T", units: {}, regiments: { a: { b: 15, t: 40, c: 0 }, c: { b: 15, t: 15, c: 0 } },
      builds: { keys: ["a", "c", "a_com"], builds: builds.map((b) => b.map((n) => ["a", "c", "a_com"].indexOf(n))) },
    };
    return suggestFor({ corps, rosterMatches: true, index: idx3, build, combatCap: 1 }) as Suggestions;
  };

  it("suggests a 2nd copy when enough neighbours took two or more", () => {
    const builds = [...rep(["a", "a", "c"], 3), ...rep(["a", "c"], 12)];
    const s = run3(builds, bs(["a"]));
    const a = s.units.find((u) => u.card.unitKey === "a")!;
    expect(a.copy).toBe(2);
    expect(a.k).toBe(3);
    expect(s.units.find((u) => u.card.unitKey === "c")!.copy).toBe(1);
  });

  it("skips a regiment entirely at its unit cap", () => {
    const builds = rep(["a", "a", "a", "c"], 15);
    expect(run3(builds, bs(["a", "a"])).units.find((u) => u.card.unitKey === "a")?.copy).toBe(3);
    expect(run3(builds, bs(["a", "a", "a"])).units.map((u) => u.card.unitKey)).not.toContain("a");
  });

  it("counts a combat-general copy for both the build and the neighbours", () => {
    const builds = rep(["a", "a_com", "c"], 15);
    // Neighbours hold 2 copies each (plain + general); the user holds one via the general.
    const a = run3(builds, bs(["a_com"])).units.find((u) => u.card.unitKey === "a")!;
    expect(a.copy).toBe(2);
    expect(a.k).toBe(15);
  });

  it("ranks a new regiment ahead of an extra copy at equal k", () => {
    const builds = rep(["a", "a", "c"], 15);
    const s = run3(builds, bs(["a"]));
    expect(s.units.map((u) => [u.card.unitKey, u.copy])).toEqual([["c", 1], ["a", 2]]);
    // ...but a higher k still wins over a lower copy number.
    const mixed = [...rep(["a", "a"], 10), ...rep(["a", "c"], 5)];
    const m = run3(mixed, bs(["a"]));
    expect(m.units.map((u) => u.card.unitKey)).toEqual(["a", "c"]);
  });
});

describe("combat generals row", () => {
  it("marks a held general as have, and not actionable", () => {
    const s = ok(run(corpsOf(MAIN), bs(["a", "c", "f_com"]), 2));
    const g = s.generals.find((x) => x.card.unitKey === "f_com")!;
    expect(g.status).toBe("have");
    expect(g.blockedReason).toBeNull();
    expect(g.swapInstanceId).toBeNull();
  });

  it("offers a swap on the first plain copy of the regiment, priced against the current price", () => {
    const idx = roster();
    const build = bs(["d", "f", "f2"].filter((k) => k !== "f2").concat(["a"]));
    const s = ok(run(corpsOf(MAIN), build, 2));
    const g = s.generals.find((x) => x.card.unitKey === "f_com")!;
    expect(g.status).toBe("swap");
    expect(g.swapInstanceId).toBe("i1");
    expect(g.regiment.unitKey).toBe("f");
    const swapped = bs(["d", "f_com", "a"]);
    expect(g.finalCost).toBe(priceBuild(idx, swapped).finalCost);
    expect(g.costDelta).toBe(priceBuild(idx, swapped).finalCost - priceBuild(idx, build).finalCost);
    expect(g.costDelta).toBe(100);
    expect(g.blockedReason).toBeNull();
  });

  it("offers an add when the build has no copy of the regiment", () => {
    const s = ok(run(corpsOf(GEN), bs(["c"]), 2));
    const g = s.generals.find((x) => x.card.unitKey === "g_com")!;
    expect(g.status).toBe("add");
    expect(g.swapInstanceId).toBeNull();
    expect(g.costDelta).toBe(600);
    expect(g.blockedReason).toBeNull();
  });

  it("blocks swaps and adds once the combat-general cap is used", () => {
    // a_com fills the single combat slot.
    const s = ok(run(corpsOf(MAIN), bs(["a_com", "f", "c"]), 1));
    expect(s.combatUsed).toBe(1);
    expect(s.combatCap).toBe(1);
    const swap = s.generals.find((x) => x.card.unitKey === "f_com")!;
    expect(swap.status).toBe("swap");
    expect(swap.blockedReason).toMatch(/Combat-general limit \(1\)/);
    const add = s.generals.find((x) => x.card.unitKey === "g_com")!;
    expect(add.status).toBe("add");
    expect(add.blockedReason).toMatch(/Combat-general limit \(1\)/);
  });

  it("sorts actionable first (k desc), then have, then blocked", () => {
    const empty = ok(run(corpsOf(GEN), bs([]), 2));
    expect(empty.generals.map((g) => [g.card.unitKey, g.k])).toEqual([["f_com", 6], ["g_com", 5], ["a_com", 4]]);
    // Holding g_com with room to spare: the two actionable ones, then `have`.
    const roomy = ok(run(corpsOf(GEN), bs(["c", "g_com"]), 2));
    expect(roomy.generals.map((g) => [g.card.unitKey, g.status])).toEqual([["f_com", "add"], ["a_com", "add"], ["g_com", "have"]]);
    // At the cap `have` still beats the blocked ones, which keep k order.
    const capped = ok(run(corpsOf(GEN), bs(["c", "g_com"]), 1));
    expect(capped.generals.map((g) => g.card.unitKey)).toEqual(["g_com", "f_com", "a_com"]);
    expect(capped.generals.slice(1).every((g) => g.blockedReason !== null)).toBe(true);
  });

  it("needs a general in at least two neighbours", () => {
    const builds = [...rep(["a", "c"], 14), ["a", "g_com"]];
    const s = ok(run(corpsOf(builds), bs(["a"]), 2));
    expect(s.generals).toEqual([]);
  });
});

describe("chooserRatesFor", () => {
  const opts = (corps: CorpsPickRates, suggestions: ReturnType<typeof run>, regimentKey = "f", minSample = 5) =>
    chooserRatesFor({ corps, suggestions, index: roster(), regimentKey, minSample });

  it("derives the plain row from b - c and the general row from the card's own b", () => {
    const corps = corpsOf(MAIN);
    const r = opts(corps, run(corps, bs([])))!;
    // f: 8 builds with f_com + 6 plain f = 14 regiment builds, 8 commanded.
    expect(r.regB).toBe(14);
    expect(r.plain.all).toBe(6);
    expect(r.generals.f_com.all).toBe(8);
  });

  it("counts like-yours over the neighbours containing the regiment", () => {
    const corps = corpsOf(MAIN);
    const sg = run(corps, bs(["a", "c", "d"]));
    const r = opts(corps, sg)!;
    const nb = (sg as Suggestions).neighbours;
    const withF = nb.filter((b) => b.some((i) => ["f", "f_com"].includes(KEYS[i])));
    expect(r.M).toBe(withF.length);
    expect(r.generals.f_com.like).toBe(withF.filter((b) => b.includes(KEYS.indexOf("f_com"))).length);
    expect(r.plain.like).toBe(r.M! - r.generals.f_com.like!);
    expect(r.plain.like! + r.generals.f_com.like!).toBe(r.M);
  });

  it("omits the like bar when no neighbour has the regiment", () => {
    const corps = corpsOf([...rep(["a", "c"], 15), ...rep(["h", "h"].slice(0, 1), 6)]);
    const sg = run(corps, bs(["a"]));
    const r = opts(corps, sg, "h")!;
    expect(r.M).toBe(0);
    expect(r.plain.like).toBeNull();
    expect(r.regB).toBe(6);
  });

  it("omits like when suggestions are unavailable or the dataset has no builds", () => {
    const corps = corpsOf(MAIN);
    expect(opts(corps, { kind: "roster-changed" })!.M).toBeNull();
    const noBuilds = corpsOf(MAIN, { withBuilds: false });
    const r = opts(noBuilds, run(noBuilds, bs([])))!;
    expect(r.M).toBeNull();
    expect(r.plain.like).toBeNull();
    expect(r.plain.all).toBe(6);
  });

  it("returns null below the minimum sample, for an unknown regiment, and without data", () => {
    const corps = corpsOf(MAIN);
    expect(opts(corps, run(corps, bs([])), "f", 15)).toBeNull();
    expect(opts(corps, run(corps, bs([])), "nope")).toBeNull();
    expect(chooserRatesFor({ corps: null, suggestions: { kind: "off" }, index: roster(), regimentKey: "f", minSample: 5 })).toBeNull();
    expect(chooserRatesFor({ corps: { kind: "unplayed", corpsName: "x" }, suggestions: { kind: "unplayed" }, index: roster(), regimentKey: "f", minSample: 5 })).toBeNull();
  });
});

describe("builds normalisation", () => {
  it("keeps valid arrays and drops malformed ones without throwing", () => {
    expect(normalizeCorpsBuilds({ keys: ["a", "b"], b: [[0, 1], [0, 2], [-1], [0.5], "x", [0, "1"], []] })).toEqual({
      keys: ["a", "b"],
      b: [[0, 1], []],
    });
  });
  it("rejects a missing or non-string key list", () => {
    expect(normalizeCorpsBuilds(undefined)).toBeUndefined();
    expect(normalizeCorpsBuilds({ keys: ["a", 3], b: [[0]] })).toBeUndefined();
    expect(normalizeCorpsBuilds({ keys: ["a"], b: "no" })).toBeUndefined();
  });
  it("threads builds through corpsPickRates", () => {
    const season = {
      scope: { note: "" },
      corps: { c: { name: "C", n: 3, builds: { keys: ["a"], b: [[0], [0, 0]] } }, d: { name: "D", n: 1 } },
    } as unknown as PickRateSeason;
    expect(corpsPickRates(season, "c")).toMatchObject({ builds: { keys: ["a"], builds: [[0], [0, 0]] } });
    expect(corpsPickRates(season, "d")).toMatchObject({ builds: null });
  });
});

describe("suggestedGeneralAction", () => {
  const base = {
    card: makeUnit({ unitKey: "g" }), k: 1, status: "swap" as const, regiment: makeUnit({ unitKey: "r" }),
    swapInstanceId: "i1", costDelta: 0, finalCost: 0, overBudget: false, blockedReason: null,
  };
  it("never swaps or adds a blocked general", () => {
    expect(suggestedGeneralAction({ ...base, blockedReason: "Combat-general limit (4) reached." })).toEqual({
      kind: "blocked", reason: "Combat-general limit (4) reached.",
    });
  });
  it("swaps when allowed, adds otherwise", () => {
    expect(suggestedGeneralAction(base)).toEqual({ kind: "swap", instanceId: "i1" });
    expect(suggestedGeneralAction({ ...base, swapInstanceId: null })).toEqual({ kind: "add" });
    expect(suggestedGeneralAction({ ...base, status: "add" })).toEqual({ kind: "add" });
  });
});
