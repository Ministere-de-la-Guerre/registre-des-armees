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
    expect(summary).toEqual({ imported: 2, skipped: 0, keptNewer: 0 });
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
    expect(importAllBuilds(repo, JSON.stringify({ nope: true }))).toEqual({ imported: 0, skipped: 1, keptNewer: 0 });
  });

  it("never reverts a build edited since the backup was taken", () => {
    const repo = new BuildRepository(new MemoryStorageAdapter());
    const old = { ...buildToSaved(current(["a"]), { name: "Kept" }), updatedAt: "2026-01-01T00:00:00.000Z" };
    repo.save(old);
    const backup = JSON.stringify(exportAllBuilds(repo));
    // Edit after the backup.
    repo.save({ ...old, instances: ["a", "b"], updatedAt: "2026-02-01T00:00:00.000Z" });

    const summary = importAllBuilds(repo, backup);
    expect(summary).toEqual({ imported: 0, skipped: 0, keptNewer: 1 });
    expect(repo.get(old.id)?.instances).toEqual(["a", "b"]);
  });

  it("an undated legacy entry never replaces an existing copy", () => {
    const repo = new BuildRepository(new MemoryStorageAdapter());
    const saved = buildToSaved(current(["a", "b"]), { name: "Mine" });
    repo.save(saved);
    const legacy = { id: saved.id, factionKey: saved.factionKey, selection: { a: 1 } };
    expect(importAllBuilds(repo, JSON.stringify([legacy]))?.keptNewer).toBe(1);
    expect(repo.get(saved.id)?.instances).toEqual(["a", "b"]);
  });

  it("restores a backup entry that is newer than the copy on the device", () => {
    const repo = new BuildRepository(new MemoryStorageAdapter());
    const stamp = "2026-01-01T00:00:00.000Z";
    const saved = { ...buildToSaved(current(["a"]), { name: "Same" }), updatedAt: stamp };
    repo.save(saved);
    const incoming = { ...saved, instances: ["c"], updatedAt: "2026-03-01T00:00:00.000Z" };
    expect(importAllBuilds(repo, JSON.stringify([incoming]))).toEqual({ imported: 1, skipped: 0, keptNewer: 0 });
    expect(repo.get(saved.id)?.instances).toEqual(["c"]);
  });
});
