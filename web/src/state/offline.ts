// Per-faction "make available offline" + storage-safety helpers (web/PWA only).
//
// The service worker runtime-caches whatever the user browses, but that is
// implicit and evictable. This module lets the user *explicitly* pull a faction's
// JSON + every icon it references into the Cache API, under a data-version-keyed
// cache the SW also reads from (see src/sw.ts `caches.match`), and records a
// marker so the UI can show which factions are fully downloaded. Everything is a
// no-op when the Cache API is unavailable (e.g. inside Electron / private mode).

import { assetUrl, dataUrl } from "../data/assets";
import { dataVersionKey, offlineCacheName, type DataVersion } from "../data/version";
import type { FactionRoster } from "../domain/types";

export function offlineSupported(): boolean {
  return typeof caches !== "undefined" && typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

let versionKeyCache: string | null = null;
export async function getDataVersionKey(): Promise<string> {
  if (versionKeyCache) return versionKeyCache;
  try {
    const res = await fetch(dataUrl("data-version.json"));
    versionKeyCache = dataVersionKey((await res.json()) as DataVersion);
  } catch {
    versionKeyCache = "0";
  }
  return versionKeyCache;
}

function rosterAssetUrls(roster: FactionRoster): string[] {
  const set = new Set<string>();
  for (const card of roster.cards) {
    for (const path of [card.icon, card.commandStarStrip, card.guerrillaBadge]) {
      const url = assetUrl(path);
      if (url) set.add(url);
    }
  }
  return [...set];
}

function markerUrl(versionKey: string, factionKey: string): string {
  const origin = globalThis.location?.origin ?? "";
  return `${origin}/__offline__/${versionKey}/${encodeURIComponent(factionKey)}`;
}

export interface DownloadProgress {
  done: number;
  total: number;
}

export interface DownloadResult {
  ok: boolean;
  cached: number;
  total: number;
  error?: string;
}

/** Fetch the faction JSON + all its icons into the version-keyed offline cache. */
export async function downloadFactionOffline(
  roster: FactionRoster,
  onProgress?: (p: DownloadProgress) => void,
): Promise<DownloadResult> {
  if (!offlineSupported()) return { ok: false, cached: 0, total: 0, error: "Offline caching isn't available here." };
  const key = await getDataVersionKey();
  const cache = await caches.open(offlineCacheName(key));
  const urls = [dataUrl(`factions/${roster.factionKey}.json`), ...rosterAssetUrls(roster)];
  const total = urls.length;
  let done = 0;
  let failed = 0;
  onProgress?.({ done, total });

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < urls.length) {
      const url = urls[next++];
      try {
        const already = await caches.match(url);
        if (!already) {
          const res = await fetch(url, { cache: "no-store" });
          if (res.ok) await cache.put(url, res.clone());
          else failed++;
        }
      } catch {
        failed++;
      }
      done++;
      onProgress?.({ done, total });
    }
  };
  const CONCURRENCY = 6;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

  await cache.put(
    markerUrl(key, roster.factionKey),
    new Response(JSON.stringify({ at: Date.now(), cached: total - failed, total }), {
      headers: { "content-type": "application/json" },
    }),
  );
  return { ok: failed === 0, cached: total - failed, total, error: failed ? `${failed} file(s) failed to download` : undefined };
}

export async function isFactionOffline(factionKey: string): Promise<boolean> {
  if (!offlineSupported()) return false;
  const key = await getDataVersionKey();
  return !!(await caches.match(markerUrl(key, factionKey)));
}

/** Faction keys currently marked as fully downloaded (for the current data version). */
export async function listOfflineFactions(): Promise<string[]> {
  if (!offlineSupported()) return [];
  const key = await getDataVersionKey();
  const cache = await caches.open(offlineCacheName(key));
  const prefix = markerUrl(key, "");
  const keys = await cache.keys();
  return keys
    .map((r) => r.url)
    .filter((u) => u.startsWith(prefix))
    .map((u) => decodeURIComponent(u.slice(prefix.length)));
}

/** Forget a faction's offline marker + its JSON. Shared icons are left to age out
 *  (or clear wholesale on the next data-version bump). */
export async function removeFactionOffline(factionKey: string): Promise<void> {
  if (!offlineSupported()) return;
  const key = await getDataVersionKey();
  const cache = await caches.open(offlineCacheName(key));
  await cache.delete(markerUrl(key, factionKey));
  await cache.delete(dataUrl(`factions/${factionKey}.json`));
}

// --- storage safety ----------------------------------------------------------

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function isStoragePersisted(): Promise<boolean> {
  try {
    return (await navigator.storage?.persisted?.()) ?? false;
  } catch {
    return false;
  }
}

export interface StorageUsage {
  usage: number;
  quota: number;
}

export async function storageEstimate(): Promise<StorageUsage | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e) return null;
    return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
  } catch {
    return null;
  }
}
