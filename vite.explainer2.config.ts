import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Production build for the "explainer 2" FE handover — same scroll canvas
// (see handover/HANDOVER.md Part B, and vite.explainer1.config.ts's own comment for
// the full reasoning), just isolated into its own handover/dist-explainer-2/ output.
// Same scroll-embed.html entry as explainer 1 — the two "explainers" are
// successive handoff deliverables built from the same route/component as it
// evolves (new model, new flow arrows, new card copy each time), not two
// independently switchable variants that coexist in the running app.
//
// Run with: pnpm build:explainer2
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "handover/dist-explainer-2",
    rollupOptions: {
      input: path.resolve(__dirname, "scroll-embed.html"),
    },
  },
})
