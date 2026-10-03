import { describe, expect, it } from "vitest";
import type { CorpsEntry } from "../domain/types";
import { makeRoster, makeUnit } from "../test/factories";
import { indexRoster } from "./build";
import type { PlanSlot } from "./plan";
import { planStats } from "./planStats";
import { planPoints, pointsBreakdown, pointsTooltip, shareSegments, speedMix, warningText } from "./planSummary";

describe("speedMix", () => {
  it("sorts tags by letter, then number, and skips zeros", () => {
    expect(speedMix({ C4: 2, C3: 2, C10: 1, F3: 0 })).toBe("C3 ×2 · C4 ×2 · C10 ×1");
    expect(speedMix({ L1: 1, C3: 3, F3: 2 })).toBe("C3 ×3 · F3 ×2 · L1 ×1");
    expect(speedMix({})).toBe("");
  });
});

describe("shareSegments", () => {
  it("gives whole percents of cards, men and gold, zero when empty", () => {
    const segs = shareSegments({
      infantry: { cards: 3, men: 300, gold: 1000 },
      cavalry: { cards: 1, men: 100, gold: 1000 },
      artillery: { cards: 0, men: 0, gold: 2000 },
      staff: { cards: 4, men: 400, gold: 9000 },
    });
    // Staff is excluded, from the segments and from the denominator.
    expect(segs.map((s) => s.arm)).toEqual(["infantry", "cavalry", "artillery"]);
    expect(segs.map((s) => s.cardsPct)).toEqual([75, 25, 0]);
    expect(segs.map((s) => s.menPct)).toEqual([75, 25, 0]);
    expect(segs.map((s) => s.goldPct)).toEqual([25, 25, 50]);
    expect(shareSegments(planStats([]).share).every((s) => s.goldPct === 0)).toBe(true);
  });
});

describe("warningText", () => {
  it("names the army that is over budget", () => {
    const index = indexRoster(
      makeRoster([
        makeUnit({ unitKey: "hus", unitClass: "cavalry_light", underlyingUnitClass: "cavalry_light", cost: 6000, finalMen: 60, cap: 9, groupCap: 9 }),
        makeUnit({ unitKey: "line", cost: 6000, cap: 9, groupCap: 9 }),
      ]),
    );
    const build = { instances: ["hus", "line"].map((unitKey, i) => ({ id: `i${i}`, unitKey })), staffSlotUnitKey: null };
    const stats = planStats([null, { index, build }]);
    expect(warningText(stats.warnings[0])).toMatch(/^Army 2: .* over budget$/);
  });
});

describe("planPoints", () => {
  const entry = (factionKey: string, displayRating: string | number, name = factionKey) =>
    ({ factionKey, displayRating, name }) as unknown as CorpsEntry;
  const entries = new Map<string, CorpsEntry>([
    ["a", entry("a", 10)],
    ["b", entry("b", "8")],
    ["lordz", entry("lordz", "", "Lordz")],
  ]);
  const slot = (factionKey: string | null) =>
    ({ build: factionKey ? { factionKey, armyCorpsName: factionKey } : null }) as unknown as PlanSlot;

  it("sums the ratings of slots with a corps; empty slots count 0", () => {
    const p = planPoints([slot("a"), slot(null), slot("b"), slot("a")], entries);
    expect(p.total).toBe(28);
    expect(p.byArmy).toEqual([10, null, 8, 10]);
    expect(p.unrated).toEqual([]);
    const slots = [slot("a"), slot(null), slot("b"), slot("a")];
    expect(pointsBreakdown(p, slots)).toBe("Army 1: 10 · Army 3: 8 · Army 4: 10");
  });

  it("leaves unrated corps out of the total and names them", () => {
    const slots3 = [slot("a"), slot("lordz"), slot("missing")];
    const p = planPoints(slots3, entries);
    expect(p.total).toBe(10);
    expect(p.byArmy).toEqual([10, null, null]);
    expect(p.unrated).toEqual(["Lordz", "missing"]);
    expect(pointsTooltip(p, slots3)).toBe("Army 1: 10 · Army 2: – · Army 3: –\nLordz, missing have no rating and aren't counted.");
  });
});
