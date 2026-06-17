# Changelog

All notable changes to the Registre des Armées desktop app are recorded here.
The format is based on [Keep a Changelog](https://keepachangelog.com/), and the
project follows the version in `web/package.json`.

## [1.2.4] — 2026-06-17

### Changed
- The build tray's "Clear build" button now floats as a tab on the top-right corner
  above the tray rectangle (its right edge meeting the scrollbar), freeing horizontal
  space so each selected-unit portrait renders slightly larger without enlarging the
  tray.
- Selected-unit cost numbers in the tray drop the gold coin glyph — just the bolded
  gold figure remains — and the oval's grey frame now sits fully behind the number
  instead of clipping it.

### Added
- Selected units in the tray now show a speed/movement code badge (e.g. L4, C2) in
  the top-left corner, matching the men-count badge style.

## [1.2.2] — 2026-06-16

### Changed
- The build tray's Commander portrait now scales to the exact same size as the
  selected-unit slots at any window size, instead of staying a fixed width. Its
  "Commander" label and the divider line are kept.
- The "Clear build" button is now narrower (label stacked on two lines), giving the
  unit row a little more width, and is vertically centred with the icon row.

## [1.2.1] — 2026-06-15

### Changed
- The Load menu now lists only builds saved for the corps currently open, instead
  of every saved build across all corps.

### Fixed
- A staff general now shows 1/1 on its cap badge once placed in the staff slot,
  instead of remaining 0/1.

## [1.2.0] — 2026-06-15

### Fixed
- Save and Save As now work in the desktop app. They relied on `window.prompt()`
  to name a build, which Electron does not support (it throws), so naming a build
  silently failed. Build naming (Save As / Rename) now uses an in-app dialog.

## [1.1.2] — 2026-06-15

### Added
- Desktop app icon (Imperial Eagle) branding the app, installer, and taskbar.

### Changed
- Within a brigade, foot and horse artillery are treated as one type and sorted
  together by cost, instead of always placing foot guns before horse guns.

## [1.1.1] — 2026-06-15

### Changed
- Combat generals now count against the foot/horse artillery caps of the unit
  they lead — they can no longer push a build past 2 foot / 1 horse gun.
- The unit-class filters (Grenadiers, Line, etc.) now also match combat generals
  associated with that unit class.
- The support division (final artillery/sapper/skirmisher division) no longer
  earns any brigade or division cost discount.

### Fixed
- Untagged reserve artillery was being merged into the final *combat* division on
  some corps (e.g. 1812 7. Junot); it now forms its own support division.

## [1.1.0] — 2026-06-15

### Added
- Staff generals that would exceed the 10,000 cost limit are greyed out and
  cannot be selected.

### Changed
- The Infantry/Cavalry/Artillery category filters now also match a combat general
  by its base unit type, not only the Generals category.
- Default grid density is now Compact.
- Brigade ordering: mixed unit types order infantry/skirmishers, cavalry, then
  artillery (cost-desc within each type).
- The unit-cap badge shows shared cap-group usage, so a base unit and its combat
  general both read e.g. 2/2 when the shared cap is reached.

### Fixed
- The unit-cap badge is no longer clipped by the portrait frame.

## [1.0.2] — 2026-06-14

### Changed
- Army-builder fixes; Windows desktop build.

## [1.0.1] — 2026-06-14

### Changed
- Army-builder fixes; Windows desktop build.

## [1.0.0] — 2026-06-14

### Added
- Initial beta: NTW3 army builder as a Windows desktop app (Electron) with
  GitHub-based auto-update.

[1.2.1]: https://github.com/Ministere-de-la-Guerre/registre-des-armees/releases/tag/v1.2.1
[1.2.0]: https://github.com/Ministere-de-la-Guerre/registre-des-armees/releases/tag/v1.2.0
[1.1.2]: https://github.com/Ministere-de-la-Guerre/registre-des-armees/releases/tag/v1.1.2
[1.1.1]: https://github.com/Ministere-de-la-Guerre/registre-des-armees/releases/tag/v1.1.1
[1.1.0]: https://github.com/Ministere-de-la-Guerre/registre-des-armees/releases/tag/v1.1.0
[1.0.2]: https://github.com/Ministere-de-la-Guerre/registre-des-armees/releases/tag/v1.0.2
[1.0.1]: https://github.com/Ministere-de-la-Guerre/registre-des-armees/releases/tag/v1.0.1
[1.0.0]: https://github.com/Ministere-de-la-Guerre/registre-des-armees/releases/tag/v1.0.0
