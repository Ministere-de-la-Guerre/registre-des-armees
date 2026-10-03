import { describe, expect, it } from "vitest";
import {
  MAX_PLAN_ARMIES,
  PlanRepository,
  addSlot,
  clearSlot,
  copySavedBuildIntoSlot,
  emptyPlan,
  exportPlanJson,
  importPlanJson,
  isPlanDirty,
  isPlanEmpty,
  loadCurrentPlan,
  migratePlan,
  rawPlanSlotCount,
  moveSlot,
  removeSlot,
  renamePlan,
  saveCurrentPlan,
  setSlotBuild,
  setSlotPlayer,
} from "./plan";
import { type SavedBuild, buildToSaved } from "./saves";
import { MemoryStorageAdapter } from "./storage";

function saved(instances: string[], staff: string | null = null): SavedBuild {
  return buildToSaved(
    {
      build: { instances: instances.map((unitKey, i) => ({ id: `i${i}`, unitKey })), staffSlotUnitKey: staff },
      config: { density: "comfortable", showCombatGenerals: true },
      factionKey: "ntw3_ac_test_x5_001",
      armyCorpsName: "Test Corps",
    },
    { name: "B" },
  );
}

describe("plan editing", () => {
  it("starts with four empty slots", () => {
    const p = emptyPlan();
    expect(p.slots).toHaveLength(MAX_PLAN_ARMIES);
    expect(p.name).toBe("Untitled plan");
    expect(new Set(p.slots.map((s) => s.id)).size).toBe(4);
  });

  it("addSlot is a no-op at 4, removeSlot never goes below 1", () => {
    let p = emptyPlan();
    expect(addSlot(p)).toBe(p);
    while (p.slots.length > 1) p = removeSlot(p, p.slots[0].id);
    expect(removeSlot(p, p.slots[0].id)).toBe(p);
    expect(addSlot(p).slots).toHaveLength(2);
  });

  it("moves slots and stops at the ends", () => {
    const p = emptyPlan();
    const [a, b] = p.slots;
    expect(moveSlot(p, a.id, -1)).toBe(p);
    expect(moveSlot(p, a.id, 1).slots.slice(0, 2).map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it("sets and clears a slot's build and player without touching the original plan", () => {
    const p = emptyPlan();
    const id = p.slots[1].id;
    const q = setSlotPlayer(setSlotBuild(p, id, saved(["a"])), id, "Ann");
    expect(p.slots[1].build).toBeNull();
    expect(q.slots[1]).toMatchObject({ player: "Ann", build: { instances: ["a"] } });
    expect(clearSlot(q, id).slots[1].build).toBeNull();
    expect(renamePlan(q, "  Duel ").name).toBe("Duel");
    expect(renamePlan(q, "  ").name).toBe(q.name);
  });

  it("slots hold copies under a fresh id", () => {
    const original = saved(["a", "b"]);
    const copy = copySavedBuildIntoSlot(original);
    expect(copy.id).not.toBe(original.id);
    copy.instances.push("c");
    expect(original.instances).toEqual(["a", "b"]);
  });
});

describe("migratePlan", () => {
  it("rejects non-plans and clamps slot count", () => {
    expect(migratePlan(null)).toBeNull();
    expect(migratePlan({ name: "x" })).toBeNull();
    expect(migratePlan({ slots: [] })?.slots).toHaveLength(1);
    expect(migratePlan({ slots: Array.from({ length: 9 }, () => ({})) })?.slots).toHaveLength(4);
  });

  it("turns a bad slot or bad build into an empty slot, keeping good ones", () => {
    const p = migratePlan({ slots: ["junk", { player: "Bo", build: { nope: 1 } }, { build: saved(["a"]) }] })!;
    expect(p.slots[0].build).toBeNull();
    expect(p.slots[1]).toMatchObject({ player: "Bo", build: null });
    expect(p.slots[2].build?.instances).toEqual(["a"]);
  });

  it("gives the same id to the same id-less plan every time", () => {
    const raw = { name: "Old", slots: [{}] };
    expect(migratePlan(raw)?.id).toBe(migratePlan(raw)?.id);
  });
});

describe("isPlanDirty", () => {
  it("ignores copy order but sees real changes", () => {
    let p = emptyPlan();
    p = setSlotBuild(p, p.slots[0].id, saved(["a", "b"], "g"));
    const same = setSlotBuild(p, p.slots[0].id, saved(["b", "a"], "g"));
    expect(isPlanDirty(same, p)).toBe(false);
    expect(isPlanDirty(setSlotBuild(p, p.slots[0].id, saved(["a", "b"], "h")), p)).toBe(true);
    expect(isPlanDirty(setSlotPlayer(p, p.slots[0].id, "Z"), p)).toBe(true);
    expect(isPlanDirty(renamePlan(p, "Other"), p)).toBe(true);
    expect(isPlanDirty(moveSlot(p, p.slots[0].id, 1), p)).toBe(true);
    expect(isPlanDirty(removeSlot(p, p.slots[3].id), p)).toBe(true);
  });

  it("without a saved plan is dirty only when non-empty", () => {
    const p = emptyPlan();
    expect(isPlanDirty(p, null)).toBe(false);
    expect(isPlanDirty(setSlotBuild(p, p.slots[0].id, saved(["a"])), null)).toBe(true);
  });

  it("counts a slot with a chosen corps but no units as non-empty", () => {
    const p = emptyPlan();
    expect(isPlanEmpty(p)).toBe(true);
    const chosen = setSlotBuild(p, p.slots[0].id, saved([]));
    expect(isPlanEmpty(chosen)).toBe(false);
    expect(isPlanDirty(chosen, null)).toBe(true);
    // ...and it differs from the plan saved without that choice.
    expect(isPlanDirty(chosen, p)).toBe(true);
  });
});

describe("PlanRepository", () => {
  it("saves, lists newest first, finds, renames, duplicates and removes", () => {
    const repo = new PlanRepository(new MemoryStorageAdapter());
    const a = { ...emptyPlan(), name: "Alpha", updatedAt: "2025-01-01T00:00:00.000Z" };
    const b = { ...emptyPlan(), name: "Beta", updatedAt: "2025-02-01T00:00:00.000Z" };
    repo.save(a);
    repo.save(b);
    expect(repo.list().map((p) => p.name)).toEqual(["Beta", "Alpha"]);
    expect(repo.findByName(" alpha ")?.id).toBe(a.id);
    repo.rename(a.id, "Gamma");
    expect(repo.get(a.id)?.name).toBe("Gamma");
    const { copy } = repo.duplicate(a.id);
    expect(copy?.name).toBe("Gamma (copy)");
    expect(repo.list()).toHaveLength(3);
    repo.remove(a.id);
    expect(repo.get(a.id)).toBeUndefined();
  });

  it("upserts by id and keeps fields it does not know", () => {
    const adapter = new MemoryStorageAdapter();
    const repo = new PlanRepository(adapter);
    const p = emptyPlan();
    adapter.write("rda.plans", JSON.stringify([{ ...p, futureField: 7 }]));
    repo.save({ ...p, name: "Edited" });
    const stored = JSON.parse(adapter.read("rda.plans")!);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: "Edited", futureField: 7 });
  });

  it("backs up an unreadable value before overwriting it", () => {
    const adapter = new MemoryStorageAdapter();
    adapter.write("rda.plans", "{not json");
    const result = new PlanRepository(adapter).save(emptyPlan());
    expect(result.ok).toBe(true);
    expect(result.warning).toMatch(/unreadable/);
  });
});

describe("working plan and JSON", () => {
  it("round-trips the working plan with its loaded plan id", () => {
    const adapter = new MemoryStorageAdapter();
    expect(loadCurrentPlan(adapter)).toBeNull();
    const plan = renamePlan(emptyPlan(), "Now");
    saveCurrentPlan({ plan, loadedPlanId: "p_x" }, adapter);
    expect(loadCurrentPlan(adapter)).toMatchObject({ loadedPlanId: "p_x", plan: { name: "Now" } });
    adapter.write("rda.currentPlan", "garbage");
    expect(loadCurrentPlan(adapter)).toBeNull();
  });

  it("exports an envelope and imports it, or a bare plan, under a fresh id", () => {
    const p = setSlotBuild(emptyPlan(), emptyPlan().slots[0].id, null);
    const withBuild = setSlotBuild(p, p.slots[0].id, saved(["a"]));
    const env = JSON.parse(exportPlanJson(withBuild));
    expect(env).toMatchObject({ format: "rda-plan", version: 1 });
    const imported = importPlanJson(exportPlanJson(withBuild))!;
    expect(imported.id).not.toBe(withBuild.id);
    expect(imported.slots[0].build?.instances).toEqual(["a"]);
    expect(importPlanJson(JSON.stringify(withBuild))?.name).toBe(withBuild.name);
    expect(importPlanJson("nope")).toBeNull();
    expect(importPlanJson("{}")).toBeNull();
  });

  it("counts the raw slots of an import, before they are trimmed", () => {
    const p = emptyPlan();
    const six = { ...p, slots: [...p.slots, ...p.slots] };
    expect(rawPlanSlotCount(exportPlanJson(p))).toBe(MAX_PLAN_ARMIES);
    expect(rawPlanSlotCount(JSON.stringify(six))).toBe(8);
    expect(importPlanJson(JSON.stringify(six))?.slots).toHaveLength(MAX_PLAN_ARMIES);
    expect(rawPlanSlotCount("nope")).toBe(0);
    expect(rawPlanSlotCount("{}")).toBe(0);
  });
});
