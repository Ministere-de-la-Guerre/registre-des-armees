import { describe, expect, it } from "vitest";
import { foldForSearch, matchesSearch } from "./searchText";

describe("foldForSearch", () => {
  it("lowercases", () => {
    expect(foldForSearch("Berwick")).toBe("berwick");
  });

  it("expands German umlauts so the base letter matches", () => {
    // "o" and "oe" and "ö" all reduce to a form containing the query.
    const folded = foldForSearch("Böcklinsau");
    expect(folded).toBe("boecklinsau");
    expect(folded.includes(foldForSearch("o"))).toBe(true);
    expect(folded.includes(foldForSearch("oe"))).toBe(true);
    expect(folded.includes(foldForSearch("ö"))).toBe(true);
  });

  it("expands ß, ä, ü and ligatures", () => {
    expect(foldForSearch("Straße")).toBe("strasse");
    expect(foldForSearch("Jäger")).toBe("jaeger");
    expect(foldForSearch("Württemberg")).toBe("wuerttemberg");
    expect(foldForSearch("Œuvre")).toBe("oeuvre");
  });

  it("strips remaining combining diacritics to ASCII", () => {
    expect(foldForSearch("léger")).toBe("leger");
    expect(foldForSearch("Ingenjör")).toBe("ingenjoer");
    expect(foldForSearch("España")).toBe("espana");
    expect(foldForSearch("Nègres à barbe")).toBe("negres a barbe");
  });

  it("makes an English-keyboard query match an accented name", () => {
    const name = foldForSearch("13e léger 'le Berwick'");
    expect(name.includes(foldForSearch("leger"))).toBe(true);
    expect(name.includes(foldForSearch("Léger"))).toBe(true);
  });
});

describe("matchesSearch", () => {
  const tow = "[1805] 11. France (Allemagne)";

  it("matches an empty / whitespace query", () => {
    expect(matchesSearch(tow, "")).toBe(true);
    expect(matchesSearch(tow, "   ")).toBe(true);
  });

  it("does not require the decorative [year]/number prefix or punctuation", () => {
    expect(matchesSearch(tow, "france")).toBe(true);
    expect(matchesSearch(tow, "allemagne")).toBe(true);
    // Words separated by the name's own punctuation still match as separate tokens.
    expect(matchesSearch(tow, "france allemagne")).toBe(true);
  });

  it("is order-independent across tokens", () => {
    expect(matchesSearch(tow, "allemagne france")).toBe(true);
    expect(matchesSearch(tow, "1805 france")).toBe(true);
  });

  it("still matches the bracketed year and number when typed", () => {
    expect(matchesSearch(tow, "1805")).toBe(true);
    expect(matchesSearch(tow, "11 france")).toBe(true);
  });

  it("requires every token to appear", () => {
    expect(matchesSearch(tow, "france espagne")).toBe(false);
    expect(matchesSearch(tow, "prussia")).toBe(false);
  });

  it("is accent-insensitive per token", () => {
    expect(matchesSearch("[1799] 9. Österreich (Italien)", "oesterreich italien")).toBe(true);
    expect(matchesSearch("[1799] 9. Österreich (Italien)", "osterreich")).toBe(true);
  });
});
