import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Desktop-first NTW3 army builder. Relative base keeps the production build
// portable (it can be opened from any sub-path or via file server) and is what
// makes the same build serve as an installable PWA from a GitHub Pages sub-path.
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    VitePWA({
      // Hand-written service worker (src/sw.ts) so we control the data-version-keyed
      // runtime caches; Workbox only injects the precache manifest.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt", // waiting worker activates only via the in-app toast
      injectRegister: false, // registration is done manually in pwa.ts (Electron-guarded)
      manifest: {
        name: "Registre des Armées — NTW3 Army Builder",
        short_name: "Registre",
        description: "Napoleon Total War 3 army builder — build, price and save corps offline.",
        lang: "fr",
        display: "standalone",
        orientation: "any",
        start_url: ".",
        scope: "./",
        theme_color: "#15223f",
        background_color: "#0f1318",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "pwa-maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      injectManifest: {
        // Precache the shell + corps picker + tiny data stamps ONLY. The 13.6k
        // unit icons and 297 faction JSONs are runtime-cached (see src/sw.ts) —
        // never list assets/icons or data/factions here.
        globPatterns: [
          "**/*.{js,css,html}",
          "pwa-*.png",
          "apple-touch-icon.png",
          "assets/ui/**",
          "assets/army_corps_by_theatre/**",
          "data/corps-index.json",
          "data/data-version.json",
        ],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1500,
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
