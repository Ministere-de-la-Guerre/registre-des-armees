# AI Agent Handoff: Registre des Armées

Deep reference for architecture, rules math, the rotation engine, and the release workflow. For the file map see `AI_FILEMAP.md`; for working rules see `CLAUDE.md`. This doc trades prose for density — expect to reason from the facts below rather than be walked through them.

Desktop-first React/Vite/Electron army builder for NTW3, backed by data generated from exported game tables and a source-parity rules engine. It exposes **all** staff/combat-general cards for a corps (not a random-roll emulator); caps enforce how many may be used.

## Generated vs authored

Never hand-edit (regenerate instead): `data/generated/**`, `web/public/data/**`, `web/public/assets/**`, `web/dist/**`, `web/release/**`, the icon trees under `assets/**`, `web/node_modules/`. Fix the generator or the source tables and rebuild.

## Commands

Root (Python):
```
python tools/build_ntw3_army_builder_database.py   # Stage 1: source/tables -> data/generated/ntw3_army_builder_units.csv
python tools/build_army_corps_catalog.py           # Stage 1: -> army_corps_catalog.{csv,json} + flag assets
python tools/build_web_data.py                      # Stage 2: -> web/public/**
python -m unittest discover -s tools/tests -v       # (single: python -m unittest tools.tests.test_army_builder_rules)
```
web/:
```
npm run build:data   # = python ../tools/build_web_data.py
npm test             # vitest run; single: npx vitest run src/rules/rules.test.ts   (-t "name" by title)
npm run lint | typecheck | build
npm run desktop      # build + electron-builder, no publish
npm run desktop:beta # beta channel (electron-builder.beta.cjs)
```

## Data pipeline

Stage 1 — raw tables → root CSV/catalog:
- `build_ntw3_army_builder_database.py`: reads `source/tables/*.tsv`, joins stats/permissions/localisation/projectiles/command-ratings/icons/abilities/placement → `data/generated/ntw3_army_builder_units.csv` + `reports/ntw3_merge_{warnings.csv,summary.txt}`.
- `build_army_corps_catalog.py`: unit CSV + `ntw3_factions.tsv` → `army_corps_catalog.{csv,json}`, `assets/army_corps_by_theatre/`, validation report.
- `organize_icons_by_army_corps.py`, `build_command_star_assets.py`, `collect_staff_general_icons.py`: supporting icon/asset trees.

Stage 2 — `build_web_data.py`: generated CSV + catalog JSON → `web/public/data/{corps-index,data-version}.json` + one roster JSON per faction under `factions/`; converts TGA→PNG into `web/public/assets/`. **TOW factions/variants are included**; TOW rows drop their inert ACDV division/brigade placement in this adapter so the web layer can derive source-corps divisions and TOW arm/class brigades. Also stamps `rosterIndex` (0-based CSV position) and remaps raw AC division ids to compact per-faction display order — division 0 sorts last (reserve/support appears after combat divisions); the remap is a bijection so grouping math is preserved. `data-version.json` records `towRows`.

## Web architecture (`web/src/`)

Flow: `App.tsx` loads corps index → `CorpsSelect` → `loadFaction(key)` → `Builder` runs `indexRoster()` → selections mutate a `BuildState` → `summarize()` (`state/build.ts`) expands into priced cards, limits, men, squares, violations. Components display derived state only; rule math stays in `rules/` and `state/`.

- `data/load.ts`: fetch + validate + normalize raw JSON → domain, tolerant of unknown/missing fields. For `_tow_` rosters, derives `placement` from source corps id + TOW brigade index and sets `placementSource="tow_source_corps"`.
- `domain/types.ts`: versioned domain models.
- `domain/tow.ts`: `_tow_` key parsing, `towSourceCorpsId`, source-corps id sorting, and TOW brigade index mapping.
- `rules/rules.ts`: parity port of `tools/army_builder_rules.py` — keep behaviorally aligned.
- `state/build.ts`: build model, add-blocking, soft-budget pricing, auto combat generals, summary. `summary.totalInfantry` (denominator of the header `squares/infantry` stat) counts line/light/grenadier/militia/irregular (combat generals by `underlyingUnitClass`); excludes skirmishers, cavalry, artillery, staff.
- `state/{filters,ordering,saves,storage,rotation,towRoll}.ts` as named below.

`BuildState` holds explicit instances so duplicate copies remove independently:
```ts
interface BuildState { instances: { id: string; unitKey: string }[]; staffSlotUnitKey: string | null; }
```

`UnitCard` key fields: `unitKey`, `factionKey`, `name`, `unitClass`; `cost` (base MP from CSV); `cap` (row cap); `groupCap` + `capGroupKey`/`baseUnitKey` (base key after stripping a final `_com_<digits>`, shared by commander variants); `placement` (division/brigade or null) + `placementSource`; `towSourceCorpsId` (parsed for TOW keys); `isGeneral`/`isCommanderVariant`/`generalKind`; `underlyingUnitClass` (base class for combat generals); `rosterIndex` (rotation tiebreak only); `finalMen` (staff generals always 16); `stats`, `abilities`, `icon`, `commandStarStrip`, `guerrillaBadge`.

## Rules math

`tools/army_builder_rules.py` == `web/src/rules/rules.ts`. **Integer floor throughout — never float-round.** Regex helpers are duplicated in `build_ntw3_army_builder_database.py`; keep in sync.

**Base cost** = sum of each selected card's own `cost`. Commander variants carry their own row cost; do not add base-unit cost on top.

**Formation discounts** — only faction keys containing `_ac_` qualify. For each recruitable non-general placed card: `roster_cost += cap*cost`, `required_count += cap` (generals excluded from these totals, but a selected placed general adds 1 to its group's completion count). Per group: `group_discount = floor(roster_cost*(required_count-1)/100)`. A complete division replaces its brigade discounts (never stack); otherwise each complete brigade credits its own. German States get 1.5x: `applied = floor(sum(completed.discount)*3/2)`, `final = base_cost - applied`. GS detection: `faction_key.split("_")[3]` contains lowercase `"g"`.

**Support divisions earn no discount.** A division is support if `placementSource` ∈ {`inferred_new_support_division`, `inferred_existing_support_division`, `reserve_support_division`}, OR it contains only support arms AND has artillery. Support arms = foot/fixed artillery, horse artillery, skirmishers, sappers, marines (sappers/marines detected by name — may be classed as line/grenadier). A combat division with organic artillery is still combat; a pure-skirmisher no-artillery division is combat unless the generator marked it support.

**General classification** uses raw men (`menRaw`), not display men: `menRaw` 32 or 122 → staff; else combat. Missing `menRaw` is a data error. All `_gen_staff_` cards display `finalMen` 16.

**Caps:** staff = 1 always. Combat cap = 1 for non-AC and TOW; for keys with `_ac_`, `N` = trailing digits of the 4th underscore component, `combat cap = 9 - N` (e.g. `ntw3_ac_test_x5_001` → 4). Separate `acSelectionGeneralMaxima()` (source-reference AC pools, used by rotation not UI): staff 1, combat = `cap + 2`.

**Staff slot:** one slot; a staff OR combat general may occupy it. A combat general there keeps its identity/cost/stars/placement/cap-group but does NOT count against the combat cap. Modeled as `staffSlotIndex` into the expanded selected-card array.

**Hard limits:** cards 31, foot artillery 2, horse artillery 1, heavy cavalry 10, staff slot 1, combat generals = combat cap, unit cap = shared cap-group count ≤ `groupCap`, max one combat-general variant per base unit. Combat generals count toward the foot/horse-artillery + heavy-cavalry limits by `underlyingUnitClass`.

**Budget** `MAX_BUILD_COST` = 10000 is a **soft** ceiling: adding an over-budget card is allowed (grid/tray colors the cost red; the build may exceed 10000). But discount eligibility uses an affordability replay: recruit order = staff slot first then instances in add-order; a candidate is affordable iff `current_discounted_final(from prior affordable cards) + candidate.face_value <= 10000`; a discount the candidate itself triggers cannot make it affordable. The final build pays every card's base cost but only credits discounts completed by affordable cards.

**`autoPickCombatGenerals()`** never adds cards — it swaps selected plain instances to combat-general variants of the same cap group: (1) find remaining combat cap; (2) skip groups already holding a combat general; (3) per eligible base unit pick the cheapest combat variant; (4) greedily take the swap that most lowers final priced cost; (5) stop when no swap lowers/preserves cost. Can unlock discounts (making formation-completers affordable) and may pick fewer than the cap. `resetCombatGenerals()` reverts combat instances to base, staff slot untouched.

## Rotation predictor (`state/rotation.ts` + `rotation.test.ts`; `RotationModal`, the army-corps "Generate times" popup)

Faithful reimplementation of NTW3.Shuffle / NTW3AC.ACgenerals (`ntw3.lua`/`ntw3ac.lua`), **verified against real in-game windows** (fixtures in `rotation.test.ts`). For each combat general in the build + the staff-slot commander, shows the nearest local time (past/future) the corps offers them.
- **Seed:** `floor(localHour/2.8)*10000 + (day*100 + month)`. Local clock, ignores year (annually periodic). ~9 windows/day at local hours `[0,3,6,9,12,14,17,20,23]`.
- **PRNG:** Windows CRT `rand()`/`srand()` LCG (`state*214013+2531011`, `RAND_MAX 32767`) — Win32 Lua 5.1 build. 5 warm-up draws, then Fisher-Yates, exactly as the Lua. Do not "simplify" the seed or PRNG.
- **Combat pool:** all combat generals ordered by arm category (artillery → cavalry → infantry) then ascending cost (engine `RecruitableUnits` order, confirmed in `ntw3_land_units.tsv`); the window offers the first `acSelectionGeneralMaxima` = `9 - rating + 2`. `rosterIndex` only breaks ties for equal-cost same-category pairs.
- **Staff pool:** offered = permanent commander (always) + one rotating shuffle pick (count 1). Commander = corps **namesake** (staff general whose name matches the corps-title leader: text before `/`, after `NN. `), e.g. Dokhtourov, Osterman-Tolstoi — NOT necessarily the priciest staff. Formation-named corps (e.g. "Garde impériale") have no namesake → commander falls back to highest-cost staff (Napoleon). See `staffCommanderKey(pool, corpsName)`.

Needs only `UnitCard.cost`, `underlyingUnitClass` (category), `armyCorpsName`, `rosterIndex`.

## TOW builder + legacy roll helpers

TOW (`_tow_`) corps are selectable from the same corps index as AC, under `tow_french_imperial` / `tow_coalition`; `CorpsSelect` can hide them with "Discount-eligible (AC) only". They are not discount-eligible: `calculateArmyCost()` returns base cost for every non-`_ac_` faction. `generalCaps()` hard-caps TOW combat generals at 1, regardless of the rating digit in the key.

TOW layout is derived in `data/load.ts`, not from ACDV tags. `tools/build_web_data.py` clears TOW `division`/`brigade`; `load.ts` parses `towSourceCorpsId` from the 4th underscore component of unit keys and maps sorted unique source ids to display divisions. Brigade numbers come from `domain/tow.ts`: staff command first, then cavalry heavy/standard/light/lancers/missile, infantry grenadiers/light/skirmishers/line/militia+irregulars, artillery foot/horse/fixed, then other. `state/ordering.ts` groups base units with commander variants and sorts each TOW brigade through the same card-ordering helper.

`state/towRoll.ts` is not the main TOW builder. It mirrors the legacy NTW3AC background roll (`ToWFarmycorps` / `ToWFgenerals`) for analysis/search: source-corps pool comes from staff generals in first-seen roster order; if more than four source corps exist, `NTW3.Shuffle` selects four for the local-time window; staff and combat pools are shuffled independently, with up to four combat generals from rolled source corps. `findTowCorpsCombinationTime()` searches nearest local-time windows for an exact or contains source-corps combination.

The TOW header **"Generate times"** button (`TowGenerateModal`) times the build the player actually made, not the Corps roll menu toggles: `towSourceCorpsIdsInBuild()`/`towCombatGeneralKeysInBuild()` derive the corps the selected units draw from plus the combat generals used, then `findTowBuildRollTime()` finds the nearest window whose roll *contains* those corps AND offers every one of those combat generals (staff generals are excluded — the legacy roll offers all of them every window). "Corps roll" (`TowRollModal`) keeps only the grid show/hide toggles; its old inner "Generate times" button is gone. All three popups share `components/rollTimeFormat.ts` + `DirectionBadge.tsx`.

**Soft 4-corps-roll ceiling.** The game rolls only 4 source corps together, but the builder lets you select across more (e.g. by enabling >4 in "Corps roll", or in the combined view where corps identity is pooled away). This is a **soft** ceiling, modeled like the 10,000 cost budget — allowed but flagged, never blocked. `towCorpsCeiling(build, index)` (`state/towRoll.ts`) returns the distinct source corps the *selection* draws from in first-seen order, per-corps selected counts, the "kept" set (first 4), and `over` (>4); `isCardOverCorpsCeiling(card, ceiling)` flags a card that already sits in a corps past the kept 4, or would open a 5th. Surfaced in `Builder.tsx` as: a **"Corps N/4"** header stat (red when over, TOW only); a build-based warning **banner** that lists every corps the build spans with counts (chips past the 4th shown red — trim those); and **red-framed medallions** (`.medallion.overcorps`, same treatment as `.overbudget`) on the offending units in both grid and tray. The banner takes priority over the older enabled-set `tooManyCorps` warning.

## Placement provenance (`build_ntw3_army_builder_database.py`)

`localisation_tag` (explicit `ACDV<d>B<b>`); `verified_override` (hand-confirmed, currently Bonaparte/Italie.C final division); `inferred_existing_support_division`; `inferred_new_support_division`; `inherited_base_unit` (`_com_` variant inherits base placement); `reserve_support_division` (raw division 0).

## Filters & ordering (`state/filters.ts`, `state/ordering.ts`)

Filters **dim** non-matching cards; two exceptions **remove** cards: `showCombatGenerals` (header "Combat generals" checkbox; stored in config/saves) and `onlyOfferedNow` (shown only for rotating `_ac_` corps; keeps only combat+staff generals in the current local window via `offeredCombatKeys`+`offeredStaffKeys` → `hiddenByRotation()`; transient, NOT saved — the offered set changes every window). Search matches name + key. Cost/men/stars/cap filters are global; range/accuracy/reload/morale/melee/charge are class-specific (combat generals use `underlyingUnitClass`); combat generals belong to category `generals` plus their base category.

Ordering: within a cap group — expensive commander variants, base, cheaper/equal variants. AC group order in a brigade — infantry/skirmishers, cavalry, artillery, other. Within a type — cost desc, stars desc, rated before unrated, name, key. Foot/horse artillery interleave by cost. Staff generals — stars desc then name/key. TOW brigade sequence is assigned before ordering by `domain/tow.ts` as described above.

## Saves (`state/saves.ts`, format v2)

Stores `factionKey`, `armyCorpsName`, ordered selected instance unit keys, `staffSlotUnitKey`, UI config (density, combat-general visibility), timestamps, id/name. `migrateSavedBuild()` upgrades old shapes; load resolves keys against the current roster and reports missing keys rather than crashing. Names are unique **per corps**: `BuildRepository.findByName(name, factionKey?)` scopes to a corps, so two corps can each hold a same-named build. Components must use `BuildRepository`, never localStorage directly; `state/storage.ts` abstracts persistence (swappable for a filesystem/SQLite/IndexedDB adapter later).

## Electron & release channels (`web/electron/main.cjs`, `web/package.json`, `web/electron-builder.beta.cjs`)

Packaged app serves `web/dist` over a private `app://bundle/` scheme (registered standard/secure, so `./data` and `./assets` fetches work). Renderer: context isolation, no node integration, sandbox on. External links open in the browser. Single-instance lock. `electron-updater` checks GitHub Releases when packaged. Headless smoke via `SMOKE_TEST=<file>`. Version source of truth = `web/package.json`.

**Stable and beta are separate apps updating from separate repos** — they install side-by-side and never cross-update. Separation is achieved by the separate repos alone (each app bundles its own `app-update.yml`), NOT by GitHub's "Pre-release" flag, so **both channels publish NORMAL "latest" releases** and both run `allowPrerelease=false`. A beta client on `1.4.0-beta.1` still updates to a normal release tagged `1.4.0-beta.2` because the provider compares by semver via `/releases/latest` → `latest.yml`; GitHub's `/releases/latest` excludes only releases whose Pre-release CHECKBOX is ticked, not versions whose string contains a hyphen. The `-beta.N` suffix is now cosmetic (lets users see they're on beta) and no longer drives the channel.
- **Stable:** `package.json` "build". appId `fr.ministeredelaguerre.registredesarmees`, product "Registre des Armées", name `registre-des-armees`, repo `registre-des-armees`. `npm run desktop[:release]`. Artifacts `RegistreDesArmees-Setup/Portable-<v>.exe`.
- **Beta:** `electron-builder.beta.cjs` spreads "build" and overrides `appId+".beta"`, `product+" Beta"`, `extraMetadata.name=registre-des-armees-beta`, `publish.repo=registre-des-armees-beta`, `publish.releaseType="release"` (publish directly as a normal release, never draft/pre-release). Version is a `-beta.N` string (e.g. `1.4.0-beta.2`). `npm run desktop:beta[:release]` (release needs `GH_TOKEN` for the beta repo). Artifacts `RegistreDesArmeesBeta-*`.
- **`extraMetadata.name` is essential:** `userData` (`app.getName()` → package name) and `updaterCacheDirName` (`<name>-updater`) both derive from the package name, so overriding it gives beta its own saved builds + update cache; without it the two collide despite different appIds.
- Runtime channel: `allowPrerelease = false` (both apps). Each app bundles `app-update.yml` for its own repo; the update path is `/releases/latest` → `latest.yml` on that repo.
- Publishing rule: **never tick GitHub's "Pre-release" box** for either channel. If a release is (or was) marked Pre-release, `allowPrerelease=false` clients won't see it via `/releases/latest` — untick it and Set as latest. `desktop:beta:release` already publishes as a normal release automatically.
- Each `desktop*` run overwrites `web/release/`; copy artifacts before building the other channel. Curated upload sets `_github_assets/` (stable) / `_github_assets_beta/` (beta) are for MANUAL publishing; `:release` auto-uploads the Setup `.exe` + `.blockmap` + `latest.yml` (all three are required for auto-update — the portable exe is manual download only).

### Release workflow (manual-draft, the default)

The build must run on **Windows** (electron-builder can't cross-build the NSIS `.exe` from Linux/WSL — no wine). The intended flow leaves everything staged so the only hand step is the GitHub draft:

1. Bump `version` in `web/package.json` and commit (`Release v<version>`).
2. On Windows: `npm run desktop:beta:stage` (beta) or `npm run desktop:stage` (stable). This builds, then runs `scripts/stage-release.mjs`, which copies exactly the Setup `.exe` + `.blockmap` + `latest.yml` (+ portable) for the current version into a freshly-cleaned `_github_assets_beta/` (or `_github_assets/`). It refuses to stage a `latest.yml` whose version doesn't match `package.json`, so a stale channel file can't slip through. These folders are gitignored (large local binaries).
3. On GitHub → the correct repo (**beta → `registre-des-armees-beta`**, stable → `registre-des-armees`) → **Draft a new release** → **Create new tag** `v<version>` → drag in every file from the staged folder → **Publish**. Never tick "Pre-release" (see channel notes above).

`:release` (`npm run desktop:beta:release`) is the fully-automated alternative — it builds, creates the tag, and uploads the three required files in one step (needs `GH_TOKEN` for the target repo). Use `:stage` when you want to eyeball/attach the files yourself; `:release` when you want it hands-off.
- Caveat: clients shipped under the OLD single-repo/shared-appId scheme (≤ v1.3.4 stable, v1.3.3-beta.1) can't be retro-fixed. **`1.4.0-beta.1` clients are also permanently stuck** and can only reach beta.2+ via a one-time MANUAL reinstall: they hardcoded `allowPrerelease=true`, and electron-updater's GitHubProvider with `allowPrerelease=true` does NOT choose the highest version — it walks `/releases.atom` and takes the first channel-matching entry. That feed is ordered by tag commit-date, not semver, and lists `v1.4.0-beta.1` ahead of `v1.4.0-beta.2`, so a beta.1 client re-selects itself and reports "up to date". This is exactly why `main.cjs` pins `allowPrerelease=false` (→ `/releases/latest` → `latest.yml`, which honors GitHub's real "Latest" pointer). Every build from `1.4.0-beta.2` onward carries the fix and auto-updates normally.

## Tests

Python: `tools/tests/test_{army_builder_rules,army_corps_catalog,division_placement}.py`.
Vitest: `rules.test.ts` (pricing/caps/support), `state/build.test.ts` (add-block/budget/auto generals), `filters`/`ordering`/`saves` `.test.ts`, `state/towRoll.test.ts`, `data/data.test.ts`. Changing rule math → run **both** suites; the TS must stay behaviorally equal to the Python.

## Safe-change guidance

Prefer source-of-truth edits. Wrong unit fields → fix generator/source tables, regenerate. JSON shape → update `build_web_data.py` + `data/load.ts` + `domain/types.ts` together. Pricing/caps → `army_builder_rules.py` + `rules/rules.ts` + parity tests together. Selection behavior → `state/build.ts` + state tests. Display order → `state/ordering.ts` + components (not data).

Before release: (1) `package.json` version correct; (2) `npm test`; (3) `npm run build`; (4) `npm run desktop:beta:stage` / `npm run desktop:stage` emits installer/portable/latest/blockmap **and** stages them; (5) confirm the curated `_github_assets*` folder holds only the intended version. Then draft + upload on GitHub (see "Release workflow" above).

Encoding: source is UTF-8 with accented French; PowerShell may render mojibake — preserve UTF-8 on rewrite.
