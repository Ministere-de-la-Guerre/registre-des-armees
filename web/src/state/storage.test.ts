import { afterEach, describe, expect, it, vi } from "vitest";

function fakeStorage(setItem: () => void): Storage {
  const map = new Map<string, string>([["rda.savedBuilds", "[]"]]);
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem,
  };
}

function quotaError(): Error {
  const e = new Error("full");
  e.name = "QuotaExceededError";
  return e;
}

describe("defaultStorageAdapter probe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("keeps a FULL localStorage (reads still work) instead of falling back to memory", async () => {
    vi.stubGlobal("localStorage", fakeStorage(() => { throw quotaError(); }));
    const { defaultStorageAdapter } = await import("./storage");
    const adapter = defaultStorageAdapter();
    expect(adapter.available).toBe(true);
    expect(adapter.read("rda.savedBuilds")).toBe("[]");
    expect(adapter.write("rda.x", "1")).toEqual({ ok: false, error: "Storage quota exceeded." });
  });

  it("falls back to memory when storage is unusable for other reasons", async () => {
    vi.stubGlobal("localStorage", fakeStorage(() => { throw new Error("SecurityError"); }));
    const { defaultStorageAdapter } = await import("./storage");
    expect(defaultStorageAdapter().available).toBe(false);
  });
});
