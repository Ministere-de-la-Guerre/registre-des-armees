// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPTIMISE_SETTINGS } from "../state/optimiser";
import { OptimiseModal } from "./OptimiseModal";

const setup = (busy: boolean) => {
  const onClose = vi.fn();
  const { container } = render(
    <OptimiseModal
      factionKey="ntw3_tow_b06_x8_009"
      settings={DEFAULT_OPTIMISE_SETTINGS}
      onSettings={() => undefined}
      filteredCount={0}
      filtersActive={false}
      busy={busy}
      error={null}
      result={null}
      fallback={false}
      canUndo={false}
      onOptimise={() => undefined}
      onUndo={() => undefined}
      onClose={onClose}
    />,
  );
  return { onClose, backdrop: container.querySelector(".modal-backdrop") as HTMLElement };
};

afterEach(cleanup);

describe("OptimiseModal", () => {
  it("closes on Escape, the backdrop and ✕ when idle", () => {
    const { onClose, backdrop } = setup(false);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(backdrop);
    fireEvent.click(screen.getByRole("button", { name: "Close optimiser" }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("stays open while a solve runs", () => {
    const { onClose, backdrop } = setup(true);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(backdrop);
    const close = screen.getByRole("button", { name: "Close optimiser" });
    expect(close).toHaveProperty("disabled", true);
    fireEvent.click(close);
    expect(onClose).not.toHaveBeenCalled();
  });
});
