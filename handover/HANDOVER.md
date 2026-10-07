# Bluprint canvas — integration guide

Every `dist-*` folder named below sits next to this file, in the repo's
`handover/` folder, with a ready-to-send `.zip` of each beside it. The build
commands write straight into this folder.

Five separate embeds live in this repo, built independently — pick whichever
one you're integrating. For the batteries on the NGEN site, that is Part E:
Parts C and D are the same two scenes as standalone pages with their own
controls, kept as visual references.

- **Part A: hero canvas** — a button-triggered 3D scene (`dist-canvas/`, built
  from `canvas.html` via `pnpm build:canvas`). You build your own title/cards
  UI and trigger camera moves from it via `window.heroScene`.
- **Part B: scroll canvas** — a scroll-driven 3D scene with a pre-built
  bottom-left info card (`dist/scroll-embed.html` + `dist/assets/`, built from
  `scroll-embed.html` via the ordinary `pnpm build`). No buttons to wire up —
  scrolling through the section is the entire interaction, and the card ships
  as part of the bundle.
- **Part C: battery stack** — a 3D NGEN battery whose module count (3–9) is
  set with a built-in slider (`dist-battery/`, built from
  `battery-preview.html` via `pnpm build:battery`). One self-contained
  section that sits in normal page flow; no buttons or API to wire up.
- **Part D: EP5/EP12 sideways batteries** — the EP5 and EP12 side by side in
  one 3D scene, with built-in model buttons and a count slider (1–4)
  (`dist-battery-sideways/`, built from `battery-sideways.html` via
  `pnpm build:battery-sideways`). Handed over separately from Part C.
- **Part E: battery embed module** — both battery scenes as one ES module
  with no UI of its own (`dist-battery-embed/`, built from `battery-embed.js`
  via `pnpm build:battery-embed`). You build the slider and buttons, and drive
  the canvas through `createBatteryScene`. Made for a single-page app: any
  number of scenes per page, each with a `destroy()`.

They're unrelated bundles (different entry points, different build configs)
— don't mix pieces from one into the other.

## Part A: hero canvas (button-triggered)

This folder is a self-contained build of the 3D hero canvas. `canvas.html` is a
working reference only (open it to see the expected behavior) — you won't
embed it directly. `favicon.png` and `hero/eyebrow-dot.svg` are unused
leftovers, safe to ignore/delete.

### 1. Load the script

```html
<canvas id="canvas"></canvas>
<script type="module" src="/assets/canvas-XXXXXXXX.js"></script>
```

(`canvas-XXXXXXXX.js` — use the actual filename inside `assets/`, it's
content-hashed.)

Host `assets/canvas-*.js` yourself (path can be anything). The `<canvas
id="canvas">` element is required — the script looks it up by that id.

### 2. Size and position the canvas

The canvas has no layout opinion beyond filling its own box — put it wherever
your hero section needs it (e.g. `position: absolute; inset: 0;` inside a
`position: relative` container), same as any background layer. Your title/
cards UI layers on top as normal.

### 3. Host the 3D model

Copy the `models/` folder as-is so it's served at
`/models/sg_connect_scroll_explainer.obj` and
`/models/sg_connect_scroll_explainer.mtl` **relative to your site root** —
that exact path is hardcoded in the script. If your hosting can't serve from
root, tell us and we'll make the path configurable before you integrate.

### 4. (If your UI overlaps the canvas) exclude it from touch-drag

On mobile, touching the canvas tilts the model. If your title/cards sit on
top of the canvas, point this at their wrapper so users can still
touch-scroll over them:

```html
<canvas id="canvas" data-hero-content-selector="#your-hero-overlay"></canvas>
```

Skip this only if nothing of yours visually overlaps the canvas.

### 5. Wire your buttons to the camera

Once the script has run, `window.heroScene` is available:

```js
window.heroScene.goToTarget(0)      // jump to camera target 0, 1, or 2
window.heroScene.goToDefault()      // return to the default view
window.heroScene.getActiveTarget()  // currently active index, or null
window.heroScene.onTargetChange(cb) // cb(index) on every change; returns an unsubscribe fn
```

There are exactly 3 targets (0–2), matching the 3 scenes baked into the
model. That's the entire camera API — everything else (tilt, parallax) is
automatic.

## Part B: scroll canvas (scroll-driven, card included)

`scroll-embed.html` is the working reference — open it (or `pnpm build` then
serve `dist/scroll-embed.html`) to see the expected behavior, including the
two dark placeholder sections proving it works embedded mid-page with your
own content above and below. Read that file's own top HTML comment too; this
section summarizes the same contract.

### 1. Copy the DOM structure

```html
<div id="scroll-track">
  <div id="scroll-stage">
    <canvas id="canvas" data-scroll="true" data-preview="true"></canvas>
    <div id="perf-monitor"><div id="perf-monitor-text"></div><canvas id="perf-history" width="140" height="32"></canvas></div>
    <canvas id="axis-gizmo" width="84" height="84"></canvas>
    <div id="react-controls-root"></div>
  </div>
</div>
<script type="module" src="/assets/main-XXXXXXXX.js"></script>
<link rel="stylesheet" href="/assets/main-XXXXXXXX.css">
```

Copy this nesting (and the CSS in `scroll-embed.html`'s `<head>` for
`#scroll-track`/`#scroll-stage`/`#perf-monitor`/`#axis-gizmo`) as-is — it's
load-bearing, not just a reference layout:

- `#scroll-track` gets its height set automatically by the script (based on
  how many Camera Targets the model has) — the value in the CSS is only a
  placeholder for the instant before that runs.
- `#scroll-stage` being `position: sticky` is what pins the canvas while you
  scroll through this section and releases it back into normal flow once you
  scroll past — no JS show/hide needed. Its `transform` isn't decorative:
  per spec it makes this element a containing block for `position: fixed`
  descendants, which is what scopes the bottom-left info card (and every
  other fixed-positioned overlay in that same bundle) to this section instead
  of the whole page.
- `#perf-monitor`/`#axis-gizmo` must stay in the DOM (hidden via CSS) even
  though you'll never see them — the script looks them up unconditionally and
  isn't null-safe around them.

Put your own page content in normal document flow before and after this
block, same as `scroll-embed.html`'s own two placeholder sections.

### 2. Load the script and stylesheet

This bundle is **not** tree-shaken like Part A's — it ships the full
React/Tailwind bundle because the info card is pre-built rather than
something you build yourselves. Load both the JS bundle and its CSS bundle
(`dist/assets/main-*.js` / `main-*.css`, content-hashed — use the actual
filenames, or keep the `<script>`/`<link>` tags Vite already generated in
`dist/scroll-embed.html` if you're copying that markup directly).

Unlike Part A's script, **this one isn't freely relocatable**: `main-*.css`
loads its webfonts (Inter, Geist Mono) via root-absolute `/assets/...` URLs
baked in at build time. Copy the entire `dist/assets/` folder as-is and serve
it at `/assets/` from your site root — not just the two hashed `main-*`
files. If your hosting can't serve `/assets/` from root, tell us and we'll
adjust the build's asset base path before you integrate.

### 3. Host the 3D model

Same as Part A — copy `models/` as-is so
`/models/sg_connect_scroll_explainer.obj`/`.mtl` resolve from your site root.

### 4. That's it — no API to wire up

Camera Target assignments and the info card's copy/icons are already baked
in (the model's own "Target_N" naming drives the camera; the card's content
is bundled). Scrolling through the section is the entire interaction — there's
no `window.heroScene`-style trigger API for this build, and no touch-drag
gesture either (only scroll and passive hover-parallax).

## Part C: battery stack (slider-driven, sits in page flow)

`battery-preview.html` is the working reference — run `pnpm build:battery`
and serve `dist-battery/battery-preview.html` (or `pnpm preview:battery`) to
see the expected behavior. The two dark placeholder sections above and below
the battery are only there to make the page scroll, the way your own page
will. Read that file's own top HTML comment too; this section covers the same
contract.

In the repo, `battery-preview.html` also demos the Part D canvas below this
one, in an iframe. The `dist-battery/` build strips that out, so the folder
you receive contains the vertical stack only.

### 1. Copy the DOM structure

```html
<div id="battery-stage">
  <canvas id="canvas" data-battery="true" data-preview="true"></canvas>
  <div id="perf-monitor"><div id="perf-monitor-text"></div><canvas id="perf-history" width="140" height="32"></canvas></div>
  <canvas id="axis-gizmo" width="84" height="84"></canvas>
  <div id="react-controls-root"></div>
</div>
<script type="module" src="/assets/battery-preview-XXXXXXXX.js"></script>
<link rel="stylesheet" href="/assets/battery-preview-XXXXXXXX.css">
```

Copy this block, and the CSS in `battery-preview.html`'s `<head>` for
`#battery-stage`, `canvas#canvas`, `#perf-monitor` and `#axis-gizmo`:

- `#battery-stage` is the module's own box. Everything it draws stays inside
  it. Size it however your layout needs — the reference uses a full viewport
  (`height: 100svh`) — and put it in normal document flow between your own
  sections. It must keep `position: relative` (the count slider is positioned
  against it) and `overflow: hidden`.
- Both `data-battery="true"` and `data-preview="true"` on the canvas are
  required. Together they select this embed's behavior; with either one
  missing you get a different route of the internal tool.
- `canvas#canvas` keeps `touch-action: pan-y`, so a finger on the canvas
  scrolls the page.
- `#perf-monitor`/`#axis-gizmo` must stay in the DOM (hidden via CSS) even
  though you'll never see them — the script looks them up unconditionally and
  isn't null-safe around them. Same constraint as Part B.
- `#react-controls-root` is where the count slider mounts.

Leave behind the two `.demo-placeholder` sections and `.render-statuses` (the
"Rendering / Paused" pill in the corner): they are demo aids, and the script
doesn't need either.

### 2. Load the script and stylesheet

Like Part B, this bundle is **not** tree-shaken — it ships the full
React/Tailwind bundle because the slider is pre-built. Load both
`dist-battery/assets/battery-preview-*.js` and `battery-preview-*.css`
(content-hashed — use the actual filenames, or keep the `<script>`/`<link>`
tags Vite generated in `dist-battery/battery-preview.html`).

It isn't freely relocatable either: the stylesheet loads its webfonts through
root-absolute URLs baked in at build time. Copy `dist-battery/assets/` and
`dist-battery/fonts/` as-is and serve them at `/assets/` and `/fonts/` from
your site root. If your hosting can't serve from root, tell us and we'll
adjust the build's asset base path before you integrate.

### 3. Host the 3D model

Copy `dist-battery/models/NGEN_assets.obj` and `NGEN_assets.mtl` so they're
served at `/models/NGEN_assets.obj` and `/models/NGEN_assets.mtl` **relative
to your site root** — that exact path is hardcoded in the script. They are the
only two files in `dist-battery/models/`. `favicon.png` is only used by the
reference page.

### 4. That's it — no API to wire up

Everything below is built in:

- **Start.** Once the model has loaded, the stack shows three modules held
  slightly apart (50px on screen). When all but the last 200px of the canvas
  has scrolled into view, they ease together into the assembled stack (800ms).
  This plays once per page load.
- **Slider.** A horizontal slider at the bottom center of the stage sets the
  number of modules, 3 to 9; the numbers under it are click targets too.
  Added modules slide and fade in beneath the top unit, removed ones slide
  and fade out, and the camera re-centers on the stack as it grows or shrinks.
- **Pointer.** Dragging with a mouse rotates the model. The mouse wheel and
  touch are left alone, so both scroll your page as usual.
- **Background.** The canvas paints its own opaque white background.
- **Reduced motion.** With `prefers-reduced-motion: reduce`, the stack appears
  assembled and count changes apply instantly.

It also keeps out of the host page's way:

- **Off screen, it stops.** Rendering halts once the stage is more than about
  200px outside the viewport and resumes as it comes back, so it costs nothing
  while the user is elsewhere on the page.
- **No keyboard shortcuts, no file-drop handling.** Space, arrows and typing
  behave as they do on the rest of your page.
- **It follows its own box.** If your layout resizes `#battery-stage`, the
  canvas re-fits; a window resize isn't required.

### 5. Things to know before you integrate

- **The stylesheet is global.** It includes Tailwind's base reset plus this
  project's own base rules, which set `body` background and text color, the
  `html` font, and a default border color on every element. Loaded on your
  page as-is, it will restyle parts of the page outside the battery. If that
  conflicts with your own styles, tell us and we'll scope the stylesheet to
  `#battery-stage` before you integrate.
- **One instance per page.** The script finds its elements by id (`canvas`,
  `react-controls-root`, …), so it can't be embedded twice on one page, and
  none of those ids can be reused elsewhere on it. It also can't share a page
  with Part A, B or D, which use the same ids — except by putting the other
  one in an iframe (see Part D).
- **No teardown.** The script starts when it loads and has no `destroy()`. On
  a regular page load that's fine. If your site is a single-page app that
  mounts and removes this section without a full reload, its listeners and
  WebGL context would outlive the section — tell us and we'll add a teardown
  call.
- **No count API.** The built-in slider is the only way to change the number
  of modules. If you need to drive it from your own UI, or read the current
  count, tell us and we'll expose it, the way Part A exposes
  `window.heroScene`.

---

## Part D: EP5/EP12 sideways batteries (model buttons + slider)

`battery-sideways.html` is the working reference — run
`pnpm build:battery-sideways` and serve
`dist-battery-sideways/battery-sideways.html` (or
`pnpm preview:battery-sideways`). It is a separate bundle from Part C with its
own output folder; nothing in `dist-battery/` is needed here, and nothing here
is needed for Part C.

### 1. Copy the DOM structure

```html
<section id="battery-stage" aria-label="Sideways battery stacking">
  <canvas id="canvas" data-battery="true" data-preview="true" data-stacking="sideways"></canvas>
  <h1 class="module-title">EP5 / EP12 · Sideways stacking</h1>
  <div id="perf-monitor"><div id="perf-monitor-text"></div><canvas id="perf-history" width="140" height="32"></canvas></div>
  <canvas id="axis-gizmo" width="84" height="84"></canvas>
  <div id="react-controls-root"></div>
</section>
<script type="module" src="/assets/battery-sideways-XXXXXXXX.js"></script>
<link rel="stylesheet" href="/assets/battery-sideways-XXXXXXXX.css">
```

Copy this block, and the CSS in `battery-sideways.html`'s `<head>`:

- `#battery-stage` is the module's own box. Everything it draws stays inside
  it. Size it however your layout needs — the reference uses a full viewport
  (`height: 100svh`) — and put it in normal document flow between your own
  sections. It must keep `position: relative` (the controls are positioned
  against it) and `overflow: hidden`.
- All three canvas attributes are required: `data-battery="true"`,
  `data-preview="true"` and `data-stacking="sideways"`. Without the third you
  get the vertical stack instead; with either of the first two missing you
  get a different route of the internal tool.
- `canvas#canvas` keeps `touch-action: pan-y`, so a finger on the canvas
  scrolls the page.
- `#perf-monitor`/`#axis-gizmo` must stay in the DOM (hidden via CSS) even
  though you'll never see them — the script looks them up unconditionally and
  isn't null-safe around them.
- `#react-controls-root` is where the model buttons and count slider mount.
- `.module-title` is plain HTML over the canvas and is yours to restyle,
  reword or delete; the script doesn't look for it.

### 2. Load the script and stylesheet

This bundle is **not** tree-shaken — it ships the full React/Tailwind bundle
because the controls are pre-built. Load both
`dist-battery-sideways/assets/battery-sideways-*.js` and
`battery-sideways-*.css` (content-hashed — use the actual filenames, or keep
the `<script>`/`<link>` tags Vite generated in
`dist-battery-sideways/battery-sideways.html`).

It isn't freely relocatable either: the stylesheet loads its webfonts through
root-absolute URLs baked in at build time. Copy `dist-battery-sideways/assets/`
and `dist-battery-sideways/fonts/` as-is and serve them at `/assets/` and
`/fonts/` from your site root. If your hosting can't serve from root, tell us
and we'll adjust the build's asset base path before you integrate.

### 3. Host the 3D models

Copy the four files in `dist-battery-sideways/models/` so they're served at
`/models/EP5-battery-stack.obj`, `/models/EP5-battery-stack.mtl`,
`/models/EP12-battery-stack.obj` and `/models/EP12-battery-stack.mtl`
**relative to your site root** — those exact paths are hardcoded in the
script. Both models are fetched on load and placed in the same scene.
`favicon.png` is only used by the reference page.

### 4. That's it — no API to wire up

Everything below is built in:

- **Scene.** The EP5 and EP12 stand side by side, far enough apart that only
  one is in view at a time. It opens on the EP5.
- **Start.** Once the models have loaded, each shows three modules held
  slightly apart (50px on screen). When all but the last 200px of the canvas
  has scrolled into view, they ease together (800ms). This plays once per
  page load.
- **Model buttons.** The EP5 / EP12 buttons at the bottom center move the
  camera to that model (about half a second). Nothing is reloaded. The model
  the camera arrives at restacks: its modules sit held apart for 300ms, then
  ease together (800ms).
- **Slider.** Sets the number of modules, 1 to 4, for both models at once; the
  numbers under it are click targets too. Added modules slide and fade in,
  removed ones slide and fade out, and the camera re-centers on the row.
- **Pointer.** Dragging with a mouse rotates the model. The mouse wheel and
  touch are left alone, so both scroll your page as usual.
- **Reduced motion.** With `prefers-reduced-motion: reduce`, the modules
  appear assembled, and count changes and model switches skip their
  animations.

It also keeps out of the host page's way:

- **Off screen, it stops.** Rendering halts once the stage is more than about
  200px outside the viewport and resumes as it comes back, so it costs nothing
  while the user is elsewhere on the page.
- **No keyboard shortcuts, no file-drop handling.** Space, arrows and typing
  behave as they do on the rest of your page.
- **It follows its own box.** If your layout resizes `#battery-stage`, the
  canvas re-fits; a window resize isn't required.

### 5. Things to know before you integrate

- **The stylesheet is global.** It includes Tailwind's base reset plus this
  project's own base rules, which set `body` background and text color, the
  `html` font, and a default border color on every element. Loaded on your
  page as-is, it will restyle parts of the page outside the module. If that
  conflicts with your own styles, tell us and we'll scope the stylesheet to
  `#battery-stage` before you integrate — or embed the module as an iframe
  (below), which isolates it completely.
- **One instance per page.** The script finds its elements by id (`canvas`,
  `react-controls-root`, …), so it can't be embedded twice in one document,
  and none of those ids can be reused elsewhere in it.
- **Together with the vertical battery stack (Part C).** Both scripts look up
  the same element ids, so they can't be loaded into one document. To show
  both on a page, put one of them in an `<iframe>` — the repo's
  `battery-preview.html` does exactly this with `battery-sideways.html`.
- **No teardown.** The script starts when it loads and has no `destroy()`. On
  a regular page load that's fine. In a single-page app that mounts and
  removes this section without a full reload, its listeners and WebGL context
  would outlive the section. Embedding it as an iframe avoids this: removing
  the iframe releases everything. Otherwise tell us and we'll add a teardown
  call.
- **No count or model API.** The built-in controls are the only way to change
  the module count or the model in view. If you need to drive them from your
  own UI, tell us and we'll expose it.
- **Render status pill (optional).** If you embed the module as an iframe on
  the same origin as your page, give the iframe `data-render-status="some-id"`
  and the script will write "Rendering" / "Paused (off screen)" into the
  element with that id on your page. Leave the attribute off and nothing
  happens.

---

## Part E: battery embed module (your controls, `createBatteryScene`)

One ES module, `dist-battery-embed/assets/battery-embed.js` (66 kB, 24 kB
gzipped), covering both the vertical stack (Part C's scene) and the sideways
EP5/EP12 pair (Part D's). It contains no React, Tailwind, stylesheet, controls
or element ids, and touches nothing on the page outside the element you give
it.

`example.html` in the same folder is a working reference with plain
host-built controls and a Destroy/Create button per scene. Serve the folder
with any static server and open it (it won't run from `file://`, since it
loads an ES module). In the repo, `pnpm dev:battery-embed` serves the same
page.

### 1. What's in the folder

- `assets/battery-embed.js` — the module. Serve it wherever you like; you
  told us `/assets/battery-embed.js`.
- `assets/battery-embed.d.ts` — its types, if you want them next to your own
  `scene.ts`.
- `models/battery/` — the six model files, named exactly as the module
  requests them: `NGEN_assets.obj`/`.mtl` (vertical), and
  `EP5-battery-stack.obj`/`.mtl` plus `EP12-battery-stack.obj`/`.mtl`
  (sideways; all four are fetched and placed in one scene). Keep the names;
  the folder is yours to choose and goes in `modelBaseUrl`.
- `example.html` — the reference page.

### 2. Markup

```html
<div class="your-sized-box">
  <canvas data-battery-canvas></canvas>
</div>
```

The module draws into `root.querySelector('canvas[data-battery-canvas]')` and
sizes to `root`, the element you pass in. Give `root` a width and a height;
that is the only layout requirement. The module sets `display: block; width:
100%; height: 100%` inline on the canvas so it fills `root`, and a `grab`
cursor, and puts all four back as it found them on `destroy()`.

### 3. API

```ts
import { createBatteryScene } from '/assets/battery-embed.js';

const scene = createBatteryScene(root, {
  variant: 'vertical',          // or 'sideways'
  count: 3,                     // vertical 3–9, sideways 1–4
  model: 'ep5',                 // sideways only; optional, defaults to 'ep5'
  reducedMotion: false,
  modelBaseUrl: '/models/battery/',
  onReady: () => {},
  onError: (error) => {},
});

scene.setCount(5);
scene.setModel('ep12');
scene.destroy();
```

- **`count`** is how many units the scene opens with. (The page builds in
  Parts C and D always opened with three.)
- **`setCount`** adds or removes units with the slide-and-fade animation; on
  `sideways` it applies to both models at once. Called while the models are
  still loading, the latest value is kept and used when they arrive.
- **`setModel`** moves the camera to that model on `sideways`; it does nothing
  on `vertical`. It can also be called while loading.
- **`destroy`** removes every listener and observer, stops the render loop,
  cancels a model download still in flight and frees the scene's GPU buffers
  and shaders. No callback fires after it. Calling it twice is harmless, as is
  calling `setCount`/`setModel` afterwards.
- **`onReady`** fires once, when the models have loaded and the scene is
  drawing. Until then the canvas shows its plain white background.
- **`onError`** receives the error if WebGL is unavailable, or a model file is
  missing or isn't the expected asset. The canvas stays blank in that case.
- **Thrown, not reported:** mistakes in the arguments throw straight away —
  an unknown `variant` or `model` and a missing canvas throw a `TypeError`, a
  `count` outside the variant's range (in the options or in `setCount`) a
  `RangeError`.
- **`reducedMotion`** is read once, at creation. To follow a change of the
  user's setting, destroy the scene and create it again.

### 4. Behavior

Unchanged from Parts C and D:

- **Start.** Once loaded, the units sit held slightly apart (50px on screen).
  When all but the last 200px of the canvas has scrolled into view, they ease
  together (800ms). Once per scene; a `setCount` before that assembles them
  immediately.
- **Count changes.** Added units slide and fade in, removed ones slide and
  fade out, and the camera re-centers on the stack.
- **EP5/EP12.** The two stand side by side, far enough apart that only one is
  in view. `setModel` moves the camera across (about half a second); the model
  it arrives at sits held apart for 300ms, then eases together (800ms).
- **Reduced motion.** The units appear assembled, and count changes and the
  restack on a model switch skip their animations.
- **Off screen, it stops.** Rendering halts once the canvas is more than about
  200px outside the viewport and resumes as it returns.
- **Pointer.** Dragging with a mouse or pen rotates the model. The wheel and
  touch are left alone, so both scroll your page. No keyboard shortcuts.
- **Background.** The canvas paints its own opaque white background.

New in this build:

- **It follows `root`.** When your layout resizes `root`, the canvas re-fits
  and the model is re-framed to the new proportions. A `root` with no size yet
  (mounted hidden) is fine; drawing starts once it has one.
- **Several scenes per page.** Every `createBatteryScene` call is independent,
  so the vertical and sideways variants can share a page.
- **Remounting.** After `destroy()`, a new scene can be created on the same
  canvas element or on a fresh one. Don't run two scenes on one canvas at the
  same time.
- **No storage, no globals.** The module doesn't read or write `localStorage`
  and adds nothing to `window`.

