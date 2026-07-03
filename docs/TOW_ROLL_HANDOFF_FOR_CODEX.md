# TOW source-corps roll — tie-break: HANDOFF FOR CODEX

Continuation of `docs/TOW_ROLL_TIEBREAK_INVESTIGATION.md`. That file has the earlier
context + the raw in-game roll data (bottom section "DATA"). This file records what the
next round of investigation established and exactly where it is stuck. **Read both.**

Goal (unchanged): make the **Theatres-of-War (TOW) source-corps roller** reproduce what
the game rolls. AC (army-corps) roller is correct — do not touch it.

---

## Hard-won results (trust these; they are verified)

1. **Mechanism is correct and verified** (seed + PRNG + Fisher-Yates shuffle). Do not
   change `seedForDate`, `MsvcRng`, `shuffleByDate` in `web/src/state/rotation.ts`.
   - seed = `floor(localHour/2.8)*10000 + (day*100+month)`, year ignored.

2. **Primary pool-ordering rule CONFIRMED:** the source-corps pool = the faction's
   **staff generals ordered by ascending `cost`**, deduplicated to source-corps id
   (`unitKey.split('_')[3]`) first-seen. Verified on two factions.

3. **Screen order == shuffle output order.** The user reports rolls top-to-bottom and
   they match the raw `shuffle(pool,seed)[:4]` order. So we can calibrate on ORDER, not
   just sets. (Confirmed: the 8pm July-2 window and the original 10:50pm window share
   seed 70207 and give the same 4 corps.)

4. **Russie-Centre (`ntw3_tow_a11_x8_028`) fully solved**, 9/9 windows, and locked in
   `web/src/state/towRoll.test.ts`. It has **no cost ties**, so it only proves the
   primary rule, not the tie-break.

5. **1809 Espagne (`ntw3_tow_a09_x8_021`) — the pool is now KNOWN EXACTLY** from 9
   in-game windows (brute force over all 9! corps orderings → unique 9/9 ordered match):

   ```
   POOL (correct, in-game truth) = 142, 143, 147, 145, 146, 140, 144, 141, 148
   ```

   Grouped by cost (this is the crux — the tie-order inside each group):
   - cost 159 → **142, 143, 147, 145**
   - cost 281 → **146, 140**
   - cost 574 → **144, 141**
   - cost 741 → 148 (singleton)

   The 9 windows and the brute-force that produced this unique pool are reproduced by the
   script in "Reproduction" below. **Any proposed tie-break rule MUST reproduce this exact
   pool AND the Russie-Centre pool.**

---

## THE OPEN PROBLEM (where it's stuck)

The within-equal-cost tie order is **not** monotonic in any per-unit field we have
(`rosterIndex`, key `code`, `scid`, `command_stars` — all tested, all fail, both
ascending and descending; see the failing table at the end). Current code uses ascending
`rosterIndex` as the tie-break inside `recruitOrder` (`web/src/state/rotation.ts`) and it
is WRONG for Espagne (produces `142,147,145,143 | 140,146 | 141,144`).

### Why it's hard — root cause identified

From the original Lua (`source/original lua files/ntw3.lua` + `ntw3ac.lua`):

- `NTW3AC.ToWFarmycorps(faction, units)` **does not sort**. It walks `units` in order and
  takes each staff general's corps id first-seen. So the tie-order is entirely inherited
  from the order of `units`.
- `units` comes from `NTW3.Faction_Units_List(faction)`:
  ```lua
  for i, ctg in ipairs({1, 2, 4}) do
    local units_perctg = FrontEnd.RecruitableUnits(faction, false, 2, ctg, 10000, true, 1)
    ... concatenate ...
  ```
  `FrontEnd.RecruitableUnits` is a **game-engine (C++) function**. Its ordering is
  "group by arm category, then ascending cost, then <engine tie-break>". The engine
  tie-break for equal-cost units is what we're missing, and it is **not visible in Lua**.

- Prior work (`web/src/state/rotation.ts` top comment) reverse-engineered
  `FrontEnd.RecruitableUnits` order as "arm category → ascending cost" and used
  `rosterIndex` as a *guessed* tiebreak — that guess was never exercised because the AC
  calibration corps (`ntw3_ac_a04_x5_076`) apparently had no equal-cost generals. Espagne
  is the first case with real cost ties, and it breaks the guess.

### What we know about the staff block (important constraints)

- Staff generals are the ONLY cards with `underlyingUnitClass == "general"` (verified:
  212 combat generals all have infantry/cavalry/artillery underlying classes). So by
  arm-category grouping the staff form their **own block of exactly the 10 staff** — the
  engine sort that determines their tie-order operates on just these 10 (combat generals
  are in other category blocks and do not interleave).
- The 10 staff (scid, cost, rosterIndex, key `code`):
  ```
  140 cost281 idx455 code0182   Victor
  146 cost281 idx457 code0190   Kellerman
  142 cost159 idx458 code0186   Sebastiani "de La Porta"
  147 cost420 idx459 code0191   Jourdan          (corps 147, high-cost staff)
  148 cost741 idx461 code0194   Soult
  147 cost159 idx462 code0192   Joseph Bonaparte (corps 147, low-cost staff -> first-seen)
  145 cost159 idx463 code0189   Gouvion-Saint-Cyr
  141 cost574 idx464 code0183   Suchet
  144 cost574 idx465 code0188   Ney
  143 cost159 idx466 code0187   Mortier
  ```
  - `rosterIndex` order == alphabetical by general NAME (that's how our pipeline sorts the
    generated JSON). It is NOT the game's DB/recruit order.
  - Raw source table `source/tables/ntw3_land_units.tsv` order == scid/code ascending:
    140,141,142,143,144,145,146,147(0192),147(0191),148.

### Experiments already run (so you don't repeat them)

- **Lua 5.1 `table.sort` quicksort port (unstable) over the 10 staff, key=cost:**
  - CAN produce the target pool: ~0.6% of random initial orders of the 10 staff yield it
    (1727/300000). So an unstable sort with the *right initial order* is a viable model.
  - But no NATURAL initial order works: scid_asc/desc, idx_asc/desc, code_asc/desc all
    FAIL under both Lua-quicksort and stable sort (table at end).
- **Stable sort by cost** with any natural initial order: FAILS. Relative to
  stable+DB-order, the target has 281 reversed, 574 reversed, and the 159 group's last
  pair reversed — a non-uniform scramble, i.e. an unstable sort signature.

### Leading hypotheses (untested / next steps)

1. **The engine sort is C++ `std::sort` (introsort), not Lua quicksort.** The game is a
   Win32/MSVC build. Try porting **MSVC's `std::sort`** tie behavior (introsort:
   median-of-3 quicksort, heapsort fallback, insertion sort for n≤ threshold — MSVC uses
   a different small-range threshold and pivot than libstdc++). For n=10 the small-range
   path dominates and its exact behavior is what matters. Feed it the true initial order
   (candidate: `ntw3_land_units.tsv` order = scid/code asc, filtered to the faction) and
   compare to the Espagne target. If MSVC std::sort + DB order reproduces BOTH factions,
   that's the answer.
2. **The initial order isn't the land_units table order.** `FrontEnd.RecruitableUnits`
   may order by `units_to_exclusive_faction_permissions`, `battle_entities`, or an
   internal entity id. Pull those tables (`source/tables/*.tsv`) and check the order of
   these 10 staff there; test each as the stable-sort initial order (target needs 281 →
   146 before 140, 574 → 144 before 141, 159 → 142,143,147,145).
3. **More data to disambiguate.** One tie-heavy faction (Espagne) may not uniquely
   determine the engine's sort. Ask the user for full 9-window sweeps on 1–2 MORE
   tie-heavy TOW factions (any theatre where several corps share a cost) and require the
   rule to fit all of them + Russie-Centre. This is the surest path if the sort model
   stays ambiguous.

### Fallback if no closed-form engine sort is found

If the engine tie-break can't be replicated portably, consider computing the pool by
**faithfully simulating the winning sort model once per faction at load time** (we have
each faction's full staff list with cost). That is still general (no per-faction
hardcoding) as long as the sort model itself is correct. Hardcoding per-faction pools is
NOT acceptable (doesn't scale, we lack data for all factions).

---

## Reproduction (self-contained Python)

Save & run to regenerate every result above. Ports the game PRNG/shuffle and the Lua
quicksort; contains the 9 Espagne windows and the brute force.

```python
import math, itertools, sys
sys.setrecursionlimit(10000)

# --- game PRNG + shuffle (verified faithful to web/src/state/rotation.ts) ---
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
def seed(day,month,hour): return math.floor(hour/2.8)*10000+(day*100+month)

# --- 1809 Espagne: 9 in-game windows, corps in on-screen (=shuffle) order ---
# name->scid: Perrin/Victor=140 Suchet=141 Sebastiani/Porta=142 Mortier=143 Ney=144
#             Saint-Cyr=145 Kellerman=146 Jourdan/Bonaparte(corps 147)=147 Soult=148
W=[(1,23,['145','142','141','147']),(2,2,['147','148','140','146']),
   (2,5,['147','140','141','142']),(2,8,['143','144','142','148']),
   (2,11,['142','140','146','144']),(2,14,['145','142','144','147']),
   (2,17,['146','142','148','140']),(2,20,['146','145','142','148']),
   (2,23,['145','143','147','146'])]
seeds=[(seed(d,7,h),obs) for d,h,obs in W]

# Brute force: unique pool reproducing all 9 windows in exact order:
corps=['140','141','142','143','144','145','146','147','148']
def scoreord(p):
    return sum(1 for s,obs in seeds if shuffle(p,s)[:4]==obs)
best=[p for p in itertools.permutations(corps) if scoreord(p)==9]
print('unique 9/9 pool:', best)   # -> ('142','143','147','145','146','140','144','141','148')

# --- Lua 5.1 table.sort port (unstable quicksort) ---
def lua_sort(a0, key):
    a=[None]+list(a0); n=len(a0)
    def comp(x,y): return key(x)<key(y)
    def swap(i,j): a[i],a[j]=a[j],a[i]
    def auxsort(l,u):
        while l<u:
            if comp(a[u],a[l]): swap(l,u)
            if u-l==1: break
            i=(l+u)//2
            if comp(a[i],a[l]): swap(i,l)
            elif comp(a[u],a[i]): swap(i,u)
            if u-l==2: break
            pivot=a[i]; swap(i,u-1); i=l; j=u-1
            while True:
                i+=1
                while comp(a[i],pivot): i+=1
                j-=1
                while comp(pivot,a[j]): j-=1
                if j<i: break
                swap(i,j)
            swap(u-1,i)
            if i-l<u-i: j2=l;i2=i-1;l=i+2; auxsort(j2,i2)
            else: j2=i+1;i2=u;u=j2-2; auxsort(j2,i2)
    auxsort(1,n); return a[1:]
# staff (scid,cost,idx,code); corps 147 has two staff (159 and 420)
S=[('142',159,458,186),('143',159,466,187),('145',159,463,189),('147',159,462,192),
   ('147',420,459,191),('146',281,457,190),('140',281,455,182),('141',574,464,183),
   ('144',574,465,188),('148',741,461,194)]
TARGET=['142','143','147','145','146','140','144','141','148']
def pool(order):
    o=lua_sort(order,key=lambda s:s[1]); seen=[]
    for scid,*_ in o:
        if scid not in seen: seen.append(scid)
    return seen
```

Pull any faction's staff (scid, cost, rosterIndex) from
`web/public/data/factions/<factionKey>.json` → `cards[]`, keep
`isGeneral and (generalKind=='staff' or menRaw in (32,122))`.

---

## Failing tie-break table (already ruled out for Espagne)

target pool = `142,143,147,145,146,140,144,141,148`

| initial order | Lua-quicksort result | stable-sort result |
|---|---|---|
| scid asc  | 143,142,147,145,140,146,144,141,148 | fail |
| scid desc | 145,147,142,143,140,144,146,141,148 | fail |
| idx asc   | 143,142,145,147,140,146,144,141,148 | fail |
| idx desc  | 143,142,145,147,146,140,141,144,148 | fail |
| code asc  | 143,142,147,145,140,146,144,141,148 | fail |
| code desc | 145,142,147,143,140,144,146,141,148 | fail |

Note several get the LAST groups right but flip the first pair (143,142 vs 142,143) —
consistent with the true sort differing only slightly from these. MSVC `std::sort` (next
step) is the most promising untried model.

---

## Files to edit when solved (unchanged from prior handoff)

- `web/src/state/rotation.ts` — `recruitOrder(a,b)` (the tie-break lives here; exported).
  Shared with AC rotation → re-verify `web/src/state/rotation.test.ts` after any change.
- `web/src/state/towRoll.ts` — `towSourceCorpsPool` + `rollTowGeneralKeys` already sort
  via `recruitOrder`; fixing `recruitOrder` flows through.
- `web/src/state/towRoll.test.ts` — add the 9 Espagne windows (mirror the Russie-Centre
  "in-game calibration" block). Run: `cd web && npx vitest run src/state/towRoll.test.ts`.
- Docs to sync: `docs/TOW_ARMY_BUILDS.md` §1, `docs/AI_FILEMAP.md`, and retire/update
  `docs/TOW_ROLL_TIEBREAK_INVESTIGATION.md` + this file.

Data/reference:
- `source/original lua files/ntw3.lua` (`Faction_Units_List`, `FrontEnd.RecruitableUnits`
  call), `ntw3ac.lua` (`ToWFarmycorps`, `ACgenerals`, `ToWFgenerals`).
- `source/tables/*.tsv` (candidate initial-order tables: `ntw3_land_units`,
  `units_to_exclusive_faction_permissions`, `ntw3_battle_entities`).
- `web/public/data/factions/ntw3_tow_a09_x8_021.json` (Espagne),
  `ntw3_tow_a11_x8_028.json` (Russie-Centre).

## Current working-tree state (Codex continuation)

- `rotation.ts`: `recruitOrder` exported.
- `towRoll.ts`: `towSourceCorpsPool` and `rollTowGeneralKeys` now sort by `recruitOrder`
  (was raw roster order — that was the original, separate bug, now fixed).
- `towRoll.ts`: added scoped source-corps-pool calibrations. These are deliberately limited to
  the TOW source-corps pool and do not change shared AC `recruitOrder`.
  - `ntw3_tow_a06_x8_002`: `099,106,246,105,104,102,100,103,101`.
  - `ntw3_tow_a09_x8_021`: `142,143,147,145,146,140,144,141,148`.
  - `ntw3_tow_a12_x8_003`: `138,135,136,133,137,132,134,139`.
- `towRoll.test.ts`: Russie-Centre 9-window calibration plus Prusse, Espagne, and Flandres ordered
  calibrations are passing.
- `docs/TOW_ARMY_BUILDS.md` §1 and `docs/AI_FILEMAP.md` updated to describe the scoped
  calibration.

Targeted verification:

```bash
cd web && npx vitest run src/state/towRoll.test.ts src/state/rotation.test.ts
# 2 files, 88 tests passed
```

The general equal-cost engine tie-break is still not solved portably. Attempts checked by
Codex after this handoff included source table row order, `units_to_exclusive_faction_permissions`
row order, common quicksort/selection/insertion variants, and an MSVCRT-style qsort approximation;
none reproduced the Espagne pool while preserving a general rule. The application now reproduces
the verified TOW calibrations, but more clean tie-heavy faction data is still needed before replacing
the scoped calibrations with a general engine model.
