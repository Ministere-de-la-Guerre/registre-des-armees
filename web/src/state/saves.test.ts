import { describe, expect, it } from "vitest";
import { makeRoster, makeUnit } from "../test/factories";
import type { BuildState } from "./build";
import {
  BuildRepository,
  type CurrentBuild,
  buildToSaved,
  exportBuildJson,
  importBuildJson,
  isDirty,
  migrateSavedBuild,
  resolveSavedBuild,
} from "./saves";
import { MemoryStorageAdapter, type StorageAdapter, type StorageResult } from "./storage";

function build(instances: string[], staff: string | null = null): BuildState {
  return { instances: instances.map((unitKey, i) => ({ id: `i${i}`, unitKey })), staffSlotUnitKey: staff };
}

function current(b: BuildState): CurrentBuild {
  return {
    build: b,
    config: { density: "comfortable", showCombatGenerals: true },
    factionKey: "ntw3_ac_test_x5_001",
    armyCorpsName: "Test Corps",
  };
}

describe("BuildRepository", () => {
  it("Save As stores a named build and lists it", () => {
    const repo = new BuildRepository(new MemoryStorageAdapter());
    repo.save(buildToSaved(current(build(["a", "a", "b"])), { name: "My Build" }));
    const all = repo.list();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("My Build");
    expect(all[0].instances).toEqual(["a", "a", "b"]);
  });

  it("duplicate-name detection via findByName", () => {
    const repo = new BuildRepository(new MemoryStorageAdapter());
    repo.save(buildToSaved(current(build(["a"])), { name: "Alpha" }));
    expect(repo.findByName("alpha")).toBeDefined();
    expect(repo.findByName("Beta")).toBeUndefined();
  });

  it("findByName scopes by corps so two corps can share a build name", () => {
    const repo = new BuildRepository(new MemoryStorageAdapter());
    const corpsA: CurrentBuild = { ...current(build(["a"])), factionKey: "ntw3_ac_aaa_x5_001", armyCorpsName: "A" };
    const corpsB: CurrentBuild = { ...current(build(["b"])), factionKey: "ntw3_ac_bbb_x5_001", armyCorpsName: "B" };
    repo.save(buildToSaved(corpsA, { name: "Shared" }));
    repo.save(buildToSaved(corpsB, { name: "Shared" }));
    // Both builds coexist, each pointing at its own corps.
    expect(repo.list()).toHaveLength(2);
    const a = repo.findByName("Shared", "ntw3_ac_aaa_x5_001");
    const b = repo.findByName("Shared", "ntw3_ac_bbb_x5_001");
    expect(a?.factionKey).toBe("ntw3_ac_aaa_x5_001");
    expect(a?.instances).toEqual(["a"]);
    expect(b?.factionKey).toBe("ntw3_ac_bbb_x5_001");
    expect(b?.instances).toEqual(["b"]);
    expect(a?.id).not.toBe(b?.id);
  });

  it("updating an existing named build keeps its id and created time", () => {
    const repo = new BuildRepository(new MemoryStorageAdapter());
    const first = buildToSaved(current(build(["a"])), { name: "Build" });
    repo.save(first);
    const updated = buildToSaved(current(build(["a", "b"])), { id: first.id, name: "Build", createdAt: first.createdAt });
    repo.save(updated);
    const all = repo.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(first.id);
    expect(all[0].createdAt).toBe(first.createdAt);
    expect(all[0].instances).toEqual(["a", "b"]);
  });

  it("rename, duplicate, and delete", () => {
    const repo = new BuildRepository(new MemoryStorageAdapter());
    const saved = buildToSaved(current(build(["a"])), { name: "Old" });
    repo.save(saved);
    repo.rename(saved.id, "New");
    expect(repo.get(saved.id)!.name).toBe("New");
    const { copy } = repo.duplicate(saved.id);
    expect(copy!.name).toBe("New (copy)");
    expect(copy!.id).not.toBe(saved.id);
    expect(repo.list()).toHaveLength(2);
    repo.remove(saved.id);
    expect(repo.list()).toHaveLength(1);
  });

  it("reports storage adapter failure without throwing", () => {
    const failing: StorageAdapter = {
      available: true,
      read: () => null,
      write: (): StorageResult => ({ ok: false, error: "Storage quota exceeded." }),
      remove: () => {},
    };
    const repo = new BuildRepository(failing);
    const result = repo.save(buildToSaved(current(build(["a"])), { name: "X" }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/quota/i);
  });
});

describe("serialization + migration", () => {
  it("export/import round trip", () => {
    const saved = buildToSaved(current(build(["a", "a", "b"], "g1")), { name: "Export Me" });
    const imported = importBuildJson(exportBuildJson(saved));
    expect(imported).not.toBeNull();
    expect(imported!.instances).toEqual(["a", "a", "b"]);
    expect(imported!.staffSlotUnitKey).toBe("g1");
  });

  it("malformed JSON / missing faction import returns null", () => {
    expect(importBuildJson("{not json")).toBeNull();
    expect(importBuildJson("{}")).toBeNull();
  });

  it("migrates legacy v1 selection record into instances", () => {
    const migrated = migrateSavedBuild({ factionKey: "f", selection: { a: 2, b: 1 } });
    expect(migrated).not.toBeNull();
    expect(migrated!.saveFormatVersion).toBe(2);
    expect([...migrated!.instances].sort()).toEqual(["a", "a", "b"]);
  });

  it("migrates legacy array-of-keys", () => {
    const migrated = migrateSavedBuild({ factionKey: "f", unitKeys: ["a", "a", "b"] });
    expect(migrated!.instances).toEqual(["a", "a", "b"]);
  });

  it("malformed stored list yields empty list, not a crash", () => {
    const adapter = new MemoryStorageAdapter();
    adapter.write("rda.savedBuilds", "{not an array");
    expect(new BuildRepository(adapter).list()).toEqual([]);
  });
});

describe("resolve + dirty", () => {
  it("restores duplicate copies as separate instances and reports missing keys", () => {
    const roster = makeRoster([makeUnit({ unitKey: "a" }), makeUnit({ unitKey: "g1", isGeneral: true })]);
    const saved = buildToSaved(current(build(["a", "a", "ghost"], "missing_general")), { name: "Partial" });
    const result = resolveSavedBuild(saved, roster);
    expect(result.build.instances.map((i) => i.unitKey)).toEqual(["a", "a"]);
    expect(result.build.instances[0].id).not.toBe(result.build.instances[1].id);
    expect(result.build.staffSlotUnitKey).toBeNull();
    expect(result.missingKeys.sort()).toEqual(["ghost", "missing_general"]);
  });

  it("detects unsaved changes", () => {
    const cur = current(build(["a", "b"]));
    expect(isDirty(cur, null)).toBe(true);
    const saved = buildToSaved(cur, { name: "S" });
    expect(isDirty(cur, saved)).toBe(false);
    const changed = current(build(["a"]));
    expect(isDirty(changed, saved)).toBe(true);
  });
});
