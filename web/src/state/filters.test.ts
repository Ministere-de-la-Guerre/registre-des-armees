import { describe, expect, it } from "vitest";
import { makeUnit } from "../test/factories";
import { defaultFilters, isFilterActive, isHiddenByGeneralSwitch, matchesCard } from "./filters";

describe("ordinary filters (dimming, not removal)", () => {
  it("matches everything by default and reports inactive", () => {
    const f = defaultFilters();
    expect(isFilterActive(f)).toBe(false);
    expect(matchesCard(makeUnit(), f)).toBe(true);
  });

  it("search matches name or unit key", () => {
    const f = { ...defaultFilters(), search: "grenad" };
    expect(matchesCard(makeUnit({ name: "Old Grenadiers" }), f)).toBe(true);
    expect(matchesCard(makeUnit({ name: "Line", unitKey: "x_grenad_1" }), f)).toBe(true);
    expect(matchesCard(makeUnit({ name: "Line", unitKey: "x" }), f)).toBe(false);
  });

  it("global numeric range excludes non-matching and blank values", () => {
    const f = defaultFilters();
    f.numeric.cost = { min: 600, max: null };
    expect(matchesCard(makeUnit({ cost: 500 }), f)).toBe(false);
    expect(matchesCard(makeUnit({ cost: 700 }), f)).toBe(true);
    f.numeric.cost = { min: null, max: null };
    f.numeric.men = { min: 100, max: null };
    expect(matchesCard(makeUnit({ cost: 700, finalMen: null }), f)).toBe(false);
  });

  it("class-specific stat filters only apply to that class", () => {
    const f = defaultFilters();
    // Require infantry accuracy >= 60.
    f.classStats.infantry.accuracy = { min: 60, max: null };
    const lowInf = makeUnit({ unitClass: "infantry_line", underlyingUnitClass: "infantry_line", stats: { accuracy: 50 } as never });
    const highInf = makeUnit({ unitClass: "infantry_line", underlyingUnitClass: "infantry_line", stats: { accuracy: 80 } as never });
    const cav = makeUnit({ unitClass: "cavalry_light", underlyingUnitClass: "cavalry_light", stats: { accuracy: 5 } as never });
    expect(matchesCard(lowInf, f)).toBe(false); // infantry filtered out
    expect(matchesCard(highInf, f)).toBe(true);
    expect(matchesCard(cav, f)).toBe(true); // cavalry unaffected by infantry filter
  });

  it("combat generals filter by underlying class", () => {
    const f = defaultFilters();
    f.classStats.artillery.accuracy = { min: 70, max: null };
    const artGeneral = makeUnit({
      unitClass: "general",
      underlyingUnitClass: "artillery_foot",
      isGeneral: true,
      generalKind: "combat",
      stats: { accuracy: 40 } as never,
    });
    expect(matchesCard(artGeneral, f)).toBe(false); // treated as artillery
  });

  it("category filter includes combat generals by their base unit type", () => {
    const f = { ...defaultFilters(), categories: ["infantry" as const] };
    const infGeneral = makeUnit({
      unitClass: "general", underlyingUnitClass: "infantry_line",
      isGeneral: true, generalKind: "combat",
    });
    const cavGeneral = makeUnit({
      unitClass: "general", underlyingUnitClass: "cavalry_light",
      isGeneral: true, generalKind: "combat",
    });
    const staff = makeUnit({ unitClass: "general", isGeneral: true, generalKind: "staff" });
    expect(matchesCard(infGeneral, f)).toBe(true); // infantry-led combat general matches
    expect(matchesCard(cavGeneral, f)).toBe(false); // cavalry-led one does not
    expect(matchesCard(staff, f)).toBe(false); // staff generals have no base unit
    // The Generals category still matches all generals.
    const g = { ...defaultFilters(), categories: ["generals" as const] };
    expect(matchesCard(infGeneral, g)).toBe(true);
    expect(matchesCard(staff, g)).toBe(true);
  });

  it("ability tri-state filters", () => {
    const f = defaultFilters();
    f.abilities.canFormSquare = "yes";
    expect(matchesCard(makeUnit({ abilities: { canFormSquare: true } as never }), f)).toBe(true);
    expect(matchesCard(makeUnit({ abilities: { canFormSquare: false } as never }), f)).toBe(false);
    f.abilities.canFormSquare = "no";
    expect(matchesCard(makeUnit({ abilities: { canFormSquare: false } as never }), f)).toBe(true);
  });

  it("division/brigade filters", () => {
    const f = defaultFilters();
    f.divisions = [2];
    expect(matchesCard(makeUnit({ placement: { division: 1, brigade: 1 } }), f)).toBe(false);
    expect(matchesCard(makeUnit({ placement: { division: 2, brigade: 1 } }), f)).toBe(true);
  });
});

describe("combat-general visibility switch (removal)", () => {
  const combat = makeUnit({ isGeneral: true, generalKind: "combat", unitClass: "general" });
  const staff = makeUnit({ isGeneral: true, generalKind: "staff", unitClass: "general" });

  it("hides only combat generals when off; keeps staff", () => {
    const off = { ...defaultFilters(), showCombatGenerals: false };
    expect(isHiddenByGeneralSwitch(combat, off)).toBe(true);
    expect(isHiddenByGeneralSwitch(staff, off)).toBe(false);
    expect(isHiddenByGeneralSwitch(makeUnit(), off)).toBe(false);
  });

  it("shows combat generals when on", () => {
    expect(isHiddenByGeneralSwitch(combat, defaultFilters())).toBe(false);
  });
});
