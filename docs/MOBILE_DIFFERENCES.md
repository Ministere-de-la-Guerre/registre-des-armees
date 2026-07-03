# Mobile-only differences — web version

Running catalog of everything the **web** build does differently on touch devices
(phones/tablets) versus desktop browsers and the Electron desktop app. Desktop
Windows/Mac browsers and Electron are byte- and behavior-identical to each other;
every entry below is a fork that only applies on touch.

## How the fork is detected

- **Touch (phones + tablets):** `(hover: none) and (pointer: coarse)` — see
  `web/src/components/useCoarsePointer.ts` (`isCoarsePointer()` / `useCoarsePointer()`).
  Electron reports `hover: hover` / `pointer: fine`, so it is excluded automatically.
- **Phones only (excludes tablets):** the above **and** a phone-sized shorter
  viewport side (≤600px in either orientation) — `isPhone()` in the same file.
- CSS forks gate on the same media queries (never on width alone — a narrow
  desktop window must keep desktop behavior).

## Differences

### Applies to phones **and** tablets (coarse pointer)

1. **Collapsible top chrome.** A chevron tab hides/shows the top bar + corps
   header so the unit grid can own the viewport. Collapsed by default in short
   landscape (`(orientation: landscape) and (max-height: 500px)`), expanded in
   portrait. Desktop always shows the chrome, no tab. (`App.tsx`)

2. **Bottom tray → summary strip + bottom sheet.** Instead of the desktop's
   always-visible single row of 31 slots, touch shows a slim strip (cost, cards
   `N/31`, and for TOW `Corps N/4`) that expands into a scrollable bottom sheet.
   Only actual selections are drawn (at readable grid size), never the empty
   placeholder slots. Action buttons (Auto/Reset generals, Clear build) live
   inside the sheet at ≥44px targets. (`BottomTray.tsx` → `TouchTray`)

3. **Touch interaction model** (`Medallion.tsx`):
   - **Grid tap = select only.** No stat card pops up. (Desktop hover/focus that
     shows the stat card is gated off on coarse pointers — including the synthetic
     `mouseenter` a tap fires — so selecting never pops a card.)
   - **Grid long-press = simplified stat card** (the "peek" `Tooltip`, bottom-
     anchored, with a **Full details** button). Replaces the desktop
     right-click→details parity in the grid.
   - **Tray tap = simplified stat card** (same peek card + Full details). Desktop
     tray click opens the full `DetailsPanel` directly.
   - **Tray long-press = remove** the copy (mirrors desktop right-click).
   - Desktop mouse hover, focus-shows-tooltip (keyboard), click-for-details and
     right-click-to-remove are all unchanged.

4. **Tray medallions show the speed badge only** — matching the desktop tray.
   No cap `N/M` badge and no selected-checkmark in the tray (those stay in the
   grid). (`Medallion.tsx`, suppressed when `showSpeed` is set.)

5. **Corps-header controls bar is a horizontal swipe-scroller.** The stats +
   toggles + Generate-times / Corps-roll / Filters / Save-Load controls sit in a
   single row the player swipes through, at readable/44px size — instead of the
   desktop's static row (which, when it overflowed on a phone, clipped its stats
   off-screen). Because that row is now an overflow scroller, the **Save/Load
   ("Load ▾") dropdown becomes a fixed bottom sheet** on touch (it would
   otherwise be clipped by the scroller); it dismisses on tap-outside / Escape.
   (`styles.css` coarse-pointer block, `SaveLoadBar.tsx`)

6. **No native text selection / iOS loupe.** `user-select: none` +
   `-webkit-touch-callout: none` at the app root on touch, re-enabled only on
   copyable stat text (details/peek card, generate-times output). `useLongPress`
   also `preventDefault()`s once a long-press is recognized. (`styles.css`,
   `useLongPress.ts`)

### Applies to phones **only** (excludes tablets)

7. **Filter drawer starts collapsed.** On phones the filter panel is closed on
   first load so the unit grid is visible immediately; the header "Filters"
   button opens it. Tablets and desktop start with it open. (`Builder.tsx`,
   `filtersOpen` initialized from `!isPhone()`)

## Not mobile-specific (web-only, shown on all screen sizes)

These are web-vs-Electron differences, not touch-vs-desktop, listed here to avoid
confusion:

- PWA install/offline: service worker, `FactionOfflineButton` ("Save offline"),
  `OfflinePanel` (storage persist/estimate, per-faction + **Download all
  factions**, saves export/import), `UpdateToast`. All no-ops in Electron.

## Related docs

- `docs/MOBILE_UX_PASS.md` — the implementation spec these forks came from.
- `docs/MOBILE_PWA_PLAN.md` — the original PWA rollout plan.
