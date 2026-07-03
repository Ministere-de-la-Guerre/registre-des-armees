import { describe, expect, it } from "vitest";
import { dataVersionKey, offlineCacheName, runtimeCacheName } from "./version";

describe("dataVersionKey", () => {
  it("is stable for the same stamp and changes when the data changes", () => {
    const a = dataVersionKey({ schemaVersion: 1, factionCount: 297, corpsListed: 297, totalSourceRows: 25668, towRows: 12032 });
    const b = dataVersionKey({ schemaVersion: 1, factionCount: 297, corpsListed: 297, totalSourceRows: 25668, towRows: 12032 });
    const changed = dataVersionKey({ schemaVersion: 1, factionCount: 298, corpsListed: 297, totalSourceRows: 25668, towRows: 12032 });
    expect(a).toBe(b);
    expect(a).not.toBe(changed);
  });

  it("falls back to '0' for missing / malformed stamps", () => {
    expect(dataVersionKey(null)).toBe("0");
    expect(dataVersionKey(undefined)).toBe("0");
    expect(dataVersionKey({} as never)).toBe("x.x.x.x.x");
  });

  it("derives distinct, version-scoped cache names", () => {
    const key = dataVersionKey({ schemaVersion: 1, factionCount: 2 });
    expect(runtimeCacheName(key)).toMatch(/^rda-runtime-/);
    expect(offlineCacheName(key)).toMatch(/^rda-offline-/);
    expect(runtimeCacheName(key)).not.toBe(offlineCacheName(key));
  });
});
