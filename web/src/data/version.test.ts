import { describe, expect, it } from "vitest";
import {
  dataVersionKey,
  deploymentScope,
  isLegacyUnscopedCacheName,
  offlineCacheName,
  offlineCachePrefix,
  runtimeCacheName,
  runtimeCachePrefix,
} from "./version";

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
    expect(runtimeCacheName(key)).toMatch(/^rda-runtime:/);
    expect(offlineCacheName(key)).toMatch(/^rda-offline:/);
    expect(runtimeCacheName(key)).not.toBe(offlineCacheName(key));
  });
});

describe("deploymentScope", () => {
  it("reduces a served path to its directory token", () => {
    expect(deploymentScope("/registre-des-armees/")).toBe("registre-des-armees");
    expect(deploymentScope("/registre-des-armees/index.html")).toBe("registre-des-armees");
    expect(deploymentScope("/registre-des-armees/sw.js")).toBe("registre-des-armees");
  });

  it("falls back to a token for a site served from the root", () => {
    expect(deploymentScope("/")).toBe("root");
    expect(deploymentScope("/index.html")).toBe("root");
    expect(deploymentScope("")).toBe("root");
  });

  it("flattens nested paths and strips characters a cache name should not carry", () => {
    expect(deploymentScope("/a/b/")).toBe("a-b");
    expect(deploymentScope("/we ird/")).toBe("we-ird");
  });

  // The whole point: stable and beta share an origin and differ only by path.
  it("keeps the stable and beta deployments apart", () => {
    const key = dataVersionKey({ schemaVersion: 1, factionCount: 2 });
    const stable = deploymentScope("/registre-des-armees/");
    const beta = deploymentScope("/registre-des-armees-beta/");
    expect(stable).not.toBe(beta);
    expect(offlineCacheName(key, stable)).not.toBe(offlineCacheName(key, beta));
    // Neither may prefix-match the other, or the activate sweep would still
    // delete across channels. "registre-des-armees-beta" starts with
    // "registre-des-armees-", so this only holds because of the ":" delimiter.
    expect(offlineCacheName(key, beta).startsWith(offlineCachePrefix(stable))).toBe(false);
    expect(offlineCacheName(key, stable).startsWith(offlineCachePrefix(beta))).toBe(false);
    expect(runtimeCacheName(key, beta).startsWith(runtimeCachePrefix(stable))).toBe(false);
  });
});

describe("isLegacyUnscopedCacheName", () => {
  it("recognises the pre-scoping names so they can be reclaimed", () => {
    expect(isLegacyUnscopedCacheName("rda-offline-1.297.297.25668.12032")).toBe(true);
    expect(isLegacyUnscopedCacheName("rda-runtime-0")).toBe(true);
    expect(isLegacyUnscopedCacheName("rda-runtime-x.x.x.x.x")).toBe(true);
  });

  it("never matches a scoped name or a foreign cache", () => {
    const key = dataVersionKey({ schemaVersion: 1, factionCount: 2 });
    expect(isLegacyUnscopedCacheName(offlineCacheName(key, "registre-des-armees"))).toBe(false);
    expect(isLegacyUnscopedCacheName(runtimeCacheName(key, "root"))).toBe(false);
    expect(isLegacyUnscopedCacheName("workbox-precache-v2")).toBe(false);
  });
});
