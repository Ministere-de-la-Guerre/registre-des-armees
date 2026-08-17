import { describe, expect, it } from "vitest";
import {
  bucketOf,
  buildsLabel,
  cardPickRate,
  tierOf,
  confidenceOf,
  corpsPickRates,
  longLabel,
  regimentRollup,
  rosterMatches,
  shortLabel,
  unitPickRate,
} from "./pickRates";
import type { PickRateSeason } from "./types";

const THRESHOLDS = { minSampleForPercent: 5, autoInclude: 85, contested: 25, rare: 5 };

// Modelled on the real Season 10 shape of the 84e: the plain grenadier card is fielded
// often, the commander variant of the SAME regiment almost never.
const season: PickRateSeason = {
  schemaVersion: 2,
  id: "season-10",
  label: "Season 10",
  patch: "NTW3 1.3.0 (Build 2081)",
  corpus: { battles: 172, armies: 1370, players: 138, recorded: "2026-08" },
  scope: { corpsTypes: ["ac"], note: "Army Corps only." },
  unitDataVersion: { totalSourceRows: 25668, factionCount: 297 },
  thresholds: THRESHOLDS,
  corps: {
    solid: {
      name: "Solid corps",
      n: 38,
      players: 18,
      units: {
        grenadiers: { b: 13, t: 26 },
        grenadiers_com_1: { b: 1, t: 1 },
        staffGeneral: { b: 30, t: 30 },
      },
      regiments: { grenadiers: { b: 14, t: 27, c: 1 }, staffGeneral: { b: 30, t: 30, c: 0 } },
    },
    thin: {
      name: "Thin corps",
      n: 3,
      units: { picked: { b: 2, t: 2 } },
      regiments: { picked: { b: 2, t: 2, c: 0 } },
    },
    unplayed: { name: "Unplayed corps", n: 0 },
  },
};

const opts = (over: Partial<{ rosterMatches: boolean }> = {}) => ({
  rosterMatches: true,
  minSampleForPercent: THRESHOLDS.minSampleForPercent,
  ...over,
});

describe("corpsPickRates", () => {
  it("returns null without a season, so the UI can stay silent while loading", () => {
    expect(corpsPickRates(null, "solid")).toBeNull();
  });

  it("reports a corps the dataset does not cover as out-of-scope, not as no data", () => {
    expect(corpsPickRates(season, "ntw3_tow_a03_x8_032")).toEqual({
      kind: "out-of-scope",
      note: "Army Corps only.",
    });
  });

  it("distinguishes a corps that is in scope but was never played", () => {
    expect(corpsPickRates(season, "unplayed")).toEqual({ kind: "unplayed", corpsName: "Unplayed corps" });
  });

  it("returns the sample size alongside the cards", () => {
    expect(corpsPickRates(season, "solid")).toMatchObject({ kind: "data", n: 38, players: 18 });
  });
});

describe("unitPickRate", () => {
  // The bug this model exists to prevent: a commander variant used to inherit its
  // regiment's number, overstating a 1-in-38 pick as 14-in-38.
  it("rates each CARD separately, so a commander variant never inherits the unit's rate", () => {
    const corps = corpsPickRates(season, "solid");
    const plain = unitPickRate(corps, "grenadiers", opts());
    const withOfficer = unitPickRate(corps, "grenadiers_com_1", opts());
    expect(plain).toMatchObject({ kind: "data", builds: 13, n: 38 });
    expect(withOfficer).toMatchObject({ kind: "data", builds: 1, n: 38 });
    expect(shortLabel(plain!)).toBe("13/38");
    expect(shortLabel(withOfficer!)).toBe("1/38");
  });

  it("rates a staff general like any other card — a real choice when the corps offers several", () => {
    expect(unitPickRate(corpsPickRates(season, "solid"), "staffGeneral", opts())).toMatchObject({
      kind: "data",
      builds: 30,
      n: 38,
    });
  });

  it("computes copies when picked", () => {
    expect(unitPickRate(corpsPickRates(season, "solid"), "grenadiers", opts())).toEqual({
      kind: "data",
      builds: 13,
      n: 38,
      pct: (100 * 13) / 38,
      copies: 2,
    });
  });

  it("withholds the percentage below the minimum sample, but still gives the counts", () => {
    const r = unitPickRate(corpsPickRates(season, "thin"), "picked", opts());
    expect(r).toMatchObject({ kind: "data", builds: 2, n: 3, pct: null });
    expect(shortLabel(r!)).toBe("2/3");
    expect(longLabel(r!)).toBe("Picked in 2 of 3 builds");
  });

  it("reads an absent card in a sampled corps as NEVER PICKED, not as missing data", () => {
    const r = unitPickRate(corpsPickRates(season, "solid"), "nobodyTakesThis", opts());
    expect(r).toEqual({ kind: "never", n: 38 });
    expect(shortLabel(r!)).toBe("0/38");
    expect(longLabel(r!)).toBe("Never picked — 0 of 38 builds");
  });

  it("downgrades never-picked to unknown when the roster has moved on since the corpus", () => {
    expect(unitPickRate(corpsPickRates(season, "solid"), "addedLater", opts({ rosterMatches: false }))).toEqual({
      kind: "unknown",
    });
  });

  it("propagates the corps-level absences to its cards", () => {
    expect(unitPickRate(corpsPickRates(season, "unplayed"), "x", opts())).toEqual({ kind: "unplayed" });
    expect(unitPickRate(corpsPickRates(season, "ntw3_tow_x"), "x", opts())).toEqual({ kind: "out-of-scope" });
  });
});

describe("cardPickRate — following what the grid is showing", () => {
  const corps = corpsPickRates(season, "solid");
  const keys = { unitKey: "grenadiers", baseUnitKey: "grenadiers" };

  it("shows the card's own rate while combat generals are visible", () => {
    const r = cardPickRate(corps, keys, { ...opts(), combineVariants: false });
    expect(r).toMatchObject({ kind: "data", builds: 13 });
  });

  // With the general tiles hidden there is nowhere else for their builds to be counted,
  // so folding them in is what keeps the grid's numbers a true count.
  it("folds the generals into the unit's rate once their tiles are hidden", () => {
    const r = cardPickRate(corps, keys, { ...opts(), combineVariants: true });
    expect(r).toMatchObject({ kind: "data", builds: 14 });
  });

  it("still reports never-picked and the corps-level absences when combining", () => {
    expect(cardPickRate(corps, { unitKey: "x", baseUnitKey: "x" }, { ...opts(), combineVariants: true }))
      .toEqual({ kind: "never", n: 38 });
    expect(
      cardPickRate(corpsPickRates(season, "unplayed"), keys, { ...opts(), combineVariants: true }),
    ).toEqual({ kind: "unplayed" });
  });

  it("falls back to the unit key when a card carries no base key", () => {
    const r = cardPickRate(corps, { unitKey: "grenadiers", baseUnitKey: "" }, { ...opts(), combineVariants: true });
    expect(r).toMatchObject({ kind: "data", builds: 14 });
  });
});

describe("regimentRollup", () => {
  // The regiment total is >= any single card's count: a build can field the plain unit
  // OR a commander variant, and both count toward the regiment.
  it("rolls the plain unit and its variants together", () => {
    const corps = corpsPickRates(season, "solid");
    expect(regimentRollup(corps, "grenadiers")).toEqual({ builds: 14, n: 38, officerBuilds: 1 });
    const plain = unitPickRate(corps, "grenadiers", opts())!;
    expect(regimentRollup(corps, "grenadiers")!.builds).toBeGreaterThan(
      plain.kind === "data" ? plain.builds : 0,
    );
  });

  it("is null when the corps has no usable sample, or the regiment is unknown", () => {
    expect(regimentRollup(corpsPickRates(season, "unplayed"), "grenadiers")).toBeNull();
    expect(regimentRollup(corpsPickRates(season, "solid"), "neverSeen")).toBeNull();
    expect(regimentRollup(null, "grenadiers")).toBeNull();
  });
});

describe("rosterMatches", () => {
  it("is true only when every stamped counter agrees", () => {
    expect(rosterMatches(season, { totalSourceRows: 25668, factionCount: 297 })).toBe(true);
    expect(rosterMatches(season, { totalSourceRows: 25669, factionCount: 297 })).toBe(false);
  });

  it("is false when either side is missing, so absence never reads as never-picked", () => {
    expect(rosterMatches(season, null)).toBe(false);
    expect(rosterMatches(null, { totalSourceRows: 1 })).toBe(false);
  });

  it("ignores extra keys the app's version stamp may gain later", () => {
    expect(rosterMatches(season, { totalSourceRows: 25668, factionCount: 297, corpsListed: 297 })).toBe(true);
  });
});

describe("confidence and labels", () => {
  it("tiers the sample size", () => {
    expect(confidenceOf(0)).toBe("none");
    expect(confidenceOf(null)).toBe("none");
    expect(confidenceOf(4)).toBe("very-thin");
    expect(confidenceOf(5)).toBe("thin");
    expect(confidenceOf(19)).toBe("moderate");
    expect(confidenceOf(20)).toBe("solid");
  });

  it("words a build count without producing '1 builds'", () => {
    expect(buildsLabel(1)).toBe("1 build");
    expect(buildsLabel(22)).toBe("22 builds");
  });

  it("gives every absence its own wording, short and long", () => {
    expect(shortLabel({ kind: "unplayed" })).toBe("no battles");
    expect(shortLabel({ kind: "out-of-scope" })).toBe("not covered");
    expect(shortLabel({ kind: "unknown" })).toBe("no data");
    const longs = (["unplayed", "out-of-scope", "unknown"] as const).map((kind) => longLabel({ kind }));
    expect(new Set(longs).size).toBe(longs.length);
  });

  it("states the percentage only in the long form", () => {
    const rate = { kind: "data", builds: 17, n: 22, pct: 77.3, copies: 2 } as const;
    expect(longLabel(rate)).toBe("Picked in 17 of 22 builds (77%)");
    // The compact form never carries a percentage — the bar encodes it.
    expect(shortLabel(rate)).toBe("17/22");
  });
});

describe("bucketOf", () => {
  it("labels a well-sampled card", () => {
    expect(bucketOf({ kind: "data", builds: 20, n: 22, pct: 91, copies: 1 }, THRESHOLDS)).toBe("auto-include");
    expect(bucketOf({ kind: "data", builds: 11, n: 22, pct: 50, copies: 1 }, THRESHOLDS)).toBe("contested");
    expect(bucketOf({ kind: "data", builds: 2, n: 22, pct: 9, copies: 1 }, THRESHOLDS)).toBe("rare");
    expect(bucketOf({ kind: "never", n: 22 }, THRESHOLDS)).toBe("never");
  });

  // The grid paints a mark green exactly when this returns "auto-include", so the
  // sample gate below is also what stops a 1-of-1 corps colouring itself green.
  it("only calls a card auto-include at or above the threshold", () => {
    const at = { kind: "data", builds: 17, n: 20, pct: 85, copies: 1 } as const;
    const below = { kind: "data", builds: 16, n: 20, pct: 80, copies: 1 } as const;
    expect(bucketOf(at, THRESHOLDS)).toBe("auto-include");
    expect(bucketOf(below, THRESHOLDS)).toBe("contested");
  });

  it("never calls a tiny sample auto-include, however high its rate", () => {
    expect(bucketOf({ kind: "data", builds: 1, n: 1, pct: 100, copies: 1 }, THRESHOLDS)).toBeNull();
    expect(bucketOf({ kind: "data", builds: 9, n: 9, pct: 100, copies: 1 }, THRESHOLDS)).toBeNull();
    expect(bucketOf({ kind: "data", builds: 10, n: 10, pct: 100, copies: 1 }, THRESHOLDS)).toBe("auto-include");
  });

  it("withholds the bucket when the sample is too small to support one", () => {
    expect(bucketOf({ kind: "data", builds: 3, n: 5, pct: 60, copies: 1 }, THRESHOLDS)).toBeNull();
    expect(bucketOf({ kind: "never", n: 5 }, THRESHOLDS)).toBeNull();
  });
});

describe("tierOf — the red-to-green scale", () => {
  const rate = (builds: number, n: number) =>
    ({ kind: "data", builds, n, pct: (100 * builds) / n, copies: 1 }) as const;

  it("walks the tiers as the pick rate climbs", () => {
    expect(tierOf(rate(0, 100), THRESHOLDS)).toBe("fringe"); //  0% but present in data
    expect(tierOf(rate(5, 100), THRESHOLDS)).toBe("fringe"); //  5%
    expect(tierOf(rate(15, 100), THRESHOLDS)).toBe("situational"); // 15%
    expect(tierOf(rate(27, 100), THRESHOLDS)).toBe("common"); // 27%
    expect(tierOf(rate(45, 100), THRESHOLDS)).toBe("popular"); // 45%
    expect(tierOf(rate(70, 100), THRESHOLDS)).toBe("core"); // 70%
    expect(tierOf(rate(90, 100), THRESHOLDS)).toBe("auto-include"); // 90%
  });

  it("puts each breakpoint in the higher tier", () => {
    expect(tierOf(rate(10, 100), THRESHOLDS)).toBe("situational");
    expect(tierOf(rate(20, 100), THRESHOLDS)).toBe("common");
    expect(tierOf(rate(35, 100), THRESHOLDS)).toBe("popular");
    expect(tierOf(rate(55, 100), THRESHOLDS)).toBe("core");
    expect(tierOf(rate(85, 100), THRESHOLDS)).toBe("auto-include");
  });

  // The median picked card sits at 20%, so the scale must not bottom out there —
  // that is the whole reason the breakpoints are not evenly spaced.
  it("lands the median card mid-scale rather than in the red", () => {
    expect(tierOf(rate(20, 100), THRESHOLDS)).toBe("common");
  });

  it("takes its top break from the season, so colour and bucket cannot disagree", () => {
    const lenient = { ...THRESHOLDS, autoInclude: 60 };
    expect(tierOf(rate(70, 100), lenient)).toBe("auto-include");
    expect(bucketOf(rate(70, 100), lenient)).toBe("auto-include");
  });

  it("colours a never-picked card, and only once the sample can support it", () => {
    expect(tierOf({ kind: "never", n: 38 }, THRESHOLDS)).toBe("never");
    expect(tierOf({ kind: "never", n: 3 }, THRESHOLDS)).toBeNull();
  });

  // If we will not state a percentage, we must not imply one with colour.
  it("stays uncoloured on a sample too thin to state a percentage", () => {
    expect(tierOf(rate(3, 3), THRESHOLDS)).toBeNull();
    expect(tierOf(rate(5, 5), THRESHOLDS)).toBe("auto-include");
  });

  it("has nothing to colour for the absence states", () => {
    expect(tierOf({ kind: "unplayed" }, THRESHOLDS)).toBeNull();
    expect(tierOf({ kind: "out-of-scope" }, THRESHOLDS)).toBeNull();
    expect(tierOf({ kind: "unknown" }, THRESHOLDS)).toBeNull();
  });
});
