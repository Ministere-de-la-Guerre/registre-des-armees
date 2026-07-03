# AI_FILEMAP — Registre des Armees

Purpose: locate the file to edit fast. NTW3 (Napoleon Total War 3 mod) army-builder. Data pipeline (Python) → generated data → web app (React/TS/Vite/Electron). NOT for humans; terse by design.

## Data flow (edit upstream, regenerate downstream)
`source/tables/*.tsv` (raw game exports = source of truth)
→ `tools/*.py` (build pipeline)
→ `data/generated/*.{csv,json}` + `assets/**` (icons)
→ `tools/build_web_data.py` → `web/public/{data,assets,factions}/*.json,png` (browser-ready AC + TOW, GENERATED, do not hand-edit)
→ `web/src/data/load.ts` normalizes → `web/src/domain/types.ts` models → rules/state/components.

Rules logic exists TWICE and must stay in parity: `tools/army_builder_rules.py` ↔ `web/src/rules/rules.ts` (TS is a faithful port; regex helpers duplicated in `tools/build_ntw3_army_builder_database.py`).

## web/ — the app (React 18 + TS + Vite + Electron, Windows desktop)
package.json scripts: `build:data`(py gen)·`dev`·`build`(tsc+vite)·`test`(vitest)·`lint`·`typecheck`·`electron`·`desktop[:release|:beta[:release]|:stage|:beta:stage]`(electron-builder; `:stage`→build+stage curated upload set)·`stage[:beta]`(`scripts/stage-release.mjs`).
- `web/src/App.tsx` — root component / composition.
- `web/src/main.tsx` · `index.html` · `styles.css` · `vite-env.d.ts`.
- `web/src/domain/`
  - `types.ts` — in-app domain models (UnitCard, UnitStats, FactionRoster, CorpsIndex, GeneralKind…). EDIT when data shape changes.
  - `labels.ts` — display label maps.
  - `tow.ts` — TOW key parsing, source-corps division ids, TOW brigade ordering helpers.
- `web/src/data/`
  - `load.ts` — fetch+validate+normalize raw JSON → domain (untrusted-input tolerant).
  - `assets.ts` — resolve public asset/data URLs vs Vite base.
  - `data.test.ts`.
- `web/src/rules/rules.ts` — pricing, discounts, general classification, roster caps (port of py). `rules.test.ts`.
- `web/src/state/` (pure logic, each has `.test.ts`)
  - `build.ts` — build = ordered explicit unit instances + staff slot; pricing/limits/add-blocking.
  - `filters.ts` — filter model; `matchesCard` dims (not removes); general-visibility switch.
  - `ordering.ts` — AC grid ordering within brigade + TOW arm/class brigade sequence. `combinedTowLayout()` backs the combined brigade-type grid (staff lifted out; every other unit pooled by brigade type, each ordered by price) — used by the TOW "Combine corps" toggle AND always for Custom Armies (non-`_ac_`/non-`_tow_` rosters; already combat-cap 1 via `generalCaps`).
  - `rotation.ts` — combat-general rotation predictor (NTW3.Shuffle clock-seed, MSVC PRNG). See memory `registre-armees-combat-general-rotation`.
  - `towRoll.ts` — legacy TOW background roll helpers (`ToWFarmycorps` / `ToWFgenerals`: source-corps slice, general keys, nearest source-corps-combo window). `findTowBuildRollTime` + `towSourceCorpsIdsInBuild`/`towCombatGeneralKeysInBuild` back the header "Generate times" button (times the roll+combat general the build actually uses). `towCorpsCeiling`/`isCardOverCorpsCeiling` = the soft 4-corps-roll ceiling (how many source corps the selection spans + which cards are over it), driving the "Corps N/4" header stat, the build-breakdown warning banner, and the red-framed medallions.
  - `saves.ts` — named versioned saved builds (graceful old-schema load).
  - `storage.ts` — StorageAdapter (localStorage abstraction).
- `web/src/components/` (UI, .tsx): `Builder`(main; `combinedView` = Custom Armies always + TOW "Combine corps" toggle → `combinedTowLayout`)·`BuilderGrid`·`CorpsSelect`·`FilterPanel`·`DetailsPanel`·`BottomTray`·`SaveLoadBar`·`RotationModal`(AC "Generate times")·`TowRollModal`(TOW "Corps roll" grid toggles)·`TowGenerateModal`(TOW "Generate times" — build-derived roll+general timing)·`Medallion`·`Tooltip`·`DualRange`. Shared: `rollTimeFormat.ts`(date fmt)·`DirectionBadge.tsx`.
- `web/src/test/factories.ts` — test data factories.
- `web/electron/main.cjs` — Electron main. `7za-wrapper.cs`. `web/build/` — icons + `make_icon.py`.
- `web/electron-builder.beta.cjs` — beta channel config (separate appId/repo; see memory `registre-armees-release-channel`). Stable config lives in `package.json`.
- `web/scripts/stage-release.mjs` — copies the release-needed artifacts (Setup exe+blockmap+latest.yml, +portable) for the current version into `_github_assets[_beta]/` for manual GitHub upload; guards against a stale `latest.yml`. See `docs/RELEASE.md`.
- tsconfig{,.app,.node}.json · vite.config.ts · .eslintrc.cjs · DESKTOP.md.

## tools/ — Python generators (run from repo root; output to data/, assets/, reports/, web/public/)
- `build_ntw3_army_builder_database.py` — TSV → `data/generated/ntw3_army_builder_units.csv` (master unit×corps table). Core importer.
- `build_army_corps_catalog.py` — → `army_corps_catalog.{csv,json}` (theatre-grouped AC + TOW corps, flags). Reads external flags path.
- `build_web_data.py` — data/generated → `web/public/**` browser JSON+PNG (adapter layer; includes TOW, strips inert TOW ACDV placement).
- `army_builder_rules.py` — pricing/roster-limit rules (source of `web/src/rules/rules.ts`).
- `validate_army_builder_rules.py` — → `reports/army_builder_rules_validation.txt`.
- `organize_icons_by_army_corps.py` — icons → `assets/icons_by_army_corps/**` + manifest.
- `collect_staff_general_icons.py` — staff-general icons → `assets/staff_general_icons_by_corps/**`, `data/staff_generals/*.csv`.
- `build_command_star_assets.py` — TGA stars → `assets/ui/command_stars/`.
- `tests/` — pytest: `test_army_builder_rules.py`·`test_army_corps_catalog.py`·`test_division_placement.py`.

## source/ — raw inputs (source of truth; mostly binary .tga art)
- `source/tables/*.tsv` — game DB exports: `ntw3_land_units`·`ntw3_unit_stats_land`·`ntw3_battle_entities`·`ntw3_factions`·`ntw3_land_projectiles`·`gun_type_to_projectiles`·`mp_general_command_ratings`·`units_to_exclusive_faction_permissions`·`localisation.loc`. These drive everything.
- `source/reference/.../ntw3_uniforms.tsv`.
- `source/original_ntw3_v94_staff_general_icons/**`, `original_game_command_star_assets/**`, `original_game_guerrilla_badge_assets/**` — raw .tga icon source.

## data/ — generated intermediates (regenerate, don't hand-edit)
`generated/army_corps_catalog.{csv,json}`·`generated/ntw3_army_builder_units.csv`·`staff_generals/staff_general_corps_placement[_with_stars].csv`.

## assets/ — icon output (38k+ files, GENERATED by tools)
`icons/`(14.5k base)·`icons_by_army_corps/`(22.6k)·`army_corps_by_theatre/`·`staff_general_icons_by_corps/`·`ui/`. Do not hand-curate; regenerate via tools.

## docs/ · reports/ · root
- `docs/CHANGELOG.md`·`HANDOFF.md`·`RELEASE.md`(release/update channels + build→stage→draft workflow)·`Instructions.txt`. `README.md` (player-facing).
- `docs/TOW_ARMY_BUILDS.md` — spec/reference for Theatres-of-War (`_tow_`) army assembly/ordering (source-corps-id divisions, TOW brigade buckets, combat-gen cap 1, all corps shown, no discounts).
- `docs/TOW_ROLL_TIEBREAK_INVESTIGATION.md` + `docs/TOW_ROLL_HANDOFF_FOR_CODEX.md` — TOW source-corps roller tuning notes. Primary rule (pool = staff generals by ascending cost, first-seen SCID) CONFIRMED; Russie-Centre solved generically; Prusse, Espagne, and Flandres matched by scoped source-corps-pool calibrations because the equal-cost engine tie-break is still not derivable from exported tables. Read before touching `towRoll.ts`/`rotation.ts` roll ordering.
- `docs/TOW_ROLLER_HANDOFF.md` — AUTHORITATIVE for the TOW corps roller: verified mechanics recap, definitive pool orders for ALL 50 TOW factions (13 calibrated from `TOW_Rolls.txt` in-game rolls, 1 derived, 36 no-shuffle ≤4-corps), implementation plan (extend `TOW_SOURCE_CORPS_POOL_CALIBRATIONS`), test-fixture guidance incl. known TOW_Rolls.txt transcription slips. Supersedes the two docs above.
- `TOW_Rolls.txt` (repo root) — user-recorded in-game TOW corps rolls (calibration source data; 4 lines have name-swap slips, see TOW_ROLLER_HANDOFF §5).
- `reports/` — validation/summary outputs of tools (CSV/txt/png); regenerated.
- `.claude/`·`.agents/` — assistant scratch (gitignored). `.gitignore` ignores py caches + those.

## Quick "where do I edit?"
- Unit stats/pricing/roster rules → `tools/army_builder_rules.py` AND `web/src/rules/rules.ts` (keep parity) → re-run tests.
- New/changed unit data → edit `source/tables/*.tsv` → rerun `tools/build_ntw3_army_builder_database.py` → `build_web_data.py`.
- Domain/data shape → `web/src/domain/types.ts` + `web/src/data/load.ts`.
- UI look/behavior → `web/src/components/*.tsx` (+ `styles.css`).
- Combat-general rotation → `web/src/state/rotation.ts` (+ `RotationModal.tsx`).
- Desktop/build/release → `web/package.json`, `web/electron/main.cjs`, `web/electron-builder.beta.cjs`.
