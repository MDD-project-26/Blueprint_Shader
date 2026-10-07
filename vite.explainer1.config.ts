import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Production build for the "explainer 1" FE handover — the scroll canvas
// (see handover/HANDOVER.md Part B), isolated into its own handover/dist-explainer-1/ output
// with no other HTML entry alongside it (vite.config.ts's default build
// bundles index.html/scroll.html/scroll-preview.html/scroll-embed.html
// together), so the folder handed to FE contains exactly what they need and
// nothing else to sort through. Not tree-shaken like vite.hero.config.ts/
// vite.canvas.config.ts — the info card ships as-is (full React/Tailwind),
// so this only needs its own outDir, not a __HERO__ strip.
//
// A future "explainer 2" (different model/flow) gets its own sibling config
// the same way — copy this file, change entry/outDir, add a build:explainerN
// script.
//
// Run with: pnpm build:explainer1
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "handover/dist-explainer-1",
    rollupOptions: {
      input: path.resolve(__dirname, "scroll-embed.html"),
    },
  },
})
