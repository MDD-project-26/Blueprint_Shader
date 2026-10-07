import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { batteryHandover } from "./vite.battery.shared"

// Production build for the EP5/EP12 sideways battery FE handover (see
// handover/HANDOVER.md Part D), isolated into its own handover/dist-battery-sideways/ output —
// the sibling of vite.battery.config.ts, which builds the vertical stack on
// its own the same way. Not tree-shaken either: the model buttons and count
// slider ship as-is (full React/Tailwind).
//
// Run with: pnpm build:battery-sideways
export default defineConfig({
  plugins: [react(), tailwindcss(), batteryHandover({
    outDir: "handover/dist-battery-sideways",
    models: ["EP5-battery-stack", "EP12-battery-stack"],
    guide: "Part D",
  })],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "handover/dist-battery-sideways",
    rollupOptions: {
      input: path.resolve(__dirname, "battery-sideways.html"),
    },
  },
})
