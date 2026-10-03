import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 8001,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      // Vite only bundles index.html by default — scroll.html is the same
      // tool (full panel, same main.tsx/main.js), just gated at runtime by
      // its own data-scroll="true" attribute (see IS_SCROLL_ROUTE in
      // main.js), so it belongs in this same build rather than a separate
      // one like hero.html/canvas.html (which tree-shake a different,
      // __HERO__-stripped bundle). Without an explicit entry here it never
      // made it into dist/, which is why it 404'd once deployed even though
      // `pnpm dev` could always serve it directly from disk. scroll-preview
      // .html is the same story — same main.js, just its own HTML with no
      // panel/perf-monitor/axis-gizmo. scroll-embed.html (the FE-team
      // handover reference, see its own comments and HANDOVER.md) is the
      // same story again — same bundle, not tree-shaken (the info card
      // ships as-is), just its own HTML demonstrating the sticky-section
      // embed structure. battery.html is index.html plus data-battery="true"
      // (see IS_BATTERY_ROUTE in main.js); battery-preview.html is that plus
      // data-preview="true", the same panel-free treatment as scroll-preview.
      input: {
        main: path.resolve(__dirname, "index.html"),
        scroll: path.resolve(__dirname, "scroll.html"),
        scrollPreview: path.resolve(__dirname, "scroll-preview.html"),
        scrollEmbed: path.resolve(__dirname, "scroll-embed.html"),
        battery: path.resolve(__dirname, "battery.html"),
        batteryPreview: path.resolve(__dirname, "battery-preview.html"),
      },
    },
  },
})
