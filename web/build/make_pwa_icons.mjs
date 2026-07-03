// Generate the PWA icon set from the app's master icon (icon_1024.png, itself
// produced by make_icon.py — the Napoleonic eagle on the navy tile).
//
// Outputs into web/public/ so they are served at stable, versionless URLs the
// web manifest and index.html can reference:
//   pwa-192x192.png / pwa-512x512.png   — "any" purpose (home-screen / install)
//   pwa-maskable-512x512.png            — "maskable" (logo inside the 80% safe zone)
//   apple-touch-icon.png                — iOS home screen (180, opaque)
//
// The outputs are committed, so `sharp` is an on-demand tool, not a permanent
// dependency (like make_icon.py's Pillow). Regenerate with:
//   npm i -D sharp && node build/make_pwa_icons.mjs && npm uninstall sharp
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "icon_1024.png");
const OUT = path.join(here, "..", "public");
const NAVY = { r: 21, g: 34, b: 63, alpha: 1 }; // matches make_icon.py NAVY

async function plain(size, file) {
  await sharp(SRC).resize(size, size, { kernel: "lanczos3" }).png().toFile(path.join(OUT, file));
}

// Maskable: shrink the whole tile so the logo sits within the maskable safe
// zone (central 80%), on a full-bleed navy background the platform can crop.
async function maskable(size, inner, file) {
  const logo = await sharp(SRC).resize(inner, inner, { kernel: "lanczos3" }).png().toBuffer();
  const pad = Math.round((size - inner) / 2);
  await sharp({ create: { width: size, height: size, channels: 4, background: NAVY } })
    .composite([{ input: logo, top: pad, left: pad }])
    .png()
    .toFile(path.join(OUT, file));
}

// Apple touch icon is never masked and iOS adds its own rounded corners, so a
// flat opaque square (navy already fills the tile) at 180 is ideal.
async function appleTouch() {
  await sharp(SRC).resize(180, 180, { kernel: "lanczos3" }).flatten({ background: NAVY }).png()
    .toFile(path.join(OUT, "apple-touch-icon.png"));
}

await plain(192, "pwa-192x192.png");
await plain(512, "pwa-512x512.png");
await maskable(512, 400, "pwa-maskable-512x512.png"); // 400/512 ≈ 78% → inside safe zone
await appleTouch();
console.log("wrote pwa-192x192, pwa-512x512, pwa-maskable-512x512, apple-touch-icon into web/public");
