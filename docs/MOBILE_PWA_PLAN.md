# Mobile PWA — Execution Plan

Goal: make the army builder installable and fully usable **offline on iOS and Android** without app stores, as a Progressive Web App, while leaving the Windows desktop (Electron) channel untouched. One codebase, three targets: desktop app, mobile PWA, plain browser.

Status: IN PROGRESS (branch `mobile-pwa`).
- **Phase 0** done — hosting = GitHub Pages (public repo); install UX = pure PWA + in-app A2HS. Recorded in `docs/RELEASE.md` → Web channel. (The device-viewport screenshot/defect list is folded into Phase 5 — no hardware in the build env.)
- **Phase 1** done — `vite-plugin-pwa` (injectManifest) + `web/src/sw.ts`, manifest + icons, Electron-guarded registration (`web/src/pwa.ts`), update toast. Build verified (sw.js + manifest emit; precache excludes icons/factions).
- **Phase 2** done — per-faction "Save offline" (`web/src/state/offline.ts` + `FactionOfflineButton`), storage persist/estimate + saves export/import (`OfflinePanel`, `saves.ts`).
- **Phase 3** foundation done (desktop-safe) — long-press→right-click parity (`useLongPress`), safe-area + `100dvh` + narrow-width CSS. **Remaining** (needs the Phase 5 device pass): details-sheet Add/Remove buttons, tray→collapsible summary bar, panel→drawer restructuring, tap-to-open Tooltip.
- **Phase 4** done — `.github/workflows/deploy-web.yml` (GitHub Pages) + docs. One-time manual step: enable Pages (Settings → Pages → Source: GitHub Actions).
- **Phase 5** NOT started — needs real iOS/Android hardware.
- **Phase 6** NOT started — optional asset diet.

Note: `data-version.json` already carries content (schemaVersion + counts), so no `build_web_data.py` change was needed — the cache key derives from that content (`web/src/data/version.ts`).

## Grounding facts (verified 2026-07-03)

- The web app is React 18 + TS + Vite with `base: "./"` (`web/vite.config.ts`), so the production build already works from any sub-path — GitHub Pages / Cloudflare Pages compatible as-is.
- All asset/data URLs go through `assetUrl()`/`dataUrl()` (`web/src/data/assets.ts`) → clean, uniform URL space for a service worker to intercept.
- `web/public` payload = **211 MB / ~14.5k files**, split:
  - `data/` — 30 MB: `corps-index.json` (108 KB), `data/factions/*.json` (297 files, ≤756 KB each), `data-version.json` (cache-busting hook, currently empty).
  - `assets/icons/` — **176 MB / 13.6k PNGs** (by arm: infantry/cavalry/artillery/generals; filenames faction-prefixed).
  - `assets/army_corps_by_theatre/` — 5.2 MB / 520 files (corps pickers). `assets/ui/` — 4 KB.
- Saves are `localStorage` behind `StorageAdapter` (`web/src/state/storage.ts`) — works unchanged in a PWA, but iOS storage is evictable → need persistence + export.
- Electron loads the same build; service-worker registration must be guarded so the desktop app never runs it.

## Non-goals

- No app-store submission, no Capacitor/Tauri wrapper (can be a later Android-only add-on).
- No change to the desktop release pipeline (`desktop:*` scripts, electron-builder, `_github_assets*`).
- No data-pipeline changes except (optionally, Phase 6) icon spritesheets.

---

## Phase 0 — Feasibility spike & decisions (small)

1. Run `npm run dev`, exercise the app at 390×844 (iPhone) and 412×915 (Android) viewports; screenshot every screen/modal. Produce a concrete defect list for Phase 3 (expected hotspots: `BuilderGrid` medallion grid, `DetailsPanel`, `BottomTray`, `FilterPanel`, `TowRollModal`/`TowGenerateModal`/`RotationModal`, `Tooltip` hover-only behavior, `DualRange` touch dragging).
2. **Decide hosting.** Constraint: ~15k files, ~215 MB, must be free + HTTPS.
   - GitHub Pages: free only for public repos; 1 GB soft cap — OK if repo is/goes public.
   - Cloudflare Pages: free on private repos; 20k-file limit per deploy — currently OK (~15k), but Phase 6 spritesheets remove the risk margin concern.
   - Pick one; record in `docs/RELEASE.md`.
3. Decide install UX: pure PWA with in-app "Add to Home Screen" instructions (iOS has no install prompt; Android/Chrome shows one).

Exit criteria: hosting chosen, mobile defect list written, no unknown blockers.

## Phase 1 — PWA shell (manifest + service worker)

1. Add `vite-plugin-pwa` (Workbox under the hood) to `web/`.
2. Web app manifest: name, short name, theme/background colors, `display: standalone`, orientation, icon set (192/512 + maskable + Apple touch icon — derive from `web/build/` icon sources).
3. **Precache** (small, versioned by build): app shell (HTML/JS/CSS), `corps-index.json`, `assets/ui/**`, `army_corps_by_theatre/**` (5.3 MB total) — app boots offline to the corps picker.
4. **Runtime cache** (cache-first, no expiry — generated files are content-stable per data version): `data/factions/*.json` and `assets/icons/**`. Anything viewed once is available offline.
5. Cache invalidation: key runtime caches by the value in `data-version.json` (start actually populating it in `tools/build_web_data.py` if empty); on version change, drop stale caches.
6. Guard registration: register the SW only when `window.location.protocol` is http(s) and not running under Electron (`navigator.userAgent`/preload flag) — desktop behavior must be byte-identical.
7. In-app update flow: when a new SW is waiting, show a small "Update available — reload" toast (replaces electron-updater's role on web).

Exit criteria: Lighthouse PWA install checks pass; airplane-mode reload works for previously visited factions; Electron build unaffected (run desktop smoke test).

## Phase 2 — Offline data strategy & storage safety

1. **"Make available offline" per faction**: explicit button (corps picker or faction header) that fetches the faction JSON + every icon it references into the Cache API with a progress indicator. Per-faction weight is roughly 0.5–5 MB — sane on mobile. An "everything" option is deliberately out (176 MB).
2. Offline indicator: show which factions are fully cached; graceful message when navigating to an uncached faction while offline.
3. `navigator.storage.persist()` on first meaningful use; surface `storage.estimate()` in a small "storage" info row.
4. **Export/import saves**: serialize the `StorageAdapter` save set to a JSON file (download / share-sheet) and re-import. This is the insurance policy against iOS evicting site data. (Also useful desktop↔phone.)

Exit criteria: a faction can be downloaded, phone goes airplane-mode, full build flow works end-to-end; saves survive export→wipe→import.

## Phase 3 — Responsive / touch UI (largest phase)

Driven by the Phase 0 defect list. Known workstreams:

1. Viewport meta + `viewport-fit=cover` + safe-area insets (iOS notch, home-indicator) in `index.html`/`styles.css`.
2. Layout: single-column flow at narrow widths — corps picker, builder grid, details, tray. Likely `BottomTray` becomes a collapsible sheet; `FilterPanel` and `DetailsPanel` become drawers/sheets instead of side panels.
3. Touch: ≥44 px tap targets on medallions/controls; `Tooltip` needs a tap-to-open (and tap-away-to-close) mode; `DualRange` needs pointer-events touch support; kill hover-only affordances.
4. Modals (`RotationModal`, `TowRollModal`, `TowGenerateModal`, `SaveLoadBar` flows) sized to small screens, scrollable, keyboard-safe.
5. Test at 320 px width (smallest realistic) through tablet; no horizontal body scroll anywhere.
6. Per CLAUDE.md pixel-perfection rule: fix any desktop regressions introduced by responsive refactors — desktop look must not degrade.

### Interaction model — replacing right-click and hover (DECIDED)

Desktop today: grid medallion **right-click = details**, tray item / staff slot **right-click = remove/clear** (`Medallion.tsx` funnels both through the `onContextMenu` prop; `Builder.tsx`, `BuilderGrid.tsx`, `BottomTray.tsx`); **hover = stats `Tooltip`**. Touch has neither channel. Mapping:

- **Long-press = right-click, everywhere.** Shared `useLongPress` hook (pointer-down + ~450 ms timer, cancelled by move/release/scroll), wired to the existing `onContextMenu` callbacks — grid long-press opens details, tray long-press removes. Android Chrome already synthesizes `contextmenu` on long-press (handlers half-work today); the hook makes iOS match and dedupes the synthetic event on Android. Requires `-webkit-touch-callout: none` + `user-select: none` on medallions (suppress iOS "Save Image" sheet) and a visual press cue (brief highlight/scale) at trigger time.
- **Visible affordances are the primary path; long-press is the shortcut** (long-press is undiscoverable):
  - Details sheet (mobile `DetailsPanel`) gains **Add / Remove buttons**, so inspect-then-add works with no gesture knowledge and replaces the hover tooltip as the pre-add preview.
  - Tray medallions get an always-visible **× remove button** (touch layouts only). Swipe-to-remove deliberately skipped for v1 — × is more discoverable and less code.
- **Grid tap stays = add** (desktop parity, fast building). Known trade-off: no hover preview on mobile → accidental adds possible; mitigated by easy tray removal. Revisit after Phase 5 device testing; fallback model is "tap opens details sheet, add from there".
- Keyboard shortcuts (`Enter`/`Delete`/`i` in `Medallion.tsx`) unchanged; desktop mouse behavior byte-identical.

### Responsive strategy — screen sizes & aspect ratios (DECIDED)

Design 3 fluid layout modes, not per-device layouts; CSS absorbs everything in between:

- **Medallion grid**: CSS grid `repeat(auto-fill, minmax(<medallion-w>, 1fr))` — column count derives from width automatically; aspect ratio is absorbed by vertical scroll.
- **Breakpoints define structure only**: narrow (<~700 px: single column, panels→drawers/sheets, tray→collapsible summary bar), medium (tablet portrait / phone landscape: grid + one panel), wide (current desktop layout, untouched). Everything inside a mode uses fluid units (`clamp()` type scale, `rem`/`%` spacing, no fixed container widths).
- **Mobile viewport traps**: `100dvh` not `100vh` (URL-bar collapse breaks fixed bottom trays); `viewport-fit=cover` + `env(safe-area-inset-*)` padding.
- **No orientation lock**: phone landscape lands in the medium mode; keep fixed chrome (header, tray bar) short so squat viewports still show useful grid.
- Pixel density is a non-issue (PNG icons render below native size, crisp at 3×). Test 320 px → tablet in DevTools; safe-area/dvh verified on hardware in Phase 5.

Exit criteria: full build/save/load/roll flow is comfortable one-handed on a phone; desktop rendering unchanged (visual diff of key screens).

## Phase 4 — Deploy pipeline & docs

1. GitHub Actions workflow: on push to `main` (or on tag), `npm run build` in `web/` → deploy `dist/` to chosen host. Web deploys are decoupled from desktop releases (desktop stays manual per `docs/RELEASE.md`).
2. Decide web-versioning story: web tracks `main` continuously vs. tags — recommend continuous (SW update toast makes rollout safe), with `data-version.json` gating data caches.
3. Update `docs/RELEASE.md` (new "web channel" section), `docs/AI_FILEMAP.md`, `README.md` (player-facing install instructions for iPhone/Android), `docs/HANDOFF.md` if architecture text mentions targets.

Exit criteria: merge to main → live site updates; docs describe all three channels.

## Phase 5 — Real-device validation

1. iOS Safari: Add to Home Screen → standalone launch, offline flow, storage persistence after several days idle, saves export via share sheet.
2. Android Chrome: install prompt, offline flow, back-button behavior in standalone mode.
3. Regression: Windows desktop app (no SW, no behavior change), plain desktop browser.
4. Fix-forward on findings; only then announce/link the PWA to players.

## Phase 6 (optional, later) — Asset diet

- Pack icons into **per-faction spritesheets** in `tools/build_web_data.py` (13.6k PNGs → ~300 sheets): faster offline downloads, far fewer requests, removes host file-count risk. Requires `Medallion`/CSS changes to render from sprite coordinates — do only if Phase 2 download times prove annoying.
- Alternative cheaper win: recompress PNGs (e.g. oxipng/pngquant) in the pipeline.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| iOS evicts site storage on long-idle installs | `storage.persist()` + export/import saves (Phase 2) |
| 176 MB icon set can't be fully precached | lazy cache-first + per-faction explicit download |
| SW cache serves stale data after a data rebuild | cache keys derived from `data-version.json` |
| SW breaks the Electron desktop app | registration guard + desktop smoke test in Phase 1 exit criteria |
| Host file-count/size limits | Cloudflare 20k-file headroom now; Phase 6 spritesheets as the durable fix |
| Responsive refactor regresses desktop UI | Phase 3 exit criteria include desktop visual diff |

## Suggested order & sizing

Phases are sequential; 0→1→2 gives a working (ugly-on-mobile) offline PWA quickly, 3 makes it pleasant, 4→5 makes it real. Rough effort split: Phase 3 ≈ half the total work; Phases 1–2 ≈ a quarter; the rest spread across 0/4/5.
