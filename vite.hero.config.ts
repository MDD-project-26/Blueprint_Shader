import path from "path"
import { defineConfig } from "vite"

// Production build for the homepage hero embed — a separate build from
// vite.config.ts (the dev-tool build) so main.js is tree-shaken
// independently per build. `__HERO__` is replaced with the literal `true`
// here, which lets Terser physically strip every `if (!IS_HERO) { ... }`
// block in main.js (keyboard shortcuts, drag/pan/zoom, flow-arrow drawing,
// photo mode, perf-monitor/axis-gizmo, model upload, the React panel
// bridge) from this build's output — none of that code, or React/Tailwind/
// Base UI, ends up in dist-hero/.
//
// Run with: pnpm exec vite build --config vite.hero.config.ts
export default defineConfig({
  define: {
    __HERO__: "true",
    // main.js's battery-embed flag (see vite.battery-embed.config.ts): spelled
    // out so its embed-only branches are stripped here too.
    __EMBED__: "false",
  },
  build: {
    outDir: "dist-hero",
    rollupOptions: {
      input: path.resolve(__dirname, "hero.html"),
    },
  },
})
