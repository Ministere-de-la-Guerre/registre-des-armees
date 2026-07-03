/// <reference lib="webworker" />
// Service worker for the Registre des Armées mobile PWA (Workbox injectManifest).
//
// Shell + small stable assets are precached (revisioned by the build). The heavy,
// content-stable payload — per-faction JSON and the 13.6k unit icons — is cached
// at runtime, cache-first, keyed by the data-version stamp so a data rebuild
// invalidates it. `caches.match` (no cacheName) lets the runtime handler serve
// assets that the in-app "make available offline" flow wrote to its own cache.
//
// This file is bundled ONLY for the web target; the Electron desktop app serves
// the same dist over app:// and never registers a service worker (see pwa.ts).
import { precacheAndRoute, cleanupOutdatedCaches, matchPrecache } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { dataVersionKey, runtimeCacheName, offlineCacheName } from "./data/version";

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
  // Serve from ANY cache (runtime OR the in-app offline downloader's cache).
  const hit = await caches.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    const key = await currentVersionKey();
    const cache = await caches.open(runtimeCacheName(key));
    cache.put(request, response.clone());
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
      // Drop runtime/offline caches from a previous data-version.
      const key = await currentVersionKey();
      const keep = new Set([runtimeCacheName(key), offlineCacheName(key)]);
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => (n.startsWith("rda-runtime-") || n.startsWith("rda-offline-")) && !keep.has(n))
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
