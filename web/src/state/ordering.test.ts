import { describe, expect, it } from "vitest";
import { makeUnit } from "../test/factories";
import { orderBrigadeCards, sortStaffGenerals } from "./ordering";

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
  it("orders infantry/skirmishers, then cavalry, then foot guns, then horse guns", () => {
    const skirm = makeUnit({ unitKey: "sk", unitClass: "infantry_skirmishers", underlyingUnitClass: "infantry_skirmishers", capGroupKey: "sk", baseUnitKey: "sk", cost: 300 });
    const line = makeUnit({ unitKey: "ln", unitClass: "infantry_line", underlyingUnitClass: "infantry_line", capGroupKey: "ln", baseUnitKey: "ln", cost: 200 });
    const cav = makeUnit({ unitKey: "cv", unitClass: "cavalry_light", underlyingUnitClass: "cavalry_light", capGroupKey: "cv", baseUnitKey: "cv", cost: 500 });
    const foot = makeUnit({ unitKey: "ft", unitClass: "artillery_foot", underlyingUnitClass: "artillery_foot", capGroupKey: "ft", baseUnitKey: "ft", cost: 400 });
    const horse = makeUnit({ unitKey: "hr", unitClass: "artillery_horse", underlyingUnitClass: "artillery_horse", capGroupKey: "hr", baseUnitKey: "hr", cost: 600 });
    const ordered = orderBrigadeCards([horse, cav, foot, line, skirm]).map((c) => c.unitKey);
    // Infantry by cost desc (skirmisher most expensive → first), then cav, foot, horse.
    expect(ordered).toEqual(["sk", "ln", "cv", "ft", "hr"]);
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
