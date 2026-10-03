// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider } from "./ConfirmProvider";
import { useConfirm, type ConfirmOptions } from "./useConfirm";

let useAsk: (o: ConfirmOptions) => Promise<boolean>;
const ask = (o: ConfirmOptions) => {
  let p!: Promise<boolean>;
  act(() => {
    p = useAsk(o);
  });
  return p;
};
function Harness() {
  useAsk = useConfirm();
  return <button>opener</button>;
}
const setup = () => render(<ConfirmProvider><Harness /></ConfirmProvider>);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useConfirm", () => {
  it("resolves true on the confirm button and focuses it", async () => {
    setup();
    const p = ask({ title: "T", message: "Sure?", confirmLabel: "Do it" });
    const btn = await screen.findByRole("button", { name: "Do it" });
    await waitFor(() => expect(document.activeElement).toBe(btn));
    expect(screen.getByText("Sure?")).toBeTruthy();
    fireEvent.click(btn);
    expect(await p).toBe(true);
    expect(screen.queryByText("Sure?")).toBeNull();
  });

  it("resolves false on Cancel, Escape and a backdrop click", async () => {
    setup();
    let p = ask({ message: "m" });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await p).toBe(false);

    p = ask({ message: "m" });
    await screen.findByText("m");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("OK"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await p).toBe(false);

    p = ask({ message: "m" });
    await screen.findByText("m");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("OK"));
    fireEvent.mouseDown(document.querySelector(".modal-backdrop")!);
    expect(await p).toBe(false);
  });

  it("does not cancel on a click inside the dialog; Enter confirms", async () => {
    setup();
    const p = ask({ message: "inside" });
    fireEvent.mouseDown(await screen.findByText("inside"));
    expect(screen.queryByText("inside")).not.toBeNull();
    await waitFor(() => expect(document.activeElement?.textContent).toBe("OK"));
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(await p).toBe(true);
  });

  it("returns focus to the previously focused element", async () => {
    setup();
    const opener = screen.getByRole("button", { name: "opener" });
    opener.focus();
    const p = ask({ message: "m" });
    await screen.findByText("m");
    await waitFor(() => expect(document.activeElement).not.toBe(opener));
    fireEvent.keyDown(window, { key: "Escape" });
    await p;
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("declines an unanswered dialog superseded by a newer one", async () => {
    setup();
    const first = ask({ message: "one" });
    await screen.findByText("one");
    const second = ask({ message: "two" });
    expect(await first).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "OK" }));
    expect(await second).toBe(true);
  });
});
