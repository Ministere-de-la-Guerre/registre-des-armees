// Storage abstraction. All persistence goes through a StorageAdapter so the UI
// and build-state logic never touch localStorage directly. A future desktop
// build can swap in a filesystem / SQLite / IndexedDB adapter without changing
// the repository or components.

export interface StorageResult {
  ok: boolean;
  error?: string;
}

export interface StorageAdapter {
  /** True when reads/writes are expected to persist. */
  readonly available: boolean;
  read(key: string): string | null;
  write(key: string, value: string): StorageResult;
  remove(key: string): void;
}

/** Namespace for all keys this app owns, to avoid collisions. */
export const STORAGE_NAMESPACE = "rda";

export class LocalStorageAdapter implements StorageAdapter {
  private store: Storage | null;

  constructor(store?: Storage) {
    this.store = store ?? safeLocalStorage();
  }

  get available(): boolean {
    return this.store !== null;
  }

  read(key: string): string | null {
    try {
      return this.store?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  write(key: string, value: string): StorageResult {
    if (!this.store) return { ok: false, error: "Storage unavailable." };
    try {
      this.store.setItem(key, value);
      return { ok: true };
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      const quota = name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
      return { ok: false, error: quota ? "Storage quota exceeded." : "Could not write to storage." };
    }
  }

  remove(key: string): void {
    try {
      this.store?.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

/** In-memory adapter (tests, or when localStorage is unavailable). */
export class MemoryStorageAdapter implements StorageAdapter {
  readonly available = false;
  private map = new Map<string, string>();
  read(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  write(key: string, value: string): StorageResult {
    this.map.set(key, value);
    return { ok: true };
  }
  remove(key: string): void {
    this.map.delete(key);
  }
}

function safeLocalStorage(): Storage | null {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    // Probe: some environments expose localStorage but throw on use.
    const probe = `${STORAGE_NAMESPACE}.__probe__`;
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

let shared: StorageAdapter | null = null;
export function defaultStorageAdapter(): StorageAdapter {
  if (shared) return shared;
  const ls = new LocalStorageAdapter();
  shared = ls.available ? ls : new MemoryStorageAdapter();
  return shared;
}
