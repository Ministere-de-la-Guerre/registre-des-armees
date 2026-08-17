import { describe, expect, it } from "vitest";
import { makeUnit } from "../test/factories";
import { type FilterState, defaultFilters, isFilterActive, isHiddenByGeneralSwitch, matchesCard } from "./filters";

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

  it("unit-class filter includes combat generals by the class they lead", () => {
    const f = { ...defaultFilters(), classes: ["infantry_grenadiers"] };
    const grenGeneral = makeUnit({
      unitClass: "general", underlyingUnitClass: "infantry_grenadiers",
      isGeneral: true, generalKind: "combat",
    });
    const lineGeneral = makeUnit({
      unitClass: "general", underlyingUnitClass: "infantry_line",
      isGeneral: true, generalKind: "combat",
    });
    const grenUnit = makeUnit({ unitClass: "infantry_grenadiers", underlyingUnitClass: "infantry_grenadiers" });
    expect(matchesCard(grenGeneral, f)).toBe(true); // grenadier-led combat general matches
    expect(matchesCard(lineGeneral, f)).toBe(false); // line-led one does not
    expect(matchesCard(grenUnit, f)).toBe(true);
  });

  it("ability tri-state filters", () => {
    const f = defaultFilters();
    f.abilities.canFormSquare = "yes";
    expect(matchesCard(makeUnit({ abilities: { canFormSquare: true } as never }), f)).toBe(true);
    expect(matchesCard(makeUnit({ abilities: { canFormSquare: false } as never }), f)).toBe(false);
    f.abilities.canFormSquare = "no";
    expect(matchesCard(makeUnit({ abilities: { canFormSquare: false } as never }), f)).toBe(true);
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

describe("pick-rate filter", () => {
  const card = makeUnit();
  const withRange = (min: number | null, max: number | null): FilterState => ({
    ...defaultFilters(),
    pickRate: { min, max },
  });

  it("is inactive until a handle moves", () => {
    expect(isFilterActive(defaultFilters())).toBe(false);
    expect(isFilterActive(withRange(20, null))).toBe(true);
    expect(isFilterActive(withRange(null, 80))).toBe(true);
  });

  it("keeps cards inside the range and drops those outside", () => {
    const rate = () => 40;
    expect(matchesCard(card, withRange(20, 60), rate)).toBe(true);
    expect(matchesCard(card, withRange(50, 100), rate)).toBe(false);
    expect(matchesCard(card, withRange(0, 30), rate)).toBe(false);
  });

  it("treats never-picked as a real 0, so 0-0 isolates the dead cards", () => {
    expect(matchesCard(card, withRange(null, 0), () => 0)).toBe(true);
    expect(matchesCard(card, withRange(1, null), () => 0)).toBe(false);
  });

  // Unlike every other numeric filter, which excludes blanks: 41% of corps have no
  // data, so excluding blanks would dim a whole roster the moment a handle moved.
  it("never dims a card the dataset cannot speak about", () => {
    expect(matchesCard(card, withRange(80, 100), () => null)).toBe(true);
    expect(matchesCard(card, withRange(80, 100), undefined)).toBe(true);
  });

  it("does nothing at all while the range is untouched", () => {
    expect(matchesCard(card, defaultFilters(), () => 3)).toBe(true);
  });
});
