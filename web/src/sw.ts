/// <reference lib="webworker" />
// Service worker for the Registre des Armées mobile PWA (Workbox injectManifest).
//
// Shell + small stable assets are precached (revisioned by the build). The heavy,
// content-stable payload — per-faction JSON and the 13.6k unit icons — is cached
// at runtime, cache-first, keyed by the data-version stamp so a data rebuild
// invalidates it. Lookups are confined to THIS deployment's caches for the
// CURRENT key — the in-app "make available offline" cache first, then the runtime
// cache — so an entry left in an old-key cache can never be served again.
//
// This file is bundled ONLY for the web target; the Electron desktop app serves
// the same dist over app:// and never registers a service worker (see pwa.ts).
import { precacheAndRoute, cleanupOutdatedCaches, matchPrecache } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import {
  OFFLINE_FETCH_HEADER,
  dataVersionKey,
  runtimeCacheName,
  offlineCacheName,
  runtimeCachePrefix,
  offlineCachePrefix,
  isLegacyUnscopedCacheName,
} from "./data/version";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

// Precache the app shell + corps picker + tiny data stamps (see vite.config.ts
// injectManifest.globPatterns). Nothing here is version-keyed — Workbox revisions
// each entry by content hash.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// --- data-version-keyed runtime caching --------------------------------------

let versionKeyPromise: Promise<string> | null = null;

function dataVersionUrl(): string {
  return new URL("data/data-version.json", self.registration.scope).toString();
}

/** Read the data-version stamp (precache first, network fallback) → cache key. */
function currentVersionKey(): Promise<string> {
  if (!versionKeyPromise) {
    versionKeyPromise = (async () => {
      try {
        const res =
          (await matchPrecache("data/data-version.json")) ??
          (await fetch(dataVersionUrl(), { cache: "no-store" }));
        if (!res || !res.ok) return "0";
        return dataVersionKey(await res.json());
      } catch {
        return "0";
      }
    })();
  }
  return versionKeyPromise;
}

async function cacheFirst(request: Request): Promise<Response> {
  // Only the current key's caches, never a bare `caches.match`: that searches
  // every cache on the origin, so a stale copy in an old-key cache (one the
  // activate sweep hasn't reclaimed yet) would keep serving last build's prices.
  const key = await currentVersionKey();
  for (const cacheName of [offlineCacheName(key), runtimeCacheName(key)]) {
    const hit = await caches.match(request, { cacheName });
    if (hit) return hit;
  }
  // Revalidate against the server on a miss: GitHub Pages sends max-age=600, so a
  // plain fetch right after a deploy could pull the PREVIOUS build's file out of
  // the HTTP cache and pin it under the new key. (Leave explicit modes — the
  // offline downloader's no-store — alone.)
  const response = await fetch(request, request.cache === "default" ? { cache: "no-cache" } : undefined);
  // The offline downloader stores its own copy; skip the duplicate runtime one.
  if (response.ok && !request.headers.has(OFFLINE_FETCH_HEADER)) {
    const cache = await caches.open(runtimeCacheName(key));
    cache.put(request, response.clone()).catch(() => {
      /* quota — the response is still served, just not cached */
    });
  }
  return response;
}

const isFactionJson = ({ url }: { url: URL }): boolean =>
  url.pathname.includes("/data/factions/") && url.pathname.endsWith(".json");

const isUnitIcon = ({ url }: { url: URL }): boolean => url.pathname.includes("/assets/icons/");

registerRoute(isFactionJson, ({ request }) => cacheFirst(request), "GET");
registerRoute(isUnitIcon, ({ request }) => cacheFirst(request), "GET");

// --- lifecycle ---------------------------------------------------------------

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop runtime/offline caches from a previous data-version, plus the
      // pre-scoping names that nothing reads any more. Matching THIS deployment's
      // prefixes rather than a bare "rda-" is what stops the stable and beta sites
      // — same origin, different path — from deleting each other's offline
      // factions whenever their data versions differ (see data/version.ts).
      const key = await currentVersionKey();
      const keep = new Set([runtimeCacheName(key), offlineCacheName(key)]);
      const mine = [runtimeCachePrefix(), offlineCachePrefix()];
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => mine.some((p) => n.startsWith(p)) || isLegacyUnscopedCacheName(n))
          .filter((n) => !keep.has(n))
          .map((n) => caches.delete(n)),
      );
      // Control open clients immediately so offline downloads work without reload.
      await self.clients.claim();
    })(),
  );
});

// The in-app "Update available — reload" toast posts this to activate a waiting SW.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
