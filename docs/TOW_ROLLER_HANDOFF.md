# TOW Corps Roller — Implementation Handoff

Status: research complete, all 50 TOW factions calibrated/derived and verified against in-game rolls.
Goal: implement the "actual roller" — for any TOW faction and any local time, predict exactly which
4 divisions (source corps) the game rolls, and extend the existing time-finder features to all TOW corps.

Read together with `docs/HANDOFF.md` (architecture) and `docs/AI_FILEMAP.md` (file locations).

## 1. What the roller must reproduce (verified game mechanics)

The game logic lives in `source/original lua files/ntw3.lua` + `ntw3ac.lua` (function
`NTW3AC.ToWFarmycorps`, line 75). Mechanics, all already implemented in
`web/src/state/rotation.ts` and `web/src/state/towRoll.ts` — reuse, do not reimplement:

- **Seed** (local time, year-agnostic): `seed = floor(localHour / 2.8) * 10000 + (day * 100 + month)`
  → `seedForDate` in rotation.ts. 9 windows/day starting at local hours 0,3,6,9,12,14,17,20,23.
- **PRNG**: Win32 MSVC CRT `rand()` LCG (`state*214013+2531011`, bits 30..16), Lua 5.1
  `math.random(l,u)` = `floor(((rand() % 32767) / 32767) * (u-l+1)) + l` → `MsvcRng` in rotation.ts.
- **Shuffle**: re-seed, 5 warm-up draws of `range(1,100)`, Fisher-Yates from the top (Lua 1-indexed)
  → `shuffleByDate` in rotation.ts.
- **Corps roll** (`ToWFarmycorps`): build the pool of source-corps ids (below); if pool > 4,
  shuffle and keep the first 4 **in shuffle output order** (the in-game display order matches);
  if pool ≤ 4, no shuffle — all corps are always offered. → `rollTowSourceCorpsIds` in towRoll.ts.
- **General roll** (`ToWFgenerals`): all staff generals always offered; combat generals filtered to
  the rolled corps, shuffled, first 4 → `rollTowGeneralKeys` in towRoll.ts.

## 2. The pool-order problem and its resolution (the hard part, now solved)

The shuffle input order is the corps' staff generals as returned by the engine's
`FrontEnd.RecruitableUnits`, deduplicated into source-corps ids (id = 4th `_`-token of the staff
unit key, e.g. `ntw3_gen_staff_138_1_0178_tow_003` → `138`).

**Verified ordering rule:** staff generals sorted by **cost ascending** (no arm-category split for
staff — e.g. Murat [C4] sorts among same-cost infantry marshals), then first-seen dedup of source ids.

**Equal-cost tiebreaker: there is none in the data.** It is the deterministic residue of the game
engine's *unstable* C++ sort. Extensive testing (unit-key number, permission/land_units row order,
rosterIndex, alphabetical, plus faithful simulations of MSVC CRT qsort / std::sort / Lua table.sort
over the reconstructed recruit arrays) shows the equal-cost order is fixed per faction but cannot
be computed from the exported tables. **It must be (and now has been) calibrated from observed
rolls.** Method used: Fisher-Yates output positions depend only on (seed, poolSize), so each
observed window pins pool slots directly; majority vote across windows resolves the full order.

Calibration data source: `TOW_Rolls.txt` (repo root; user-recorded in-game rolls, July 2026).
Validation: 152/160 slots across the five 8-window rosters (the 8 misses are 4 transcription-slip
lines, see §5), plus 7×4 slots of the July-2 20:55 batch, plus 3 disambiguation windows — every
window matches the final pools exactly.

## 3. Definitive pool orders — all 50 TOW factions

Status meaning:
- `CALIBRATED` — order verified from observed rolls (equal-cost ties present).
- `DERIVED` — cost-ascending alone fully determines the dedup order (any tie permutation yields the
  same pool); safe with zero field data.
- `NO-SHUFFLE` — ≤ 4 source corps: the game never shuffles; all corps always offered; order shown
  is cost order but is irrelevant to the roll.

| factionKey | status | pool (source-corps ids, shuffle-input order) |
|---|---|---|
| ntw3_tow_a05_x8_001 [1805] 11. France (Allemagne) | CALIBRATED | 097,096,093,092,094 |
| ntw3_tow_a06_x8_002 [1806] 12. France (Prusse) | CALIBRATED | 099,106,246,105,104,102,100,103,101 |
| ntw3_tow_a08_x8_047 [1809] 10. France (Autriche) | CALIBRATED | 112,114,248,110,111,109,108 |
| ntw3_tow_a09_x8_021 [1809] 10. France (Espagne) | CALIBRATED | 142,143,147,145,146,140,144,141,148 |
| ntw3_tow_a12_x8_003 [1815] 9. France (Flandres) | CALIBRATED | 138,135,136,133,137,132,134,139 |
| ntw3_tow_a13_x8_022 [1811] 8. France (Espagne) | CALIBRATED | 153,149,151,247,154,152,150 |
| ntw3_tow_a17_x8_054 [1814] 8. France | CALIBRATED | 294,290,293,283,289,282 |
| ntw3_tow_b04_x8_016 [1800] 8. Osmanlı, UK | CALIBRATED | 072,073,070,074,069,071 |
| ntw3_tow_b06_x8_008 [1807] 9. Rossiya (Polsha) | CALIBRATED | 041,042,045,043,040 |
| ntw3_tow_b06_x8_009 [1806] 10. Preußen | CALIBRATED | 034,039,035,038,037,036 |
| ntw3_tow_b08_x8_044 [1809] 10. Österreich | CALIBRATED | 049,050,047,051,046,048,053 |
| ntw3_tow_b11_x8_013 [1812] 10. Rossiya | CALIBRATED | 263,262,192,188,184,190,185,186,183,249 |
| ntw3_tow_b13_x8_050 [1811] 7. España | CALIBRATED | 176,174,178,175,177 |
| ntw3_tow_a11_x8_028 [1812] 11. France (Russie-Centre) | DERIVED | 124,130,131,120,121,119,117 |
| ntw3_tow_a03_x8_032 · a03_x8_033 · a03_x8_038 · a03_x8_040 · a04_x8_005 · a05_x8_004 · a11_x8_027 · a11_x8_029 · b03_x8_039 · b03_x8_041 · b03_x8_042 · b03_x8_043 · b04_x8_015 · b05_x8_006 · b05_x8_007 · b07_x8_018 · b08_x8_045 · b08_x8_046 · b09_x8_019 · b09_x8_020 · b10_x8_026 · b11_x8_014 · b12_x8_011 · b12_x8_012 · b13_x8_049 · b14_x8_031 · b15_x8_052 · b15_x8_053 · b17_x8_055 · b17_x8_056 · b17_x8_057 · c07_x8_017 · c08_x8_048 · c10_x8_025 · c14_x8_030 · c15_x8_051 | NO-SHUFFLE | ≤4 corps — roll always offers everything |

Existing entries in `TOW_SOURCE_CORPS_POOL_CALIBRATIONS` (`web/src/state/towRoll.ts:14`) for
a06/a09/a12 match this table (independent re-derivation confirmed them). The 10 other CALIBRATED
rows are new and must be added.

## 4. Implementation plan

1. **Extend `TOW_SOURCE_CORPS_POOL_CALIBRATIONS`** in `web/src/state/towRoll.ts` with the 10 new
   CALIBRATED entries from §3. The existing mechanism (derive pool via `towSourceCorpsPool`,
   override with calibration when membership matches) already handles DERIVED and NO-SHUFFLE
   factions correctly — no structural change needed.
2. **The roller UI**: with §3 complete, `rollTowSourceCorpsIds(cards, date)` is now correct for
   every TOW faction. Build the feature on the existing pieces:
   - `TowRollModal` (corps-roll grid toggles) and `TowGenerateModal` (build-derived timing) —
     see `web/src/components/`.
   - `findTowCorpsCombinationTime` / `findTowBuildRollTime` (towRoll.ts) already scan nearest
     windows; they become trustworthy for all corps once the table is extended.
   - A per-window timetable view ("what rolls when") is cheap: iterate `WINDOW_START_HOURS`
     (rotation.ts) over dates, call `rollTowSourceCorpsIds`, display 4 division labels per window.
   - Division display names: the in-game roll labels each corps by its staff general(s) —
     two-staff corps show both (e.g. "Victor-Marmont" = corps 289). Use the staff generals of the
     source corps for labels (cf. `staffCommanderKey` name logic in rotation.ts, `web/src/domain/tow.ts`).
3. **Tests** (`web/src/state/towRoll.test.ts`): add fixtures from `TOW_Rolls.txt`. Each line is
   `assert rollTowSourceCorpsIds(cards, localDate)` (first 4, ordered) — dates: "July 2" blocks use
   month 7 day 2, "1ST OF JULY" blocks day 1; hour = the listed local hour (e.g. `23pm`→23, `14pm`→14,
   `12am`→0, `12pm`→12); any year. The July-2 20:55 batch (one window, 7 factions) is seed hour 20.
   At minimum, fixture one window per newly calibrated faction; the disambiguating windows
   (Osmanlı July 2 15:00 & 18:00; Preußen July 2 15:00) are the highest-value ones.
4. Keep `reports/`/docs updated per repo conventions; update `docs/AI_FILEMAP.md` if files are added.

## 5. Data caveats (important for tests)

- **Do not use these `TOW_Rolls.txt` lines as fixtures verbatim** — they contain verified
  transcription slips (the rolled *set* is right, the order/name is wrong):
  - 1811 Espagne, 23pm: 4th name is Joseph (not Massena).
  - 1812 Russia, 23pm: Baggovout ↔ Tchitchagov swapped.
  - 1812 Russia, 20pm: should read Bagration, Toutchkov, Baggovout-De Tolly, Tolstoi-Miloradovich.
  - 1812 Russia, 8am: Konstantin ↔ Tolstoi-Miloradovich swapped.
- Corps-id ↔ name mapping: parse the staff key (`gen_staff_<id>_<rank>_<num>`); "Bonaparte" labels
  the corps whose highest-rank staff is Napoléon (e.g. Prusse corps 105 also holds Lefebvre).
- Seeds use the **local** clock (os.date in Lua) — the roller must use local time, and predictions
  are annually periodic (seed ignores year).
- Equal-cost tie orders are engine constants: they can never be derived from data for future
  factions/mod updates — recalibrate from one or two observed windows if NTW3 changes staff costs
  or rosters (method in §2; one ordered window usually collapses all candidates).
