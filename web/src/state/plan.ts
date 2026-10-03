// Ordre de Bataille: a team plan of 1-4 armies. Each slot holds a *copy* of a
// saved build (never the saved build itself), so editing the plan never rewrites
// the player's build library. Persistence mirrors saves.ts: named plans behind a
// StorageAdapter, plus one autosaved working plan.

import { type SavedBuild, makeId, migrateSavedBuild } from "./saves";
import { type StorageAdapter, type StorageResult, STORAGE_NAMESPACE, defaultStorageAdapter } from "./storage";

export const PLAN_FORMAT_VERSION = 1;
export const MAX_PLAN_ARMIES = 4;
const PLANS_KEY = `${STORAGE_NAMESPACE}.plans`;
const CURRENT_PLAN_KEY = `${STORAGE_NAMESPACE}.currentPlan`;

export interface PlanSlot {
  id: string;
  /** Optional label for who plays this army. */
  player: string;
  build: SavedBuild | null;
}

export interface Plan {
  planFormatVersion: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 1..MAX_PLAN_ARMIES slots, in display order. */
  slots: PlanSlot[];
}

export function makePlanId(): string {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

let slotCounter = 0;
export function makeSlotId(): string {
  slotCounter += 1;
  return `s_${Date.now().toString(36)}_${slotCounter.toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function emptySlot(): PlanSlot {
  return { id: makeSlotId(), player: "", build: null };
}

export function emptyPlan(): Plan {
  const now = nowIso();
  return {
    planFormatVersion: PLAN_FORMAT_VERSION,
    id: makePlanId(),
    name: "Untitled plan",
    createdAt: now,
    updatedAt: now,
    slots: Array.from({ length: MAX_PLAN_ARMIES }, emptySlot),
  };
}

/** True when the plan holds nothing worth confirming before it is replaced. */
export function isPlanEmpty(plan: Plan): boolean {
  return plan.slots.every((s) => s.build === null && !s.player.trim());
}

// --- pure editing helpers (each returns a new plan) ---------------------------

function withSlots(plan: Plan, slots: PlanSlot[]): Plan {
  return { ...plan, slots, updatedAt: nowIso() };
}

function mapSlot(plan: Plan, slotId: string, edit: (s: PlanSlot) => PlanSlot): Plan {
  if (!plan.slots.some((s) => s.id === slotId)) return plan;
  return withSlots(plan, plan.slots.map((s) => (s.id === slotId ? edit(s) : s)));
}

export function addSlot(plan: Plan): Plan {
  if (plan.slots.length >= MAX_PLAN_ARMIES) return plan;
  return withSlots(plan, [...plan.slots, emptySlot()]);
}

export function removeSlot(plan: Plan, slotId: string): Plan {
  if (plan.slots.length <= 1 || !plan.slots.some((s) => s.id === slotId)) return plan;
  return withSlots(plan, plan.slots.filter((s) => s.id !== slotId));
}

export function moveSlot(plan: Plan, slotId: string, delta: -1 | 1): Plan {
  const from = plan.slots.findIndex((s) => s.id === slotId);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= plan.slots.length) return plan;
  const slots = [...plan.slots];
  [slots[from], slots[to]] = [slots[to], slots[from]];
  return withSlots(plan, slots);
}

export function setSlotBuild(plan: Plan, slotId: string, build: SavedBuild | null): Plan {
  return mapSlot(plan, slotId, (s) => ({ ...s, build }));
}

export function clearSlot(plan: Plan, slotId: string): Plan {
  return setSlotBuild(plan, slotId, null);
}

export function setSlotPlayer(plan: Plan, slotId: string, player: string): Plan {
  return mapSlot(plan, slotId, (s) => ({ ...s, player }));
}

export function renamePlan(plan: Plan, name: string): Plan {
  return { ...plan, name: name.trim() || plan.name, updatedAt: nowIso() };
}

/** A slot's own copy of a saved build, under a fresh id so it never aliases the
 *  library entry (saving the slot's build back to the library then creates a new
 *  build rather than overwriting the original). */
export function copySavedBuildIntoSlot(saved: SavedBuild): SavedBuild {
  return {
    ...saved,
    id: makeId(),
    instances: [...saved.instances],
    config: { ...saved.config },
  };
}

// --- migration ---------------------------------------------------------------

function migrateSlot(raw: unknown): PlanSlot {
  if (!raw || typeof raw !== "object") return emptySlot();
  const r = raw as Record<string, unknown>;
  return {
    id: typeof r.id === "string" && r.id ? r.id : makeSlotId(),
    player: typeof r.player === "string" ? r.player : "",
    build: migrateSavedBuild(r.build),
  };
}

/** Stable id for a stored plan that has none, so Rename / Delete can find it
 *  again (see legacyId in saves.ts). */
function legacyPlanId(raw: Record<string, unknown>): string {
  const text = JSON.stringify(raw);
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `p_legacy_${(h >>> 0).toString(36)}`;
}

/** Coerce an unknown persisted record into a Plan. Needs a `slots` array; the
 *  count is clamped to 1..MAX_PLAN_ARMIES and an unreadable slot becomes empty. */
export function migratePlan(raw: unknown): Plan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.slots)) return null;
  const slots = r.slots.slice(0, MAX_PLAN_ARMIES).map(migrateSlot);
  if (slots.length === 0) slots.push(emptySlot());
  // Slot ids must be unique for the helpers that address a slot by id.
  const seen = new Set<string>();
  for (const s of slots) {
    if (seen.has(s.id)) s.id = makeSlotId();
    seen.add(s.id);
  }
  return {
    planFormatVersion: PLAN_FORMAT_VERSION,
    id: typeof r.id === "string" && r.id ? r.id : legacyPlanId(r),
    name: typeof r.name === "string" && r.name ? r.name : "Untitled plan",
    createdAt: typeof r.createdAt === "string" ? r.createdAt : nowIso(),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : nowIso(),
    slots,
  };
}

// --- unsaved-changes check -----------------------------------------------------

function sameBuild(a: SavedBuild | null, b: SavedBuild | null): boolean {
  if (!a || !b) return a === b;
  if (a.factionKey !== b.factionKey || a.staffSlotUnitKey !== b.staffSlotUnitKey) return false;
  const x = [...a.instances].sort();
  const y = [...b.instances].sort();
  return x.length === y.length && x.every((k, i) => k === y[i]);
}

/** True when `plan` differs from the named plan it was loaded from. Compares what
 *  the player sees: name, slot order, players and each slot's build (copies
 *  order-insensitively, plus the commander). Ids and timestamps are ignored.
 *  With no saved plan, a plan is dirty once it holds anything. */
export function isPlanDirty(plan: Plan, saved: Plan | null): boolean {
  if (!saved) return !isPlanEmpty(plan);
  if (plan.name !== saved.name || plan.slots.length !== saved.slots.length) return true;
  return plan.slots.some((s, i) => s.player !== saved.slots[i].player || !sameBuild(s.build, saved.slots[i].build));
}

// --- JSON --------------------------------------------------------------------

export interface PlanExport {
  format: "rda-plan";
  version: number;
  exportedAt: string;
  plan: Plan;
}

export function exportPlanJson(plan: Plan): string {
  const envelope: PlanExport = { format: "rda-plan", version: PLAN_FORMAT_VERSION, exportedAt: nowIso(), plan };
  return JSON.stringify(envelope, null, 2);
}

/** Accepts the export envelope or a bare plan. The imported plan gets a fresh id
 *  so it never overwrites the named plan it was exported from. */
function unwrapPlanJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  return record && record.format === "rda-plan" ? record.plan : parsed;
}

/** How many slots the file holds before migratePlan trims it to MAX_PLAN_ARMIES
 *  (0 when unreadable), so the UI can say armies were dropped. */
export function rawPlanSlotCount(text: string): number {
  try {
    const inner = unwrapPlanJson(text);
    const slots = inner && typeof inner === "object" ? (inner as Record<string, unknown>).slots : null;
    return Array.isArray(slots) ? slots.length : 0;
  } catch {
    return 0;
  }
}

export function importPlanJson(text: string): Plan | null {
  try {
    const plan = migratePlan(unwrapPlanJson(text));
    return plan && { ...plan, id: makePlanId() };
  } catch {
    return null;
  }
}

// --- working plan (autosave) ---------------------------------------------------

export interface CurrentPlan {
  plan: Plan;
  /** Id of the named plan this working plan was loaded from / last saved as. */
  loadedPlanId: string | null;
}

export function loadCurrentPlan(adapter: StorageAdapter = defaultStorageAdapter()): CurrentPlan | null {
  const raw = adapter.read(CURRENT_PLAN_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    const plan = migratePlan(parsed?.plan);
    if (!plan) return null;
    return { plan, loadedPlanId: typeof parsed?.loadedPlanId === "string" ? parsed.loadedPlanId : null };
  } catch {
    return null;
  }
}

export function saveCurrentPlan(current: CurrentPlan, adapter: StorageAdapter = defaultStorageAdapter()): StorageResult {
  return adapter.write(CURRENT_PLAN_KEY, JSON.stringify(current));
}

// --- named plans ---------------------------------------------------------------

/** Repository over a StorageAdapter, the plan twin of BuildRepository: writes edit
 *  the stored array entry by entry so unknown fields and entries this version
 *  can't read survive (the key is shared by the stable and beta web builds). */
export class PlanRepository {
  constructor(private adapter: StorageAdapter = defaultStorageAdapter()) {}

  get persistent(): boolean {
    return this.adapter.available;
  }

  private readStored(): { entries: unknown[] } | { unreadable: string } {
    const raw = this.adapter.read(PLANS_KEY);
    if (!raw) return { entries: [] };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return { entries: parsed };
    } catch {
      /* fall through */
    }
    return { unreadable: raw };
  }

  list(): Plan[] {
    const stored = this.readStored();
    if (!("entries" in stored)) return [];
    return stored.entries
      .map(migratePlan)
      .filter((p): p is Plan => p !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Plan | undefined {
    return this.list().find((p) => p.id === id);
  }

  /** Find a named plan by (case-insensitive) name. */
  findByName(name: string): Plan | undefined {
    const lc = name.trim().toLowerCase();
    return this.list().find((p) => p.name.trim().toLowerCase() === lc);
  }

  /** Apply `edit` to the stored entries and write them back; an unparseable stored
   *  value is first copied aside, and the write refused if that copy fails. */
  private update(edit: (entries: unknown[]) => unknown[]): StorageResult {
    const stored = this.readStored();
    let warning: string | undefined;
    let entries: unknown[];
    if ("entries" in stored) {
      entries = stored.entries;
    } else {
      const backupKey = `${PLANS_KEY}.unreadable-${Date.now()}`;
      const backup = this.adapter.write(backupKey, stored.unreadable);
      if (!backup.ok) {
        return {
          ok: false,
          error: "the existing saved plans couldn't be read, and were left untouched rather than overwritten",
        };
      }
      entries = [];
      warning = `The previously saved plans couldn't be read; they were kept under “${backupKey}”.`;
    }
    const result = this.adapter.write(PLANS_KEY, JSON.stringify(edit(entries)));
    return warning && result.ok ? { ...result, warning } : result;
  }

  /** Insert or update by id. Fields this version doesn't know about are kept. */
  save(plan: Plan): StorageResult {
    return this.update((entries) => {
      const next: unknown[] = [];
      let replaced = false;
      for (const e of entries) {
        if (migratePlan(e)?.id !== plan.id) next.push(e);
        else if (!replaced) {
          next.push({ ...(e as Record<string, unknown>), ...plan });
          replaced = true;
        }
      }
      if (!replaced) next.push(plan);
      return next;
    });
  }

  remove(id: string): StorageResult {
    return this.update((entries) => entries.filter((e) => migratePlan(e)?.id !== id));
  }

  rename(id: string, name: string): StorageResult {
    return this.update((entries) =>
      entries.map((e) => (migratePlan(e)?.id === id ? { ...(e as Record<string, unknown>), id, name, updatedAt: nowIso() } : e)),
    );
  }

  duplicate(id: string): { result: StorageResult; copy?: Plan } {
    const original = this.get(id);
    if (!original) return { result: { ok: false, error: "Plan not found." } };
    const now = nowIso();
    const copy: Plan = {
      ...original,
      id: makePlanId(),
      name: `${original.name} (copy)`,
      createdAt: now,
      updatedAt: now,
    };
    return { result: this.save(copy), copy };
  }
}
