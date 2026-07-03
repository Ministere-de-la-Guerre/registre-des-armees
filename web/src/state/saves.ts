// Named saved builds, versioned and stored behind a StorageAdapter. Loading old
// or partially incompatible builds fails gracefully and reports missing unit
// keys. The schema stores explicit instances so duplicate copies round-trip.

import type { FactionRoster } from "../domain/types";
import { type BuildState, makeInstanceId } from "./build";
import { type StorageAdapter, type StorageResult, STORAGE_NAMESPACE, defaultStorageAdapter } from "./storage";

export const SAVE_FORMAT_VERSION = 2;
const STORAGE_KEY = `${STORAGE_NAMESPACE}.savedBuilds`;

export interface BuildConfig {
  density: "comfortable" | "compact";
  showCombatGenerals: boolean;
}

export interface SavedBuild {
  saveFormatVersion: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  factionKey: string;
  armyCorpsName: string;
  /** Ordered unit keys, one entry per selected copy. */
  instances: string[];
  staffSlotUnitKey: string | null;
  config: BuildConfig;
  sourceDataVersion?: number;
}

export function makeId(): string {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Coerce an unknown persisted record into a SavedBuild, migrating older shapes. */
export function migrateSavedBuild(raw: unknown): SavedBuild | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const factionKey = typeof r.factionKey === "string" ? r.factionKey : "";
  if (!factionKey) return null;

  // instances: prefer explicit array; migrate v1 `selection` record / arrays.
  let instances: string[] = [];
  if (Array.isArray(r.instances)) {
    instances = r.instances.filter((k): k is string => typeof k === "string");
  } else if (r.selection && typeof r.selection === "object" && !Array.isArray(r.selection)) {
    for (const [k, v] of Object.entries(r.selection as Record<string, unknown>)) {
      const n = typeof v === "number" ? v : Number(v);
      for (let i = 0; i < Math.floor(Number.isFinite(n) ? n : 0); i += 1) instances.push(k);
    }
  } else if (Array.isArray(r.selection)) {
    instances = (r.selection as unknown[]).filter((k): k is string => typeof k === "string");
  } else if (Array.isArray(r.unitKeys)) {
    instances = (r.unitKeys as unknown[]).filter((k): k is string => typeof k === "string");
  }

  const cfg = (r.config ?? {}) as Record<string, unknown>;
  return {
    saveFormatVersion: SAVE_FORMAT_VERSION,
    id: typeof r.id === "string" ? r.id : makeId(),
    name: typeof r.name === "string" && r.name ? r.name : "Untitled build",
    createdAt: typeof r.createdAt === "string" ? r.createdAt : nowIso(),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : nowIso(),
    factionKey,
    armyCorpsName: typeof r.armyCorpsName === "string" ? r.armyCorpsName : "",
    instances,
    staffSlotUnitKey: typeof r.staffSlotUnitKey === "string" ? r.staffSlotUnitKey : null,
    config: {
      density: cfg.density === "compact" ? "compact" : "comfortable",
      showCombatGenerals: cfg.showCombatGenerals !== false,
    },
    sourceDataVersion: typeof r.sourceDataVersion === "number" ? r.sourceDataVersion : undefined,
  };
}

export interface CurrentBuild {
  build: BuildState;
  config: BuildConfig;
  factionKey: string;
  armyCorpsName: string;
}

export function buildToSaved(current: CurrentBuild, meta: { id?: string; name: string; createdAt?: string }): SavedBuild {
  return {
    saveFormatVersion: SAVE_FORMAT_VERSION,
    id: meta.id ?? makeId(),
    name: meta.name,
    createdAt: meta.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    factionKey: current.factionKey,
    armyCorpsName: current.armyCorpsName,
    instances: current.build.instances.map((i) => i.unitKey),
    staffSlotUnitKey: current.build.staffSlotUnitKey,
    config: current.config,
  };
}

export interface LoadResult {
  build: BuildState;
  config: BuildConfig;
  missingKeys: string[];
}

/** Resolve a saved build against a roster, dropping + reporting unknown keys.
 *  Each saved copy becomes a separate tray instance. */
export function resolveSavedBuild(saved: SavedBuild, roster: FactionRoster): LoadResult {
  const known = new Set(roster.cards.map((c) => c.unitKey));
  const instances = [];
  const missingKeys: string[] = [];
  for (const key of saved.instances) {
    if (known.has(key)) instances.push({ id: makeInstanceId(), unitKey: key });
    else missingKeys.push(key);
  }
  let staffSlotUnitKey = saved.staffSlotUnitKey;
  if (staffSlotUnitKey && !known.has(staffSlotUnitKey)) {
    missingKeys.push(staffSlotUnitKey);
    staffSlotUnitKey = null;
  }
  return { build: { instances, staffSlotUnitKey }, config: saved.config, missingKeys };
}

/** True when `current` differs from the loaded `saved` build (unsaved changes). */
export function isDirty(current: CurrentBuild, saved: SavedBuild | null): boolean {
  if (!saved) return current.build.instances.length > 0 || current.build.staffSlotUnitKey !== null;
  const a = [...current.build.instances.map((i) => i.unitKey)].sort();
  const b = [...saved.instances].sort();
  if (a.length !== b.length || a.some((k, i) => k !== b[i])) return true;
  if (current.build.staffSlotUnitKey !== saved.staffSlotUnitKey) return true;
  if (current.config.density !== saved.config.density) return true;
  if (current.config.showCombatGenerals !== saved.config.showCombatGenerals) return true;
  return false;
}

export function exportBuildJson(saved: SavedBuild): string {
  return JSON.stringify(saved, null, 2);
}

export function importBuildJson(text: string): SavedBuild | null {
  try {
    return migrateSavedBuild(JSON.parse(text));
  } catch {
    return null;
  }
}

// --- whole-save-set backup (export/import) -----------------------------------
// iOS can evict site storage from an idle installed PWA, so the entire save set
// can be serialized to a file the user keeps (and re-imported on any device).

export interface BuildsBackup {
  format: "rda-builds-backup";
  version: number;
  exportedAt: string;
  builds: SavedBuild[];
}

export function exportAllBuilds(repo: BuildRepository): BuildsBackup {
  return { format: "rda-builds-backup", version: SAVE_FORMAT_VERSION, exportedAt: nowIso(), builds: repo.list() };
}

export interface ImportSummary {
  imported: number;
  skipped: number;
}

/** Merge a backup file into the repo, by id. Accepts a full backup object, a bare
 *  array of builds, or a single build — each entry migrated through the same path
 *  as normal loads, so older exports import cleanly. */
export function importAllBuilds(repo: BuildRepository, text: string): ImportSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const rawBuilds: unknown[] = Array.isArray(parsed)
    ? parsed
    : record && Array.isArray(record.builds)
      ? (record.builds as unknown[])
      : [parsed];
  let imported = 0;
  let skipped = 0;
  for (const raw of rawBuilds) {
    const build = migrateSavedBuild(raw);
    if (build && repo.save(build).ok) imported += 1;
    else skipped += 1;
  }
  return { imported, skipped };
}

/** Repository over a StorageAdapter. Components use this, never localStorage. */
export class BuildRepository {
  constructor(private adapter: StorageAdapter = defaultStorageAdapter()) {}

  get persistent(): boolean {
    return this.adapter.available;
  }

  list(): SavedBuild[] {
    const raw = this.adapter.read(STORAGE_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map(migrateSavedBuild)
        .filter((b): b is SavedBuild => b !== null)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }

  get(id: string): SavedBuild | undefined {
    return this.list().find((b) => b.id === id);
  }

  /** Find a saved build by (case-insensitive) name. When `factionKey` is given the
   *  search is restricted to that corps, so two different corps can each keep a
   *  build of the same name without one's Save As overwriting the other's. */
  findByName(name: string, factionKey?: string): SavedBuild | undefined {
    const lc = name.trim().toLowerCase();
    return this.list().find(
      (b) => b.name.trim().toLowerCase() === lc && (factionKey === undefined || b.factionKey === factionKey),
    );
  }

  private writeAll(builds: SavedBuild[]): StorageResult {
    return this.adapter.write(STORAGE_KEY, JSON.stringify(builds));
  }

  /** Insert or update by id. */
  save(build: SavedBuild): StorageResult {
    const all = this.list().filter((b) => b.id !== build.id);
    all.push(build);
    return this.writeAll(all);
  }

  remove(id: string): StorageResult {
    return this.writeAll(this.list().filter((b) => b.id !== id));
  }

  rename(id: string, name: string): StorageResult {
    const all = this.list().map((b) => (b.id === id ? { ...b, name, updatedAt: nowIso() } : b));
    return this.writeAll(all);
  }

  duplicate(id: string): { result: StorageResult; copy?: SavedBuild } {
    const original = this.get(id);
    if (!original) return { result: { ok: false, error: "Build not found." } };
    const copy: SavedBuild = {
      ...original,
      id: makeId(),
      name: `${original.name} (copy)`,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    return { result: this.save(copy), copy };
  }
}
