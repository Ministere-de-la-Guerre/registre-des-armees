import { describe, expect, it } from "vitest";
import { fitsTeam, joinTeam, pickSideArmies, teamAnchor, teamKeysByFaction, TOW_POOL, type TeamKey } from "./teamRule";
import type { CorpsEntry, CorpsIndex } from "./types";

const corps = (factionKey: string): CorpsEntry => ({
  factionKey,
  name: factionKey,
  displayYear: "",
  displayRating: "",
  order: 0,
  flag: null,
  postSelectionFlag: null,
  isArmyCorps: true,
  cardCount: 1,
});

const index: CorpsIndex = {
  schemaVersion: 1,
  sides: [
    { side: "empire", theatres: [{ theatre: "Russia (1812)", corps: [corps("e1"), corps("e2")] }, { theatre: "Spain (1809)", corps: [corps("e3")] }] },
    { side: "coalition", theatres: [{ theatre: "Patriotic War (1812)", corps: [corps("c1"), corps("c2")] }] },
    { side: "tow_french_imperial", theatres: [{ theatre: "Theatres of War", corps: [corps("ti1"), corps("ti2")] }] },
    { side: "tow_coalition", theatres: [{ theatre: "Theatres of War", corps: [corps("tc1")] }] },
    { side: "custom", theatres: [{ theatre: "Custom Armies", corps: [corps("x1"), corps("x2"), corps("britain"), corps("france")] }] },
  ],
};
const keys = teamKeysByFaction(index);
const k = (f: string) => keys.get(f)!;

describe("fitsTeam", () => {
  it("lets anything start a team", () => expect(fitsTeam(null, k("e1"))).toBe(true));
  it("requires the same side and theatre for campaign corps", () => {
    expect(fitsTeam(k("e1"), k("e2"))).toBe(true);
    expect(fitsTeam(k("e1"), k("e3"))).toBe(false); // other theatre
    expect(fitsTeam(k("e1"), k("c1"))).toBe(false); // other side
    expect(fitsTeam(k("c1"), k("c2"))).toBe(true);
  });
  it("mixes Theatres of War with custom armies, and nothing else", () => {
    expect(fitsTeam(k("ti1"), k("ti2"))).toBe(true);
    expect(fitsTeam(k("ti1"), k("x1"))).toBe(true);
    expect(fitsTeam(k("x1"), k("ti1"))).toBe(true);
    expect(fitsTeam(k("x1"), k("x2"))).toBe(true);
    expect(fitsTeam(k("ti1"), k("e1"))).toBe(false);
    expect(fitsTeam(k("x1"), k("c1"))).toBe(false);
  });
  it("keeps the two Theatres of War sides apart", () => {
    expect(fitsTeam(k("ti1"), k("tc1"))).toBe(false);
  });
});

describe("joinTeam", () => {
  it("lets the first Theatres of War army fix the side after custom ones", () => {
    const a = joinTeam(k("x1"), k("tc1"))!;
    expect(a.side).toBe("coalition");
    expect(fitsTeam(a, k("ti1"))).toBe(false);
    expect(fitsTeam(a, k("x2"))).toBe(true);
  });
  it("returns null for a clash", () => expect(joinTeam(k("e1"), k("c1"))).toBeNull());
});

describe("teamAnchor", () => {
  it("is the first army, skipping clashes and unknowns", () => {
    expect(teamAnchor([null, k("e1"), k("c1"), k("e2")])?.label).toBe("Imperial · Russia (1812)");
    expect(teamAnchor([])).toBeNull();
  });
});

describe("pickSideArmies", () => {
  const list = (...fs: (string | null)[]): (TeamKey | null)[] => fs.map((f) => (f ? k(f) : null));
  it("takes one side's armies in replay order, up to the cap", () => {
    const ks = list("e1", "e2", "c1", "c2", "e1", "e2");
    expect(pickSideArmies(ks, "imperial", 4)).toEqual([0, 1, 4, 5]);
    expect(pickSideArmies(ks, "coalition", 4)).toEqual([2, 3]);
  });
  it("drops armies from another theatre than the first", () => {
    expect(pickSideArmies(list("e1", "e3", "e2"), "imperial", 4)).toEqual([0, 2]);
  });
  it("adds custom armies only where they fit", () => {
    expect(pickSideArmies(list("ti1", "tc1", "x1"), "imperial", 4)).toEqual([0, 2]);
    expect(pickSideArmies(list("e1", "x1"), "imperial", 4)).toEqual([0]);
  });
  it("ignores unknown corps", () => {
    expect(pickSideArmies(list(null, "c1"), "coalition", 4)).toEqual([1]);
  });
});

describe("custom armies with a known nation", () => {
  const list = (...fs: string[]): TeamKey[] => fs.map(k);
  it("take the side of their nation, in the TOW pool", () => {
    expect(k("britain").side).toBe("coalition");
    expect(k("france").side).toBe("imperial");
    expect(k("x1").side).toBeNull();
    for (const f of ["britain", "france", "x1"]) expect(k(f).pool).toBe(TOW_POOL);
  });
  it("go only to their own side in a replay", () => {
    const ks = list("ti1", "ti2", "britain", "tc1");
    expect(pickSideArmies(ks, "imperial", 4)).toEqual([0, 1]);
    expect(pickSideArmies(ks, "coalition", 4)).toEqual([2, 3]);
  });
  it("anchor a plan on their side", () => {
    expect(fitsTeam(k("britain"), k("ti1"))).toBe(false);
    expect(fitsTeam(k("britain"), k("tc1"))).toBe(true);
    expect(fitsTeam(k("britain"), k("x1"))).toBe(true);
  });
});
