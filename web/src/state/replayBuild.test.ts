import { describe, expect, it } from "vitest";
import type { ReplayArmy } from "../domain/replay";
import { makeRoster, makeUnit } from "../test/factories";
import { indexRoster, summarize } from "./build";
import { SAVE_FORMAT_VERSION } from "./saves";
import { replayArmyIssues, replayBuildName, resolveReplayArmy, savedBuildFromReplayArmy } from "./replayBuild";

const FACTION = "ntw3_ac_b09_x4_163";

function makeArmy(partial: Partial<ReplayArmy> = {}): ReplayArmy {
  return {
    factionKey: FACTION,
    corpsId: "163",
    side: "b09",
    player: "Tac",
    corpsName: "13. Wellesley / Peninsular",
    flag: "data\\ui\\flags\\f_09b_ac163",
    staffKey: "ntw3_gen_staff_163_8_0195",
    general: "Arthur Wellesley 'Wellington'",
    units: ["ntw3_inf_line_163_048_3031", "ntw3_inf_line_163_048_3031", "ntw3_inf_light_163_043_1366"].map((key) => ({
      key,
      name: "",
      regiment: "",
      officer: "",
      tier: "",
    })),
    ...partial,
  };
}

describe("replayBuildName", () => {
  it("combines the player and the corps", () => {
    expect(replayBuildName(makeArmy())).toBe("Tac — 13. Wellesley / Peninsular");
  });

  it("falls back to the corps alone for an AI army", () => {
    expect(replayBuildName(makeArmy({ player: "" }))).toBe("13. Wellesley / Peninsular");
  });

  it("falls back to the faction key when the corps has no name", () => {
    expect(replayBuildName(makeArmy({ player: "", corpsName: "" }))).toBe(FACTION);
  });
});

describe("savedBuildFromReplayArmy", () => {
  it("maps the army onto the saved-build shape", () => {
    const saved = savedBuildFromReplayArmy(makeArmy());
    expect(saved.saveFormatVersion).toBe(SAVE_FORMAT_VERSION);
    expect(saved.factionKey).toBe(FACTION);
    expect(saved.armyCorpsName).toBe("13. Wellesley / Peninsular");
    expect(saved.staffSlotUnitKey).toBe("ntw3_gen_staff_163_8_0195");
    expect(saved.name).toBe("Tac — 13. Wellesley / Peninsular");
  });

  it("keeps every fielded copy, in replay order", () => {
    expect(savedBuildFromReplayArmy(makeArmy()).instances).toEqual([
      "ntw3_inf_line_163_048_3031",
      "ntw3_inf_line_163_048_3031",
      "ntw3_inf_light_163_043_1366",
    ]);
  });

  it("takes an explicit name over the default", () => {
    expect(savedBuildFromReplayArmy(makeArmy(), "  Wellington at Talavera  ").name).toBe("Wellington at Talavera");
  });

  it("ignores a blank name", () => {
    expect(savedBuildFromReplayArmy(makeArmy(), "   ").name).toBe("Tac — 13. Wellesley / Peninsular");
  });
});

describe("resolveReplayArmy", () => {
  const roster = makeRoster(
    [
      makeUnit({ unitKey: "ntw3_inf_line_163_048_3031", factionKey: FACTION, cap: 2, groupCap: 2 }),
      makeUnit({ unitKey: "ntw3_inf_light_163_043_1366", factionKey: FACTION }),
      makeUnit({ unitKey: "ntw3_gen_staff_163_8_0195", factionKey: FACTION, isGeneral: true, generalKind: "staff" }),
    ],
    FACTION,
  );

  it("resolves every copy as its own instance", () => {
    const { build, missingKeys } = resolveReplayArmy(makeArmy(), roster);
    expect(build.instances.map((i) => i.unitKey)).toEqual([
      "ntw3_inf_line_163_048_3031",
      "ntw3_inf_line_163_048_3031",
      "ntw3_inf_light_163_043_1366",
    ]);
    expect(build.staffSlotUnitKey).toBe("ntw3_gen_staff_163_8_0195");
    expect(missingKeys).toEqual([]);
  });

  it("gives each copy a distinct instance id so the tray can remove them singly", () => {
    const { build } = resolveReplayArmy(makeArmy(), roster);
    expect(new Set(build.instances.map((i) => i.id)).size).toBe(3);
  });

  it("drops and reports units the current dataset does not know", () => {
    const army = makeArmy({
      units: [{ key: "ntw3_inf_line_163_999_9999", name: "", regiment: "", officer: "", tier: "" }],
      staffKey: "ntw3_gen_staff_163_8_0195",
    });
    const { build, missingKeys } = resolveReplayArmy(army, roster);
    expect(build.instances).toEqual([]);
    expect(missingKeys).toEqual(["ntw3_inf_line_163_999_9999"]);
  });

  it("clears a staff general that is missing from the roster", () => {
    const { build, missingKeys } = resolveReplayArmy(makeArmy({ staffKey: "ntw3_gen_staff_163_9_9999" }), roster);
    expect(build.staffSlotUnitKey).toBeNull();
    expect(missingKeys).toEqual(["ntw3_gen_staff_163_9_9999"]);
  });

  it("handles an army with no staff general", () => {
    const { build, missingKeys } = resolveReplayArmy(makeArmy({ staffKey: null }), roster);
    expect(build.staffSlotUnitKey).toBeNull();
    expect(missingKeys).toEqual([]);
  });
});

describe("replayArmyIssues", () => {
  /** Summarise `copies` copies of a unit costing `cost` each. */
  function summaryFor(cost: number, copies: number) {
    const card = makeUnit({ unitKey: "u_costly", factionKey: FACTION, cost, cap: 40, groupCap: 40 });
    const index = indexRoster(makeRoster([card], FACTION));
    return summarize(index, {
      instances: Array.from({ length: copies }, (_, i) => ({ id: `i${i}`, unitKey: "u_costly" })),
      staffSlotUnitKey: null,
    });
  }

  it("says nothing about an army inside the limit", () => {
    expect(replayArmyIssues(summaryFor(1000, 9))).toEqual([]);
  });

  it("reports an army over the cost ceiling, with the overage", () => {
    // 12 × 1,000 = 12,000, i.e. 2,000 over the 10,000 ceiling.
    const issues = replayArmyIssues(summaryFor(1000, 12));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("12,000 MP");
    expect(issues[0]).toContain("2,000 over");
    expect(issues[0]).toContain("higher funds level");
  });

  it("does not fire exactly at the ceiling", () => {
    expect(replayArmyIssues(summaryFor(1000, 10))).toEqual([]);
  });

  it("passes through the rules engine's own limit violations", () => {
    // 34 cheap copies: under cost, but over the 31-card maximum.
    const issues = replayArmyIssues(summaryFor(10, 34));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.join(" ")).toMatch(/31/);
  });
});
