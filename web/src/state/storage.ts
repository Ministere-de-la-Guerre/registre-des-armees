// Storage abstraction. All persistence goes through a StorageAdapter so the UI
// and build-state logic never touch localStorage directly. A future desktop
// build can swap in a filesystem / SQLite / IndexedDB adapter without changing
// the repository or components.

export interface StorageResult {
  ok: boolean;
  error?: string;
  /** Set on a successful write the user should still hear about. */
  warning?: string;
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
      return { ok: false, error: isQuotaError(e) ? "Storage quota exceeded." : "Could not write to storage." };
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

function isQuotaError(e: unknown): boolean {
  const name = e && typeof e === "object" ? (e as { name?: unknown }).name : undefined;
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

function safeLocalStorage(): Storage | null {
  let ls: Storage | undefined;
  try {
    ls = globalThis.localStorage;
  } catch {
    return null; // merely touching it throws when storage is blocked
  }
  if (!ls) return null;
  // Probe: some environments expose localStorage but throw on use.
  const probe = `${STORAGE_NAMESPACE}.__probe__`;
  try {
    ls.setItem(probe, "1");
    ls.removeItem(probe);
    return ls;
  } catch (e) {
    // A FULL store still reads fine. Falling back to the memory adapter here
    // would hide every existing save (and disable Export, the one way to get
    // them out) exactly when the user most needs them; keep the real store and
    // let each write report the quota error instead.
    if (!isQuotaError(e)) return null;
    try {
      ls.getItem(probe);
      return ls;
    } catch {
      return null;
    }
  }
}

let shared: StorageAdapter | null = null;
export function defaultStorageAdapter(): StorageAdapter {
  if (shared) return shared;
  const ls = new LocalStorageAdapter();
  shared = ls.available ? ls : new MemoryStorageAdapter();
  return shared;
}
