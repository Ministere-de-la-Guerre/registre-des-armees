# Mobile UX pass — implementation instructions

Status: IMPLEMENTED on the `mobile-pwa` branch. Follow-up to the responsive/touch pass (commit 269ee86) after real-device testing of the deployed PWA surfaced four usability problems, plus one offline feature request.

## Scope gate (applies to every item below)

All changes apply to **phones and tablets only**. Desktop browsers on Windows/Mac and the Electron build must stay pixel- and behavior-identical.

- CSS: gate under `@media (hover: none) and (pointer: coarse)` (optionally combined with width/orientation queries where noted). Do NOT gate on width alone — a narrow desktop window must keep desktop behavior.
- JS/TSX: where behavior forks (tooltip trigger, long-press semantics), detect the same way, e.g. `matchMedia("(hover: none) and (pointer: coarse)")`, evaluated once and shared (small hook or module constant). Pointer-event `pointerType` checks are fine where a specific event is in hand (the `useLongPress` hook already ignores mouse pointers).
- Electron is `hover: hover` / `pointer: fine`, so it is excluded automatically; no extra guard needed.

## 1. Hideable + scrollable top bar and bottom tray

Problem: on phones the fixed top bar and bottom tray together consume most of the screen — landscape is unusable, portrait leaves a sliver of grid. The tray squeezes 31 slots into one row of unreadably small medallions.

Both bars become **collapsible**, and their expanded content becomes **scrollable at readable size** instead of shrinking to fit.

### 1a. Bottom tray (`BottomTray.tsx` + `styles.css`)

- **Collapsed state (default on touch devices):** a slim summary strip (~40–48px tall) pinned to the bottom. Shows the running numbers the user needs at a glance — total cost, cards used `N/31`, and for TOW the `Corps N/4` stat — plus an expand affordance (chevron / drag-handle pill). Respect `env(safe-area-inset-bottom)` as the current tray does.
- **Expanded state:** a bottom sheet overlaying the grid (grid does not reflow under it; the sheet sits on top with a scrim or shadow). Content:
  - Commander slot + all selected copies as medallions at **readable size** — reuse the grid medallion size, not the current `tray-mini` squeeze — in a **wrapping grid that scrolls vertically** when it overflows the sheet.
  - Do not render the 31 empty placeholder slots on touch; show only actual selections (the `N/31` count in the strip carries that information).
  - The action buttons (Auto generals / Reset generals / Clear build) live inside the sheet, at ≥44px touch-target size.
- **Toggle:** tap the strip (or the chevron) to expand; collapse via the same chevron, tapping the scrim, or swiping the sheet down. Adding a unit from the grid must NOT auto-expand the sheet — the strip's cost/count updating is the feedback.
- Sheet max-height ≈ 60–70% of the viewport in portrait, and in landscape it may take most of the height (it's an overlay, so that's fine).
- Desktop keeps the existing always-visible single-row tray untouched.

### 1b. Top bar (`App.tsx` / topbar markup + `styles.css`)

- Add a **hide/show toggle** on touch devices: a small persistent chevron tab (respecting `env(safe-area-inset-top)`) that collapses the top bar to just that tab and re-expands it. Collapsed by default in landscape on short viewports (`(orientation: landscape) and (max-height: ~500px)`), expanded by default in portrait.
- When expanded and its content overflows, the bar **scrolls instead of shrinking**: controls stay at readable/tappable size (≥44px targets), with the control row horizontally scrollable (momentum scroll, no visible scrollbar chrome needed) or the whole bar vertically scrollable capped at a max-height — pick whichever reads better with the current bar structure, but never font-shrink below readable.
- The filter panel / corps picker entry points must remain reachable from the collapsed state (they're inside the bar, so the tab is the path — that's acceptable).

## 2. Touch interaction model: tap = select, long-press = simplified stat card

Problem: on touch, a tap both selects the unit AND pops the simplified stat card. Root cause: tap focuses the medallion and `Medallion`'s `onFocus` fires the same hover path (`onHover` → `Tooltip`) as mouse-enter.

New model on touch devices (desktop mouse/keyboard behavior unchanged, including focus-shows-tooltip for keyboard users — gate on pointer type, not on focus itself, if feasible; otherwise gating the whole hover/focus tooltip path off on coarse-pointer devices is acceptable):

- **Tap on a grid medallion = select only.** No card, no popup. The tray strip updating is the feedback.
- **Long-press on a grid medallion = show the simplified stat card** (the existing `Tooltip` component content), NOT the full `DetailsPanel`. This replaces the current long-press→details parity in the grid.
  - Position: on phones the anchored-to-DOMRect placement will overflow; render it as a bottom-anchored popover (above the tray strip) or centered card instead. Must never clip off-screen.
  - Dismiss: tap anywhere outside it, tap it, or scroll.
  - Add a small **"Full details" action** on the card so `DetailsPanel` stays reachable on touch (it is otherwise orphaned once long-press stops opening it).
  - Blocked-reason text (`blockReason`) must still appear on the card as it does for hover today.
- **Tray (expanded sheet) on touch:** **long-press stays REMOVE** (unchanged, mirrors desktop right-click) — confirmed by the user; do NOT rewire it to the peek card. Tap on a tray medallion, which opens the full details panel today, routes to the **simplified card** on touch instead (with a "Full details" action), matching the grid's peek surface. Desktop click-for-details and right-click-to-remove stay unchanged.
- `useLongPress` already suppresses the synthetic click/contextmenu after a long-press; keep that working with the new callback wiring.

## 3. Kill the iOS text-selection highlight / loupe on long-press

Problem: long-pressing near (not on) medallions — unit names, brigade headers, bar labels, gaps — starts iOS text selection with the loupe.

- Apply `user-select: none` + `-webkit-user-select: none` + `-webkit-touch-callout: none` at the **app root**, gated to touch devices (`@media (hover: none) and (pointer: coarse)`), instead of only on `.medallion`.
- Re-enable `user-select: text` only where copying is plausibly useful: the stat text inside `DetailsPanel` / the simplified card, and any generate-times output the user might copy. Nothing else.
- In `useLongPress`, `preventDefault()` on the initiating touch/pointer event once a long-press is recognized, to suppress residual native behaviors (Android image-save sheet, stray selection) — without breaking scroll (only prevent once the press is recognized as long, not on touchstart).

## 4. One-click "Download all" for offline

Problem: offline caching is per-faction only; the user wants every corps/faction downloadable with a single click and accepts a long wait.

- Add a **"Download all factions"** button to `OfflinePanel.tsx`, driven by a new orchestrator in `state/offline.ts` that loops the full faction list (same list the corps picker loads) calling the existing `downloadFactionOffline` **sequentially** (or concurrency 2 max — icon fetches inside a faction already fan out; don't hammer GitHub Pages).
- Before starting: call `requestPersistentStorage()`; show the `storageEstimate()` numbers and a rough expected-size note so the wait/size is expected.
- Progress UI: "Faction 12 / 50 — <name>", per-faction reuse of the existing `DownloadProgress` if cheap, plus a **Cancel** button (cancel finishes the in-flight faction, keeps what's already cached).
- **Skip factions already offline** at the current data-version key (`isFactionOffline`), so the button is also a cheap "complete my set" / resume after cancel or failure.
- Per-faction failures do NOT abort the run: continue, collect failures, and report them at the end ("47 downloaded, 3 failed: …") with the button acting as retry.
- Everything stays keyed to the data-version cache key exactly like single-faction downloads; no new cache scheme. Web-only, same `offlineSupported()` guard (no-op in Electron).

## Acceptance checklist

- iPhone-size viewport, landscape: with both bars collapsed, the unit grid gets ≥80% of the viewport height; every control still reachable.
- Portrait: collapsed tray strip shows cost / N-of-31 / corps stat; expanding shows every selected unit at grid-medallion size, scrollable.
- Touch: tap adds instantly with no card popup; long-press in the grid shows the simplified card on-screen (never clipped) with a working "Full details" action; long-press in the tray still removes the copy.
- Long-press anywhere in the app on iOS produces no text-selection highlight or loupe.
- "Download all" on a fresh install ends with every faction listed as offline; airplane-mode app loads any corps; cancel + re-run resumes without re-downloading finished factions.
- Desktop browser + Electron: zero visual or behavioral change (hover tooltip, right-click, always-visible tray with 31 slots, no chevrons/tabs). `npm run test`, `lint`, `typecheck` green.
