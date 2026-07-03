# TOW Army Builds — spec

Scope: how a **Theatres of War (`_tow_`)** army is assembled and ordered in the army-builder
screen. TOW counterpart to the Army-Corps (`_ac_`) builder. TOW reuses the **normal build rules of
the AC builder** (§5) except for the deliberate divergences: **combat-general cap = 1**, **no
division/brigade discount**, and **source-corps divisions with arm/class/speed brigades** (§2/§4).

Authoritative math for the app: `web/src/rules/rules.ts` (↔ `tools/army_builder_rules.py`, keep
parity); ordering: `web/src/state/ordering.ts`. Legacy provenance: `source/original lua
files/ntw3.lua` + `ntw3ac.lua`.

---

## 0. Data source & available fields (verified)

Master table: `data/generated/ntw3_army_builder_units.csv` (25,668 rows; **12,032 with
`is_tow_variant=true`**). Browser copy flows through `tools/build_web_data.py` →
`web/src/data/load.ts` → domain models. Fields this spec relies on (all present in the CSV):

| field | use |
|---|---|
| `is_tow_variant` (bool) | **filter** — the full TOW unit list |
| `unit_key` | unique per variant; carries `_tow_<id>` (and `_com_<n>` for combat generals) |
| `faction_key`, `army_corps_name` | corps grouping (`army_corps_name` e.g. `[1799] 9. France (Italie)`) |
| source corps id | TOW division grouping: the 4th underscore component of `unit_key`, e.g. `081` in `ntw3_inf_line_081_030_2438_tow_032` |
| `unit_class` | brigade category — verified values below |
| `speed_code` | cavalry ordering (C1–C5) and per-arm speed tier |
| `base_mp_cost` (int, gold) | **per-variant** cost — see §7; within-brigade cost-desc sort |
| `unit_cap` (int) | **per-variant** max copies of this card — see §5/§7 |
| `is_general`, `is_commander_variant` (bool) | general classification (§3) |
| `command_stars` | staff-general ordering + star strip selection |
| `men_raw` | corroborates staff marker (`men_raw=32` ⇒ Men/2=16) |
| `icon_path`, `icon_filename`, `icon_match_method` | unit icon linkage (§8) |
| `command_star_icon_path`, `command_star_strip_path`, `command_star_layout` | general star overlay (§8) |
| `division_brigade_code`,`division_id`,`brigade_id` | ACDV tags — present for ~91% of TOW units but **unused** for TOW layout (§6) |

**Verified `unit_class` values (TOW):** `general` (5439), `infantry_line` (2144),
`infantry_light` (718), `infantry_grenadiers` (549), `infantry_skirmishers` (353),
`infantry_militia` (292), `infantry_irregulars` (51); `cavalry_light` (640), `cavalry_standard`
(365), `cavalry_lancers` (321), `cavalry_heavy` (277), `cavalry_missile` (11); `artillery_foot`
(614), `artillery_horse` (254), `artillery_fixed` (4).

---

## 1. Corps roll — show every corp (for now)

Legacy `NTW3AC.ToWFarmycorps` shuffled corps and sliced to `max_ac = 4`. **Drop that limit** — the
TOW screen lists **every corp** the faction can roll (group by `army_corps_name`), no shuffle, no
cap.

Legacy roll reference, from `source/original lua files/ntw3.lua` + `ntw3ac.lua`:

- `NTW3AC.ToWFarmycorps(faction, units)` builds the available source-corps list from **staff
  generals only**: `unit.IsGeneral` and `unit.Men / 2 == 16 or unit.Men / 2 == 61`.
- For each staff general, it splits `unit.Key` on `_` and uses the 4th component as the source
  corps id. Example: `ntw3_gen_staff_081_6_0115_tow_032` -> `081`.
- Source corps ids are deduplicated in **first-seen recruit order** — the game walks
  `FrontEnd.RecruitableUnits` (arm category → ascending cost → engine tie-break), **not** raw roster
  order, so the staff generals must be visited in that order before dedup. The generic code uses
  `recruitOrder`; `ntw3_tow_a06_x8_002`, `ntw3_tow_a09_x8_021`, and `ntw3_tow_a12_x8_003` have
  scoped source-corps-pool calibrations because their equal-cost engine tie-breaks are verified in
  game but not derivable from the exported tables. If
  there are more than 4, the list is shuffled with `NTW3.Shuffle` and sliced to the first 4;
  otherwise all ids are returned unchanged. (Verified against 9 in-game Russie-Centre windows and
  ordered in-game Prusse/Espagne/Flandres windows — see `web/src/state/towRoll.test.ts`.)
- `NTW3.Shuffle` is deterministic for the local date/time bucket: `seed = floor(hour / 2.8) *
  10000 + ddmm`, burns 5 random values, then runs Fisher-Yates. The seed does not include the year,
  and each shuffle call reseeds the RNG.
- `NTW3AC.ToWFgenerals(faction, units, corps_ids)` then includes all staff generals (`max_gens[1] =
  999`) and only combat generals whose key's 4th component is in the rolled `corps_ids`; both pools
  are shuffled separately, with up to 4 combat generals returned.

## 2. TOW divisions — source corps id, not ACDV

A TOW "division" is the set of units that came from one source army corps inside the selected
TOW army. Do **not** use `division_brigade_code` / `division_id` / `brigade_id` for this split:
those ACDV tags are army-corps-builder metadata and can mix several TOW source corps inside the
same ACDV division.

Use the source corps id embedded in the unit key instead:

```text
ntw3_gen_staff_081_6_0115_tow_032        -> source corps 081, TOW army 032
ntw3_inf_line_081_030_2438_tow_032       -> source corps 081, TOW army 032
ntw3_inf_line_081_030_2438_tow_032_com_3016 -> source corps 081, TOW army 032
```

For TOW keys, parse:

- `towId` from `_tow_<id>`; this matches the selected TOW army/faction.
- `sourceCorpsId` from the 4th underscore component (`parts[3]`) of the full unit key. Staff,
  base units, and combat-general variants all use the same source id convention.

Group all cards in a TOW roster by `sourceCorpsId`; each group is one TOW division. A division may
have multiple staff generals, and that is expected: it contains every possible staff general for
that source army corps. Render those staff generals in that division's Command brigade, ordered by
`command_stars` as in §3.

Verified data invariant: every non-general TOW unit source id currently has at least one matching
staff-general source id in the same TOW faction.

## 3. Generals — classification from real flags

- **Staff / corps commanders** = `is_general=true` **and** `is_commander_variant=false`
  (`ntw3_gen_staff_*` keys; `men_raw=32`; carry `command_stars`). HQ command cards are **all
  shown**, but grouped into their source-corps division (§2), not one global command block.
- **Combat generals** = `is_general=true` **and** `is_commander_variant=true`. **Cap = 1 total**
  (overrides `generalCaps`, which otherwise returns `combat = 9 − N` for `_tow_` — that override is
  the divergence). Each links to its parent unit by key-stem (`capGroupKey` strips `_com_<n>`), so
  it renders **inline next to its parent unit** and **counts against that unit's class cap**
  (`cappedClassOf`: an artillery-led combat general consumes an artillery slot). At most one combat
  general may lead a given base unit.

> The old `Men/2 == 16 or 61` heuristic maps to `classifyGeneral` (`men_raw` 32/122 ⇒ staff);
> prefer `is_commander_variant` for the staff-vs-combat split.

## 4. Brigade ordering

Within each source-corps division (§2), each entry is one **brigade / gap**, top-to-bottom in this
fixed order. **Within a brigade, units rank by `base_mp_cost` descending**, with combat generals
hugging their unit (§3).

1. **Command** — staff generals (`is_commander_variant=false`), sorted by `command_stars`.
2. **Cavalry — by `speed_code`**, one gap per tier in this order (heaviest → lightest):
   - **C1 + C2 together** (one gap) — `cavalry_heavy` (cuirassiers)
   - **C3** — `cavalry_standard` (battle cavalry)
   - **C4** — `cavalry_light` (hussards/chasseurs)
   - **C4/C5** — `cavalry_lancers`
   - **C5** — `cavalry_missile` (cossacks / irregular "shooting" cavalry)
3. **`infantry_grenadiers`**
4. **`infantry_light`**
5. **`infantry_skirmishers`**
6. **`infantry_line`**
7. **`infantry_militia`** + **`infantry_irregulars`** (militia / irregular infantry)
8. **`artillery_foot`** (foot guns)
9. **`artillery_horse`** (horse guns)
10. **`artillery_fixed`** — its own brigade, **last** (Congreve rockets, marine/fixed guns; `[F0]`,
    empty `speed_code`)

Intentional TOW≠AC differences: cavalry precedes infantry (AC does infantry→cavalry); foot, horse,
and fixed artillery are **three separate** gaps (AC interleaves foot+horse by cost).

## 5. Normal build rules (caps) — same as AC

All AC roster limits apply to TOW. Source of truth: `web/src/rules/rules.ts` (mirror in
`tools/army_builder_rules.py`).

| rule | limit | const |
|---|---|---|
| Total unit cards | 31 | `MAX_TOTAL_UNIT_CARDS` |
| Build cost (funds) | 10000 | `MAX_BUILD_COST` |
| Foot artillery | 2 | `MAX_FOOT_ARTILLERY` |
| Horse artillery | 1 | `MAX_HORSE_ARTILLERY` |
| Heavy cavalry | 10 | `MAX_HEAVY_CAVALRY` |
| Combat generals | **1** (TOW override) | §3 |

- **Per-card cap = the card's own `unit_cap`** (how many copies may be recruited). It is **shared
  across a base unit and its commander variants** (same `capGroupKey`) — a combat general counts
  against the underlying unit's cap. `unit_cap` varies widely by card (e.g. line infantry commonly
  1–4, militia up to ~14); do not assume a fixed number per class — read it from the row.
- The class caps for `artillery_foot`/`artillery_horse`/`cavalry_heavy` count combat generals by
  their **underlying** class (`cappedClassOf`).

## 6. Pricing — no discounts (already the case for TOW)

- Army price = **plain sum of `base_mp_cost`** over selected cards. `calculateArmyCost` already
  returns `baseCost` with zero discount for any non-`_ac_` key (TOW included) — no change needed
  there, just do not add one.
- **No division/brigade discount, no German-states ×1.5** for TOW (AC-only).
- ACDV `division_brigade_code`/`division_id`/`brigade_id` are **present** for ~91% of TOW units but
  the TOW view groups by source corps id (§2) and then orders by arm/class/speed (§4), not by them.
  Treat ACDV as inert for TOW layout.

## 7. TOW variant cost & cap are independent

Each variant is its own CSV row keyed by full `unit_key`. **The `_tow_` variant's `base_mp_cost`
and `unit_cap` may differ from the same unit's `_ac_` or base variant.** Always read cost and cap
from the **TOW row itself** — never copy them from another variant or assume parity across
variants.

## 8. Unit → icon linkage

Every TOW row has a populated `icon_path` (0 empty across all 12,032). Linkage:

- **`icon_path`** — repo-relative path to the source `.tga`, form
  `assets/icons/<arm>/<source-faction>_<body>_icon.tga`
  (e.g. `assets/icons/infantry/french_rev_inf_line_081_030_2438_icon.tga`). **`icon_filename`** is
  the basename. Resolve the browser URL via `web/src/data/assets.ts` (`.tga` source is converted to
  PNG under `web/public/assets/**` by `tools/build_web_data.py`).
- **`icon_match_method`** records how the icon was resolved. For TOW the dominant value is
  **`tow_base_reuse`** (11,626): the TOW variant **reuses the base unit's icon** — the icon keys off
  the underlying body, not the `_tow_<id>` suffix. Other methods: `uniform_table_exact` (300),
  `icon_name_exact_stem` (105), `uniform_table_first_declared` (1). Every method still yields a
  concrete `icon_path`, so consumers only need `icon_path`.
- **Combat generals** get their **own portrait** icon (`..._com_<n>_icon.tga`), not the unit's icon.
- **Command stars** are a separate overlay, populated only when `command_stars` is set:
  `command_star_icon_path` (e.g. `assets/ui/command_stars/star_gold.png`), `command_star_strip_path`
  (e.g. `assets/ui/command_stars/vertical/command_stars_3.png`), and `command_star_layout`
  (e.g. `vertical_left`). Render the star strip over the general's icon per the layout.

---

## Where to implement (pointers)
- Show-all-corps: `web/src/components/CorpsSelect.tsx` + `web/src/state/build.ts`.
- Combat-general cap=1: `web/src/rules/rules.ts` `generalCaps` (add a `_tow_` branch) — mirror in
  `tools/army_builder_rules.py`.
- TOW brigade sequence (§4), foot/horse/fixed split, cavalry-before-infantry, C1+C2 merged:
  `web/src/state/ordering.ts` (needs a TOW branch; current logic is AC-shaped).
- TOW source-corps divisions (§2): data/domain may need an explicit derived `sourceCorpsId` rather
  than reusing AC `placement`.
- Icons: already resolved upstream; verify `load.ts`/`assets.ts` surface `icon_path` and the star
  fields into the domain model for TOW cards.

## Open items to confirm
- `artillery_fixed` placement resolved (own brigade, last — §4.10); confirm rockets vs marine guns
  should share that one gap.
