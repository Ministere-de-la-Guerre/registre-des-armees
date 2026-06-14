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

describe("staff-general sorting", () => {
  it("sorts by command stars desc, unrated last", () => {
    const s2 = makeUnit({ unitKey: "s2", commandStars: 2, isGeneral: true, generalKind: "staff" });
    const s5 = makeUnit({ unitKey: "s5", commandStars: 5, isGeneral: true, generalKind: "staff" });
    const sNull = makeUnit({ unitKey: "s0", commandStars: null, isGeneral: true, generalKind: "staff" });
    const ordered = sortStaffGenerals([s2, sNull, s5]).map((c) => c.unitKey);
    expect(ordered).toEqual(["s5", "s2", "s0"]);
  });
});
