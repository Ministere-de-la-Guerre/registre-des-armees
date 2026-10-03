// @vitest-environment jsdom
// The Builder -> host contract behind the Ordre de Bataille planner: onBuildChange
// reports real edits only (never the empty pre-seed build or the seed itself, nor
// view-only toggles), and a Builder without the host props behaves as before.

import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildToSaved } from "../state/saves";
import { makeRoster, makeUnit } from "../test/factories";
import { Builder } from "./Builder";

const roster = makeRoster([
  makeUnit({ unitKey: "line", name: "Line Regiment", cost: 400, cap: 5, groupCap: 5 }),
  makeUnit({ unitKey: "grenadiers", name: "Grenadiers", cost: 500, cap: 5, groupCap: 5, unitClass: "infantry_grenadiers", underlyingUnitClass: "infantry_grenadiers" }),
]);

const seed = buildToSaved(
  {
    build: { instances: [{ id: "x", unitKey: "line" }], staffSlotUnitKey: null },
    config: { density: "comfortable", showCombatGenerals: true },
    factionKey: roster.factionKey,
    armyCorpsName: roster.armyCorpsName,
  },
  { name: "Seeded" },
);

beforeAll(() => {
  // jsdom has none of these; the builder only needs them not to throw.
  class NoopObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", NoopObserver);
  vi.stubGlobal("IntersectionObserver", NoopObserver);
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

const addLine = () => {
  const card = document.querySelector<HTMLElement>('.map [data-unit-key="grenadiers"]');
  expect(card).not.toBeNull();
  fireEvent.click(card!);
};

describe("Builder onBuildChange", () => {
  it("stays silent for the empty pre-seed build and the seed itself", () => {
    const onBuildChange = vi.fn();
    render(
      <StrictMode>
        <Builder roster={roster} postFlag={null} onBack={() => {}} initialSaved={seed} onBuildChange={onBuildChange} context={{ backLabel: "‹ Plan", label: "Army 1 of Plan" }} />
      </StrictMode>,
    );
    expect(onBuildChange).not.toHaveBeenCalled();
    expect(document.querySelector(".corps-header .sub")?.textContent).toBe("Army 1 of Plan");
  });

  it("reports an edit, with the seeded unit kept, and not a view-only toggle", () => {
    const onBuildChange = vi.fn();
    render(<Builder roster={roster} postFlag={null} onBack={() => {}} initialSaved={seed} onBuildChange={onBuildChange} />);
    expect(onBuildChange).not.toHaveBeenCalled();

    addLine();
    expect(onBuildChange).toHaveBeenCalledTimes(1);
    const reported = onBuildChange.mock.calls[0][0];
    expect(reported.build.instances.map((i: { unitKey: string }) => i.unitKey)).toEqual(["line", "grenadiers"]);
    expect(reported.factionKey).toBe(roster.factionKey);

    // "Combat generals" is a view setting: it must not look like an edit.
    fireEvent.click(screen.getByLabelText("Combat generals"));
    expect(onBuildChange).toHaveBeenCalledTimes(1);

    // The latest config rides along with the next real edit.
    addLine();
    expect(onBuildChange).toHaveBeenCalledTimes(2);
    expect(onBuildChange.mock.calls[1][0].config.showCombatGenerals).toBe(false);
  });

  it("behaves as a plain builder without the host props", () => {
    render(<Builder roster={roster} postFlag={null} onBack={() => {}} />);
    expect(screen.getByText("← Corps")).toBeTruthy();
    expect(screen.getByText("New build")).toBeTruthy();
    addLine();
    expect(screen.getByText("Unsaved build")).toBeTruthy();
  });
});
