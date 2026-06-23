# AI Agent Handoff: Registre des Armees

This document is for another AI agent taking over the project. It explains the
repository layout, app architecture, data pipeline, rules math, and release
workflow. The short version: this is a desktop-first React/Vite/Electron army
builder for NTW3, backed by generated data from exported game tables and a
source-parity rules engine.

## Project Purpose

Registre des Armees lets a user choose an NTW3 army corps, browse every
recruitable unit card for that corps, build an army, see cost and limit feedback,
save/load builds, and package the result as a Windows desktop app.

The app is not a random-roll emulator. It deliberately exposes all staff and
combat-general cards available to the selected corps. Selection caps enforce how
many may be used.

## Repository Map

Root files:

- `README.md`: project documentation and the best source of rule provenance.
- `docs/CHANGELOG.md`: release notes. It currently stops at 1.2.4 even though
  `web/package.json` is 1.3.1.
- `docs/Instructions.txt`: original/manual project instructions.
- `docs/HANDOFF.md`: this file.
- `data/generated/ntw3_army_builder_units.csv`: primary generated unit/corps database.
- `data/generated/army_corps_catalog.csv` and
  `data/generated/army_corps_catalog.json`: generated corps/theatre selection
  index and flag metadata.
- `data/staff_generals/staff_general_corps_placement.csv` and
  `data/staff_generals/staff_general_corps_placement_with_stars.csv`:
  staff-general placement/star reference data.

Important directories:

- `data/generated/`: generated data used by the Python tools and web import.
- `data/staff_generals/`: staff-general placement CSV outputs.
- `docs/`: project notes, changelog, instructions, and this handoff.
- `source/tables/`: exported TSV source tables from NTW3.
- `source/reference/`: extra reference TSVs, currently including uniforms.
- `source/original_*`: extracted original game assets kept for provenance.
- `assets/icons/`: normalized icon source tree by broad class.
- `assets/icons_by_army_corps/`: icons organized by faction and division.
- `assets/staff_general_icons_by_corps/`: staff-general portraits at corps root.
- `assets/army_corps_by_theatre/`: generated flag assets grouped by side/theatre.
- `assets/ui/`: command-star strips and guerrilla badge overlay.
- `reports/`: validation summaries, merge warnings, manifests, previews.
- `tools/`: Python data-build and validation tools.
- `web/`: React/Vite/Electron desktop app.
- `web/public/`: generated app data/assets consumed by Vite.
- `web/dist/`: production Vite build.
- `web/release/`: electron-builder output.
- `web/release/_github_assets/`: curated files to upload to a GitHub release.

Do not treat `web/node_modules/`, `web/dist/`, `web/release/`,
`web/public/data/`, or `web/public/assets/` as hand-authored code. They are
dependencies or generated output. Edit the generator/source data instead.

## Development Commands

From repo root:

```powershell
python tools/build_ntw3_army_builder_database.py
python tools/build_army_corps_catalog.py
python tools/build_web_data.py
python -m unittest discover -s tools/tests -v
```

From `web/`:

```powershell
npm run build:data
npm test
npm run lint
npm run build
npm run desktop
npm run desktop:dir
```

`npm run build:data` runs `python ../tools/build_web_data.py`.
`npm run desktop` runs the Vite build and electron-builder without publishing.
`npm run desktop:release` publishes to GitHub if `GH_TOKEN` is configured.

## Data Pipeline

There are two main generation stages.

Stage 1: raw NTW3 tables to root CSV/catalog.

- `tools/build_ntw3_army_builder_database.py`
  reads `source/tables/*.tsv`, joins unit stats, permissions, localisation,
  projectiles, command ratings, icons, abilities, and placement data, then writes
  `data/generated/ntw3_army_builder_units.csv`, `reports/ntw3_merge_warnings.csv`, and
  `reports/ntw3_merge_summary.txt`.
- `tools/build_army_corps_catalog.py`
  reads the generated unit CSV plus `source/tables/ntw3_factions.tsv`, copies and
  normalizes flags, and writes `data/generated/army_corps_catalog.csv`,
  `data/generated/army_corps_catalog.json`, `assets/army_corps_by_theatre/`, and
  `reports/army_corps_catalog_validation.txt`.
- `tools/organize_icons_by_army_corps.py` creates the icon-by-corps tree and
  reports.
- `tools/build_command_star_assets.py` and `tools/collect_staff_general_icons.py`
  maintain supporting UI/staff-general assets.

Stage 2: root CSV/catalog to web app data.

- `tools/build_web_data.py` reads `data/generated/ntw3_army_builder_units.csv`
  and `data/generated/army_corps_catalog.json`.
- It writes `web/public/data/corps-index.json`,
  `web/public/data/data-version.json`, and one roster JSON per selectable faction
  under `web/public/data/factions/`.
- It converts TGA unit icons to PNG and copies browser-friendly assets to
  `web/public/assets/`.
- Current generated web manifest:
  schema version 1, 247 faction rosters, 247 listed corps, 25,668 source rows,
  12,032 excluded ToW rows.

ToW faction rows and ToW unit variants are excluded from the app at this second
stage. The source/root CSV can still contain ToW data.

## Web App Architecture

The app code lives in `web/src/`.

- `main.tsx`: React entrypoint.
- `App.tsx`: top-level flow. Loads the corps index, shows `CorpsSelect`, loads a
  selected faction roster, then renders `Builder`.
- `data/assets.ts`: resolves public-relative asset/data URLs against Vite
  `base: "./"`.
- `data/load.ts`: validation/normalization layer. It fetches generated JSON and
  converts unknown raw data into stable domain models with safe defaults.
- `domain/types.ts`: versioned in-app TypeScript domain models.
- `rules/rules.ts`: TypeScript rules engine. It is a parity port of
  `tools/army_builder_rules.py`; keep them behaviorally aligned.
- `state/build.ts`: selected build model, add-blocking, soft-budget pricing,
  auto combat-general replacement, reset logic, and summary derivation.
- `state/filters.ts`: filter model and matching.
- `state/ordering.ts`: unit-card ordering within staff/brigade groups.
- `state/saves.ts`: versioned save/load repository.
- `state/storage.ts`: storage abstraction over localStorage/in-memory fallback.
- `components/`: UI pieces for selection, builder grid, cards, details, filters,
  bottom tray, and save/load controls.

Data flow:

1. `App` calls `loadCorpsIndex()`.
2. User chooses a `CorpsEntry`.
3. `App` calls `loadFaction(factionKey)`.
4. `Builder` indexes the roster with `indexRoster()`.
5. User selections mutate a `BuildState`.
6. `summarize()` expands state into selected cards, price, limits, men, squares,
   and violation messages.
7. Components display derived state only; rule math should stay in `rules/` and
   `state/`.

## Domain Model Notes

`UnitCard` is the central in-app shape. Key fields:

- `unitKey`, `factionKey`, `name`, `unitClass`
- `cost`: base MP recruitment cost from the source CSV.
- `cap`: card row cap.
- `groupCap`: cap for the underlying base unit, shared with commander variants.
- `capGroupKey` / `baseUnitKey`: base key after stripping final `_com_<digits>`.
- `placement`: display/pricing division and brigade, or null.
- `placementSource`: provenance from the generator.
- `isGeneral`, `isCommanderVariant`, `generalKind`
- `underlyingUnitClass`: base unit class used for combat generals.
- `finalMen`: display men count; staff generals always show 16.
- `stats` and `abilities`
- `icon`, `commandStarStrip`, `guerrillaBadge`

`BuildState` stores explicit selected instances:

```ts
interface BuildState {
  instances: { id: string; unitKey: string }[];
  staffSlotUnitKey: string | null;
}
```

Every selected copy has its own instance id so duplicate copies can be removed
independently. The staff/commander slot is separate and holds at most one general.

## Core Rules Math

The source-backed implementation is in `tools/army_builder_rules.py`; the app
uses the TypeScript port in `web/src/rules/rules.ts`.

### Base Cost

Every selected card contributes its own MP cost:

```text
base_cost = sum(selected_card.cost)
```

Commander variants already have their own row costs. Do not add base-unit cost
on top of a commander variant.

### Formation Discount Eligibility

Only faction keys containing `_ac_` receive brigade/division discounts.

For each recruitable non-general card in the selected faction with a placement:

```text
roster_cost contribution = cap * cost
required_count contribution = cap
```

Generals are excluded from the roster totals. A selected placed general still
adds one selected card to its division/brigade completion count.

For each group:

```text
group_discount = floor(roster_cost * (required_count - 1) / 100)
```

A complete division replaces its brigade discounts. If a division is complete,
only the division discount is credited; otherwise each complete brigade can
credit its brigade discount. They never stack.

German States get a 1.5x total discount:

```text
normal_discount = sum(completed_group.discount)
applied_discount = floor(normal_discount * 3 / 2)  # German States only
final_cost = base_cost - applied_discount
```

German States detection is intentionally narrow:

```text
faction_key.split("_")[3] contains lowercase "g"
```

Keep integer floor arithmetic. Do not replace with floating rounding.

### Support Divisions

Support/reserve divisions do not earn discounts.

A division is support if:

- it is explicitly/designated by `placementSource` as one of
  `inferred_new_support_division`, `inferred_existing_support_division`, or
  `reserve_support_division`; or
- it contains only support arms and has artillery.

Support arms are foot/fixed artillery, horse artillery, skirmishers, sappers, and
marines. Sappers/marines are detected by name because they can be classed as
line/grenadier infantry.

A combat division with organic artillery is still a combat division and can earn
discounts. A pure skirmisher division with no artillery is treated as combat
unless the generator explicitly marked it as support.

### General Classification

General-class cards require raw men data. Classification uses exact `menRaw`, not
the displayed/final men count:

```text
menRaw 32 or 122 -> staff general
anything else    -> combat general
```

Missing raw men is a data error in rules code. The generator supplies fallback
raw men for known staff/general cases where appropriate.

All `_gen_staff_` cards display `finalMen = 16`.

### General Caps

Staff cap is always 1.

For non-AC/non-ToW factions:

```text
combat cap = 1
```

For faction keys containing `_ac_` or `_tow_`:

```text
N = trailing digits from the fourth underscore component
combat cap = 9 - N
```

Example: `ntw3_ac_test_x5_001` has combat cap 4.

There is a separate `acSelectionGeneralMaxima()` helper for source-reference AC
general pools:

```text
staff = 1
combat = combat_cap + 2
```

The UI does not use that helper for card visibility.

### Staff Slot

The app has one staff/commander slot.

- A staff general can occupy it.
- A combat general can also occupy it.
- A combat general in the staff slot still keeps its identity, cost, stars,
  placement, and shared cap group.
- A combat general in the staff slot does not count against
  `combat_generals_against_cap`.
- The slot can hold only one general.

Rules validation models this with `staffSlotIndex` into the expanded selected-card
array.

### Known Limits

Hard limits:

```text
total unit cards = 31
foot artillery   = 2
horse artillery  = 1
heavy cavalry    = 10
staff slot       = 1
combat generals  = combat cap
unit cap         = shared cap group count <= groupCap
combat general   = max one combat-general variant per base unit
```

Combat generals count by `underlyingUnitClass` for foot-artillery,
horse-artillery, and heavy-cavalry limits. An artillery-led combat general uses
an artillery slot.

The unit cap group is the base unit key after stripping a final `_com_<digits>`.
Base unit copies and all combat-general variants share that cap.

### 10,000 Budget Rule

`MAX_BUILD_COST` is 10,000.

The UI treats the budget as a soft ceiling:

- adding a unit that pushes the build over 10,000 is allowed;
- the grid/tray warns by coloring costs red;
- the build can end above 10,000.

Discount eligibility still uses an affordability replay:

1. Recruit order is commander/staff slot first, then unit instances in the order
   they were added.
2. For each candidate card, compute the current discounted final cost from only
   previously affordable cards.
3. The candidate is affordable only if:

```text
current_discounted_final + candidate.face_value_cost <= 10000
```

4. A discount triggered by the candidate itself cannot make that candidate
   affordable.
5. The final displayed build pays the base cost of every selected card, but only
   discounts completed by affordable cards are credited.

This means over-budget cards can be selected but cannot complete a brigade or
division for discount credit if they were unaffordable at face value.

### Auto Combat Generals

`autoPickCombatGenerals()` never adds cards. It replaces selected plain unit
instances with combat-general variants for the same cap group.

Algorithm:

1. Determine remaining combat-general cap.
2. Ignore units whose cap group already has a combat general.
3. For each eligible selected base unit, find the cheapest combat-general variant
   for that cap group.
4. Greedily choose the swap that most lowers final priced cost.
5. Stop when no remaining swap lowers or preserves the final cost.

This can unlock discounts by making previously unaffordable formation-completing
cards affordable. It can also choose fewer combat generals than the cap if more
would make the build dearer.

`resetCombatGenerals()` reverses combat-general instances back to their base unit
while leaving the staff slot untouched.

## Placement and Division Inference

`build_ntw3_army_builder_database.py` writes placement provenance:

- `localisation_tag`: explicit `ACDV<d>B<b>` in localisation.
- `verified_override`: hand-confirmed override, currently used for Bonaparte /
  Italie.C final division.
- `inferred_existing_support_division`: untagged support joins an existing final
  support division.
- `inferred_new_support_division`: untagged support creates a new final support
  division after the highest combat division.
- `inherited_base_unit`: `_com_<digits>` commander variant inherits base placement.
- `reserve_support_division`: raw division 0 support/reserve division.

`build_web_data.py` remaps raw division ids to compact display order per faction.
Division 0 sorts last because in-game reserve/support appears after combat
divisions. This remap is a bijection within a faction, so it preserves grouping
math while improving display labels.

## Filtering and Ordering

Filters in `state/filters.ts` mostly dim non-matching cards instead of hiding
them. The exception is the combat-general visibility switch, which removes combat
generals from the grid when off.

Search matches unit name and unit key.

Cost, men, command stars, and cap filters are global.

Range, accuracy, reload, morale, melee attack/defense, and charge bonus are
class-specific by infantry/cavalry/artillery. Combat generals use
`underlyingUnitClass`.

Combat generals belong to category `generals` and also to the broad category of
their base unit.

Ordering in `state/ordering.ts`:

- Within a cap group: expensive commander variants, base unit, cheaper/equal
  commander variants.
- Group order inside a brigade: infantry/skirmishers, cavalry, artillery, other.
- Within a type: cost descending, stars descending, rated before unrated, name,
  key.
- Foot and horse artillery are not separated; they interleave by cost.
- Staff generals sort by command stars descending, then name/key.

## Saves and Persistence

Saves are versioned in `state/saves.ts`.

Current save format version: 2.

Saves store:

- `factionKey`
- `armyCorpsName`
- ordered selected instance unit keys
- `staffSlotUnitKey`
- UI config: density and combat-general visibility
- timestamps and save id/name

Older save shapes are migrated by `migrateSavedBuild()`. Loading resolves unit
keys against the current roster and reports missing keys rather than crashing.

Components must use `BuildRepository`; do not directly touch localStorage.
`state/storage.ts` abstracts persistence and can be swapped later for a desktop
filesystem/SQLite/IndexedDB adapter.

## Electron Desktop App

Electron code lives in `web/electron/main.cjs`.

Key points:

- Packaged app serves `web/dist` over a private `app://bundle/` scheme.
- Relative fetches like `./data/...` and `./assets/...` work because
  `app://` is registered as standard/secure and supports fetch.
- Renderer uses context isolation, no node integration, and sandbox enabled.
- External HTTP(S) links open in the user's browser.
- Single-instance lock focuses an existing window.
- `electron-updater` checks GitHub Releases when packaged.
- `autoUpdater.allowPrerelease = true` is enabled.
- A headless smoke mode exists via `SMOKE_TEST=<output-file>`.

Build configuration is in `web/package.json`.

Version source of truth for desktop release is `web/package.json`.

Targets:

- NSIS installer: `RegistreDesArmees-Setup-${version}.exe`
- Portable exe: `RegistreDesArmees-Portable-${version}.exe`

Release output:

- `web/release/latest.yml`
- `web/release/*.exe`
- `web/release/*.blockmap`
- `web/release/_github_assets/` curated upload folder.

For v1.3.1, `_github_assets` contains:

- `RegistreDesArmees-Setup-1.3.1.exe`
- `RegistreDesArmees-Setup-1.3.1.exe.blockmap`
- `RegistreDesArmees-Portable-1.3.1.exe`
- `latest.yml`

Auto-update requires the installer, latest.yml, and blockmap attached to the
GitHub Release tagged `v<version>`. The portable exe is for manual download.

## Important Tests

Python:

- `tools/tests/test_army_builder_rules.py`
- `tools/tests/test_army_corps_catalog.py`
- `tools/tests/test_division_placement.py`

Web/Vitest:

- `web/src/rules/rules.test.ts`: pricing, caps, support division behavior.
- `web/src/state/build.test.ts`: add blocking, budget soft ceiling, auto generals.
- `web/src/state/filters.test.ts`: filters/dimming behavior.
- `web/src/state/ordering.test.ts`: card ordering.
- `web/src/state/saves.test.ts`: save migration/persistence behavior.
- `web/src/data/data.test.ts`: data normalization expectations.

When changing rule math, run both Python and Vitest suites. The TypeScript rules
must remain behaviorally equivalent to the Python source rules.

## Safe Change Guidance for Future Agents

Prefer source-of-truth edits:

- If raw unit fields are wrong, inspect/fix the generator or source tables, then
  regenerate data.
- If web JSON shape changes, update `tools/build_web_data.py`,
  `web/src/data/load.ts`, and `web/src/domain/types.ts` together.
- If pricing/caps change, update `tools/army_builder_rules.py`,
  `web/src/rules/rules.ts`, and parity tests together.
- If selection behavior changes, update `web/src/state/build.ts` and the relevant
  `state/*.test.ts`.
- If display grouping/order changes, update `web/src/state/ordering.ts` and UI
  components, not generated data.

Avoid hand-editing generated files unless the user explicitly asks for a quick
release artifact update. Generated files include:

- `data/generated/ntw3_army_builder_units.csv`
- `data/generated/army_corps_catalog.*`
- `web/public/data/**`
- `web/public/assets/**`
- `web/dist/**`
- `web/release/**`

Before release, verify:

1. `web/package.json` version is correct.
2. `npm test` passes.
3. `npm run build` passes.
4. `npm run desktop` emits expected installer/portable/latest/blockmap files.
5. `web/release/_github_assets` contains only the intended version upload set.

## Known Current Workspace Notes

`git status --short` currently reports untracked `.claude/` and Python
`__pycache__` folders. They appear unrelated to the app handoff and should not be
committed unless the user explicitly wants them.

Some text in existing files appears mojibake in PowerShell output for accented
French strings, but the app/source files are intentionally UTF-8. Be careful when
rewriting files and preserve encoding.
