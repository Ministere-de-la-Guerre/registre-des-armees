import { describe, expect, it } from "vitest";
import { makeUnit } from "../test/factories";
import { combinedTowLayout, orderBrigadeCards, sortStaffGenerals, towBrigades, towBrigadeIndexOf } from "./ordering";

describe("commander-beside-base ordering", () => {
  it("places expensive commanders left of the base, cheaper ones right", () => {
    const base = makeUnit({ unitKey: "u", cost: 500, capGroupKey: "u", baseUnitKey: "u" });
    const expensive = makeUnit({
      unitKey: "u_com_1", cost: 800, capGroupKey: "u", baseUnitKey: "u",
      isGeneral: true, generalKind: "combat", unitClass: "general", underlyingUnitClass: "infantry_line",
    });
    const cheaper = makeUnit({
      unitKey: "u_com_2", cost: 300, capGroupKey: "u", baseUnitKey: "u",
      isGeneral: true, generalKind: "combat", unitClass: "general", underlyingUnitClass: "infantry_line",
    });
    const ordered = orderBrigadeCards([cheaper, base, expensive]).map((c) => c.unitKey);
    expect(ordered).toEqual(["u_com_1", "u", "u_com_2"]);
  });

  it("keeps two equal-cost commanders ordered by stars (desc)", () => {
    const base = makeUnit({ unitKey: "u", cost: 500, capGroupKey: "u", baseUnitKey: "u" });
    const lowStar = makeUnit({
      unitKey: "u_com_1", cost: 700, commandStars: 1, capGroupKey: "u", baseUnitKey: "u",
      isGeneral: true, generalKind: "combat", unitClass: "general",
    });
    const highStar = makeUnit({
      unitKey: "u_com_2", cost: 700, commandStars: 4, capGroupKey: "u", baseUnitKey: "u",
      isGeneral: true, generalKind: "combat", unitClass: "general",
    });
    const ordered = orderBrigadeCards([base, lowStar, highStar]).map((c) => c.unitKey);
    expect(ordered).toEqual(["u_com_2", "u_com_1", "u"]);
  });
});

describe("brigade cross-type ordering", () => {
  it("orders infantry/skirmishers, then cavalry, then artillery (foot+horse by cost)", () => {
    const skirm = makeUnit({ unitKey: "sk", unitClass: "infantry_skirmishers", underlyingUnitClass: "infantry_skirmishers", capGroupKey: "sk", baseUnitKey: "sk", cost: 300 });
    const line = makeUnit({ unitKey: "ln", unitClass: "infantry_line", underlyingUnitClass: "infantry_line", capGroupKey: "ln", baseUnitKey: "ln", cost: 200 });
    const cav = makeUnit({ unitKey: "cv", unitClass: "cavalry_light", underlyingUnitClass: "cavalry_light", capGroupKey: "cv", baseUnitKey: "cv", cost: 500 });
    const footHi = makeUnit({ unitKey: "ft2", unitClass: "artillery_foot", underlyingUnitClass: "artillery_foot", capGroupKey: "ft2", baseUnitKey: "ft2", cost: 700 });
    const horse = makeUnit({ unitKey: "hr", unitClass: "artillery_horse", underlyingUnitClass: "artillery_horse", capGroupKey: "hr", baseUnitKey: "hr", cost: 600 });
    const footLo = makeUnit({ unitKey: "ft", unitClass: "artillery_foot", underlyingUnitClass: "artillery_foot", capGroupKey: "ft", baseUnitKey: "ft", cost: 400 });
    const ordered = orderBrigadeCards([horse, cav, footLo, line, skirm, footHi]).map((c) => c.unitKey);
    // Infantry by cost desc, then cavalry, then foot+horse guns interleaved by cost
    // (foot 700, horse 600, foot 400) — not all foot before all horse.
    expect(ordered).toEqual(["sk", "ln", "cv", "ft2", "hr", "ft"]);
  });
});

describe("TOW brigade sequencing", () => {
  const u = (unitKey: string, unitClass: string, cost: number, extra: Partial<Parameters<typeof makeUnit>[0]> = {}) =>
    makeUnit({ unitKey, unitClass, underlyingUnitClass: unitClass, capGroupKey: unitKey, baseUnitKey: unitKey, cost, ...extra });

  it("orders cavalry (heaviest→lightest) before infantry, then foot/horse/fixed artillery last", () => {
    const cards = [
      u("foot", "artillery_foot", 400),
      u("line", "infantry_line", 600),
      u("heavy", "cavalry_heavy", 900),
      u("fixed", "artillery_fixed", 300),
      u("gren", "infantry_grenadiers", 700),
      u("horse", "artillery_horse", 500),
      u("light_cav", "cavalry_light", 800),
    ];
    const seq = towBrigades(cards).map((b) => b.cards[0].unitKey);
    expect(seq).toEqual(["heavy", "light_cav", "gren", "line", "foot", "horse", "fixed"]);
  });

  it("puts staff generals in the command brigade before arm/class brigades", () => {
    const staffLow = makeUnit({
      unitKey: "staff_low", commandStars: 2, isGeneral: true, generalKind: "staff", unitClass: "general",
    });
    const staffHigh = makeUnit({
      unitKey: "staff_high", commandStars: 5, isGeneral: true, generalKind: "staff", unitClass: "general",
    });
    const line = u("ln", "infantry_line", 400);
    const brigades = towBrigades([line, staffLow, staffHigh]);
    expect(brigades.map((b) => b.cards.map((c) => c.unitKey))).toEqual([
      ["staff_high", "staff_low"],
      ["ln"],
    ]);
  });

  it("groups militia and irregulars into one brigade, ranked by cost desc", () => {
    const cards = [
      u("mil", "infantry_militia", 200),
      u("irr", "infantry_irregulars", 350),
    ];
    const brigades = towBrigades(cards);
    expect(brigades).toHaveLength(1);
    expect(brigades[0].cards.map((c) => c.unitKey)).toEqual(["irr", "mil"]);
  });

  it("keeps a combat general beside its unit inside that unit's brigade", () => {
    const base = u("cv", "cavalry_standard", 500);
    const general = makeUnit({
      unitKey: "cv_com_1", cost: 800, capGroupKey: "cv", baseUnitKey: "cv",
      isGeneral: true, generalKind: "combat", unitClass: "general", underlyingUnitClass: "cavalry_standard",
    });
    const line = u("ln", "infantry_line", 400);
    const brigades = towBrigades([line, base, general]);
    // Two brigades: cavalry_standard (with its general) then infantry_line.
    expect(brigades.map((b) => b.cards.map((c) => c.unitKey))).toEqual([["cv_com_1", "cv"], ["ln"]]);
  });

  it("maps classes to their fixed sequence position", () => {
    expect(towBrigadeIndexOf("cavalry_heavy")).toBe(2);
    expect(towBrigadeIndexOf("artillery_fixed")).toBe(14);
    expect(towBrigadeIndexOf("general")).toBeGreaterThan(14); // trailing "other"
  });
});

describe("combined TOW layout", () => {
  const u = (unitKey: string, unitClass: string, cost: number, extra: Partial<Parameters<typeof makeUnit>[0]> = {}) =>
    makeUnit({ unitKey, unitClass, underlyingUnitClass: unitClass, capGroupKey: unitKey, baseUnitKey: unitKey, cost, ...extra });

  it("lifts all staff into one row and pools each brigade type across corps by price", () => {
    // Two source corps, each contributing a line unit and a heavy-cavalry unit,
    // plus a staff general apiece. Combined, staff lift out; the two heavies pool
    // into the cavalry-heavy brigade and the two lines into the line brigade,
    // each ordered by cost desc regardless of which corps they came from.
    const staffA = makeUnit({ unitKey: "sA", commandStars: 4, isGeneral: true, generalKind: "staff", unitClass: "general" });
    const staffB = makeUnit({ unitKey: "sB", commandStars: 2, isGeneral: true, generalKind: "staff", unitClass: "general" });
    const heavyA = u("hA", "cavalry_heavy", 800);
    const heavyB = u("hB", "cavalry_heavy", 900);
    const lineA = u("lA", "infantry_line", 500);
    const lineB = u("lB", "infantry_line", 400);

    const { staffGenerals, brigades } = combinedTowLayout([lineA, staffB, heavyA, lineB, staffA, heavyB]);

    expect(staffGenerals.map((c) => c.unitKey)).toEqual(["sA", "sB"]);
    expect(brigades.map((b) => ({ brigade: b.brigade, cards: b.cards.map((c) => c.unitKey) }))).toEqual([
      { brigade: 2, cards: ["hB", "hA"] },
      { brigade: 10, cards: ["lA", "lB"] },
    ]);
  });

  it("produces no staff row and no command brigade when there are no staff generals", () => {
    const { staffGenerals, brigades } = combinedTowLayout([u("ln", "infantry_line", 400)]);
    expect(staffGenerals).toEqual([]);
    expect(brigades.map((b) => b.brigade)).toEqual([10]);
  });
});

describe("staff-general sorting", () => {
  it("sorts by command stars desc, unrated last", () => {
    const s2 = makeUnit({ unitKey: "s2", commandStars: 2, isGeneral: true, generalKind: "staff" });
    const s5 = makeUnit({ unitKey: "s5", commandStars: 5, isGeneral: true, generalKind: "staff" });
    const sNull = makeUnit({ unitKey: "s0", commandStars: null, isGeneral: true, generalKind: "staff" });
    const ordered = sortStaffGenerals([s2, sNull, s5]).map((c) => c.unitKey);
    expect(ordered).toEqual(["s5", "s2", "s0"]);
  });
});
