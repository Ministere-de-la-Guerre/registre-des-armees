# Pick rates

Optional overlay in the army builder showing how often each card was fielded in a corpus
of Clan Games replays ("season"). Army Corps only. Flag-gated: absent from normal builds.

## Build flag

- Enabled by `vite build --mode pickrates`, which loads `web/.env.pickrates` (`VITE_PICK_RATES=1`).
  Without it there is no toggle, no fetch, and `vite.config.ts` drops `data/pick-rates/` from `dist`.
- npm scripts (`web/package.json`): `build:pickrates` (web build), `build:pickrates:data`
  (runs `tools/build_pick_rates.py`), `desktop:beta:pickrates`, `desktop:beta:pickrates:stage`.

## Data pipeline

```
data/clan_games_replays/<season>/*.replay          (local, not shipped)
  -> python3 tools/analyze_replays.py --replays <dir> --out reports/replay_stats/<season-id>
  -> reports/replay_stats/<season-id>/*.csv          (git-ignored)
  -> python3 tools/build_pick_rates.py --stats reports/replay_stats/<season-id> \
        --season-id <season-id> --label "<label>" [--recorded YYYY-MM]
  -> data/pick_rates/<season-id>.json + index.json   (committed; source of truth)
  -> web/public/data/pick-rates/                     (copied; also by build_web_data.py)
```

Each build replaces one season file and rewrites `index.json` (default season = last by
natural order). Needs `data/generated/ntw3_army_builder_units.csv` and
`web/public/data/{corps-index,data-version}.json`.

## "All seasons" dataset

An ordinary season file built from every season's replays analyzed together. Repeating
`--replays` makes `battle_id` `<folder>/<file>` (file names recur across seasons) and runs
duplicate detection across all folders, so a game uploaded in two seasons counts once.
**Rebuild it whenever a season is added** (add the new `--replays`):

```
python3 tools/analyze_replays.py --replays data/clan_games_replays/season_8 \
    --replays data/clan_games_replays/season_9 --replays data/clan_games_replays/season_10 \
    --out reports/replay_stats/all-seasons
python3 tools/build_pick_rates.py --stats reports/replay_stats/all-seasons \
    --season-id all-seasons --label "All seasons" --recorded "<first> – <last>"
```

The id `all-seasons` sorts before `season-*` in `index.json`: it is first in the switcher,
and the default stays the newest season.

## Exclusion

Two levels, applied to all armies (AC, TOW, custom); scope narrowing happens in `build_pick_rates.py`.

**Battle level** (whole battle dropped, `excluded_battles.csv`: `battle_id, reason, detail`):

| Order | Reason | Meaning |
|---|---|---|
| 1 | `parse_error` | `replay_parser.parse` raised |
| 2 | `naval` | zero armies parsed, or any `ntw3_nav_` key |
| 3 | `duplicate` | same fingerprint (map + sorted army_key/player/staff/unit keys, over ALL parsed armies, before any army is dropped) as an accepted battle, i.e. one game uploaded twice |

**Army level** (only that army dropped, `excluded_armies.csv`: `battle_id, army_index, army_key, player, reason, detail`).
The battle stays accepted and its other armies count normally; `battles.csv` `armies` is the kept count.
A dropped army has no rows in `armies.csv` / `army_units.csv` and is not counted in `players.csv` / `corps_popularity.csv`.
`army_index` keeps the army's original position in the battle (no renumbering).

| Order | Reason | Meaning |
|---|---|---|
| 1 | `unverifiable` | a staff/unit key does not resolve to a card of that army's own faction, or the faction has no roster |
| 2 | `over_budget` | `calculate_army_cost(...).final_cost` > 10000 (`MAX_BUILD_COST`) |
| 3 | `limit_violation` | `check_known_limits` reports violations (staff slot 0, roster passed, as in `web/src/state/build.ts`) |

Special case, not a rule break: when `staff_key` resolves to a non-General card, the army fielded no staff
general (the parser positionally read its first unit as the staff slot). The analyzer treats that card as an
ordinary first unit, checks limits with no staff slot, and writes no staff-slot row.

## Analyzer CSVs

Booleans are the literal strings `True`/`False`. `battle_id` is the replay file name;
`army_index` is the army's 0-based position in the battle (a corps fielded twice stays two builds).

- `battles.csv`: battle_id, game_build, map, victory_condition, wind, armies
- `armies.csv`: battle_id, army_index, army_key, corps_name, player, side, staff_key, units, final_cost
- `army_units.csv`: battle_id, army_index, army_key, slot, unit_key, base_unit_key (cap group, i.e. commander suffix stripped), is_commander, is_staff_slot, resolved (staff general is slot 0)
- `players.csv`: player, battles, armies
- `corps_popularity.csv`: army_key, corps_name, appearances, distinct_players
- `excluded_battles.csv`: battle_id, reason, detail
- `excluded_armies.csv`: battle_id, army_index, army_key, player, reason, detail

## Season file (`data/pick_rates/<id>.json`, schemaVersion 3)

- `id`, `label`, `patch` (e.g. `NTW3 1.3.0 (Build 2081)`, or `mixed (n game builds)`)
- `corpus`: `battles`, `armies`, `players` (in-scope only), `recorded`
- `scope`: `corpsTypes` (`["ac"]`), `note`
- `unitDataVersion`: unit-DB stamp the corpus was computed against
- `thresholds`: `minSampleForPercent` 5, `autoInclude` 85, `contested` 25, `rare` 5
- `corps[factionKey]`: `name`, `n` (army appearances = builds), `players?`, and when `n > 0`:
  - `units[unitKey]`: `b` builds containing >= 1 copy of that exact card, `t` total copies
  - `regiments[baseUnitKey]`: `b`, `t` rolled up over the plain unit and all commander variants, `c` builds led by a commander variant. A combat general in the command slot (`is_staff_slot` and a commander variant) is excluded from this rollup, since it is not fielding that regiment in the line; it still counts in `units`. Staff generals' own rows still count here
  - `builds`: `{"keys": [unitKey, ...], "b": [[idx, ...], ...]}` (schema v3). One inner array per recorded build
    (the same battle_id + army_index builds `n` counts, in army_units.csv appearance order, so `len(b) == n`). Each
    lists indices into `keys` for that build's unit cards, copies repeated, staff slot excluded (`is_staff_slot`),
    sorted ascending. `keys` is sorted, unique, and limited to keys that corps' builds use. Only corps with `n > 0`.
    If an old `army_units.csv` lacks `is_staff_slot`, slot 0 is dropped instead (with a warning).

`index.json`: `defaultSeason` plus per-season summaries (`battles`, `armies`, `players`,
`corpsWithData`, `corpsInScope`, `recorded`, `file`).

## Suggest units (`web/src/features/pickRates/suggest.ts`)

A bottom-tray sheet ("Suggest units") listing what builds like the user's also took. Pure and deterministic,
recomputed on every build change (add, remove, swap, commander change, clear) and on season switch; it is cheap
(about 100 builds x 30 keys) so nothing is cached across changes.

- Regiment set: a build's cards mapped to `capGroupKey` (staff excluded); the user's set is the same over their
  instances. Similarity = Jaccard over these sets. Neighbours = the 15 most similar builds (`min(15, n)`, ties by
  original order). An empty build makes every build a neighbour (corps-wide counts).
- Needs `n >= 15` recorded builds, builds present in the season file, and a matching roster stamp; otherwise the
  sheet shows a reason line instead of rows.
- Units row: up to 8 regiments in at least 2 neighbours and absent from the build, ranked by neighbour count.
  Combat generals row: up to 8 combat generals in at least 2 neighbours, each as `have`, `swap` (the build has
  the plain regiment) or `add`, with real blocks (combat cap, regiment already led, add rules).
- Cost change = real `priceBuild` of the build after the add/swap minus the current one, so division discounts
  show (a negative change means the add completes a division).
- General chooser: the swap modal shows per-option pick rates, "All builds" (regiment-level `units` data) and
  "Like yours" (share of the neighbours containing that regiment).

## Absence states (`web/src/features/pickRates/pickRates.ts`)

Never collapse these:

1. **Corps not in scope** (`corps[key]` missing: TOW, Custom Armies) -> `out-of-scope`, shows the scope note.
2. **In scope, `n = 0`** -> `unplayed` ("no battles recorded").
3. **Card omitted from `units`, corps has `n > 0`** (zero-pick cards are not written):
   - `unitDataVersion` matches the app's data version (`rosterMatches`) -> `never` ("0 of n builds"), a real finding.
   - roster is newer / stamp missing or different -> `unknown`, the card may postdate the corpus.
4. **Card present** -> `data`; `pct` is `null` when `n < minSampleForPercent` (fraction shown, no percentage).

Tiers and buckets are further withheld on thin samples (buckets need `n >= 10`).
