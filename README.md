# Registre des Armees

App-ready NTW3 unit data, icons, source-table exports, and reproducible build tools.

## Main Data

- `data/generated/ntw3_army_builder_units.csv`: all allowed unit and army-corps combinations.
- `data/staff_generals/staff_general_corps_placement.csv`: staff-general placement evidence.
- `data/staff_generals/staff_general_corps_placement_with_stars.csv`: explicit star-ready staff-general copy.
- `assets/icons_by_army_corps/`: unit icons organized by corps key and division.
- `assets/staff_general_icons_by_corps/`: staff-general portraits organized at corps root.

All paths stored in the CSV files are relative to this project folder.

## General Command Stars

The stars shown beside staff-general and combat-general portraits are not baked into
the portrait files. Napoleon renders a separate star texture repeatedly. The number
of stars comes from:

`db/mp_general_command_ratings_tables/mp_general_command_ratings.command_stars`

The join is:

`mp_general_command_ratings.unit_key = ntw3_land_units.key`

This applies to both `gen_staff` units and combat-general `_com_` variants. A missing
rating means that no command-star overlay should be shown. Staff-general ratings use
1-9 stars; combat-general ratings currently use 1-7 stars.

### Guerrilla Card Badge

Cards with guerrilla deployment display a small red-and-white circular badge over
the lower-right edge of their portrait. This is a global per-card rule for every
corps and ToW roster. It applies equally to ordinary units, artillery, combat
generals, and staff generals. The supplied in-game reference is the
**10-point Platov / Atamanstvo** corps in Russia 1812
(`ntw3_ac_b11_r5_189`). In that roster, 46 of 63 selectable cards carry the badge,
including Cossack cavalry, commander variants, and three artillery cards.

The app must render this as a card overlay whenever the selected CSV row has:

```text
has_guerrilla_deployment = true
```

Do not infer it from the corps, unit class, portrait, commander status, or general
type, and do not
apply it to every Platov card: the remaining 17 cards have the value `false`. Keep the
badge separate from the base portrait so one icon can be reused safely across roster
variants. The overlay position is `lower-right`, matching the supplied screenshot.

The original NTW3 card textures contain this badge baked directly into each marked
portrait rather than as a separately named UI texture. The reusable app overlay was
recovered by comparing 80 different marked portraits and retaining the identical
badge pixels. Use the native 16 x 16 transparent PNG at:

`assets/ui/guerrilla_badge/guerrilla_badge.png`

The CSV also provides `guerrilla_badge_path` and `guerrilla_badge_layout` on every
marked row. Unmarked rows leave both fields blank. Extraction provenance and layout
details are recorded in `assets/ui/guerrilla_badge/metadata.json`.

The original game textures were copied read-only from `data.pack`:

- Silver: `ui/frontend ui/skins/army_card_star.tga`
- Gold: `ui/frontend ui/skins/spanish_skin/army_card_star.tga`

The gold texture matches the in-game example and is the recommended app asset.

### Ready-To-Use Assets

- `assets/ui/guerrilla_badge/guerrilla_badge.png`: recovered 16 x 16 transparent
  guerrilla-deployment overlay for the portrait's lower-right edge.
- `assets/ui/guerrilla_badge/metadata.json`: extraction provenance and placement.
- `assets/ui/command_stars/star_gold.png`: one compact transparent gold star.
- `assets/ui/command_stars/star_silver.png`: one compact transparent silver star.
- `assets/ui/command_stars/vertical/command_stars_1.png` through
  `command_stars_9.png`: ready-made vertical overlays for the portrait's left edge.
- `assets/ui/command_stars/metadata.json`: dimensions, spacing, source, and path pattern.
- `source/original_game_command_star_assets/`: untouched extracted TGA copies.

The main troop CSV and staff-general CSV contain:

- `command_stars`: numeric rating; blank means no stars.
- `command_star_icon_path`: reusable single-star PNG.
- `command_star_strip_path`: ready-made PNG containing the correct star count.
- `command_star_layout`: currently `vertical_left`.

Example web layout:

```css
.portrait {
  position: relative;
}

.portrait-command-stars {
  position: absolute;
  left: 1px;
  top: 18px;
  image-rendering: auto;
}
```

Use the row's `command_star_strip_path` as the overlay image source. Keep the field
blank when `command_stars` is blank.

## Corps And Division Placement

Corps availability comes from exact `unit_key + faction_key` rows in
`units_to_exclusive_faction_permissions` where `allowed=true`.

Normal units use the `ACDV<division>B<brigade>` description tag and are copied to:

`assets/icons_by_army_corps/<faction_key>/Division_<number>/`

Staff generals do not contain an ACDV tag, so they belong at the army-corps root:

`assets/staff_general_icons_by_corps/<faction_key>/`

ToW icons are collected into their respective shared `TOW` folders.

## Army-Corps Flags And Theatres

`data/generated/army_corps_catalog.csv` and `data/generated/army_corps_catalog.json` are the app-facing indexes for
the army-corps selection screen. They map every recruitable `faction_key` to:

- its Empire, Coalition, Theatres of War, or Custom Armies section;
- its historical theatre heading, parsed year/rating, and screen display order;
- its displayed corps name and canonical source faction key;
- its original flag directory and available flag variants;
- separate main-selection and post-selection flag paths.

Assets are organized as:

`assets/army_corps_by_theatre/<side>/<ordered_theatre>/<faction_key>/flag.png`

Use `flag_png_path` (`44x22`) on the main theatre/corps selection screen shown in the
two overview screenshots. It is a clean flag without the later lobby annotations.

After a corps has been selected, use `post_selection_flag_png_path` when present.
This is copied from the original `flag_132.tga` (`132x66`) and may contain authored
corps abbreviations, campaign years, painted backgrounds, and colored rating numbers.
Those markings are baked into the image; they are not generated text. A blank
post-selection path means NTW3 supplies no authored `flag_132` for that corps.

The original NTW3 folder remains read-only. `tools/build_army_corps_catalog.py` reads
the copied `source/tables/ntw3_factions.tsv`, joins source factions to the normalized
army-builder keys by stable side/block/corps ID. It uses the horizontal
`mini_flag.tga` shown by the selection screen. When that compact asset is absent, the
same corps' clean unit-identification or large flag artwork is used. `flag_132.tga`
is deliberately excluded from main-screen fallbacks because it belongs only after
corps selection. Every main-selection TGA and PNG is normalized to `44x22`;
`selection_flag_source_file` and
`selection_flag_derivation` record whether it was native or resized. The catalog
lists all other available original variants without duplicating the HUD textures.

The 1813 Hessen-Kassel corps has only a written post-selection flag in its own source
folder. Its main-screen flag therefore reuses the native clean mini flag from the
same `s7` Hessen-Kassel contingent in 1808; the donor is recorded in
`selection_flag_donor_source_faction_key` rather than being hidden.

Theatre headings come from the supplied English in-game screenshots. The `a16` and
`b16` German Campaign (1813) blocks exist in the source faction table but are not
visible in those screenshots, so their `theatre_basis` is explicitly recorded as
`source_block_inference`. See `reports/army_corps_catalog_validation.txt`.

## Army-Builder Rules

Reusable source-backed calculations are in `tools/army_builder_rules.py`. The main
CSV is the recruitable-card input: each row is an allowed `unit_key + faction_key`
pairing, and `base_mp_cost` is that card's `MPCost`. Commander variants therefore
use their own row cost without adding another base-unit cost.

Base army cost is:

```text
sum(selected card MPCost)
```

Only faction keys containing `_ac_` receive brigade or division discounts. Placement
is parsed strictly from `ACDV<division>B<brigade>`; the raw numeric division and
brigade IDs are used for pricing.

Verified in-game placements may be recorded as narrowly scoped build overrides when
the supplied localisation omits its ACDV tag. For `ntw3_ac_a03_x5_080`
(`12. Bonaparte / Italie.C`), the fifth and final division is:

- `ACDV5B1`: 12-, 4-, and 8-pound foot artillery, including the 8-pound battery's
  combat-general variant.
- `ACDV5B2`: 8- and 4-pound horse artillery.
- `ACDV5B3`: Sapeurs and Tirailleurs.

For genuine `ntw3_ac_*` army corps, untagged non-general cards then use the verified
final-division convention. Foot and fixed artillery join the foot-artillery brigade, horse
artillery joins the horse-artillery brigade, and skirmishers, sappers, and marines
join the final brigade. Staff generals remain unplaced at the army-corps root.

For every recruitable, tagged, non-general row in a group:

```text
roster cost contribution = Cap * MPCost
required count contribution = Cap
```

Generals are excluded from predefined roster cost and required count. Every selected
tagged card still adds one to its brigade and division completion count, including a
tagged combat general. A division is complete when its selected count reaches its
required count. A complete division receives only the division discount; otherwise,
each complete brigade receives its own discount. They do not stack.

```text
group discount = floor(group roster cost * (group required count - 1) / 100)
final AC cost = base army cost - total applied discount
```

German States detection splits the faction key on `_` and checks only whether the
fourth component contains lowercase `g`. Its applied discount is:

```text
floor(total normal discount * 1.5)
```

The code uses integer arithmetic for both floors.

### General And Card Limits

A General-class row is staff/nonfighting only when exact raw `Men / 2` is 16 or 61
(`men_raw` is 32 or 122); every other General-class row is combat. The display field
is not used because it can be floor-derived. Missing raw `Men` is reported rather
than guessed. Staff cap is 1. Combat cap is 1 for faction keys without `_ac_` and
without `_tow_`. For AC/ToW keys, trailing digits `N` are read from the fourth
underscore-separated component and combat cap is `9 - N`. This formula applies to
every army corps; there are no corps-specific exceptions or override table.

Every General-class unit whose key contains `_gen_staff_` has a final in-game men
count of 16. The generated `men_display` field and `UnitCard.final_men_count` both
enforce 16 for all staff generals, including rows with missing raw men data. The
generator records 32 raw men when a staff-general source row is missing. Combat
general variants with missing stats inherit the raw and displayed men counts from
their regular base unit after removing the `_com_<digits>` suffix. If duplicate base
stats disagree on that count, the first declared source row is used deterministically.

The build app has one corps-command/staff slot. A true staff general can occupy it,
and a combat general may be moved from a division into that slot. A combat general
placed there remains a combat-general card for its identity, cost, stars, ACDV
completion, and underlying-unit cap, but it does not count against the corps'
combat-general cap. The slot can contain only one general.

A unit may be led by at most one combat general, even across different commander
variants of the same base unit (its shared cap group). The unit's own cap can permit
several copies, but only one of them carries a general: `check_known_limits` reports a
`combat_general_max:<faction>:<base_unit>` violation when more than one combat-general
variant of the same base unit is selected, and the build app blocks the second.

Reusable validation represents this placement with the zero-based
`staff_slot_index` argument to `check_known_limits`. Without that explicit placement,
combat generals are treated as division generals and count against the combat cap.

`NTW3AC.ACgenerals` has a separate automatic general-pool helper where the staff
maximum remains 1 and the combat candidate maximum is `combat cap + 2`. That pool
helper is preserved only as source-reference behavior. The build app must not use it
to determine which generals are visible.

### Combat-General Display

Display every combat-general commander variant available to the selected corps at
the same time. Do not reproduce NTW3's random combat-general rolls. Combat-general
caps restrict how many cards may be selected; they do not restrict which cards the
user may browse. Staff generals are also always displayed when available.

For example, `ntw3_ac_b11_r5_189` exposes all 18 Platov combat-general commander
variants simultaneously, alongside Matvei Platov as its staff general.
`UnitCatalog.cards_for_faction()` returns the complete unrandomized card list.

A combat-general commander variant counts as one card against the cap of its
underlying unit. The underlying key is obtained by removing the final
`_com_<digits>` suffix. For example, selecting
`ntw3_cav_light_214_018_1397_com_1463` uses one of the available slots for
`ntw3_cav_light_214_018_1397`; with a cap of 1, the commander and ordinary unit
cannot both be selected.

Other implemented limits are 31 total cards, 2 foot artillery, 1 horse artillery,
and 10 heavy cavalry. A displayed division supports at most 7 brigade slots; seven
is a UI maximum, not a requirement that every slot be occupied.

### Confirmed Scope

The app uses the CSV `base_mp_cost` directly and does not apply XP-adjusted pricing.
It does not apply unit-compatibility exclusions. The relevant commander behavior is
implemented as shared cap accounting between `_com_` variants and their underlying
unit; no additional commander-conflict rule is assumed.

Range extraction requires an active ranged weapon. Equipment-template labels such
as `carbine` are ignored when the unit has zero ammunition and no artillery gun type;
those cavalry cards are melee-only and correctly retain a blank range.

See `reports/army_builder_rules_validation.txt` for current input validation and
unresolved source-data mappings.

The two conflicting localisation rows for `ntw3_gen_staff_285_2_0600` and its
`_tow_057` variant are resolved as **Ferdinand von Wintzingerode**. This is confirmed
by the original in-game card, which matches the 240 cost, two-star command rating,
portrait, and Wintzingerode biography. The override is limited to those exact keys.

Run the rule tests with the bundled Python runtime or any Python 3.10+ interpreter:

```text
python -m unittest discover -s tools/tests -v
```

## Rebuild Tools

- `tools/build_ntw3_army_builder_database.py`
- `tools/organize_icons_by_army_corps.py`
- `tools/collect_staff_general_icons.py`
- `tools/build_command_star_assets.py`
- `tools/army_builder_rules.py`
- `tools/validate_army_builder_rules.py`
- `tools/build_army_corps_catalog.py`
- `tools/build_web_data.py`

The original NTW3 installation is treated as read-only. Build outputs and extracted
copies are written only inside this repository.

## Division And Support-Division Inference

`build_ntw3_army_builder_database.py` resolves the division/brigade of every
army-corps card and records the decision in the `placement_source` column:

- `localisation_tag` — explicit `ACDV<d>B<b>` tag in the localisation.
- `verified_override` — a narrowly-scoped in-game-confirmed seed
  (`DIVISION_PLACEMENT_OVERRIDES`, e.g. Bonaparte / Italie.C division 5).
- `inferred_existing_support_division` — the highest tagged division already
  contains artillery, so untagged support cards join it.
- `inferred_new_support_division` — the highest tagged division is combat-only,
  so a **new** support division is created *after* it (this fixes artillery that
  was previously merged into the preceding infantry/cavalry division).
- `inherited_base_unit` — a `_com_<digits>` commander variant with no tag
  inherits its base unit's placement (important for artillery combat generals).
- `reserve_support_division` — division `0` (`ACDV0B*`) is the game's reserve/support
  division. When a corps has one, all of its reserve support (the division-0 tagged
  artillery plus any untagged support) consolidates there, organised by category
  brigade, and the web remap (`build_web_data.py`) displays it *after* every combat
  division. Divisional artillery tagged into a combat division (e.g. `ACDV4B4`) is
  untouched and stays with its division.

Within a support division: foot/fixed artillery → brigade 1, horse artillery →
brigade 2, skirmishers/sappers/marines → the final brigade. The generator reports
`ambiguous_support_division`, `commander_base_placement_disagreement`, and
`unplaced_commander_with_placed_base` warnings rather than guessing silently.

## Flag Transparency

The selection and post-selection flags already carry correct alpha. The earlier
"white background" on the Denmark, Mamluk and Nauendorf flags was a white CSS
backdrop showing through their transparent regions, now removed. For any future
source flag that genuinely uses white as a transparency key, add its
`faction_key` to `FLAG_WHITE_KEY_FACTIONS` in `tools/build_web_data.py`; a
border-flood-fill keys only the background and preserves interior white details.

## Web App

A desktop-first **React + TypeScript + Vite** army builder lives in `web/`.

```text
cd web
npm install
npm run build:data   # regenerate web/public/data + PNG assets from the CSV/catalog
npm run dev          # dev server
npm test             # Vitest (rules parity, build/blocking, filters, saves, ordering, data)
npm run lint
npm run build        # tsc + production build
```

Data architecture (raw inputs stay separate from generated outputs):

1. **Raw import / adapter** — `tools/build_web_data.py` converts
   `data/generated/ntw3_army_builder_units.csv` + `data/generated/army_corps_catalog.json` into normalized
   per-faction JSON under `web/public/data/` and converts `.tga` icons to PNG.
2. **Validation / normalization** — `web/src/data/load.ts` (unknown fields
   ignored, missing fields defaulted).
3. **Versioned domain models** — `web/src/domain/`.
4. **Rules engine** — `web/src/rules/rules.ts` (TypeScript port of
   `tools/army_builder_rules.py`, with parity tests).
5. **React UI** — `web/src/components/`.
6. **Save persistence** — `web/src/state/storage.ts` defines a `StorageAdapter`
   interface (localStorage + in-memory adapters); `web/src/state/saves.ts` is the
   versioned `BuildRepository`. Components never touch `localStorage` directly, so
   a future desktop `.exe` can swap in a filesystem/SQLite/IndexedDB adapter.

## Credits

The application icon (`web/build/icon.ico`) features **"Napoleonic Eagle" by
Sodacan** ([Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Napoleonic_Eagle.svg)),
licensed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
The eagle is unmodified, composited onto a coloured background; the resulting
icon is distributed under CC BY-SA 3.0. See `web/build/ICON_CREDIT.txt`.
