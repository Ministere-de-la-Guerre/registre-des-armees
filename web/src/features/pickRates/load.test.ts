import { describe, expect, it } from "vitest";
import { normalizeCorps, normalizeCorpsBuilds } from "./load";

describe("normalizeCorpsBuilds", () => {
  it("keeps a valid payload", () => {
    expect(normalizeCorpsBuilds({ keys: ["a", "b"], b: [[0, 1], [1], []] })).toEqual({
      keys: ["a", "b"],
      b: [[0, 1], [1], []],
    });
  });
  it("returns undefined for non-objects and non-array keys or b", () => {
    for (const raw of [undefined, null, 5, "x", [], { keys: "a", b: [] }, { keys: [], b: {} }, { keys: ["a"] }, { b: [] }]) {
      expect(normalizeCorpsBuilds(raw)).toBeUndefined();
    }
  });
  it("returns undefined when any key is not a string", () => {
    expect(normalizeCorpsBuilds({ keys: ["a", 2], b: [[0]] })).toBeUndefined();
  });
  it("drops inner arrays with out-of-range, negative or non-integer indices, or non-arrays", () => {
    const out = normalizeCorpsBuilds({ keys: ["a", "b"], b: [[0], [2], [-1], [0.5], ["0"], [null], 7, null, [1]] });
    expect(out).toEqual({ keys: ["a", "b"], b: [[0], [1]] });
  });
});

describe("normalizeCorps", () => {
  it("skips non-object entries and never throws", () => {
    const out = normalizeCorps({ a: null, b: 3, c: "x", d: [1], e: { n: 4 } } as Record<string, unknown>);
    expect(Object.keys(out)).toContain("e");
    expect(out.a).toBeUndefined();
    expect(out.b).toBeUndefined();
    expect(out.c).toBeUndefined();
  });
  it("drops bad builds but keeps the rest of the entry", () => {
    const out = normalizeCorps({ k: { n: 9, builds: { keys: [1], b: [] } } });
    expect(out.k).toEqual({ n: 9 });
  });
  it("keeps valid builds", () => {
    const out = normalizeCorps({ k: { n: 1, builds: { keys: ["a"], b: [[0]] } } });
    expect(out.k.builds).toEqual({ keys: ["a"], b: [[0]] });
  });
});
