import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Desktop-first NTW3 army builder. Relative base keeps the production build
// portable (it can be opened from any sub-path or via file server).
export default defineConfig({
  base: "./",
  plugins: [react()],
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
