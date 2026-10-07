import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { batteryHandover } from "./vite.battery.shared"

// Production build for the battery stack FE handover (see handover/HANDOVER.md
// Part C), isolated into its own handover/dist-battery/ output with no other HTML
// entry alongside it — same reasoning as vite.explainer1.config.ts: the
// default build bundles every route together, so this gives FE a folder
// containing exactly what they need. Not tree-shaken like vite.hero.config.ts/
// vite.canvas.config.ts — the count slider ships as-is (full React/Tailwind),
// so this only needs its own outDir, not a __HERO__ strip.
//
// battery-preview.html also demos the EP5/EP12 sideways canvas in an iframe;
// that block is stripped here, since the sideways canvas is handed over
// separately (vite.battery-sideways.config.ts → handover/dist-battery-sideways/).
//
// Run with: pnpm build:battery
export default defineConfig({
  plugins: [react(), tailwindcss(), batteryHandover({
    outDir: "handover/dist-battery",
    models: ["NGEN_assets"],
    guide: "Part C",
    strip: "sideways",
  })],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "handover/dist-battery",
    rollupOptions: {
      input: path.resolve(__dirname, "battery-preview.html"),
    },
  },
})
