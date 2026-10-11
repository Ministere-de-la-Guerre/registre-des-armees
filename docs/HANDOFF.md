# Registre des Armées — Technical Overview

Developer-facing companion to the root [README.md](../README.md). This documents
how the thing actually works: where the data comes from, how the game's rules are
reproduced, how the general-rotation predictor was reverse-engineered, and how
releases ship.

The root README is the user-facing pitch. This is the architecture.

---

## 1. What this repository is

Two separate programs that meet at a JSON contract:

1. **A Python data pipeline** (`tools/`) that turns the game's own exported
   database tables and UI assets (`source/`) into normalized JSON + PNG the app
   can serve (`web/public/data`, `web/public/assets`).
2. **A React/TypeScript app** (`web/`) that reads that JSON and reimplements
   NTW3's army-corps lobby rules — pricing, formation discounts, caps, and the
   general-rotation clock — client-side. It ships as a PWA (GitHub Pages) and as
   an Electron desktop app for Windows.

Nothing in the app is a server call. There is no backend. Everything is static
files plus client-side math.

```
source/ (game exports: TSV tables, .lua, .tga)
   │  tools/build_ntw3_army_builder_database.py
   ▼
data/generated/ntw3_army_builder_units.csv   (13 MB, 25 668 unit×faction rows)  ── committed
data/generated/army_corps_catalog.{csv,json}                                     ── committed
   │  tools/build_web_data.py          (the only step CI runs)
   ▼
web/public/data/{corps-index,data-version}.json
web/public/data/factions/<faction_key>.json   (one per corps, ~297 files)
web/public/assets/{icons,army_corps_by_theatre,ui}/**                            ── gitignored
   │  fetch() at runtime
   ▼
web/src/data/load.ts → domain types → rules/ + state/ → components/
```

The split matters: `data/generated/*` is committed because rebuilding it needs a
local copy of the game's files (flags, `.tga` icons) that aren't in this repo.
`web/public/{data,assets}` is gitignored and regenerated on every build from the
committed CSV — that's the one pipeline step CI can run unattended.

---

## 2. Source data (`source/`)

| Path | What it is |
| --- | --- |
| `source/tables/*.tsv` | Tab-separated exports of the game's DB tables, pulled from the `.pack` files |
| `source/original lua files/ntw3.lua`, `ntw3ac.lua` | The game's own frontend Lua — the authoritative rules spec |
| `source/original_game_command_star_assets/` | Raw `.tga` command-star pips from the game UI skin |
| `source/original_game_guerrilla_badge_assets/` | Raw `.tga` guerrilla-deployment badge |
| `source/original_ntw3_v94_staff_general_icons/` | 374 raw `.tga` staff-general portraits (NTW3 v9.4 `cards94.pack`) |
| `source/reference/.../ntw3_uniforms.tsv` | Uniform→icon reference, used as an icon-resolution fallback |

The notable TSVs:

- `ntw3_land_units.tsv` — one row per unit: key, display name, class,
  `multiplayer_cost`, `total_cap`, `icon_name`.
- `ntw3_unit_stats_land.tsv` (18 MB) — combat stats, men counts, movement entity keys.
- `units_to_exclusive_faction_permissions.tsv` — the `(unit, faction, allowed)`
  triples. **This is the primary join**: it's what expands each unit into
  per-corps roster rows, and why the output CSV has 25k rows for a few thousand units.
- `mp_general_command_ratings.tsv` — `unit_key` → command stars.
- `ntw3_factions.tsv` — corps metadata, flag paths, index.
- `localisation.loc.tsv` (23 MB) — all display strings. Unit descriptions carry
  embedded `ACDV<div>B<brigade>` division/brigade tags, which is how formation
  structure is recovered.
- `ntw3_land_projectiles.tsv`, `gun_type_to_projectiles.tsv` — range resolution.

### The Lua files are the spec

`ntw3.lua` and `ntw3ac.lua` are not reference material — they're the ground truth
the entire rules engine was ported from. Worth knowing by name:

- `NTW3.MaxUnits()` → 31 cards.
- `NTW3.CapTypeUnit()` → foot artillery 2 / horse artillery 1 / heavy cavalry 10.
- `NTW3.AC_DivisionBrigade_Bonus` / `_PriceCut` / `_Roster` / `_Selected` → the
  brigade/division discount math.
- `NTW3.FactionIsGermanStates` → the ×1.5 discount bonus.
- **`NTW3.Shuffle`** (lines ~670–683) → the PRNG seeding + shuffle behind the
  entire general-rotation feature.
- `NTW3AC.CapGenerals` → staff max 1, combat max = `9 - N` from the faction key.
- `NTW3AC.ACgenerals` → splits generals into staff/combat pools by `Men/2 ∈ {16,61}`,
  shuffles each, takes the first N.
- `NTW3AC.ToWFgenerals` / `ToWFarmycorps` → the Theatre-of-War roll.

If a rule in `tools/army_builder_rules.py` or `web/src/rules/rules.ts` looks
arbitrary, the answer is almost always in these two files.

---

## 3. The Python pipeline (`tools/`)

Six scripts, run in order. Only step 6 runs in CI; steps 2–4 need the game's
local files and are re-run by hand when NTW3 patches.

### 3.1 `build_ntw3_army_builder_database.py` → `data/generated/ntw3_army_builder_units.csv`

The heaviest script (~1400 lines). Joins the 8 TSVs plus the uniforms reference
into one wide CSV (~50 columns, see `OUTPUT_COLUMNS`): identity, class, men,
speed code, division/brigade placement, cost, cap, weapon/range, command stars,
general flags, icon path, full combat stats, boolean abilities, guns.

The hard parts:

- **Duplicate keys.** `unique_by_key` drops genuinely ambiguous rows (with
  warnings); `resolve_first_occurrence` keeps the *first-declared* row for
  `ntw3_land_units.tsv` and `mp_general_command_ratings.tsv`, because Total War's
  loader resolves duplicates to first occurrence.
- **`infer_final_division_placements()`.** Many corps' final artillery/support
  division carries no `ACDV` tag in its localisation text. This infers whether
  the highest tagged division is itself a support division (all support units
  *and* holds artillery) or whether a new division must be created, then places
  untagged `foot_artillery`/`horse_artillery`/`specialists` cards accordingly.
  The result is stamped into a `placement_source` column, which the pricing
  engine later reads to decide discount eligibility.
  `DIVISION_PLACEMENT_OVERRIDES` hardcodes one verified exception.
- **`inherit_commander_placements()`.** Untagged `_com_<N>` commander variants
  inherit their base unit's division/brigade.
- **`resolve_icon()` / `scan_icons()`.** Fuzzy-matches `icon_name` against files
  under `assets/icons/` by filename, stem, or unit-key suffix, falling back to
  the uniforms table for ToW variants with no icon of their own. The match
  method is recorded per row (`icon_match_method`) so bad matches are auditable.
- **`select_projectile()`.** Resolves real fired range via direct missile fields
  or `gun_type_to_projectiles.tsv`, with weapon-type-specific rules (round shot
  vs shell vs rocket).

Also writes QA reports to `reports/` (gitignored).

### 3.2 `build_army_corps_catalog.py` → `data/generated/army_corps_catalog.{csv,json}`

Groups corps into the 15 historical theatres (`THEATRES`), split Empire /
Coalition / ToW / Custom, and converts each corps' flag `.tga` → 44×22
`flag.png` + `post_selection_flag.png` under `assets/army_corps_by_theatre/`.

Needs `--flags-root <NTW3>/graphic/ui/flags` (the default is a hardcoded dev
path). Writes to a staging directory and swaps it in atomically only if
validation passes, so a half-failed run can't corrupt committed assets.

### 3.3 `build_command_star_assets.py` → `assets/ui/command_stars/`

Crops the two command-star `.tga` skins (silver + the Spanish-skin gold variant)
to 10×10 PNGs and pre-composites vertical 1–9 star strips plus `metadata.json`,
so the app renders a star rating as one `<img>` rather than nine.

### 3.4 `collect_staff_general_icons.py` → `assets/staff_general_icons_by_corps/`, `data/staff_generals/*.csv`

Sorts the 374 raw staff-general portraits into per-corps folders driven by the
exact permission rows (ToW generals pooled into one `TOW/`). Verifies SHA-256
against already-placed assets and exits non-zero on a missing or mismatched
icon. Emits two placement CSVs consumed by `validate_army_builder_rules.py`.

### 3.5 `organize_icons_by_army_corps.py` — QA only

Copies every unit icon into a human-browsable
`assets/icons_by_army_corps/<corps>/Division_NN/` tree with a manifest and a
`--prune` flag. Not consumed downstream; it exists so icon correctness can be
eyeballed per corps and division.

### 3.6 `build_web_data.py` → `web/public/{data,assets}` — the app's data contract

`npm run build:data` (from `web/`) or `python tools/build_web_data.py`. Reads
`data/generated/ntw3_army_builder_units.csv` and `army_corps_catalog.json`,
plus — when present — the build optimiser's `ntw3_optimiser_values.csv` and
`ntw3_optimiser_params.json` (§4.6), which it merges into the faction files
(`optimiserValue` per card, an `optimiser` block per ToW / Custom roster).
Produces:

| Output | Contents |
| --- | --- |
| `data/data-version.json` | `schemaVersion`, row counts, and a sha256 `contentHash` over every cached data file |
| `data/corps-index.json` | Theatre-grouped corps listing (Empire / Coalition / ToW-Imperial / ToW-Coalition / Custom) |
| `data/factions/<faction_key>.json` | One normalized roster per corps, camelCase, `cards[]` |
| `assets/icons/**/*.png` | `.tga` → PNG via Pillow |
| `assets/army_corps_by_theatre/**`, `assets/ui/**` | Flags, command stars, guerrilla badge |
| `data/pick-rates/*.json` | Copied from `data/pick_rates/` if present |
| `data/build-report.txt` | Validation summary |

Two details that are load-bearing:

- **`rosterIndex`** is stamped per card from CSV row order *before* the display
  sort. The rotation engine needs the original order to reproduce the in-game
  shuffle (§5); losing it silently breaks general timing.
- **`contentHash`** keys the PWA's service-worker and offline caches, so a
  pipeline rebuild automatically invalidates stale cached JSON and icons.

The script is idempotent: it skips PNG conversion when the destination is newer
than the source, and **prunes** anything under `web/public/{data,assets}` it
didn't produce this run, so deleting a corps upstream cleanly removes its files.
`SCHEMA_VERSION = 2` — bump it when the JSON *shape* changes (2 added the
optional optimiser fields).

### 3.7 `build_pick_rates.py` — optional feature data

Turns a local (never committed) corpus of parsed replay-statistics CSVs under
`reports/replay_stats/` into per-season pick-rate JSON in `data/pick_rates/`
plus an `index.json`. Scope is Army Corps only (`SCOPE = ["ac"]`); ToW and
Custom are excluded.

```
python tools/build_pick_rates.py --season-id season-10 --label "Season 10" --recorded 2026-08
```

### 3.8 `replay_parser.py` / `validate_replay.py` — verification tooling

"Replay" here means an NTW3 multiplayer battle recording (`.replay`), not
anything to do with builds. Every string in the format is
`0x0E <uint16 LE char count> <UTF-16LE chars>`.

`replay_parser.py` scans the binary for well-formed tagged strings, rejects
false positives with an ASCII/Latin/Cyrillic plausibility heuristic
(`_plausible`), locates each army block by corps key (`ARMY_KEY_RE`, with
positional inference for Custom Armies that have no recognisable key), extracts
the ordered recruited unit keys (first = staff/commander slot), then pairs them
with their localized display names — self-checking the pairing by requiring the
regiment number in a unit key to appear in its display name, which catches
off-by-one misalignment.

```
python tools/replay_parser.py <file.replay> [--json]
python tools/validate_replay.py <file.replay>
```

`validate_replay.py` resolves every extracted key against the units CSV, then
re-prices each army through `calculate_army_cost` + `check_known_limits`. If
every key resolves and every army prices sanely, the extraction is byte-exact.

> **Parity constraint:** `replay_parser.py` is a port of
> `web/src/domain/replay.ts`, and `army_builder_rules.py` is the Python twin of
> `web/src/rules/rules.ts`. In both pairs the TypeScript is the reference
> implementation (it ships in the app and carries the test suite); the Python
> exists for offline tooling. **Change one, change the other.**

### 3.9 `validate_army_builder_rules.py`

A data-integrity report (not a test suite): general-classification coverage,
staff-general men normalization, faction general-cap parsing across all AC/ToW
factions, and whether every staff-general placement row has a matching units-CSV
row. Writes `reports/army_builder_rules_validation.txt`.

### 3.10 Python tests

`tools/tests/` uses plain `unittest.TestCase`. `tools/` is a package, so run from
the repo root:

```
python -m pytest tools/tests          # or: python -m unittest discover -s tools/tests
```

| File | Covers |
| --- | --- |
| `test_army_builder_rules.py` (34 tests) | Discount math, German-States bonus, general caps/classification, cap-group sharing, cavalry-only horse-artillery cap, limit violations |
| `test_build_web_data.py` | `normalize_unit` ToW placement nulling, content-hash stability, stale-file pruning, exit codes |
| `test_database_builder.py` | TSV merge/dedup |
| `test_division_placement.py` | Support-division inference and commander inheritance |
| `test_army_corps_catalog*.py` | Flag/theatre catalog logic |

---

## 4. The rules engine

Implemented twice, intentionally: `tools/army_builder_rules.py` and
`web/src/rules/rules.ts`. `web/src/rules/rules.test.ts` is the parity suite.

### 4.1 Hard limits

```
MAX_TOTAL_UNIT_CARDS = 31        MAX_FOOT_ARTILLERY  = 2
MAX_BUILD_COST       = 10000     MAX_HORSE_ARTILLERY = 1   (2 if cavalry-only corps)
MAX_HEAVY_CAVALRY    = 10        MAX_BRIGADE_SLOTS_PER_DIVISION = 7
```

A "cavalry-only corps" (`isCavalryOnlyCorps`) is one with cavalry and zero
infantry — it gets the second horse-artillery slot.

### 4.2 Formation discounts

`buildRosterTotals` groups every recruitable non-general card by division and by
`division:brigade`, accumulating, per group:

```
rosterCost    = Σ (cap × cost)      # the group at full roster strength
requiredCount = Σ cap
```

The discount for a completed group is then integer arithmetic matching the Lua:

```
groupDiscount = floor(rosterCost × (requiredCount − 1) / 100)
```

`calculateArmyCost` walks divisions in id order. If the player's selected count
in a division reaches its `requiredCount`, the **division** discount is credited
and its brigades are skipped; otherwise each brigade is checked individually.

**Support divisions earn nothing.** `supportDivisions` flags a division where
every unit is a support arm (artillery / skirmisher / sapper / marine — detected
by key prefix, class, or name regex) *and* it holds artillery, or one the
pipeline tagged via `placement_source` (`inferred_new_support_division`, …).
One exception set — `SUPPORT_DIVISION_BRIGADE_DISCOUNT_FACTIONS`, currently
`ntw3_ac_a11_x5_117` (Davout 1812) — still grants brigade-level discounts to the
non-artillery brigades of an otherwise-undiscounted support division.

**German States bonus.** `isGermanStates` tests for a `"g"` in the fourth
underscore-component of the faction key, and multiplies:

```
appliedDiscount = floor(normalDiscount × 3 / 2)
finalCost       = baseCost − appliedDiscount
```

`cachedRosterTotals` memoizes `buildRosterTotals` in a `WeakMap` keyed on
`(roster array, factionKey)`, because `calculateArmyCost` is re-run on every
recruit-order prefix during affordability replay and on every candidate during
the auto-generals search.

### 4.3 The soft 10 000 ceiling (`priceBuild` / `affordableSubset`)

The game prices cards strictly **in recruit order** — commander/staff slot
first, then each instance in add order — and stops crediting discounts once the
running total would exceed 10 000. `priceBuild` reproduces this: it charges
every selected card at face value, but computes discounts only over the
affordable *prefix*, then applies them against the full `baseCost`.

This is why card order is semantically meaningful, not cosmetic, and it drives
the next algorithm.

### 4.4 General caps and cap groups

- At most one staff general in a build.
- AC corps: `combat = 9 − N`, where `N` is the trailing digit of the faction
  key's fourth component (`..._x5_...` → 4). ToW and non-AC factions are hard
  capped at 1 staff / 1 combat.
- `acSelectionGeneralMaxima` adds **+2** to the combat cap — but only for what
  the rotation *offers*, not what a finished build may contain (`max_gens[2]` in
  the Lua).
- **Cap groups.** A `_com_<N>` commander variant shares its base unit's
  `unit_cap` (not its own) and, if it's a combat general, counts against the base
  unit's *class* for the artillery/heavy-cavalry caps. At most one combat general
  may lead a given base unit.
- The dedicated **staff slot** may instead hold a combat general — which frees
  the corps' own staff general to be recruited as an ordinary extra unit. That's
  the `staffSlotUnitKey` / `staff_slot_index` plumbing.

### 4.5 Auto combat generals (`web/src/state/build.ts::autoPickCombatGenerals`)

This never adds units. It **swaps** an already-selected plain copy for a
combat-general variant of the same unit, so card count, shared caps, and class
caps are untouched — only a combat-general slot is spent.

Two pruning insights make it tractable:

1. A general costing ≥ the plain copy can only raise the price, so candidates
   are **strictly cheaper** variants only.
2. Swapping the **first** selected copy of a unit is always at least as good as a
   later one: pricing is order-sensitive (§4.3), so an earlier price drop lowers
   the running total for more subsequent cards — which can pull a
   formation-completing copy back inside budget and unlock a large brigade or
   division discount.

So candidates = {first selected copy of each eligible unit} × {every strictly
cheaper general that leads it}, one bucket per unit (a unit takes at most one
general), with `maxSwaps = min(remainingCombatSlots, bucketCount)`.

- **Exact search.** `countSwapSets` is a DP counting the ways to pick ≤
  `maxSwaps` buckets (one option each), capped early at
  `AUTO_GENERALS_EXACT_LIMIT = 2500`. Under that bound, an exhaustive DFS prices
  every subset via `priceBuild` and keeps the strictly cheapest (ties → fewer
  generals, then DFS visit order, which is cheapest-general-first).
- **Greedy fallback** above it: repeatedly price `chosen + candidate` for each
  open bucket and commit the single swap that lowers cost most; stop on the first
  non-strict improvement.

### 4.6 Build optimiser (`web/src/state/optimiser.ts`, `acOptimiser.ts`) — every army with data

The header's **Optimise** button (`components/OptimiseModal.tsx`) builds the
legal army with the most *normative value*: what the game's average pricing rule
charges for the cards' stats. It is the integer programme of the offline
analysis, `analysis/cost_effective_builds.py` `solve()`, re-implemented in
TypeScript. Its "max value" build is reproduced here, and with Single roll its
"four corps" build. For Army Corps it is `analysis/ac_builds.py` `solve_corps()`:
the same programme plus the formation discounts and the recruit-order rule (below).

**Settings** (Builder state, kept for the session):
- **Max unit cards:** 2–31, staff general included.
- **Value mode** (Quantity is the default everywhere; `allowedModes`):
  - ToW / Custom: **Quantity** / **Quality**;
  - Army Corps: **Quantity** / **Quality** / **Formation discount only**. For AC,
    "Quality" is the AC study's size-band model (mode key `sizeBands`; the user
    replaced full harmonisation with it and kept the familiar label); "Formation discount
    only" values each card at its own list price (no model), so the build fields the
    most list value 10 000 reaches after discounts.
- **Optimise remainder:** keep the current build and fill what is left; off by default.
- **Only filtered units:** on by default. The candidates are Builder's
  `filteredCards`: the grid filters, Offered now and the corps roll — but *not*
  the Combat-generals display switch, which only hides medallions.
- **Allow no staff general:** off by default.
- **Single roll:** ToW only, on by default; ≤ 4 source corps
  (`LEGACY_TOW_MAX_SOURCE_CORPS`), staff general included.

The result is applied immediately; **Undo optimise** restores the previous build
until the next edit.

- **Values are data**, because the app cannot run the pricing models.
  - The analysis scripts named in this section are not on this branch: they are kept on the
    `analysis/unit-pricing` branch of `jediknightnapoleon/registre-des-armees-beta`. The data
    files they produce (`data/generated/ntw3_optimiser_*`) are committed here, so the app builds
    without them.
  - `analysis/export_optimiser_values.py` writes
    `data/generated/ntw3_optimiser_values.csv` (per unit and combat-general
    card) and `ntw3_optimiser_params.json`. Both are committed.
  - Each card carries its pool's modes only:
    - `quantity` (all): noise-only harmonisation, so the size discount is kept;
    - `quality` (ToW / Custom): fully size-harmonised, so the size bias is removed;
    - `sizeBands` (AC): the size-band model of `analysis/AC_PRICING_REPORT.md`.
  - `ntw3_optimiser_params.json` holds one block per pool (`pools.tow`, `pools.ac`;
    AC has its own staff T3 refit); `build_web_data.py` writes the faction's pool
    block into its file. German Campaign 1813 (`a16`/`b16`) is work in progress in
    the mod and gets no data (`acOptimiser.isWorkInProgressCorps`).
  - **Staff generals are valued in the app**, from the parameters:
    - the price rule T3 = b·stars^q (1 gold without stars);
    - plus λ·stars·D, where D = Σ models·(mRef − morale)₊ over the build's units;
    - ×(1 + σ) for a C-class general;
    - plus a melee bonus for a fighting bodyguard.
    D depends on the build, so each staff option gets an auxiliary w ≤ D,
    w ≤ D_max·z.
- **Rules** mirror `checkKnownLimits`, reusing `cappedClassOf`,
  `horseArtilleryMax` and `generalCaps`:
  - funds and the card cap;
  - one staff general;
  - the combat-general cap;
  - cap groups shared with combat-general versions;
  - one combat general per group;
  - foot artillery, horse artillery and heavy cavalry caps.
  In remainder mode the kept cards are subtracted from every limit.
- **Solver:** HiGHS compiled to WebAssembly (`highs` npm package), the same
  solver `scipy.optimize.milp` uses, run in a module Web Worker
  (`state/optimiser.worker.ts`, client `workerSolver` in `state/solveLp.ts`).
  - The model is passed as CPLEX LP text, with a 10 s time limit.
  - The `.wasm` (~3.5 MB) is precached by the PWA (`**/*.wasm`).
  - Electron serves it as `application/wasm`.
  - Vite builds workers as ES modules (`worker.format: "es"`) and pre-bundles
    `highs` in dev.
- **Army Corps** (`state/acOptimiser.ts`; its header has the full model):
  - a 0/1 column per brigade or division the build may still complete (rebate
    > 0, from `buildRosterTotals` + `groupDiscount`): completion counts combat
    generals, a division replaces its brigades, the budget credits the rebates;
  - the app's recruit-order rule (§4.3) is *in* the model: completed groups are
    recruited in a fixed order ≺ (rebate − what a division's own brigades have
    earned, descending; optimal by an exchange argument), and one row per group
    checks the running total at its completing card. `compareRebateGroups` and
    Python's `group_order_key` must stay identical;
  - decode writes the instances in that recruit order (kept instances first,
    then the completed groups, brigade by brigade inside divisions, then loose
    cards); `priceBuild` recruits the staff slot first, as Python does;
  - safety net: every build is re-priced (`acBuildEarnsItsRebates`); one that
    did not earn a rebate is cut and re-solved (≤ `MAX_REBATE_CUTS`, ≤ 30 s),
    else rebuilt without discounts and flagged. On all 223 corps × 4 versions
    the offline optimiser needs 0 cuts;
  - MIP gap 1e-6 (1e-8 for Formation discount only), as `ac_builds.py`; ToW
    keeps HiGHS's default.
- **Tests:** `optimiser.golden.test.ts` pins the ToW / Custom LP text (written
  before the AC extension); `acOptimiser.test.ts` covers rebates, the recruit
  order, remainder, support divisions and the safety net on synthetic corps;
  `optimiser.parity.test.ts` checks the TS optimum equals Python's for Preußen
  10, Napoli and HRE (both versions, with and without Single roll) and for
  Davout I.C 1812, Bonaparte / Italie.C and Eugène / Italie (all three AC
  modes: same value, final cost, list cost, rebate and completed groups, 0
  cuts). Its fixture comes from `export_optimiser_values.py --fixture`.
- **Refreshing the values** after changing the analysis: the AC inputs come from
  the team study (`analysis/TEAM_BUILDS_REPORT.md` → Commands: `team_values.py`,
  `ac_builds.py`, `team_search.py`), then three steps:
  ```
  py -3.13 analysis/export_optimiser_values.py
  py -3.13 tools/build_web_data.py
  py -3.13 analysis/export_optimiser_values.py --fixture
  ```
- **Not checked:** whether a single roll actually offers the chosen combat
  general. "Generate times" finds that window.

### 4.7 Team suggestion (`web/src/state/teamSuggest.ts`, `teamBuild.ts`)

The Ordre de Bataille planner's **Suggest team** (`components/SuggestTeamModal.tsx`)
finds the best armies for a team points total (Σ corps numbers, `corpsPoints`;
ntw3.lua `Faction_Points`), as `analysis/team_search.py` does offline.
- **Pools** (`teamPools`): one AC theatre and side, or ToW + Custom of one side
  (`domain/teamRule.ts`). The same ToW army twice is an option (the Lua allows it).
- **Mixed plans are refused:** `planTeamConflict` walks the slots with `joinTeam`
  and names the first clash (pool, theatre or side); the button is disabled with
  that sentence as its tooltip, and `TeamConflictWarning` shows it in the strip.
- **Army values:** precomputed (`CorpsEntry.bestBuildValue`, from
  `data/generated/ntw3_optimiser_army_values.csv`) at the default settings with
  nothing kept — instant and offline; otherwise (`needsLiveValues`: card cap, no
  staff, single roll off, kept armies with units) every candidate is optimised
  live in the worker, with progress, Cancel and a session cache (`teamBuild.ts`).
  The user chose this split (2026-10-10).
- **Ranking:** by total value or by the weakest army (ties: the other);
  `suggestTeams` enumerates at most ~36k teams. Teams take `k`; the UI offers 4
  (3 is legal and a planned extension).
- **Optimise remainder** keeps the plan's armies (and their units) and fills the
  rest; off replaces the whole team (`plan.ts` `applySuggestedTeam`).
- **Use this team** puts the corps in the plan with placeholder builds, then
  optimises each army; a build lands only while its slot still holds the
  placeholder (`fillPlaceholder`). **Undo suggestion** restores the plan.
- Rosters come from App's `usePlanRosters().ensure`, shared with the planner's own
  loads; an army whose roster is not available offline is reported and skipped.

---

## 5. The general-rotation engine (`web/src/state/rotation.ts`)

The headline feature, and the most delicate code in the repo. In game, the pool
of generals a corps may recruit is reshuffled on a clock-derived seed, so the
offered set changes roughly every three hours. This module reproduces that
exactly, so the app can name the nearest local time a given general is on offer.

Everything below is a byte-faithful port of `NTW3.Shuffle` and
`NTW3AC.ACgenerals`, **verified against 7 distinct observed in-game windows**
(corps `ntw3_ac_a04_x5_076`, 2026-06) with the calibration fixtures living in
`rotation.test.ts`.

### 5.1 Seed — and why the rotation repeats annually

```ts
seed = floor(localHour / 2.8) * 10000 + (day * 100 + month)
```

Day, month, and an hour bucket. **No year.** Same calendar day + same hour
bucket ⇒ same seed ⇒ same shuffle, forever. That's the entire explanation for
"the rotation repeats every year", and it's read off the player's local wall
clock (`os.date`), not UTC.

### 5.2 PRNG — Windows CRT `rand()`

NTW3 is a Win32 build, so Lua 5.1's `math.random` falls through to the MSVC C
runtime. `MsvcRng` reimplements it:

```ts
state = (state × 214013 + 2531011) mod 2³²      // LCG
rand()  = (state >>> 16) & 0x7fff               // bits 30..16, RAND_MAX = 32767
range(l, u) = floor(((rand() % RAND_MAX) / RAND_MAX) × (u − l + 1)) + l   // Lua 5.1 math.random
```

### 5.3 Shuffle

`shuffleByDate`: re-seed from the date, **discard 5 warm-up `range(1,100)`
draws** (the game does this), then Fisher-Yates walking Lua's 1-indexed array
from `#tbl` down to 2, swapping with `random(1, i)`.

### 5.4 Pool order — the part that took calibration

The PRNG was right from the start; what was wrong was the *input order* fed to
the shuffle. It must match the game's `FrontEnd.RecruitableUnits` order, which
`recruitOrder` reproduces:

```
sort by arm category (artillery → cavalry → infantry, also alphabetical)
then by ascending cost
then by rosterIndex          // stable tiebreak for same-category, same-cost pairs
```

This is why `build_web_data.py` must stamp `rosterIndex` from raw CSV order
before any display sort (§3.6).

`combatPool` / `staffPool` filter by `generalKind` and apply that sort;
`offeredFrom(pool, count, d)` shuffles for the window and takes the first
`count`, where combat count is `acSelectionGeneralMaxima(faction).combat` (cap +
2). The two pools shuffle **independently** — `NTW3.Shuffle` re-seeds on every
call with the same seed.

Staff offers are special (`offeredStaffKeys`): the corps' **namesake commander**
is always available, identified by matching the leader surname in the corps title
(the part before `/`) against staff general names — *not* by cost, since the
dearer generals in those corps (Koutouzov, Miloradovitch) are the rotating
picks. Corps named for a formation rather than a person (e.g. Garde impériale)
have no namesake and fall back to the highest-cost staff general.

### 5.5 Windows are not a clean 3 hours

Because the bucket divisor is 2.8, there are 9 unequal windows per day starting
at local hours:

```
[0, 3, 6, 9, 12, 14, 17, 20, 23]        // WINDOW_START_HOURS
```

A window is identified by **(local calendar day, slot index)**, never by reading
an hour back off a `Date` — on a spring-forward day the slot's start hour may not
exist (EET 03:00→04:00; Santiago/Azores/Havana/Cairo/Beirut 00:00→01:00). The
game only sees the wall clock, so such a window simply begins at the first
instant after the gap; `slotStart` binary-searches for it.

### 5.6 Search

- **`findRotation` / `findRotationWith`** scan outward from now in both
  directions, bounded by `MAX_WINDOWS = 9 × 367` (just over the annual period),
  memoizing `offeredAt(window)` by seed, then return whichever of the nearest
  future and nearest past window is closer (`closestDirection: "now" | "future" | "past"`).
- **`findRotationCover`** handles several wanted generals at once — it reports the
  *fewest distinct windows* that jointly offer the whole set. That's set cover:
  bitmask each target general, compute each window's coverage mask, find the
  minimum cover size `k` by **BFS over reachable bitmask states** (unweighted
  shortest path from `0` to `fullMask`), DFS-enumerate every size-`k` covering
  combination (pruned by suffix-OR reachability), and for each one pick the best
  times via `bestPickForLists` — a k-way min-range sweep ("smallest range
  covering one element from each of k lists") minimizing cluster spread, tie-broken
  by closeness to now.

### 5.7 Theatre of War (`web/src/state/towRoll.ts`)

ToW corps roll differently. `NTW3AC.ToWFarmycorps` shuffles a pool of **source
corps** and picks up to `LEGACY_TOW_MAX_SOURCE_CORPS = 4`; `NTW3AC.ToWFgenerals`
then offers up to `LEGACY_TOW_MAX_COMBAT_GENERALS = 4` combat generals
restricted to generals belonging to the rolled corps.

`findTowBuildRollTime` is the "Generate times" button for ToW. It times the
**whole build**, scanning windows for the nearest one where both:

- the rolled source-corps set *contains* every source corps the build draws from
  (`sourceCorpsCombinationMatches(..., "contains")` — filler corps are fine), and
- every combat general actually used in the build is among that window's offers.

A few source-corps pools have their equal-cost tie-break hardcoded in
`TOW_SOURCE_CORPS_POOL_CALIBRATIONS`, because that ordering can't be derived
from the exported Lua or DB tables and had to be observed in game.

---

## 6. The web app (`web/`)

98 TS/TSX files. No state-management library — plain `useState`/`useEffect`/
`useMemo` in components, with every piece of business logic factored into pure,
framework-free modules under `state/`, `rules/`, and `domain/` that operate on
plain data and are unit-tested directly.

### 6.1 Shell

- **`App.tsx`** — `App` wraps `AppBody` in `ConfirmProvider`. `AppBody` owns
  top-level routing as state: `screen: "corps" | "replay" | "planner"`, the
  selected `CorpsEntry`/`FactionRoster`, the working `CurrentPlan` (autosaved on
  change), a `ReplaySession`, and PWA update-toast state. Loads
  `corps-index.json` on mount and faction rosters on demand.
- **`main.tsx`** — React 18 `createRoot` inside `ErrorBoundary`, plus global
  `dragover`/`drop` handlers that stop the browser (and especially Electron) from
  navigating the window to a dropped `file://` URL with no way back.

### 6.2 Layer map

| Directory | Responsibility |
| --- | --- |
| `domain/` | Pure data models and NTW3 parsing: `types.ts` (`UnitCard`, `FactionRoster`, `CorpsIndex`), `tow.ts` (ToW key parsing / brigade ordering), `replay.ts` (binary `.replay` parser — the reference impl), `gunTypes.ts`, `searchText.ts`, `labels.ts`, `buggedUniforms.ts` |
| `rules/` | `rules.ts` — pricing, discounts, caps (§4) |
| `state/` | Build/plan logic and persistence: `build.ts` (add validation, pricing replay, auto-generals), `rotation.ts`, `towRoll.ts`, `saves.ts`, `plan.ts`, `storage.ts`, `offline.ts`, `filters.ts`, `ordering.ts`, `planStats.ts`, `planSummary.ts`, `planSync.ts`, `replayBuild.ts`, `replayPlan.ts` |
| `data/` | Runtime fetch + normalize only: `load.ts`, `assets.ts`, `version.ts`. **No generated content lives here.** |
| `components/` | All UI (38 files) |
| `features/pickRates/` | Flag-gated pick-rate statistics sub-feature |
| `test/` | `factories.ts` — shared `UnitCard`/roster fixtures |

Notable components: `Builder.tsx` (the main builder screen, ~60 KB),
`BuilderGrid.tsx`, `BottomTray.tsx`, `CorpsSelect.tsx`/`CorpsPickerModal.tsx`,
`DetailsPanel.tsx`/`Tooltip.tsx`/`Medallion.tsx`, `FilterPanel.tsx`/`DualRange.tsx`,
`PlannerScreen.tsx` (Ordre de Bataille, ~35 KB), `ReplayScreen.tsx`,
`RotationModal.tsx`/`TowGenerateModal.tsx`/`TowRollModal.tsx`,
`GeneralSwapModal.tsx`, `SaveLoadBar.tsx`/`SavedBuildPicker.tsx`,
`OfflinePanel.tsx`/`FactionOfflineButton.tsx`, and image export via
`exportBuildImage.ts`/`renderPlanImage.tsx` (`html-to-image`).

### 6.3 Key domain types

`UnitCard` carries both game data and the accounting hooks the rules need:
`unitKey`, `factionKey`, `cost`, `cap`, `groupCap`, `placement {division, brigade} | null`,
`isGeneral`, `generalKind: "staff" | "combat" | null`, `capGroupKey`/`baseUnitKey`
(the `_com_<N>` suffix stripped, for shared-cap accounting),
`underlyingUnitClass` (the class a combat general reports, so he occupies his led
unit's slot), `rosterIndex`, `guns`/`gunType`, `stats`, `abilities`.

### 6.4 Data loading

`web/src/data/` is fetch-and-normalize only. The pipeline writes **directly into
`web/public/data` and `web/public/assets`** (gitignored); Vite copies `public/`
verbatim into `dist/`. At runtime `load.ts` fetches over HTTP(S) or `app://`:
`loadCorpsIndex()` → `corps-index.json`, `loadFaction(key)` →
`factions/<key>.json`. `dataUrl`/`assetUrl` resolve against Vite's `BASE_URL`,
and `base: "./"` means one build works from a GitHub Pages sub-path, `file://`,
or Electron's `app://` alike. The JSON is never bundled as JS modules.

`version.ts` derives `dataVersionKey()` from `data-version.json`
(`schemaVersion` + row counts + `contentHash`) and is shared verbatim with the
service worker — hence the comment there to keep the module DOM-free.

### 6.5 Persistence (`state/storage.ts`, `saves.ts`, `plan.ts`)

A `StorageAdapter` interface (`read`/`write`/`remove`) decouples everything from
`localStorage`. `LocalStorageAdapter` write-probes on construction (so a present
but throwing storage, e.g. private browsing, falls back) and detects quota
errors; `MemoryStorageAdapter` is the fallback and the test double. All keys are
namespaced `rda.`.

```ts
SavedBuild {
  id, name, factionKey,
  instances: string[],        // one unitKey per selected copy — duplicates round-trip
  staffSlotUnitKey,
  config, createdAt, updatedAt,
  saveFormatVersion           // SAVE_FORMAT_VERSION = 2
}
```

`migrateSavedBuild` defensively upgrades older shapes (v1 stored a
`unitKey → count` record). `resolveSavedBuild` turns a `SavedBuild` + a loaded
roster back into the live `BuildState { instances: {id, unitKey}[], staffSlotUnitKey }`,
dropping and *reporting* unit keys no longer in the roster.

`BuildRepository` (`list`/`get`/`save`/`remove`/`rename`/`duplicate`/`findByName`)
stores one JSON array under `rda.savedBuilds`, and is careful to preserve unknown
fields and entries from other format versions byte-for-byte — **the stable and
beta web deployments share one `localStorage` origin**, so a careless write would
corrupt the other channel's saves.

`exportAllBuilds`/`importAllBuilds` implement a full backup file (format
`"rda-builds-backup"`) because iOS can evict site storage from an idle installed
PWA. Import merges by id and never overwrites a locally-newer entry.

Plans (`plan.ts`): `Plan { slots: PlanSlot[] }`, 1–4 slots, each holding a
**copy** of a `SavedBuild` so editing a plan can't mutate the saved-build
library. Named plans under `rda.plans`; the autosaved working plan under
`rda.currentPlan`.

Only `localStorage` is used for app state. IndexedDB/Cache Storage appears only
via Workbox for asset caching — a separate system.

### 6.6 PWA and offline

`vite.config.ts` configures `VitePWA` with `strategies: "injectManifest"`,
`srcDir: "src"`, `filename: "sw.ts"`, `registerType: "prompt"`,
`injectRegister: false` — i.e. a **hand-written service worker** with Workbox
only injecting the precache manifest.

Precache covers the shell, CSS/JS, PWA icons, `assets/ui/**`,
`assets/army_corps_by_theatre/**`, and the two small stamp files. It deliberately
**excludes** the ~13.6k unit icons and ~297 faction JSONs; those are runtime-cached
cache-first by `sw.ts` route predicates (`isFactionJson`, `isUnitIcon`), keyed by
`dataVersionKey`. On `activate`, caches not matching the current version key and
deployment scope are swept.

`registerType: "prompt"` means a new worker waits until the user accepts via
`pwa.ts::applyUpdate()` (which posts `SKIP_WAITING` and reloads). Other open
tabs get `onUpdatedElsewhere` instead of a forced reload — reloading them would
discard an unsaved build.

**Per-corps "Save offline"** (`state/offline.ts`) is explicit selective caching
on top of that. `downloadFactionOffline(roster)` collects the faction JSON plus
every icon it references (`rosterAssetUrls`: card icons, command-star strips,
guerrilla badges) and fetches them 6-way-concurrently into a **durable,
version-keyed** `offlineCacheName(key)` bucket, distinct from the evictable
`runtimeCacheName(key)`. Assets already in the runtime cache are *moved*, not
duplicated. A per-faction completion marker (`__offline__/<versionKey>/<factionKey>`)
is written only on full success, so a partial download never reports "offline".
`downloadAllFactionsOffline` drives this sequentially and skips already-offline
factions, so it doubles as resume/retry.

Cache names are scoped by deployment path (`deploymentScope`), so the stable and
beta sites — same GitHub Pages origin, different sub-paths — never read or evict
each other's caches. `requestPersistentStorage`/`storageEstimate` back the quota
UX in `OfflinePanel.tsx`.

`pwa.ts::isWebTarget()` detects Electron (via `app://`/`file://` protocol or an
`Electron/` user-agent substring) and makes all of this a no-op there — the
desktop build ships its data bundled and is offline by construction.

### 6.7 Electron (`web/electron/`)

`main.cjs` registers a privileged `app://` scheme
(`standard` + `secure` + `supportFetchAPI`) and serves the built `dist/` tree
over `app://bundle/...` via `protocol.handle`, validating that every resolved
path stays inside `DIST` (no `../` escape) and mapping extensions to MIME types.
That's what lets the renderer's relative `fetch("./data/…")` work identically to
the web build.

The window is locked down: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`. External links go through `shell.openExternal`, and
`will-navigate` is blocked for any non-`app` URL (complementing the `main.tsx`
drop guards). A single-instance lock focuses the existing window on relaunch. A
`SMOKE_TEST` env var runs a headless self-check (did the SPA mount, could it
fetch `data-version.json`) writing the result to a file — necessary because a GUI
`.exe` on Windows doesn't attach to a parent console.

**Auto-update** uses `electron-updater` against GitHub Releases, with one rule
that must not be changed casually:

> `autoUpdater.allowPrerelease = false` is mandatory, including for `-beta.N`
> builds. With `allowPrerelease = true`, electron-updater's GitHub provider walks
> the unsorted `releases.atom` feed — ordered by tag commit date, not semver —
> and takes the first match, which can permanently pin a beta client to its own
> stale version. With it `false`, the updater hits `/releases/latest` and that
> release's `latest.yml`, which is correct regardless of version-string shape.
> This is why beta releases are published as **ordinary, non-prerelease** GitHub
> releases.

Portable builds (`IS_PORTABLE`, detected via `PORTABLE_EXECUTABLE_*` env vars)
disable auto-download and just offer to open the releases page — a portable
`.exe` must never silently run the NSIS installer on quit.

**Channel separation.** `web/package.json`'s top-level `"build"` block is the
*stable* electron-builder config (appId `fr.ministeredelaguerre.registredesarmees`,
publishing to `registre-des-armees`). `electron-builder.beta.cjs` spreads it and
overrides `appId` (`+".beta"`), `productName` (`+" Beta"`), NSIS names, the
publish repo (`registre-des-armees-beta`, `releaseType: "release"`), and crucially
`extraMetadata.name = "registre-des-armees-beta"` — which gives beta its own
`app.getName()`, userData folder, and updater cache, so beta and stable have
entirely separate saved builds and update state.

### 6.8 Build tooling

| File | Role |
| --- | --- |
| `vite.config.ts` | React plugin + `VitePWA`; `base: "./"`; a WSL2 `usePolling` watcher workaround (inotify doesn't fire for `/mnt/c`); `stripPickRateDataWhenDisabled`, a `closeBundle` plugin that deletes `dist/data/pick-rates` unless built with `VITE_PICK_RATES=1` |
| `tsconfig.json` | Solution file — references only, no direct compilation |
| `tsconfig.app.json` | The app: `ES2021` + `DOM`, `react-jsx`, strict, `noUnusedLocals/Parameters`, `include: ["src"]` but **`exclude: ["src/sw.ts"]`** |
| `tsconfig.node.json` | `vite.config.ts` itself |
| `tsconfig.worker.json` | **Only** `src/sw.ts` + `src/data/version.ts`, with `lib: ["ES2021", "WebWorker", "WebWorker.Iterable"]` and `types: []` |
| `.eslintrc.cjs` | Classic config: `eslint:recommended`, `@typescript-eslint/recommended`, `react-hooks/recommended`, `react-refresh/only-export-components` |

`tsconfig.worker.json` exists because the service worker runs in
`ServiceWorkerGlobalScope`, not `Window`: its ambient globals (`self`, `caches`,
`clients`) conflict with the `DOM` lib. So `sw.ts` is excluded from the app
project and type-checked against `WebWorker` separately. `version.ts` is in both
projects because `sw.ts` imports it. `npm run typecheck` runs both passes.
`npm run lint` uses `--max-warnings 0`, so warnings fail in practice.

### 6.9 Tests

Vitest, configured in `vite.config.ts` (`globals: true`, `environment: "node"`,
`include: ["src/**/*.test.ts", "src/**/*.test.tsx"]`). 24 test files, colocated
next to their modules.

| File | Covers |
| --- | --- |
| `state/build.test.ts` (42 KB — the largest) | `evaluateAdd`, `priceBuild`/`affordableSubset` soft-ceiling behavior, `autoPickCombatGenerals` exact vs greedy paths and tie-breaking |
| `rules/rules.test.ts` (25 KB) | Parity with `army_builder_rules.py`: discounts, caps, classification |
| `state/towRoll.test.ts` (27 KB), `state/rotation.test.ts` (20 KB) | Calibration fixtures replaying real observed in-game windows — these are what pin the PRNG/seed/shuffle reproduction |
| `domain/replay.test.ts` (19 KB) | `.replay` binary parsing against sample byte sequences |
| `state/saves.test.ts`, `backup.test.ts`, `plan.test.ts`, `storage.test.ts` | Save migration, backup merge semantics, plan persistence, storage quota/fallback |
| `data/data.test.ts`, `data/version.test.ts` | Malformed/missing-field robustness, cache-key derivation |
| `components/Builder.notify.test.tsx`, `ConfirmProvider.test.tsx` | The only two component tests — the suite deliberately targets the pure layers |

The rotation and ToW calibration fixtures are the repo's most valuable tests: the
only way to know the rotation engine is still correct is that it still reproduces
those recorded windows.

---

## 7. Release workflow

### Web / PWA — continuous

`.github/workflows/deploy-web.yml` fires on every push to `main`. It regenerates
`web/public/{data,assets}` with Python 3.12 + Pillow (`python tools/build_web_data.py`),
installs with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` (the desktop binary isn't needed),
runs `typecheck && lint && test`, builds, and deploys to GitHub Pages. Permissions
are least-privilege (build job reads only; Pages write + OIDC go to the deploy job)
and `concurrency: pages` lets a newer push supersede an in-flight run.

**Web releases are date-labelled, not semver:**

```
Web YYYY.MM.DD (beta channel): <summary>      # second drop same day → .2, .3, …
```

`web/package.json`'s semver is a **desktop concern only** — it feeds
electron-builder artifact names and electron-updater's version comparison. Don't
put a date in it, and don't bump it for a web-only release.

### Desktop — manual

```
npm run desktop                 # build + electron-builder --win  (stable, local)
npm run desktop:beta            # same via electron-builder.beta.cjs
npm run desktop:release         # publish stable to GitHub (needs GH_TOKEN)
npm run desktop:beta:release    # publish beta
npm run desktop:beta:stage      # build beta, then stage assets for a manual release
```

`web/scripts/stage-release.mjs <stable|beta>` copies only what a GitHub Release
needs — `<prefix>-Setup-<version>.exe`, its `.blockmap`, `latest.yml`, and
optionally the portable `.exe` — from `web/release/` into a clean
`_github_assets[_beta]/` at the repo root. It first validates that `latest.yml`'s
stamped version matches `package.json` **and** that it points at *this* channel's
Setup exe, guarding against publishing a stale or cross-channel `latest.yml`
that would send auto-updating clients at a missing installer.

See [`web/DESKTOP.md`](../web/DESKTOP.md) for the installer details, the
SmartScreen situation (builds aren't code-signed), and the
`electron/7za-wrapper.cs` workaround for the Windows symlink-privilege error
`winCodeSign` extraction can hit without Developer Mode.

---

## 8. Working on this

### Setup

```bash
# Data (needs Python 3.12 + Pillow)
python -m pip install --upgrade Pillow
python tools/build_web_data.py          # → web/public/{data,assets}

# App
cd web
npm ci
npm run dev
```

### Verify before pushing

```bash
cd web && npm run typecheck && npm run lint && npm test
python -m pytest tools/tests            # from the repo root
```

### Invariants worth knowing before you change anything

1. **`rules.ts` ↔ `army_builder_rules.py` must stay in parity**, as must
   `replay.ts` ↔ `replay_parser.py`. TypeScript is the reference in both pairs.
2. **`rosterIndex` must come from raw CSV row order**, stamped before any display
   sort. The rotation engine's shuffle input depends on it.
3. **Don't touch `rotation.ts`'s PRNG, seed, warm-up count, or pool sort** without
   re-running the calibration fixtures. The 5 discarded warm-up draws and the
   `/2.8` bucket divisor look like bugs; they are the game's behavior.
4. **Pricing is order-sensitive** (§4.3). Any change to recruit order changes
   prices.
5. **`autoUpdater.allowPrerelease` stays `false`** (§6.7).
6. **`saves.ts` writes must preserve unknown fields** — stable and beta share one
   `localStorage` origin.
7. **Keep `data/version.ts` DOM-free** — it's bundled into the service worker.
8. **Bump `SCHEMA_VERSION`** in `build_web_data.py` when the generated JSON shape
   changes; bump `SAVE_FORMAT_VERSION` (with a migration) when `SavedBuild`
   changes.
9. **Integer arithmetic in the discount math is deliberate** — `floor` placement
   matches the Lua and is what makes prices agree with the game to the livre.
