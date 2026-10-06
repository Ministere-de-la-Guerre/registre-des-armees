import { describe, expect, it } from "vitest";
import type { ReplayArmy, ReplayBattle } from "../domain/replay";
import { planFromReplayArmies, replayPlanName } from "./replayPlan";

const army = (player: string, n: number): ReplayArmy => ({
  factionKey: `ntw3_ac_${n}`,
  corpsId: String(n),
  side: "b09",
  player,
  corpsName: `Corps ${n}`,
  flag: "",
  staffKey: `staff_${n}`,
  general: "G",
  units: [{ key: `u_${n}`, name: "", regiment: "", officer: "", tier: "" }],
});

const battle = (count: number): ReplayBattle => ({
  gameBuild: "",
  map: "Austerlitz",
  victoryCondition: "",
  wind: "",
  armies: Array.from({ length: count }, (_, i) => army(`P${i}`, i)),
  warnings: [],
});

describe("replayPlanName", () => {
  it("joins the map and the file name without extension", () => {
    expect(replayPlanName(battle(2), "my_match.replay")).toBe("Austerlitz — my match");
  });
  it("falls back when both are empty", () => {
    expect(replayPlanName({ ...battle(2), map: "" }, "")).toBe("Replay team");
  });
});

describe("planFromReplayArmies", () => {
  it("builds a new unsaved plan with one slot per ticked army, in replay order", () => {
    const { plan, loadedPlanId } = planFromReplayArmies(battle(6), [3, 1], "g.replay");
    expect(loadedPlanId).toBeNull();
    expect(plan.name).toBe("Austerlitz — g");
    expect(plan.slots.map((s) => s.player)).toEqual(["P1", "P3"]);
    expect(plan.slots[0].build).toMatchObject({ factionKey: "ntw3_ac_1", staffSlotUnitKey: "staff_1", name: "P1 — Corps 1" });
    expect(new Set(plan.slots.map((s) => s.id)).size).toBe(2);
  });
  it("ignores bad or repeated indices and caps at four", () => {
    const { plan } = planFromReplayArmies(battle(8), [0, 0, 9, -1, 1, 2, 3, 4], "g.replay");
    expect(plan.slots.map((s) => s.player)).toEqual(["P0", "P1", "P2", "P3"]);
  });
  it("keeps one empty slot when no index is valid", () => {
    for (const picks of [[], [9, -1, 1.5]]) {
      const { plan } = planFromReplayArmies(battle(3), picks, "g.replay");
      expect(plan.slots).toHaveLength(1);
      expect(plan.slots[0].build).toBeNull();
      expect(plan.slots[0].player).toBe("");
    }
    expect(planFromReplayArmies(battle(0), [0], "g.replay").plan.slots).toHaveLength(1);
  });
});
