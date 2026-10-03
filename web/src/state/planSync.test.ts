import { describe, expect, it } from "vitest";
import { slotBuildFromCurrent } from "./planSync";
import { type CurrentBuild, type SavedBuild, buildToSaved } from "./saves";

const config = { density: "compact" as const, showCombatGenerals: true };
const current = (factionKey: string, unitKeys: string[], staff: string | null = null): CurrentBuild => ({
  build: { instances: unitKeys.map((unitKey, i) => ({ id: `i${i}`, unitKey })), staffSlotUnitKey: staff },
  config,
  factionKey,
  armyCorpsName: "Corps of Test",
});

describe("slotBuildFromCurrent", () => {
  it("names a new slot after its corps", () => {
    const saved = slotBuildFromCurrent(null, current("f1", ["a", "b"]));
    expect(saved.name).toBe("Corps of Test");
    expect(saved.instances).toEqual(["a", "b"]);
  });

  it("keeps the slot's id, name and creation time across edits", () => {
    const prev: SavedBuild = buildToSaved(current("f1", ["a"]), { name: "My army", createdAt: "2020-01-01T00:00:00.000Z" });
    const next = slotBuildFromCurrent(prev, current("f1", ["a", "b"], "gen"));
    expect(next.id).toBe(prev.id);
    expect(next.name).toBe("My army");
    expect(next.createdAt).toBe(prev.createdAt);
    expect(next.instances).toEqual(["a", "b"]);
    expect(next.staffSlotUnitKey).toBe("gen");
  });

  it("keeps the slot's config rather than the builder's defaults", () => {
    const prev: SavedBuild = buildToSaved(
      { ...current("f1", ["a"]), config: { density: "comfortable" as const, showCombatGenerals: false } },
      { name: "My army" },
    );
    const next = slotBuildFromCurrent(prev, current("f1", ["a", "b"]));
    expect(next.config).toEqual(prev.config);
    expect(slotBuildFromCurrent(null, current("f1", ["a"])).config).toEqual(config);
  });

  it("does not carry a build over from a different corps", () => {
    const prev = buildToSaved(current("f1", ["a"]), { name: "Old" });
    const next = slotBuildFromCurrent(prev, current("f2", ["z"]));
    expect(next.id).not.toBe(prev.id);
    expect(next.name).toBe("Corps of Test");
  });
});
