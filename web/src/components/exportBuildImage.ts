// Render the current build as a single stretched-out line of unit medallions —
// commander first, then every selected copy — and hand it to the device: copied
// to the clipboard on desktop (fine pointer), saved/shared on phones & tablets.
//
// Drawn on a canvas rather than screenshotting the DOM: the tray is collapsed and
// horizontally clipped on mobile, and canvas gives a clean, full-width, device-
// independent strip that mirrors the in-game unit bar (and the desktop .exe).

import { assetUrl } from "../data/assets";
import type { UnitCard } from "../domain/types";
import type { BuildState, RosterIndex } from "../state/build";

// Class → short label for the fallback tile when a unit has no icon (mirrors the
// Medallion abbreviations).
const ABBR: Record<string, string> = {
  infantry_line: "Line",
  infantry_light: "Light",
  infantry_grenadiers: "Gren",
  infantry_skirmishers: "Skirm",
  infantry_militia: "Militia",
  infantry_irregulars: "Irreg",
  cavalry_heavy: "Hvy Cav",
  cavalry_light: "Lt Cav",
  cavalry_lancers: "Lancer",
  cavalry_standard: "Cav",
  cavalry_missile: "Cav",
  artillery_foot: "Foot Art",
  artillery_horse: "Horse Art",
  artillery_fixed: "Fixed Art",
  general: "General",
};

// Palette (kept in sync with styles.css :root).
const C = {
  bgTop: "#1a2230",
  bgBottom: "#0f1216",
  panel3: "#2a323e",
  line: "#2e3742",
  line2: "#3c4757",
  frame: "#46515f",
  azure: "#5aa2e6",
  text: "#e8ebf1",
  textSoft: "#97a1b0",
  gold: "#d8b44a",
  goldBright: "#f3d271",
  goldDeep: "#9a7c2c",
};

const SANS = '"Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif';
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif';

// Layout in CSS px (the whole canvas is drawn at OUTPUT_SCALE for crispness).
const OUTPUT_SCALE = 2;
const PAD = 18;
const HEADER_H = 42;
const CELL_W = 78;
const GAP = 6;
const DIVIDER_W = 15; // gap that carries the commander/units divider
const PORTRAIT_W = 64;
const PORTRAIT_H = 76;
const TOP_PAD = 12; // room for the badges that overhang the portrait top
const COST_H = 20;
const MIN_WIDTH = 360;
const HEADER_GAP = 16; // least space between the title and a same-line subtitle
const SUBTITLE_LINE_H = 17; // extra header height when the subtitle gets its own line

function loadImage(src: string, timeoutMs = 15000): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    let settled = false;
    const settle = (result: HTMLImageElement | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // A request that neither loads nor errors (a stalled icon fetch on a flaky
    // network) would otherwise leave Promise.all in renderBuildImage hanging
    // forever, so the export button silently does nothing. Time out to null.
    const timer = setTimeout(() => settle(null), timeoutMs);
    img.onload = () => settle(img);
    img.onerror = () => settle(null);
    img.src = src;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** A pill badge (men / speed): rounded rect with text, sized to fit. Returns its width. */
function drawPill(ctx: CanvasRenderingContext2D, cx: number, cy: number, text: string): number {
  ctx.font = `700 10px ${SANS}`;
  const w = Math.ceil(ctx.measureText(text).width) + 10;
  const h = 15;
  const x = cx - w / 2;
  const y = cy - h / 2;
  ctx.fillStyle = C.panel3;
  roundRect(ctx, x, y, w, h, 5);
  ctx.fill();
  ctx.strokeStyle = C.line2;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy + 0.5);
  return w;
}

/** Draw an image cover-fit inside an ellipse (matches object-fit: cover). */
function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  cx: number,
  cy: number,
  w: number,
  h: number,
) {
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.clip();
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
  ctx.restore();
}

interface CellData {
  card: UnitCard;
  commander: boolean;
  icon: HTMLImageElement | null;
}

function drawCell(ctx: CanvasRenderingContext2D, cell: CellData, cellX: number, portraitTop: number) {
  const { card, commander, icon } = cell;
  const cx = cellX + CELL_W / 2;
  const cy = portraitTop + PORTRAIT_H / 2;

  // Portrait frame.
  ctx.beginPath();
  ctx.ellipse(cx, cy, PORTRAIT_W / 2, PORTRAIT_H / 2, 0, 0, Math.PI * 2);
  ctx.fillStyle = C.panel3;
  ctx.fill();
  if (icon) {
    drawCover(ctx, icon, cx, cy, PORTRAIT_W, PORTRAIT_H);
  } else {
    ctx.fillStyle = "#aeb7c4";
    ctx.font = `600 10px ${SERIF}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(ABBR[card.unitClass] ?? card.unitClass, cx, cy);
  }
  // Re-stroke the frame on top of the icon.
  ctx.beginPath();
  ctx.ellipse(cx, cy, PORTRAIT_W / 2, PORTRAIT_H / 2, 0, 0, Math.PI * 2);
  ctx.lineWidth = commander ? 3 : 2.5;
  ctx.strokeStyle = commander ? C.azure : C.frame;
  ctx.stroke();

  // Top badges: speed pill (left) and men pill (right), overhanging the top edge.
  const badgeY = portraitTop + 1;
  if (card.speedCode) drawPill(ctx, cellX + 15, badgeY, card.speedCode);
  if (card.finalMen != null) drawPill(ctx, cellX + CELL_W - 15, badgeY, String(card.finalMen));

  // Command stars (generals): centered pill just inside the portrait top.
  if (card.isGeneral && card.commandStars) {
    const text = `★${card.commandStars}`;
    ctx.font = `700 9px ${SANS}`;
    const w = Math.ceil(ctx.measureText(text).width) + 8;
    const h = 14;
    const x = cx - w / 2;
    const y = portraitTop + 8;
    ctx.fillStyle = "rgba(0,0,0,0.72)";
    roundRect(ctx, x, y, w, h, 7);
    ctx.fill();
    ctx.strokeStyle = C.gold;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = C.goldBright;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cx, y + h / 2 + 0.5);
  }

  // Cost: gold coin + figure, centered below the portrait.
  const costText = card.cost.toLocaleString();
  ctx.font = `800 12px ${SANS}`;
  const numW = ctx.measureText(costText).width;
  const coinR = 4.5;
  const gap = 4;
  const totalW = coinR * 2 + gap + numW;
  const startX = cx - totalW / 2;
  const coinCx = startX + coinR;
  const coinCy = portraitTop + PORTRAIT_H + 10;
  const coin = ctx.createRadialGradient(
    coinCx - 1.5,
    coinCy - 1.5,
    0.5,
    coinCx,
    coinCy,
    coinR,
  );
  coin.addColorStop(0, "#ffe9a8");
  coin.addColorStop(0.68, C.gold);
  coin.addColorStop(1, C.goldDeep);
  ctx.beginPath();
  ctx.arc(coinCx, coinCy, coinR, 0, Math.PI * 2);
  ctx.fillStyle = coin;
  ctx.fill();
  ctx.fillStyle = C.goldBright;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.9)";
  ctx.shadowBlur = 2;
  ctx.shadowOffsetY = 1;
  ctx.fillText(costText, coinCx + coinR + gap, coinCy);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

export interface BuildImageMeta {
  title: string;
  subtitle: string;
}

/** Render the build (commander + selected units, in order) to a PNG blob. */
export async function renderBuildImage(
  index: RosterIndex,
  build: BuildState,
  meta: BuildImageMeta,
): Promise<Blob> {
  const staffCard = build.staffSlotUnitKey ? index.byKey.get(build.staffSlotUnitKey) : undefined;
  const units = build.instances
    .map((i) => index.byKey.get(i.unitKey))
    .filter((c): c is UnitCard => Boolean(c));

  const cards: { card: UnitCard; commander: boolean }[] = [];
  if (staffCard) cards.push({ card: staffCard, commander: true });
  for (const u of units) cards.push({ card: u, commander: false });

  // Preload icons in parallel (null → fallback tile). Same-origin, so no taint.
  const cells: CellData[] = await Promise.all(
    cards.map(async ({ card, commander }) => {
      const src = assetUrl(card.icon);
      const icon = src ? await loadImage(src) : null;
      return { card, commander, icon };
    }),
  );

  // Widths: each cell is CELL_W; the gap after the commander carries the divider.
  const gapBefore = (i: number) => (i === 0 ? 0 : i === 1 && staffCard ? DIVIDER_W : GAP);
  let contentW = 0;
  cells.forEach((_, i) => (contentW += gapBefore(i) + CELL_W));
  const width = Math.max(MIN_WIDTH, PAD * 2 + contentW);

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  // Header layout: title left, subtitle right-aligned on the same line — unless the
  // two would collide (a long corps name on a narrow, few-unit strip), in which case
  // the subtitle drops to its own line under the title rather than being overdrawn.
  const titleFont = `600 19px ${SERIF}`;
  const subFont = `12px ${SANS}`;
  const inner = width - PAD * 2;
  ctx.font = titleFont;
  const titleW = ctx.measureText(meta.title).width;
  ctx.font = subFont;
  const subW = ctx.measureText(meta.subtitle).width;
  const stacked = titleW + HEADER_GAP + subW > inner;
  const headerH = HEADER_H + (stacked ? SUBTITLE_LINE_H : 0);
  const height = PAD + headerH + TOP_PAD + PORTRAIT_H + COST_H + PAD;

  // Sizing the canvas resets its context state, so scale after.
  canvas.width = Math.round(width * OUTPUT_SCALE);
  canvas.height = Math.round(height * OUTPUT_SCALE);
  ctx.scale(OUTPUT_SCALE, OUTPUT_SCALE);

  // Background.
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, C.bgTop);
  bg.addColorStop(1, C.bgBottom);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Header: title (left, serif gold) + subtitle (right, soft — or under the title
  // when stacked) + divider line. maxWidth only squeezes text that still can't fit.
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.goldBright;
  ctx.font = titleFont;
  ctx.textAlign = "left";
  ctx.fillText(meta.title, PAD, PAD + 22, inner);
  ctx.fillStyle = C.textSoft;
  ctx.font = subFont;
  if (stacked) {
    ctx.fillText(meta.subtitle, PAD, PAD + 22 + SUBTITLE_LINE_H, inner);
  } else {
    ctx.textAlign = "right";
    ctx.fillText(meta.subtitle, width - PAD, PAD + 21);
  }
  ctx.strokeStyle = C.goldDeep;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD, PAD + headerH - 8);
  ctx.lineTo(width - PAD, PAD + headerH - 8);
  ctx.stroke();

  // Cells.
  const portraitTop = PAD + headerH + TOP_PAD;
  let x = PAD;
  cells.forEach((cell, i) => {
    x += gapBefore(i);
    // Divider line between the commander and the first unit.
    if (i === 1 && staffCard) {
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const dx = x - DIVIDER_W / 2;
      ctx.moveTo(dx, portraitTop - 2);
      ctx.lineTo(dx, portraitTop + PORTRAIT_H + 2);
      ctx.stroke();
    }
    drawCell(ctx, cell, x, portraitTop);
    x += CELL_W;
  });

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png");
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** How an export ended. "downloaded" means a download was *started* — whether it
 *  landed can't be known (an installed iOS web app silently drops blob downloads),
 *  so callers must not report it as saved. */
export type DeliverResult = "copied" | "shared" | "cancelled" | "downloaded";

const errorName = (e: unknown) => (e instanceof Error || e instanceof DOMException ? e.name : "");

/** Open the share sheet for the image, falling back to a download. Must be called
 *  straight from a user gesture (a tap handler, before any await): browsers — WebKit
 *  strictly — refuse navigator.share once that gesture's activation has lapsed. */
export async function shareImageFile(file: File): Promise<DeliverResult> {
  try {
    await navigator.share({ files: [file] });
    return "shared";
  } catch (e) {
    // User dismissed the sheet — handled; don't also download.
    if (errorName(e) === "AbortError") return "cancelled";
    downloadBlob(file, file.name);
    return "downloaded";
  }
}

/** Send the image to the device: clipboard on desktop, share sheet (else download)
 *  on touch. Call it synchronously from the click handler with the render still in
 *  flight: the clipboard write is started at once with the pending image (a
 *  Promise-valued ClipboardItem), inside the click's user activation.
 *
 *  The share sheet can't take a pending file, so on touch it is only tried once the
 *  render is done. When the browser then refuses it for lack of a fresh gesture
 *  (NotAllowedError — WebKit, after a slow render), the file comes back as
 *  `{ retryShare }` for the caller to offer behind a new tap (see shareImageFile). */
export async function deliverImage(
  image: Promise<Blob>,
  filename: string,
  coarse: boolean,
): Promise<DeliverResult | { retryShare: File }> {
  // Desktop / fine pointer: copy the PNG to the clipboard.
  if (!coarse && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": image })]);
      return "copied";
    } catch {
      // Clipboard blocked (permissions, insecure context, no Promise support) →
      // fall back to download.
    }
  }

  const blob = await image;

  // Phones / tablets: prefer the native share sheet (lets iOS "Save Image" to
  // Photos, which a blob download can't do in a standalone PWA); else download.
  if (coarse && typeof navigator.canShare === "function") {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return "shared";
      } catch (e) {
        const name = errorName(e);
        if (name === "AbortError") return "cancelled";
        // The render outlasted the tap's activation: ask for a fresh tap.
        if (name === "NotAllowedError") return { retryShare: file };
        // Any other failure → fall through to a direct download.
      }
    }
  }

  downloadBlob(blob, filename);
  return "downloaded";
}
