// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactionRoster } from "../domain/types";

const loadFaction = vi.fn<(key: string) => Promise<FactionRoster>>();
vi.mock("../data/load", () => ({ loadFaction: (key: string) => loadFaction(key) }));

const { usePlanRosters } = await import("./usePlanRosters");

const roster = (factionKey: string) =>
  ({ schemaVersion: 2, factionKey, armyCorpsName: "Test", cards: [], optimiser: null }) as FactionRoster;

afterEach(() => {
  cleanup();
  loadFaction.mockReset();
});

describe("usePlanRosters", () => {
  it("does not cache a failed request: the next ensure() fetches again", async () => {
    loadFaction.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(roster("a"));
    const { result } = renderHook(() => usePlanRosters([], true));
    await expect(result.current.ensure("a")).rejects.toThrow("offline");
    await expect(result.current.ensure("a")).resolves.toMatchObject({ factionKey: "a" });
    expect(loadFaction).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.loads.get("a")).toMatchObject({ status: "ready" }));
  });

  it("does not reload a failed plan corps on its own; retry() does", async () => {
    loadFaction.mockRejectedValueOnce(new Error("missing")).mockResolvedValueOnce(roster("p"));
    const { result, rerender } = renderHook(({ keys }) => usePlanRosters(keys, true), { initialProps: { keys: ["p"] } });
    await waitFor(() => expect(result.current.loads.get("p")).toMatchObject({ status: "error" }));
    rerender({ keys: ["p"] });
    rerender({ keys: ["p", "p"] });
    expect(loadFaction).toHaveBeenCalledTimes(1);
    act(() => result.current.retry("p"));
    await waitFor(() => expect(result.current.loads.get("p")).toMatchObject({ status: "ready" }));
    expect(loadFaction).toHaveBeenCalledTimes(2);
  });

  it("shares one request between callers", async () => {
    loadFaction.mockResolvedValue(roster("s"));
    const { result } = renderHook(() => usePlanRosters(["s"], true));
    await result.current.ensure("s");
    await result.current.ensure("s");
    expect(loadFaction).toHaveBeenCalledTimes(1);
  });
});
