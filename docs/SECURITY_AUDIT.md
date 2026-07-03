# Security & Logic Audit — Registre des Armées

Date: 2026-07-03
Scope reviewed: Electron main process, updater, custom `app://` protocol, data
loading/normalization, persistence (localStorage saves, JSON import/export),
rules/build/rotation logic, Python build tools.

Overall this is a low-attack-surface desktop app: `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`, no preload bridge, no remote content,
React (auto-escaping), and no `dangerouslySetInnerHTML`/`eval`/`innerHTML`
anywhere. The findings below are mostly hardening and correctness issues rather
than actively exploitable holes. They are ordered by severity.

---

## 1. [Medium] Unbounded instance expansion on build import → tab-freeze DoS

**File:** `web/src/state/saves.ts` (lines ~51–54, in `migrateSavedBuild`)

`importBuildJson()` parses arbitrary user-pasted/shared JSON and hands it to
`migrateSavedBuild`. The v1 `selection` migration expands a per-unit *count* into
individual instances with no upper bound:

```ts
for (const [k, v] of Object.entries(r.selection as Record<string, unknown>)) {
  const n = typeof v === "number" ? v : Number(v);
  for (let i = 0; i < Math.floor(Number.isFinite(n) ? n : 0); i += 1) instances.push(k);
}
```

A crafted import such as `{"factionKey":"x","selection":{"a":1e12}}` makes the
loop run a trillion times, hanging (and eventually OOM-ing) the renderer. Because
imported builds come from other users / files, this is untrusted input.

**Fix:** clamp each count and the total instance list to a sane maximum.

```ts
const MAX_INSTANCES = 1000; // a legal roster is far smaller
...
const count = Math.min(Math.floor(Number.isFinite(n) ? n : 0), MAX_INSTANCES);
for (let i = 0; i < count && instances.length < MAX_INSTANCES; i += 1) instances.push(k);
```

Also cap the `r.instances`/`r.selection`/`r.unitKeys` array branches:
`instances = instances.slice(0, MAX_INSTANCES);` before returning. Unknown keys
are already dropped later by `resolveSavedBuild`, so a cap here is purely
protective and changes no legitimate behavior.

---

## 2. [Low] Path-traversal guard uses prefix match without a separator

**File:** `web/electron/main.cjs` (lines ~178–181)

```js
const filePath = path.normalize(path.join(DIST, rel));
if (!filePath.startsWith(DIST)) {
  return new Response("Forbidden", { status: 403 });
}
```

`startsWith(DIST)` also accepts a *sibling* directory whose name merely begins
with the dist path — e.g. if `DIST` is `.../resources/app.asar/dist`, a resolved
path of `.../resources/app.asar/dist-backup/x` passes the check. `path.join`
collapses `..`, so a request like `app://bundle/../dist-backup/secret` could
escape the intended folder. Impact is limited (requests only originate from the
trusted renderer, and there is normally nothing sensitive beside `dist`), but the
guard is incorrect.

**Fix:** require an exact match or a real path-separator boundary.

```js
const DIST_PREFIX = DIST + path.sep;
if (filePath !== DIST && !filePath.startsWith(DIST_PREFIX)) {
  return new Response("Forbidden", { status: 403 });
}
```

---

## 3. [Low] No Content-Security-Policy (defense in depth)

**Files:** `web/index.html`, `web/electron/main.cjs`

There is no CSP — neither a `<meta http-equiv="Content-Security-Policy">` tag nor
a header injected on the `app://` responses. Today React escaping + no dynamic
HTML make XSS unlikely, but a CSP is the standard Electron backstop: if a future
change ever introduces an injection sink, a strict policy blocks inline script,
`eval`, and remote loads.

**Fix (preferred — set a header on every `app://` response):** in the
`protocol.handle("app", …)` handler, add to the response headers:

```js
"content-security-policy":
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'none'",
```

(Vite emits hashed module scripts served from `app://`, so `script-src 'self'`
is sufficient; keep `'unsafe-inline'` for styles only if the app relies on inline
styles — tighten later if possible.)

---

## 4. [Low] No navigation lock on the main window

**File:** `web/electron/main.cjs` (`createWindow`)

`setWindowOpenHandler` correctly denies new windows and only opens `http(s)`
links externally. But there is no `webContents.on("will-navigate", …)` guard, so
if any bug ever caused the top-level frame to navigate (a stray `location =` , a
drag-drop of a URL, etc.), the renderer could leave the `app://` origin.

**Fix:** block top-level navigation away from the app origin.

```js
win.webContents.on("will-navigate", (e, url) => {
  if (!url.startsWith("app://") && url !== DEV_SERVER_URL) e.preventDefault();
});
```

---

## 5. [Low] Auto-update integrity depends on TLS + hash only if installers are unsigned

**File:** `web/electron/main.cjs` (`setupAutoUpdates`), `web/package.json` (build config)

The updater pulls `latest.yml` + installer from GitHub Releases over HTTPS and
electron-updater verifies the SHA512 from the yml. There is no code-signing
config (`certificateFile`/`win.signtoolOptions`) in `package.json`, so update
authenticity rests entirely on TLS to GitHub plus the hash in a file fetched the
same way. That is acceptable for a hobby app but means anyone who can serve a
forged GitHub response (or compromises the release repo) can push a malicious
update that installs silently (`autoInstallOnAppQuit = true`).

**Fix / note:** ideally sign the Windows build (Authenticode) so electron-updater
enforces publisher identity. At minimum, document that release-repo write access
is the trust root and protect those credentials. No code change strictly required
— tracking item.

---

## 6. [Low logic bug] `isDirty` ignores unit order, so reorders are silently lost

**File:** `web/src/state/saves.ts` (lines ~128–137)

```ts
const a = [...current.build.instances.map((i) => i.unitKey)].sort();
const b = [...saved.instances].sort();
if (a.length !== b.length || a.some((k, i) => k !== b[i])) return true;
```

The save format stores **ordered** instances (`buildToSaved` preserves tray
order, and the grid/tray order is user-meaningful), but `isDirty` sorts both
sides before comparing — treating the build as a multiset. Consequence: if the
user only *reorders* units and then closes/loads another build, the app believes
there are no unsaved changes and the reorder is discarded without a prompt.

**Fix:** compare in order (drop the `.sort()`), since order is part of the saved
state:

```ts
const a = current.build.instances.map((i) => i.unitKey);
const b = saved.instances;
if (a.length !== b.length || a.some((k, i) => k !== b[i])) return true;
```

If order is deliberately *not* meant to be significant, then `buildToSaved`
should also normalize order — but pick one; the two functions currently disagree.

---

## 7. [Informational] DST edge in rotation window arithmetic

**File:** `web/src/state/rotation.ts` (`windowStart`/`nextWindowStart`/`prevWindowStart`)

Window math uses `Date.setHours` on local time. On the two days a year with a
DST transition, a local hour can be skipped or repeated, so a predicted window
boundary near the transition can be off by an hour. This mirrors how the game
itself reads `os.date`, so it may be *correct* to leave as-is, but it is worth a
comment noting the intentional local-time behavior so it is not "fixed" later.

**Action:** no change required; document the assumption.

---

## Checked and found clean

- No `eval` / `new Function` / `innerHTML` / `document.write` / `dangerouslySetInnerHTML` in the web app.
- Image `src` values come from generated, trusted data and are rendered via React attributes (no `javascript:`/HTML injection path).
- `factionKey` used in `fetch("factions/${factionKey}.json")` originates from the trusted generated corps-index, not user input — no request-forgery/traversal via that path.
- Python build tools: no `shell=True`, `os.system`, `eval`, `exec`, `pickle`, or `yaml.load`.
- `localStorage` access is defensively wrapped; JSON parsing is guarded and tolerant of bad shapes.
- Electron `webPreferences` are hardened (context isolation on, node integration off, sandbox on, no preload).

---

## Suggested fix order

1. **#1** (import DoS) — small, self-contained, protects untrusted input.
2. **#6** (`isDirty` order) — one-line correctness fix, user-visible data loss.
3. **#2** (path-guard separator) — one-line hardening.
4. **#3 / #4** (CSP + navigation lock) — defense in depth in `main.cjs`.
5. **#5** (signing) — process/tracking item.
