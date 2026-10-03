// "Copy image" for the planner: a PNG snapshot of PlanExportView, so the picture is
// the live planner's own markup, fonts and medallions.
//
// The view is rendered into an offscreen, fixed-width iframe rather than the page:
// media queries follow the viewport, so only a document that is itself 1600px wide
// gets the desktop layout, whatever device the export is started from.

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { toBlob } from "html-to-image";
import { PlanExportView, type PlanExportProps } from "./PlanExportView";

const EXPORT_WIDTH = 1600;
const PIXEL_RATIO = 2;
// Browser canvas limits: 16384px per side and roughly 16M pixels in all (Safari).
const MAX_SIDE = 16384;
const MAX_PIXELS = 16_000_000;
// The app's page background (--bg), behind the screen's own gradient.
const BACKGROUND = "#0f1216";
// An iframe that never fires `load` (or an image that never settles) would leave the
// planner waiting forever with the clipboard promise pending; fail instead so the
// caller's usual failure toast shows.
const FRAME_TIMEOUT_MS = 10_000;
const RENDER_TIMEOUT_MS = 20_000;

/** Rejects with `message` if `work` has not settled within `ms`. The timer is always
 *  cleared; a late rejection of `work` is swallowed so it cannot go unhandled. */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** The app's CSS as text, with the touch-device media features switched off. An iframe
 *  inherits hover/pointer from the device, so a phone would otherwise apply the
 *  coarse-pointer rules (scrolling toolbar, pinned strip) to the picture. Width queries
 *  need no care: the iframe is 1600px wide. */
function appCss(): string {
  let css = "";
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) css += `${rule.cssText}\n`;
    } catch {
      // A cross-origin sheet cannot be read; the app has none.
    }
  }
  // An unknown feature value matches nothing, so those rules never apply.
  return css.replace(/\(hover:\s*none\)/g, "(hover: never)").replace(/\(pointer:\s*coarse\)/g, "(pointer: never)");
}

/** Resolve once every image in the document has loaded (or failed: the medallion then
 *  just lacks its icon, as on screen). Lazy images in an offscreen frame would never
 *  start, so they are made eager first. */
async function imagesLoaded(doc: Document): Promise<void> {
  const imgs = Array.from(doc.images);
  for (const img of imgs) img.loading = "eager";
  await Promise.all(
    imgs.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
          }),
    ),
  );
  await Promise.all(imgs.map((img) => img.decode().catch(() => undefined)));
}

export async function renderPlanImage(props: PlanExportProps): Promise<Blob> {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;left:-${EXPORT_WIDTH + 200}px;top:0;width:${EXPORT_WIDTH}px;height:900px;border:0;pointer-events:none;`;
  frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>';
  const loaded = new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
  document.body.appendChild(frame);
  let root = null as ReturnType<typeof createRoot> | null;

  const render = async (): Promise<Blob> => {
    await withTimeout(loaded, FRAME_TIMEOUT_MS, "Plan image frame did not load");
    const doc = frame.contentDocument!;
    const style = doc.createElement("style");
    // The app locks html/body/#root to the viewport height with hidden overflow.
    style.textContent = `${appCss()}\nhtml, body, #root { height: auto; overflow: visible; }`;
    doc.head.appendChild(style);

    root = createRoot(doc.getElementById("root")!);
    flushSync(() => root!.render(<PlanExportView {...props} />));
    await imagesLoaded(doc);
    await doc.fonts?.ready;

    const node = doc.querySelector<HTMLElement>(".plan-export")!;
    const height = Math.ceil(node.getBoundingClientRect().height);
    const ratio = Math.min(PIXEL_RATIO, MAX_SIDE / height, MAX_SIDE / EXPORT_WIDTH, Math.sqrt(MAX_PIXELS / (EXPORT_WIDTH * height)));
    // The fonts are the system stacks in styles.css (no @font-face to embed), so the
    // snapshot uses the same ones.
    const blob = await toBlob(node, {
      width: EXPORT_WIDTH,
      height,
      pixelRatio: ratio,
      backgroundColor: BACKGROUND,
      skipFonts: true,
    });
    if (!blob) throw new Error("Plan image render produced no data");
    return blob;
  };

  try {
    return await withTimeout(render(), RENDER_TIMEOUT_MS, "Plan image render timed out");
  } finally {
    root?.unmount();
    frame.remove();
  }
}
