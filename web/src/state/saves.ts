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

/** Stable id for a stored entry that has none (very old saves). A random one
 *  would differ on every list(), so Rename / Delete could never find the entry
 *  again — the repository rewrites entries verbatim rather than re-migrating. */
function legacyId(raw: Record<string, unknown>): string {
  const text = JSON.stringify(raw);
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `b_legacy_${(h >>> 0).toString(36)}`;
}

// A build holds at most 31 cards; a v1 `selection` count far beyond that is
// corrupt, and expanding e.g. 1e9 copies would freeze the tab.
const MAX_MIGRATED_COPIES = 64;

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
      const copies = Math.min(Math.floor(Number.isFinite(n) ? n : 0), MAX_MIGRATED_COPIES - instances.length);
      for (let i = 0; i < copies; i += 1) instances.push(k);
    }
  } else if (Array.isArray(r.selection)) {
    instances = (r.selection as unknown[]).filter((k): k is string => typeof k === "string");
  } else if (Array.isArray(r.unitKeys)) {
    instances = (r.unitKeys as unknown[]).filter((k): k is string => typeof k === "string");
  }

  const cfg = (r.config ?? {}) as Record<string, unknown>;
  return {
    saveFormatVersion: SAVE_FORMAT_VERSION,
    id: typeof r.id === "string" ? r.id : legacyId(r),
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
  /** Unreadable entries, or ones the store refused (see `error`). */
  skipped: number;
  /** Entries whose copy on this device was edited more recently than the backup. */
  keptNewer: number;
  error?: string;
}

function stampOf(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** Merge a backup file into the repo, by id. Accepts a full backup object, a bare
 *  array of builds, or a single build — each entry migrated through the same path
 *  as normal loads, so older exports import cleanly. An entry never replaces a
 *  copy on this device that was updated more recently: restoring an old backup
 *  must not silently revert the edits made since (those are counted in
 *  `keptNewer` instead). */
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
  const existing = new Map(repo.list().map((b) => [b.id, b]));
  const summary: ImportSummary = { imported: 0, skipped: 0, keptNewer: 0 };
  for (const raw of rawBuilds) {
    const build = migrateSavedBuild(raw);
    if (!build) {
      summary.skipped += 1;
      continue;
    }
    // migrateSavedBuild stamps a missing updatedAt with "now"; an undated entry
    // must count as the oldest possible, not the newest.
    const dated = typeof (raw as Record<string, unknown>).updatedAt === "string";
    const current = existing.get(build.id);
    if (current && stampOf(current.updatedAt) > (dated ? stampOf(build.updatedAt) : 0)) {
      summary.keptNewer += 1;
      continue;
    }
    const result = repo.save(build);
    if (result.ok) {
      summary.imported += 1;
      existing.set(build.id, build);
    } else {
      summary.skipped += 1;
    }
    summary.error ??= result.error ?? result.warning;
  }
  return summary;
}

/** Repository over a StorageAdapter. Components use this, never localStorage.
 *
 *  Writes edit the stored array entry by entry and leave every other entry
 *  byte-for-byte as it was. The key is shared by the stable and beta web builds
 *  (same origin), so a newer build's fields, or an entry this version can't
 *  read, must survive an older build saving next to them — re-serializing
 *  everything through migrateSavedBuild used to drop both. */
export class BuildRepository {
  constructor(private adapter: StorageAdapter = defaultStorageAdapter()) {}

  get persistent(): boolean {
    return this.adapter.available;
  }

  /** The stored array, or `unreadable` when the key holds something else. */
  private readStored(): { entries: unknown[] } | { unreadable: string } {
    const raw = this.adapter.read(STORAGE_KEY);
    if (!raw) return { entries: [] };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return { entries: parsed };
    } catch {
      /* fall through */
    }
    return { unreadable: raw };
  }

  list(): SavedBuild[] {
    const stored = this.readStored();
    if (!("entries" in stored)) return [];
    return stored.entries
      .map(migrateSavedBuild)
      .filter((b): b is SavedBuild => b !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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

  /** Apply `edit` to the stored entries and write them back. If the stored value
   *  can't be parsed, it is first copied aside under its own key — the write
   *  that follows would otherwise destroy the only copy — and the write is
   *  refused if that copy can't be made. */
  private update(edit: (entries: unknown[]) => unknown[]): StorageResult {
    const stored = this.readStored();
    let warning: string | undefined;
    let entries: unknown[];
    if ("entries" in stored) {
      entries = stored.entries;
    } else {
      const backupKey = `${STORAGE_KEY}.unreadable-${Date.now()}`;
      const backup = this.adapter.write(backupKey, stored.unreadable);
      if (!backup.ok) {
        return {
          ok: false,
          error: "the existing saved builds couldn't be read, and were left untouched rather than overwritten",
        };
      }
      entries = [];
      warning = `The previously saved builds couldn't be read; they were kept under “${backupKey}”.`;
    }
    const result = this.adapter.write(STORAGE_KEY, JSON.stringify(edit(entries)));
    return warning && result.ok ? { ...result, warning } : result;
  }

  /** Insert or update by id. Fields this version doesn't know about are kept. */
  save(build: SavedBuild): StorageResult {
    return this.update((entries) => {
      const next: unknown[] = [];
      let replaced = false;
      for (const e of entries) {
        if (migrateSavedBuild(e)?.id !== build.id) next.push(e);
        else if (!replaced) {
          next.push({ ...(e as Record<string, unknown>), ...build });
          replaced = true;
        } // (a later duplicate of the same id is dropped, as before)
      }
      if (!replaced) next.push(build);
      return next;
    });
  }

  remove(id: string): StorageResult {
    return this.update((entries) => entries.filter((e) => migrateSavedBuild(e)?.id !== id));
  }

  rename(id: string, name: string): StorageResult {
    return this.update((entries) =>
      entries.map((e) => (migrateSavedBuild(e)?.id === id ? { ...(e as Record<string, unknown>), id, name, updatedAt: nowIso() } : e)),
    );
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
