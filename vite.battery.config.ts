import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Production build for the battery stack FE handover (see HANDOVER.md
// Part C), isolated into its own dist-battery/ output with no other HTML
// entry alongside it — same reasoning as vite.explainer1.config.ts: the
// default build bundles every route together, so this gives FE a folder
// containing exactly what they need. Not tree-shaken like vite.hero.config.ts/
// vite.canvas.config.ts — the count slider ships as-is (full React/Tailwind),
// so this only needs its own outDir, not a __HERO__ strip.
//
// Run with: pnpm build:battery
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist-battery",
    rollupOptions: {
      input: path.resolve(__dirname, "battery-preview.html"),
    },
  },
})
