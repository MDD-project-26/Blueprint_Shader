import fs from "fs"
import path from "path"
import type { Plugin } from "vite"

// Shared by the two battery handover builds (vite.battery.config.ts and
// vite.battery-sideways.config.ts) so each output folder holds exactly one
// canvas and only the files that canvas loads:
//
// - `strip` names a block of the reference page that belongs to the other
//   canvas, marked in the HTML as <!-- only:NAME:start --> … <!-- only:NAME:end -->,
//   and removes it from the built page.
// - `models` lists the public/models/ files (without extension) this canvas
//   fetches; every other model, and the hero-only public/hero/, is deleted
//   from the output after Vite has copied public/ across.
// - `guide` names this canvas's part of handover/HANDOVER.md ("Part C"); that
//   section alone is written into the output as its own HANDOVER.md, so the
//   folder can be sent without the rest of the guide.
export function batteryHandover({ outDir, models, guide, strip }: { outDir: string; models: string[]; guide: string; strip?: string }): Plugin {
  return {
    name: "battery-handover",
    transformIndexHtml(html) {
      if (!strip) return html
      return html.replace(new RegExp(`[ \\t]*<!-- only:${strip}:start -->[\\s\\S]*?<!-- only:${strip}:end -->\\n?`, "g"), "")
    },
    closeBundle() {
      const out = path.resolve(__dirname, outDir)
      fs.rmSync(path.join(out, "hero"), { recursive: true, force: true })
      const modelsDir = path.join(out, "models")
      for (const file of fs.existsSync(modelsDir) ? fs.readdirSync(modelsDir) : []) {
        if (!models.includes(path.parse(file).name)) fs.rmSync(path.join(modelsDir, file))
      }
      writeHandoverGuide(out, guide)
    },
  }
}

// Writes one part of handover/HANDOVER.md ("Part C") into `out` as that
// folder's own HANDOVER.md, so the folder can be sent without the rest of the
// guide. Also used by vite.battery-embed.config.ts.
export function writeHandoverGuide(out: string, guide: string) {
  const full = fs.readFileSync(path.resolve(__dirname, "handover/HANDOVER.md"), "utf8")
  const section = full.split(/^(?=## Part )/m).find(part => part.startsWith(`## ${guide}:`))
  if (!section) throw new Error(`handover/HANDOVER.md has no "${guide}" section`)
  const folder = path.basename(out)
  fs.writeFileSync(path.join(out, "HANDOVER.md"), [
    `# ${section.split("\n")[0].replace(/^## Part \w+: /, "").replace(/^./, first => first.toUpperCase())} — integration guide`,
    "",
    `This file sits inside \`${folder}/\`, the folder it describes: a path`,
    `written as \`${folder}/assets/\` below means \`assets/\` right here. It is`,
    `${guide} of the project's full guide; any other "Part" it mentions is a`,
    "different canvas that isn't in this folder.",
    "",
    section.replace(/\n---\s*$/, "\n").replace(/^(#+) /gm, (_, hashes) => `${hashes.length > 2 ? "##" : "#"} `).replace(/^# .*\n/, "").trim(),
    "",
  ].join("\n"))
}
