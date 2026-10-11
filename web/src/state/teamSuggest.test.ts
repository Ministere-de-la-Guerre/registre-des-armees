import { describe, expect, it } from "vitest";
import type { CorpsEntry, CorpsIndex } from "../domain/types";
import { teamKeysByFaction } from "../domain/teamRule";
import { applySuggestedTeam, emptyPlan, fillPlaceholder, setSlotBuild, emptyBuildFor } from "./plan";
import {
  type TeamCandidate,
  candidatesOf,
  needsLiveValues,
  poolsFor,
  precomputedValue,
  reachableTotals,
  suggestTeams,
  teamModes,
  teamPools,
} from "./teamSuggest";
import { DEFAULT_OPTIMISE_SETTINGS } from "./optimiser";

const corps = (factionKey: string, rating: number | string, value?: { quantity: number; sizeBands?: number; quality?: number }): CorpsEntry => ({
  factionKey, name: `${rating}. ${factionKey}`, displayYear: "", displayRating: rating, order: 0, flag: null,
  postSelectionFlag: null, isArmyCorps: factionKey.includes("_ac_"), cardCount: 1, bestBuildValue: value ?? null,
});

const ac = (id: string, rating: number, value: number) => corps(`ntw3_ac_a11_x5_${id}`, rating, { quantity: value, sizeBands: value + 1 });
const index: CorpsIndex = {
  schemaVersion: 3,
  sides: [
    { side: "empire", theatres: [
      { theatre: "Russia (1812)", corps: [ac("1", 6, 9000), ac("2", 7, 10_500), ac("3", 8, 12_000), ac("4", 9, 13_000), ac("5", 10, 16_000)] },
      { theatre: "German Campaign (1813)", corps: [1, 2, 3, 4].map((i) => corps(`ntw3_ac_a16_x5_${i}`, 8, { quantity: 1 })) },
      { theatre: "Spain (1809)", corps: [ac("9", 8, 1)] },
    ] },
    { side: "tow_french_imperial", theatres: [{ theatre: "Theatres of War", corps: [
      corps("ntw3_tow_t1", 7, { quantity: 10_000, quality: 9_800 }), corps("ntw3_tow_t2", 8, { quantity: 11_000, quality: 11_500 }),
      corps("ntw3_tow_t3", 9, { quantity: 12_500, quality: 12_000 })] }] },
    { side: "custom", theatres: [{ theatre: "Custom Armies", corps: [
      corps("france", 9, { quantity: 13_000, quality: 12_900 }), corps("aaa_lordz", 1, { quantity: 1 }),
      corps("austria", "", { quantity: 5 })] }] },
  ],
};
const keys = teamKeysByFaction(index);

const cand = (name: string, points: number, value: number): TeamCandidate => ({ factionKey: name, name, points, value });

describe("teamPools", () => {
  const pools = teamPools(index, keys);

  it("keeps pools with four valued, rated armies and leaves out the work-in-progress 1813 theatre", () => {
    expect(pools.map((p) => [p.label, p.members.length])).toEqual([
      ["Imperial · Russia (1812)", 5],
      ["Imperial · Theatres of War + Custom", 5],     // 3 ToW + France + Lordz (rated 1); unrated Austria is out
    ]);
  });

  it("offers each pool its own value modes, and picks the pools a kept army allows", () => {
    expect(teamModes("ac")).toEqual(["quantity", "sizeBands"]);
    expect(teamModes("tow")).toEqual(["quantity", "quality"]);
    expect(poolsFor(pools, keys.get("ntw3_tow_t1")!).map((p) => p.kind)).toEqual(["tow"]);
    expect(poolsFor(pools, null)).toHaveLength(2);
    expect(precomputedValue(pools[0].members[0], "sizeBands")).toBe(9001);
  });
});

describe("suggestTeams", () => {
  const ru = candidatesOf(teamPools(index, keys)[0].members, (e) => precomputedValue(e, "quantity"));

  it("returns only teams at exactly the total, best total first", () => {
    const { teams } = suggestTeams(ru, { total: 32, criterion: "total" });
    expect(teams.length).toBeGreaterThan(0);
    for (const t of teams) expect(t.armies.reduce((s, a) => s + a.candidate.points, 0)).toBe(32);
    expect(teams.map((t) => t.total)).toEqual([...teams.map((t) => t.total)].sort((a, b) => b - a));
    // Of 6, 7, 8, 9 and 10, only 6 + 7 + 9 + 10 reaches 32 with four distinct corps.
    expect(teams[0].armies.map((a) => a.candidate.points).sort((a, b) => a - b)).toEqual([6, 7, 9, 10]);
  });

  it("ranks by the weakest army when asked, breaking ties by total", () => {
    const pool = [cand("a", 8, 100), cand("b", 8, 100), cand("c", 8, 100), cand("d", 8, 100), cand("e", 8, 90), cand("f", 8, 500)];
    const byTotal = suggestTeams(pool, { total: 32, criterion: "total" }).teams[0];
    const byWeakest = suggestTeams(pool, { total: 32, criterion: "weakest" }).teams[0];
    expect(byTotal.armies.map((a) => a.candidate.name)).toContain("f");
    expect(byWeakest.weakest).toBe(100);
    expect(byWeakest.armies.map((a) => a.candidate.name)).toContain("f");         // tie on weakest → higher total
    expect(byWeakest.armies.map((a) => a.candidate.name)).not.toContain("e");
  });

  it("keeps fixed armies, never offers them twice without repeats, and allows repeats when asked", () => {
    const pool = [cand("a", 6, 10), cand("b", 7, 20), cand("c", 8, 30)];
    const fixed = [pool[2]];
    const distinct = suggestTeams(pool, { total: 21, k: 3, criterion: "total", fixed });
    expect(distinct.teams.map((t) => t.armies.map((a) => `${a.candidate.name}${a.fixed ? "*" : ""}`))).toEqual([["c*", "a", "b"]]);
    const withRepeats = suggestTeams(pool, { total: 24, k: 3, criterion: "total", fixed, repeats: true });
    expect(withRepeats.teams[0].armies.map((a) => a.candidate.name)).toEqual(["c", "c", "c"]);
  });

  it("works for teams of three, and gives the nearest reachable totals when none fits", () => {
    const pool = [cand("a", 6, 10), cand("b", 7, 20), cand("c", 9, 30)];
    expect(suggestTeams(pool, { total: 22, k: 3, criterion: "total" }).teams).toHaveLength(1);
    const miss = suggestTeams(pool, { total: 25, k: 3, criterion: "total" });
    expect(miss.teams).toEqual([]);
    expect(miss.nearestTotals).toEqual([22]);
    expect([...reachableTotals(pool, { k: 2 }).keys()].sort((a, b) => a - b)).toEqual([13, 15, 16]);
  });
});

describe("needsLiveValues", () => {
  it("uses the precomputed values only at the default settings with nothing kept", () => {
    expect(needsLiveValues(DEFAULT_OPTIMISE_SETTINGS, 0)).toBe(false);
    expect(needsLiveValues({ ...DEFAULT_OPTIMISE_SETTINGS, maxCards: 20 }, 0)).toBe(true);
    expect(needsLiveValues({ ...DEFAULT_OPTIMISE_SETTINGS, allowNoStaff: true }, 0)).toBe(true);
    expect(needsLiveValues({ ...DEFAULT_OPTIMISE_SETTINGS, singleRoll: false }, 0)).toBe(true);
    expect(needsLiveValues(DEFAULT_OPTIMISE_SETTINGS, 1)).toBe(true);
  });
});

describe("applySuggestedTeam", () => {
  const team = [{ factionKey: "f1", name: "One" }, { factionKey: "f2", name: "Two" }, { factionKey: "f3", name: "Three" }];

  it("overwrites the whole plan, keeping slot ids and players in order", () => {
    const plan = emptyPlan();
    const { plan: next, placeholders } = applySuggestedTeam(plan, team);
    expect(next.slots.map((s) => s.build?.factionKey)).toEqual(["f1", "f2", "f3"]);
    expect(next.slots.map((s) => s.id)).toEqual(plan.slots.slice(0, 3).map((s) => s.id));
    expect(placeholders.map((p) => p.factionKey)).toEqual(["f1", "f2", "f3"]);
  });

  it("with kept slots fills only the empty ones, then adds slots up to four", () => {
    let plan = emptyPlan();
    plan = { ...plan, slots: plan.slots.slice(0, 2) };
    plan = setSlotBuild(plan, plan.slots[1].id, emptyBuildFor({ factionKey: "kept", name: "Kept" }));
    const { plan: next } = applySuggestedTeam(plan, team, new Set([plan.slots[1].id]));
    expect(next.slots.map((s) => s.build?.factionKey)).toEqual(["f1", "kept", "f2", "f3"]);
  });

  it("fills a placeholder only while the slot still holds it", () => {
    const { plan, placeholders } = applySuggestedTeam(emptyPlan(), team);
    const built = { ...emptyBuildFor({ factionKey: "f1", name: "One" }), instances: ["u1"] };
    const filled = fillPlaceholder(plan, placeholders[0], built);
    expect(filled.slots[0].build?.instances).toEqual(["u1"]);
    expect(filled.slots[0].build?.id).toBe(placeholders[0].buildId);
    const edited = setSlotBuild(plan, plan.slots[0].id, emptyBuildFor({ factionKey: "other", name: "Other" }));
    expect(fillPlaceholder(edited, placeholders[0], built)).toBe(edited);
  });
});
