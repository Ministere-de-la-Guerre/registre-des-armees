# TOW source-corps roll — tie-break investigation (HANDOFF)

Status as of 2026-07-02. Read this before continuing the TOW roller work. Purpose:
tune the **Theatres-of-War (TOW) source-corps roller** so it matches what the game
actually rolls. The AC (army-corps) roller is already correct — do **not** touch it.

---

## TL;DR

- The TOW roller shuffles a **pool of source corps** with a clock-seeded PRNG, then
  takes the first 4. The seed + shuffle math are **correct and verified**. The only
  thing that was ever wrong is the **order of the pool fed into the shuffle**.
- **Primary ordering rule is CONFIRMED:** build the pool by sorting the faction's
  **staff generals by ascending cost**, then take each source-corps id first-seen.
  (Ties in cost broken by a secondary key — see below.)
- **Fixed & verified:** `[1812] 11. France (Russie-Centre)` (`ntw3_tow_a11_x8_028`),
  9/9 in-game windows reproduced exactly, in order. That faction has **no cost ties**,
  so it only proved the *primary* rule.
- **OPEN / UNRESOLVED:** `[1809] 10. France (Espagne)` (`ntw3_tow_a09_x8_021`) has
  **many cost ties** (4 corps @159, 2 @281, 2 @574). One in-game window shows the
  current **tie-break is wrong**. One window is not enough to determine the true
  tie-break — **need more in-game rolls for this faction** (see "What to collect").

---

## The mechanism (verified, do not change)

All in `web/src/state/rotation.ts`:

- **Seed:** `seedForDate(d)` = `floor(localHour / 2.8) * 10000 + (day*100 + month)`.
  Year is ignored. Windows are ~3h; each 3-hour clock sample lands in a distinct bucket.
- **PRNG:** Windows CRT `rand()/srand()` LCG (`state = state*214013 + 2531011`, return
  bits 30..16, `RAND_MAX = 32767`). `MsvcRng` class.
- **Shuffle:** `shuffleByDate` — reseed, **5 warm-up draws**, then Fisher-Yates over
  Lua 1-indexed positions. Output order is meaningful (first 4 are kept).

## The ordering rule (the actual subject of this work)

The game builds the source-corps pool by walking `FrontEnd.RecruitableUnits` (NOT raw
roster order), collecting the 4th `_`-component of each **staff general**'s key
(`ntw3_gen_staff_<SCID>_<n>_<code>_tow_<army>` → `<SCID>`), de-duplicated first-seen.

`FrontEnd.RecruitableUnits` order = **arm category → ascending cost → <tie-break>**.
For staff generals arm category is always `general`, so in practice it is:

- **ascending `cost`**  ← CONFIRMED (both factions)
- then a **tie-break among equal-cost corps**  ← UNKNOWN. Current code uses ascending
  `rosterIndex`; the Espagne data proves that is wrong.

`recruitOrder` in `rotation.ts` implements `(armCategory, cost, rosterIndex)`. The
`rosterIndex` leg is the suspect. Note: `rotation.ts` claims `recruitOrder` was
"verified against 7 in-game AC windows", but that AC corps likely had distinct costs
too, so its tie-break was probably never exercised either. Treat the tie-break as
**unproven across the whole app**, not just TOW.

---

## Data on hand

### Russie-Centre `ntw3_tow_a11_x8_028` — SOLVED (9/9)

Pool (correct, recruit order): `124, 130, 131, 120, 121, 119, 117`
Corps→commander: 120 Eugène · 130 Guard/Bonaparte · 124 Junot · 131 Murat ·
121 Poniatowski · 117 Davout · 119 Ney.
All 9 windows are locked in `web/src/state/towRoll.test.ts` (describe "Russie-Centre
in-game calibration"). Costs are all distinct (1,55,145,255,381,522,674) → no tie-break
tested here.

### 1809 Espagne `ntw3_tow_a09_x8_021` — BUG (tie-break unresolved)

Staff generals (scid, cost, rosterIndex, command_stars, key):

```
scid=140 cost=281 idx=455 stars=3 ntw3_gen_staff_140_3_0182_tow_021  Victor (Claude-Victor Perrin)
scid=146 cost=281 idx=457 stars=3 ntw3_gen_staff_146_3_0190_tow_021  Kellerman(n)
scid=142 cost=159 idx=458 stars=2 ntw3_gen_staff_142_2_0186_tow_021  Sébastiani "de La Porta"
scid=147 cost=420 idx=459 stars=4 ntw3_gen_staff_147_4_0191_tow_021  Jourdan
scid=148 cost=741 idx=461 stars=6 ntw3_gen_staff_148_6_0194_tow_021  Soult
scid=147 cost=159 idx=462 stars=2 ntw3_gen_staff_147_2_0192_tow_021  Joseph Bonaparte
scid=145 cost=159 idx=463 stars=2 ntw3_gen_staff_145_2_0189_tow_021  Gouvion-Saint-Cyr
scid=141 cost=574 idx=464 stars=5 ntw3_gen_staff_141_5_0183_tow_021  Suchet
scid=144 cost=574 idx=465 stars=5 ntw3_gen_staff_144_5_0188_tow_021  Ney
scid=143 cost=159 idx=466 stars=2 ntw3_gen_staff_143_2_0187_tow_021  Mortier
```

Distinct corps (9): 140,141,142,143,144,145,146,147,148.
Cost groups (first-seen entry cost): **{142,147,145,143}@159**, **{140,146}@281**,
147 again @420 (already seen), **{141,144}@574**, **148@741**.

Note: `cost` and `command_stars` are perfectly correlated in both factions
(159→2, 281→3, 420→4, 574→5, 741→6), so "ascending cost" and "ascending stars" are
indistinguishable so far.

**In-game truth (the only Espagne window we have):**
- **July 2nd, 10:50 pm** (hour 22 → seed `70207`): roll should be
  **Porta (142), Saint-Cyr (145), Kellerman (146), Soult (148)** — user gave these as
  the on-screen names; treat as a **set** (screen order may be sorted, unknown).

**Current app output at that window (with rosterIndex tie-break):**
`140, 143, 142, 148` = Victor, Mortier, Porta, Soult — WRONG (2 of 4 correct).

**Brute-force result for that window:** the expected set is reproducible with the same
seed+shuffle; every pool ordering that reproduces it has the **281 group as `[146,140]`
(Kellerman before Victor)** — i.e. the tie-break must NOT be ascending rosterIndex
(140 idx455 < 146 idx457), nor ascending scid/stars/key-code (all rank 140 first).
Descending rosterIndex fits the 281 pair but FAILS the 159 group, so the rule is
**not a single monotonic direction on rosterIndex** either. One window can't pin it —
8 candidate pools survive.

---

## What to collect (to finish this)

For the **1809 Espagne** faction (`ntw3_tow_a09_x8_021`), record several more in-game
rolls. For each: **date, time, and all 4 corps in the exact top-to-bottom on-screen
order.** Aim for **~6 windows at clearly different clock hours** (so the hour-bucket
`floor(hour/2.8)` differs — e.g. ~1am, 4am, 7am, 10am, 1pm, 4pm, 7pm span buckets 0–6).
Different days are fine and add signal (day changes the `ddmm` part of the seed).

More tie-heavy factions (any TOW theatre where several corps share a cost) would also
help confirm the rule generalizes.

## How to use the new data (next session)

1. Reproduce with the Python harness below (faithful port of `rotation.ts`).
2. The pool is `[perm of the 159-group] + [perm of 281-group] + [perm of 574-group] + [148]`.
   Brute-force the intra-group permutations against ALL collected windows (require a
   pool that reproduces **every** window). With ~6 windows this should collapse to one
   pool order.
3. From that pool order, infer the tie-break rule (candidates to test: raw game/db
   order, `command_stars`, the 4-digit key `<code>`, the `<n>` field, MSVC non-stable
   qsort behavior, etc.). **The rule must also reproduce Russie-Centre's 9 windows.**
4. Implement the tie-break in `recruitOrder` (see files below), extend the calibration
   test with the Espagne windows, and re-run the suite.

### Reproduction harness (Python, self-contained)

```python
import math, itertools
class Rng:
    def __init__(s,seed): s.s=seed&0xffffffff
    def rand(s): s.s=(s.s*214013+2531011)&0xffffffff; return (s.s>>16)&0x7fff
    def range(s,l,u): return math.floor((s.rand()%32767)/32767*(u-l+1))+l
def shuffle(a,seed):
    o=list(a); r=Rng(seed)
    for _ in range(5): r.range(1,100)
    for i in range(len(o),1,-1):
        j=r.range(1,i); o[i-1],o[j-1]=o[j-1],o[i-1]
    return o
def seed(day,month,hour): return math.floor(hour/2.8)*10000 + (day*100+month)
# roll4 = shuffle(pool, seed(d,m,h))[:4]
```

To pull a faction's staff generals + costs from generated data:
`web/public/data/factions/<factionKey>.json` → `cards[]`, keep
`isGeneral and (generalKind=='staff' or menRaw in (32,122))`; scid = `unitKey.split('_')[3]`.

---

## Exact files the AI should look at / edit

Edit (ordering logic + parity):
- **`web/src/state/rotation.ts`** — `recruitOrder(a,b)` (the tie-break lives here; it is
  `exported`), plus `seedForDate`, `shuffleByDate`, `MsvcRng` (verified — reference only).
- **`web/src/state/towRoll.ts`** — `towSourceCorpsPool` (sorts staff via `recruitOrder`
  before dedup) and `rollTowGeneralKeys` (sorts `staffPool`/`combatPool` via
  `recruitOrder` before shuffling). These already import and apply `recruitOrder`; fixing
  the tie-break in `recruitOrder` flows through automatically.

Tests (add the new Espagne windows here, mirror the Russie-Centre block):
- **`web/src/state/towRoll.test.ts`** — describe "Russie-Centre in-game calibration"
  is the template. Run: `cd web && npx vitest run src/state/towRoll.test.ts`.
- **`web/src/state/rotation.test.ts`** — existing AC rotation calibration; make sure a
  tie-break change doesn't regress it.

Docs to keep in sync:
- **`docs/TOW_ARMY_BUILDS.md`** §1 (pool ordering description).
- **`docs/AI_FILEMAP.md`** — `web/src/state/towRoll.ts` / `rotation.ts` entries.
- **This file** — update/retire once the tie-break is solved.

Data sources (read-only, to derive pools):
- **`web/public/data/factions/<factionKey>.json`** — browser-ready roster (has `cost`,
  `rosterIndex`, `commandStars`, `generalKind`, `menRaw`, `unitKey`). Generated — do not
  hand-edit.
- Upstream if the data itself is wrong: `data/generated/ntw3_army_builder_units.csv`
  → regenerated by `tools/build_ntw3_army_builder_database.py` → `tools/build_web_data.py`.

Do **not** touch: the AC army-corps roller / `findRotation` combat-general path is
correct per the user. Only the tie-break inside `recruitOrder` and the TOW pool builders
are in scope. Note `recruitOrder` is shared by AC rotation, so any change must be
re-verified against `rotation.test.ts`.

## Current code state (already committed to working tree, not yet released)

- `rotation.ts`: `recruitOrder` was made `export`.
- `towRoll.ts`: `towSourceCorpsPool` now sorts staff by `recruitOrder`; `rollTowGeneralKeys`
  now sorts its pools by `recruitOrder`. (Was raw roster order — that was the original bug.)
- `towRoll.test.ts`: added Russie-Centre 9-window calibration (passing).
- `docs/TOW_ARMY_BUILDS.md` §1: updated to "recruit order".
These fixes are correct for the **primary** rule; the **tie-break** is still `rosterIndex`
and is known-wrong for Espagne. That's the remaining task.


DATA
July 1
11pm - Saint Cyr, Sebastiani, Suchet, Jourdan/Bonaparte

July 2
2am - Jourdan/Bonaparte, Soult, Perrin, Kellermann
5am - Jourdan/Bonaparte, Perrin, Suchet, Sebastiani
8am - Mortier, Ney, Sebastiani, Soult
11am - Sebastiani, Perrin, Kellermann, Ney
2pm - Saint-Cyr, Sebatiani, Ney, Jourdan/Bonaparte
5pm - Kellermann, Sebastiani, Soult, Perrin
8pm - Kellermann, Saint-Cyr, Sebastiani, Soult
11pm - Saint-Cyr, Mortier, Jourdan/Bonaparte, Kellermann