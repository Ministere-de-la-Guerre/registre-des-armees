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

export const RUNTIME_CACHE_PREFIX = "rda-runtime";
export const OFFLINE_CACHE_PREFIX = "rda-offline";

// Pre-scoping names, kept only so the activate sweep can reclaim them.
const LEGACY_PREFIXES = ["rda-runtime-", "rda-offline-"];

// Scope and version are joined with ":" — the one character `deploymentScope`
// cannot emit. That matters: the scopes in play are "registre-des-armees" and
// "registre-des-armees-beta", and the second STARTS WITH the first plus "-", so a
// hyphen-joined name would let the stable site's prefix sweep match beta's caches
// and delete them — the very bug this scoping exists to prevent. Terminating the
// scope with a character it can never contain makes the prefixes disjoint.
const SCOPE_DELIM = ":";

// Cache names carry the deployment's base path on top of the data-version key.
//
// The stable and beta web builds are served from the SAME GitHub Pages origin
// (…github.io/registre-des-armees[-beta]/) and differ only by path, but Cache
// Storage is per-origin, not per-path. Unscoped names therefore had the two
// channels sharing entries — and worse, the activate handler in sw.ts drops every
// rda-* cache whose data-version isn't the current one, so whichever site the user
// opened last wiped the other channel's explicitly downloaded offline factions as
// soon as their data versions diverged. Deriving the token from the serving
// directory keeps deployments apart with no per-channel build configuration.

/** Cache-name token for the directory `pathname` is served from. */
export function deploymentScope(pathname: string): string {
  const dir = pathname.replace(/[^/]*$/, ""); // drop the file name, keep the directory
  const token = dir
    .replace(/^\/+|\/+$/g, "") // trim the bounding slashes
    .replace(/[^A-Za-z0-9._-]+/g, "-"); // keep the result safe inside a cache name
  return token || "root";
}

/** The running context's scope. `self` covers both window and worker. */
function currentScope(): string {
  const path = typeof self !== "undefined" && self.location ? self.location.pathname : "";
  return deploymentScope(path);
}

export function runtimeCachePrefix(scope: string = currentScope()): string {
  return `${RUNTIME_CACHE_PREFIX}${SCOPE_DELIM}${scope}${SCOPE_DELIM}`;
}
export function offlineCachePrefix(scope: string = currentScope()): string {
  return `${OFFLINE_CACHE_PREFIX}${SCOPE_DELIM}${scope}${SCOPE_DELIM}`;
}
export function runtimeCacheName(versionKey: string, scope: string = currentScope()): string {
  return runtimeCachePrefix(scope) + versionKey;
}
export function offlineCacheName(versionKey: string, scope: string = currentScope()): string {
  return offlineCachePrefix(scope) + versionKey;
}

/**
 * Names written before scoping existed ("rda-offline-<versionKey>"). A scoped
 * name always has ":" where these have "-", so the two forms cannot be confused.
 * Nothing reads them after the rename, so the activate handler reclaims them —
 * which does cost existing web users their explicitly downloaded factions once.
 */
export function isLegacyUnscopedCacheName(name: string): boolean {
  return LEGACY_PREFIXES.some((p) => name.startsWith(p));
}
