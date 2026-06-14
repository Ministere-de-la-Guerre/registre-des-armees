import { describe, expect, it } from "vitest";
import { makeRoster, makeUnit } from "../test/factories";
import { type BuildState, evaluateAdd, indexRoster } from "./build";

const b = (instances: string[], staff: string | null = null): BuildState => ({
  instances: instances.map((unitKey, i) => ({ id: `i${i}`, unitKey })),
  staffSlotUnitKey: staff,
});

describe("evaluateAdd blocking", () => {
  it("blocks once 31 cards are selected", () => {
    const roster = makeRoster([makeUnit({ unitKey: "a", cost: 10, cap: 99, groupCap: 99 })]);
    const idx = indexRoster(roster);
    const full = b(Array.from({ length: 31 }, () => "a"));
    expect(evaluateAdd(idx, full, idx.byKey.get("a")!, 5)?.reason).toMatch(/full/i);
  });

  it("allows a copy whose base cost reaches exactly 10,000", () => {
    const a = makeUnit({ unitKey: "a", cost: 5000, cap: 2, groupCap: 2 });
    const idx = indexRoster(makeRoster([a]));
    // One selected (5000); adding the 2nd reaches 10,000 base — exactly at the cap.
    expect(evaluateAdd(idx, b(["a"]), a, 5)).toBeNull();
  });

  it("blocks a card that would push *base* (pre-discount) cost over 10,000", () => {
    const a = makeUnit({ unitKey: "a", cost: 5000, cap: 2, groupCap: 2, placement: { division: 1, brigade: 1 } });
    const bcard = makeUnit({ unitKey: "bb", cost: 6000, cap: 1, groupCap: 1, placement: { division: 1, brigade: 2 } });
    const idx = indexRoster(makeRoster([a, bcard]));
    expect(evaluateAdd(idx, b(["a"]), bcard, 5)?.reason).toMatch(/10,000/);
  });

  it("blocks a copy whose current cost + price exceeds 10,000 (no earned discount yet)", () => {
    // Adding `sol` would complete the brigade and rebate it under 10,000, but with no
    // discount yet earned the running cost is 9,500 + 600 = 10,100, so it is blocked.
    const a = makeUnit({ unitKey: "a", cost: 9500, cap: 1, groupCap: 1, placement: { division: 1, brigade: 1 } });
    const sol = makeUnit({ unitKey: "sol", cost: 600, cap: 1, groupCap: 1, placement: { division: 1, brigade: 1 } });
    const idx = indexRoster(makeRoster([a, sol]));
    expect(evaluateAdd(idx, b(["a"]), sol, 5)?.reason).toMatch(/before discount/i);
  });

  it("allows a copy that fits once already-earned formation discounts are applied", () => {
    // Two completed brigades earn discounts that pull the running cost under 10,000,
    // so a unit whose *base* total would be 10,100 is still affordable (current
    // discounted cost 8,820 + 1,100 = 9,920). Mirrors the Toutchkov / Soulima case.
    const p = makeUnit({ unitKey: "p", cost: 1500, cap: 3, groupCap: 3, placement: { division: 1, brigade: 1 } });
    const q = makeUnit({ unitKey: "q", cost: 1500, cap: 3, groupCap: 3, placement: { division: 1, brigade: 2 } });
    const z = makeUnit({ unitKey: "z", cost: 1100, cap: 1, groupCap: 1, placement: { division: 1, brigade: 3 } });
    const idx = indexRoster(makeRoster([p, q, z]));
    expect(evaluateAdd(idx, b(["p", "p", "p", "q", "q", "q"]), z, 5)).toBeNull();
  });

  it("blocks the same combat general twice (one general per unit)", () => {
    const g = makeUnit({
      unitKey: "g", cost: 100, cap: 1, groupCap: 1, isGeneral: true, generalKind: "combat", unitClass: "general",
    });
    const idx = indexRoster(makeRoster([g]));
    expect(evaluateAdd(idx, b(["g"]), g, 5)?.reason).toMatch(/only one combat general/i);
  });

  it("blocks a second combat general for the same base unit even when its cap allows two copies", () => {
    // Base unit cap 2: two plain copies are fine, but only one may carry a general.
    const base = makeUnit({ unitKey: "u", cost: 500, cap: 2, groupCap: 2, capGroupKey: "u", baseUnitKey: "u" });
    const c1 = makeUnit({
      unitKey: "u_com_1", cost: 800, cap: 2, groupCap: 2, capGroupKey: "u", baseUnitKey: "u",
      isGeneral: true, generalKind: "combat", unitClass: "general",
    });
    const c2 = makeUnit({
      unitKey: "u_com_2", cost: 700, cap: 2, groupCap: 2, capGroupKey: "u", baseUnitKey: "u",
      isGeneral: true, generalKind: "combat", unitClass: "general",
    });
    const idx = indexRoster(makeRoster([base, c1, c2]));
    // One general already on the unit -> a different general for the same unit is blocked.
    expect(evaluateAdd(idx, b(["u_com_1"]), c2, 5)?.reason).toMatch(/only one combat general/i);
    // But a plain second copy (no general) is still allowed by the cap of 2.
    expect(evaluateAdd(idx, b(["u_com_1"]), base, 5)).toBeNull();
  });

  it("enforces foot-artillery limit of 2", () => {
    const art = makeUnit({ unitKey: "f", unitClass: "artillery_foot", underlyingUnitClass: "artillery_foot", cap: 9, groupCap: 9, cost: 100 });
    const idx = indexRoster(makeRoster([art]));
    expect(evaluateAdd(idx, b(["f", "f"]), art, 5)?.reason).toMatch(/foot-artillery/i);
  });
});
