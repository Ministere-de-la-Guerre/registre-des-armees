import { describe, expect, it } from "vitest";
import { BuildRepository, buildToSaved, exportAllBuilds, importAllBuilds, type CurrentBuild } from "./saves";
import { MemoryStorageAdapter } from "./storage";

function current(instances: string[]): CurrentBuild {
  return {
    build: { instances: instances.map((unitKey, i) => ({ id: `i${i}`, unitKey })), staffSlotUnitKey: null },
    config: { density: "comfortable", showCombatGenerals: true },
    factionKey: "ntw3_ac_test_x5_001",
    armyCorpsName: "Test Corps",
  };
}

describe("whole-save-set backup", () => {
  it("round-trips every build through export → import into a fresh device", () => {
    const src = new BuildRepository(new MemoryStorageAdapter());
    src.save(buildToSaved(current(["a", "a", "b"]), { name: "First" }));
    src.save(buildToSaved(current(["c"]), { name: "Second" }));

    const backup = exportAllBuilds(src);
    expect(backup.format).toBe("rda-builds-backup");
    expect(backup.builds).toHaveLength(2);

    const dest = new BuildRepository(new MemoryStorageAdapter());
    const summary = importAllBuilds(dest, JSON.stringify(backup));
    expect(summary).toEqual({ imported: 2, skipped: 0 });
    expect(dest.list().map((b) => b.name).sort()).toEqual(["First", "Second"]);
  });

  it("merges by id (re-importing the same backup does not duplicate)", () => {
    const repo = new BuildRepository(new MemoryStorageAdapter());
    repo.save(buildToSaved(current(["a"]), { name: "Only" }));
    const backup = JSON.stringify(exportAllBuilds(repo));
    importAllBuilds(repo, backup);
    importAllBuilds(repo, backup);
    expect(repo.list()).toHaveLength(1);
  });

  it("accepts a bare array and a single build; rejects junk", () => {
    const repo = new BuildRepository(new MemoryStorageAdapter());
    const single = buildToSaved(current(["a"]), { name: "Solo" });
    expect(importAllBuilds(repo, JSON.stringify([single]))?.imported).toBe(1);
    expect(importAllBuilds(repo, JSON.stringify(single))?.imported).toBe(1);
    expect(importAllBuilds(repo, "not json")).toBeNull();
    expect(importAllBuilds(repo, JSON.stringify({ nope: true }))).toEqual({ imported: 0, skipped: 1 });
  });
});
