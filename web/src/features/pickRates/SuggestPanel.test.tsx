// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeUnit } from "../../test/factories";
import { SuggestPanel, regimentShortName } from "./SuggestPanel";
import type { GeneralSuggestion, Suggestions, UnitSuggestion } from "./suggest";

afterEach(cleanup);

const plain = makeUnit({ unitKey: "a", capGroupKey: "a", name: "¤ 52e de ligne 'Les Vaillants' [L3]" });
const general = makeUnit({ unitKey: "a_g", capGroupKey: "a", name: "Général X", isGeneral: true, generalKind: "combat" });
const unit = (over: Partial<UnitSuggestion> = {}): UnitSuggestion => ({
  card: plain, k: 9, costDelta: 600, finalCost: 5000, overBudget: false, blockedReason: null, completesDiscount: false, ...over,
});
const gen = (over: Partial<GeneralSuggestion> = {}): GeneralSuggestion => ({
  card: general, k: 7, status: "swap", regiment: plain, swapInstanceId: "i1",
  costDelta: -803, finalCost: 4000, overBudget: false, blockedReason: null, ...over,
});
const ok = (over: Partial<Suggestions> = {}): Suggestions => ({
  kind: "ok", K: 15, n: 40, emptyBuild: false, sharedPct: 71, units: [unit(), unit({ card: { ...plain, unitKey: "c" }, costDelta: -100, completesDiscount: true })], generals: [gen()],
  combatUsed: 2, combatCap: 4, neighbours: [], ...over,
});

describe("SuggestPanel", () => {
  it("shortens regiment names", () => {
    expect(regimentShortName(plain)).toBe("52e de ligne");
  });

  it("renders header, rows and wires clicks", () => {
    const onPickUnit = vi.fn();
    const onPickGeneral = vi.fn();
    render(
      <SuggestPanel result={ok()} seasonLabel="Season 9" onPickUnit={onPickUnit} onPickGeneral={onPickGeneral} onClose={() => {}} />,
    );
    expect(screen.getByText("Builds like yours also took")).toBeTruthy();
    expect(screen.getByText(/share 71% of your regiments · Season 9/)).toBeTruthy();
    expect(screen.getAllByText("9 of 15 builds").length).toBeGreaterThan(0);
    expect(screen.getByText("+600 MP")).toBeTruthy();
    expect(screen.getByText("−803 MP")).toBeTruthy();
    expect(screen.getByText("completes a division")).toBeTruthy();
    expect(screen.getByText("On your 52e de ligne")).toBeTruthy();
    expect(screen.getByText("2 of 4 used · 2 left")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /add it to your build/ })[0]);
    expect(onPickUnit).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /put it in charge/ }));
    expect(onPickGeneral).toHaveBeenCalledTimes(1);
  });

  it("shows have / blocked / empty states", () => {
    render(
      <SuggestPanel
        result={ok({ units: [], generals: [gen({ status: "have" }), gen({ card: { ...general, unitKey: "b" }, blockedReason: "Limit reached" })], combatUsed: 4 })}
        seasonLabel="S" onPickUnit={() => {}} onPickGeneral={() => {}} onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Nothing more to suggest/)).toBeTruthy();
    expect(screen.getByText("✓ In your build")).toBeTruthy();
    expect(screen.getAllByText("Limit reached").length).toBeGreaterThan(0);
    expect(screen.getByText("4 of 4 used · limit reached")).toBeTruthy();
  });

  it("shows only the reason when unavailable", () => {
    render(<SuggestPanel result={{ kind: "thin", n: 7 }} seasonLabel="S" onPickUnit={() => {}} onPickGeneral={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Only 7 recorded builds — suggestions need 15.")).toBeTruthy();
    expect(screen.queryByText("Units")).toBeNull();
  });
});
