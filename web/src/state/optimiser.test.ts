import type { FactionRoster, OptimiserParams, UnitCard } from "../domain/types";
import { makeUnit } from "../test/factories";
import { nodeSolver } from "../test/highs";
import { type BuildState, emptyBuild, indexRoster, summarize } from "./build";
import { DEFAULT_OPTIMISE_SETTINGS, type OptimiseSettings, buildOptimiseProblem, optimiseBuild } from "./optimiser";

const TOW = "ntw3_tow_a01_x8_001";
const PARAMS: OptimiserParams = {
  t3B: 100, t3Q: 1, mRef: 10, lambda: { quality: 0, quantity: 0 },
  speedBonus: 0.02, meleeBonus: 0, standardGeneralMelee: 3,
};

/** A valued unit card; `corps` gives it a ToW key and source corps. */
function unit(key: string, cost: number, value: number, extra: Partial<UnitCard> & { corps?: string } = {}): UnitCard {
  const { corps, ...partial } = extra;
  const unitKey = corps ? `ntw3_inf_line_${corps}_001_${key}_tow_001` : key;
  return makeUnit({
    unitKey, factionKey: TOW, cost, cap: 0, groupCap: 0, placement: null, towSourceCorpsId: corps ?? null,
    optimiserValue: { quality: value, quantity: value }, ...partial,
  });
}

function staff(key: string, stars: number, cost: number, extra: Partial<UnitCard> = {}): UnitCard {
  return makeUnit({
    unitKey: key, factionKey: TOW, unitClass: "general", underlyingUnitClass: "general", isGeneral: true,
    generalKind: "staff", commandStars: stars, cost, cap: 1, groupCap: 1, menRaw: 32, placement: null,
    stats: { morale: 12, meleeAttack: 3 } as UnitCard["stats"], ...extra,
  });
}

function rosterOf(cards: UnitCard[], factionKey = TOW, optimiser: OptimiserParams | null = PARAMS): FactionRoster {
  return { schemaVersion: 2, factionKey, armyCorpsName: "Test", cards: cards.map((c) => ({ ...c, factionKey })), optimiser };
}

async function run(roster: FactionRoster, settings: Partial<OptimiseSettings> = {}, current: BuildState = emptyBuild(),
                   candidates: readonly UnitCard[] = roster.cards) {
  const index = indexRoster(roster);
  const outcome = await optimiseBuild(roster, index, current, candidates, { ...DEFAULT_OPTIMISE_SETTINGS, ...settings },
                                      await nodeSolver());
  return { index, outcome };
}

function okBuild(r: Awaited<ReturnType<typeof run>>) {
  if (!r.outcome.ok) throw new Error(r.outcome.error);
  const summary = summarize(r.index, r.outcome.build);
  expect(summary.limits.violations).toEqual([]);
  expect(summary.price.finalCost).toBeLessThanOrEqual(10_000);
  return r.outcome.build;
}

const keysOf = (b: BuildState) => b.instances.map((i) => i.unitKey);

describe("optimiseBuild", () => {
  const line = unit("line", 300, 450, { cap: 6, groupCap: 6 });
  const light = unit("light", 400, 520, { cap: 4, groupCap: 4 });
  const militia = unit("militia", 150, 160);
  const general = staff("gen2", 2, 200);
  const roster = rosterOf([line, light, militia, general]);

  it("fills a legal build with one staff general", async () => {
    const build = okBuild(await run(roster));
    expect(build.staffSlotUnitKey).toBe("gen2");
    expect(build.instances.length + 1).toBeLessThanOrEqual(31);
    expect(keysOf(build).filter((k) => k === "line")).toHaveLength(6);   // best value per gold, up to its cap
  });

  it("honours the card cap, staff general included", async () => {
    const build = okBuild(await run(roster, { maxCards: 5 }));
    expect(build.instances.length + 1).toBe(5);
  });

  it("leaves the slot empty only when allowed and worth it", async () => {
    const cheapStaff = staff("gen0", 0, 1);
    const r = rosterOf([unit("elite", 100, 1000), cheapStaff]);
    const withStaff = okBuild(await run(r, { maxCards: 3 }));
    expect(withStaff.staffSlotUnitKey).toBe("gen0");
    expect(withStaff.instances).toHaveLength(2);
    const without = okBuild(await run(r, { maxCards: 3, allowNoStaff: true }));
    expect(without.staffSlotUnitKey).toBeNull();
    expect(without.instances).toHaveLength(3);
  });

  it("in remainder mode keeps the build and the caps it already uses", async () => {
    const current: BuildState = {
      instances: [{ id: "a", unitKey: "light" }, { id: "b", unitKey: "light" }, { id: "c", unitKey: "light" },
                  { id: "d", unitKey: "light" }],
      staffSlotUnitKey: "gen2",
    };
    const build = okBuild(await run(roster, { remainder: true }, current));
    expect(build.instances.slice(0, 4).map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
    expect(build.staffSlotUnitKey).toBe("gen2");
    expect(keysOf(build).filter((k) => k === "light")).toHaveLength(4);    // its cap was already full
    expect(build.instances.length).toBeGreaterThan(4);
  });

  it("only uses the candidate cards", async () => {
    const build = okBuild(await run(roster, {}, emptyBuild(), [light, militia, general]));
    expect(keysOf(build)).not.toContain("line");
  });

  it("allows at most one combat general", async () => {
    const lineA = unit("lineA", 300, 300, { cap: 3, groupCap: 3 });
    const lineB = unit("lineB", 300, 300, { cap: 3, groupCap: 3 });
    const genA = unit("lineA_com_0001", 250, 900, { isGeneral: true, isCommanderVariant: true, generalKind: "combat",
                                                    unitClass: "general", capGroupKey: "lineA", baseUnitKey: "lineA", cap: 3,
                                                    groupCap: 3 });
    const genB = unit("lineB_com_0002", 250, 900, { isGeneral: true, isCommanderVariant: true, generalKind: "combat",
                                                    unitClass: "general", capGroupKey: "lineB", baseUnitKey: "lineB", cap: 3,
                                                    groupCap: 3 });
    const build = okBuild(await run(rosterOf([lineA, lineB, genA, genB, general])));
    expect(keysOf(build).filter((k) => k.includes("_com_"))).toHaveLength(1);
  });

  it("keeps foot artillery within its cap", async () => {
    const guns = unit("guns", 200, 800, { unitClass: "artillery_foot", underlyingUnitClass: "artillery_foot" });
    const build = okBuild(await run(rosterOf([guns, militia, general])));
    expect(keysOf(build).filter((k) => k === "guns")).toHaveLength(2);
  });

  it("with Single roll draws on at most 4 source corps, staff general included", async () => {
    const corps = ["101", "102", "103", "104", "105", "106"];
    const cards = [...corps.map((c, i) => unit(`u${i}`, 500, 900 + i, { corps: c, cap: 1, groupCap: 1 })),
                   staff("ntw3_gen_staff_101_2_0001_tow_001", 2, 200, { towSourceCorpsId: "101" })];
    const r = rosterOf(cards);
    const corpsOf = (b: BuildState) => new Set([...keysOf(b), b.staffSlotUnitKey ?? ""]
      .map((k) => cards.find((c) => c.unitKey === k)?.towSourceCorpsId).filter(Boolean));
    expect(corpsOf(okBuild(await run(r))).size).toBeLessThanOrEqual(4);
    expect(corpsOf(okBuild(await run(r, { singleRoll: false }))).size).toBe(6);
  });

  it("explains why no build can be made", async () => {
    const r = await run(roster, {}, emptyBuild(), [line, militia]);
    expect(r.outcome).toEqual({ ok: false, error: expect.stringContaining("No staff general") });
    const pricey = rosterOf([unit("pricey", 5000, 5500), general]);
    const broke: BuildState = { instances: [{ id: "p1", unitKey: "pricey" }, { id: "p2", unitKey: "pricey" }],
                                staffSlotUnitKey: null };
    expect((await run(pricey, { remainder: true }, broke)).outcome).toEqual({ ok: false, error: expect.stringContaining("funds") });
    const full: BuildState = { instances: Array.from({ length: 31 }, (_, i) => ({ id: `i${i}`, unitKey: "militia" })),
                               staffSlotUnitKey: null };
    expect((await run(roster, { remainder: true }, full)).outcome).toEqual({ ok: false, error: expect.stringContaining("31 cards") });
    const index = indexRoster(roster);
    expect(buildOptimiseProblem(rosterOf(roster.cards, TOW, null), index, emptyBuild(), roster.cards, DEFAULT_OPTIMISE_SETTINGS))
      .toEqual({ error: expect.stringContaining("No optimiser data") });
  });
});
