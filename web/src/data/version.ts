// The data-version stamp (web/public/data/data-version.json) is the cache-busting
// key for everything the pipeline regenerates. Both the service worker and the
// in-app offline manager derive their runtime cache names from it, so a data
// rebuild automatically drops stale offline caches. Keep this module DOM-free —
// it is bundled into the service worker.

export interface DataVersion {
  schemaVersion?: number;
  factionCount?: number;
  corpsListed?: number;
  totalSourceRows?: number;
  towRows?: number;
}

/** A short, stable string that changes whenever the generated dataset changes. */
export function dataVersionKey(dv: DataVersion | null | undefined): string {
  if (!dv || typeof dv !== "object") return "0";
  const fields: (keyof DataVersion)[] = [
    "schemaVersion",
    "factionCount",
    "corpsListed",
    "totalSourceRows",
    "towRows",
  ];
  const parts = fields.map((f) => {
    const v = dv[f];
    return typeof v === "number" && Number.isFinite(v) ? String(v) : "x";
  });
  return parts.join(".");
}

export const RUNTIME_CACHE_PREFIX = "rda-runtime-";
export const OFFLINE_CACHE_PREFIX = "rda-offline-";

export function runtimeCacheName(versionKey: string): string {
  return RUNTIME_CACHE_PREFIX + versionKey;
}
export function offlineCacheName(versionKey: string): string {
  return OFFLINE_CACHE_PREFIX + versionKey;
}
