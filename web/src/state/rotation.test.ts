import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeUnit } from "../test/factories";
import {
  WINDOW_START_HOURS,
  combatPool,
  findRotation,
  findRotationCover,
  nextWindowStart,
  offeredCombatKeys,
  offeredStaffKeys,
  prevWindowStart,
  seedForDate,
  shuffleByDate,
  staffCommanderKey,
  staffPool,
  windowStart,
  windowStartHour,
} from "./rotation";

// A synthetic combat-general pool in roster order for faction "_x5_" → combat
// cap = 9-5 = 4, offered = 4 + 2 = 6 per window.
const FACTION = "ntw3_ac_test_x5_001";
function pool(n: number) {
  return Array.from({ length: n }, (_, i) =>
    makeUnit({ unitKey: `g${i}`, isGeneral: true, generalKind: "combat", menRaw: 160, rosterIndex: i }),
  );
}

describe("MSVC PRNG fidelity", () => {
  it("reproduces the canonical Windows rand() sequence for srand(1)", () => {
    // Documented MSVC vector: srand(1) → 41, 18467, 6334, 26500, 19169. Re-deriving
    // the LCG inline keeps the test independent of the module's private class.
    let state = 1 >>> 0;
    const rand = () => {
      state = (Math.imul(state, 214013) + 2531011) >>> 0;
      return (state >>> 16) & 0x7fff;
    };
    expect([rand(), rand(), rand(), rand(), rand()]).toEqual([41, 18467, 6334, 26500, 19169]);
  });
});

describe("window buckets", () => {
  it("starts windows at the /2.8 boundaries", () => {
    expect([...WINDOW_START_HOURS]).toEqual([0, 3, 6, 9, 12, 14, 17, 20, 23]);
  });
  it("maps clock hours to their window start", () => {
    expect(windowStartHour(0)).toBe(0);
    expect(windowStartHour(2)).toBe(0);
    expect(windowStartHour(13)).toBe(12);
    expect(windowStartHour(14)).toBe(14); // 14/2.8 === 5.0 → new bucket
    expect(windowStartHour(23)).toBe(23);
  });
});

describe("seed", () => {
  it("ignores the year (annually periodic)", () => {
    const a = seedForDate(new Date(2026, 5, 23, 14, 30)); // 23 Jun 2026, bucket 5
    const b = seedForDate(new Date(2031, 5, 23, 16, 5)); // 23 Jun 2031, hour 16 → bucket 5
    expect(a).toBe(b);
  });
  it("changes across hour buckets on the same day", () => {
    const a = seedForDate(new Date(2026, 5, 23, 13)); // bucket 4
    const b = seedForDate(new Date(2026, 5, 23, 14)); // bucket 5
    expect(a).not.toBe(b);
  });
});

describe("offeredCombatKeys", () => {
  const p = pool(20);
  it("offers exactly min(cap+2, poolSize) combat generals", () => {
    expect(offeredCombatKeys(FACTION, p, new Date(2026, 5, 23, 14)).length).toBe(6);
    expect(offeredCombatKeys(FACTION, pool(4), new Date(2026, 5, 23, 14)).length).toBe(4);
  });
  it("is deterministic for the same window", () => {
    const a = offeredCombatKeys(FACTION, p, new Date(2026, 5, 23, 12, 1));
    const b = offeredCombatKeys(FACTION, p, new Date(2026, 5, 23, 13, 59)); // same bucket 4
    expect(a).toEqual(b);
  });
  it("is stable across years for the same calendar window (periodicity)", () => {
    const a = offeredCombatKeys(FACTION, p, new Date(2026, 5, 23, 14));
    const b = offeredCombatKeys(FACTION, p, new Date(2040, 5, 23, 15)); // same day/month, bucket 5
    expect(a).toEqual(b);
  });
  it("generally offers a different set in an adjacent window", () => {
    const a = offeredCombatKeys(FACTION, p, new Date(2026, 5, 23, 13)).join();
    const b = offeredCombatKeys(FACTION, p, new Date(2026, 5, 23, 14)).join();
    expect(a).not.toBe(b);
  });
});

describe("findRotation", () => {
  const p = pool(20);

  it("reports activeNow consistently with the current window's offer", () => {
    const now = new Date(2026, 5, 23, 14, 20);
    const offered = offeredCombatKeys(FACTION, p, now);
    const r = findRotation(p, 6,offered[0], now);
    expect(r.activeNow).toBe(true);
    expect(r.closestDirection).toBe("now");
    expect(r.closest).not.toBeNull();
  });

  it("finds a nearest past and future window for a general not offered now", () => {
    const now = new Date(2026, 5, 23, 14, 20);
    const offered = new Set(offeredCombatKeys(FACTION, p, now));
    const absent = p.map((c) => c.unitKey).find((k) => !offered.has(k))!;
    const r = findRotation(p, 6,absent, now);
    expect(r.activeNow).toBe(false);
    // With 6 of 20 offered each window, every general recurs within the year.
    expect(r.next).not.toBeNull();
    expect(r.prev).not.toBeNull();
    expect(r.closest).not.toBeNull();
    expect(r.next!.getTime()).toBeGreaterThan(now.getTime());
    expect(r.prev!.getTime()).toBeLessThan(now.getTime());
    // The offered set at the predicted windows really contains the general.
    expect(offeredCombatKeys(FACTION, p, r.next!)).toContain(absent);
    expect(offeredCombatKeys(FACTION, p, r.prev!)).toContain(absent);
  });

  it("returns nulls for a general that is not in the pool", () => {
    const r = findRotation(p, 6,"not-a-real-key", new Date(2026, 5, 23, 14));
    expect(r.next).toBeNull();
    expect(r.prev).toBeNull();
    expect(r.closest).toBeNull();
  });

  it("picks the closer of past/future as `closest`", () => {
    const now = new Date(2026, 5, 23, 14, 20);
    const offered = new Set(offeredCombatKeys(FACTION, p, now));
    const absent = p.map((c) => c.unitKey).find((k) => !offered.has(k))!;
    const r = findRotation(p, 6,absent, now);
    if (r.next && r.prev) {
      const toNext = r.next.getTime() - now.getTime();
      const fromPrev = now.getTime() - r.prev.getTime();
      const expected = toNext <= fromPrev ? r.next : r.prev;
      expect(r.closest!.getTime()).toBe(expected.getTime());
    }
  });
});

describe("findRotationCover", () => {
  const p = pool(20);
  const offeredAt = (d: Date) => offeredCombatKeys(FACTION, p, d);

  it("returns nothing for no targets", () => {
    const r = findRotationCover(offeredAt, [], new Date(2026, 5, 23, 10));
    expect(r.groups).toEqual([]);
    expect(r.unreachable).toEqual([]);
  });

  it("covers generals offered together in a single window", () => {
    const now = new Date(2026, 5, 23, 14, 20);
    const here = offeredCombatKeys(FACTION, p, now); // 6 generals offered right now
    const r = findRotationCover(offeredAt, here, now);
    expect(r.groups.length).toBe(1); // one window covers them all
    expect(r.groups[0].direction).toBe("now");
    expect(new Set(r.groups[0].keys)).toEqual(new Set(here));
    expect(r.unreachable).toEqual([]);
  });

  it("splits into the fewest windows when they can't share one, listing each general once", () => {
    const now = new Date(2026, 5, 23, 10, 0);
    // 7 targets can never fit one window (cap 6), so at least two windows are needed.
    const targets = p.slice(0, 7).map((c) => c.unitKey);
    const r = findRotationCover(offeredAt, targets, now);
    expect(r.unreachable).toEqual([]);
    expect(r.groups.length).toBeGreaterThanOrEqual(2);
    // No single window offers all seven, confirming ≥2 is genuinely required.
    const covered = r.groups.flatMap((g) => g.keys);
    expect(new Set(covered)).toEqual(new Set(targets)); // union covers all…
    expect(covered.length).toBe(targets.length); // …and each general appears exactly once
    // Every group's window really offers the generals attributed to it.
    for (const g of r.groups) {
      const here = new Set(offeredCombatKeys(FACTION, p, g.window));
      for (const key of g.keys) expect(here.has(key)).toBe(true);
    }
  });

  it("reports generals that never appear as unreachable", () => {
    const now = new Date(2026, 5, 23, 10, 0);
    const r = findRotationCover(offeredAt, ["not-a-real-key"], now);
    expect(r.groups).toEqual([]);
    expect(r.unreachable).toEqual(["not-a-real-key"]);
  });

  it("breaks count ties toward the tightest cluster, then nearest to now", () => {
    // now is 10:00, inside the 09:00 window. A and B never co-occur; each is offered
    // twice a day. The two-window covers of {A,B} with the tightest 3h spread are the
    // 03:00+06:00 (past) and 17:00+20:00 (future) pairs; the morning pair sits nearer
    // to 10:00, so it must win. Schedule is year-independent (the rotation is), so the
    // finder's per-seed memo stays valid.
    const now = new Date(2026, 5, 23, 10, 0);
    const sched = (d: Date): string[] => {
      if (d.getMonth() !== 5 || d.getDate() !== 23) return [];
      const h = d.getHours();
      if (h === 3 || h === 17) return ["B"];
      if (h === 6 || h === 20) return ["A"];
      return [];
    };
    const r = findRotationCover(sched, ["A", "B"], now);
    expect(r.groups.length).toBe(2);
    expect(r.groups.map((g) => g.window.getHours())).toEqual([3, 6]);
    expect(r.groups.map((g) => g.keys)).toEqual([["B"], ["A"]]);
    expect(r.groups.every((g) => g.direction === "past")).toBe(true);
  });
});

describe("shuffleByDate", () => {
  it("does not mutate its input and permutes deterministically", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    const copy = [...arr];
    const d = new Date(2026, 5, 23, 14);
    const a = shuffleByDate(arr, d);
    const b = shuffleByDate(arr, d);
    expect(arr).toEqual(copy); // unmutated
    expect(a).toEqual(b); // deterministic
    expect([...a].sort()).toEqual([...copy].sort()); // a permutation
  });
});

describe("combatPool ordering", () => {
  it("orders by arm category (artillery→cavalry→infantry) then ascending cost", () => {
    const g = (key: string, cls: string, cost: number, ri: number) =>
      makeUnit({ unitKey: key, isGeneral: true, generalKind: "combat", underlyingUnitClass: cls, cost, rosterIndex: ri });
    const cards = [
      g("inf_cheap", "infantry_line", 200, 9),
      g("cav_dear", "cavalry_light", 800, 0),
      g("art", "artillery_foot", 1232, 7),
      g("inf_dear", "infantry_grena", 900, 1),
      g("cav_cheap", "cavalry_heavy", 300, 4),
      makeUnit({ unitKey: "staff", isGeneral: true, generalKind: "staff", menRaw: 32, rosterIndex: 3 }),
      makeUnit({ unitKey: "plain", isGeneral: false, rosterIndex: 2 }),
    ];
    expect(combatPool(cards).map((c) => c.unitKey)).toEqual([
      "art", // artillery first
      "cav_cheap", // cavalry by cost
      "cav_dear",
      "inf_cheap", // infantry by cost
      "inf_dear",
    ]);
  });

  it("breaks same-category, same-cost ties by rosterIndex", () => {
    const g = (key: string, ri: number) =>
      makeUnit({ unitKey: key, isGeneral: true, generalKind: "combat", underlyingUnitClass: "infantry_line", cost: 500, rosterIndex: ri });
    expect(combatPool([g("b", 5), g("a", 1)]).map((c) => c.unitKey)).toEqual(["a", "b"]);
  });
});

// Calibration lock: 7 real in-game windows recorded for corps "10. Bonaparte /
// Alexandrie" (ntw3_ac_a04_x5_076) on 2026-06-23/24. The faction's combat-general
// pool is reproduced here by (category, cost); the predictor must offer exactly
// the six generals observed in each window. This pins the whole engine end-to-end.
describe("in-game calibration — corps a04_x5_076", () => {
  const FAC = "ntw3_ac_a04_x5_076"; // combat offered = 9 - 5 + 2 = 6
  // [label, category, cost] as read from the live roster.
  const ROSTER: [string, string, number][] = [
    ["Andreossy", "artillery", 1232],
    ["Boussart", "cavalry", 398],
    ["Murat", "cavalry", 519],
    ["Corbineau", "cavalry", 718],
    ["Ravier", "infantry", 217],
    ["Boyer", "infantry", 230],
    ["Abbe", "infantry", 313],
    ["Schramm", "infantry", 343],
    ["SaintAulaire", "infantry", 365],
    ["Bon", "infantry", 450],
    ["Dugua", "infantry", 503],
    ["Cassagne", "infantry", 687],
    ["Darricau", "infantry", 733],
    ["Darmagnac", "infantry", 756],
    ["Rampon", "infantry", 798],
    ["Kleber", "infantry", 1040],
  ];
  const roster = ROSTER.map(([label, cat, cost], i) =>
    makeUnit({ unitKey: label, isGeneral: true, generalKind: "combat", underlyingUnitClass: `${cat}_x`, cost, rosterIndex: i }),
  );
  const pool = combatPool(roster);

  // [year, monthIndex, day, hour, expected six] — hour picks the right bucket.
  const WINDOWS: [number, number, number, number, string[]][] = [
    [2026, 5, 23, 7, ["Kleber", "Dugua", "Schramm", "Boussart", "Corbineau", "Andreossy"]],
    [2026, 5, 23, 13, ["Darmagnac", "Kleber", "Cassagne", "SaintAulaire", "Boyer", "Abbe"]],
    [2026, 5, 23, 15, ["Darmagnac", "Rampon", "Bon", "SaintAulaire", "Boyer", "Corbineau"]],
    [2026, 5, 23, 18, ["Murat", "Kleber", "Schramm", "SaintAulaire", "Boussart", "Andreossy"]],
    [2026, 5, 23, 21, ["Darmagnac", "Murat", "Schramm", "Rampon", "Boyer", "Ravier"]],
    [2026, 5, 24, 1, ["Murat", "Kleber", "Rampon", "Darricau", "Ravier", "Boussart"]],
    [2026, 5, 24, 4, ["Darmagnac", "Murat", "Kleber", "Rampon", "Darricau", "Abbe"]],
  ];

  it.each(WINDOWS)("offers the observed six at %i-%i-%i %i:00", (y, mo, da, ho, expected) => {
    const got = offeredCombatKeys(FAC, pool, new Date(y, mo, da, ho));
    expect(new Set(got)).toEqual(new Set(expected));
  });
});

// Staff calibration lock: 7 real in-game windows for the Garde impériale staff
// pool (ntw3_ac_a11_x5_130) on 2026-06-23. Staff is offered as the permanent
// commander (Napoléon, highest cost — always available) plus one rotating pick,
// so windows show 1 or 2 generals.
describe("in-game staff calibration — Garde impériale a11_x5_130", () => {
  const STAFF: [string, number][] = [
    ["Lefebvre", 83],
    ["Bessieres", 217],
    ["Mortier", 382],
    ["Napoleon", 1007],
  ];
  const pool = staffPool(
    STAFF.map(([label, cost], i) =>
      makeUnit({ unitKey: label, isGeneral: true, generalKind: "staff", menRaw: 32, underlyingUnitClass: "general", cost, rosterIndex: i }),
    ),
  );

  const WINDOWS: [number, string[]][] = [
    [1, ["Napoleon"]], // 12am  bucket 0
    [4, ["Napoleon", "Mortier"]], // 3am  bucket 1
    [7, ["Napoleon"]], // 6am  bucket 2
    [10, ["Napoleon", "Lefebvre"]], // 9am  bucket 3
    [18, ["Napoleon", "Lefebvre"]], // 6pm  bucket 6
    [21, ["Napoleon", "Mortier"]], // 9pm  bucket 7
    [23, ["Napoleon"]], // 11pm bucket 8
  ];

  it.each(WINDOWS)("offers the observed staff at June 23 %i:00", (ho, expected) => {
    // "Garde impériale" has no namesake staff → commander falls back to highest cost (Napoleon).
    const got = offeredStaffKeys(pool, "7. Garde impériale", new Date(2026, 5, 23, ho));
    expect(new Set(got)).toEqual(new Set(expected));
  });
});

describe("staffCommanderKey", () => {
  const named = (key: string, name: string, cost: number, ri: number) =>
    makeUnit({ unitKey: key, name, isGeneral: true, generalKind: "staff", menRaw: 32, underlyingUnitClass: "general", cost, rosterIndex: ri });

  it("picks the corps namesake even when it is the cheaper staff", () => {
    // Dokhtourov / VI.K: Dokhtourov (329) is the fixed commander; Koutouzov (867) rolls.
    const pool = staffPool([
      named("dokhtourov", "Dmitri Dokhtourov", 329, 53),
      named("koutouzov", "Mikhail Koutouzov", 867, 54),
    ]);
    expect(staffCommanderKey(pool, "9. Dokhtourov / VI.K")).toBe("dokhtourov");
  });

  it("matches multi-word namesakes (Osterman-Tolstoi)", () => {
    const pool = staffPool([
      named("tolstoi", "Aleksandr Osterman-Tolstoi", 423, 45),
      named("miloradovitch", "Mikhail Miloradovitch", 864, 46),
    ]);
    expect(staffCommanderKey(pool, "7. Osterman-Tolstoi / IV.K")).toBe("tolstoi");
  });

  it("falls back to highest-cost staff when the title names a formation", () => {
    const pool = staffPool([
      named("lefebvre", "François Lefebvre", 83, 68),
      named("napoleon", "Napoléon Bonaparte", 1007, 70),
    ]);
    expect(staffCommanderKey(pool, "7. Garde impériale")).toBe("napoleon");
  });
});

// DST: window arithmetic must stay monotonic and gap-free when a window's start
// hour is skipped (spring forward) or repeated (fall back). Each case switches the
// process time zone (Node re-reads process.env.TZ on assignment; vitest runs each
// file in its own forked process) and checks that the switch really took effect,
// so these can't pass vacuously under a zone without the transitions.
describe("window arithmetic across DST transitions", () => {
  const ZONES: [string, [number, number, number], [number, number, number]][] = [
    // [zone, spring-forward day, fall-back day] in 2026 (local calendar)
    ["Europe/Athens", [2026, 2, 29], [2026, 9, 25]], // 03:00→04:00, 04:00→03:00
    ["America/Santiago", [2026, 8, 6], [2026, 3, 4]], // 00:00→01:00, Sat 24:00→23:00
    ["Atlantic/Azores", [2026, 2, 29], [2026, 9, 25]], // 00:00→01:00, 01:00→00:00
  ];
  let savedTz: string | undefined;
  beforeEach(() => {
    savedTz = process.env.TZ;
  });
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });
  const useZone = (tz: string, [y, m, d]: [number, number, number]) => {
    process.env.TZ = tz;
    // Precondition: the spring-forward day really is 23 h long in this zone.
    const len = new Date(y, m, d + 1).getTime() - new Date(y, m, d).getTime();
    expect(len, `TZ=${tz} not applied`).toBe(23 * 3_600_000);
  };

  it.each(ZONES)("%s: a year of window starts is strictly monotonic and self-consistent", (tz, spring) => {
    useZone(tz, spring);
    const end = new Date(2027, 0, 1).getTime();
    let ws = windowStart(new Date(2026, 0, 1, 0, 30));
    let count = 0;
    while (ws.getTime() < end) {
      const nx = nextWindowStart(ws);
      expect(nx.getTime()).toBeGreaterThan(ws.getTime());
      expect(prevWindowStart(nx).getTime()).toBe(ws.getTime());
      expect(windowStart(ws).getTime()).toBe(ws.getTime());
      expect(seedForDate(nx)).not.toBe(seedForDate(ws));
      ws = nx;
      count++;
    }
    expect(count).toBe(9 * 365); // no window lost or duplicated
  });

  it.each(ZONES)("%s: every instant around both transitions lies in its window", (tz, spring, fall) => {
    useZone(tz, spring);
    for (const [y, m, d] of [spring, fall]) {
      const from = new Date(y, m, d - 1, 12).getTime();
      const to = new Date(y, m, d + 1, 12).getTime();
      for (let t = from; t < to; t += 5 * 60_000) {
        const at = new Date(t);
        const ws = windowStart(at);
        expect(ws.getTime()).toBeLessThanOrEqual(t);
        expect(nextWindowStart(ws).getTime()).toBeGreaterThan(t);
        expect(prevWindowStart(ws).getTime()).toBeLessThan(ws.getTime());
        expect(seedForDate(ws)).toBe(seedForDate(at)); // same game roll as the clock reads
      }
    }
  });

  it("Europe/Athens: the skipped-03:00 window opens at 04:00 and ends at 06:00", () => {
    useZone("Europe/Athens", [2026, 2, 29]);
    const ws = windowStart(new Date(2026, 2, 29, 4, 30));
    expect([ws.getDate(), ws.getHours(), ws.getMinutes()]).toEqual([29, 4, 0]);
    expect(prevWindowStart(ws).getHours()).toBe(0);
    const nx = nextWindowStart(ws);
    expect([nx.getDate(), nx.getHours()]).toEqual([29, 6]);
  });

  it("Europe/Athens: fall-back's repeated 03:00 hour stays in one window", () => {
    useZone("Europe/Athens", [2026, 2, 29]);
    const first = new Date(2026, 9, 25, 3, 30); // first 03:30 (EEST)
    const second = new Date(first.getTime() + 3_600_000); // repeated 03:30 (EET)
    expect(second.getHours()).toBe(3);
    const ws = windowStart(second);
    expect(ws.getTime()).toBe(windowStart(first).getTime());
    expect(nextWindowStart(ws).getTime() - ws.getTime()).toBe(4 * 3_600_000); // 03:00–06:00 + 1 h
  });

  it.each(ZONES)("%s: searches scan through the spring-forward day", (tz, spring) => {
    useZone(tz, spring);
    const [y, m, d] = spring;
    // A general offered only in the 06:00 window of the spring-forward day, looked
    // up the evening before: it must be found a few hours ahead, not a year back.
    const sched = (at: Date): string[] =>
      at.getMonth() === m && at.getDate() === d && windowStartHour(at.getHours()) === 6 ? ["A"] : [];
    const now = new Date(y, m, d - 1, 22, 0);
    const cover = findRotationCover(sched, ["A"], now);
    expect(cover.groups.map((g) => [g.window.getTime(), g.direction])).toEqual([
      [new Date(y, m, d, 6).getTime(), "future"],
    ]);
    // …and from earlier that morning (after the gap), the window ahead is found.
    const early = new Date(y, m, d, 4, 30);
    const cover2 = findRotationCover(sched, ["A"], early);
    expect(cover2.groups[0].window.getTime()).toBe(new Date(y, m, d, 6).getTime());
  });
});
