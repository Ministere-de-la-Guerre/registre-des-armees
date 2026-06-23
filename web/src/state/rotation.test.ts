import { describe, expect, it } from "vitest";
import { makeUnit } from "../test/factories";
import {
  WINDOW_START_HOURS,
  combatPool,
  findRotation,
  offeredCombatKeys,
  offeredStaffKeys,
  seedForDate,
  shuffleByDate,
  staffCommanderKey,
  staffPool,
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
