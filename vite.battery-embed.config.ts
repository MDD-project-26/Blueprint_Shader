import fs from "fs"
import path from "path"
import { defineConfig, type Plugin } from "vite"
import { writeHandoverGuide } from "./vite.battery.shared"

// Production build of the battery scenes as one ES module for the FE team's
// single-page app (see handover/HANDOVER.md Part E): battery-embed.js →
// handover/dist-battery-embed/assets/battery-embed.js, exporting
// createBatteryScene. It replaces the two page-style handovers
// (vite.battery.config.ts, vite.battery-sideways.config.ts) on their site: no
// React/Tailwind, no stylesheet, no built-in controls, no element ids, and a
// destroy().
//
// Two things make that possible, both specific to this config:
//
// - `__EMBED__` is replaced with the literal `true` (and `__HERO__` with
//   `false`), so every tool-only block in main.js is stripped the same way
//   vite.hero.config.ts strips them for the hero.
// - sceneFactory compiles main.js into a function. As written, main.js is a
//   page script: one canvas, one set of module-level state, running once when
//   it loads. Wrapping its body in `export function createScene(embedScene)`
//   turns that state into one scene's own, so each call is an independent
//   scene that can be destroyed and created again. Every other build still
//   gets main.js exactly as written.
//
// Run with: pnpm build:battery-embed (pnpm dev:battery-embed serves
// battery-embed.html, a reference page with host-built controls).
const OUT_DIR = "handover/dist-battery-embed"
const MODELS = ["NGEN_assets", "EP5-battery-stack", "EP12-battery-stack"]

function sceneFactory(): Plugin {
  const mainJs = path.resolve(__dirname, "main.js")
  return {
    name: "battery-embed-scene-factory",
    enforce: "pre",
    transform(code, id) {
      if (id.split("?")[0] !== mainJs) return null
      // The imports stay at module level; everything after them is the scene.
      const imports = [...code.matchAll(/^import .*;$/gm)]
      const last = imports.at(-1)
      if (!last) throw new Error("main.js: expected its imports at the top")
      const split = last.index + last[0].length
      // `controls` is the React panel's bridge; nothing imports it here.
      const body = code.slice(split).replace(/^export const controls = /m, "const controls = ")
      if (/^(import|export) /m.test(body)) throw new Error("main.js: an import or export below the top would end up inside createScene")
      return { code: `${code.slice(0, split)}\nexport function createScene(embedScene) {${body}\n}\n`, map: null }
    },
  }
}

function handoverFiles(): Plugin {
  return {
    name: "battery-embed-handover-files",
    apply: "build",
    closeBundle() {
      const out = path.resolve(__dirname, OUT_DIR)
      // Under models/battery/, the folder the FE team serves them from.
      const modelsDir = path.join(out, "models/battery")
      fs.mkdirSync(modelsDir, { recursive: true })
      for (const model of MODELS) {
        for (const extension of ["obj", "mtl"]) {
          fs.copyFileSync(path.resolve(__dirname, `public/models/${model}.${extension}`), path.join(modelsDir, `${model}.${extension}`))
        }
      }
      fs.copyFileSync(path.resolve(__dirname, "battery-embed.d.ts"), path.join(out, "assets/battery-embed.d.ts"))
      // The reference page, pointed at this folder's own files so it runs
      // from any static server started here.
      const example = fs.readFileSync(path.resolve(__dirname, "battery-embed.html"), "utf8")
        .replace('"/battery-embed.js"', '"./assets/battery-embed.js"')
        .replace('"/models/"', '"./models/battery/"')
      fs.writeFileSync(path.join(out, "example.html"), example)
      writeHandoverGuide(out, "Part E")
    },
  }
}

export default defineConfig(({ command }) => ({
  plugins: [sceneFactory(), handoverFiles()],
  define: {
    __EMBED__: "true",
    __HERO__: "false",
  },
  // The dev server serves the models from public/; the build copies just the
  // battery ones itself (see handoverFiles).
  publicDir: command === "build" ? false : "public",
  server: {
    port: 8002,
    open: "/battery-embed.html",
  },
  build: {
    outDir: OUT_DIR,
    modulePreload: false,
    rollupOptions: {
      input: path.resolve(__dirname, "battery-embed.js"),
      preserveEntrySignatures: "strict",
      output: {
        format: "es",
        entryFileNames: "assets/battery-embed.js",
      },
    },
  },
}))
