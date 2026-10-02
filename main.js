// Only used by captureVideo() (video-mode Enter, tool build only) to encode
// frames into a real MP4 via WebCodecs instead of a real-time MediaRecorder
// stream — see that function's own comment. Static top-level import so
// Rollup can tree-shake it (and this whole dependency) out of the hero/
// canvas builds once captureVideo's only call site, inside an
// `if (!IS_HERO)` block, is stripped by Terser — verified via
// `pnpm build:hero`/`build:canvas` after adding this.
import { BufferTarget, CanvasSource, getFirstEncodableVideoCodec, Mp4OutputFormat, Output, Quality } from 'mediabunny';
import { createBatteryStack } from './battery-stack.js';

// --- Config ---------------------------------------------------------------

// Capped at 2x: beyond that, extra device pixels cost real GPU/CPU time
// (the WebGL canvas's backing store scales with this) for a sharpness
// difference nobody presenting on a laptop/projector/TV can actually
// perceive — only very high-DPR phones/tablets (3x) hit the cap.
const DPR = Math.min(window.devicePixelRatio || 1, 2);

// Build-time flag (replaced with a literal true/false by Vite's `define` —
// see vite.hero.config.ts) that gates every dev/authoring-only block in this
// file: keyboard shortcuts, drag/pan/zoom interactions, flow-arrow drawing,
// photo mode, the perf-monitor/axis-gizmo overlays, model upload, and the
// React panel bridge. Terser's dead-code elimination physically strips
// `if (!IS_HERO) { ... }` blocks from the hero build's output, the same
// mechanism that strips `if (import.meta.env.DEV)` blocks from production
// React builds — so none of that code ships to the hero bundle at all.
const IS_HERO = typeof __HERO__ !== 'undefined' && __HERO__;

// --- DOM --------------------------------------------------------------

const canvas = document.getElementById('canvas');

// Runtime flag (not a build-time one like IS_HERO — this is the same tool
// bundle as the root page, just served from scroll.html, which sets
// data-scroll="true" on the canvas element) for the "/scroll" route: the
// full tool (panel, keyboard shortcuts, drag/pan/zoom, flow-arrow drawing,
// model upload, perf-monitor/axis-gizmo — none of that is stripped), minus
// photo/video mode (see the P/V keydown handlers below) and minus
// loadBundledDefaultModel's opening camera move (bird's-eye drop, yaw
// settle, push into Camera Target 1) — the model just appears already
// sitting at its resting pose. Live hover-parallax tilt
// (updateParallaxTargetFromPointer) is unaffected either way; it doesn't
// route through the intro tweens or photo/video mode.
const IS_SCROLL_ROUTE = canvas?.dataset.scroll === 'true';
// scroll-preview.html sets both data-scroll and data-preview — it's the
// same IS_SCROLL_ROUTE experience (scroll-driven camera, bottom-left info
// card), just with the React control panel forced permanently hidden (see
// the panel's own isPreviewRoute usage in panel.tsx: unlike scroll.html's
// H-key toggle, there's no escape hatch here). Not read anywhere else in
// this module — the FPS monitor/axis-gizmo stay visually hidden via
// scroll-preview.html's own CSS instead of a JS branch here, since both are
// unconditionally required (non-null-checked) elements whenever this isn't
// the separate __HERO__-stripped build (see perfMonitorEl/axisGizmoCanvas
// below) and adding a real branch for them would only matter once a
// tree-shaken preview build (mirroring canvas.html) replaces this
// same-bundle approach.
const IS_PREVIEW_ROUTE = canvas?.dataset.preview === 'true';
// battery.html's own data-battery="true" — the same tool as index.html
// (full panel, same main.tsx/main.js), except startup loads the bundled
// NGEN battery (loadBundledBatteryModel) with stacking already switched on
// instead of loadBundledDefaultModel's scene and intro. Flow arrows drawn
// here are never persisted (see saveModelFlowPath): localStorage is shared
// with the other routes, whose saved arrows belong to a different model.
const IS_BATTERY_ROUTE = canvas?.dataset.battery === 'true';

// #scroll-track (scroll.html) is the only thing giving the /scroll route's
// document real scroll height — see its own CSS comment. Sized dynamically
// (see updateScrollTrackHeight below) rather than a fixed value baked into
// the CSS, specifically so however many Camera Targets end up assigned (up
// to CAMERA_TARGET_SLOT_COUNT) each still gets a full viewport-height span
// of scroll to travel through, instead of every span getting squeezed into
// whatever a fixed track height happens to divide into.
const scrollTrackEl = IS_SCROLL_ROUTE ? document.getElementById('scroll-track') : null;
// The scroll track's leading intro span (see updateScrollTrackHeight and
// renderCubeFrame's own introFraction below) — how many viewport-heights of
// scroll the bottom-left info card's entrance (src/panel.tsx) gets before
// the camera starts blending toward Target 1. Half a viewport rather than a
// full one: the card's rise/fade/blur-in is a quick, small-distance move
// (see CARD_INTRO_OFFSET_PX in panel.tsx), not a full scene transition, so a
// whole 100vh of scroll to play it out read as too slow. Kept in sync with
// panel.tsx's own copy of this constant (see its card entrance effect) —
// both need to agree on how much of the track is intro vs. target-to-target
// scroll.
const SCROLL_INTRO_SPAN_VH_UNITS = 0.5;
// How far out Target 1's own framing starts zoomed at scrollY 0 — the
// camera opens at (1 - this) of Target 1's normal "frame to fit" zoom, then
// zooms in the remaining 10% over the intro span alongside the bottom-left
// info card's entrance (see panel.tsx's own copy of this constant, and
// renderCubeFrame's introZoomMultiplier below), landing exactly at Target
// 1's normal framing right as the card finishes sliding in. Position/center
// never moves during the intro span (see blendProgress below) — only this
// zoom does.
const SCROLL_INTRO_ZOOM_OUT_FRACTION = 0.2;
function updateScrollTrackHeight() {
  if (!scrollTrackEl) return;
  const numTargets = cameraTargetSlots.filter(Boolean).length;
  // One viewport-height span per target (matches the /scroll route's own
  // renderCubeFrame branch, which divides progress evenly across
  // numTargets - 1 spans) plus the trailing viewport itself, so N targets
  // read as N * 100vh of track — same 300vh a fixed 3-target build already
  // used, just generalized. Math.max(1, ...) keeps a full viewport's worth
  // of target track (no scroll range, but no zero-height layout glitch
  // either) before any targets are assigned yet.
  //
  // Plus SCROLL_INTRO_SPAN_VH_UNITS more *leading* span on top of that:
  // reserved for the intro, during which renderCubeFrame's own
  // IS_SCROLL_ROUTE branch holds the camera completely still on Target 1
  // (see its introFraction) instead of blending anywhere — that span exists
  // purely so there's scroll room for the bottom-left info card
  // (src/panel.tsx) to slide in from below the viewport before the model
  // starts moving at all.
  scrollTrackEl.style.height = `${(Math.max(1, numTargets) + SCROLL_INTRO_SPAN_VH_UNITS) * 100}vh`;
}

// The control panel (src/panel.tsx) is a React/coss-ui component tree that
// owns the panel's own UI state (including show/hide + the H-key shortcut).
// This module stays plain WebGL/canvas code; `controls` (bottom of file) is
// the one bridge the panel calls into and subscribes to.
const SLIDER_STORAGE_PREFIX = 'iconMosaic.slider.';

function restoreNumber(id, fallback) {
  const stored = localStorage.getItem(SLIDER_STORAGE_PREFIX + id);
  return stored !== null ? Number(stored) : fallback;
}

function persistNumber(id, value) {
  localStorage.setItem(SLIDER_STORAGE_PREFIX + id, String(value));
}

// One-time migration: the cubeSize slider's default changed from 1000% to
// 100% — drop any previously persisted 1000% value once so existing
// browsers pick up the new default instead of restoring the old one.
// Anything the user sets afterward still persists normally.
const CUBE_SIZE_RESET_MIGRATION_KEY = 'iconMosaic.cubeSizeDefaultResetV1';
if (!localStorage.getItem(CUBE_SIZE_RESET_MIGRATION_KEY)) {
  localStorage.removeItem(SLIDER_STORAGE_PREFIX + 'cubeSize');
  localStorage.setItem(CUBE_SIZE_RESET_MIGRATION_KEY, '1');
}

// One-time migration: the dot fill's defaults changed (frequency 1 -> 9 ->
// 4, size 16% -> 5%) — same reasoning as the cubeSize migration above. V2
// (rather than reusing V1) so browsers that already ran V1 still pick up
// the frequency 9 -> 4 change.
const DOT_DEFAULTS_RESET_MIGRATION_KEY = 'iconMosaic.dotDefaultsResetV2';
if (!localStorage.getItem(DOT_DEFAULTS_RESET_MIGRATION_KEY)) {
  localStorage.removeItem(SLIDER_STORAGE_PREFIX + 'dotFrequency');
  localStorage.removeItem(SLIDER_STORAGE_PREFIX + 'dotSize');
  localStorage.setItem(DOT_DEFAULTS_RESET_MIGRATION_KEY, '1');
}

// One-time migration: the plus fill's defaults changed (frequency 11 -> 2,
// size 20% -> 5%) — same reasoning as the cubeSize/dot migrations above. A
// new V2 key (rather than reusing V1, which only ever cleared frequency)
// so browsers that already ran V1 still pick up the size default too.
const PLUS_DEFAULTS_RESET_MIGRATION_KEY = 'iconMosaic.plusDefaultsResetV2';
if (!localStorage.getItem(PLUS_DEFAULTS_RESET_MIGRATION_KEY)) {
  localStorage.removeItem(SLIDER_STORAGE_PREFIX + 'plusFrequency');
  localStorage.removeItem(SLIDER_STORAGE_PREFIX + 'plusSize');
  localStorage.setItem(PLUS_DEFAULTS_RESET_MIGRATION_KEY, '1');
}

// One-time cleanup: the model's X/Y/Z position used to persist across
// reloads (see modelOffsetXPercent etc.), but that meant a page reload could
// reopen wherever a previous session's camera move/pan happened to leave
// it — position is now always session-only, starting at 0 every load (see
// modelOffsetXPercent's declaration), so any browser with an old persisted
// value just has dead, never-read localStorage entries; drop them once.
const MODEL_OFFSET_RESET_MIGRATION_KEY = 'iconMosaic.modelOffsetDefaultResetV1';
if (!localStorage.getItem(MODEL_OFFSET_RESET_MIGRATION_KEY)) {
  localStorage.removeItem(SLIDER_STORAGE_PREFIX + 'modelOffsetX');
  localStorage.removeItem(SLIDER_STORAGE_PREFIX + 'modelOffsetY');
  localStorage.removeItem(SLIDER_STORAGE_PREFIX + 'modelOffsetZ');
  localStorage.setItem(MODEL_OFFSET_RESET_MIGRATION_KEY, '1');
}

// Width of the model flow's traveling glow pulse (blueprint mode), as a
// fraction of the path's total length — see MODEL_FLOW_PULSE_BAND_FRACTION
// in renderCubeFrame, which multiplies this in.
let pulseWidthValue = restoreNumber('pulseWidth', 1);
let pulseBandFraction = pulseWidthValue / 100;

function setPulseWidth(value) {
  pulseWidthValue = value;
  pulseBandFraction = value / 100;
  persistNumber('pulseWidth', value);
}

// Speed of the flow pulses along a path, as a percentage of
// FLOW_PULSE_PERIOD_BASE_MS's baseline speed — 100% takes
// FLOW_PULSE_PERIOD_BASE_MS to travel the whole path, 200% takes half that
// (twice as fast), 50% takes twice as long (half as fast).
const FLOW_SPEED_MIN = 10;
const FLOW_SPEED_MAX = 200;
let flowSpeedPercent = restoreNumber('flowSpeed', 50);

function setFlowSpeedPercent(value) {
  const clamped = Math.max(FLOW_SPEED_MIN, Math.min(FLOW_SPEED_MAX, value));
  flowSpeedPercent = clamped;
  persistNumber('flowSpeed', clamped);
  return clamped;
}

// Comet pulse shape (see flowPulseIntensity in CUBE_FRAGMENT_SHADER) — core
// and tail length are both percentages of uFlowSigma (the "Pulse width"
// slider's own base scale, same unit its old fixed multiplier constants
// used to be in), so they still shrink/grow together with pulse width. Tail
// falloff is a direct exponent instead — 2 matches a plain Gaussian, higher
// stays near full brightness longer then drops more sharply near the tail's
// end, lower behaves more like a thin exponential streak.
const FLOW_CORE_LENGTH_MIN = 1;
const FLOW_CORE_LENGTH_MAX = 200;
let flowCoreLengthPercent = restoreNumber('flowCoreLength', 60);

function setFlowCoreLengthPercent(value) {
  const clamped = Math.max(FLOW_CORE_LENGTH_MIN, Math.min(FLOW_CORE_LENGTH_MAX, value));
  flowCoreLengthPercent = clamped;
  persistNumber('flowCoreLength', clamped);
  return clamped;
}

// Whether the tail (the d<0, "already passed" side of the comet — see
// flowPulseIntensity in CUBE_FRAGMENT_SHADER) renders at all. Off leaves
// just the head/core riding the front of the pulse with nothing trailing
// behind it. Session-only, like showModelFlowArrow/showModelFlowPoints —
// not persisted.
let flowTailVisible = true;

function setFlowTailVisible(value) {
  flowTailVisible = value;
}

const FLOW_TAIL_LENGTH_MIN = 50;
const FLOW_TAIL_LENGTH_MAX = 500;
let flowTailLengthPercent = restoreNumber('flowTailLength', 160);

function setFlowTailLengthPercent(value) {
  const clamped = Math.max(FLOW_TAIL_LENGTH_MIN, Math.min(FLOW_TAIL_LENGTH_MAX, value));
  flowTailLengthPercent = clamped;
  persistNumber('flowTailLength', clamped);
  return clamped;
}

const FLOW_TAIL_FALLOFF_MIN = 1;
const FLOW_TAIL_FALLOFF_MAX = 8;
let flowTailFalloffValue = restoreNumber('flowTailFalloff', 1);

function setFlowTailFalloff(value) {
  const clamped = Math.max(FLOW_TAIL_FALLOFF_MIN, Math.min(FLOW_TAIL_FALLOFF_MAX, value));
  flowTailFalloffValue = clamped;
  persistNumber('flowTailFalloff', clamped);
  return clamped;
}

// Pulses-per-MODEL_FLOW_REFERENCE_LENGTH-of-path-length (see
// flowPulseDensity/uFlowPulseDensity in renderCubeFrame/CUBE_FRAGMENT_
// SHADER) rather than a literal fixed count — a longer arrow carries
// proportionally more concurrent pulses chasing each other, instead of the
// same handful stretched thin over more physical distance. At a
// MODEL_FLOW_REFERENCE_LENGTH-long arrow this reduces to exactly this
// value, so it still reads as a familiar "how many pulses" slider for a
// typical arrow. Each arrow's own count is floored/capped at
// MAX_FLOW_PULSES, the shader loop's fixed iteration bound.
const FLOW_PULSE_FREQUENCY_MIN = 1;
const FLOW_PULSE_FREQUENCY_MAX = 8;
let flowPulseFrequencyValue = restoreNumber('flowPulseFrequency', 5);

function setFlowPulseFrequency(value) {
  const clamped = Math.max(FLOW_PULSE_FREQUENCY_MIN, Math.min(FLOW_PULSE_FREQUENCY_MAX, Math.round(value)));
  flowPulseFrequencyValue = clamped;
  persistNumber('flowPulseFrequency', clamped);
  return clamped;
}

// The loaded model's size, as a percentage multiplier on top of CUBE_SCALE
// (see renderCubeFrame) — 100 (the default) = CUBE_SCALE unchanged, up to
// 1000 = 10x that.
const CUBE_SIZE_MIN = 1;
const CUBE_SIZE_MAX = 1000;
let cubeSizePercent = restoreNumber('cubeSize', 100);
let cubeSizeScale = cubeSizePercent / 100;

// Shared by setCubeSizePercent (the "Model size" slider) and the scroll-to-
// zoom handler below — clamps and applies the scale, without either one's
// own persist/notify timing (the slider wants both immediately; the wheel
// handler batches them — see scheduleWheelZoomSync).
function applyCubeSizePercent(percent) {
  const clamped = Math.max(CUBE_SIZE_MIN, Math.min(CUBE_SIZE_MAX, percent));
  const previousScale = cubeSizeScale;
  cubeSizePercent = clamped;
  cubeSizeScale = clamped / 100;

  // Zoom into the pivot crosshair (screen-center — see getObjectSpacePan)
  // rather than the model's own origin: rescale the manual pan by the same
  // ratio the model just resized by, so whatever object-space point
  // currently sits under the crosshair keeps sitting there instead of
  // drifting as the model grows/shrinks around its own center.
  if (previousScale > 0 && cubeSizeScale !== previousScale) {
    const ratio = cubeSizeScale / previousScale;
    modelOffsetXPercent = clampModelPosition(modelOffsetXPercent * ratio);
    modelOffsetYPercent = clampModelPosition(modelOffsetYPercent * ratio);
    modelOffsetZPercent = clampModelPosition(modelOffsetZPercent * ratio);
  }

  return clamped;
}

function setCubeSizePercent(percent) {
  const clamped = applyCubeSizePercent(percent);
  persistNumber('cubeSize', clamped);
  notifyModelState();
  return clamped;
}

// Blueprint mode's technical-fill patterns (see aFillPattern /
// materialFillPatternId — hatch lines, dots, or plus marks): each pattern
// gets its own frequency (pattern periods per object-space unit, i.e. how
// tightly packed the lines/dots/pluses are on a fill-flagged face) so they
// can be tuned independently rather than sharing one control. Needs to be
// user-adjustable since a custom model's object-space scale (and therefore
// how dense a given frequency reads) varies per model — see parseObj's
// per-model extent normalization.
const LINE_FREQUENCY_MIN = 1;
const LINE_FREQUENCY_MAX = 60;
let lineFrequencyValue = restoreNumber('lineFrequency', 40);

function setLineFrequency(value) {
  const clamped = Math.max(LINE_FREQUENCY_MIN, Math.min(LINE_FREQUENCY_MAX, value));
  lineFrequencyValue = clamped;
  persistNumber('lineFrequency', clamped);
  return clamped;
}

const DOT_FREQUENCY_MIN = 1;
const DOT_FREQUENCY_MAX = 60;
let dotFrequencyValue = restoreNumber('dotFrequency', 4);

function setDotFrequency(value) {
  const clamped = Math.max(DOT_FREQUENCY_MIN, Math.min(DOT_FREQUENCY_MAX, value));
  dotFrequencyValue = clamped;
  persistNumber('dotFrequency', clamped);
  return clamped;
}

// Dot radius, as a percentage of the cell period (see dotsMask) — e.g. 16
// means each dot's radius is 16% of the spacing between dot centers.
const DOT_SIZE_MIN = 5;
const DOT_SIZE_MAX = 45;
let dotSizePercent = restoreNumber('dotSize', 5);

function setDotSizePercent(value) {
  const clamped = Math.max(DOT_SIZE_MIN, Math.min(DOT_SIZE_MAX, value));
  dotSizePercent = clamped;
  persistNumber('dotSize', clamped);
  return clamped;
}

const PLUS_FREQUENCY_MIN = 1;
const PLUS_FREQUENCY_MAX = 60;
let plusFrequencyValue = restoreNumber('plusFrequency', 9);

function setPlusFrequency(value) {
  const clamped = Math.max(PLUS_FREQUENCY_MIN, Math.min(PLUS_FREQUENCY_MAX, value));
  plusFrequencyValue = clamped;
  persistNumber('plusFrequency', clamped);
  return clamped;
}

// Plus arm half-length, as a percentage of the cell period (see plusMask) —
// arm thickness scales proportionally (see PLUS_THICKNESS_RATIO in
// renderCubeFrame) so a single slider keeps the mark reading as a "+"
// rather than needing a separate thickness control.
const PLUS_SIZE_MIN = 5;
const PLUS_SIZE_MAX = 45;
let plusSizePercent = restoreNumber('plusSize', 5);

function setPlusSizePercent(value) {
  const clamped = Math.max(PLUS_SIZE_MIN, Math.min(PLUS_SIZE_MAX, value));
  plusSizePercent = clamped;
  persistNumber('plusSize', clamped);
  return clamped;
}

// Fixed ratio (rather than a third slider) so the mark keeps reading as a
// "+" as its size changes — matches the original hardcoded 0.05/0.2
// thickness/arm-length ratio from before these were user-adjustable.
const PLUS_THICKNESS_RATIO = 0.12;

// Blueprint shader theme: which background/fill palette renderCubeFrame uses
// (see BLUEPRINT_THEMES below). Green-material parts and the wireframe line
// color stay the same across themes — only the "paper" the drawing sits on
// changes. Declared ahead of the light angle/intensity block below since
// each theme keeps its own independent light defaults/storage.
const SHADER_THEME_STORAGE_KEY = 'iconMosaic.shaderTheme';
const storedShaderTheme = localStorage.getItem(SHADER_THEME_STORAGE_KEY);
// Storage (SHADER_THEME_STORAGE_KEY) is shared across every route/build, so
// a 'dark' preference saved while using the root tool (or any other route)
// would otherwise silently carry over here too. The /scroll route always
// opens on the light theme regardless — deliberately ignoring storage on
// load, not just falling back to light when nothing's been saved yet — since
// it's meant to always start the same way. The panel's theme switch still
// works live during the session (and still writes through to the same
// shared storage other routes read), this only pins what *this* route boots
// into. Every other route keeps its prior behavior: stored 'light'/'dark'
// wins, dark otherwise.
let shaderTheme = IS_SCROLL_ROUTE
  ? 'light'
  : storedShaderTheme === 'light' || storedShaderTheme === 'dark'
    ? storedShaderTheme
    : 'dark';

// Directional light angle, as azimuth (rotation around the vertical Y axis)
// and elevation (above/below the horizontal plane), both in degrees — see
// renderCubeFrame, which converts these to the uLightDir vector each frame.
// Each shader theme has its own independent values/storage/defaults (see
// setShaderTheme, which reloads these on a theme switch) rather than one
// shared setting — dark keeps its original flat storage keys/defaults
// unchanged; light gets its own keys and its own (brighter, more
// front-lit) defaults suited to a white background.
const LIGHT_AZIMUTH_MIN = 0;
const LIGHT_AZIMUTH_MAX = 360;
const LIGHT_ELEVATION_MIN = -90;
const LIGHT_ELEVATION_MAX = 90;
const LIGHT_INTENSITY_MIN = 0;
const LIGHT_INTENSITY_MAX = 200;

function lightAzimuthStorageId() {
  return shaderTheme === 'light' ? 'lightAzimuthLight' : 'lightAzimuth';
}
function lightElevationStorageId() {
  return shaderTheme === 'light' ? 'lightElevationLight' : 'lightElevation';
}
function lightIntensityStorageId() {
  return shaderTheme === 'light' ? 'lightIntensityLight' : 'lightIntensity';
}
function lightAzimuthDefault() {
  return shaderTheme === 'light' ? 110 : 160;
}
function lightElevationDefault() {
  return shaderTheme === 'light' ? 33 : 50;
}
function lightIntensityDefault() {
  return shaderTheme === 'light' ? 185 : 100;
}

let lightAzimuthValue = restoreNumber(lightAzimuthStorageId(), lightAzimuthDefault());
let lightElevationValue = restoreNumber(lightElevationStorageId(), lightElevationDefault());
// Scales the directional light's diffuse contribution (see uLightIntensity
// in CUBE_FRAGMENT_SHADER), as a percent — 100 matches the original
// fixed-brightness look, higher pushes lit faces brighter/unlit faces
// darker, lower flattens the shading toward a uniform flat fill.
let lightIntensityPercent = restoreNumber(lightIntensityStorageId(), lightIntensityDefault());

function setLightAzimuth(value) {
  lightAzimuthValue = value;
  persistNumber(lightAzimuthStorageId(), value);
}

function setLightElevation(value) {
  lightElevationValue = value;
  persistNumber(lightElevationStorageId(), value);
}

function setLightIntensityPercent(value) {
  const clamped = Math.max(LIGHT_INTENSITY_MIN, Math.min(LIGHT_INTENSITY_MAX, value));
  lightIntensityPercent = clamped;
  persistNumber(lightIntensityStorageId(), clamped);
  return clamped;
}

// Cube mode's "Blueprint mode" checkbox: dims the model to a flat navy fill
// and overlays a crease/boundary-edge wireframe in bright cyan, on a navy
// background — see renderCubeFrame and buildCreaseEdgeLines.
const BLUEPRINT_STORAGE_KEY = 'iconMosaic.blueprint';
const storedBlueprint = localStorage.getItem(BLUEPRINT_STORAGE_KEY);
let blueprintEnabled = storedBlueprint !== null ? storedBlueprint === 'true' : true;

function setBlueprintEnabled(value) {
  blueprintEnabled = value;
  localStorage.setItem(BLUEPRINT_STORAGE_KEY, String(blueprintEnabled));
}

function setShaderTheme(value) {
  shaderTheme = value === 'light' ? 'light' : 'dark';
  localStorage.setItem(SHADER_THEME_STORAGE_KEY, shaderTheme);
  // Reload the light angle/intensity sliders from this theme's own
  // storage/defaults — see lightAzimuthStorageId etc. above — and let the
  // panel know, since these are ordinary panel-controlled slider values.
  lightAzimuthValue = restoreNumber(lightAzimuthStorageId(), lightAzimuthDefault());
  lightElevationValue = restoreNumber(lightElevationStorageId(), lightElevationDefault());
  lightIntensityPercent = restoreNumber(lightIntensityStorageId(), lightIntensityDefault());
  refreshBlueprintLineColors();
  notifyModelState();
}

// --- Source: the loaded .obj model, rendered with plain WebGL -------------

// Renders directly into the visible <canvas> (WebGL's own backing store,
// set from `renderScale` — see applyCanvasSize/resize far below — takes the
// place of a fixed on-screen resolution). An earlier version of this file
// rendered into a separate square offscreen canvas and 2D-blitted
// (cover-fit crop) it onto this one every frame; that extra full-frame
// resample was the actual per-frame cost, independent of both scene
// complexity and the WebGL resolution — measuring it (see the FPS/ms
// monitor below) is what surfaced it. Rendering straight into `canvas`
// removes that pass entirely: the browser's own (effectively free,
// hardware-composited) canvas-to-CSS-box scaling does what the manual
// blit used to. The tradeoff is that "cover fit" now has to happen in the
// projection matrix (see updateCubeProjection) instead of a pixel crop,
// since there's no longer a separate square source to crop from.
const gl = canvas.getContext('webgl', { antialias: true });
// Needed for fwidth() in CUBE_FRAGMENT_SHADER's hatch-line anti-aliasing —
// must be enabled before that shader compiles (see below). Universally
// supported (core in WebGL2, a ubiquitous extension in WebGL1) so no
// fallback path if it's somehow missing; the shader would just fail to
// compile, same as any other compile error here.
gl.getExtension('OES_standard_derivatives');

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

const CUBE_VERTEX_SHADER = `
  attribute vec3 aPosition;
  attribute vec3 aNormal;
  attribute vec3 aColor;
  attribute float aIsGreen;
  attribute float aFlowCoord;
  // The world-space arc length of whichever flow path this vertex was
  // assigned to (aFlowCoord's normalizing masterTotalLen, carried through
  // unnormalized) — lets the fragment shader convert the tail/core reach
  // back out of aFlowCoord's per-path-normalized space into an absolute
  // distance, so their real lengths stay the same regardless of how long
  // the specific arrow is. See recomputeModelFlowCoords/MODEL_FLOW_REFERENCE_LENGTH.
  attribute float aFlowPathLen;
  // Which technical-fill pattern (if any) this vertex's face uses: 0 = none,
  // 1 = hatch lines, 2 = dots, 3 = plus marks — see materialFillPatternId,
  // which maps a Blender material name to one of these. A single float
  // (rather than a separate boolean per pattern) keeps this to one
  // attribute/buffer regardless of how many fill patterns exist.
  attribute float aFillPattern;
  uniform mat4 uModelView;
  uniform mat4 uProjection;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying float vIsGreen;
  varying float vFlowCoord;
  varying float vFlowPathLen;
  varying vec3 vPosition;
  varying float vFillPattern;
  void main() {
    gl_Position = uProjection * uModelView * vec4(aPosition, 1.0);
    // Object-space normal (no model rotation applied) so the light stays
    // fixed relative to the model instead of the camera as it's dragged.
    vNormal = aNormal;
    vColor = aColor;
    vIsGreen = aIsGreen;
    vFlowCoord = aFlowCoord;
    vFlowPathLen = aFlowPathLen;
    // Object-space position, same reasoning as vNormal above: the fill
    // pattern it drives (see CUBE_FRAGMENT_SHADER) needs to stay fixed to
    // the model rather than swim as the camera orbits.
    vPosition = aPosition;
    vFillPattern = aFillPattern;
  }
`;

const CUBE_FRAGMENT_SHADER = `
  #extension GL_OES_standard_derivatives : enable
  precision mediump float;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying float vIsGreen;
  varying float vFlowCoord;
  varying float vFlowPathLen;
  varying vec3 vPosition;
  varying float vFillPattern;
  uniform vec3 uLightDir;
  uniform float uLightIntensity;
  uniform bool uBlueprint;
  uniform vec3 uBlueprintFillColor;
  uniform vec3 uBlueprintFillColorGreen;
  uniform bool uFlowActive;
  // uFlowWorldPos is a shared, ever-growing world-space distance at the
  // *reference* speed (see flowSpeedWorldPerMs in renderCubeFrame) — the
  // speed a MODEL_FLOW_REFERENCE_LENGTH-long (uFlowReferenceLength) arrow
  // actually travels at. flowPulseIntensity below scales it per-vertex by
  // sqrt(vFlowPathLen / uFlowReferenceLength) so longer arrows move faster
  // than shorter ones — not proportionally faster (that would make every
  // arrow's lap TIME constant again, i.e. back in sync), just enough that
  // long arrows read livelier while still drifting out of phase with short
  // ones over time. The scaled result is then wrapped by this vertex's own
  // vFlowPathLen to get *this* arrow's own 0-1 travel-loop progress, and
  // this arrow's other concurrent pulses (see uFlowPulseDensity below) are
  // spaced out from that using uFlowRange/uFlowPad — all per-vertex since
  // pulse count, speed, and lap time all depend on vFlowPathLen.
  uniform float uFlowWorldPos;
  uniform float uFlowReferenceLength;
  uniform float uFlowRange;
  uniform float uFlowPad;
  // Pulses-per-MODEL_FLOW_REFERENCE_LENGTH-of-path-length (see
  // FLOW_PULSE_FREQUENCY_MIN/flowPulseDensity in renderCubeFrame) —
  // multiplied by this vertex's own vFlowPathLen in flowPulseIntensity
  // below to get that specific arrow's own pulse count, so a longer arrow
  // carries proportionally more concurrent pulses instead of the same
  // handful stretched thin over more physical distance. GLSL ES 1.00 loops
  // need a constant upper bound, so MAX_FLOW_PULSES caps the loop and each
  // arrow's own computed count is checked with a dynamic break. Raised from
  // the old 8 (which matched FLOW_PULSE_FREQUENCY_MAX, but that's the
  // density baseline for a MODEL_FLOW_REFERENCE_LENGTH-long arrow, not a
  // ceiling on any specific arrow's own count — a ~29-unit arrow at the
  // default "Pulse frequency" already computes ~49) so long arrows keep
  // scaling instead of saturating well before the default density would
  // otherwise allow — dialed back down from a first pass at 64, which read
  // as too dense/costly on the longest arrows. Each extra unit here is
  // extra worst-case per-fragment cost (one more possible loop
  // iteration/exp() pair), so don't raise this far past what the longest
  // arrows actually need.
  const int MAX_FLOW_PULSES = 32;
  uniform float uFlowPulseDensity;
  uniform float uFlowSigma;
  uniform vec3 uFlowColor;
  uniform vec3 uFlowCoreColor;
  // Absolute world-space head/core/tail reach (not a fraction of any one
  // path's own length — see MODEL_FLOW_REFERENCE_LENGTH) so all three stay
  // the same physical size on every arrow regardless of how long it is drawn.
  uniform float uFlowHeadWorldSigma;
  uniform float uFlowCoreWorldSigma;
  uniform float uFlowTailWorldSigma;
  uniform float uFlowTailFalloffExponent;
  uniform bool uFlowTailVisible;
  uniform vec3 uHatchLineColor;
  uniform float uLineFrequency;
  uniform float uDotFrequency;
  uniform float uDotRadius;
  uniform float uPlusFrequency;
  uniform float uPlusArmHalf;
  uniform float uPlusThickness;

  // Shared by all three fill patterns below (lines/dots/plus): projects
  // object-space position onto the two axes spanning the face (dropping
  // whichever axis the normal points along), sampled in object space so the
  // pattern stays put on the face as the model rotates instead of swimming
  // (screen-space would be simpler but reads as "wrong" the moment the
  // camera moves) — and so spacing is consistent regardless of which cube
  // face, or which arbitrary custom-model face, is flagged.
  vec2 fillPatternUV(vec3 pos, vec3 normal) {
    vec3 an = abs(normal);
    if (an.x >= an.y && an.x >= an.z) return pos.yz;
    if (an.y >= an.x && an.y >= an.z) return pos.xz;
    return pos.xy;
  }

  // Edge thickness/softness shared by all three patterns, and the shared
  // anti-moire fallback: derived from the screen-space gradient of each
  // pattern's own "distance to feature" value rather than a fixed fraction
  // of the period, so every pattern renders at a constant ~1 device pixel
  // — matching the wireframe overlay (gl.LINES at the default 1px width) —
  // regardless of how the face is scaled/tilted/zoomed. Below
  // MIN_RESOLVED_PERIOD_PX screen pixels per period, the pattern has more
  // than one repeat per pixel — under-sampled, so a crisp per-fragment test
  // aliases into shimmering moire as the surface (or the camera orbiting
  // it) tilts the face toward grazing incidence, where foreshortening keeps
  // shrinking the on-screen period. Standard fix (used for procedural
  // grids/checkers under minification): once the period drops close to or
  // below this, fade to the pattern's flat average coverage instead of
  // trying to resolve individual features the pixel grid can't represent.
  const float FILL_EDGE_HALF_WIDTH_PX = 1.0;
  const float FILL_MIN_RESOLVED_PERIOD_PX = 3.0;
  const float FILL_ALIASED_PERIOD_PX = 1.0;

  // Diagonal hatch lines. Uses the exact gradient length (dFdx/dFdy
  // combined via Pythagoras) rather than fwidth's cheaper
  // abs(dFdx)+abs(dFdy) approximation — fwidth overestimates the gradient
  // except when the line runs exactly along the x or y screen axis, so it
  // was making the line's rendered width (and thus its antialiasing)
  // inconsistent — thinner/rougher-looking — at the diagonal angles most
  // hatch lines actually run at.
  float hatchLinesMask(vec3 pos, vec3 normal) {
    vec2 uv = fillPatternUV(pos, normal);
    float diag = (uv.x + uv.y) * uLineFrequency;
    float gradLen = length(vec2(dFdx(diag), dFdy(diag)));
    float phase = fract(diag);
    float distToLine = min(phase, 1.0 - phase) / max(gradLen, 1e-6);
    float crispLine = 1.0 - smoothstep(0.0, FILL_EDGE_HALF_WIDTH_PX, distToLine);
    float periodPx = 1.0 / max(gradLen, 1e-6);
    float coverage = clamp((2.0 * FILL_EDGE_HALF_WIDTH_PX) / max(periodPx, 1e-3), 0.0, 1.0);
    float resolved = smoothstep(FILL_ALIASED_PERIOD_PX, FILL_MIN_RESOLVED_PERIOD_PX, periodPx);
    return mix(coverage, crispLine, resolved);
  }

  // Small filled circles on a regular grid, one per uDotFrequency cell.
  // uDotRadius is a fraction of the cell period (so dot size scales with
  // spacing, like a real screen-printed dot pattern) rather than a fixed
  // size — user-adjustable via the "Dot size" slider.
  float dotsMask(vec3 pos, vec3 normal) {
    vec2 uv = fillPatternUV(pos, normal) * uDotFrequency;
    vec2 cell = fract(uv) - 0.5;
    float dist = length(cell);
    float gradLen = length(vec2(dFdx(dist), dFdy(dist)));
    float distPx = (dist - uDotRadius) / max(gradLen, 1e-6);
    float crispDot = 1.0 - smoothstep(-FILL_EDGE_HALF_WIDTH_PX, FILL_EDGE_HALF_WIDTH_PX, distPx);
    float periodPx = 1.0 / max(gradLen, 1e-6);
    float flatCoverage = clamp(3.14159265 * uDotRadius * uDotRadius, 0.0, 1.0);
    float resolved = smoothstep(FILL_ALIASED_PERIOD_PX, FILL_MIN_RESOLVED_PERIOD_PX, periodPx);
    return mix(flatCoverage, crispDot, resolved);
  }

  // Small "+" marks on a regular grid, one per uPlusFrequency cell — a
  // union of a horizontal and a vertical bar (a cheap box-distance cross,
  // not an exact Euclidean SDF, but sufficient at the thin scale these
  // render at). uPlusArmHalf/uPlusThickness are fractions of the cell
  // period, same reasoning as uDotRadius above — user-adjustable via the
  // "Plus size" slider (thickness follows arm length at a fixed ratio, see
  // PLUS_THICKNESS_RATIO in renderCubeFrame, so it keeps reading as a "+").
  float plusMask(vec3 pos, vec3 normal) {
    vec2 uv = fillPatternUV(pos, normal) * uPlusFrequency;
    vec2 cell = fract(uv) - 0.5;
    float distH = max(abs(cell.y) - uPlusThickness, abs(cell.x) - uPlusArmHalf);
    float distV = max(abs(cell.x) - uPlusThickness, abs(cell.y) - uPlusArmHalf);
    float dist = min(distH, distV);
    float gradLen = length(vec2(dFdx(dist), dFdy(dist)));
    float distPx = dist / max(gradLen, 1e-6);
    float crispPlus = 1.0 - smoothstep(-FILL_EDGE_HALF_WIDTH_PX, FILL_EDGE_HALF_WIDTH_PX, distPx);
    float periodPx = 1.0 / max(gradLen, 1e-6);
    float flatCoverage = clamp(8.0 * uPlusArmHalf * uPlusThickness - 4.0 * uPlusThickness * uPlusThickness, 0.0, 1.0);
    float resolved = smoothstep(FILL_ALIASED_PERIOD_PX, FILL_MIN_RESOLVED_PERIOD_PX, periodPx);
    return mix(flatCoverage, crispPlus, resolved);
  }
  // Traveling energy-pulse intensity along a user-drawn arrow, restricted to
  // green (flagged) parts that some arrow actually touches — driven by a 3D
  // arc-length coordinate (aFlowCoord). Vertices on a green part no arrow was
  // ever drawn on get a negative aFlowCoord (see recomputeModelFlowCoords) so
  // they never light up, rather than defaulting to 0 and falsely flashing
  // whenever the pulse happens to pass near the start of some other part's
  // arrow.
  //
  // Comet shape rather than a symmetric Gaussian band: d>0 is ahead of the
  // pulse center in the direction of travel (increasing vFlowCoord, same
  // direction uFlowPulseCenter sweeps over time) — the comet's bright head,
  // narrow and fixed like the tail/core below, so it cuts off sharply just
  // past center. d<0 is behind — already passed, fading — so it uses
  // uFlowTailWorldSigma (user-adjustable "Tail length", an absolute
  // world-space distance via dArc below so it doesn't grow/shrink with this
  // specific arrow's own length) for its reach, and uFlowTailFalloffExponent
  // ("Tail falloff") for the curve's shape independent of that reach: 2.0
  // matches a plain Gaussian, higher stays near full brightness longer then
  // drops more sharply near the tail's end, lower behaves more like a thin
  // exponential streak. On top of both sits a second, much tighter "hot
  // core" lobe (uFlowCoreWorldSigma, "Core length" — symmetric, and, like
  // the head and tail, an absolute world-space size rather than a fraction
  // of this arrow's own length, so it doesn't grow/shrink with path length
  // either) adding extra brightness concentrated right at the head, so it
  // reads as a distinct bright point instead of just the front edge of a
  // flat-topped band.
  // 1.5 read fine back when the (now-removed) bloom pass pre-boosted
  // uFlowColor by up to 4x before blurring it — blur then spread that
  // extra brightness into an obviously bigger halo, so even a modest
  // additive nudge here translated into a dramatic glow change. Rendered
  // directly on the model with no blur, 1.5x on top of an already-bright
  // pulse barely moved the on-screen result, which is why widening "Core
  // length" only ever looked subtle after bloom was dropped. Raised to
  // compensate so the slider still has real range on its own.
  const float FLOW_COMET_CORE_BOOST = 4.5;
  // Every sigma below gets floored to cover at least this many screen
  // pixels — same fix as hatchLinesMask/dotsMask/plusMask above, applied to
  // the pulse instead of a fill pattern. vFlowCoord is a 0-1 fraction of
  // this specific arrow's own path length, so how many screen pixels one
  // unit of it spans isn't fixed — it shrinks the same way any world-space
  // length does when zoomed out, but *also* when the path's local direction
  // swings toward/away from the camera (orthographic projection collapses
  // length-along-view-direction to near nothing, independent of zoom — a
  // ground-parallel tube keeps its full length on screen from a bird's-eye
  // view, but a vertical one is now pointing straight at the camera). Once
  // a sigma that's a fixed WORLD size gets squeezed into a fraction of a
  // pixel by either effect, it can't be sampled correctly, which is exactly
  // the blocky/double-lobed look reported at steep angles and far zoom.
  // Widening the sigma here keeps the pulse resolvable to begin with.
  const float FLOW_MIN_SIGMA_PX = 1.0;
  // Returns (headTailIntensity, coreIntensity) separately rather than one
  // combined scalar — main() below colors them independently (uFlowColor
  // for the head/tail body, uFlowCoreColor for the hot core lobe), so the
  // core reads as a visibly distinct hot spot instead of just extra
  // brightness in the same color.
  vec2 flowPulseIntensity() {
    if (!(uBlueprint && uFlowActive && vIsGreen > 0.5 && vFlowCoord >= 0.0)) return vec2(0.0);
    float coordGradLen = length(vec2(dFdx(vFlowCoord), dFdy(vFlowCoord)));
    float minCoordSigma = coordGradLen * FLOW_MIN_SIGMA_PX;
    // minCoordSigma is in vFlowCoord's own 0-1-per-path units — scale it by
    // vFlowPathLen (same conversion dArc below uses) to floor tail/core
    // sigma in the world-space units they actually need to be in.
    float minWorldSigma = minCoordSigma * vFlowPathLen;
    // This arrow's own travel-loop progress. uFlowWorldPos is a shared
    // absolute world-space distance at the *reference* speed (see
    // flowSpeedWorldPerMs in renderCubeFrame); sqrt(lapLen/uFlowReferenceLength)
    // scales that up for longer arrows (down for shorter ones) so longer
    // arrows move faster in absolute terms, without scaling exactly enough
    // to keep every arrow's lap TIME equal — arrows still drift out of
    // phase with each other over time, which is intentional (see the file
    // header comment above "3D flow arrows"). The result is then wrapped by
    // *this* vertex's own vFlowPathLen to get this arrow's 0-1 progress.
    // GLSL's mod() always lands in [0, lapLen) for lapLen > 0, unlike JS's
    // %, so no separate handling for negative input is needed here.
    float lapLen = max(vFlowPathLen, 1e-6);
    float arrowWorldPos = uFlowWorldPos * sqrt(lapLen / uFlowReferenceLength);
    float basePulseCenter = -uFlowPad + mod(arrowWorldPos, lapLen) / lapLen * uFlowRange;
    // This arrow's own pulse count — longer arrows (bigger vFlowPathLen)
    // get proportionally more, see uFlowPulseDensity above. Floored to the
    // nearest whole pulse and never less than 1, so even a short arrow
    // always carries at least the primary pulse.
    int pulseCount = int(clamp(floor(uFlowPulseDensity * vFlowPathLen + 0.5), 1.0, float(MAX_FLOW_PULSES)));
    float spacing = uFlowRange / float(pulseCount);
    float totalBase = 0.0;
    float totalCore = 0.0;
    for (int i = 0; i < MAX_FLOW_PULSES; i++) {
      if (i >= pulseCount) break;
      // Extra pulses trail the primary one at even offsets around the
      // shared travel loop, each wrapped back into [-uFlowPad, uFlowRange -
      // uFlowPad) so they fade in/out at the loop's ends just like the
      // primary pulse instead of popping when an offset center wanders past
      // a boundary. GLSL's mod() (x - y*floor(x/y)) always lands in
      // [0, uFlowRange) for uFlowRange > 0, unlike JS's %, so no separate
      // handling for negative input is needed here.
      float shifted = basePulseCenter - float(i) * spacing + uFlowPad;
      float wrapped = mod(shifted, uFlowRange);
      float d = vFlowCoord - (wrapped - uFlowPad);
      // World-space distance from the pulse center — unlike d itself (a
      // fraction of this specific arrow's own length), this is the same
      // physical distance meaning on every arrow, which is what lets the
      // core lobe below stay a fixed size regardless of path length.
      float dArc = abs(d) * vFlowPathLen;
      float base;
      if (d > 0.0) {
        float sigma = max(uFlowHeadWorldSigma, minWorldSigma);
        base = exp(-(dArc * dArc) / (2.0 * sigma * sigma));
      } else {
        float tailSigma = max(max(uFlowTailWorldSigma, minWorldSigma), 1e-6);
        base = uFlowTailVisible ? exp(-0.5 * pow(dArc / tailSigma, uFlowTailFalloffExponent)) : 0.0;
      }
      float coreSigma = max(uFlowCoreWorldSigma, minWorldSigma);
      float core = exp(-(dArc * dArc) / (2.0 * coreSigma * coreSigma));
      totalBase += base;
      totalCore += core * FLOW_COMET_CORE_BOOST;
    }
    return vec2(totalBase, totalCore);
  }

  void main() {
    float diff = max(dot(normalize(vNormal), normalize(uLightDir)), 0.0) * uLightIntensity;
    float brightness = 0.2 + diff * 0.8;
    // Blueprint mode: ignore the material/cube color entirely and shade a
    // flat fill instead (navy, or green for green-material parts), dimmed
    // further so the wireframe overlay (drawn in a separate pass) reads as
    // the bright part of the look.
    vec3 base = uBlueprint ? (vIsGreen > 0.5 ? uBlueprintFillColorGreen : uBlueprintFillColor) : vColor;
    // Wider range than the old 0.3-0.6 (barely a 2x spread) so faces at
    // different angles to uLightDir read as clearly distinct shades instead
    // of nearly-uniform navy. Floor raised further (0.12 -> 0.3) so unlit
    // faces stay bright too, not just the lit ones.
    float shade = uBlueprint ? (0.3 + diff * 1.1) : brightness;
    vec3 color = base * shade;
    vec2 flowIntensity = flowPulseIntensity();
    color += uFlowColor * flowIntensity.x + uFlowCoreColor * flowIntensity.y;
    // Fill-pattern-flagged faces (see aFillPattern / materialFillPatternId)
    // get uHatchLineColor drawn on top of everything above in whichever
    // pattern their material selected, so it reads on top of blueprint
    // fill, shaded-mode lighting, and the flow glow alike.
    int fillPatternId = int(vFillPattern + 0.5);
    float fillMask = 0.0;
    if (fillPatternId == 1) fillMask = hatchLinesMask(vPosition, vNormal);
    else if (fillPatternId == 2) fillMask = dotsMask(vPosition, vNormal);
    else if (fillPatternId == 3) fillMask = plusMask(vPosition, vNormal);
    if (fillPatternId != 0) {
      color = mix(color, uHatchLineColor, fillMask);
    }
    gl_FragColor = vec4(color, 1.0);
  }
`;

const cubeProgram = gl.createProgram();
gl.attachShader(cubeProgram, compileShader(gl.VERTEX_SHADER, CUBE_VERTEX_SHADER));
gl.attachShader(cubeProgram, compileShader(gl.FRAGMENT_SHADER, CUBE_FRAGMENT_SHADER));
gl.linkProgram(cubeProgram);
if (!gl.getProgramParameter(cubeProgram, gl.LINK_STATUS)) {
  throw new Error(gl.getProgramInfoLog(cubeProgram));
}

// Unlit flat-color line shader, used to draw the wireframe overlay in
// blueprint mode. Shares uModelView/uProjection semantics with the cube
// program but has no lighting — each edge vertex carries its own color
// (aLineColor) instead, so green-material edges can render green while
// everything else stays the default blueprint accent color (see
// buildCreaseEdgeLines). Also doubles as the shader for the drawn flow-arrow
// overlay itself (see renderCubeFrame) — that path is just a small ad hoc
// buffer bound to the same attributes.
const LINE_VERTEX_SHADER = `
  attribute vec3 aLinePosition;
  attribute vec3 aLineColor;
  uniform mat4 uLineModelView;
  uniform mat4 uLineProjection;
  varying vec3 vLineColor;
  void main() {
    gl_Position = uLineProjection * uLineModelView * vec4(aLinePosition, 1.0);
    vLineColor = aLineColor;
  }
`;

// Flat, unlit — the flow pulse only shows on the fill (see CUBE_FRAGMENT_SHADER),
// so the wireframe/edge lines never carry it regardless of green-flagged status.
// uLineAlpha defaults to 1 (fully opaque, e.g. the model wireframe) — the
// flow-arrow ribbons (see renderCubeFrame) lower it and enable gl.BLEND
// around their draw calls to render at partial opacity over the scene.
const LINE_FRAGMENT_SHADER = `
  precision mediump float;
  varying vec3 vLineColor;
  uniform float uLineAlpha;
  void main() {
    gl_FragColor = vec4(vLineColor, uLineAlpha);
  }
`;

const lineProgram = gl.createProgram();
gl.attachShader(lineProgram, compileShader(gl.VERTEX_SHADER, LINE_VERTEX_SHADER));
gl.attachShader(lineProgram, compileShader(gl.FRAGMENT_SHADER, LINE_FRAGMENT_SHADER));
gl.linkProgram(lineProgram);
if (!gl.getProgramParameter(lineProgram, gl.LINK_STATUS)) {
  throw new Error(gl.getProgramInfoLog(lineProgram));
}

// Two selectable blueprint palettes (see shaderTheme/setShaderTheme above) —
// "dark" is the original navy fill with gray wireframe lines, "light" is a
// pale gray fill with dark navy wireframe lines. Green-material parts (see
// isGreenDominant) ignore both and always get a green fill
// (BLUEPRINT_FILL_COLOR_GREEN) with black edges (BLUEPRINT_LINE_COLOR_GREEN_PART)
// so they read as a distinct, "called out" element regardless of theme.
const BLUEPRINT_THEMES = {
  dark: {
    bg: [4 / 255, 28 / 255, 44 / 255], // #041C2C
    fill: [4 / 255, 28 / 255, 44 / 255], // #041C2C
    line: [124 / 255, 134 / 255, 142 / 255], // #7C868E
  },
  light: {
    bg: [1, 1, 1], // #FFFFFF
    fill: [244 / 255, 246 / 255, 247 / 255], // #F4F6F7
    line: [4 / 255, 28 / 255, 44 / 255], // #041C2C
  },
};
const BLUEPRINT_FILL_COLOR_GREEN = [68 / 255, 214 / 255, 44 / 255]; // #44D62C
const BLUEPRINT_LINE_COLOR_GREEN_PART = [0, 0, 0];
// Bright additive glow colors for the traveling flow pulse — added on top of
// whatever's underneath, so it reads as a light passing through rather than
// a color swap. Head/tail body and hot core lobe (see
// FLOW_COMET_CORE_BOOST/uFlowCoreWorldSigma in CUBE_FRAGMENT_SHADER) share
// the same white, kept as separate uniforms/colors in case they need to
// diverge again later.
const BLUEPRINT_FLOW_COLOR = [1, 1, 1];
const BLUEPRINT_FLOW_CORE_COLOR = [1, 1, 1];

// Builds a blueprint wireframe's edge list from a flat position array and a
// flat triangle index list (three indices per triangle) — but only keeps
// "significant" edges: boundary edges (used by exactly one triangle) and
// creases (used by 2+ triangles whose face normals diverge past
// CREASE_ANGLE_DOT_THRESHOLD). Coplanar/smooth interior edges are dropped —
// notably this is what keeps a fan-triangulated quad's diagonal split out of
// the wireframe (its two triangles share the same plane, so that edge never
// qualifies). Necessary for dense meshes too: a literal "every triangle
// edge" wireframe on a 500k+-triangle mesh would overflow a 16-bit index
// buffer and render as solid haze rather than a clean line drawing.
const CREASE_ANGLE_DOT_THRESHOLD = Math.cos((25 * Math.PI) / 180);

// triIsGreen is one boolean per triangle (triIndices.length / 3); an edge
// renders in BLUEPRINT_LINE_COLOR_GREEN_PART (black) if any triangle using it
// is flagged green (see isGreenDominant) — e.g. ngen.mtl's
// EV_charger_body_green / shared_pipe_green parts — otherwise the default
// gray.
function buildCreaseEdgeLines(flatPositions, triIndices, triIsGreen) {
  const vertexCount = flatPositions.length / 3;
  const edgeMap = new Map();
  const triCount = triIndices.length / 3;
  for (let t = 0; t < triCount; t++) {
    const ia = triIndices[t * 3], ib = triIndices[t * 3 + 1], ic = triIndices[t * 3 + 2];
    const ax = flatPositions[ia * 3], ay = flatPositions[ia * 3 + 1], az = flatPositions[ia * 3 + 2];
    const bx = flatPositions[ib * 3], by = flatPositions[ib * 3 + 1], bz = flatPositions[ib * 3 + 2];
    const cx = flatPositions[ic * 3], cy = flatPositions[ic * 3 + 1], cz = flatPositions[ic * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const isGreen = !!triIsGreen[t];

    const edges = [[ia, ib], [ib, ic], [ic, ia]];
    for (const [i0, i1] of edges) {
      const key = i0 < i1 ? i0 * vertexCount + i1 : i1 * vertexCount + i0;
      const existing = edgeMap.get(key);
      if (!existing) {
        edgeMap.set(key, { i0, i1, nx, ny, nz, minDot: 1, count: 1, isGreen });
      } else {
        const dot = existing.nx * nx + existing.ny * ny + existing.nz * nz;
        if (dot < existing.minDot) existing.minDot = dot;
        existing.count++;
        if (isGreen) existing.isGreen = true;
      }
    }
  }

  const lines = [];
  const lineIsGreen = [];
  for (const { i0, i1, count, minDot, isGreen } of edgeMap.values()) {
    if (count === 1 || minDot < CREASE_ANGLE_DOT_THRESHOLD) {
      lines.push(
        flatPositions[i0 * 3], flatPositions[i0 * 3 + 1], flatPositions[i0 * 3 + 2],
        flatPositions[i1 * 3], flatPositions[i1 * 3 + 1], flatPositions[i1 * 3 + 2],
      );
      lineIsGreen.push(isGreen);
    }
  }
  return {
    positions: new Float32Array(lines),
    isGreen: lineIsGreen,
    colors: buildLineColors(lineIsGreen, BLUEPRINT_THEMES[shaderTheme].line),
  };
}

// Per-vertex color buffer for a buildCreaseEdgeLines result — green-flagged
// edges always render in BLUEPRINT_LINE_COLOR_GREEN_PART (black) regardless
// of theme, everything else gets the current theme's line color. Split out
// from buildCreaseEdgeLines so switching shaderTheme can recolor the existing
// edge geometry (see setShaderTheme) without re-deriving creases/boundaries.
function buildLineColors(lineIsGreen, lineColor) {
  const colors = new Float32Array(lineIsGreen.length * 6);
  for (let i = 0; i < lineIsGreen.length; i++) {
    const c = lineIsGreen[i] ? BLUEPRINT_LINE_COLOR_GREEN_PART : lineColor;
    const o = i * 6;
    colors[o] = c[0]; colors[o + 1] = c[1]; colors[o + 2] = c[2];
    colors[o + 3] = c[0]; colors[o + 4] = c[1]; colors[o + 5] = c[2];
  }
  return colors;
}

// Re-uploads customModelLineColorBuffer from the cached per-edge isGreen
// flags (edge geometry never changes on a theme switch, only which color
// each non-green edge gets) — see setShaderTheme.
function refreshBlueprintLineColors() {
  const lineColor = BLUEPRINT_THEMES[shaderTheme].line;
  if (customModelLineIsGreenCache) {
    gl.bindBuffer(gl.ARRAY_BUFFER, customModelLineColorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, buildLineColors(customModelLineIsGreenCache, lineColor), gl.STATIC_DRAW);
  }
}

const aPosition = gl.getAttribLocation(cubeProgram, 'aPosition');
const aNormal = gl.getAttribLocation(cubeProgram, 'aNormal');
const aColor = gl.getAttribLocation(cubeProgram, 'aColor');
const aIsGreen = gl.getAttribLocation(cubeProgram, 'aIsGreen');
const aFlowCoord = gl.getAttribLocation(cubeProgram, 'aFlowCoord');
const aFlowPathLen = gl.getAttribLocation(cubeProgram, 'aFlowPathLen');
const aFillPattern = gl.getAttribLocation(cubeProgram, 'aFillPattern');
const uModelView = gl.getUniformLocation(cubeProgram, 'uModelView');
const uProjection = gl.getUniformLocation(cubeProgram, 'uProjection');
const uLightDir = gl.getUniformLocation(cubeProgram, 'uLightDir');
const uLightIntensity = gl.getUniformLocation(cubeProgram, 'uLightIntensity');
const uBlueprint = gl.getUniformLocation(cubeProgram, 'uBlueprint');
const uBlueprintFillColor = gl.getUniformLocation(cubeProgram, 'uBlueprintFillColor');
const uBlueprintFillColorGreen = gl.getUniformLocation(cubeProgram, 'uBlueprintFillColorGreen');
const uFlowActive = gl.getUniformLocation(cubeProgram, 'uFlowActive');
const uFlowWorldPos = gl.getUniformLocation(cubeProgram, 'uFlowWorldPos');
const uFlowReferenceLength = gl.getUniformLocation(cubeProgram, 'uFlowReferenceLength');
const uFlowRange = gl.getUniformLocation(cubeProgram, 'uFlowRange');
const uFlowPad = gl.getUniformLocation(cubeProgram, 'uFlowPad');
const uFlowPulseDensity = gl.getUniformLocation(cubeProgram, 'uFlowPulseDensity');
const uFlowSigma = gl.getUniformLocation(cubeProgram, 'uFlowSigma');
const uFlowColor = gl.getUniformLocation(cubeProgram, 'uFlowColor');
const uFlowCoreColor = gl.getUniformLocation(cubeProgram, 'uFlowCoreColor');
const uFlowHeadWorldSigma = gl.getUniformLocation(cubeProgram, 'uFlowHeadWorldSigma');
const uFlowCoreWorldSigma = gl.getUniformLocation(cubeProgram, 'uFlowCoreWorldSigma');
const uFlowTailWorldSigma = gl.getUniformLocation(cubeProgram, 'uFlowTailWorldSigma');
const uFlowTailFalloffExponent = gl.getUniformLocation(cubeProgram, 'uFlowTailFalloffExponent');
const uFlowTailVisible = gl.getUniformLocation(cubeProgram, 'uFlowTailVisible');
const uHatchLineColor = gl.getUniformLocation(cubeProgram, 'uHatchLineColor');
const uLineFrequency = gl.getUniformLocation(cubeProgram, 'uLineFrequency');
const uDotFrequency = gl.getUniformLocation(cubeProgram, 'uDotFrequency');
const uDotRadius = gl.getUniformLocation(cubeProgram, 'uDotRadius');
const uPlusFrequency = gl.getUniformLocation(cubeProgram, 'uPlusFrequency');
const uPlusArmHalf = gl.getUniformLocation(cubeProgram, 'uPlusArmHalf');
const uPlusThickness = gl.getUniformLocation(cubeProgram, 'uPlusThickness');

const aLinePosition = gl.getAttribLocation(lineProgram, 'aLinePosition');
const aLineColor = gl.getAttribLocation(lineProgram, 'aLineColor');
const uLineModelView = gl.getUniformLocation(lineProgram, 'uLineModelView');
const uLineProjection = gl.getUniformLocation(lineProgram, 'uLineProjection');
const uLineAlpha = gl.getUniformLocation(lineProgram, 'uLineAlpha');

gl.enable(gl.DEPTH_TEST);
gl.clearColor(0, 0, 0, 1);

// Minimal column-major mat4 helpers (matches WebGL's native matrix layout).
function mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function mat4Perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  // prettier-ignore
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

// True isometric is an orthographic (parallel-projection) view — no
// perspective foreshortening, unlike mat4Perspective above.
function mat4Ortho(left, right, bottom, top, near, far) {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  // prettier-ignore
  return new Float32Array([
    -2 * lr, 0, 0, 0,
    0, -2 * bt, 0, 0,
    0, 0, 2 * nf, 0,
    (left + right) * lr, (top + bottom) * bt, (far + near) * nf, 1,
  ]);
}

function mat4RotateX(theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  // prettier-ignore
  return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]);
}

function mat4RotateY(theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  // prettier-ignore
  return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]);
}

function mat4Translate(x, y, z) {
  // prettier-ignore
  return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]);
}

function mat4Scale(s) {
  // prettier-ignore
  return new Float32Array([s,0,0,0, 0,s,0,0, 0,0,s,0, 0,0,0,1]);
}

// prettier-ignore
const IDENTITY_MAT4 = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

// Orthographic frustum half-size chosen to match how big the cube read
// under the old 45°-fov perspective projection at the same camera distance
// (distance * tan(fovy/2)), so switching to isometric didn't also change
// the cube's apparent size on screen. This is the reference half-size for
// a square viewport; updateCubeProjection derives the actual per-axis
// half-extents (cubeProjectionHalfX/Y) from it below.
const CUBE_ORTHO_HALF_SIZE = (5 * Math.tan(Math.PI / 8)) / 10;
let cubeProjectionHalfX = CUBE_ORTHO_HALF_SIZE;
let cubeProjectionHalfY = CUBE_ORTHO_HALF_SIZE;
let cubeProjection = mat4Ortho(-cubeProjectionHalfX, cubeProjectionHalfX, -cubeProjectionHalfY, cubeProjectionHalfY, 0.1, 100);

// Replicates the "cover fit" a 2D-crop blit used to give for free: the
// shorter display axis keeps the full reference half-size (nothing is
// ever clipped on that axis), while the longer axis's half-extent shrinks
// in proportion to the aspect ratio, so panning/framing looks identical to
// the old square-render-then-crop pipeline without an extra pixel crop —
// see raycastGreenMesh below, which must read back these exact half-extents
// (not the fixed reference one) to unproject a pointer position correctly.
function updateCubeProjection(aspect) {
  if (aspect >= 1) {
    cubeProjectionHalfX = CUBE_ORTHO_HALF_SIZE;
    cubeProjectionHalfY = CUBE_ORTHO_HALF_SIZE / aspect;
  } else {
    cubeProjectionHalfY = CUBE_ORTHO_HALF_SIZE;
    cubeProjectionHalfX = CUBE_ORTHO_HALF_SIZE * aspect;
  }
  cubeProjection = mat4Ortho(-cubeProjectionHalfX, cubeProjectionHalfX, -cubeProjectionHalfY, cubeProjectionHalfY, 0.1, 100);
}

// 10% of the original size (which was itself "300% smaller", i.e. a third
// the size); the "Model size" slider (cubeSizeScale) multiplies on top of
// this.
const CUBE_SCALE = (1 / 3) * 0.1;

// Model's on-canvas X/Y position, as a slider value from -300 to 300 applied
// as an object-space translate *inside* rotation in renderCubeFrame (i.e.
// before rotation, so it's rigid with the model — see getObjectSpacePan for
// why). MODEL_POSITION_RANGE converts that value into view-space units
// (divided by 100, so ±100 — a third of the slider's travel — is where the
// offset just carries the model past the ortho frustum's edge, i.e.
// CUBE_ORTHO_HALF_SIZE plus roughly the default-size model's own
// half-extent); the rest of the range up to ±300 keeps panning it well
// off-canvas. Deliberately session-only (not persisted/restored via
// localStorage like the other sliders) — always starts at 0,0 on a fresh
// page load rather than reopening wherever a previous session's camera
// move/pan happened to leave it.
const MODEL_POSITION_MIN = -300;
const MODEL_POSITION_MAX = 300;
const MODEL_POSITION_RANGE = CUBE_ORTHO_HALF_SIZE * 1.2;
let modelOffsetXPercent = 0;
let modelOffsetYPercent = 0;
// Third pan axis, same range/units/session-only persistence as X/Y — unused
// by the default isometric view (there's no "Model Z position" slider), but
// driven by vertical drag while the bird's-eye camera (Space held — see the
// Space keydown handler) is active, since at a 90° top-down pitch it's this
// axis, not Y, that reads as forward/back movement across the ground plane
// on screen.
let modelOffsetZPercent = 0;

function clampModelPosition(percent) {
  return Math.max(MODEL_POSITION_MIN, Math.min(MODEL_POSITION_MAX, percent));
}

function setModelOffsetXPercent(percent) {
  const clamped = clampModelPosition(percent);
  modelOffsetXPercent = clamped;
  return clamped;
}

function setModelOffsetYPercent(percent) {
  const clamped = clampModelPosition(percent);
  modelOffsetYPercent = clamped;
  return clamped;
}

function setModelOffsetZPercent(percent) {
  const clamped = clampModelPosition(percent);
  modelOffsetZPercent = clamped;
  return clamped;
}

function resetModelPosition() {
  setModelOffsetXPercent(0);
  setModelOffsetYPercent(0);
  setModelOffsetZPercent(0);
}

// Shared by renderCubeFrame and raycastGreenMesh's unprojection so the two
// stay in sync — the raycast has to undo the exact same view-space
// translate the render pass applies, or drawing on a panned model would hit
// the wrong spot.
function getModelViewOffset() {
  return [
    (modelOffsetXPercent / 100) * MODEL_POSITION_RANGE,
    (modelOffsetYPercent / 100) * MODEL_POSITION_RANGE,
    (modelOffsetZPercent / 100) * MODEL_POSITION_RANGE,
  ];
}

// Camera depth in view space — how far back the "camera" sits from the
// model along Z. Kept as its own mutable seam (rather than inlined into the
// translate call) so future scripted movement-through-the-model can drive it
// per frame. Because this translate is applied *after* rotation in
// renderCubeFrame's modelView build (see below), changing it can never
// affect cubeRotX/Y or the hover parallax (cubeParallaxX/Y) — rotation stays
// live no matter where the camera currently sits.
let cameraOffsetZ = -5;

// Classic isometric angles: 45° yaw so all three visible faces read as
// equally foreshortened, and a ~35.264° (arctan(1/sqrt(2))) downward pitch
// — the "magic angle" where a cube's edges project at exactly 30° from
// horizontal, which is what makes an isometric view look isometric rather
// than just "some 3/4 angle." Positive because mat4RotateX at a positive
// theta rotates the model's +Y (top face) normal toward +Z, i.e. toward the
// camera — so the camera ends up above the object looking down onto its top
// face, rather than seeing the underside from below.
const CUBE_ISO_YAW = Math.PI / 4;
const CUBE_ISO_PITCH = Math.atan(1 / Math.SQRT2);

// Bird's-eye camera: straight down (90° pitch) with yaw reset to 0, used
// while Space is held (see the Space keydown/keyup handlers below) so the
// user can fly over and navigate the scene from directly above. Yaw is
// zeroed (not left at whatever it currently is) specifically so the ground
// plane isn't left sitting at a diagonal — with no yaw, object-space X and Z
// map cleanly onto screen-horizontal and screen-vertical, which is what lets
// the Space-drag pan below move along X/Z (ground-plane, "left/right" and
// "up/down through the scene") instead of the default view's X/Y.
const CUBE_BIRDSEYE_YAW = 0;
const CUBE_BIRDSEYE_PITCH = Math.PI / 2;

// Starts in the bird's-eye pose (rather than straight at CUBE_ISO_PITCH/
// YAW) so the bundled model's very first visible frame, once it's actually
// loaded, reads as a deliberate top-down opening shot rather than already
// sitting at its resting angle; loadBundledDefaultModel eases this into the
// actual resting rotation once the model's ready (see its
// tweenCubeRotationTo call, MODEL_LOAD_ROTATION_INTRO_MS). The /scroll route
// (IS_SCROLL_ROUTE) skips that whole opening shot, so it starts pinned
// directly at the resting angle instead — nothing ever tweens away from it.
let cubeRotX = IS_SCROLL_ROUTE ? CUBE_ISO_PITCH : CUBE_BIRDSEYE_PITCH;
let cubeRotY = IS_SCROLL_ROUTE ? CUBE_ISO_YAW : CUBE_BIRDSEYE_YAW;
let cubeDragging = false;
let cubeLastPointer = null;

// Space-to-fly: holding Space rises into a bird's-eye view (see
// tweenCubeRotationTo/CUBE_BIRDSEYE_PITCH below) and dragging moves the
// model on the ground plane (modelOffsetXPercent/ZPercent — X has its own
// "Model X position" slider, Z has none since it's bird's-eye-only) instead
// of rotating it, regardless of whether click-drag rotation is enabled.
// Takes priority over rotation-drag while held (see the pointerdown handler
// below).
let spaceHeld = false;
let panDragging = false;
let panLastPointer = null;
// Held-Z drag (see zKeyHeld below): independent of Space/bird's-eye —
// vertical drag alone adjusts object-space Y (height), same up-is-positive
// convention as the "Model Y position" slider.
let zDragging = false;
let zLastPointer = null;
// Plain (no-modifier) drag while editingDefaultView is active (see
// setEditingDefaultView) — rotation-drag is locked in that mode anyway, so
// the ordinary drag gesture pans instead of doing nothing, without needing
// Space held — same X/Z ground-plane mapping panDragging (Space-drag) uses,
// deliberately never Y: height is locked while editing the default position
// (see the Z keydown handler and the panel's "Model Y position" slider,
// both gated on editingDefaultView too), so there's exactly one axis pair
// this mode can ever touch.
let editPanDragging = false;
let editPanLastPointer = null;
let zKeyHeld = false; // declared up here (not by the Z keydown/keyup handlers further below) since updateCubeCursor, defined next, reads it immediately
let panSyncRAF = null; // see schedulePanSync below

// setModelOffsetXPercent/YPercent/ZPercent trigger a full panel re-render on
// every call — fine for the sliders (one call per user action), but calling
// them on every single pointermove while panning made the drag visibly
// janky, since a pointer can fire many move events per rendered frame.
// Panning instead mutates the raw percent variables directly (cheap) and
// batches the panel notify to once per animation frame via this, with
// pointerup doing one final synchronous flush so the panel never lags
// behind once the drag actually stops.
function schedulePanSync() {
  if (panSyncRAF !== null) return;
  panSyncRAF = requestAnimationFrame(() => {
    panSyncRAF = null;
    notifyModelState();
  });
}
function flushPanSync() {
  if (panSyncRAF !== null) {
    cancelAnimationFrame(panSyncRAF);
    panSyncRAF = null;
  }
  notifyModelState();
}

// Ambient parallax tilt: a small extra rotation, layered on top of
// cubeRotX/Y, that follows the cursor's position anywhere on the page.
// cubeParallaxTargetX/Y track the cursor instantly; cubeParallaxX/Y ease
// toward that target a little each frame (see renderCubeFrame) so the tilt
// reads as a soft parallax drift rather than snapping straight to the mouse.
// Suspended while dragging so the two rotation sources don't fight.
const CUBE_PARALLAX_MAX_RAD = 0.2;
const CUBE_PARALLAX_SMOOTHING = 0.1;
let cubeParallaxTargetX = 0;
let cubeParallaxTargetY = 0;

// A touch starting over the title/cards (heroContentEl's own on-screen
// bounds, read live since it reflows across breakpoints) is left alone
// entirely — never tracked, so it's always free for native page scroll. A
// touch starting on the clean canvas above that drives the tilt instead;
// canvas.style.touchAction is flipped to 'none' for just that one touch (see
// its pointerdown handler) so native scroll doesn't fight the drag, and back
// to the CSS default ('pan-y') on release so the next touch starts fresh.
//
// '.hero-content' is this repo's own demo overlay (hero.html); the FE
// handover build (canvas.html) ships no overlay markup of its own, since
// the FE team's homepage already has its own hero UI. That page can point
// this at its real overlay wrapper via
// `<canvas data-hero-content-selector="#selector">`; left unset (or
// unmatched), heroContentEl is null and the exclusion below is skipped
// entirely — every touch on the canvas drives the tilt, so the FE side
// should set this to whatever wraps their title/cards, the same way
// hero.html's own .hero-content does, or their users won't be able to
// touch-scroll past that text.
const heroContentEl = document.querySelector(canvas.dataset.heroContentSelector || '.hero-content');
let heroTouchDragPointerId = null;
let cubeParallaxX = 0;
let cubeParallaxY = 0;
// Whether a real cursor reading has ever come in — see
// updateParallaxTargetFromPointer, which kicks off a one-time slow reveal
// (CUBE_PARALLAX_INIT_REVEAL_MS, see advanceParallax below) toward it the
// first time only, rather than easing there via the normal fast
// CUBE_PARALLAX_SMOOTHING from the placeholder 0 the variables above start
// at — that read as an unexplained jump; an instant snap (tried first) read
// as an equally unexplained pop. A slower, deliberate reveal is the middle
// ground: still clearly *arriving* rather than popping in, but slow enough
// not to read as chasing the cursor the way the original per-frame ease did.
let cubeParallaxRegistered = false;
const CUBE_PARALLAX_INIT_REVEAL_MS = 2500;
let cubeParallaxInitRevealStartTime = null;
let cubeParallaxInitRevealFromX = 0;
let cubeParallaxInitRevealFromY = 0;

// Tweens the model to a given rotation angle — both the drag rotation
// (cubeRotX/Y) and the ambient parallax tilt (cubeParallaxX/Y and its
// target) ease toward the target/zero respectively. Animated as a fast ease
// (see the tween applied in renderCubeFrame) rather than an instant jump, so
// it reads as a deliberate snap instead of a jarring cut. Used both for
// snapping back to the default framed angle (resetCubeRotation, below —
// shared by the "Reset rotation" button, enabling "Pause hover movement",
// Shift+R, and Space-up) and for rising into the bird's-eye view on
// Space-down (see the keydown/keyup handlers below).
// Ease-out cubic — starts fast, decelerates into the target with no
// overshoot. The default for every fast (180ms) reset-style tween (Reset
// rotation, Space bird's-eye rise/return, the "Go to default" button),
// where the deceleration itself is what reads as "arriving."
const EASE_OUT_CUBIC = (t) => 1 - (1 - t) ** 3;

// Ease-out quad — same decelerate-to-rest shape as EASE_OUT_CUBIC but a
// gentler curve (t^2 vs t^3 falloff): less abrupt at the start, so it reads
// as a softer pull-back. Used for loadBundledDefaultModel's intro zoom
// (see cubeRotResetZoomEasing) rather than EASE_OUT_CUBIC's snappier feel,
// which suited the fast 180ms UI resets it was written for.
const EASE_OUT_QUAD = (t) => 1 - (1 - t) ** 2;

// Ease-in-out quad — the in-out counterpart of EASE_OUT_QUAD above (same
// t^2 falloff shape, mirrored to also accelerate in rather than starting at
// full speed): symmetric acceleration in, deceleration out. Used for
// loadBundledDefaultModel's intro phase 2 pan and zoom alike (see
// startIntroCameraTargetTween's call site).
const EASE_IN_OUT_QUAD = (t) => (t < 0.5 ? 2 * t ** 2 : 1 - (-2 * t + 2) ** 2 / 2);

// Ease-in-out sine — the gentlest of the in-out curves here: a plain cosine
// half-wave, so acceleration itself changes smoothly throughout (no abrupt
// kink at the midpoint the polynomial eases above have). Used for
// loadBundledDefaultModel's intro yaw settle (see startIntroYawTween's call
// site), which runs far longer than anything else in the intro and reads
// best as one continuous, unhurried turn rather than a curve tuned for a
// snappier motion.
const EASE_IN_OUT_SINE = (t) => -(Math.cos(Math.PI * t) - 1) / 2;

// Ease-in-out expo: near-flat at both ends (t^0..slow start, (1-t)^0..slow
// finish) with an exponential sweep through the middle — holds near 0 and
// near 1 longer than a plain quad/cubic ease-in-out would, giving
// loadBundledDefaultModel's bird's-eye-in intro a deliberate pause-then-snap
// character over its duration. The 0/1 endpoints are special-cased since
// 2^(-Infinity)-style underflow at t exactly 0 or 1 is what the formula
// would otherwise (harmlessly, but needlessly) rely on floating point to
// resolve to 0.
const EASE_IN_OUT_EXPO = (t) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2;
};

const CUBE_ROT_RESET_MS = 180; // fast — quicker than the modal open duration, barely more than a frame or two of "not instant"
let cubeRotResetStartTime = null;
let cubeRotResetFrom = null; // { rotX, rotY, parX, parY, parTargetX, parTargetY, sizePercent } snapshot taken at tween start
let cubeRotResetTargetX = CUBE_ISO_PITCH;
let cubeRotResetTargetY = CUBE_ISO_YAW;
// Target cubeSizePercent for this tween's optional zoom-in-then-out (see
// zoomInFactor below) — always whatever cubeSizePercent already was when
// the tween started (e.g. the baked default, applied just before
// loadBundledDefaultModel's tweenCubeRotationTo call), so the tween always
// *settles* at the same level a non-zooming caller would've held all along.
// Meaningless (and unused) whenever cubeRotResetZoomInFactor is 0.
let cubeRotResetTargetSizePercent = 100;
// Fraction above cubeRotResetTargetSizePercent the tween *starts* zoomed
// in at, easing back down to the target over the same curve/clock as the
// rotation itself (see renderCubeFrame) rather than as a separate tween —
// 0 for every existing fast reset-style caller (no zoom change at all);
// loadBundledDefaultModel's intro is the one caller that passes ~0.2, so
// the opening bird's-eye -> resting-rotation drop starts ~20% closer in and
// zooms out to the resting framing as it settles, instead of holding a
// fixed distance through the whole rotation.
let cubeRotResetZoomInFactor = 0;
// This tween's duration, in ms — defaults to CUBE_ROT_RESET_MS's fast snap
// for every existing caller (Reset rotation, Space bird's-eye rise/return,
// the "Go to default" button); loadBundledDefaultModel's initial bird's-eye
// -> resting-rotation intro is the one caller that passes something slower.
let cubeRotResetDurationMs = CUBE_ROT_RESET_MS;
// Delay, in ms, before rotation starts moving from its snapshot — the
// tween's start time (and the zoom's, which always starts immediately at
// t=0 regardless of this) is unaffected; only rotation's own t/eased clock
// is offset by this. 0 for every existing caller; loadBundledDefaultModel's
// intro passes ~500 so the zoom-out visibly starts pulling back before the
// rotation joins in, rather than both firing in the same instant.
let cubeRotResetDelayMs = 0;
// The zoom's own duration, in ms — independent of cubeRotResetDurationMs
// (rotation's) so the zoom can keep easing after rotation has already
// landed, both sharing the same start time. Defaults to durationMs (the
// two run in lockstep, as they did before this was split out) for every
// existing caller; loadBundledDefaultModel's intro passes a longer one so
// the zoom-out keeps going through the pause before phase 2. Meaningless
// (and unused) whenever cubeRotResetZoomInFactor is 0.
let cubeRotResetZoomDurationMs = CUBE_ROT_RESET_MS;
// This tween's easing curve — see EASE_OUT_CUBIC/EASE_IN_OUT_EXPO above.
let cubeRotResetEasing = EASE_OUT_CUBIC;
// The zoom's own easing curve — independent of cubeRotResetEasing
// (rotation's) for the same reason its duration is split out above.
// Defaults to EASE_OUT_CUBIC (decelerate-into-place, no overshoot) rather
// than mirroring `easing`, since a zoom reads best as a straightforward
// pull-back that keeps slowing down all the way to rest — unlike
// rotation's EASE_IN_OUT_EXPO pause-then-snap character, which would make
// the zoom look like it stalls partway through. Meaningless (and unused)
// whenever cubeRotResetZoomInFactor is 0.
let cubeRotResetZoomEasing = EASE_OUT_CUBIC;
// Whether this tween also drives cubeParallaxX/Y itself (decaying the
// snapshot back toward zero, same as the base rotation easing toward its
// target — see renderCubeFrame) instead of leaving them to the normal
// per-frame hover easing. True for every existing fast (180ms) reset-style
// tween, where a live hover fighting a snap this quick would just look like
// jitter. False for loadBundledDefaultModel's slow 2s intro specifically —
// long enough that suppressing hover for its whole duration would read as
// hover simply not working yet, so that one leaves parallax on the normal
// path and just lets the two motions run concurrently.
let cubeRotResetSuppressParallax = true;

function tweenCubeRotationTo(targetRotX, targetRotY, durationMs = CUBE_ROT_RESET_MS, suppressParallax = true, easing = EASE_OUT_CUBIC, zoomInFactor = 0, zoomDurationMs = durationMs, zoomEasing = EASE_OUT_CUBIC, delayMs = 0) {
  // cubeSizePercent as it already stands when the tween starts is the level
  // it settles back to at the end — for loadBundledDefaultModel that's the
  // baked default view's sizePercent, already applied synchronously just
  // before this call (see applyDefaultCameraViewPanZoom), unchanged from
  // before this tween had any zoom effect at all.
  const targetSizePercent = cubeSizePercent;
  cubeRotResetFrom = {
    rotX: cubeRotX,
    rotY: cubeRotY,
    parX: cubeParallaxX,
    parY: cubeParallaxY,
    parTargetX: cubeParallaxTargetX,
    parTargetY: cubeParallaxTargetY,
    sizePercent: targetSizePercent * (1 + zoomInFactor),
  };
  cubeRotResetTargetX = targetRotX;
  cubeRotResetTargetY = targetRotY;
  cubeRotResetTargetSizePercent = targetSizePercent;
  cubeRotResetZoomInFactor = zoomInFactor;
  cubeRotResetZoomDurationMs = zoomDurationMs;
  cubeRotResetZoomEasing = zoomEasing;
  cubeRotResetSuppressParallax = suppressParallax;
  cubeRotResetDurationMs = durationMs;
  cubeRotResetEasing = easing;
  cubeRotResetDelayMs = delayMs;
  cubeRotResetStartTime = performance.now();
}

function resetCubeRotation() {
  introYawTweenActive = false; // a manual reset takes over yaw too — see introYawTweenActive's own comment
  tweenCubeRotationTo(CUBE_ISO_PITCH, CUBE_ISO_YAW);
}

// Intro-only Y-axis (yaw) settle: loadBundledDefaultModel wants cubeRotY to
// keep gently turning across BOTH phase 1 and phase 2's combined duration
// (see MODEL_LOAD_TOTAL_INTRO_MS), well past phase 1's own short rotation
// tween (cubeRotResetStartTime above, which fully lands by the end of phase
// 1). A separate tween is what makes that possible — tweenCubeRotationTo
// couples X/Y to a single shared clock, so reusing it here would force yaw
// onto pitch's much shorter timeline. Applied in renderCubeFrame after the
// cubeRotResetStartTime block, so it has the final say over cubeRotY
// whenever both are active (i.e., for the whole of phase 1) — pitch and yaw
// visually move together at first even though they're on separate clocks,
// since phase 1's own (moot, while this tween is active) yaw target is set
// to a no-op — see startIntroYawTween's call site.
let introYawTweenActive = false;
let introYawTweenStartTime = null;
let introYawFrom = 0;
let introYawTo = 0;
let introYawDurationMs = 0;
let introYawEasing = EASE_OUT_CUBIC;

function startIntroYawTween(fromRad, toRad, durationMs, easing) {
  cubeRotY = fromRad;
  introYawFrom = fromRad;
  introYawTo = toRad;
  introYawDurationMs = durationMs;
  introYawEasing = easing;
  introYawTweenStartTime = performance.now();
  introYawTweenActive = true;
}

// "Pause hover movement" control: freezes the ambient parallax tilt so the
// model holds still regardless of cursor position, snapping back to the
// default framed angle (via resetCubeRotation above) rather than staying
// wherever it was when paused.
let hoverMovementPaused = false;

function setHoverMovementPaused(value) {
  hoverMovementPaused = value;
  if (value) resetCubeRotation();
}

// "Photo mode": entered/left with the P key (see the keydown handler below)
// to compose a clean shot before exporting — while active, ambient hover
// parallax is locked out (same guard list as hoverMovementPaused/
// editingDefaultView, see updateParallaxTargetFromPointer) and the
// orientation is snapped to the default isometric angle via
// resetCubeRotation, same as enabling "Pause hover movement" does. Unlike
// hoverMovementPaused, this doesn't otherwise restrict drag-rotation/zoom/
// pan — it only fixes the *starting* orientation and freezes hover, so
// there's nothing to undo on exit.
let photoMode = false;

function setPhotoMode(value) {
  value = !!value;
  if (value === photoMode || videoRecording || pngSequenceExporting) return;
  photoMode = value;
  if (value) {
    resetCubeRotation();
    if (videoMode) videoMode = false; // mutually exclusive with video mode, see setVideoMode
  }
  notifyModelState(); // drives the panel's bottom-center photo-mode indicator, same as spaceHeld
}

// The panel's small photo-options card (shown only while photoMode is
// active — see getModelState) drives both of these; Enter always captures
// using whatever they're currently set to (see the photo-mode Enter handler
// below), rather than Cmd/Ctrl+Enter or Shift+Cmd/Ctrl+Enter being separate
// one-off variants — one capture trigger, state lives in the panel.
let photoExport2x = true;
let photoUniformLineWidth = true;

function setPhotoExport2x(value) {
  photoExport2x = !!value;
  notifyModelState();
}

function setPhotoUniformLineWidth(value) {
  photoUniformLineWidth = !!value;
  notifyModelState();
}

// "Video mode": sibling to photo mode above, entered/left with the V key —
// same orientation-lock/hover-freeze behavior (see updateParallaxTargetFromPointer),
// but Enter starts a fixed-length recording (see captureVideo), and
// Cmd/Ctrl+Enter starts a frame-by-frame PNG sequence export instead (see
// capturePngSequence), instead of an instant still. Mutually exclusive with
// photo mode (each turns the other off on entry) so Enter is never ambiguous
// about which capture it triggers.
let videoMode = false;
// True only for the duration of an in-progress captureVideo() recording —
// kept separate from videoMode itself so the mode stays entered (for a
// retake) once a clip finishes, while a second Enter mid-recording, or a V/P
// press trying to switch modes mid-capture, is ignored rather than
// corrupting the in-flight export.
let videoRecording = false;
// True only for the duration of an in-progress capturePngSequence() export —
// a wholly separate flag from videoRecording (rather than reusing it)
// despite the two exports being mutually exclusive in practice and treated
// identically by renderLoop/renderCubeFrame, since the panel still needs to
// tell them apart to show the right indicator text (see getModelState).
let pngSequenceExporting = false;
// 0..1, frames completed / total — read by getModelState so the panel can
// show export progress the way videoRecording's countdown shows elapsed
// time; unlike that countdown, this can't be derived from wall-clock time on
// the panel side, since capturePngSequence isn't bound to it.
let pngSequenceProgress = 0;

function setVideoMode(value) {
  value = !!value;
  if (value === videoMode || videoRecording || pngSequenceExporting) return;
  videoMode = value;
  if (value) {
    resetCubeRotation();
    if (photoMode) photoMode = false; // mutually exclusive with photo mode, see setPhotoMode
  }
  notifyModelState(); // drives the panel's bottom-center video-mode indicator, same as photoMode
}

// "Disable rotation" control: click-and-drag rotation is off by default so
// visitors can't accidentally spin the model away from its framed angle.
let rotationDisabled = true;
// "Edit default position" mode (the panel button toggles this via
// setEditingDefaultView, defined further down alongside defaultCameraView)
// — while active, the user can only pan X/Z (plain drag — see
// editPanDragging — or the "Model X position" slider) and zoom (scroll/
// "Model size" slider) the free camera. Everything else that could move the
// view is locked: rotation dragging (see the pointerdown handler), height/Y
// (see the Z keydown handler and the panel's "Model Y position" slider —
// defaultCameraView.offsetY just carries through whatever it already was,
// since nothing in this mode can ever change it), and Camera Targets (see
// the Digit1/2/3 handler and the panel's target "Go" buttons). There's no
// target object to auto-frame here the way Camera Targets have, so this is
// the only way to define what "the default position" actually is: park the
// free camera by hand, then capture it. Declared here (rather than next to
// setEditingDefaultView) specifically so it's initialized before
// updateCubeCursor's own top-level call just below,
// which reads it.
let editingDefaultView = false;

function updateCubeCursor() {
  canvas.style.cursor = spaceHeld || zKeyHeld || editingDefaultView || !rotationDisabled ? 'grab' : 'default';
}

function setRotationDisabled(value) {
  rotationDisabled = value;
  if (!cubeDragging) updateCubeCursor();
}

updateCubeCursor();

// Held Space rises into a bird's-eye view (straight-down pitch, zero yaw —
// see CUBE_BIRDSEYE_PITCH/YAW) to fly over and navigate the scene, same
// spirit as the space-pan idiom in Figma/Photoshop but repurposed for a
// top-down look instead of a same-angle pan. Guarded against
// inputs/textareas/selects so it doesn't fight typing a value into a slider
// or the model-name select, and preventDefault stops the page from
// scrolling (there's normally nothing to scroll, but also stops Space from
// re-clicking whatever button last had focus).
// Read by updateParallaxTargetFromPointer (always active, even in the hero
// build) — declared here, outside the `if (!IS_HERO)` guard below, so it
// stays in scope for that function regardless of which build this is; the
// held-R listeners that actually set it true are still gated.
let rKeyHeld = false;

// True while focus sits on a control that already handles its own
// Enter/Space keyboard activation — form fields, and (since the React panel
// added switches for the photo-mode options card) any button or
// role="switch"/role="button" element, which base-ui's Switch renders as.
// Every single-key/Enter shortcut below checks this first, so pressing
// Enter/P/V/etc. while a panel switch or input has focus activates just
// that control instead of also firing the app-wide shortcut — e.g. Enter
// toggling the "Uniform line width" switch it's focused on *and* capturing
// a photo in the same keypress.
function focusIsOnInteractiveControl() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return true;
  const role = el.getAttribute && el.getAttribute('role');
  return role === 'switch' || role === 'button';
}

if (!IS_HERO) {
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || spaceHeld) return;
  if (focusIsOnInteractiveControl()) return;
  event.preventDefault();
  spaceHeld = true;
  introYawTweenActive = false; // manual bird's-eye rise takes over yaw too — see introYawTweenActive's own comment
  tweenCubeRotationTo(CUBE_BIRDSEYE_PITCH, CUBE_BIRDSEYE_YAW);
  if (!cubeDragging) updateCubeCursor();
  notifyModelState(); // panel's "Press space to move" indicator flips to "Release to enter rotation mode"
});
window.addEventListener('keyup', (event) => {
  if (event.code !== 'Space') return;
  spaceHeld = false;
  resetCubeRotation(); // back down to the default framed angle, same fast ease as the rise on Space-down
  if (!panDragging) updateCubeCursor();
  notifyModelState();
});
// Dropping focus (e.g. alt-tabbing away) mid-hold never fires a matching
// keyup — without this, spaceHeld/panDragging could get stuck on, and the
// camera could get stranded up in the bird's-eye view.
window.addEventListener('blur', () => {
  const wasSpaceHeld = spaceHeld;
  spaceHeld = false;
  if (panDragging) {
    panDragging = false;
    flushPanSync();
  }
  if (wasSpaceHeld) {
    resetCubeRotation();
    notifyModelState();
  }
  updateCubeCursor();
});

// Held R is a quick, temporary "enable rotation" shortcut — click-drag
// rotation turns on for as long as it's held and back off the moment it's
// released, regardless of whatever the panel's "Disable rotation" switch is
// set to. Unlike Space, it never resets rotation on its own — pressing or
// releasing R always leaves the model at whatever angle it was already at.
// rKeyHeld (separate from rotationDisabled itself) exists purely to ignore
// keyboard auto-repeat's duplicate keydown events while held.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyR') return;
  if (focusIsOnInteractiveControl()) return;
  // Shift+R is a one-shot "reset orientation to default" shortcut,
  // independent of the plain-R hold-to-rotate gesture below.
  if (event.shiftKey) {
    event.preventDefault();
    resetCubeRotation();
    return;
  }
  if (rKeyHeld) return;
  rKeyHeld = true;
  setRotationDisabled(false);
  notifyModelState();
});
window.addEventListener('keyup', (event) => {
  if (event.code !== 'KeyR' || !rKeyHeld) return;
  rKeyHeld = false;
  setRotationDisabled(true);
  // Unlike Space, releasing R does NOT reset rotation — whatever angle the
  // user left it at while rotating should stick.
  notifyModelState();
});
// Same reasoning as the Space blur handler above — alt-tabbing away mid-hold
// never fires a matching keyup.
window.addEventListener('blur', () => {
  if (!rKeyHeld) return;
  rKeyHeld = false;
  setRotationDisabled(true);
  notifyModelState();
});

// Held Z is its own drag gesture, independent of Space/bird's-eye: click and drag
// while it's held adjusts object-space Y (height) directly — see
// zDragging's pointerdown/pointermove/pointerup handling below. Excludes
// Cmd/Ctrl+Z, which is the flow-arrow undo shortcut below instead. Also
// excluded while editingDefaultView is active — height is locked while
// editing the default position (see editPanDragging's comment).
window.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyZ' || zKeyHeld || event.metaKey || event.ctrlKey || editingDefaultView) return;
  if (focusIsOnInteractiveControl()) return;
  zKeyHeld = true;
  if (!zDragging) updateCubeCursor();
});
window.addEventListener('keyup', (event) => {
  if (event.code !== 'KeyZ') return;
  zKeyHeld = false;
  if (!zDragging) updateCubeCursor();
});
window.addEventListener('blur', () => {
  zKeyHeld = false;
  if (!zDragging) updateCubeCursor();
});

// Cmd+Z (Mac) / Ctrl+Z (Windows/Linux) undoes the most recently finalized
// flow arrow — same action as the panel's "Undo last arrow" button, just
// without needing draw mode active first (matches that button, which is
// always clickable). preventDefault stops the browser's own undo from also
// firing (e.g. undoing an accidental text selection).
window.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyZ' || !(event.metaKey || event.ctrlKey) || event.shiftKey) return;
  if (focusIsOnInteractiveControl()) return;
  event.preventDefault();
  undoLastModelFlowArrow();
});

// Delete/Backspace removes whichever flow arrow is currently selected (see
// setModelFlowSelectMode/the select-mode click handler) — same action as the
// panel's "Delete selected" button. A no-op (deleteSelectedModelFlowArrow
// itself just returns) when nothing's selected, so this never fights
// Backspace's normal job of erasing text in a focused field — the
// input/textarea/select guard below covers that anyway.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Delete' && event.code !== 'Backspace') return;
  if (selectedFlowArrowIndex === null) return;
  if (focusIsOnInteractiveControl()) return;
  event.preventDefault();
  deleteSelectedModelFlowArrow();
});

// A is a plain toggle (unlike Space/R/Z's hold gestures) for the "Draw flow
// arrow" mode — press to enter, press again to leave. setModelFlowDraw
// already handles the enter/leave side effects (resetting position/rotation,
// dropping an in-progress arrow) and notifies the panel, same as its Switch.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyA' || event.repeat) return;
  if (focusIsOnInteractiveControl()) return;
  event.preventDefault();
  setModelFlowDraw(!modelFlowDrawMode);
});

// The /scroll route (IS_SCROLL_ROUTE) drops photo/video mode entirely, same
// as it drops the opening camera move (see the flag's own declaration) —
// none of the P/Escape/Shift+P/V/Enter/Cmd+Enter handlers below are wired up
// there, so those keys are plain no-ops on that route.
if (!IS_SCROLL_ROUTE) {
// P enters photo mode (see setPhotoMode/photoMode's own comment) — no
// longer a toggle: once photoMode is already on, plain P is a no-op rather
// than exiting, since P and Shift+P (capture, just below) are one keystroke
// apart and exiting on a mistyped Shift would be an easy way to lose the
// framing mid-shoot. Esc is the only way out (see the handler below).
// Excludes Shift so it doesn't also fire alongside Shift+P.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyP' || event.shiftKey || event.repeat || photoMode) return;
  if (focusIsOnInteractiveControl()) return;
  event.preventDefault();
  setPhotoMode(true);
});

// Escape exits photo mode — the only way out now that P only enters (see
// the handler above). A no-op outside photo mode so it doesn't fight
// Escape's other browser/panel uses (e.g. blurring a focused control) when
// photo mode isn't active.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Escape' || !photoMode || event.repeat) return;
  event.preventDefault();
  setPhotoMode(false);
});

// Shift+P captures the photo while photo mode is active — a no-op
// otherwise, so it never fights the browser's/panel's own default keyboard
// behavior. Resolution comes from the panel's current photoExport2x toggle
// (see the small photo-options card shown while photoMode is active) rather
// than a modifier-key variant — one capture trigger, state lives in the
// panel instead of which key combo was pressed. The line-width behavior
// isn't passed through here at all — renderCubeFrame reads
// photoUniformLineWidth live, so the capture just gets whatever the preview
// was already showing.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyP' || !event.shiftKey || !photoMode || event.repeat) return;
  if (focusIsOnInteractiveControl()) return;
  event.preventDefault();
  capturePhoto(photoExport2x ? PHOTO_EXPORT_MAX_DIMENSION_2X : PHOTO_EXPORT_MAX_DIMENSION);
});

// V is the same kind of plain toggle as P above, for video mode (see
// setVideoMode/videoMode's own comment).
window.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyV' || event.repeat) return;
  if (focusIsOnInteractiveControl()) return;
  event.preventDefault();
  setVideoMode(!videoMode);
});

// Enter starts a recording (see VIDEO_EXPORT_DURATION_MS) while video mode
// is active and no capture is already running — mirrors the photo-mode
// Enter handler above; a second Enter mid-recording, or a plain Enter while
// a PNG sequence export is running, is a no-op via the videoRecording/
// pngSequenceExporting checks. Excludes Cmd/Ctrl+Enter (see the next
// handler) so a single keypress can't fire both at once.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Enter' || !videoMode || videoRecording || pngSequenceExporting || event.metaKey || event.ctrlKey || event.repeat) return;
  if (focusIsOnInteractiveControl()) return;
  event.preventDefault();
  captureVideo();
});

// Cmd+Enter (Ctrl+Enter off Mac, same convention KeyZ's undo shortcut above
// uses) starts a PNG-sequence export instead of a real-time recording — see
// capturePngSequence's own comment for why you'd want this over plain Enter.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Enter' || !(event.metaKey || event.ctrlKey) || !videoMode || videoRecording || pngSequenceExporting || event.repeat) return;
  if (focusIsOnInteractiveControl()) return;
  event.preventDefault();
  capturePngSequence();
});
} // end if (!IS_SCROLL_ROUTE) — photo/video mode

// 1-7 jump straight to Camera Target 1-7 (see goToCameraTarget), same
// shortcut as each target's own "Go" button in the panel. Ignored while
// editingDefaultView is active — see setEditingDefaultView — since jumping
// to a target would take over centering entirely, out from under an
// in-progress pan/zoom edit. Matches CAMERA_TARGET_SLOT_COUNT (7) — kept as
// a literal object here (like before, when it only covered 3) rather than
// generated from that constant, since CAMERA_TARGET_SLOT_COUNT isn't
// declared until further down the file and this runs at module-eval time.
const CAMERA_TARGET_DIGIT_KEYS = {
  Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4, Digit6: 5, Digit7: 6,
};
window.addEventListener('keydown', (event) => {
  const slotIndex = CAMERA_TARGET_DIGIT_KEYS[event.code];
  if (slotIndex === undefined || event.repeat) return;
  if (focusIsOnInteractiveControl()) return;
  if (!cameraTargetSlots[slotIndex] || editingDefaultView) return; // nothing assigned to this slot yet
  event.preventDefault();
  goToCameraTarget(slotIndex);
});

// 0 jumps to the baked-in default view (see goToDefaultCameraView), same
// shortcut pattern as 1/2/3 above for the Camera Targets. goToDefaultCameraView
// itself already no-ops while editingDefaultView is active, but the guard is
// mirrored here too so the key doesn't even preventDefault for nothing.
window.addEventListener('keydown', (event) => {
  if (event.code !== 'Digit0' || event.repeat) return;
  if (focusIsOnInteractiveControl()) return;
  if (!defaultCameraView || editingDefaultView) return; // nothing saved yet
  event.preventDefault();
  goToDefaultCameraView();
});
} // end if (!IS_HERO) — keyboard shortcuts

// wheelZoomSyncRAF/scheduleWheelZoomSync stay outside the IS_HERO guard —
// renderCubeFrame's intro zoom tween (see cubeRotResetZoomInFactor) calls
// scheduleWheelZoomSync directly, so both builds need it; only the
// mouse-wheel listener itself (below) is a hero-excluded interaction.
let wheelZoomSyncRAF = null;
function scheduleWheelZoomSync() {
  if (wheelZoomSyncRAF !== null) return;
  wheelZoomSyncRAF = requestAnimationFrame(() => {
    wheelZoomSyncRAF = null;
    persistNumber('cubeSize', cubeSizePercent);
    notifyModelState();
  });
}
// IS_SCROLL_ROUTE mostly excludes this listener's actual zoom behavior (on
// top of !IS_HERO) — that route's whole point is a normal scrollable page
// around the canvas, so the wheel is normally left to the browser's native
// scroll (driving renderCubeFrame's Camera Target blend) instead of being
// captured (and preventDefault'd) for 3D zoom. The one exception is arrow
// draw mode (modelFlowDrawMode, checked inside the handler below): drawing
// needs scroll-to-zoom to frame the model, not page-scroll stepping between
// targets mid-trace, so the listener is still attached here — it just no-ops
// (leaving the wheel to native scroll) whenever draw mode isn't active.
if (!IS_HERO) {
// Scroll-to-zoom: the mouse wheel (or trackpad scroll) zooms the camera in
// and out, reusing the exact same underlying scale as the "Model size"
// slider (see applyCubeSizePercent) — so it zooms into the pivot crosshair
// for free, the same way that slider already does, and the slider stays
// live-in-sync with whatever the wheel does. Exponential rather than linear
// (each wheel "notch" scales by a fixed *ratio*, not a fixed amount) so it
// feels consistent whether zoomed way in or way out, across
// CUBE_SIZE_MIN..CUBE_SIZE_MAX's wide range. Bound to the canvas
// specifically (not window) so scrolling the side panels' own overflowing
// content doesn't also zoom the 3D view underneath them.
const CUBE_WHEEL_ZOOM_SPEED = 0.0018; // tuned so one typical mouse-wheel notch (~100 deltaY) feels like one comfortable zoom step
canvas.addEventListener(
  'wheel',
  (event) => {
    if (IS_SCROLL_ROUTE && !modelFlowDrawMode) return; // let native page scroll through — renderCubeFrame's IS_SCROLL_ROUTE branch reads window.scrollY to blend Camera Targets instead
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * CUBE_WHEEL_ZOOM_SPEED);
    applyCubeSizePercent(cubeSizePercent * factor);
    scheduleWheelZoomSync();
  },
  { passive: false },
);
} // end if (!IS_HERO) — wheel zoom

// The camera itself needs no 'scroll' listener for IS_SCROLL_ROUTE —
// renderCubeFrame reads window.scrollY directly, once per rendered frame, to
// continuously blend it between Camera Targets as the user scrolls (see its
// own IS_SCROLL_ROUTE branch). Reading it there instead of via a listener
// keeps the model's framing locked exactly to scroll position, with no
// separate throttling/sync step of its own to lag behind it.

if (!IS_HERO) {
// The hero build has no rotate-drag/space-pan/Z-height-drag/edit-view-pan
// interactions at all (see updateParallaxTargetFromPointer's own pointermove
// listener further down, kept outside this guard) — only ambient
// hover-parallax remains.
canvas.addEventListener('pointerdown', (event) => {
  if (modelFlowSelectMode) return;
  if (zKeyHeld) {
    zDragging = true;
    zLastPointer = { x: event.clientX, y: event.clientY };
    canvas.style.cursor = 'grabbing';
    return;
  }
  // Checked before the draw-mode branch below (same relative order as
  // outside draw mode) so a space-held left-click pans instead of being
  // swallowed as "reserved for tracing an arrow" — the draw-mode
  // pointerdown handler further down skips placing a point for the same
  // reason, via its own spaceHeld check.
  if (spaceHeld) {
    panDragging = true;
    panLastPointer = { x: event.clientX, y: event.clientY };
    canvas.style.cursor = 'grabbing';
    return;
  }
  // See editPanDragging's own comment — takes priority over the plain
  // rotation-drag path below (which editingDefaultView locks anyway) so an
  // ordinary drag pans immediately, with no modifier key needed.
  if (editingDefaultView) {
    editPanDragging = true;
    editPanLastPointer = { x: event.clientX, y: event.clientY };
    canvas.style.cursor = 'grabbing';
    return;
  }
  if (modelFlowDrawMode) {
    // Left button is reserved for tracing an arrow (see the draw-mode
    // pointerdown handler below); right button still rotates the model so a
    // drawing session isn't stuck at whatever angle it started at.
    if (event.button !== 2) return;
    cubeDragging = true;
    cubeLastPointer = { x: event.clientX, y: event.clientY };
    canvas.style.cursor = 'grabbing';
    return;
  }
  // editingDefaultView never reaches here — it returns via editPanDragging
  // above — but rotationDisabled still gates the plain case as normal.
  if (rotationDisabled) return;
  cubeDragging = true;
  cubeLastPointer = { x: event.clientX, y: event.clientY };
  canvas.style.cursor = 'grabbing';
});
} // end if (!IS_HERO) — pointerdown drag interactions

if (IS_HERO) {
canvas.addEventListener('pointerdown', (event) => {
  if (event.pointerType !== 'touch') return;
  // heroContentEl is null on the FE handover build (canvas.html) whenever
  // its data-hero-content-selector isn't wired up to a real element yet —
  // see heroContentEl's own comment. Nothing to exclude in that case, so
  // every touch on the canvas arms the tilt drag.
  if (heroContentEl && event.clientY >= heroContentEl.getBoundingClientRect().top) return; // over the title/cards — leave untouched for native scroll
  heroTouchDragPointerId = event.pointerId;
  canvas.style.touchAction = 'none';
});
} // end if (IS_HERO) — clean-canvas touch-drag tracking (arm)

window.addEventListener('pointermove', (event) => {
  if (IS_HERO) {
    // Only the one touch that started on the clean canvas (armed above)
    // ever reaches updateParallaxTargetFromPointer — anything else,
    // including a touch that started over the title, returns here and
    // never drives the tilt, leaving it free for native scroll.
    if (event.pointerType === 'touch' && event.pointerId !== heroTouchDragPointerId) return;
    updateParallaxTargetFromPointer(event);
    return;
  }
  if (editPanDragging) {
    // Horizontal -> X, vertical -> Z — same ground-plane mapping panDragging
    // (Space-drag) uses; see editPanDragging's own comment for why Y never
    // moves here.
    const dxPix = event.clientX - editPanLastPointer.x;
    const dyPix = event.clientY - editPanLastPointer.y;
    editPanLastPointer = { x: event.clientX, y: event.clientY };
    const percentPerPixelX = ((cubeProjectionHalfX * 2) / window.innerWidth) * (100 / MODEL_POSITION_RANGE);
    const percentPerPixelY = ((cubeProjectionHalfY * 2) / window.innerHeight) * (100 / MODEL_POSITION_RANGE);
    modelOffsetXPercent = clampModelPosition(modelOffsetXPercent + dxPix * percentPerPixelX);
    modelOffsetZPercent = clampModelPosition(modelOffsetZPercent + dyPix * percentPerPixelY);
    schedulePanSync();
    return;
  }
  if (zDragging) {
    // Vertical-only: dragging up subtracts a negative dyPix, raising Y,
    // same up-is-positive convention as the "Model Y position" slider.
    const dyPix = event.clientY - zLastPointer.y;
    zLastPointer = { x: event.clientX, y: event.clientY };
    const percentPerPixelY = ((cubeProjectionHalfY * 2) / window.innerHeight) * (100 / MODEL_POSITION_RANGE);
    modelOffsetYPercent = clampModelPosition(modelOffsetYPercent - dyPix * percentPerPixelY);
    schedulePanSync();
    return;
  }
  if (panDragging) {
    // 1:1 with the cursor: convert the pixel delta to view-space units via
    // the ortho frustum's actual on-screen size, then to the same percent
    // scale setModelOffsetXPercent/ZPercent (and MODEL_POSITION_RANGE) use.
    // This only ever runs while the bird's-eye camera is active (Space
    // held — see the keydown handler above), looking straight down with
    // zero yaw, so screen-horizontal drag maps to object-space X and
    // screen-vertical drag maps to object-space Z (the ground plane's other
    // axis) rather than Y, which at a 90° pitch would move things in depth,
    // not across the screen — Y is only reachable via the separate held-Z
    // drag above. Dragging right adds to X the same way it always has;
    // dragging down adds to Z to make the ground follow the cursor instead
    // of the camera.
    const dxPix = event.clientX - panLastPointer.x;
    const dyPix = event.clientY - panLastPointer.y;
    panLastPointer = { x: event.clientX, y: event.clientY };
    const percentPerPixelX = ((cubeProjectionHalfX * 2) / window.innerWidth) * (100 / MODEL_POSITION_RANGE);
    const percentPerPixelY = ((cubeProjectionHalfY * 2) / window.innerHeight) * (100 / MODEL_POSITION_RANGE);
    modelOffsetXPercent = clampModelPosition(modelOffsetXPercent + dxPix * percentPerPixelX);
    modelOffsetZPercent = clampModelPosition(modelOffsetZPercent + dyPix * percentPerPixelY);
    schedulePanSync();
    return;
  }
  if (cubeDragging) {
    cubeRotY += (event.clientX - cubeLastPointer.x) * 0.01;
    cubeRotX += (event.clientY - cubeLastPointer.y) * 0.01;
    cubeLastPointer = { x: event.clientX, y: event.clientY };
    return;
  }
  updateParallaxTargetFromPointer(event);
});

// Keep the model perfectly still while tracing an arrow onto it, or while
// trying to click one precisely in select mode — ambient parallax tilt
// shifting the surface under the cursor would make either one hard to do.
// Also suspended for as long as Space, R, or Z is held (spaceHeld covers
// both the pre-drag hold and the pan-drag itself, rKeyHeld the same for
// rotate-drag, zKeyHeld the same for the height drag) so none of them
// fight the manual pan/rotate/height-adjust; it simply stops updating its
// target rather than resetting, so it resumes smoothly from wherever it
// was once the key is released. Shared by the 'pointermove' listener above
// (every subsequent update) and the 'pointerenter' one below (a first
// reading as early as possible after load — see its own comment for why).
//
// JS has no way to read the cursor's position without at least one pointer
// event since load. 'pointerenter' (below) covers the cursor actually
// crossing into the window right around load, but not the more common case
// this was actually reported for: the cursor already sitting motionless
// somewhere inside the viewport *through* a reload, which fires neither
// 'pointerenter' (it never crossed a boundary — it was already inside) nor
// 'pointermove' (it never moved) until the user eventually nudges it (a
// CSS-:hover-based probe was tried to get around this with zero movement
// required at all — confirmed impossible: browsers reset their
// pointer-tracking state on every navigation, so nothing survives a real
// reload without at least one genuine post-load pointer event, apparently
// deliberately — see git history for the probe and how it was ruled out).
// "Ever registered" — set true the first time this runs at all, regardless
// of which listener — covers the motionless-cursor case: the very first
// real reading kicks off a slow reveal (advanceParallax,
// CUBE_PARALLAX_INIT_REVEAL_MS) toward it instead of either snapping
// straight there (read as an unexplained pop) or easing there at the
// normal fast CUBE_PARALLAX_SMOOTHING rate (the original swoop this was
// built to avoid) — every update after this first one still eases normally.
function updateParallaxTargetFromPointer(event) {
  // editingDefaultView locks hover parallax the same way the others here
  // do — see setEditingDefaultView: while parking the free camera for the
  // baked-in default, ambient tilt drifting the view around while the user
  // is trying to pan/zoom precisely would fight the exact composition
  // they're lining up. photoMode/videoMode lock it too, so the orientation
  // stays at the fixed default isometric angle setPhotoMode/setVideoMode
  // snapped to — see their own comments.
  if (modelFlowDrawMode || modelFlowSelectMode || hoverMovementPaused || spaceHeld || rKeyHeld || zKeyHeld || editingDefaultView || photoMode || videoMode) return;
  const nx = Math.max(-1, Math.min(1, (event.clientX / window.innerWidth) * 2 - 1));
  const ny = Math.max(-1, Math.min(1, (event.clientY / window.innerHeight) * 2 - 1));
  cubeParallaxTargetY = nx * CUBE_PARALLAX_MAX_RAD;
  cubeParallaxTargetX = ny * CUBE_PARALLAX_MAX_RAD;
  if (!cubeParallaxRegistered) {
    cubeParallaxRegistered = true;
    cubeParallaxInitRevealFromX = cubeParallaxX;
    cubeParallaxInitRevealFromY = cubeParallaxY;
    cubeParallaxInitRevealStartTime = performance.now();
  }
}

// Advances cubeParallaxX/Y by one frame — the one-time slow reveal (see
// cubeParallaxRegistered's comment) while it's running, otherwise the
// normal fast per-frame ease toward cubeParallaxTargetX/Y. Shared by both
// call sites in renderCubeFrame (the plain per-frame path, and the one
// nested inside an active rotation tween when it isn't suppressing
// parallax) so the reveal plays out identically regardless of whether the
// load intro's rotation tween happens to still be running at the same time.
function advanceParallax() {
  // editingDefaultView freezes the tilt exactly where it already is,
  // instantly — not just the target (see updateParallaxTargetFromPointer's
  // own gate), so there's no residual settling left to finish converging
  // toward whatever the target already was the moment edit mode started.
  if (editingDefaultView) return;
  if (cubeParallaxInitRevealStartTime !== null) {
    const t = Math.min(1, (performance.now() - cubeParallaxInitRevealStartTime) / CUBE_PARALLAX_INIT_REVEAL_MS);
    const eased = EASE_OUT_CUBIC(t);
    cubeParallaxX = cubeParallaxInitRevealFromX + (cubeParallaxTargetX - cubeParallaxInitRevealFromX) * eased;
    cubeParallaxY = cubeParallaxInitRevealFromY + (cubeParallaxTargetY - cubeParallaxInitRevealFromY) * eased;
    if (t >= 1) cubeParallaxInitRevealStartTime = null;
  } else {
    cubeParallaxX += (cubeParallaxTargetX - cubeParallaxX) * CUBE_PARALLAX_SMOOTHING;
    cubeParallaxY += (cubeParallaxTargetY - cubeParallaxY) * CUBE_PARALLAX_SMOOTHING;
  }
}

// Simulated circling-cursor path driving cubeParallaxX/Y during a video or
// PNG-sequence capture (see videoRecording/captureVideo and
// pngSequenceExporting/capturePngSequence) — traces exactly one full loop
// over the caller-supplied t (0..1), so a clip covering the full range lands
// its last frame back on its first (sin/cos at t=1 loop back to their t=0
// values) rather than leaving a visible pop if it's ever played back
// looping. Reuses the same nx/ny -> parallaxTarget mapping
// updateParallaxTargetFromPointer uses for real cursor input (see
// CUBE_PARALLAX_MAX_RAD), just parameterized by progress through the loop
// instead of pointer position, and written straight into cubeParallaxX/Y
// rather than through advanceParallax's spring smoothing — a lagged
// approximation of the path wouldn't necessarily land exactly back where it
// started. Both captureVideo and capturePngSequence derive t from frame
// index / total frame count (see their own comments on why neither is bound
// to wall-clock time) — they just disagree on whether the last frame reaches
// t=1 exactly, per their own comments on that.
//
// An ellipse, not a circle: VIDEO_TILT_VERTICAL_FACTOR scales pitch (up/down
// tilt) down relative to yaw (left/right tilt, still the full
// CUBE_PARALLAX_MAX_RAD), since a full-amplitude vertical swing read as more
// motion than wanted here — tune this one constant to adjust how flat the
// loop is.
const VIDEO_TILT_VERTICAL_FACTOR = 0.5;

function advanceVideoTilt(t) {
  const angle = t * Math.PI * 2;
  cubeParallaxTargetX = Math.sin(angle) * CUBE_PARALLAX_MAX_RAD * VIDEO_TILT_VERTICAL_FACTOR;
  cubeParallaxTargetY = Math.cos(angle) * CUBE_PARALLAX_MAX_RAD;
  cubeParallaxX = cubeParallaxTargetX;
  cubeParallaxY = cubeParallaxTargetY;
}

// Fires without requiring movement whenever the cursor actually crosses
// into the window around load time, which — unlike the cursor already
// resting inside the viewport through a reload (nothing can detect that
// with zero movement; browsers reset their pointer-tracking state on every
// navigation, specifically so a freshly loaded page can't otherwise infer
// anything about the cursor before the user has interacted with *it* — a
// CSS-:hover-based probe was tried and confirmed unable to get around this,
// verified with Playwright: same technique instantly detects hover via
// page.setContent (no navigation), but never fires at all after a real
// page.goto navigation, even 300ms later, with no post-load pointer event)
// — a browser will often deliver 'pointerenter' within the first frame or
// two, before the intro's own rotation has moved far enough for the snap
// above to be worth avoiding in the first place.
//
// Touch has no persistent hover, so unlike mouse (where this only fires once,
// on first entering the window), every single touch contact re-fires
// 'pointerenter' as a "fresh entry" — including a touch starting over the
// title, which pointerdown above deliberately never arms. Left ungated,
// that call would run unconditionally and drive the tilt regardless, so it
// defers to the same tracked-touch gate as pointermove above.
window.addEventListener('pointerenter', (event) => {
  if (IS_HERO && event.pointerType === 'touch' && event.pointerId !== heroTouchDragPointerId) return;
  updateParallaxTargetFromPointer(event);
});

if (!IS_HERO) {
window.addEventListener('pointerup', () => {
  cubeDragging = false;
  if (panDragging) {
    panDragging = false;
    flushPanSync();
  }
  if (zDragging) {
    zDragging = false;
    flushPanSync();
  }
  if (editPanDragging) {
    editPanDragging = false;
    flushPanSync();
  }
  updateCubeCursor();
});
} // end if (!IS_HERO) — pointerup drag reset

if (IS_HERO) {
const endHeroTouchDrag = (event) => {
  if (event.pointerType !== 'touch') return;
  if (event.pointerId === heroTouchDragPointerId) heroTouchDragPointerId = null;
  canvas.style.touchAction = ''; // fall back to the CSS default (pan-y) rather than hardcoding it here too
};
window.addEventListener('pointerup', endHeroTouchDrag);
window.addEventListener('pointercancel', endHeroTouchDrag);
} // end if (IS_HERO) — clean-canvas touch-drag tracking (release)

// --- Custom model upload (cube mode's "Use custom model" option) -------
//
// Parses a Blender-exported Wavefront .obj (Export > Wavefront (.obj),
// with "Triangulate Faces" on — n-gons still fan-triangulate fine, but
// tris keep the geometry exact) plus its companion .mtl (Blender writes
// one alongside by default, referenced by the .obj's own `mtllib` line).
// Only positions/normals/material-diffuse-color are used: the shader is
// flat per-vertex diffuse lighting with no texture sampling, so vt (UV)
// lines are read past but never stored. If the file has no vn lines
// (normals not exported), a flat face normal is computed per triangle via
// cross product instead — same visual result for a low-poly/flat-shaded
// model, just without needing the OBJ to supply it.
//
// No index buffer: each face's vertices are pushed straight into the output
// arrays in triangle order, duplicating vertices per-face so every face can
// have its own flat normal, so the model draws with drawArrays rather than
// drawElements.

// Corrective rotation applied to the loaded model — its own axes needed a
// quarter-turn around Y to sit the way we want on screen.
const CUSTOM_MODEL_ROTATE_Y_RAD = -Math.PI / 2;

// Reads a .mtl's `newmtl <name>` / `Kd r g b` pairs into a name -> [r,g,b]
// map. Ka/Ks/textures etc. aren't read — the shader only has room for one
// flat diffuse color per face.
function parseMtl(text) {
  const materials = {};
  let current = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('newmtl ')) {
      current = trimmed.slice(7).trim();
      materials[current] = [1, 1, 1];
    } else if (trimmed.startsWith('Kd ') && current) {
      const parts = trimmed.split(/\s+/);
      materials[current] = [parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])];
    }
  }
  return materials;
}

function parseObj(text, materials, baseScaleMultiplier = 1) {
  const positions = [];
  const normals = [];
  const outPositions = [];
  const outNormals = [];
  const outColors = [];
  const outIsGreen = []; // one entry per emitted vertex — blueprint mode's green-fill flag
  const outObjectName = []; // one entry per emitted vertex — the `o`/`g` name active when it was emitted; resolved to an index into `objects` below (see outObjectIndex)
  const outFillPattern = []; // one entry per emitted vertex — 0/1/2/3 fill-pattern id (see materialFillPatternId)
  const outTriVertIdx = []; // one entry per emitted vertex, the original `v` index it came from — used only for crease-edge detection below
  const outTriIsGreen = []; // one entry per emitted triangle — feeds the wireframe's green-edge coloring
  const outTargetPositions = []; // Target-material triangles, kept separately (see isTargetMaterial) purely to feed the "Show target materials" purple overlay — never mixed into outPositions/the opaque draw
  const outTargetTriVertIdx = []; // same convention as outTriVertIdx, but for Target-material triangles — feeds that overlay's own crease-edge wireframe
  const outTargetTriIsGreen = []; // one entry per Target-material triangle; always false (green-fill flag is meaningless for placeholder cubes) but buildCreaseEdgeLines requires the argument
  let activeColor = [1, 1, 1]; // no usemtl seen yet (or an unrecognized name) == plain white
  let activeIsGreen = false;
  let activeFillPattern = 0;
  let activeIsTarget = false; // see isTargetMaterial — true while a "Target"-material face is active

  // Per-object (raw, pre-transform) bounding boxes, tracked purely so camera
  // targets (see cameraTargetSlots below) can later be assigned to a named
  // part of the file — unrelated to geometry/material parsing. objectOrder
  // preserves first-appearance order for the panel's object picker.
  //
  // `o` is the authoritative object boundary; `g` is tracked only as a
  // fallback for files with no `o` lines at all. Exporters (Blender
  // included) commonly emit multiple `g` lines *within* a single object —
  // one per material slot it uses — so once any `o` line has been seen,
  // later `g` lines are ignored rather than treated as new objects; otherwise
  // one real object fragments into several wrongly-centered camera targets,
  // sometimes even colliding on the same name.
  let activeObjectName = null;
  let sawObjectLine = false;
  const objectBounds = new Map();
  const objectOrder = [];
  function touchObjectBounds(x, y, z) {
    const name = activeObjectName || 'Object 1';
    let b = objectBounds.get(name);
    if (!b) {
      b = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
      objectBounds.set(name, b);
      objectOrder.push(name);
    }
    if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
    if (z < b.minZ) b.minZ = z; if (z > b.maxZ) b.maxZ = z;
  }

  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed[0] === 'v' && trimmed[1] === ' ') {
      const parts = trimmed.split(/\s+/);
      positions.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
    } else if (trimmed.startsWith('vn ')) {
      const parts = trimmed.split(/\s+/);
      normals.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
    } else if (trimmed[0] === 'o' && trimmed[1] === ' ') {
      sawObjectLine = true;
      activeObjectName = trimmed.slice(2).trim() || activeObjectName;
    } else if (trimmed[0] === 'g' && trimmed[1] === ' ' && !sawObjectLine) {
      activeObjectName = trimmed.slice(2).trim() || activeObjectName;
    } else if (trimmed.startsWith('usemtl ')) {
      const materialName = trimmed.slice(7).trim();
      activeColor = materials[materialName] || [1, 1, 1];
      activeIsGreen = isGreenDominant(activeColor[0] * 255, activeColor[1] * 255, activeColor[2] * 255);
      activeFillPattern = materialFillPatternId(materialName);
      activeIsTarget = isTargetMaterial(materialName);
    } else if (trimmed[0] === 'f' && trimmed[1] === ' ') {
      const faceVerts = trimmed.split(/\s+/).slice(1).map((part) => {
        const [vStr, , vnStr] = part.split('/'); // v[/vt][/vn]
        const vRaw = parseInt(vStr, 10);
        const vIdx = vRaw > 0 ? vRaw - 1 : positions.length + vRaw;
        let vnIdx = null;
        if (vnStr) {
          const vnRaw = parseInt(vnStr, 10);
          vnIdx = vnRaw > 0 ? vnRaw - 1 : normals.length + vnRaw;
        }
        return { vIdx, vnIdx };
      });
      // Fan triangulation: works for tris as-is, and for any convex n-gon.
      for (let i = 1; i < faceVerts.length - 1; i++) {
        const tri = [faceVerts[0], faceVerts[i], faceVerts[i + 1]];
        const p = tri.map((t) => positions[t.vIdx]);
        let n = tri.map((t) => (t.vnIdx !== null ? normals[t.vnIdx] : null));
        if (n.some((v) => !v)) {
          const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
          const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
          let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
          const len = Math.hypot(nx, ny, nz) || 1;
          nx /= len; ny /= len; nz /= len;
          n = [[nx, ny, nz], [nx, ny, nz], [nx, ny, nz]];
        }
        if (!activeIsTarget) outTriIsGreen.push(activeIsGreen);
        else outTargetTriIsGreen.push(false);
        for (let k = 0; k < 3; k++) {
          // Target-material faces still contribute to their object's
          // bounding box (touchObjectBounds below) so the cube can drive
          // Camera Target / /scroll sizing, but are otherwise skipped here —
          // see isTargetMaterial.
          if (!activeIsTarget) {
            outPositions.push(p[k][0], p[k][1], p[k][2]);
            outNormals.push(n[k][0], n[k][1], n[k][2]);
            outColors.push(activeColor[0], activeColor[1], activeColor[2]);
            outIsGreen.push(activeIsGreen ? 1 : 0);
            outObjectName.push(activeObjectName || 'Object 1');
            outFillPattern.push(activeFillPattern);
            outTriVertIdx.push(tri[k].vIdx);
          } else {
            outTargetPositions.push(p[k][0], p[k][1], p[k][2]);
            outTargetTriVertIdx.push(tri[k].vIdx);
          }
          touchObjectBounds(p[k][0], p[k][1], p[k][2]);
        }
      }
    }
  }

  if (outPositions.length === 0) return null;

  // Fixed corrective rotation (imported model's own axes don't match the
  // orientation we want on screen) — applied to both positions and normals
  // before centering so the post-rotation bounding box (and thus scale) is
  // computed from the final orientation.
  const ry = CUSTOM_MODEL_ROTATE_Y_RAD;
  if (ry !== 0) {
    const cosY = Math.cos(ry), sinY = Math.sin(ry);
    for (let i = 0; i < outPositions.length; i += 3) {
      const x = outPositions[i], z = outPositions[i + 2];
      outPositions[i] = x * cosY + z * sinY;
      outPositions[i + 2] = -x * sinY + z * cosY;
      const nx = outNormals[i], nz = outNormals[i + 2];
      outNormals[i] = nx * cosY + nz * sinY;
      outNormals[i + 2] = -nx * sinY + nz * cosY;
    }
    for (let i = 0; i < outTargetPositions.length; i += 3) {
      const x = outTargetPositions[i], z = outTargetPositions[i + 2];
      outTargetPositions[i] = x * cosY + z * sinY;
      outTargetPositions[i + 2] = -x * sinY + z * cosY;
    }
  }

  // Center (X/Z) and floor (Y) the model, then scale to roughly a [-1, 1]
  // envelope, so the same CUBE_SCALE/camera distance frame it similarly
  // regardless of what units the source model was modeled in. Y specifically
  // aligns to the *lowest* point (minY)
  // rather than the bounding box's vertical midpoint like X/Z — Blender's
  // OBJ exporter already converts its Z-up scenes to this format's Y-up, so
  // a model built with its ground plane at Blender height 0 should still
  // have its ground at object-space Y=0 after import, not floating at
  // -extentY/2 with the scene's vertical *center* at 0. Everything derived
  // from cy below (per-object centroids, the wireframe's dedupedTransformed
  // copy) automatically inherits this floor-relative convention too, and
  // it's what the flow-pulse pivot's floor guide (see
  // CUSTOM_MODEL_ROTATE_Y_RAD) assumes Y=0 means.
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < outPositions.length; i += 3) {
    const x = outPositions[i], y = outPositions[i + 1], z = outPositions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2, cy = minY, cz = (minZ + maxZ) / 2;
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  // 10x the [-1, 1] envelope described above, i.e. the model's intended
  // physical size, independent of CUBE_SCALE (which still applies on top of
  // this). baseScaleMultiplier (default 1, i.e. no-op) lets a specific
  // caller shrink or grow that intended size further — see
  // loadBundledDefaultModel.
  const scale = (2 / extent) * 10 * baseScaleMultiplier;
  for (let i = 0; i < outPositions.length; i += 3) {
    outPositions[i] = (outPositions[i] - cx) * scale;
    outPositions[i + 1] = (outPositions[i + 1] - cy) * scale;
    outPositions[i + 2] = (outPositions[i + 2] - cz) * scale;
  }
  for (let i = 0; i < outTargetPositions.length; i += 3) {
    outTargetPositions[i] = (outTargetPositions[i] - cx) * scale;
    outTargetPositions[i + 1] = (outTargetPositions[i + 1] - cy) * scale;
    outTargetPositions[i + 2] = (outTargetPositions[i + 2] - cz) * scale;
  }

  // Per-object camera-target centroids (see cameraTargetSlots), in the same
  // final coordinate space outPositions ends up in — each object's raw
  // bounding-box center run through the identical rotate/center/scale steps
  // above (affine transforms commute with taking a center point, so this is
  // equivalent to transforming all of that object's vertices and re-deriving
  // its bounding box, just without the extra pass).
  //
  // `size` (bounding-box diagonal length) is computed the same way, but
  // needs no rotation step at all: a Y-axis rotation preserves vector
  // lengths, so the pre-rotation diagonal only needs the uniform `scale`
  // applied to land in the final coordinate space. Used by camera-target
  // zoom (see renderCubeFrame) to frame smaller objects closer and larger
  // ones farther back.
  const objects = objectOrder.map((name) => {
    const b = objectBounds.get(name);
    let ox = (b.minX + b.maxX) / 2, oy = (b.minY + b.maxY) / 2, oz = (b.minZ + b.maxZ) / 2;
    if (ry !== 0) {
      const cosY = Math.cos(ry), sinY = Math.sin(ry);
      const rotX = ox * cosY + oz * sinY;
      const rotZ = -ox * sinY + oz * cosY;
      ox = rotX; oz = rotZ;
    }
    const size = Math.hypot(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ) * scale;
    // Rotation-aware axis-aligned bounding box, in the same final coordinate
    // space as `center` above — feeds the camera-target bounding-box overlay
    // (see showCameraTargetBoxes). Re-derived from all 4 raw X/Z corners
    // (Y is untouched by a Y-axis rotation) rather than just rotating
    // min/max, since rotating an AABB's corners individually and re-taking
    // their min/max is the only way to get a true AABB in the rotated frame.
    let bMinX = Infinity, bMaxX = -Infinity, bMinZ = Infinity, bMaxZ = -Infinity;
    for (const rawX of [b.minX, b.maxX]) {
      for (const rawZ of [b.minZ, b.maxZ]) {
        let rx8 = rawX, rz8 = rawZ;
        if (ry !== 0) {
          const cosY = Math.cos(ry), sinY = Math.sin(ry);
          rx8 = rawX * cosY + rawZ * sinY;
          rz8 = -rawX * sinY + rawZ * cosY;
        }
        if (rx8 < bMinX) bMinX = rx8; if (rx8 > bMaxX) bMaxX = rx8;
        if (rz8 < bMinZ) bMinZ = rz8; if (rz8 > bMaxZ) bMaxZ = rz8;
      }
    }
    const bounds = {
      minX: (bMinX - cx) * scale, maxX: (bMaxX - cx) * scale,
      minY: (b.minY - cy) * scale, maxY: (b.maxY - cy) * scale,
      minZ: (bMinZ - cz) * scale, maxZ: (bMaxZ - cz) * scale,
    };
    return { name, center: [(ox - cx) * scale, (oy - cy) * scale, (oz - cz) * scale], size, bounds };
  });

  // Per-vertex index into `objects` above — lets flow arrows (see
  // recomputeModelFlowCoords/setFlowArrowObjectEnabled) tell which named
  // object a given green vertex belongs to, so one arrow drawn across
  // several objects can have its pulse restricted to just some of them.
  const objectIndexByName = new Map(objectOrder.map((name, i) => [name, i]));
  const outObjectIndex = outObjectName.map((name) => objectIndexByName.get(name));

  // Blueprint-mode wireframe: crease/boundary edges only (see
  // buildCreaseEdgeLines) — a literal every-edge wireframe on a mesh this
  // dense would overflow a 16-bit index buffer and render as solid haze.
  // buildCreaseEdgeLines needs a position array indexed by the same vIdx
  // values outTriVertIdx uses — that's the deduped `positions` list (one
  // entry per `v` line), NOT outPositions (which is duplicated per-triangle
  // and therefore indexed differently) — so rebuild a transformed copy of
  // `positions` here, applying the identical rotate/center/scale steps
  // above (same cx/cy/cz/scale/ry, since triangulating doesn't change the
  // bounding box) rather than transforming outPositions a second time.
  const dedupedTransformed = new Float32Array(positions.length * 3);
  for (let i = 0; i < positions.length; i++) {
    let [x, y, z] = positions[i];
    if (ry !== 0) {
      const cosY = Math.cos(ry), sinY = Math.sin(ry);
      const rx = x * cosY + z * sinY;
      const rz = -x * sinY + z * cosY;
      x = rx; z = rz;
    }
    dedupedTransformed[i * 3] = (x - cx) * scale;
    dedupedTransformed[i * 3 + 1] = (y - cy) * scale;
    dedupedTransformed[i * 3 + 2] = (z - cz) * scale;
  }
  const lineData = buildCreaseEdgeLines(dedupedTransformed, new Uint32Array(outTriVertIdx), outTriIsGreen);
  // Target-material overlay's own wireframe (see showTargetMaterials) — same
  // crease/boundary-edge treatment as the main model's blueprint wireframe
  // above, just against outTargetTriVertIdx instead of outTriVertIdx; only
  // .positions is used (drawn in a fixed purple, not lineData's
  // theme-dependent color), so the isGreen/colors half of the result is
  // thrown away rather than threaded through applyParsedModel.
  const targetLineData = buildCreaseEdgeLines(dedupedTransformed, new Uint32Array(outTargetTriVertIdx), outTargetTriIsGreen);

  return {
    positions: new Float32Array(outPositions),
    normals: new Float32Array(outNormals),
    colors: new Float32Array(outColors),
    isGreen: new Float32Array(outIsGreen),
    objectIndex: new Float32Array(outObjectIndex),
    fillPattern: new Float32Array(outFillPattern),
    targetPositions: new Float32Array(outTargetPositions),
    targetLinePositions: targetLineData.positions,
    linePositions: lineData.positions,
    lineColors: lineData.colors,
    lineIsGreen: lineData.isGreen,
    hasMaterials: Object.keys(materials).length > 0,
    objects,
  };
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

const customModelPositionBuffer = gl.createBuffer();
const customModelNormalBuffer = gl.createBuffer();
const customModelColorBuffer = gl.createBuffer();
const customModelIsGreenBuffer = gl.createBuffer();
const customModelFillPatternBuffer = gl.createBuffer();
// Target-material triangles (see isTargetMaterial/outTargetPositions in
// parseObj) — fed to the "Show target materials" purple overlay
// (showTargetMaterials) via the line program, same as the camera-target
// box fill below, rather than the opaque cubeProgram draw.
const customModelTargetFillBuffer = gl.createBuffer();
let customModelTargetVertexCount = 0;
const customModelTargetLineBuffer = gl.createBuffer();
let customModelTargetLineVertexCount = 0;
const customModelFlowCoordBuffer = gl.createBuffer();
const customModelFlowPathLenBuffer = gl.createBuffer();
const customModelLineBuffer = gl.createBuffer();
const customModelLineColorBuffer = gl.createBuffer();
// Only populated while photo mode's "Uniform wireframe line width" switch
// is on (see photoUniformLineWidth/buildLineRibbonNDC) — the ribbon geometry
// that replaces the plain gl.LINES wireframe draw for as long as that's
// active, live preview included.
const customModelLineRibbonBuffer = gl.createBuffer();
const customModelLineRibbonColorBuffer = gl.createBuffer();
let customModelVertexCount = 0;
let customModelLineVertexCount = 0;
let customModelReady = false;
let cubeModelStatus = ''; // status text shown next to the file picker

const modelStateListeners = [];

// Camera targets: up to 3 named sub-objects from the loaded .obj (see
// `objects` in parseObj's return value) that the "Go to Object N" panel
// buttons ease the framing toward. cameraTargetSlots holds which object name
// (or null for an unassigned/empty slot) is assigned to each of
// CAMERA_TARGET_SLOT_COUNT slots; cameraTargetActiveIndex is which slot is
// currently driving the camera, or null to fall back to the manual pan
// sliders as before. cameraTargetCurrent is the spring-driven position that
// chases whichever slot is active (renderCubeFrame, each frame) — this is
// the "null object" the camera stays rigidly offset from: rotation (drag +
// hover) and distance never change when it moves.
//
// A fixed max (rather than a slot list that just grows/shrinks with however
// many the presenter has assigned) keeps the keyboard shortcuts (1-7, see
// CAMERA_TARGET_DIGIT_KEYS) and the panel's slot rows static — the panel
// always renders all 7, most just showing "— none —" until assigned. Empty
// slots (cameraTargetSlots[i] === null) are skipped wherever targets are
// stepped through in sequence — see IS_SCROLL_ROUTE's own renderCubeFrame
// branch, which is the one place that iterates the slots as a sequence
// rather than jumping to one by its own fixed index.
const CAMERA_TARGET_SLOT_COUNT = 7;
let customModelObjects = []; // [{name, center:[x,y,z], size:number, bounds:{minX,maxX,minY,maxY,minZ,maxZ}}], from parseObj
/** @type {(string | null)[]} */
let cameraTargetSlots = Array(CAMERA_TARGET_SLOT_COUNT).fill(null);
let cameraTargetActiveIndex = null;
let cameraTargetCurrent = [0, 0, 0];
// Pending "phase 2" of loadBundledDefaultModel's intro (see
// MODEL_LOAD_ROTATION_INTRO_MS there) — the timer that, once the opening
// rotation tween lands, eases on into Camera Target 1. Cancelled by
// goToCameraTarget/resetCameraTarget below so a manual 1/2/3 press or a
// "Go to default" (0 key) during those first few seconds isn't overridden
// once this timer fires.
let introCameraTargetTimer = null;

// A 4th, freeform baked-in camera pan+zoom alongside the 3 named Camera
// Targets above — captures modelOffsetXPercent/Y/Z (the manual pan) and
// cubeSizePercent (zoom) only, deliberately never rotation: "going to
// default" always leaves rotation exactly where it already is, same as
// going to a Camera Target (see goToCameraTarget's own comment on that).
// Set via "edit default position" mode (see editingDefaultView below) —
// unlike a Camera Target's auto-framing, there's no target object to frame
// here, so the only way to define this one is to let the user manually park
// the free camera wherever they want and capture that directly. Starts at
// BAKED_DEFAULT_CAMERA_VIEW (below) and, like cameraTargetActiveIndex,
// deliberately session-only from there — re-editing it via "Edit default
// position" updates this in memory for the rest of the session but is never
// persisted, so a reload always lands back on the baked-in value rather than
// whatever was last edited.
let defaultCameraView = null; // { offsetX, offsetY, offsetZ, sizePercent } | null

// Ships with the app so a fresh load lands on a deliberately composed
// default view instead of the plain centered/100% whole-scene one — same
// "hand-set once, then baked into source" idea as DEFAULT_MODEL_FLOW_PATH_DATA
// above, captured via `copy(localStorage.getItem('iconMosaic.defaultCameraView'))`
// in the console after using "Edit default position" back when this was
// still localStorage-persisted. sizePercent is 8x its originally-captured
// value (offsetX/Y/Z are pan percentages of the scale-independent
// MODEL_POSITION_RANGE, so those didn't need adjusting) — compensates for
// loadBundledDefaultModel dropping its own former 8x parseObj multiplier,
// so the on-screen framing this produces is unchanged.
const BAKED_DEFAULT_CAMERA_VIEW = { offsetX: -5.17360464543138, offsetY: 0, offsetZ: 20.631551421416827, sizePercent: 138.76653352869642 };

// Applies a saved view's pan+zoom (never rotation — see the comment above
// defaultCameraView's declaration). Shared by goToDefaultCameraView,
// setEditingDefaultView (jumping to the existing default on entering edit
// mode), and loadBundledDefaultModel.
function applyDefaultCameraViewPanZoom(view) {
  setCubeSizePercent(view.sizePercent);
  modelOffsetXPercent = view.offsetX;
  modelOffsetYPercent = view.offsetY;
  modelOffsetZPercent = view.offsetZ;
  notifyModelState();
}

// Instantly settles the camera-target spring at its rest state (centered,
// 1x zoom, zero velocity) instead of letting it decay there over the next
// several frames as it normally would (see renderCubeFrame's stepSpring
// calls). cameraTargetZoomCurrent is multiplied into the final scale
// unconditionally (see `s` in renderCubeFrame), not just while a target is
// active, so without this a target's leftover fit-zoom would still be
// fading back toward 1x for a beat after the default view's own zoom is
// set, producing a brief double-zoom instead of a clean cut straight to
// it. Also needed for pan now that the default view sets that too (see
// applyDefaultCameraViewPanZoom) — getObjectSpacePan suppresses manual pan
// entirely until the spring reports at-rest, so without this the new pan
// wouldn't actually show up on screen until the leftover spring finished
// decaying on its own, same class of bug goToCameraTarget's own seeding
// fixes for the reverse direction.
function settleCameraTargetSpring() {
  cameraTargetCurrent = [0, 0, 0];
  cameraTargetZoomCurrent = 1;
  cameraTargetVelocity = [0, 0, 0];
  cameraTargetZoomVelocity = 0;
  cameraTargetSpringLastTime = null;
  cameraTargetAtRest = true;
}

// Drops any active camera target (which would otherwise keep overriding
// centering/zoom every frame) and jumps to the saved default pan/zoom — a
// no-op if none has ever been saved. Bound to the "Go" button and the 0 key
// (see the Digit0 keydown handler above) — disabled/ignored while
// editingDefaultView is active (see setEditingDefaultView) since jumping
// mid-edit would just discard whatever pan/zoom is being worked out back to
// the last saved value.
function goToDefaultCameraView() {
  if (!defaultCameraView || editingDefaultView) return;
  if (cameraTargetActiveIndex !== null) resetCameraTarget();
  settleCameraTargetSpring();
  applyDefaultCameraViewPanZoom(defaultCameraView);
}

function setEditingDefaultView(enabled) {
  enabled = !!enabled;
  if (enabled === editingDefaultView) return;
  editingDefaultView = enabled;
  if (!cubeDragging && !editPanDragging) updateCubeCursor();
  if (enabled) {
    // Start from the existing default (if any) rather than wherever the
    // camera happens to already be, so this refines it in place instead of
    // setting a brand new value from an arbitrary starting point.
    if (cameraTargetActiveIndex !== null) resetCameraTarget();
    settleCameraTargetSpring();
    if (defaultCameraView) applyDefaultCameraViewPanZoom(defaultCameraView);
  } else {
    defaultCameraView = {
      offsetX: modelOffsetXPercent,
      offsetY: modelOffsetYPercent,
      offsetZ: modelOffsetZPercent,
      sizePercent: cubeSizePercent,
    };
  }
  notifyModelState();
}

// Master visibility switch for the light-blue bounding-box overlay drawn
// around every object currently assigned to a camera-target slot (see
// CAMERA_TARGET_BOX_* below and its draw call in renderCubeFrame) —
// independent of blueprint mode and of which slot (if any) is actively
// driving the camera, so it's useful purely for checking which objects are
// wired up as targets.
let showCameraTargetBoxes = false;
// Master visibility switch for the purple, 50%-opacity overlay that reveals
// Target-material faces (see isTargetMaterial) — those are otherwise
// excluded from the opaque draw entirely (parseObj), so this is the only
// way to see where a "Target" cube actually sits/how it's sized without
// re-opening the source file in Blender.
let showTargetMaterials = false;
// Mirrors the React panel's own "controls hidden" state (H key / hamburger
// button, see src/panel.tsx's `hidden` state) — main.js has no DOM
// dependency on the panel and can't read that state directly, so panel.tsx
// pushes it in via setPanelsHidden whenever it changes. Used purely to gate
// the pivot orb + floor guide draw call in renderCubeFrame: those are a
// dev/presenter aid for seeing the current rotation/zoom pivot, and reading
// as clutter over an otherwise-clean shot once the panels (and therefore
// the presenter chrome generally) are intentionally hidden.
// Hero starts (and stays) with this true — there's no panel to hide/show it,
// and the pivot orb/floor guide it gates are presenter-facing dev aids that
// should never appear on the production hero build.
let panelsHidden = IS_HERO;
function setPanelsHidden(hidden) {
  panelsHidden = !!hidden;
}
// Extra scale multiplier applied on top of cubeSizeScale while a camera
// target is active (see renderCubeFrame) — springs to 1x whenever no target
// is active, and to an exact "frame to fit" goal otherwise (see
// CAMERA_TARGET_VERTICAL_SAFE_ZONE), on the same spring as
// cameraTargetCurrent so zoom and pan move together.
let cameraTargetZoomCurrent = 1;
// Damped-spring simulation driving cameraTargetCurrent/cameraTargetZoomCurrent
// toward whatever the active target's goal position/zoom is this frame (see
// renderCubeFrame) — a real position+velocity integration (semi-implicit
// Euler) rather than a fixed-duration tween, so the goal can keep moving
// (switching targets mid-flight, a resize changing the frame-to-fit zoom)
// without a visible restart: the spring just keeps pulling from wherever it
// currently is, carrying its existing velocity. cameraTargetVelocity/
// cameraTargetZoomVelocity are the per-axis object-space velocities;
// cameraTargetSpringLastTime is the performance.now() of the previous
// step, used to compute dt (null right after a reset, so the first step
// after that doesn't take a giant dt).
let cameraTargetVelocity = [0, 0, 0];
let cameraTargetZoomVelocity = 0;
let cameraTargetSpringLastTime = null;
// Whether the spring is currently close enough to rest (position, zoom, AND
// velocity all near their at-rest goal) that it's safe to hand screen
// centering back to the manual pan sliders — see getObjectSpacePan, which
// needs a real "settled" signal instead of a tween-end event now that the
// spring has no fixed end time.
let cameraTargetAtRest = true;
// Stiffness (pull toward the goal) and damping (velocity drag) of the
// spring, in the standard critically-damped-at
// `damping = 2 * sqrt(stiffness)` parameterization — 2*sqrt(15) ≈ 7.75, so
// damping: 9 sits slightly past critical (ratio ~1.16): a slow, deliberate
// arrival with no overshoot/bounce, rather than the snappier springy feel
// of an underdamped ratio (< 1). Lower stiffness for an even slower move
// (keep damping ≈ 1.16 * 2 * sqrt(stiffness) to hold the same ratio and
// stay overshoot-free); raise damping alone for a more sluggish, "through
// honey" settle at the same speed.
const CAMERA_TARGET_SPRING_STIFFNESS = 15;
const CAMERA_TARGET_SPRING_DAMPING = 9;
// Zoom's own, softer spring (same ~1.16 damping ratio as position's, just
// lower stiffness) — position and zoom used to share the position spring
// above outright, but the targets in this scene sit far apart in
// object-space while zoom's goal is usually a much smaller relative change,
// so with identical time-constants zoom visibly finished while position
// still had real distance left to cover. Slowing zoom down instead of
// speeding position up keeps position's existing pacing untouched.
const CAMERA_TARGET_ZOOM_SPRING_STIFFNESS = 4;
const CAMERA_TARGET_ZOOM_SPRING_DAMPING = 4.65; // 1.1619 * 2*sqrt(4), same ratio as CAMERA_TARGET_SPRING_DAMPING/STIFFNESS
// Clamps the per-step dt fed into the spring integration (seconds) — caps
// how far a single step can move after e.g. a backgrounded-tab stall, so
// the simulation can't blow up from an enormous one-off dt.
const CAMERA_TARGET_SPRING_MAX_DT = 0.05;
// Below these position/velocity/zoom thresholds the spring is considered
// settled (see cameraTargetAtRest) — object-space units are on the same
// ~20-unit whole-model scale as parseObj's normalization, so 0.01 is
// visually imperceptible.
const CAMERA_TARGET_SPRING_REST_EPSILON = 0.01;
// Fraction of the viewport height left empty above AND below a framed
// camera target (so the object itself occupies the middle 1 - 2 * this
// fraction of the screen) — see renderCubeFrame's zoomGoal calculation,
// which projects the target's own rotated bounding box through the
// current rx/ry and solves for the scale that hits this fill exactly.
// Recomputed every frame, so the object stays framed to this fraction
// continuously as it's rotated, unlike a fixed reference-size heuristic.
const CAMERA_TARGET_VERTICAL_SAFE_ZONE = 0.25;
const CAMERA_TARGET_ZOOM_MIN = 0.01;
const CAMERA_TARGET_ZOOM_MAX = 50;

// Hero-only: below this viewport width, hero.css switches the title/cards
// overlay to its wrapped mobile layout (see the @media query in hero.css —
// keep both in sync), which covers noticeably more of the screen's bottom
// half than the desktop bottom-left-corner layout does. heroVerticalBias
// nudges camera-target framing upward (see getCurrentCameraOffset) so the
// model's important detail clears the overlay instead of sitting behind
// it. Desktop hero and the tool build (IS_HERO false, so this always stays
// 0) are both unaffected — this never touches the manual pan sliders or
// the baked default view, only the camera-target system's own centering.
const HERO_MOBILE_BREAKPOINT_PX = 720;
// Fraction of the vertical ortho frustum's half-height (cubeProjectionHalfY)
// to shift framing upward by on mobile. A starting point, not a measured
// value — tune directly against the actual overlay height on a real narrow
// viewport, which isn't something that could be checked from here.
const HERO_MOBILE_VERTICAL_BIAS_FRACTION = 0.28;
let heroVerticalBias = 0;

function updateHeroVerticalBias() {
  if (!IS_HERO) return;
  heroVerticalBias = window.innerWidth <= HERO_MOBILE_BREAKPOINT_PX
    ? cubeProjectionHalfY * HERO_MOBILE_VERTICAL_BIAS_FRACTION
    : 0;
}

// /scroll-only, same idea as heroVerticalBias above but for the bottom step
// card (src/panel.tsx) — below sm (640px, kept in sync with that card's own
// Tailwind breakpoint) the card runs full-width along the bottom edge, so
// framing nudges upward there to clear it. Expressed in actual screen
// pixels (unlike heroVerticalBias's frustum-fraction) since that's the unit
// the request behind this was made in; converted to cubeProjectionHalfY's
// view-space units via the same "cubeProjectionHalfY * 2 view-units spans
// window.innerHeight px" relationship the ortho projection itself is built
// on (see updateCubeProjection).
const SCROLL_MOBILE_BREAKPOINT_PX = 640;
const SCROLL_MOBILE_VERTICAL_BIAS_PX = 120;
let scrollMobileVerticalBias = 0;

function updateScrollMobileVerticalBias() {
  if (!IS_SCROLL_ROUTE) return;
  scrollMobileVerticalBias = window.innerWidth <= SCROLL_MOBILE_BREAKPOINT_PX
    ? cubeProjectionHalfY * (2 * SCROLL_MOBILE_VERTICAL_BIAS_PX) / window.innerHeight
    : 0;
}

function getModelState() {
  return {
    spaceHeld,
    photoMode,
    photoExport2x,
    photoUniformLineWidth,
    videoMode,
    videoRecording,
    videoExportDurationMs: VIDEO_EXPORT_DURATION_MS,
    pngSequenceExporting,
    pngSequenceProgress,
    rotationDisabled,
    // Included so schedulePanSync/flushPanSync's notifyModelState() (fired
    // continuously while Space-dragging) keeps the "Model X/Y position"
    // sliders live-in-sync with the drag, not just on the next full reload
    // (getInitialState reads these too, but that's only read once on mount).
    modelOffsetX: modelOffsetXPercent,
    modelOffsetY: modelOffsetYPercent,
    customModelReady,
    cubeSize: cubeSizePercent,
    cubeModelStatus,
    batteryStackAvailable: !!batteryStack,
    batteryStackEnabled,
    batteryStackCount,
    batteryStackAnimation,
    batteryModelLoading,
    customModelObjectNames: batteryStack?.activeNames ?? customModelObjects.map((o) => o.name),
    cameraTargetSlots,
    cameraTargetActiveIndex,
    showCameraTargetBoxes,
    showTargetMaterials,
    hasDefaultCameraView: !!defaultCameraView,
    editingDefaultView,
    modelFlowArrowCount: modelFlowPaths.length,
    selectedFlowArrowIndex,
    modelFlowDrawMode,
    modelFlowSelectMode,
    // Included (not just in getInitialState) so entering draw mode — which
    // force-enables this (see setModelFlowDraw) — keeps the panel's "Show
    // flow arrows" switch in sync even when toggled via the A-key shortcut
    // rather than the panel's own button.
    showModelFlowArrow,
    // Per-object pulse toggles for whichever arrow is selected — one entry
    // per object that arrow's drag actually touched, [] if nothing's
    // selected or the selected arrow only ever touched one object (nothing
    // to choose between).
    selectedFlowArrowObjects: (() => {
      const path = selectedFlowArrowIndex !== null ? modelFlowPaths[selectedFlowArrowIndex] : null;
      if (!path || path.touchedObjectIndices.length <= 1) return [];
      return path.touchedObjectIndices.map((idx) => ({
        index: idx,
        name: customModelObjects[idx]?.name ?? `Object ${idx + 1}`,
        enabled: path.enabledObjectIndices.includes(idx),
      }));
    })(),
    // Drives the "Reverse flow" button's active/inactive look (see
    // reverseSelectedFlowArrow) — false whenever nothing's selected.
    selectedFlowArrowReversed: !!(selectedFlowArrowIndex !== null && modelFlowPaths[selectedFlowArrowIndex]?.reversed),
  };
}

function setCameraTargetSlot(slotIndex, objectName) {
  cameraTargetSlots = cameraTargetSlots.map((v, i) => (i === slotIndex ? objectName || null : v));
  if (cameraTargetActiveIndex === slotIndex && !objectName) {
    cameraTargetActiveIndex = null;
  }
  updateScrollTrackHeight(); // no-op off the /scroll route; assigning/clearing a slot changes how many targets there are to scroll through
  notifyModelState();
}

// The object-space point manual pan is currently centering on screen (same
// formula as pivotObj in renderCubeFrame) — used to seed a camera-target
// transition's starting position when coming from manual-pan mode, so the
// switch (which suppresses manual pan outright, see getObjectSpacePan)
// doesn't read as an instant jump before the transition's own motion takes
// over. Shared by goToCameraTarget and startIntroCameraTargetTween.
function seedCameraTargetPosFromManualPan() {
  const [panX, panY, panZ] = getObjectSpacePan();
  // Must match the actual render scale `s` (see pivotObj/getCurrentCameraOffset
  // in renderCubeFrame) exactly, not just cubeSizeScale — CUBE_SCALE is a
  // ~0.033 base multiplier baked into every object-space distance, so
  // omitting it here understated the seed by ~30x, which rendered as a
  // wrong-magnitude jump on the very first camera-target frame before the
  // spring corrected course. cameraTargetZoomCurrent is 1 at this point
  // (we're coming from rest in manual-pan mode), included anyway to stay
  // exactly in sync with `s` if that ever weren't the case.
  const s = CUBE_SCALE * cubeSizeScale * cameraTargetZoomCurrent;
  return s > 0 ? [-panX / s, -panY / s, -panZ / s] : [0, 0, 0];
}

// The centering position + "frame to fit" zoom a given Camera Target slot
// eases toward — extracted from renderCubeFrame's per-frame spring-goal
// calculation (see the cameraTargetActiveIndex branch there) so
// startIntroCameraTargetTween can also read it once, up front, as a fixed
// tween endpoint instead of a goal the spring re-reads every frame.
function computeCameraTargetGoal(slotIndex) {
  const targetName = cameraTargetSlots[slotIndex];
  const target = targetName ? customModelObjects.find((o) => o.name === targetName) : null;
  return computeCameraTargetGoalForObject(target);
}

// Optional "Target_Start" marker object (case-insensitive; not a numbered
// Target_N, so it never claims a Camera Target slot via TARGET_NAME_RE
// above) — when a model names one, the /scroll route (IS_SCROLL_ROUTE)
// treats it as the animation's starting framing instead of opening already
// on Target 1 (see loadBundledDefaultModel's initial snap and
// renderCubeFrame's intro-span blend below).
const TARGET_START_NAME_RE = /^target_start$/i;
function findTargetStartObject() {
  return customModelObjects.find((o) => TARGET_START_NAME_RE.test(o.name)) ?? null;
}

// Shared by computeCameraTargetGoal (numbered slots) and the Target_Start
// lookup above — both just need "frame to fit" math for an arbitrary named
// object, not specifically one sitting in a Camera Target slot.
function computeCameraTargetGoalForObject(target) {
  const center = target ? target.center : [0, 0, 0];
  let zoomGoal = 1;
  if (target && target.bounds) {
    // "Frame to fit" zoom, using the target's bounding box projected
    // through the fixed isometric resting rotation (CUBE_ISO_PITCH/
    // CUBE_ISO_YAW) rather than the scene's *current* rx/ry — this is the
    // "initial state" rotation every target starts from, so the fit
    // reflects the object's actual (rotated, isometric) silhouette instead
    // of a flat/unrotated one, while still being a fixed per-object value
    // that doesn't chase hover/drag rotation while a target is active.
    // Still reactive to the "Model size" slider and window resize
    // (cubeSizeScale/cubeProjectionHalfY), just not to rotation. Being
    // orthographic, on-screen size depends only on this projected extent
    // and the uniform scale below, never on distance from the camera, so
    // solving for the exact CAMERA_TARGET_VERTICAL_SAFE_ZONE fill fraction
    // is exact.
    const { minX, maxX, minY, maxY, minZ, maxZ } = target.bounds;
    const [ccx, ccy, ccz] = target.center;
    let minProjY = Infinity, maxProjY = -Infinity;
    for (const x of [minX, maxX]) {
      for (const y of [minY, maxY]) {
        for (const z of [minZ, maxZ]) {
          const afterY = rotateYVec3([x - ccx, y - ccy, z - ccz], CUBE_ISO_YAW);
          const afterX = rotateXVec3(afterY, CUBE_ISO_PITCH);
          if (afterX[1] < minProjY) minProjY = afterX[1];
          if (afterX[1] > maxProjY) maxProjY = afterX[1];
        }
      }
    }
    const projectedHeight = maxProjY - minProjY;
    if (projectedHeight > 1e-6) {
      const fillFraction = 1 - 2 * CAMERA_TARGET_VERTICAL_SAFE_ZONE;
      // Normally divides by the *live* cubeSizeScale so the "Model size"
      // slider can't change the on-screen framing (it cancels out against
      // the same term in `s` in renderCubeFrame). While draw mode is
      // active, divides by the frozen drawModeZoomBaselinePercent instead
      // (see setModelFlowDraw) so that cancellation doesn't also eat
      // scroll-to-zoom, which drives cubeSizeScale through the exact same
      // path.
      const zoomGoalSizeScale = drawModeZoomBaselinePercent !== null
        ? drawModeZoomBaselinePercent / 100
        : cubeSizeScale;
      zoomGoal = Math.max(
        CAMERA_TARGET_ZOOM_MIN,
        Math.min(
          CAMERA_TARGET_ZOOM_MAX,
          (fillFraction * 2 * cubeProjectionHalfY) / (projectedHeight * CUBE_SCALE * zoomGoalSizeScale)
        )
      );
    }
  }
  return { center, zoomGoal };
}

function goToCameraTarget(slotIndex) {
  if (!cameraTargetSlots[slotIndex]) return;
  if (introCameraTargetTimer !== null) {
    clearTimeout(introCameraTargetTimer);
    introCameraTargetTimer = null;
  }
  introCamTargetTweenActive = false;
  // Coming from manual-pan mode (no target active — e.g. the default view):
  // seed the spring at the object-space point the manual pan is currently
  // centering on screen, rather than leaving it wherever it was last
  // settled to rest (usually [0,0,0]). Otherwise the manual pan —
  // suppressed the instant a target activates, see getObjectSpacePan —
  // vanishes in a single frame while the spring separately eases from the
  // wrong starting point, which reads as an instant jump with no
  // transition at all. Switching directly between two already-active
  // targets (or away from a still-tweening intro, see
  // introCamTargetTweenActive above) skips this: cameraTargetCurrent
  // already holds the live in-flight position, which is the correct start
  // as-is.
  if (cameraTargetActiveIndex === null) {
    cameraTargetCurrent = seedCameraTargetPosFromManualPan();
    cameraTargetVelocity = [0, 0, 0];
    cameraTargetSpringLastTime = null;
  }
  cameraTargetActiveIndex = slotIndex;
  notifyModelState();
}

// Intro-only alternative to goToCameraTarget: instead of the spring every
// manual 1/2/3 press or panel button uses (see goToCameraTarget/
// renderCubeFrame's stepSpring calls), eases position and zoom to Camera
// Target 1 on their own fixed durations/easing curves — the intro's phase 2
// wants a specific, tunable timing/feel rather than the spring's live,
// physically-simulated one. Position and zoom can have independent
// duration/easing (zoomDurationMs/zoomEasing default to the position ones
// if omitted), same split as tweenCubeRotationTo's rotation/zoom.
let introCamTargetTweenActive = false;
let introCamTargetTweenStartTime = null;
let introCamTargetTweenFromPos = [0, 0, 0];
let introCamTargetTweenToPos = [0, 0, 0];
let introCamTargetTweenFromZoom = 1;
let introCamTargetTweenToZoom = 1;
let introCamTargetPosDurationMs = CUBE_ROT_RESET_MS;
let introCamTargetPosEasing = EASE_OUT_CUBIC;
let introCamTargetZoomDurationMs = CUBE_ROT_RESET_MS;
let introCamTargetZoomEasing = EASE_OUT_CUBIC;
// Delay, in ms, before zoom starts moving from its snapshot — position is
// unaffected and always starts immediately at t=0, same delay/no-delay
// split as tweenCubeRotationTo's cubeRotResetDelayMs (rotation there plays
// the delayed role; here it's zoom).
let introCamTargetZoomDelayMs = 0;

function startIntroCameraTargetTween(slotIndex, posDurationMs, posEasing, zoomDurationMs = posDurationMs, zoomEasing = posEasing, zoomDelayMs = 0) {
  if (!cameraTargetSlots[slotIndex]) return;
  // cameraTargetActiveIndex is guaranteed null here (nothing else can have
  // activated a target before this fires — see the cancellation in
  // goToCameraTarget/resetCameraTarget), so this always seeds from manual
  // pan, same as goToCameraTarget's own first-activation branch.
  introCamTargetTweenFromPos = seedCameraTargetPosFromManualPan();
  introCamTargetTweenFromZoom = cameraTargetZoomCurrent;
  const goal = computeCameraTargetGoal(slotIndex);
  introCamTargetTweenToPos = goal.center;
  introCamTargetTweenToZoom = goal.zoomGoal;
  cameraTargetCurrent = [...introCamTargetTweenFromPos];
  cameraTargetVelocity = [0, 0, 0];
  cameraTargetSpringLastTime = null;
  cameraTargetActiveIndex = slotIndex;
  introCamTargetPosDurationMs = posDurationMs;
  introCamTargetPosEasing = posEasing;
  introCamTargetZoomDurationMs = zoomDurationMs;
  introCamTargetZoomEasing = zoomEasing;
  introCamTargetZoomDelayMs = zoomDelayMs;
  introCamTargetTweenStartTime = performance.now();
  introCamTargetTweenActive = true;
  notifyModelState();
}

// Drops back to the manual pan sliders (getModelViewOffset) instead of a
// camera target driving the offset — see getCurrentCameraOffset.
function resetCameraTarget() {
  if (introCameraTargetTimer !== null) {
    clearTimeout(introCameraTargetTimer);
    introCameraTargetTimer = null;
  }
  introCamTargetTweenActive = false;
  cameraTargetActiveIndex = null;
  notifyModelState();
}

function setShowCameraTargetBoxes(enabled) {
  showCameraTargetBoxes = !!enabled;
  notifyModelState();
}

function setShowTargetMaterials(enabled) {
  showTargetMaterials = !!enabled;
  notifyModelState();
}

function notifyModelState() {
  const state = getModelState();
  modelStateListeners.forEach((listener) => listener(state));
}

// JS-side copies kept around (not just uploaded to the GPU) so the flow
// arrow-drawing tool can raycast against the green triangles and recompute
// each vertex's arc-length-along-the-drawn-path coordinate whenever the
// arrow changes — see raycastGreenMesh/recomputeModelFlowCoords below.
let customModelPositionsCache = null;
let customModelIsGreenCache = null;
let customModelObjectIndexCache = null; // one entry per vertex — see parseObj's outObjectIndex
let customModelLinePositionsCache = null;
let customModelLineIsGreenCache = null; // one entry per line-position pair — see buildLineColors
let greenTriPositionsCache = null; // Float32Array, only the triangles flagged green, for cheap raycasting
let greenTriObjectIndexCache = null; // one entry per green triangle, parallel to greenTriPositionsCache — which object each hit belongs to

let batteryStack = null;
let batteryStackEnabled = false;
let batteryStackCount = 9;
let batteryStackAnimation = true;
let batteryModelLoading = false;

function configureBatteryStack(count = batteryStackCount, enabled = batteryStackEnabled, animation = batteryStackAnimation, replay = false) {
  if (!batteryStack) return;
  if (!Number.isInteger(count) || count < 3 || count > 9) return;
  batteryStackCount = count;
  batteryStackEnabled = !!enabled;
  batteryStackAnimation = !!animation;
  const shouldAnimate = batteryStackAnimation && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  batteryStack.configure(count, batteryStackEnabled, shouldAnimate, performance.now(), replay);
  clearModelFlowPath();
  updateBatteryStackGeometry();
  notifyModelState();
}

function updateBatteryStackGeometry() {
  const geometry = batteryStack?.update(performance.now());
  if (!geometry) return;
  const upload = (buffer, values) => {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, values, gl.DYNAMIC_DRAW);
  };
  upload(customModelPositionBuffer, geometry.positions);
  upload(customModelLineBuffer, geometry.linePositions);
  if (geometry.membershipChanged) {
    upload(customModelNormalBuffer, geometry.normals);
    upload(customModelColorBuffer, geometry.colors);
    upload(customModelIsGreenBuffer, geometry.isGreen);
    upload(customModelFillPatternBuffer, geometry.fillPattern);
    customModelLineIsGreenCache = geometry.lineIsGreen;
    refreshBlueprintLineColors();
  }
  customModelVertexCount = geometry.positions.length / 3;
  customModelLineVertexCount = geometry.linePositions.length / 3;
  customModelPositionsCache = geometry.positions;
  customModelObjectIndexCache = geometry.objectIndex;
  customModelIsGreenCache = geometry.isGreen;
  customModelLinePositionsCache = geometry.linePositions;
  customModelObjects = geometry.objects;
  const triangles = [], owners = [];
  for (let i = 0; i < geometry.isGreen.length; i += 3) {
    if (!geometry.isGreen[i]) continue;
    triangles.push(...geometry.positions.subarray(i * 3, i * 3 + 9));
    owners.push(geometry.objectIndex[i]);
  }
  greenTriPositionsCache = new Float32Array(triangles);
  greenTriObjectIndexCache = owners;
  if (geometry.membershipChanged) recomputeModelFlowCoords();
}

async function loadBundledBatteryModel() {
  if (batteryModelLoading) return;
  batteryModelLoading = true;
  notifyModelState();
  try {
    const [objText, mtlText] = await Promise.all(['obj', 'mtl'].map(async extension => {
      const response = await fetch(`/models/NGEN_assets.${extension}`);
      if (!response.ok) throw new Error(`Battery ${extension} file is unavailable.`);
      return response.text();
    }));
    applyParsedModel(parseObj(objText, parseMtl(mtlText)), 'NGEN_assets.obj', 'NGEN_assets.mtl');
    clearModelFlowPath();
    if (IS_BATTERY_ROUTE) configureBatteryStack(batteryStackCount, true);
  } catch (error) {
    console.error(error);
    cubeModelStatus = "Couldn't load NGEN_assets.obj";
  } finally {
    batteryModelLoading = false;
    notifyModelState();
  }
}

// Uploads an already-parsed model (see parseObj) to the custom-model GPU
// buffers and flips customModelReady on so renderCubeFrame starts drawing
// it. Shared by the file picker and drag-and-drop paths (see
// loadModelFromFiles below).
function applyParsedModel(parsed, objName, mtlName, defaultCameraTargets = []) {
  if (!parsed) {
    customModelReady = false;
    cubeModelStatus = `Couldn't find any faces in ${objName}`;
    notifyModelState();
    return;
  }
  batteryStack = createBatteryStack(parsed);
  batteryStackEnabled = false;
  batteryStackCount = 9;
  gl.bindBuffer(gl.ARRAY_BUFFER, customModelPositionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, parsed.positions, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, customModelNormalBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, parsed.normals, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, customModelColorBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, parsed.colors, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, customModelIsGreenBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, parsed.isGreen, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, customModelFillPatternBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, parsed.fillPattern, gl.STATIC_DRAW);
  customModelVertexCount = parsed.positions.length / 3;

  gl.bindBuffer(gl.ARRAY_BUFFER, customModelTargetFillBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, parsed.targetPositions, gl.STATIC_DRAW);
  customModelTargetVertexCount = parsed.targetPositions.length / 3;
  gl.bindBuffer(gl.ARRAY_BUFFER, customModelTargetLineBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, parsed.targetLinePositions, gl.STATIC_DRAW);
  customModelTargetLineVertexCount = parsed.targetLinePositions.length / 3;

  gl.bindBuffer(gl.ARRAY_BUFFER, customModelLineBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, parsed.linePositions, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, customModelLineColorBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, parsed.lineColors, gl.STATIC_DRAW);
  customModelLineVertexCount = parsed.linePositions.length / 3;

  customModelPositionsCache = parsed.positions;
  customModelIsGreenCache = parsed.isGreen;
  customModelObjectIndexCache = parsed.objectIndex;
  customModelLinePositionsCache = parsed.linePositions;
  customModelLineIsGreenCache = parsed.lineIsGreen;

  // A newly loaded model's object names/centroids have nothing to do with
  // whatever the previous model's camera-target assignments pointed at —
  // defaultCameraTargets (only ever passed by loadBundledDefaultModel, since
  // it's the only caller that knows its model's object names up front) seeds
  // fresh slots instead of leaving them empty. Always padded/truncated to
  // exactly CAMERA_TARGET_SLOT_COUNT regardless of how many names a caller
  // actually passed (loadBundledDefaultModel currently seeds only 3 of the
  // 7) — the rest just stay null (empty) until assigned by hand.
  customModelObjects = parsed.objects;
  cameraTargetSlots = Array.from(
    { length: CAMERA_TARGET_SLOT_COUNT },
    (_, i) => defaultCameraTargets[i] ?? null,
  );
  // Auto-assign objects named "Target_N" (case-insensitive) straight to
  // Camera Target slot N-1, so a Blender export using that naming
  // convention needs no manual dropdown assignment. Overrides
  // defaultCameraTargets for the same slot — the model's own naming is a
  // more explicit signal than a generic bundled-model seed.
  const TARGET_NAME_RE = /^target_(\d+)$/i;
  for (const obj of parsed.objects) {
    const match = TARGET_NAME_RE.exec(obj.name);
    if (!match) continue;
    const slotIndex = Number(match[1]) - 1;
    if (slotIndex >= 0 && slotIndex < CAMERA_TARGET_SLOT_COUNT) {
      cameraTargetSlots[slotIndex] = obj.name;
    }
  }
  updateScrollTrackHeight(); // no-op off the /scroll route; a freshly loaded model may seed a different number of assigned slots than the last one
  cameraTargetActiveIndex = null;
  cameraTargetCurrent = [0, 0, 0];
  cameraTargetZoomCurrent = 1;
  // Zero out the spring so renderCubeFrame doesn't carry the old model's
  // velocity into a move toward the new model's origin next frame.
  cameraTargetVelocity = [0, 0, 0];
  cameraTargetZoomVelocity = 0;
  cameraTargetSpringLastTime = null;
  cameraTargetAtRest = true;

  const greenTris = [];
  const greenTriObjectIndex = [];
  for (let i = 0; i < parsed.isGreen.length; i += 3) {
    if (parsed.isGreen[i]) {
      const o = i * 3;
      for (let k = 0; k < 9; k++) greenTris.push(parsed.positions[o + k]);
      greenTriObjectIndex.push(parsed.objectIndex[i]);
    }
  }
  greenTriPositionsCache = new Float32Array(greenTris);
  greenTriObjectIndexCache = greenTriObjectIndex;

  // Any existing arrow's coordinates belonged to the *previous* model and no
  // longer mean anything — callers decide whether to drop it (a genuinely
  // different upload) or try to restore a persisted one (the routine
  // bundled-model auto-load); see the two applyParsedModel call sites below,
  // which call clearModelFlowPath() or restoreModelFlowPath() accordingly.

  customModelReady = true;
  setCubeSizePercent(100); // a freshly loaded model starts at the default size, not whatever the slider was left at
  const triCount = customModelVertexCount / 3;
  cubeModelStatus = parsed.hasMaterials
    ? `${objName} (${triCount} tris, colors from ${mtlName})`
    : `${objName} (${triCount} tris, no materials found)`;
  if (batteryStack) {
    // Frame this newly added asset without changing the default scene or camera.
    resetCameraTarget();
    settleCameraTargetSpring();
    const bounds = {
      minX: Math.min(...parsed.objects.map(object => object.bounds.minX)),
      maxX: Math.max(...parsed.objects.map(object => object.bounds.maxX)),
      minY: Math.min(...parsed.objects.map(object => object.bounds.minY)),
      maxY: Math.max(...parsed.objects.map(object => object.bounds.maxY)),
      minZ: Math.min(...parsed.objects.map(object => object.bounds.minZ)),
      maxZ: Math.max(...parsed.objects.map(object => object.bounds.maxZ)),
    };
    const center = [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, (bounds.minZ + bounds.maxZ) / 2];
    const { zoomGoal } = computeCameraTargetGoalForObject({ center, bounds });
    setCubeSizePercent(zoomGoal * 100);
    const scale = CUBE_SCALE * cubeSizeScale;
    modelOffsetXPercent = -center[0] * scale / MODEL_POSITION_RANGE * 100;
    modelOffsetYPercent = -center[1] * scale / MODEL_POSITION_RANGE * 100;
    modelOffsetZPercent = -center[2] * scale / MODEL_POSITION_RANGE * 100;
    resetCubeRotation();
  }
  notifyModelState();
}

// Shared by the file-picker input and drag-and-drop below: given a loose
// list of Files (as either produces), finds the .obj and its .mtl sidecar,
// parses, and uploads, replacing whatever model (bundled default or a
// previous upload) was showing. Only ever runs in response to the user
// explicitly picking or dropping files.
async function loadModelFromFiles(files) {
  const objFile = files.find((f) => /\.obj$/i.test(f.name));
  if (!objFile) return;
  // Blender's .obj references its sidecar via `mtllib <name>.mtl` — if
  // multiple other files were provided, prefer the one matching that name;
  // with only one other file provided, just assume that's the intended .mtl.
  const mtlCandidates = files.filter((f) => /\.mtl$/i.test(f.name));

  let materials = {};
  try {
    const objText = await readFileText(objFile);
    const mtllibMatch = objText.match(/^mtllib\s+(.+)$/m);
    const mtlFile = mtllibMatch
      ? mtlCandidates.find((f) => f.name === mtllibMatch[1].trim()) || mtlCandidates[0]
      : mtlCandidates[0];
    if (mtlFile) materials = parseMtl(await readFileText(mtlFile));

    const parsed = parseObj(objText, materials);
    applyParsedModel(parsed, objFile.name, mtlFile && mtlFile.name);
    clearModelFlowPath(); // a newly loaded model invalidates any previously drawn arrow
  } catch (err) {
    console.error(err);
    cubeModelStatus = `Couldn't read ${objFile.name}`;
    notifyModelState();
  }
}

// Delay before the opening bird's-eye -> resting-rotation tween below
// actually starts rotating — the zoom-out (see the tweenCubeRotationTo call
// below) still starts immediately at load, so this reads as the pull-back
// beginning alone for a beat before the rotation joins in, rather than both
// firing in the same instant.
const MODEL_LOAD_ROTATION_INTRO_DELAY_MS = 1000;

// Duration of the opening bird's-eye -> resting-rotation tween below, once
// it starts (after MODEL_LOAD_ROTATION_INTRO_DELAY_MS).
const MODEL_LOAD_ROTATION_INTRO_MS = 2000;

// Pause between intro phase 1 (the tween above) landing and phase 2 (the
// push into Camera Target 1, below) starting — long enough to read as a
// deliberate beat of stillness on the resting pose before the camera moves
// again, rather than the two phases blurring into one continuous motion.
const MODEL_LOAD_INTRO_PHASE_GAP_MS = 2000;

// How much earlier than the gap would otherwise put it phase 2 actually
// starts (see introCameraTargetTimer below) — phase 1's own zoom is still
// timed to finish at the full MODEL_LOAD_PHASE1_TOTAL_MS +
// MODEL_LOAD_INTRO_PHASE_GAP_MS mark either way. Set equal to the gap
// itself so it fully cancels the gap's effect on phase 2's *start time* —
// phase 2 begins the instant phase 1's rotation lands, with zero residual
// pause, while phase 1's own zoom keeps running independently until its
// own MODEL_LOAD_PHASE1_TOTAL_MS + MODEL_LOAD_INTRO_PHASE_GAP_MS mark.
// This also happens to close phase 2's own zoom start-delay gap: with
// MODEL_LOAD_PHASE2_ZOOM_DELAY_MS unchanged, phase-2 zoom now starts
// moving at the exact millisecond phase-1 zoom lands (see the timeline in
// plans/001-close-intro-phase-seam.md).
const MODEL_LOAD_PHASE_OVERLAP_MS = 2000;

// Total span of intro phase 1, from load to the resting pose landing —
// rotation's own delay + duration. The zoom (which starts at t=0, no delay)
// is timed to finish exactly here plus the phase gap (see the
// tweenCubeRotationTo call below), independent of when phase 2 itself
// starts (see MODEL_LOAD_PHASE_OVERLAP_MS above).
const MODEL_LOAD_PHASE1_TOTAL_MS = MODEL_LOAD_ROTATION_INTRO_DELAY_MS + MODEL_LOAD_ROTATION_INTRO_MS;

// Phase 2's pan duration (see startIntroCameraTargetTween) — pan itself has
// no delay, so this is also how long it takes from phase 2's start to land.
const MODEL_LOAD_PHASE2_PAN_MS = 5000;

// Phase 2's zoom duration and start delay — zoom holds at its starting
// scale until MODEL_LOAD_PHASE2_ZOOM_DELAY_MS after phase 2 begins, then
// eases over MODEL_LOAD_PHASE2_ZOOM_MS, landing at the same moment the pan
// does (2000 + 3000 = MODEL_LOAD_PHASE2_PAN_MS). ZOOM_DELAY_MS is left at
// 2000 rather than scaled up with everything else here — that's what makes
// it start moving at the exact millisecond phase 1's own zoom lands
// (MODEL_LOAD_PHASE2_START_MS + 2000 = MODEL_LOAD_PHASE1_TOTAL_MS +
// MODEL_LOAD_INTRO_PHASE_GAP_MS with the current constants), closing the
// seam between phase 1 and phase 2's zoom motion (see
// plans/001-close-intro-phase-seam.md) — changing this value would reopen
// that gap.
const MODEL_LOAD_PHASE2_ZOOM_MS = 3000;
const MODEL_LOAD_PHASE2_ZOOM_DELAY_MS = 2000;

// When phase 2 itself starts, relative to load — named so
// introCameraTargetTimer's delay and MODEL_LOAD_TOTAL_INTRO_MS below don't
// have to repeat the same formula.
const MODEL_LOAD_PHASE2_START_MS = MODEL_LOAD_PHASE1_TOTAL_MS + MODEL_LOAD_INTRO_PHASE_GAP_MS - MODEL_LOAD_PHASE_OVERLAP_MS;

// Full intro span, load to phase 2 fully landing — phase 2's own longer of
// pan/zoom (zoom's delay + duration) added to when phase 2 starts.
const MODEL_LOAD_TOTAL_INTRO_MS = MODEL_LOAD_PHASE2_START_MS
  + Math.max(MODEL_LOAD_PHASE2_PAN_MS, MODEL_LOAD_PHASE2_ZOOM_DELAY_MS + MODEL_LOAD_PHASE2_ZOOM_MS);

// cubeRotY's own separate settle tween (see startIntroYawTween below) runs
// this long — deliberately MODEL_LOAD_TOTAL_INTRO_MS plus 2 more seconds,
// so it keeps turning for a beat after both phases have otherwise fully
// landed, rather than tying it to either phase's own (much shorter)
// timeline or cutting off the instant they do.
const MODEL_LOAD_YAW_DURATION_MS = MODEL_LOAD_TOTAL_INTRO_MS + 2000;

// How far short of CUBE_ISO_YAW (the default orthographic pose's resting
// yaw) the model starts, in degrees — MODEL_LOAD_YAW_DURATION_MS turns it
// the rest of the way in.
const MODEL_LOAD_YAW_START_OFFSET_DEG = -30;

// Bundled default model (public/models/), shown on startup — same
// parse/apply path as a manual upload, just fetched from a static asset
// instead of picked/dropped by the user.
async function loadBundledDefaultModel() {
  try {
    const [objText, mtlText] = await Promise.all([
      fetch('/models/sg_connect_scroll_explainer.obj').then((r) => r.text()),
      fetch('/models/sg_connect_scroll_explainer.mtl').then((r) => r.text()),
    ]);
    const materials = parseMtl(mtlText);
    // Same extent normalization a manually dropped/uploaded model gets
    // (see loadModelFromFiles's own parseObj call) — no extra multiplier —
    // so the bundled default model isn't a different absolute physical size
    // than the same file would be if the user dragged it in themselves.
    // BAKED_DEFAULT_CAMERA_VIEW's sizePercent below is scaled up 8x to
    // compensate and keep the same on-screen framing this used to produce
    // at the old 8x-larger object-space scale; Camera Targets need no such
    // compensation since their own "frame to fit" zoom is computed fresh
    // from the model's actual (now 1x) bounds every time.
    const parsed = parseObj(objText, materials);
    // No defaultCameraTargets array needed here — this model already names
    // its own marker objects Target_1/Target_2/Target_3/Target_4 (each on
    // the invisible "Target" material, see isTargetMaterial), so
    // applyParsedModel's own Target_N auto-assignment (see its TARGET_NAME_RE)
    // wires slots 1-4 up on its own.
    applyParsedModel(parsed, 'sg_connect_scroll_explainer.obj', 'sg_connect_scroll_explainer.mtl');
    // Always lands on BAKED_DEFAULT_CAMERA_VIEW rather than whichever Camera
    // Target the user had active last session — both that and
    // defaultCameraView's own in-session edits are deliberately session-only
    // (see their declarations), always starting fresh at the baked-in
    // default view on load instead of persisting across a reload.
    // cameraTargetCurrent starts at [0,0,0] regardless, so the spring would
    // ease into a target's centroid/zoom from center on load rather than
    // snapping there, if one ever were active this early.
    //
    // Pan/zoom is applied instantly, same as before; rotation always eases
    // to the same fixed CUBE_ISO_PITCH/YAW baseline (defaultCameraView never
    // carries rotation — see its own declaration comment; Camera Targets
    // never did either), as a single bird's-eye -> resting-rotation tween —
    // cubeRotX/Y start pinned to the bird's-eye pose (see their declaration)
    // for exactly this: so the model's first look, once it's actually
    // loaded, is dropping down into place rather than just appearing already
    // framed.
    defaultCameraView = BAKED_DEFAULT_CAMERA_VIEW;
    applyDefaultCameraViewPanZoom(defaultCameraView);
    // The /scroll route (IS_SCROLL_ROUTE) snaps cameraTargetCurrent/
    // cameraTargetZoomCurrent straight to Target 1's goal here, up front —
    // renderCubeFrame's own IS_SCROLL_ROUTE branch only *eases* toward its
    // scroll-derived goal each frame (see SCROLL_SCRUB_SMOOTHING there), so
    // without this, cameraTargetCurrent's [0, 0, 0] module-load default would
    // visibly ease in from the origin on first load instead of landing
    // already at rest. With current pre-set equal to the goal it'll compute
    // at scrollY 0 anyway, that easing has nothing to do on the first frame.
    if (IS_SCROLL_ROUTE) {
      const goal = computeCameraTargetGoal(0);
      // When the model names a Target_Start marker object, that's the
      // animation's actual starting framing (see findTargetStartObject) —
      // scrolling then eases from here into Target 1 over the intro span
      // (renderCubeFrame's own IS_SCROLL_ROUTE branch below). Falls back to
      // the old zoom-only pull-in for models with no Target_Start: starts at
      // (1 - SCROLL_INTRO_ZOOM_OUT_FRACTION) of Target 1's own zoom, same
      // position as Target 1 throughout — matches renderCubeFrame's
      // introZoomMultiplier at progress 0 exactly, so there's no jump once
      // scroll starts driving that same multiplier back up to 1.
      const startObj = findTargetStartObject();
      if (startObj) {
        const startGoal = computeCameraTargetGoalForObject(startObj);
        cameraTargetCurrent = startGoal.center;
        cameraTargetZoomCurrent = startGoal.zoomGoal;
      } else {
        cameraTargetCurrent = goal.center;
        cameraTargetZoomCurrent = goal.zoomGoal * (1 - SCROLL_INTRO_ZOOM_OUT_FRACTION);
      }
    }
    // suppressParallax: false — keep ambient hover tilt live through the
    // whole drop instead of freezing it (see cubeRotResetSuppressParallax).
    // zoomInFactor 0.5: phase 1 starts ~50% zoomed in past the baked
    // default's zoom and eases back out to exactly that default level as it
    // rotates into the resting pose — so the baked default stays the same
    // fixed framing the rest of the app already assumes (phase 2's push
    // into Camera Target 1 below, "Go to default", etc.), and only the
    // opening beat itself pulls back to reach it. zoomDurationMs stretches
    // that zoom-out across all of phase 1 (delay + rotation duration, see
    // MODEL_LOAD_PHASE1_TOTAL_MS) *and* the MODEL_LOAD_INTRO_PHASE_GAP_MS
    // pause after it, so the pull-back is still visibly settling into the
    // gap instead of finishing the instant rotation lands. zoomEasing is
    // EASE_OUT_QUAD rather than matching the rotation's own EASE_IN_OUT_EXPO
    // pause-then-snap curve, or EASE_OUT_CUBIC (the sharper default built
    // for fast 180ms UI resets) — a gentler decelerate-to-rest that suits
    // this much longer, purely cinematic pull-back. delayMs holds rotation
    // at the bird's-eye pose for MODEL_LOAD_ROTATION_INTRO_DELAY_MS while
    // the zoom (which ignores this delay, see cubeRotResetDelayMs) is
    // already underway.
    //
    // The /scroll route (IS_SCROLL_ROUTE, see its own declaration) skips
    // this whole section — cubeRotX/Y are already pinned to CUBE_ISO_PITCH/
    // YAW (their resting angle) from module load, defaultCameraView's
    // pan/zoom above is already instant, and there's no push into Camera
    // Target 1: the model just sits at rest, with only live hover-parallax
    // tilt on top.
    if (!IS_SCROLL_ROUTE) {
    // Yaw itself is handed off entirely to startIntroYawTween below (see
    // its own comment) — passing this call's own current cubeRotY (just set
    // by startIntroYawTween, immediately above) as its yaw target makes this
    // tween's Y contribution a deliberate no-op (from === target), so
    // there's exactly one thing driving cubeRotY through the whole intro,
    // not two tweens racing on the same variable.
    startIntroYawTween(
      CUBE_ISO_YAW + (MODEL_LOAD_YAW_START_OFFSET_DEG * Math.PI) / 180,
      CUBE_ISO_YAW,
      MODEL_LOAD_YAW_DURATION_MS,
      EASE_IN_OUT_SINE,
    );
    tweenCubeRotationTo(
      CUBE_ISO_PITCH, cubeRotY, MODEL_LOAD_ROTATION_INTRO_MS, false, EASE_IN_OUT_EXPO, 0.5,
      MODEL_LOAD_PHASE1_TOTAL_MS + MODEL_LOAD_INTRO_PHASE_GAP_MS, EASE_OUT_QUAD,
      MODEL_LOAD_ROTATION_INTRO_DELAY_MS,
    );
    // Intro phase 2: MODEL_LOAD_PHASE_OVERLAP_MS before the rotation tween
    // above (plus its trailing zoom-out) would otherwise fully finish
    // settling, ease on into Camera Target 1 (the bundled model's first
    // object group, see applyParsedModel's own call above) over its own
    // fixed duration and easing curves (see startIntroCameraTargetTween)
    // rather than the physically-simulated spring goToCameraTarget uses for
    // a manual 1/2/3 press — so the intro's last beat reads as arriving somewhere specific, on a
    // deliberately tuned timing, instead of just stopping at a generic
    // framing. Pan and zoom share the same EASE_IN_OUT_QUAD curve — the
    // in-out counterpart of phase 1's own zoom curve (EASE_OUT_QUAD, see its
    // call site above) — but zoom additionally holds at its starting scale
    // for MODEL_LOAD_PHASE2_ZOOM_DELAY_MS before easing over
    // MODEL_LOAD_PHASE2_ZOOM_MS (see its own comment on why that lands it
    // exactly alongside the pan). startIntroCameraTargetTween itself is a
    // no-op if slot 0 ends up unassigned (e.g. a fresh manual model load
    // beat this timer to it), and this timer is cancelled by
    // goToCameraTarget/resetCameraTarget if the presenter picks a target
    // (or "Go to default") manually before it fires.
    introCameraTargetTimer = setTimeout(
      () => startIntroCameraTargetTween(
        0, MODEL_LOAD_PHASE2_PAN_MS, EASE_IN_OUT_QUAD, MODEL_LOAD_PHASE2_ZOOM_MS, EASE_IN_OUT_QUAD,
        MODEL_LOAD_PHASE2_ZOOM_DELAY_MS,
      ),
      MODEL_LOAD_PHASE2_START_MS,
    );
    } // end if (!IS_SCROLL_ROUTE) — opening camera move
    // Hero never restores a locally-drawn arrow from localStorage — every
    // visitor is effectively a fresh session, so it always plays the baked
    // default flow path. IS_HERO short-circuits before restoreModelFlowPath()
    // is even called.
    if (IS_HERO || !restoreModelFlowPath()) applyDefaultModelFlowPath();
  } catch (err) {
    console.error(err);
  }
}

// Drag-and-drop a .obj (+ optional .mtl) anywhere on the page as an
// alternative to the file picker — same loadModelFromFiles path either way.
if (!IS_HERO) {
window.addEventListener('dragover', (event) => {
  event.preventDefault();
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length) loadModelFromFiles(files);
});
} // end if (!IS_HERO) — drag-and-drop model upload

// --- 3D flow arrows: draw one or more paths on the model's green parts, pulse follows each ---
//
// A Gaussian glow band travels along each user-drawn path at a shared
// absolute world-space speed (see FLOW_PULSE_PERIOD_BASE_MS/
// flowSpeedWorldPerMs), scaled by the user-adjustable flowSpeedPercent. Each
// "path" is drawn directly on the model's surface (via raycasting into the
// green triangles under the cursor), and each vertex's position along its
// nearest path is computed once (in object space) rather than per-frame.
// Supports any number of arrows — e.g. separate branches of a green run
// that don't share a single line — by giving every green vertex a flow
// coordinate normalized to *its own nearest arrow's* length (0-1) rather
// than an absolute arc length; since the pulse moves at the same speed on
// every arrow, a short arrow's lap takes less time than a long arrow's, so
// arrows are intentionally *not* kept in phase with each other (see
// recomputeModelFlowCoords).

const MODEL_FLOW_STORAGE_KEY = 'iconMosaic.modelFlowPath';
// Baked-in starter arrows for the bundled default model (see
// loadBundledDefaultModel/applyDefaultModelFlowPath below) — when non-empty,
// captured from a hand-drawn path (via
// `copy(localStorage.getItem('iconMosaic.modelFlowPath'))` in the console)
// so a fresh browser with nothing in localStorage yet still gets a pulsing
// flow instead of an empty green mesh. Same shape saveModelFlowPath persists
// to localStorage (points/touchedObjectIndices/enabledObjectIndices/
// sourceOffset/masterTotalLen — the latter two carry over branch/junction
// timing, see buildModelFlowPathsFromData), just applied unconditionally on
// startup instead. Specific to the bundled model's geometry/scale — re-capture
// and replace if the model ever changes again.
const DEFAULT_MODEL_FLOW_PATH_DATA = [{"points":[[2.9193208411913467,0.3450483466730212,0.6807763727238205],[2.920140044189356,0.345457959349897,0.7635828152373607],[2.831728841714245,0.3012523481509035,0.7617691417902384],[2.8273479672802537,0.2978634770865014,0.7632343634131069],[2.8243567943573,0.21762156264267318,0.763172484136307]],"touchedObjectIndices":[290],"enabledObjectIndices":[290],"sourceOffset":0,"masterTotalLen":0.26770171824033},{"points":[[2.8243560791015625,0.17225761710876597,0.7315663648890101],[2.824356079101566,0.17317488650298074,0.7121198791925596],[2.8243560791015625,0.027922332357467994,0.7121003349860455],[2.6412663050652228,0.025641715154048228,0.7112586275687125],[2.641338720328406,0.025641715154055333,0.30847663917537815]],"touchedObjectIndices":[281],"enabledObjectIndices":[281],"sourceOffset":0,"masterTotalLen":0.7506085694272375},{"points":[[2.179713677649727,0.025641715154055333,0.76510943477723],[2.8231795130468864,0.025641715154055333,0.762294748322395],[2.8243567943572963,0.13271278534180997,0.76448478403832]],"touchedObjectIndices":[286],"enabledObjectIndices":[286],"sourceOffset":0,"masterTotalLen":0.7505719275811688},{"points":[[2.7927913274351943,0.0769233107566798,1.0027242639323681],[2.8233749713963,0.0769233107566869,1.0014170361237582],[2.8243567943573,0.17617733219321252,1.0015159477265954],[2.8243567943573034,0.17417924250182182,0.7928369420709132]],"touchedObjectIndices":[276],"enabledObjectIndices":[276],"sourceOffset":0,"masterTotalLen":0.3385590663841229},{"points":[[2.249643507504757,0.13568516288468402,-1.4674314188739253],[2.228429990926305,0.02533801268207725,-1.4650859789525796],[2.0815684795379674,0.025324682875293547,-1.4661642310223506],[2.0851854091261828,0.025513144209977412,0.7600910991531578],[2.1358722223005593,0.025513144209984517,0.7648541776115643]],"touchedObjectIndices":[267],"enabledObjectIndices":[267],"sourceOffset":0,"masterTotalLen":2.536426068669501},{"points":[[6.421203271720733,1.3649130958472284,-1.1827020511365305],[2.4513610250754514,1.3681475905041651,-1.1865082921635377]],"touchedObjectIndices":[195],"enabledObjectIndices":[195],"sourceOffset":0,"masterTotalLen":3.969845389014049},{"points":[[6.417725351802733,1.0903076890805323,-1.1831838825033785],[2.45740796979761,1.0915539113993304,-1.1851533834749048]],"touchedObjectIndices":[192,191],"enabledObjectIndices":[192,191],"sourceOffset":0,"masterTotalLen":3.960318067809207},{"points":[[6.4162532939121455,0.8170069949419201,-1.184840293862429],[2.4502449940134277,0.8168324060597882,-1.1848614897615093]],"touchedObjectIndices":[187],"enabledObjectIndices":[187],"sourceOffset":0,"masterTotalLen":3.966008303798173},{"points":[[6.403309893632118,0.8161586120980928,-1.7490164659021303],[2.475109187920976,0.8134537726634079,-1.74721371511378]],"touchedObjectIndices":[199],"enabledObjectIndices":[199],"sourceOffset":0,"masterTotalLen":3.9282020506099595},{"points":[[6.406167008663138,1.092914674866833,-1.7511773085437383],[2.4746065111725164,1.0899873564952145,-1.74884174856129]],"touchedObjectIndices":[203],"enabledObjectIndices":[203],"sourceOffset":0,"masterTotalLen":3.931562281010182},{"points":[[6.420001530148442,1.3649901266430788,-1.747055980944694],[2.4617695927127317,1.3646300066159682,-1.7478329066869094]],"touchedObjectIndices":[208,207],"enabledObjectIndices":[208,207],"sourceOffset":0,"masterTotalLen":3.958232030065455},{"points":[[-7.259464823921391,0.8264391790253285,-3.9514793189036985],[-7.2576988530541655,0.8276633270421598,0.006732973637443851]],"touchedObjectIndices":[201],"enabledObjectIndices":[201],"sourceOffset":0,"masterTotalLen":3.95821287578312},{"points":[[-7.255482562753031,1.1053542423735365,-3.952383955973123],[-7.260189157176946,1.1000208285077093,0.006495491217888838]],"touchedObjectIndices":[205],"enabledObjectIndices":[205],"sourceOffset":0,"masterTotalLen":3.9588858375464615},{"points":[[-7.259581812925482,1.375652664900045,-3.9451497935696818],[-7.255006918623415,1.38073269744757,0.017184688420707195]],"touchedObjectIndices":[209,210],"enabledObjectIndices":[209,210],"sourceOffset":0,"masterTotalLen":3.962340379568444},{"points":[[-6.692540768152313,1.3786185382302563,-3.9470147073243567],[-6.6928029750615465,1.3785760583205189,0.014616207207813314]],"touchedObjectIndices":[197],"enabledObjectIndices":[197],"sourceOffset":0,"masterTotalLen":3.961630923437215},{"points":[[-6.693624718167371,1.102253895537487,-3.9405482423844065],[-6.693015100541544,1.1025763281267729,-0.0004402189248828847]],"touchedObjectIndices":[193,194],"enabledObjectIndices":[193,194],"sourceOffset":0,"masterTotalLen":3.9401080838127447},{"points":[[-6.6905426343303205,0.8297677556671914,-3.9294216423537947],[-6.691525641360684,0.8296138368386892,0.00630375648084569]],"touchedObjectIndices":[189],"enabledObjectIndices":[189],"sourceOffset":0,"masterTotalLen":3.935725524604824},{"points":[[-6.972605409303895,0.14712809931605975,0.21547474016745838],[-6.969792772275859,0.03811296234210104,0.2361383225688094],[-6.97091310360914,0.03828848898410797,0.3830082831212458],[-6.362797007257534,0.03828848898410797,0.3782981863323158],[-6.3628195327074195,0.03828848898410442,0.23726290723212173]],"touchedObjectIndices":[268],"enabledObjectIndices":[268],"sourceOffset":0,"masterTotalLen":1.0070358236067254},{"points":[[-6.331820531669813,0.038288488984111524,0.2362584495725244],[-6.333049522671184,0.038288488984111524,0.5343361258826249],[-6.01420150516388,0.038288306444879794,0.5312573466036987]],"touchedObjectIndices":[269],"enabledObjectIndices":[269],"sourceOffset":0,"masterTotalLen":2.992862387445121},{"points":[[-6.01420150516388,0.038288306444879794,0.5312573466036987],[-5.913842311146524,0.03828830644488335,0.531495919083131]],"touchedObjectIndices":[269],"enabledObjectIndices":[269],"sourceOffset":0.6169430913231151,"masterTotalLen":2.992862387445121},{"points":[[-6.01420150516388,0.038288306444879794,0.5312573466036987],[-6.021771401814939,0.03828830644489045,-1.745832139178301],[-5.922955963843495,0.03828830644489045,-1.7452373896975928]],"touchedObjectIndices":[269],"enabledObjectIndices":[269],"sourceOffset":0.6169430913231151,"masterTotalLen":2.992862387445121},{"points":[[-5.7197148529759385,0.03828830644487624,-1.746089194158916],[-5.529495901506156,0.03828830644488335,-1.744652538730449]],"touchedObjectIndices":[374],"enabledObjectIndices":[374],"sourceOffset":0,"masterTotalLen":0.19022437666367503},{"points":[[-5.328778877971166,0.03828830644488335,-1.7440146141339987],[-5.150774034945618,0.03828830644488335,-1.7432520414106278]],"touchedObjectIndices":[373],"enabledObjectIndices":[373],"sourceOffset":0,"masterTotalLen":0.17800647644877501},{"points":[[-5.711766393549908,0.038288306444879794,0.5308282376716633],[-5.535274391428835,0.03828830644488335,0.5314829470231253]],"touchedObjectIndices":[371],"enabledObjectIndices":[371],"sourceOffset":0,"masterTotalLen":0.17649321646182223},{"points":[[-5.327331129779817,0.0382883064448869,0.5302478279888803],[-5.149750599759948,0.03828830644488335,0.530641906502126]],"touchedObjectIndices":[372],"enabledObjectIndices":[372],"sourceOffset":0,"masterTotalLen":0.1775809672797513},{"points":[[-0.462270931282422,0.35478723725054095,0.32368792867420426],[-0.46389842978493334,0.3539734657925955,0.40776601322515127],[-0.554541473553833,0.30841575021379697,0.4055771691279175],[-0.558397650718689,0.22490972772847684,0.40468492887138474]],"touchedObjectIndices":[294],"enabledObjectIndices":[294],"sourceOffset":0,"masterTotalLen":0.269169008107442},{"points":[[-0.8787762818350029,0.03479950875043514,0.4067966178320752],[-0.5610170264249916,0.03479932621121051,0.4053239291488282],[-0.558397650718689,0.138655320233942,0.40562472448252507]],"touchedObjectIndices":[289],"enabledObjectIndices":[289],"sourceOffset":0,"masterTotalLen":0.4216521242177545},{"points":[[-0.5583980083465576,0.18189131232486133,0.3737903461002057],[-0.5583980083465576,0.18340023287234786,0.3531567313295398],[-0.5583980083465576,0.03720825825165264,0.35341587720412054],[-0.7385454038963761,0.03479950875044224,0.3533754307082635],[-0.7384115618870588,0.03479950875043514,-0.04985344575668549]],"touchedObjectIndices":[284],"enabledObjectIndices":[284],"sourceOffset":0,"masterTotalLen":0.7502733203488117},{"points":[[-0.5583976507186872,0.18548004858528344,0.4367081796394441],[-0.5583976507186907,0.18300103645908194,0.6444739789638163],[-0.5583976507186872,0.08702161625780391,0.6431372552710037],[-0.5905975408468174,0.08608092367649078,0.6442015739789149]],"touchedObjectIndices":[279],"enabledObjectIndices":[279],"sourceOffset":0,"masterTotalLen":0.33600052183592033},{"points":[[-2.792728062617666,0.35291716980972865,0.2243392418203669],[-2.7091733231336335,0.3530761091091499,0.22402137261885713],[-2.7123292488607627,0.3082751995567321,0.31362318571966696],[-2.713060234033562,0.30257338052860305,0.31799816732996433],[-2.712362809124251,0.22353525623535475,0.3189086318016052]],"touchedObjectIndices":[293],"enabledObjectIndices":[293],"sourceOffset":0,"masterTotalLen":0.27005346876917313},{"points":[[-2.7413183833607526,0.18077285075371208,0.31890916824341176],[-2.7638359678451296,0.18302360345870738,0.31890916824341176],[-2.7629700486283912,0.04058248055271818,0.3189091682434082],[-2.7633067676188285,0.03370794281363487,0.500874885791891],[-3.166851696245338,0.03370794281363487,0.5016284498284307]],"touchedObjectIndices":[283],"enabledObjectIndices":[283],"sourceOffset":0,"masterTotalLen":0.7507150195816545},{"points":[[-2.711427545723472,0.03370794281363487,0.6390487353904148],[-2.7115160438664336,0.03370794281363487,0.3208953518927036],[-2.712492905203458,0.1377524743540084,0.3189086318016088]],"touchedObjectIndices":[288],"enabledObjectIndices":[288],"sourceOffset":0,"masterTotalLen":0.4222214786089038},{"points":[[-2.683224113915377,0.18012531197184245,0.3189086318016052],[-2.4720779479255777,0.18278827465548275,0.3189086318016088],[-2.4744668252343747,0.08498954027891514,0.3191314130636602],[-2.473629625037546,0.08498954027891159,0.35091903145715475]],"touchedObjectIndices":[278],"enabledObjectIndices":[278],"sourceOffset":0,"masterTotalLen":0.34078975877126944},{"points":[[-0.9356327481054336,0.3619528166520567,-2.4953165165354],[-0.8548101415690175,0.36209371208109786,-2.4955982868876703],[-0.8532338177039627,0.3154838908878652,-2.4035450334313495],[-0.8553209542390112,0.23119744454981728,-2.4000005722045934]],"touchedObjectIndices":[292],"enabledObjectIndices":[292],"sourceOffset":0,"masterTotalLen":0.26840281272620264},{"points":[[-0.8833552579205279,0.19099855505973906,-2.399999856948856],[-0.9064407824348437,0.19341424679388908,-2.399999856948856],[-0.9059425047951959,0.04269165351604798,-2.399999856948856],[-0.906081065133618,0.042370319366451525,-2.2178971172485547],[-1.305766141676278,0.04023528811884525,-2.2155969142913783]],"touchedObjectIndices":[282],"enabledObjectIndices":[282],"sourceOffset":0,"masterTotalLen":0.755735461079476},{"points":[[-0.8509288021777266,0.04237031936645508,-2.0806504824320653],[-0.8536248699569473,0.042631783311144034,-2.4000003337860107],[-0.8541336592365703,0.14725451641750942,-2.400000333786007]],"touchedObjectIndices":[287],"enabledObjectIndices":[287],"sourceOffset":0,"masterTotalLen":0.4239853090176636},{"points":[[-0.8259317484142148,0.1898956750916163,-2.4000005722045934],[-0.6165747432970328,0.1913945494244711,-2.4000005722045863],[-0.6146920552617345,0.0937650237952532,-2.400000572204588],[-0.6170739368645926,0.09365192055702565,-2.368652439764817]],"touchedObjectIndices":[277],"enabledObjectIndices":[277],"sourceOffset":0,"masterTotalLen":0.3384487426668632},{"points":[[-3.9436116672438537,0.35402838106542234,-3.7054272430527746],[-3.9426847115493615,0.35449185891267376,-3.624031511327134],[-4.031114179299372,0.3102771846423025,-3.623098851401724],[-4.038219451904297,0.23104646331603362,-3.6224566997657837]],"touchedObjectIndices":[291],"enabledObjectIndices":[291],"sourceOffset":0,"masterTotalLen":0.2598251214988603},{"points":[[-4.038220882415775,0.184308511985801,-3.654389738731903],[-4.0382208824157715,0.18359249779317466,-3.6765965357968358],[-4.038220882415775,0.03516462927424513,-3.6761267544130836],[-4.219410238584899,0.03479969128965976,-3.675777273328257],[-4.219888568666491,0.034799691289663315,-4.077374649948439]],"touchedObjectIndices":[280],"enabledObjectIndices":[280],"sourceOffset":0,"masterTotalLen":0.753434671461332},{"points":[[-4.357849640830646,0.031154260810406953,-3.6202764511108363],[-4.039656489178178,0.03479969128965976,-3.620999523454282],[-4.038220405578617,0.1414591293066474,-3.6227831268869455]],"touchedObjectIndices":[285],"enabledObjectIndices":[285],"sourceOffset":0,"masterTotalLen":0.42489887082555344},{"points":[[-4.070202383124194,0.08608128875494003,-3.3844415774140053],[-4.038383136639382,0.08608128875494003,-3.384474633267244],[-4.038220405578615,0.18273584985980662,-3.384748514564995],[-4.038220405578613,0.1853599071652816,-3.593399799445046]],"touchedObjectIndices":[275],"enabledObjectIndices":[275],"sourceOffset":0,"masterTotalLen":0.33714213445416474},{"points":[[-3.1651170993245614,0.8006025679609436,-1.62803316116333],[-3.1644245908198556,0.8283831499268963,-1.62803316116333],[-3.1280345333075967,0.8292234539985657,-1.629305023702969],[-3.1279126941045323,0.5424314205647462,-1.6280331611633265],[-2.7497409265515937,0.5432774424552917,-1.6314943895831284],[-2.750350238734047,0.5432774424552917,-1.545180933320598],[-2.7499241633031595,0.583151638507843,-1.5418964227066372],[-2.7500955160739906,0.583151638507843,-1.5110230937898699],[-2.7493908306966546,0.22892677413628348,-1.5070822238922084]],"touchedObjectIndices":[30],"enabledObjectIndices":[30],"sourceOffset":0,"masterTotalLen":1.240643025599736},{"points":[[-2.4426329135894775,0.030264412469762192,-1.015135657830097],[-2.4426329135894775,0.031375997800147104,-1.337905529771433],[-2.751660342962058,0.032496966421604156,-1.3390602359549924],[-2.7492949813288217,0.035312147223244494,-1.5069890022277868],[-2.7476215230551375,0.13339069183559715,-1.5069890022277797]],"touchedObjectIndices":[302],"enabledObjectIndices":[302],"sourceOffset":0,"masterTotalLen":0.8978652431533579},{"points":[[-2.7719343547967954,0.13539441998002388,-1.5069890022277797],[-2.771406689556091,0.0352149140221929,-1.5069890022277797],[-2.772617871080115,0.03243176266551018,-1.280556921005745]],"touchedObjectIndices":[256],"enabledObjectIndices":[256],"sourceOffset":0,"masterTotalLen":1.2485819969225629},{"points":[[-2.772617871080115,0.03243176266551018,-1.280556921005745],[-2.7703815664804026,0.03243176266551373,-1.1449915433419862]],"touchedObjectIndices":[256],"enabledObjectIndices":[256],"sourceOffset":0.32663331952550523,"masterTotalLen":1.2485819969225629},{"points":[[-2.772617871080115,0.03243176266551018,-1.280556921005745],[-3.164239512023519,0.03243176266551018,-1.2814361666074512]],"touchedObjectIndices":[256],"enabledObjectIndices":[256],"sourceOffset":0.32663331952550523,"masterTotalLen":1.2485819969225629},{"points":[[-3.164239512023519,0.03243176266551018,-1.2814361666074512],[-3.164352854992119,0.03243176266551018,-1.1423247955053824]],"touchedObjectIndices":[256],"enabledObjectIndices":[256],"sourceOffset":0.7182559474826146,"masterTotalLen":1.2485819969225629},{"points":[[-3.164239512023519,0.03243176266551018,-1.2814361666074512],[-3.5555357440031035,0.03243176266551373,-1.2836172017833216],[-3.5566299445412675,0.032431762665506625,-1.1445977687566118]],"touchedObjectIndices":[256],"enabledObjectIndices":[256],"sourceOffset":0.7182559474826146,"masterTotalLen":1.2485819969225629},{"points":[[-2.4893055278466463,0.03209239427994781,-1.8293642997741717],[-2.450103347250751,0.032496966421604156,-1.8327251395953184],[-2.4469041460286025,0.032496966421604156,-1.7064728651214658]],"touchedObjectIndices":[186],"enabledObjectIndices":[186],"sourceOffset":0,"masterTotalLen":0.9781444834150789},{"points":[[-2.4469041460286025,0.032496966421604156,-1.7064728651214658],[-2.4881428431236454,0.032496966421600604,-1.7073853736881492]],"touchedObjectIndices":[186],"enabledObjectIndices":[186],"sourceOffset":0.1656408622212007,"masterTotalLen":0.9781444834150789},{"points":[[-2.4469041460286025,0.032496966421604156,-1.7064728651214658],[-2.447022871897623,0.03249696642160771,-1.5839715861893957]],"touchedObjectIndices":[186],"enabledObjectIndices":[186],"sourceOffset":0.1656408622212007,"masterTotalLen":0.9781444834150789},{"points":[[-2.447022871897623,0.03249696642160771,-1.5839715861893957],[-2.4901167071967265,0.032496966421604156,-1.5834954364840694]],"touchedObjectIndices":[186],"enabledObjectIndices":[186],"sourceOffset":0.2881421986866647,"masterTotalLen":0.9781444834150789},{"points":[[-2.447022871897623,0.03249696642160771,-1.5839715861893957],[-2.445136010842889,0.03249696642160238,-1.3935241014601072],[-2.7278849064602078,0.032496966421600604,-1.393327362128689],[-2.7289329359223053,0.034142354702291655,-1.5069890022277814],[-2.726166367574212,0.13722334475188447,-1.506989002227785]],"touchedObjectIndices":[186],"enabledObjectIndices":[186],"sourceOffset":0.2881421986866647,"masterTotalLen":0.9781444834150789},{"points":[[-1.3599698673636382,0.7961975336074829,-4.262721513612154],[-1.3560040882418534,0.8303149938583374,-4.259377518174784],[-1.357296910201292,0.8303149938583374,-4.226610865913358],[-1.356117302374372,0.5538302992816213,-4.221238136291504],[-1.355983676642623,0.5443689823150599,-3.8520221725774135],[-1.4432653282087777,0.5443689823150635,-3.8481853400986665],[-1.445828453810261,0.5842431783676147,-3.8426357326483966],[-1.4778348462420983,0.5842431783676147,-3.8447463213737905],[-1.479634404182434,0.23467153744490687,-3.8459099434085786]],"touchedObjectIndices":[33,29],"enabledObjectIndices":[33,29],"sourceOffset":0,"masterTotalLen":1.2225384269823603},{"points":[[-1.1531189716717822,0.03358853235841508,-3.5804823722331918],[-1.1542463829450131,0.03358853235841153,-3.538464853767554],[-1.280149185208149,0.033588532358407974,-3.541500262778481]],"touchedObjectIndices":[185],"enabledObjectIndices":[185],"sourceOffset":0,"masterTotalLen":0.9779511506900345},{"points":[[-1.280149185208149,0.033588532358407974,-3.541500262778481],[-1.2776621034608269,0.03358853235840087,-3.579882777551081]],"touchedObjectIndices":[185],"enabledObjectIndices":[185],"sourceOffset":0.16797202856329982,"masterTotalLen":0.9779511506900345},{"points":[[-1.280149185208149,0.033588532358407974,-3.541500262778481],[-1.4031512663417853,0.03358853235841153,-3.541534488362707]],"touchedObjectIndices":[185],"enabledObjectIndices":[185],"sourceOffset":0.16797202856329982,"masterTotalLen":0.9779511506900345},{"points":[[-1.4031512663417853,0.03358853235841153,-3.541534488362707],[-1.4003929310067207,0.03358853235841153,-3.582564053292458]],"touchedObjectIndices":[185],"enabledObjectIndices":[185],"sourceOffset":0.29097411445860594,"masterTotalLen":0.9779511506900345},{"points":[[-1.4031512663417853,0.03358853235841153,-3.541534488362707],[-1.5921370191875521,0.03358853235840442,-3.541651163713695],[-1.5931758769800108,0.03358853235841153,-3.8209515594478702],[-1.4819012920039576,0.033588532358407974,-3.8241733920555916],[-1.476890350938934,0.1407799396565066,-3.8206074237823415]],"touchedObjectIndices":[185],"enabledObjectIndices":[185],"sourceOffset":0.29097411445860594,"masterTotalLen":0.9779511506900345},{"points":[[-1.966185706273345,0.03319435581740393,-3.537832736968994],[-1.649277913031602,0.03358853235841508,-3.5400669554512874],[-1.6486690242363338,0.03358853235840442,-3.8438230784677003],[-1.480387064430932,0.033588532358407974,-3.8447666257733832],[-1.4797276258468628,0.13443458782275997,-3.8444245768655865]],"touchedObjectIndices":[301],"enabledObjectIndices":[301],"sourceOffset":0,"masterTotalLen":0.8898060438039553},{"points":[[-1.4797276258468628,0.1288685291988756,-3.8639325482393705],[-1.4806110041116725,0.03352332860231755,-3.866337149981204],[-1.7055894501240516,0.0335233286023211,-3.8687115599179673]],"touchedObjectIndices":[255],"enabledObjectIndices":[255],"sourceOffset":0,"masterTotalLen":1.2437352463246638},{"points":[[-1.7055894501240516,0.0335233286023211,-3.8687115599179673],[-1.8341407386625055,0.033523328602313995,-3.866675561287945]],"touchedObjectIndices":[255],"enabledObjectIndices":[255],"sourceOffset":0.32037058399399976,"masterTotalLen":1.2437352463246638},{"points":[[-1.7055894501240516,0.0335233286023211,-3.8687115599179673],[-1.7038661316375459,0.033523328602313995,-4.261168419206779]],"touchedObjectIndices":[255],"enabledObjectIndices":[255],"sourceOffset":0.32037058399399976,"masterTotalLen":1.2437352463246638},{"points":[[-1.7038661316375459,0.033523328602313995,-4.261168419206779],[-1.8312136174895608,0.0335233286023211,-4.258000194500129]],"touchedObjectIndices":[255],"enabledObjectIndices":[255],"sourceOffset":0.7128312268990484,"masterTotalLen":1.2437352463246638},{"points":[[-1.7038661316375459,0.033523328602313995,-4.261168419206779],[-1.7034569435811586,0.033523328602313995,-4.6512968865427915],[-1.8441554528619828,0.03284347604660098,-4.6466965675354]],"touchedObjectIndices":[255],"enabledObjectIndices":[255],"sourceOffset":0.7128312268990484,"masterTotalLen":1.2437352463246638}];
const MODEL_FLOW_PULSE_BAND_FRACTION = 0.15; // sigma as a fraction of each path's own normalized (0-1) length
// Fixed reference length (world units) the head's, tail's, and core's reach
// are all computed against instead of each arrow's own masterTotalLen, so
// they produce the same absolute size on every arrow regardless of how long
// that specific arrow is drawn. Chosen to roughly match the previous look on
// a mid-length arrow; tune directly if the head/tail/core read too long/short.
const MODEL_FLOW_REFERENCE_LENGTH = 3;
// Comet head's fixed fraction of uFlowSigma (the "Pulse width" slider's own
// base scale) — unlike FLOW_CORE_LENGTH/FLOW_TAIL_LENGTH there's no user
// control for this, so it's just a constant multiplier converted to an
// absolute world-space sigma (see uFlowHeadWorldSigma below) the same way
// flowCoreLengthPercent/flowTailLengthPercent are.
const FLOW_COMET_HEAD_SIGMA_MULT = 0.12;
// Sentinel aFlowCoord for a green vertex no arrow reaches (no path enables
// its object) — any negative value works since real arc-length fractions
// are always in [0, 1]; the fragment shader's `vFlowCoord >= 0.0` check is
// what actually keeps these vertices dark, this just has to stay negative.
const MODEL_FLOW_NO_ARROW_COORD = -1;
const MODEL_FLOW_ARROW_COLOR = [0.2, 0.45, 0.95]; // blue guide line for finalized, unselected arrows
const MODEL_FLOW_ARROW_SELECTED_COLOR = [1, 0.55, 0.1]; // orange highlight for the currently selected arrow/branch — distinct from the plain finished-arrow blue above
const MODEL_FLOW_ARROW_DRAG_COLOR = [1, 0, 0]; // red for the not-yet-finalized in-progress drag — turns blue once double-clicked to confirm
const MODEL_FLOW_ARROW_HALF_WIDTH_PX = 3; // half-width of the ribbon built in buildArrowRibbonNDC below
const MODEL_FLOW_ARROW_OPACITY = 0.75; // applied to all three ribbon batches (finalized/selected/in-progress) via uLineAlpha
// Rubber-band cursor preview (see modelFlowHoverClientPos): a dashed line
// from the last placed point out to wherever the cursor currently raycasts,
// previewing the segment a click would add before it's actually placed.
// Same red as the in-progress drag ribbon, dashed instead of solid so it
// reads as "not yet real" even at a glance.
const MODEL_FLOW_HOVER_LINE_HALF_WIDTH_PX = MODEL_FLOW_ARROW_HALF_WIDTH_PX * 0.75;
const MODEL_FLOW_HOVER_DASH_LENGTH_PX = 8;
const MODEL_FLOW_HOVER_DASH_GAP_PX = 6;
// Furthest an object-space click can land from an arrow's polyline and still
// count as selecting it (see nearestPointOnPath3D) — beyond this, a click in
// select mode is treated as clicking empty space and clears the selection.
const MODEL_FLOW_SELECT_MAX_DIST = 0.2;
// Furthest a pointerdown->pointerup pair can drift (screen pixels) and still
// count as a click rather than a drag, while in select mode.
const MODEL_FLOW_SELECT_CLICK_MAX_DRIFT_PX = 6;
// Draw mode drops one arrow point per click, chaining point 1 -> point 2 ->
// point 3 etc.; a double-click (two clicks landing within this many ms, this
// close together on screen) finalizes the arrow at whatever point the first
// of that pair already added, rather than starting yet another segment.
const MODEL_FLOW_DRAW_DOUBLE_CLICK_MAX_MS = 400;
const MODEL_FLOW_DRAW_DOUBLE_CLICK_MAX_DRIFT_PX = 6;
// The traveling glow pulse loops over this period (scaled by the
// user-adjustable flowSpeedPercent — see setFlowSpeedPercent) and pads this
// many (base) sigmas past each end of the path, so it fades in/out via the
// comet's tail falloff instead of popping straight from invisible to full
// brightness at the loop. Sized with enough margin past the tail's own sigma
// (see FLOW_COMET_TAIL_SIGMA_MULT in the fragment shader) that its falloff
// is fully negligible by the time the pulse wraps — re-tune this alongside
// that constant, since a shorter/steeper tail needs proportionally less pad,
// and too little pad here pops visibly at the loop.
const FLOW_PULSE_PERIOD_BASE_MS = 3000;
const FLOW_PULSE_PAD_SIGMAS = 13;

let modelFlowDrawMode = false;
// cubeSizePercent at the moment draw mode was entered (see setModelFlowDraw)
// — while set, renderCubeFrame's camera-target "frame to fit" zoom goal uses
// this frozen value instead of the live cubeSizeScale, so scroll-to-zoom
// (which otherwise only feeds cubeSizeScale, exactly the term the frame-to-
// fit goal is built to cancel out — see zoomGoal's denominator) actually
// changes the on-screen size while tracing an arrow, instead of the spring
// yanking it straight back to the target's fitted framing every frame. Reset
// to null (and cubeSizePercent restored to this value) on leaving draw mode.
let drawModeZoomBaselinePercent = null;
let modelFlowSelectMode = false;
// While actively building one new (possibly multi-branch) arrow
// click-by-click, object-space: { points, pointObjectIndices, touchedObjects,
// startingJunction, completedBranches, pendingJunctions } — see
// finalizeModelFlowDrag/the draw-mode pointerdown handler for the
// shift+click-junction state machine.
let modelFlowDrag = null;
let modelFlowLastClickTime = null; // performance.now() of the last point-dropping click, for double-click-to-finish detection
let modelFlowLastClickPos = null; // { x, y } clientX/Y of that same click
// [{ points: [[x,y,z], ...], cumLen: number[], totalLen, sourceOffset,
// masterTotalLen }, ...] one entry per finalized branch (a single-branch
// arrow is just one entry; a branching one is several, sharing a junction
// point — see sourceOffset/masterTotalLen in finalizeModelFlowDrag).
let modelFlowPaths = [];
let selectedFlowArrowIndex = null; // index into modelFlowPaths, or null if nothing selected
let modelFlowSelectDownPos = null; // { x, y } clientX/Y at pointerdown, while in select mode — distinguishes a click from a drag
let showModelFlowArrow = false;
// Independent of showModelFlowArrow — lets the click-point/junction dots
// (see the draw-mode render block) be hidden on their own while the
// in-progress drag ribbon stays visible, or vice versa.
let showModelFlowPoints = true;
const modelFlowOverlayBuffer = gl.createBuffer(); // small, rebuilt-on-demand buffer for drawing the arrow guide ribbon

// Pivot indicator: a small yellow orb marking exactly what point drag/hover
// rotation and the "Model size" zoom pivot around (see getObjectSpacePan) —
// its object-space location moves with pan/camera-target, but (being the
// pivot) always projects to the same fixed on-screen point. Built the same
// way as the flow-arrow ribbon above (a flat NDC-space triangle list,
// projected on the CPU via the same projection*modelView `combined` matrix,
// so it respects the model's depth buffer instead of always drawing on
// top), just a small radial-gradient disc instead of a ribbon — that
// gradient (bright center fading to a darker gold edge) is what reads as a
// lit sphere rather than a flat dot, without needing an actual 3D mesh or a
// dedicated shader.
const PIVOT_ORB_RADIUS_PX = 5;
const PIVOT_ORB_SEGMENTS = 20;
const PIVOT_ORB_COLOR_CENTER = [1, 0.95, 0.55]; // bright yellow highlight
const PIVOT_ORB_COLOR_EDGE = [0.72, 0.52, 0.04]; // darker gold, fakes falloff toward the sphere's silhouette
const pivotOrbBuffer = gl.createBuffer();

// centerNDC is [x, y, z] already in NDC/clip space (see its call site —
// projected via `combined`, same as buildArrowRibbonNDC's ribbon points).
// Returns interleaved [x, y, z, r, g, b] vertices (unlike the ribbon's
// position-only buffer) since each vertex needs its own color for the
// center-to-edge gradient rather than one flat gl.vertexAttrib3f color.
// Factored out of buildPivotOrbNDC so buildPointMarkersNDC below (the
// flow-draw click-point dots) can reuse the same radial-gradient-disc
// geometry with its own radius/colors instead of the pivot's fixed gold.
// Returns a plain array (not yet a typed Float32Array) so multi-point
// callers can concatenate several discs cheaply before making one.
function buildOrbVertsNDC(centerNDC, canvasWidth, canvasHeight, radiusPx, colorCenter, colorEdge) {
  const halfW = canvasWidth / 2, halfH = canvasHeight / 2;
  const rx = radiusPx / halfW, ry = radiusPx / halfH;
  const [cx, cy, cz] = centerNDC;
  const verts = [];
  for (let i = 0; i < PIVOT_ORB_SEGMENTS; i++) {
    const a0 = (i / PIVOT_ORB_SEGMENTS) * Math.PI * 2;
    const a1 = ((i + 1) / PIVOT_ORB_SEGMENTS) * Math.PI * 2;
    verts.push(
      cx, cy, cz, ...colorCenter,
      cx + Math.cos(a0) * rx, cy + Math.sin(a0) * ry, cz, ...colorEdge,
      cx + Math.cos(a1) * rx, cy + Math.sin(a1) * ry, cz, ...colorEdge,
    );
  }
  return verts;
}

function buildPivotOrbNDC(centerNDC, canvasWidth, canvasHeight, radiusPx) {
  return new Float32Array(buildOrbVertsNDC(centerNDC, canvasWidth, canvasHeight, radiusPx, PIVOT_ORB_COLOR_CENTER, PIVOT_ORB_COLOR_EDGE));
}

// One small disc per placed point of the in-progress flow-arrow drag (see
// the draw-mode pointerdown handler), so a click's exact landing spot stays
// visible while the arrow is still being built — not just the ribbon
// connecting them. pointsObjectSpace/combined follow buildArrowRibbonNDC's
// convention: object-space points projected to NDC on the CPU via the same
// projection*modelView matrix used for the rest of the overlay.
function buildPointMarkersNDC(pointsObjectSpace, combined, canvasWidth, canvasHeight, radiusPx, colorCenter, colorEdge) {
  const verts = [];
  for (const p of pointsObjectSpace) {
    const px = combined[0] * p[0] + combined[4] * p[1] + combined[8] * p[2] + combined[12];
    const py = combined[1] * p[0] + combined[5] * p[1] + combined[9] * p[2] + combined[13];
    const pz = combined[2] * p[0] + combined[6] * p[1] + combined[10] * p[2] + combined[14];
    verts.push(...buildOrbVertsNDC([px, py, pz], canvasWidth, canvasHeight, radiusPx, colorCenter, colorEdge));
  }
  return new Float32Array(verts);
}

// Shared by every point/junction dot batch below (drag-in-progress and
// finalized alike) — builds the marker geometry and immediately draws it
// through modelFlowPointsBuffer. Assumes the caller already set up
// uLineModelView/uLineProjection (IDENTITY_MAT4) and enabled
// aLinePosition/aLineColor once for the whole stretch of batches.
function drawPointMarkerBatch(points, combined, radiusPx, colorCenter, colorEdge) {
  if (points.length === 0) return;
  const markers = buildPointMarkersNDC(points, combined, canvas.width, canvas.height, radiusPx, colorCenter, colorEdge);
  gl.bindBuffer(gl.ARRAY_BUFFER, modelFlowPointsBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, markers, gl.DYNAMIC_DRAW);
  gl.vertexAttribPointer(aLinePosition, 3, gl.FLOAT, false, 24, 0);
  gl.vertexAttribPointer(aLineColor, 3, gl.FLOAT, false, 24, 12);
  gl.drawArrays(gl.TRIANGLES, 0, markers.length / 6);
}

const MODEL_FLOW_POINT_RADIUS_PX = 12;
const MODEL_FLOW_POINT_COLOR_CENTER = [1, 1, 1]; // white highlight, reads clearly against the red guide ribbon
const MODEL_FLOW_POINT_COLOR_EDGE = [0.55, 0.55, 0.55];
// Junction points (see shift+click in the draw-mode pointerdown handler)
// render as their own, slightly larger dots instead of a plain white click
// point — red while still waiting on their second branch (see
// pendingJunctions), yellow once that branch is double-click finished (see
// closedJunctions) — so it's obvious at a glance which splits still need
// closing out before the whole arrow can finalize.
const MODEL_FLOW_JUNCTION_RADIUS_PX = MODEL_FLOW_POINT_RADIUS_PX * 1.35;
const MODEL_FLOW_JUNCTION_UNFINISHED_COLOR_CENTER = [1, 0.35, 0.3];
const MODEL_FLOW_JUNCTION_UNFINISHED_COLOR_EDGE = [0.7, 0.1, 0.05];
const MODEL_FLOW_JUNCTION_CLOSED_COLOR_CENTER = [1, 0.92, 0.3];
const MODEL_FLOW_JUNCTION_CLOSED_COLOR_EDGE = [0.75, 0.6, 0.05];
// The arrow's one true source/origin point (see sourceOffset === 0 in
// finalizeModelFlowDrag — the very first point of the very first branch,
// where the pulse actually starts) — an orange dot, distinct from the plain
// white points and red/yellow junctions.
const MODEL_FLOW_ORIGIN_RADIUS_PX = MODEL_FLOW_JUNCTION_RADIUS_PX;
const MODEL_FLOW_ORIGIN_COLOR_CENTER = [1, 0.55, 0.1];
const MODEL_FLOW_ORIGIN_COLOR_EDGE = [0.65, 0.3, 0.02];
// A finalized branch's own last point (where its arrowhead points) — its
// finishing point for the flow, per branch (a branching arrow has more than
// one). Blue, matching MODEL_FLOW_ARROW_COLOR's finished-arrow blue. Only
// meaningful once finalized (see the finished-arrows marker section) — an
// in-progress branch's last point can still be extended further, so it
// isn't a real "finish" yet.
const MODEL_FLOW_ENDPOINT_RADIUS_PX = MODEL_FLOW_JUNCTION_RADIUS_PX;
const MODEL_FLOW_ENDPOINT_COLOR_CENTER = [0.3, 0.55, 1];
const MODEL_FLOW_ENDPOINT_COLOR_EDGE = [0.1, 0.25, 0.7];
// Shared by all three marker draws below (plain click points, unfinished
// junctions, closed junctions) — each just re-uploads its own data into it
// right before its own draw call, so one buffer covers all of them.
const modelFlowPointsBuffer = gl.createBuffer();

// Floor guide: a dashed yellow line straight down (object-space Y=0 is the
// floor — see CUSTOM_MODEL_ROTATE_Y_RAD) from the pivot orb to the floor
// directly beneath/above it, showing how high off the ground the current
// pivot sits. Same color family as the orb; a plain flat color (not the
// orb's radial gradient) since a thin dashed line doesn't read as 3D shaded
// either way.
const PIVOT_FLOOR_LINE_COLOR = [1, 0.85, 0.15];
const PIVOT_FLOOR_LINE_HALF_WIDTH_PX = 1.25;
const PIVOT_FLOOR_DASH_LENGTH_PX = 6;
const PIVOT_FLOOR_DASH_GAP_PX = 5;
const pivotFloorLineBuffer = gl.createBuffer();

// Camera-target bounding-box overlay (see showCameraTargetBoxes): a light
// blue box drawn around every object currently assigned to one of the 3
// camera-target slots, rendered as real 3D geometry (uLineModelView/
// uLineProjection set to the actual modelView/cubeProjection, not the
// NDC-space identity trick the flow-arrow ribbon/pivot orb use above) so it
// sits correctly in the scene's depth buffer — occluded by the model like
// any other object instead of always drawing on top. Faces render at very
// low opacity (a volume tint) with the 12 edges drawn a second time, in the
// same buffer's line-mode counterpart, at a stronger opacity so the box's
// shape stays legible.
const CAMERA_TARGET_BOX_COLOR = [0.55, 0.78, 1]; // light blue
const CAMERA_TARGET_BOX_FILL_OPACITY = 0.1;
const CAMERA_TARGET_BOX_EDGE_OPACITY = 0.45;
const cameraTargetBoxFillBuffer = gl.createBuffer();
const cameraTargetBoxEdgeBuffer = gl.createBuffer();

// "Show target materials" overlay (see showTargetMaterials/isTargetMaterial):
// reveals the actual Target-material faces themselves — normally excluded
// from the opaque draw entirely (parseObj) — as a translucent purple fill,
// drawn through the same lineProgram/uLineAlpha path as the camera-target
// box above rather than the opaque cubeProgram (which has no alpha uniform).
const TARGET_MATERIAL_COLOR = [0.65, 0.25, 0.85]; // purple
const TARGET_MATERIAL_OPACITY = 0.5;
const TARGET_MATERIAL_EDGE_OPACITY = 0.9; // stronger than the fill so the wireframe reads clearly on top of it

// Builds the 6-face (12-triangle) fill geometry and 12-edge line geometry
// for one object's axis-aligned bounds (see parseObj's per-object `bounds`).
// Winding isn't meaningful here — the app never enables gl.CULL_FACE — so
// face vertex order just needs to trace out a simple quad, not a
// consistent outward normal.
function buildBoxGeometry(bounds) {
  const { minX, maxX, minY, maxY, minZ, maxZ } = bounds;
  const p000 = [minX, minY, minZ], p100 = [maxX, minY, minZ];
  const p110 = [maxX, maxY, minZ], p010 = [minX, maxY, minZ];
  const p001 = [minX, minY, maxZ], p101 = [maxX, minY, maxZ];
  const p111 = [maxX, maxY, maxZ], p011 = [minX, maxY, maxZ];
  const quads = [
    [p000, p100, p101, p001], // bottom
    [p010, p011, p111, p110], // top
    [p000, p010, p110, p100], // front
    [p001, p101, p111, p011], // back
    [p000, p001, p011, p010], // left
    [p100, p110, p111, p101], // right
  ];
  const fill = [];
  for (const [a, b, c, d] of quads) {
    fill.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  const edgePairs = [
    [p000, p100], [p100, p101], [p101, p001], [p001, p000], // bottom
    [p010, p011], [p011, p111], [p111, p110], [p110, p010], // top
    [p000, p010], [p100, p110], [p101, p111], [p001, p011], // verticals
  ];
  const edges = [];
  for (const [a, b] of edgePairs) edges.push(...a, ...b);
  return { fill: new Float32Array(fill), edges: new Float32Array(edges) };
}

// Dashes a straight object-space segment (pointA -> pointB) at a constant
// on-screen pixel dash/gap length regardless of zoom — same CPU-side
// projection + constant-pixel-width-ribbon technique as buildArrowRibbonNDC,
// simplified to a single already-straight segment (no per-point joints or
// arrowhead) and split into dash/gap steps along its own length instead of
// one continuous ribbon.
function buildDashedLineNDC(pointA, pointB, combined, canvasWidth, canvasHeight, halfWidthPx, dashPx, gapPx) {
  const halfW = canvasWidth / 2, halfH = canvasHeight / 2;
  const project = (p) => [
    combined[0] * p[0] + combined[4] * p[1] + combined[8] * p[2] + combined[12],
    combined[1] * p[0] + combined[5] * p[1] + combined[9] * p[2] + combined[13],
    combined[2] * p[0] + combined[6] * p[1] + combined[10] * p[2] + combined[14],
  ];
  const a = project(pointA), b = project(pointB);
  let dxPix = (b[0] - a[0]) * halfW, dyPix = (b[1] - a[1]) * halfH;
  const lenPix = Math.hypot(dxPix, dyPix) || 1;
  dxPix /= lenPix; dyPix /= lenPix;
  const nx = (-dyPix * halfWidthPx) / halfW, ny = (dxPix * halfWidthPx) / halfH;
  const verts = [];
  const stepPix = dashPx + gapPx;
  const steps = Math.ceil(lenPix / stepPix);
  for (let i = 0; i < steps; i++) {
    const startPix = i * stepPix;
    if (startPix >= lenPix) break;
    const endPix = Math.min(startPix + dashPx, lenPix);
    const t0 = startPix / lenPix, t1 = endPix / lenPix;
    const p0x = a[0] + (b[0] - a[0]) * t0, p0y = a[1] + (b[1] - a[1]) * t0, p0z = a[2] + (b[2] - a[2]) * t0;
    const p1x = a[0] + (b[0] - a[0]) * t1, p1y = a[1] + (b[1] - a[1]) * t1, p1z = a[2] + (b[2] - a[2]) * t1;
    verts.push(
      p0x - nx, p0y - ny, p0z,  p1x - nx, p1y - ny, p1z,  p0x + nx, p0y + ny, p0z,
      p0x + nx, p0y + ny, p0z,  p1x - nx, p1y - ny, p1z,  p1x + nx, p1y + ny, p1z,
    );
  }
  return new Float32Array(verts);
}

// Builds every drawn arrow as one combined ribbon of triangles with a
// constant on-screen pixel width, rather than gl.LINES — WebGL's line width
// is clamped to ~1px on most browsers/GPUs (the "width" argument to
// gl.lineWidth is widely ignored), so a hairline strip can never be made to
// look bigger; a ribbon is the only reliable way. Does the projection on the
// CPU instead of in the vertex shader: `combined` (projection * modelView)
// is exactly what the shader would apply, and since both factors are built
// from rotate/scale/translate and an orthographic projection — each with an
// implicit [0,0,0,1] last row — clip.w is always 1, so the projected xyz IS
// the NDC position with no perspective divide needed. That lets the offset
// below be computed directly in NDC/pixel space instead of guessing an
// object-space width that would look wrong at every zoom level. Per-segment
// quads (no mitered joints), and each arrow's segments are kept separate
// (no bridging quad between one arrow's last point and the next arrow's
// first) — fine for thin guide lines, and not worth the extra complexity for
// what's just a visual marker. Each path also gets a filled triangular
// arrowhead at its endpoint, pointing along the final segment's direction,
// so the arrow's direction of travel (start -> end) is visible at a glance
// instead of just an undirected line.
const MODEL_FLOW_ARROWHEAD_LENGTH_FACTOR = 4; // arrowhead tip-to-base length, as a multiple of halfWidthPx
const MODEL_FLOW_ARROWHEAD_HALF_WIDTH_FACTOR = 2.2; // arrowhead base half-width, as a multiple of halfWidthPx
// Triangle-fan resolution for the rounded start cap below — high enough
// that the semicircle reads as smooth rather than faceted at the ribbon's
// on-screen size (a few px radius), without pushing per-arrow vertex count
// up meaningfully.
const MODEL_FLOW_ARROW_CAP_SEGMENTS = 10;

// The ribbon quad below starts with a flat perpendicular edge at each
// path's first point (a plain "butt" cap) — fine for the far end, which
// already reads as pointed thanks to the arrowhead, but the near end read
// as a hard square-off. Fans a halfWidthPx semicircle of triangles around
// the first point instead, swept from the first segment's a1 side, back
// through the reverse-of-travel direction, to its a0 side — i.e. bulging
// away from the path rather than into it, so it just rounds off the
// existing quad's start edge instead of extending the ribbon's length.
function addRoundStartCap(verts, a, b, halfW, halfH, halfWidthPx) {
  let dxPix = (b[0] - a[0]) * halfW, dyPix = (b[1] - a[1]) * halfH;
  const lenPix = Math.hypot(dxPix, dyPix) || 1;
  dxPix /= lenPix; dyPix /= lenPix;
  const perpPixX = -dyPix * halfWidthPx, perpPixY = dxPix * halfWidthPx;
  const backPixX = -dxPix * halfWidthPx, backPixY = -dyPix * halfWidthPx;
  for (let k = 0; k < MODEL_FLOW_ARROW_CAP_SEGMENTS; k++) {
    const theta1 = (Math.PI * k) / MODEL_FLOW_ARROW_CAP_SEGMENTS;
    const theta2 = (Math.PI * (k + 1)) / MODEL_FLOW_ARROW_CAP_SEGMENTS;
    const p1x = perpPixX * Math.cos(theta1) + backPixX * Math.sin(theta1);
    const p1y = perpPixY * Math.cos(theta1) + backPixY * Math.sin(theta1);
    const p2x = perpPixX * Math.cos(theta2) + backPixX * Math.sin(theta2);
    const p2y = perpPixY * Math.cos(theta2) + backPixY * Math.sin(theta2);
    verts.push(
      a[0], a[1], a[2],
      a[0] + p1x / halfW, a[1] + p1y / halfH, a[2],
      a[0] + p2x / halfW, a[1] + p2y / halfH, a[2],
    );
  }
}

function buildArrowRibbonNDC(pathsPoints, combined, canvasWidth, canvasHeight, halfWidthPx) {
  const halfW = canvasWidth / 2, halfH = canvasHeight / 2;
  const arrowLengthPx = halfWidthPx * MODEL_FLOW_ARROWHEAD_LENGTH_FACTOR;
  const arrowHalfWidthPx = halfWidthPx * MODEL_FLOW_ARROWHEAD_HALF_WIDTH_FACTOR;
  const verts = [];
  for (const points of pathsPoints) {
    const ndcPoints = points.map((p) => [
      combined[0] * p[0] + combined[4] * p[1] + combined[8] * p[2] + combined[12],
      combined[1] * p[0] + combined[5] * p[1] + combined[9] * p[2] + combined[13],
      combined[2] * p[0] + combined[6] * p[1] + combined[10] * p[2] + combined[14],
    ]);
    if (ndcPoints.length >= 2) {
      addRoundStartCap(verts, ndcPoints[0], ndcPoints[1], halfW, halfH, halfWidthPx);
    }
    for (let i = 0; i < ndcPoints.length - 1; i++) {
      const a = ndcPoints[i], b = ndcPoints[i + 1];
      // Direction converted to actual pixels (NDC axes scaled independently
      // by the canvas's own half-width/half-height) so the perpendicular
      // offset reads as an isotropic pixel width even when the canvas isn't
      // square.
      let dxPix = (b[0] - a[0]) * halfW, dyPix = (b[1] - a[1]) * halfH;
      const lenPix = Math.hypot(dxPix, dyPix) || 1;
      dxPix /= lenPix; dyPix /= lenPix;
      const nx = (-dyPix * halfWidthPx) / halfW, ny = (dxPix * halfWidthPx) / halfH;
      const a0x = a[0] - nx, a0y = a[1] - ny;
      const a1x = a[0] + nx, a1y = a[1] + ny;
      const b0x = b[0] - nx, b0y = b[1] - ny;
      const b1x = b[0] + nx, b1y = b[1] + ny;
      verts.push(
        a0x, a0y, a[2],  b0x, b0y, b[2],  a1x, a1y, a[2],
        a1x, a1y, a[2],  b0x, b0y, b[2],  b1x, b1y, b[2],
      );

      // Arrowhead on the final segment only, built from the same
      // direction/perpendicular the ribbon quad above just used.
      if (i === ndcPoints.length - 2) {
        const backX = (dxPix * arrowLengthPx) / halfW, backY = (dyPix * arrowLengthPx) / halfH;
        const baseCx = b[0] - backX, baseCy = b[1] - backY;
        const wingX = (-dyPix * arrowHalfWidthPx) / halfW, wingY = (dxPix * arrowHalfWidthPx) / halfH;
        verts.push(
          b[0], b[1], b[2],
          baseCx - wingX, baseCy - wingY, b[2],
          baseCx + wingX, baseCy + wingY, b[2],
        );
      }
    }
  }
  return new Float32Array(verts);
}

// Builds a constant-pixel-width ribbon (2 triangles per segment) for a
// buildCreaseEdgeLines-style flat, disjoint segment list — same NDC-space
// technique as buildArrowRibbonNDC just above, minus the polyline/arrowhead
// handling this doesn't need, plus carrying each segment's own color through
// (buildCreaseEdgeLines/buildLineColors give every segment a single flat
// color across both its vertices, so one color per segment is enough; no
// per-vertex interpolation to preserve). CPU-side rather than a
// vertex-shader ribbon technique for simplicity — called every frame while
// photo mode's "Uniform wireframe line width" switch is on (live preview,
// not just the captured frame; see renderCubeFrame), so a model with a very
// large crease-edge wireframe (hundreds of thousands of edges) will feel the
// per-frame rebuild cost while the switch is on. If that ever shows up as a
// real slowdown, the fix is moving this to the vertex shader (bake each
// vertex's "other endpoint" + side into the geometry once at model load,
// let the shader do the pixel-width offset) instead of rebuilding on the
// CPU every frame — not attempted yet since it's a bigger change than this
// preview feature needed to start.
function buildLineRibbonNDC(positions, colors, combined, canvasWidth, canvasHeight, halfWidthPx) {
  const halfW = canvasWidth / 2, halfH = canvasHeight / 2;
  const segCount = positions.length / 6;
  const outPositions = new Float32Array(segCount * 18);
  const outColors = new Float32Array(segCount * 18);
  for (let s = 0; s < segCount; s++) {
    const o = s * 6;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const a = [
      combined[0] * ax + combined[4] * ay + combined[8] * az + combined[12],
      combined[1] * ax + combined[5] * ay + combined[9] * az + combined[13],
      combined[2] * ax + combined[6] * ay + combined[10] * az + combined[14],
    ];
    const b = [
      combined[0] * bx + combined[4] * by + combined[8] * bz + combined[12],
      combined[1] * bx + combined[5] * by + combined[9] * bz + combined[13],
      combined[2] * bx + combined[6] * by + combined[10] * bz + combined[14],
    ];
    let dxPix = (b[0] - a[0]) * halfW, dyPix = (b[1] - a[1]) * halfH;
    const lenPix = Math.hypot(dxPix, dyPix) || 1;
    dxPix /= lenPix; dyPix /= lenPix;
    const nx = (-dyPix * halfWidthPx) / halfW, ny = (dxPix * halfWidthPx) / halfH;
    const po = s * 18;
    outPositions.set([
      a[0] - nx, a[1] - ny, a[2],  b[0] - nx, b[1] - ny, b[2],  a[0] + nx, a[1] + ny, a[2],
      a[0] + nx, a[1] + ny, a[2],  b[0] - nx, b[1] - ny, b[2],  b[0] + nx, b[1] + ny, b[2],
    ], po);
    const cr = colors[o], cg = colors[o + 1], cb = colors[o + 2];
    for (let k = 0; k < 6; k++) {
      outColors[po + k * 3] = cr;
      outColors[po + k * 3 + 1] = cg;
      outColors[po + k * 3 + 2] = cb;
    }
  }
  return { positions: outPositions, colors: outColors };
}

// Rotates a vec3 the same way mat4RotateX/mat4RotateY would (see those
// functions) — used here to build the inverse camera transform for
// unprojecting a screen point into the model's object space.
function rotateXVec3(v, theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}
function rotateYVec3(v, theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

// Advances one axis of the camera-target spring by dt seconds using the
// closed-form solution of the damped-oscillator ODE (rather than stepping a
// numeric integrator like semi-implicit Euler). A numeric step's error is a
// function of dt, and rAF's per-frame dt jitters by a couple of ms even at a
// steady average fps (invisible to the FPS overlay, which only ever sees an
// average over its display window) — during the slow tail of the decel that
// jitter stops being negligible next to the shrinking real per-frame delta
// and reads as choppy motion despite fps looking fine. The closed form
// instead evaluates the exact position/velocity at time dt analytically, so
// any dt (however irregular) lands exactly on the true decay curve with no
// integration error to amplify. Both springs in this file (position and
// zoom) are configured overdamped (ratio ~1.16, see CAMERA_TARGET_SPRING_*
// comments) so only that branch is implemented — an underdamped/critical
// branch would be needed if a future spring here used ratio <= 1.
// Returns [newPosition, newVelocity]. stiffness/damping default to
// CAMERA_TARGET_SPRING_STIFFNESS/DAMPING (position's spring) — the zoom
// call in renderCubeFrame passes CAMERA_TARGET_ZOOM_SPRING_STIFFNESS/DAMPING
// instead, its own softer spring (see those constants' comment).
function stepSpring(position, velocity, goal, dt, stiffness = CAMERA_TARGET_SPRING_STIFFNESS, damping = CAMERA_TARGET_SPRING_DAMPING) {
  if (dt <= 0) return [position, velocity];
  const omega0 = Math.sqrt(stiffness);
  const zeta = damping / (2 * omega0);
  const y0 = position - goal; // offset from goal; the ODE is homogeneous in this frame
  const v0 = velocity;
  // Overdamped (zeta > 1): two real negative roots, y(t) = A*e^(r1*t) + B*e^(r2*t).
  const spread = omega0 * Math.sqrt(zeta * zeta - 1);
  const r1 = -zeta * omega0 + spread;
  const r2 = -zeta * omega0 - spread;
  const a = (v0 - y0 * r2) / (r1 - r2);
  const b = y0 - a;
  const e1 = Math.exp(r1 * dt);
  const e2 = Math.exp(r2 * dt);
  const y = a * e1 + b * e2;
  const newVelocity = a * r1 * e1 + b * r2 * e2;
  return [y + goal, newVelocity];
}

// Inverse of renderCubeFrame's modelView build (translate(ox,oy,oz) *
// rotateX(rx) * rotateY(ry) * translate(panX,panY,panZ) * scale(s)) applied
// to a single view-space point, undone in reverse order: un-translate(o),
// un-rotateX, un-rotateY, un-translate(pan), un-scale. The manual-pan
// translate sits *inside* the rotation (undone before un-scaling, after the
// rotations) rather than outside it — see getObjectSpacePan below for why.
function unprojectViewPointToObject(pv, rx, ry, s, ox, oy, oz, panX, panY, panZ) {
  const untranslated = [pv[0] - ox, pv[1] - oy, pv[2] - oz]; // inverse of mat4Translate(ox, oy, oz)
  const unrotatedX = rotateXVec3(untranslated, -rx);
  const unrotatedY = rotateYVec3(unrotatedX, -ry);
  const unpanned = [unrotatedY[0] - panX, unrotatedY[1] - panY, unrotatedY[2] - panZ]; // inverse of mat4Translate(panX, panY, panZ)
  return [unpanned[0] / s, unpanned[1] / s, unpanned[2] / s];
}

// Forward counterpart of unprojectViewPointToObject: scale, rotateY,
// rotateX (pre-translate) — used to find where an object-space point (e.g. a
// camera-target centroid) lands in view space, so renderCubeFrame can pan to
// center it regardless of the model's current rotation. Camera-target mode
// never combines with the manual object-space pan (see getObjectSpacePan),
// so this deliberately has no pan term of its own.
function projectObjectPointToView(p, rx, ry, s) {
  const scaled = [p[0] * s, p[1] * s, p[2] * s];
  const afterY = rotateYVec3(scaled, ry);
  return rotateXVec3(afterY, rx);
}

// Shared by renderCubeFrame and raycastGreenMesh so raycasting always
// unprojects through the exact same view-space offset the render pass drew
// with. Only ever nonzero for camera-target mode now (including while the
// spring is still settling back out of one, so a deactivated target eases
// back to screen-center instead of snapping) — locking a target to
// screen-center has to counteract whatever the *current* rotation does to
// it, which is exactly what this recomputes every call (rx/ry-dependent).
// Read-only: when a camera target is active, this reads cameraTargetCurrent's
// already-stepped position rather than advancing it — only renderCubeFrame's
// own per-frame tick does that (see the spring step in renderCubeFrame), so
// the motion stays tied to render frames rather than to how often a caller
// (e.g. pointermove during arrow-drawing) happens to ask for the offset.
function getCurrentCameraOffset(rx, ry, s) {
  const viewPoint = projectObjectPointToView(cameraTargetCurrent, rx, ry, s);
  // heroVerticalBias/scrollMobileVerticalBias (see their own comments) are
  // each 0 outside their one route-and-viewport-width combination — a
  // no-op everywhere else, including the tool build — and mutually
  // exclusive (IS_HERO and IS_SCROLL_ROUTE never both true), so summing
  // them is safe.
  return [-viewPoint[0], -viewPoint[1] + heroVerticalBias + scrollMobileVerticalBias];
}

// The manual "Model X/Y position" pan, plus the Z axis Space-drag alone
// drives (slider- or Space-drag-driven; see getModelViewOffset) — unlike
// getCurrentCameraOffset above, this is applied
// *inside* rotation (see renderCubeFrame/unprojectViewPointToObject), so it's
// rigid with the model instead of counteracting rotation: rotating (drag or
// hover) always pivots around the model's true center regardless of how far
// it's been panned, rather than the pivot itself drifting to wherever a
// post-rotation pan translate happened to place it. Suppressed while a
// camera target is active — that mode already owns centering via the offset
// above, and combining both would fight over the same screen position. Also
// suppressed until the spring settles back to rest (cameraTargetAtRest) so
// manual pan doesn't cut back in until the camera has actually finished
// easing back to screen-center, instead of jumping in partway through.
function getObjectSpacePan() {
  // While actively drawing, Space-drag panning (see the draw-mode
  // pointerdown/pointermove handling) needs to actually move the model even
  // with a camera target active — normally camera-target mode owns
  // centering outright and never combines with manual pan (see
  // getCurrentCameraOffset/projectObjectPointToView's own no-pan-term
  // comments), which is fine everywhere else, but would make Space-drag
  // panning silently do nothing during a drawing session started from a
  // target. The target's own outer offset (getCurrentCameraOffset) still
  // applies on top of this regardless, so panning moves you relative to
  // wherever the target's currently centered rather than replacing it.
  const targetOwnsCentering = !modelFlowDrawMode && (cameraTargetActiveIndex !== null || !cameraTargetAtRest);
  return targetOwnsCentering ? [0, 0, 0] : getModelViewOffset();
}

// Möller–Trumbore ray-triangle intersection. tris is a flat Float32Array of
// vertex triples (9 floats per triangle); offset picks which triangle.
// Returns the ray parameter t (distance along dir, dir need not be unit
// length) or null if the ray misses this triangle or hits behind the origin.
function rayTriangleIntersect(origin, dir, tris, offset) {
  const EPS = 1e-9;
  const ax = tris[offset], ay = tris[offset + 1], az = tris[offset + 2];
  const bx = tris[offset + 3], by = tris[offset + 4], bz = tris[offset + 5];
  const cx = tris[offset + 6], cy = tris[offset + 7], cz = tris[offset + 8];
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = dir[1] * e2z - dir[2] * e2y;
  const py = dir[2] * e2x - dir[0] * e2z;
  const pz = dir[0] * e2y - dir[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < EPS) return null;
  const invDet = 1 / det;
  const tx = origin[0] - ax, ty = origin[1] - ay, tz = origin[2] - az;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * invDet;
  if (v < 0 || u + v > 1) return null;
  const tHit = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return tHit > EPS ? tHit : null;
}

// Casts a ray from a screen point (clientX/clientY, as from a pointer event)
// through the orthographic camera into object space, and returns the
// nearest hit { point, objectIndex } on a green triangle, or null if it
// misses the green mesh entirely (drawing is deliberately restricted to
// green parts, since that's the only place the flow pulse can ever show).
// objectIndex (see parseObj's outObjectIndex/greenTriObjectIndexCache) lets
// the arrow-drawing tool track which named object(s) an arrow was actually
// drawn over, for per-arrow object filtering (setFlowArrowObjectEnabled).
function raycastGreenMesh(clientX, clientY) {
  if (!greenTriPositionsCache || greenTriPositionsCache.length === 0) return null;

  // CSS-space rect: with rendering now going straight into `canvas` (no
  // separate offscreen source/crop to map through — see updateCubeProjection
  // above), a pointer position converts to NDC directly, independent of
  // DPR or the canvas's actual backing-store resolution (renderScale).
  const rect = canvas.getBoundingClientRect();
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2; // canvas Y is down, NDC Y is up

  // s must match renderCubeFrame's exactly (including the eased camera-target
  // zoom multiplier) or raycasting drifts out of sync with what's on screen.
  const rx = cubeRotX + cubeParallaxX, ry = cubeRotY + cubeParallaxY, s = CUBE_SCALE * cubeSizeScale * cameraTargetZoomCurrent;
  const [ox, oy] = getCurrentCameraOffset(rx, ry, s);
  const [panX, panY, panZ] = getObjectSpacePan();
  const originView = [ndcX * cubeProjectionHalfX, ndcY * cubeProjectionHalfY, -0.1];
  const farView = [originView[0], originView[1], -50];
  const originObj = unprojectViewPointToObject(originView, rx, ry, s, ox, oy, cameraOffsetZ, panX, panY, panZ);
  const farObj = unprojectViewPointToObject(farView, rx, ry, s, ox, oy, cameraOffsetZ, panX, panY, panZ);
  const dir = [farObj[0] - originObj[0], farObj[1] - originObj[1], farObj[2] - originObj[2]];

  let bestT = Infinity, bestPoint = null, bestObjectIndex = -1;
  const tris = greenTriPositionsCache;
  for (let i = 0; i < tris.length; i += 9) {
    const t = rayTriangleIntersect(originObj, dir, tris, i);
    if (t !== null && t < bestT) {
      bestT = t;
      bestPoint = [originObj[0] + dir[0] * t, originObj[1] + dir[1] * t, originObj[2] + dir[2] * t];
      bestObjectIndex = greenTriObjectIndexCache[i / 9];
    }
  }
  return bestPoint ? { point: bestPoint, objectIndex: bestObjectIndex } : null;
}

// Nearest point on a 3D polyline to `point` — the 3D analogue of the 2D
// projectOntoPath used for image mode's flow cells. Returns both the arc
// length along the path and the squared distance to that nearest point, so
// callers juggling multiple candidate paths (see recomputeModelFlowCoords)
// can tell which path `point` actually sits closest to.
function nearestPointOnPath3D(path, point) {
  const { points, cumLen } = path;
  let bestDistSq = Infinity, bestArcLen = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const segLenSq = abx * abx + aby * aby + abz * abz || 1;
    const apx = point[0] - a[0], apy = point[1] - a[1], apz = point[2] - a[2];
    let t = (apx * abx + apy * aby + apz * abz) / segLenSq;
    t = Math.max(0, Math.min(1, t));
    const projx = a[0] + abx * t, projy = a[1] + aby * t, projz = a[2] + abz * t;
    const dx = point[0] - projx, dy = point[1] - projy, dz = point[2] - projz;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestArcLen = cumLen[i] + Math.sqrt(segLenSq) * t;
    }
  }
  return { arcLen: bestArcLen, distSq: bestDistSq };
}

// Raw (un-fudged) arc length of a polyline — unlike buildPathMetrics'
// totalLen, this doesn't floor a genuinely-zero length up to 1 (that floor
// exists purely so totalLen can be safely used as a division denominator
// elsewhere; a junction's sourceOffset below is a plain additive distance,
// where a floored zero would silently overcount).
function pathArcLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    len += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return len;
}

function buildPathMetrics(points) {
  const cumLen = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    cumLen.push(cumLen[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  return { points, cumLen, totalLen: cumLen[cumLen.length - 1] || 1 };
}

// Recomputes every green vertex's flow coordinate and re-uploads the fill's
// flow-coord buffer (the wireframe never carries the pulse, so it has no
// flow-coord buffer of its own). Each vertex is assigned to whichever of
// modelFlowPaths it's actually nearest to (see nearestPointOnPath3D) among
// those whose enabledObjectIndices includes the vertex's own object (see
// setFlowArrowObjectEnabled — lets one arrow drawn across several objects
// pulse only some of them), then stores its arc length *from that arrow's
// true source, normalized by masterTotalLen* — a 0-1 fraction rather than an
// absolute distance — so every arrow shares the same pulse timing/width
// regardless of how many arrows exist or how long each one is (see the
// flowSigma/flowPulseCenter math in renderCubeFrame, which is expressed in
// this same normalized space). sourceOffset/masterTotalLen (see
// finalizeModelFlowDrag) are what let a branching arrow's pulse actually
// travel from its one true source, through a junction, before splitting —
// each branch measures from the same source rather than restarting at 0 the
// moment it's nearest, which would make every branch light up from its own
// start at the very beginning of the cycle regardless of how far that
// branch actually sits from the source. Non-green vertices and vertices
// whose object has no eligible path at all get a negative sentinel
// (MODEL_FLOW_NO_ARROW_COORD) rather than 0 — see the fragment shader's
// `vFlowCoord >= 0.0` gate, which is what actually keeps the glow off those
// parts. Defaulting to a real 0 (a valid arc position) used to make every
// arrow-less part flash in sync whenever the traveling pulse passed the
// start of its cycle, since 0 looked exactly like "sitting at the start of
// some arrow".
// Called whenever an arrow is drawn/cleared/reconfigured and once after a
// model (re)loads a restored path.
function recomputeModelFlowCoords() {
  if (!customModelReady || !customModelPositionsCache) return;

  const vertexCount = customModelPositionsCache.length / 3;
  const flowCoords = new Float32Array(vertexCount).fill(MODEL_FLOW_NO_ARROW_COORD);
  // Parallel buffer: each vertex's chosen path's own masterTotalLen, carried
  // through unnormalized (see aFlowPathLen) so the fragment shader can undo
  // flowCoords' per-path normalization and measure the tail in absolute
  // world-space distance instead of a fraction of that one path's length.
  const flowPathLens = new Float32Array(vertexCount).fill(1);
  if (modelFlowPaths.length > 0) {
    for (let i = 0; i < vertexCount; i++) {
      if (!customModelIsGreenCache[i]) continue;
      const vertexObjectIndex = customModelObjectIndexCache[i];
      const p = [customModelPositionsCache[i * 3], customModelPositionsCache[i * 3 + 1], customModelPositionsCache[i * 3 + 2]];
      let bestFrac = MODEL_FLOW_NO_ARROW_COORD, bestDistSq = Infinity, bestMasterTotalLen = 1;
      for (const path of modelFlowPaths) {
        if (path.enabledObjectIndices && !path.enabledObjectIndices.includes(vertexObjectIndex)) continue;
        const { arcLen, distSq } = nearestPointOnPath3D(path, p);
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          const masterTotalLen = path.masterTotalLen || path.totalLen;
          bestFrac = masterTotalLen > 0 ? ((path.sourceOffset || 0) + arcLen) / masterTotalLen : 0;
          bestMasterTotalLen = masterTotalLen || 1;
        }
      }
      flowCoords[i] = bestFrac;
      flowPathLens[i] = bestMasterTotalLen;
    }
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, customModelFlowCoordBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, flowCoords, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, customModelFlowPathLenBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, flowPathLens, gl.STATIC_DRAW);
}

function saveModelFlowPath() {
  if (IS_BATTERY_ROUTE) return;
  if (modelFlowPaths.length > 0) {
    localStorage.setItem(
      MODEL_FLOW_STORAGE_KEY,
      JSON.stringify(modelFlowPaths.map((path) => ({
        points: path.points,
        touchedObjectIndices: path.touchedObjectIndices,
        enabledObjectIndices: path.enabledObjectIndices,
        sourceOffset: path.sourceOffset,
        masterTotalLen: path.masterTotalLen,
      }))),
    );
  } else {
    localStorage.removeItem(MODEL_FLOW_STORAGE_KEY);
  }
}

function clearModelFlowPath() {
  modelFlowPaths = [];
  modelFlowDrag = null;
  selectedFlowArrowIndex = null;
  saveModelFlowPath();
  recomputeModelFlowCoords();
  notifyModelState();
}

// Shared by restoreModelFlowPath and applyDefaultModelFlowPath below: turns
// saveModelFlowPath's serialized shape (points/touchedObjectIndices/
// enabledObjectIndices/sourceOffset/masterTotalLen) back into real
// modelFlowPaths entries, preserving each entry's own sourceOffset/
// masterTotalLen instead of resetting them — so a multi-branch (junction)
// arrow keeps its branches' pulse timing relative to their true shared
// source rather than every branch restarting at 0.
function buildModelFlowPathsFromData(dataArray) {
  return dataArray.map((data) => {
    const metrics = buildPathMetrics(data.points);
    return {
      ...metrics,
      touchedObjectIndices: data.touchedObjectIndices,
      enabledObjectIndices: data.enabledObjectIndices,
      sourceOffset: data.sourceOffset || 0,
      masterTotalLen: data.masterTotalLen || metrics.totalLen,
      reversed: false,
    };
  });
}

// Restores whatever arrow set saveModelFlowPath last persisted for the
// bundled model, exactly as drawn — called by loadBundledDefaultModel
// *before* it falls back to applyDefaultModelFlowPath, so a locally-drawn
// arrow survives a reload instead of always being replaced by the (often
// empty) baked-in default. Returns whether it actually found and applied
// something.
function restoreModelFlowPath() {
  const raw = localStorage.getItem(MODEL_FLOW_STORAGE_KEY);
  if (!raw) return false;
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(saved) || saved.length === 0) return false;
  modelFlowPaths = buildModelFlowPathsFromData(saved);
  modelFlowDrag = null;
  selectedFlowArrowIndex = null;
  recomputeModelFlowCoords();
  notifyModelState();
  return true;
}

// Installs DEFAULT_MODEL_FLOW_PATH_DATA as the current arrow set — used in
// place of clearModelFlowPath() right after the bundled model loads, so
// startup shows a pulsing arrow instead of a blank green mesh.
function applyDefaultModelFlowPath() {
  modelFlowPaths = buildModelFlowPathsFromData(DEFAULT_MODEL_FLOW_PATH_DATA);
  modelFlowDrag = null;
  selectedFlowArrowIndex = null;
  saveModelFlowPath();
  recomputeModelFlowCoords();
  notifyModelState();
}

// While an arrow is mid-drag (points placed click-by-click, not yet
// finalized — see the draw-mode pointerdown handler), undo drops just the
// last placed point instead of the whole arrow, so a stray click can be
// walked back one step at a time without losing everything drawn so far.
// Two ways this can hand a junction back to pendingJunctions rather than
// losing it (see hasOpenJunction — only one junction can be open at a time,
// so undo re-opening one is also what allows a fresh shift+click again):
//  - popping the point that's still awaiting its explicitly-resumed branch
//    (shift-clicked but never resumed yet) drops it out of pendingJunctions
//    directly;
//  - popping the current branch down to nothing when it's itself that
//    explicitly-resumed branch (isResumedFromPending — started at the
//    junction, never got any point past that seed) re-queues that same
//    junction instead of silently discarding it.
// A third case — undoing away the *automatic continuation* a shift+click
// creates (isResumedFromPending false but startingJunction set) — removes
// the junction from pendingJunctions instead of re-adding it: that branch
// never popped it off in the first place (see the pointerdown handler), so
// undoing it away means undoing the split itself, not offering it for
// another resume.
// Once the current branch empties out with no junction of its own to
// restore, undo walks back into the previous branch this session already
// closed off (see completedBranches/closeCurrentBranchIntoCompleted),
// reopening it for further undo. Only once there's neither a current branch
// nor any completed one left this session does undo fall back to dropping
// the most recently finalized arrow.
function undoLastModelFlowArrow() {
  if (modelFlowDrag && modelFlowDrag.points.length > 0) {
    const poppedPoint = modelFlowDrag.points.pop();
    modelFlowDrag.pointObjectIndices.pop();
    modelFlowDrag.touchedObjects = new Set(modelFlowDrag.pointObjectIndices);
    const pendingIndex = modelFlowDrag.pendingJunctions.findIndex((j) => j.point === poppedPoint);
    if (pendingIndex !== -1) modelFlowDrag.pendingJunctions.splice(pendingIndex, 1);
    // Undoing back down to just the junction's own seed point un-commits the
    // resumed branch — it turns red again (see the pointerdown handler's
    // "grew past the seed" check, which is what turned it yellow).
    if (modelFlowDrag.points.length === 1 && modelFlowDrag.isResumedFromPending && modelFlowDrag.startingJunction) {
      const closedIndex = modelFlowDrag.closedJunctions.indexOf(modelFlowDrag.startingJunction);
      if (closedIndex !== -1) modelFlowDrag.closedJunctions.splice(closedIndex, 1);
    }
    if (modelFlowDrag.points.length === 0) {
      if (modelFlowDrag.startingJunction) {
        if (modelFlowDrag.isResumedFromPending) {
          // This now-empty branch was the explicitly-resumed one (started at
          // the junction, undone away before it grew any further) — put the
          // junction back rather than dropping it.
          modelFlowDrag.pendingJunctions.push(modelFlowDrag.startingJunction);
        } else {
          // This now-empty branch was the automatic continuation a
          // shift+click creates alongside its junction (see the pointerdown
          // handler) — that junction is still sitting in pendingJunctions
          // from that same click, so undoing this branch away undoes the
          // split itself: remove it again instead of duplicating it.
          const idx = modelFlowDrag.pendingJunctions.indexOf(modelFlowDrag.startingJunction);
          if (idx !== -1) modelFlowDrag.pendingJunctions.splice(idx, 1);
        }
      }
      if (modelFlowDrag.completedBranches.length > 0) {
        const prev = modelFlowDrag.completedBranches.pop();
        modelFlowDrag.points = prev.points;
        modelFlowDrag.pointObjectIndices = prev.pointObjectIndices;
        modelFlowDrag.touchedObjects = prev.touchedObjects;
        modelFlowDrag.startingJunction = prev.startingJunction;
        modelFlowDrag.isResumedFromPending = prev.isResumedFromPending;
        modelFlowDrag.branchSourceOffset = prev.sourceOffset;
        if (prev.startingJunction && prev.isResumedFromPending) {
          modelFlowDrag.pendingJunctions.push(prev.startingJunction);
          // Un-completing this branch reopens the junction it closed — back
          // to red (see closedJunctions' rendering) until it's redrawn.
          const closedIndex = modelFlowDrag.closedJunctions.indexOf(prev.startingJunction);
          if (closedIndex !== -1) modelFlowDrag.closedJunctions.splice(closedIndex, 1);
        }
      } else {
        modelFlowDrag = null;
      }
      modelFlowLastClickTime = null;
      modelFlowLastClickPos = null;
    }
    notifyModelState();
    return;
  }
  if (modelFlowPaths.length === 0) return;
  modelFlowPaths.pop();
  // The removed arrow was always the last index — if that's what was
  // selected, the selection no longer points at anything; earlier indices
  // are unaffected and stay valid.
  if (selectedFlowArrowIndex === modelFlowPaths.length) selectedFlowArrowIndex = null;
  saveModelFlowPath();
  recomputeModelFlowCoords();
  notifyModelState();
}

// Drops whichever arrow is currently selected (see setModelFlowSelectMode /
// the select-mode click handler below).
function deleteSelectedModelFlowArrow() {
  if (selectedFlowArrowIndex === null) return;
  modelFlowPaths.splice(selectedFlowArrowIndex, 1);
  selectedFlowArrowIndex = null;
  saveModelFlowPath();
  recomputeModelFlowCoords();
  notifyModelState();
}

// Flips which end of the currently-selected branch the flow travels toward
// — reversing the points array (and rebuilding cumLen/totalLen from it) is
// all that's needed: buildArrowRibbonNDC always draws its arrowhead at the
// *last* point, so it now points the other way automatically, and
// recomputeModelFlowCoords's arc length is now measured from the opposite
// end too. sourceOffset/masterTotalLen are deliberately left untouched —
// they still anchor this branch's timing to the same physical distance
// range from the arrow's true source (see finalizeModelFlowDrag), just with
// the two ends' timing swapped, which is what makes the reversed branch
// still meet its junction (if any) as part of the same pulse cycle rather
// than running on its own unrelated schedule.
function reverseSelectedFlowArrow() {
  if (selectedFlowArrowIndex === null) return;
  const path = modelFlowPaths[selectedFlowArrowIndex];
  if (!path) return;
  path.points.reverse();
  const metrics = buildPathMetrics(path.points);
  path.cumLen = metrics.cumLen;
  path.totalLen = metrics.totalLen;
  path.reversed = !path.reversed;
  saveModelFlowPath();
  recomputeModelFlowCoords();
  notifyModelState();
}

// Toggles whether the currently-selected arrow's pulse applies to one of the
// objects it was drawn over — lets one arrow spanning several objects (e.g.
// its screen-space path crosses from one green part onto an adjacent one)
// pulse only some of them. objectIndex must be one of that arrow's own
// touchedObjectIndices (see finalizeModelFlowDrag below); the
// panel only ever offers those as choices.
function setFlowArrowObjectEnabled(objectIndex, enabled) {
  if (selectedFlowArrowIndex === null) return;
  const path = modelFlowPaths[selectedFlowArrowIndex];
  if (!path) return;
  const has = path.enabledObjectIndices.includes(objectIndex);
  if (enabled && !has) path.enabledObjectIndices.push(objectIndex);
  else if (!enabled && has) path.enabledObjectIndices = path.enabledObjectIndices.filter((i) => i !== objectIndex);
  saveModelFlowPath();
  recomputeModelFlowCoords();
  notifyModelState();
}

function setModelFlowDraw(value) {
  modelFlowDrawMode = value;
  // Drawing and selecting are mutually exclusive — both interpret a canvas
  // click differently (start a new arrow vs. pick an existing one), so
  // enabling one turns off the other.
  if (value) {
    modelFlowSelectMode = false;
    selectedFlowArrowIndex = null;
    // Otherwise a new arrow could be traced without ever seeing the ones
    // already drawn (e.g. right after loading a model with "Show flow
    // arrows" still off) — drawing needs them visible to trace against.
    showModelFlowArrow = true;
    // Start every drawing session from a clean, centered, default-angle
    // view — same as holding Space does — since panned off-center or held
    // at a leftover angle makes tracing a path accurately onto the green
    // surface harder than it needs to be. Also drops any active Camera
    // Target (relevant on the /scroll route, where renderCubeFrame's own
    // IS_SCROLL_ROUTE branch excludes draw mode — see its condition — and
    // falls back to the plain spring branch below it, which reads this) so
    // the camera centers on the model itself rather than staying locked onto
    // whichever target the scroll position last landed on.
    cameraTargetActiveIndex = null;
    resetModelPosition();
    resetCubeRotation();
    // Freezes the camera-target frame-to-fit zoom goal at today's "Model
    // size" (see drawModeZoomBaselinePercent/zoomGoal in renderCubeFrame) so
    // scroll-to-zoom actually moves the view instead of being cancelled out
    // frame-to-frame.
    drawModeZoomBaselinePercent = cubeSizePercent;
  } else {
    // Leaving draw mode snaps back to the framed default angle and locks
    // rotation again, same as a fresh page load. Also drop any arrow that
    // was still being built click-by-click and never got double-clicked to
    // finish — otherwise it'd sit around, invisible (not yet in
    // modelFlowPaths), until a later drawing session picked it back up.
    modelFlowDrag = null;
    modelFlowLastClickTime = null;
    modelFlowLastClickPos = null;
    // Mirrors the force-on above — draw mode is what turned this on, so
    // leaving it turns it back off rather than leaving arrows on-screen
    // after the user's done drawing.
    showModelFlowArrow = false;
    resetCubeRotation();
    setRotationDisabled(true);
    // Restores whatever zoom was in effect right before draw mode started
    // (undoing any scroll-to-zoom from mid-session) and lets the
    // camera-target frame-to-fit goal track cubeSizeScale live again.
    if (drawModeZoomBaselinePercent !== null) {
      setCubeSizePercent(drawModeZoomBaselinePercent);
      drawModeZoomBaselinePercent = null;
    }
  }
  notifyModelState();
}

// See setModelFlowDraw above re: mutual exclusivity with draw mode.
function setModelFlowSelectMode(value) {
  modelFlowSelectMode = value;
  if (value) {
    modelFlowDrawMode = false;
  } else {
    selectedFlowArrowIndex = null;
  }
  notifyModelState();
}

function setModelFlowArrowVisible(value) {
  showModelFlowArrow = value;
}

function setModelFlowPointsVisible(value) {
  showModelFlowPoints = value;
}

// Suppress the browser's right-click menu while drawing so right-drag reads
// as a rotate gesture instead of popping up a context menu mid-drag.
if (!IS_HERO) {
canvas.addEventListener('contextmenu', (event) => {
  if (modelFlowDrawMode) event.preventDefault();
});
} // end if (!IS_HERO) — flow-draw contextmenu suppression

// Pushes the current branch onto completedBranches, provided it has the 2+
// points needed to form a real line — a lone point (e.g. a junction that
// was itself the very first click ever) is simply dropped instead of
// producing a degenerate zero-length branch. Shared by finalizeModelFlowDrag
// (a real double-click finish) and the shift+click handler below (which
// closes off the current branch immediately, right at the new junction,
// rather than waiting for a double-click — see its own comment for why).
function closeCurrentBranchIntoCompleted(drag) {
  if (drag.points.length < 2) return;
  drag.completedBranches.push({
    points: drag.points,
    pointObjectIndices: drag.pointObjectIndices,
    touchedObjects: drag.touchedObjects,
    startingJunction: drag.startingJunction,
    isResumedFromPending: drag.isResumedFromPending,
    sourceOffset: drag.branchSourceOffset,
  });
}

// Double-click-to-finish (see the draw-mode pointerdown handler below):
// closes off whichever branch is currently being built click-by-click (see
// closeCurrentBranchIntoCompleted). If a shift-clicked junction is still
// waiting on its second (explicitly resumed) branch — see hasOpenJunction,
// an arrow can have any number of junctions but only one open/uncommitted at
// a time — drawing resumes from it instead of finishing for good. Only once
// every junction from this session is closed does the whole session's
// branches all become real, independent entries in modelFlowPaths — a
// branch simply sharing its start point with whatever it split from is what
// reads as the flow splitting in two there, so no other code
// (buildPathMetrics/recomputeModelFlowCoords/buildArrowRibbonNDC/rendering/
// save-load) needs to know branching exists at all.
function finalizeModelFlowDrag() {
  if (!modelFlowDrag) return;
  closeCurrentBranchIntoCompleted(modelFlowDrag);
  if (modelFlowDrag.pendingJunctions.length > 0) {
    const junction = modelFlowDrag.pendingJunctions.pop();
    modelFlowDrag.points = [junction.point];
    modelFlowDrag.pointObjectIndices = [junction.objectIndex];
    modelFlowDrag.touchedObjects = new Set([junction.objectIndex]);
    modelFlowDrag.startingJunction = junction;
    modelFlowDrag.isResumedFromPending = true;
    modelFlowDrag.branchSourceOffset = junction.sourceOffset;
    // Otherwise the click that resumes the new branch (right where the
    // finishing double-click just landed) could itself read as another
    // double-click and immediately re-finish a 1-point branch.
    modelFlowLastClickTime = null;
    modelFlowLastClickPos = null;
    notifyModelState();
    return;
  }
  // Every branch's flow coordinate is measured from the one true source (see
  // sourceOffset/branchSourceOffset above), not restarted at 0 per branch —
  // so the pulse only actually reaches a junction, and splits into its
  // branches, once it's traveled the real distance there. masterTotalLen
  // (shared by every branch from this arrow) is set by whichever branch
  // reaches farthest from the source, so a full 0-1 pulse cycle corresponds
  // to the flow crossing the arrow's single longest source-to-end distance;
  // shorter branches simply go dark once the pulse passes their own (nearer)
  // endpoint, which is exactly what a "finishing point" means with more than
  // one of them.
  let masterTotalLen = 0;
  for (const branch of modelFlowDrag.completedBranches) {
    masterTotalLen = Math.max(masterTotalLen, branch.sourceOffset + pathArcLength(branch.points));
  }
  for (const branch of modelFlowDrag.completedBranches) {
    const path = buildPathMetrics(branch.points);
    // Every object a click actually raycasted onto — the pulse applies to
    // all of them by default (see setFlowArrowObjectEnabled for narrowing
    // this down to just some of them after the fact).
    path.touchedObjectIndices = [...branch.touchedObjects];
    path.enabledObjectIndices = [...branch.touchedObjects];
    path.sourceOffset = branch.sourceOffset;
    path.masterTotalLen = masterTotalLen || 1;
    path.reversed = false; // see reverseSelectedFlowArrow
    modelFlowPaths.push(path);
  }
  if (modelFlowDrag.completedBranches.length > 0) {
    saveModelFlowPath();
    recomputeModelFlowCoords();
  }
  modelFlowDrag = null;
  modelFlowLastClickTime = null;
  modelFlowLastClickPos = null;
  notifyModelState();
}

if (!IS_HERO) {
canvas.addEventListener('pointerdown', (event) => {
  if (!blueprintEnabled) return;
  if (modelFlowSelectMode) {
    modelFlowSelectDownPos = { x: event.clientX, y: event.clientY };
    event.stopPropagation();
    return;
  }
  if (!modelFlowDrawMode) return;
  if (spaceHeld) return; // panning instead (see the other pointerdown handler's spaceHeld check)
  if (event.button !== 0) return; // right button rotates instead (see the other pointerdown handler)
  const hit = raycastGreenMesh(event.clientX, event.clientY);
  if (!hit) return;
  event.stopPropagation();
  const now = performance.now();
  // A second click landing quickly and in nearly the same screen spot as the
  // previous one is read as "double-click to finish here" rather than
  // "add another point" — the point it's finishing at was already added by
  // the first click of that pair, so this one only finalizes.
  if (
    modelFlowDrag &&
    modelFlowLastClickTime !== null &&
    now - modelFlowLastClickTime <= MODEL_FLOW_DRAW_DOUBLE_CLICK_MAX_MS &&
    Math.hypot(event.clientX - modelFlowLastClickPos.x, event.clientY - modelFlowLastClickPos.y) <= MODEL_FLOW_DRAW_DOUBLE_CLICK_MAX_DRIFT_PX
  ) {
    finalizeModelFlowDrag();
    return;
  }
  if (!modelFlowDrag) {
    modelFlowDrag = {
      points: [hit.point],
      pointObjectIndices: [hit.objectIndex],
      touchedObjects: new Set([hit.objectIndex]),
      // Which junction (if any) this current branch starts at — null for the
      // session's very first branch (see isResumedFromPending for the two
      // ways a branch can end up starting at one). Carried onto
      // completedBranches (see closeCurrentBranchIntoCompleted) so undo can
      // restore it if the user un-draws all the way back past it.
      startingJunction: null,
      // Whether startingJunction (if set) came from explicitly resuming a
      // queued split (popped off pendingJunctions in finalizeModelFlowDrag —
      // "Branch 3"/"Branch 4" in a junction-then-junction diagram) versus
      // being the automatic continuation created the instant its junction
      // was shift-clicked (see the shift+click handling below — "Branch
      // 2" in that same diagram: it still starts at a junction, but was
      // never actually popped off pendingJunctions). Matters for exactly two
      // things: only a resumed branch growing past its seed closes its
      // junction (see the "grew past the seed" check below — the automatic
      // continuation isn't the side that resolves the split), and undo needs
      // to know whether to push the junction back onto pendingJunctions or
      // just remove it again (see undoLastModelFlowArrow).
      isResumedFromPending: false,
      // Cumulative arc length from the whole arrow's true source (the very
      // first point of its first branch) to this branch's own start point —
      // 0 for the first branch, or a junction's own sourceOffset when
      // starting at one (see finalizeModelFlowDrag/the shift+click handling
      // below). Lets every branch's flow coordinate be measured from the one
      // true source rather than restarting at 0, so the traveling pulse only
      // reaches a junction (and splits into its branches) once it's actually
      // traveled there — see masterTotalLen in
      // finalizeModelFlowDrag/recomputeModelFlowCoords.
      branchSourceOffset: 0,
      // Branches already closed off this session (see
      // closeCurrentBranchIntoCompleted) but not yet pushed to
      // modelFlowPaths — held back until every junction closes (see
      // finalizeModelFlowDrag/pendingJunctions).
      completedBranches: [],
      // At most one entry at a time — only one junction can be open
      // (awaiting its second, explicitly-resumed branch) at once, so each
      // one still only ever splits two ways — but the session can work
      // through any number of them sequentially, since a new shift+click is
      // allowed again as soon as the previous one closes (see
      // hasOpenJunction below). Kept as an array (rather than a single
      // nullable field) since finalizeModelFlowDrag/undoLastModelFlowArrow
      // already just push/pop/splice it either way.
      pendingJunctions: [],
      // Every junction from this session whose explicitly-resumed branch has
      // since grown past its seed point (see the "grew past the seed" check
      // below) — rendered as a yellow dot instead of pendingJunctions' red.
      // Purely a display concern.
      closedJunctions: [],
    };
  } else {
    modelFlowDrag.points.push(hit.point);
    modelFlowDrag.pointObjectIndices.push(hit.objectIndex);
    modelFlowDrag.touchedObjects.add(hit.objectIndex);
    // The current branch just grew past its junction seed point (i.e. this
    // is the resumed branch's first real point, not just the auto-seeded
    // junction itself) — the junction is committed to now, so it turns
    // yellow immediately rather than waiting for this branch to be
    // double-click finished (see closedJunctions' rendering). Scoped to
    // isResumedFromPending: the automatic continuation created alongside a
    // brand-new junction (see below) also starts at 1 point and would
    // otherwise trip this same check the moment it gets its own next click —
    // but that's not the side that resolves the split, its sibling branch is.
    if (modelFlowDrag.isResumedFromPending && modelFlowDrag.startingJunction && modelFlowDrag.points.length === 2 && !modelFlowDrag.closedJunctions.includes(modelFlowDrag.startingJunction)) {
      modelFlowDrag.closedJunctions.push(modelFlowDrag.startingJunction);
    }
  }
  // Shift+click makes the just-placed point a junction — and, unlike a plain
  // click, closes off the branch here immediately (see
  // closeCurrentBranchIntoCompleted) rather than letting it keep going
  // through the junction: a branch is only ever the stretch between one
  // junction (or the true source) and wherever it next ends, whether that's
  // an arrowhead or another junction — never a through-line straddling one.
  // A fresh branch then starts right away at this same point (the
  // "automatic continuation" — whatever's clicked next), while the junction
  // itself is queued in pendingJunctions for its second, explicitly-resumed
  // branch once the continuation is eventually finished (see
  // finalizeModelFlowDrag). Only allowed while no other junction from this
  // session is still open (pending, or resumed but not yet grown past its
  // seed point) — once one closes (turns yellow), a fresh shift+click can
  // open the next one, so one arrow can carry any number of splits, just
  // never two unresolved at once.
  const hasOpenJunction =
    modelFlowDrag.pendingJunctions.length > 0 ||
    (modelFlowDrag.startingJunction && !modelFlowDrag.closedJunctions.includes(modelFlowDrag.startingJunction));
  if (event.shiftKey && !hasOpenJunction) {
    // sourceOffset: how far the true source is from *this* point — the
    // current branch's own offset plus the arc length walked within this
    // branch so far (points already includes the just-placed point above).
    const sourceOffset = modelFlowDrag.branchSourceOffset + pathArcLength(modelFlowDrag.points);
    const junction = { point: hit.point, objectIndex: hit.objectIndex, sourceOffset };
    closeCurrentBranchIntoCompleted(modelFlowDrag);
    modelFlowDrag.points = [junction.point];
    modelFlowDrag.pointObjectIndices = [junction.objectIndex];
    modelFlowDrag.touchedObjects = new Set([junction.objectIndex]);
    modelFlowDrag.startingJunction = junction;
    modelFlowDrag.isResumedFromPending = false;
    modelFlowDrag.branchSourceOffset = junction.sourceOffset;
    modelFlowDrag.pendingJunctions.push(junction);
  }
  modelFlowLastClickTime = now;
  modelFlowLastClickPos = { x: event.clientX, y: event.clientY };
});
} // end if (!IS_HERO) — flow-draw/select pointerdown

// Read by renderCubeFrame's rubber-band preview (always active) — declared
// here, outside the `if (!IS_HERO)` guards, so it stays in scope regardless
// of build; only ever set non-null by the gated pointermove listener below.
let modelFlowHoverClientPos = null;

if (!IS_HERO) {
// Rubber-band preview: while a branch is mid-drag, renderCubeFrame draws a
// dashed line from the last placed point out to wherever the cursor
// currently raycasts onto the green mesh — showing where the next click
// would land before it's actually confirmed. raycastGreenMesh linearly
// scans every green triangle, so it's deliberately NOT run per mousemove
// event (which can fire far faster than the display refreshes) — this just
// records the latest client position cheaply, and renderCubeFrame raycasts
// it at most once per rendered frame, see modelFlowHoverClientPos below.
canvas.addEventListener('pointermove', (event) => {
  modelFlowHoverClientPos = modelFlowDrawMode && modelFlowDrag ? { x: event.clientX, y: event.clientY } : null;
});
canvas.addEventListener('pointerleave', () => {
  modelFlowHoverClientPos = null;
});
window.addEventListener('pointerup', (event) => {
  if (modelFlowSelectDownPos) {
    const dx = event.clientX - modelFlowSelectDownPos.x, dy = event.clientY - modelFlowSelectDownPos.y;
    modelFlowSelectDownPos = null;
    // A drag beyond the click threshold isn't a selection attempt (e.g. the
    // pointer merely slipped while clicking) — leave whatever was selected
    // alone rather than guessing.
    if (Math.hypot(dx, dy) > MODEL_FLOW_SELECT_CLICK_MAX_DRIFT_PX) return;
    const hit = raycastGreenMesh(event.clientX, event.clientY);
    let newIndex = null;
    let bestDistSq = Infinity;
    if (hit) {
      modelFlowPaths.forEach((path, i) => {
        const { distSq } = nearestPointOnPath3D(path, hit.point);
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          newIndex = i;
        }
      });
      // Too far from every arrow — treat as clicking empty space, not a
      // selection of "whatever happened to be nearest."
      if (bestDistSq > MODEL_FLOW_SELECT_MAX_DIST * MODEL_FLOW_SELECT_MAX_DIST) newIndex = null;
    }
    selectedFlowArrowIndex = newIndex;
    notifyModelState();
  }
  // Arrow points are now dropped on click (pointerdown) and finalized on
  // double-click, both handled in the pointerdown listener above — pointerup
  // has nothing left to do for draw mode itself.
});
} // end if (!IS_HERO) — flow-draw rubber-band preview + select pointerup

// Bottom-right axis gizmo: a small always-visible indicator of which way
// object-space X/Y/Z currently point on screen, so panning/rotating (drag,
// hover parallax, R, Space's bird's-eye view, camera targets — anything
// that changes rx/ry) doesn't leave the user guessing which axis is which.
// A separate plain-2D canvas (see #axis-gizmo in index.html) rather than
// squeezing a scissored sub-viewport into the main WebGL canvas — much
// simpler to get text labels and line styling right, and precedented by
// #perf-history just above doing the same thing for the FPS sparkline.
// Reuses rotateXVec3/rotateYVec3 (see unprojectViewPointToObject above) with
// the exact same rotation order renderCubeFrame's modelView applies
// (Y then X) so the gizmo's orientation always matches the model's.
// #axis-gizmo doesn't exist in the hero build's HTML (see hero.html) — every
// lookup/size below is IS_HERO-guarded so module load never dereferences a
// null canvas; drawAxisGizmo itself stays a normal top-level declaration
// (its call site in renderCubeFrame is what's actually gated) so it's never
// invoked in hero regardless.
const axisGizmoCanvas = IS_HERO ? null : document.getElementById('axis-gizmo');
const axisGizmoCtx = IS_HERO ? null : axisGizmoCanvas.getContext('2d');
const AXIS_GIZMO_DPR = Math.max(1, window.devicePixelRatio || 1);
if (!IS_HERO) {
  axisGizmoCanvas.width = axisGizmoCanvas.clientWidth * AXIS_GIZMO_DPR || axisGizmoCanvas.width;
  axisGizmoCanvas.height = axisGizmoCanvas.clientHeight * AXIS_GIZMO_DPR || axisGizmoCanvas.height;
}
const AXIS_GIZMO_RADIUS = IS_HERO ? 0 : (axisGizmoCanvas.width / 2) * 0.68; // leaves room for the end labels within the canvas
const AXIS_GIZMO_LINE_WIDTH = 2 * AXIS_GIZMO_DPR;
const AXIS_GIZMO_FONT = `${11 * AXIS_GIZMO_DPR}px ui-monospace, monospace`;
// Standard red/green/blue = X/Y/Z convention (Blender, Three.js editor,
// etc.) — worth keeping even though this app uses green/red for unrelated
// things elsewhere (flow parts, arrow guides), since it's what anyone
// who's used a 3D tool before will already recognize at a glance.
const AXIS_GIZMO_AXES = [
  { dir: [1, 0, 0], label: 'X', color: '229, 57, 53' },
  { dir: [0, 1, 0], label: 'Y', color: '67, 160, 71' },
  { dir: [0, 0, 1], label: 'Z', color: '30, 136, 229' },
];

function drawAxisGizmo(rx, ry) {
  const w = axisGizmoCanvas.width, h = axisGizmoCanvas.height;
  const cx = w / 2, cy = h / 2;
  axisGizmoCtx.clearRect(0, 0, w, h);

  // Each axis contributes a near (behind, -dir) and far (in front, +dir)
  // tip; painter's-algorithm sorted back-to-front by rotated depth (index 2)
  // so nearer tips draw over farther ones, same cheap trick
  // buildPivotOrbNDC's caller relies on for the real 3D scene's depth buffer
  // — there's no actual depth buffer here since this is a flat 2D canvas.
  const tips = [];
  for (const axis of AXIS_GIZMO_AXES) {
    const rotated = rotateXVec3(rotateYVec3(axis.dir, ry), rx);
    tips.push({ ...axis, rotated, sign: 1 });
    tips.push({ ...axis, rotated: rotated.map((v) => -v), sign: -1 });
  }
  tips.sort((a, b) => a.rotated[2] - b.rotated[2]);

  for (const tip of tips) {
    const tx = cx + tip.rotated[0] * AXIS_GIZMO_RADIUS;
    const ty = cy - tip.rotated[1] * AXIS_GIZMO_RADIUS; // canvas Y is down, object-space Y is up
    const alpha = tip.sign > 0 ? 1 : 0.35; // the -X/-Y/-Z tips read as faint stubs, not full axes
    axisGizmoCtx.strokeStyle = `rgba(${tip.color}, ${alpha})`;
    axisGizmoCtx.lineWidth = AXIS_GIZMO_LINE_WIDTH;
    axisGizmoCtx.lineCap = 'round';
    axisGizmoCtx.beginPath();
    axisGizmoCtx.moveTo(cx, cy);
    axisGizmoCtx.lineTo(tx, ty);
    axisGizmoCtx.stroke();

    if (tip.sign > 0) {
      axisGizmoCtx.fillStyle = `rgba(${tip.color}, 1)`;
      axisGizmoCtx.beginPath();
      axisGizmoCtx.arc(tx, ty, 2.5 * AXIS_GIZMO_DPR, 0, Math.PI * 2);
      axisGizmoCtx.fill();
      axisGizmoCtx.font = AXIS_GIZMO_FONT;
      axisGizmoCtx.textAlign = 'center';
      axisGizmoCtx.textBaseline = 'middle';
      const lx = cx + tip.rotated[0] * (AXIS_GIZMO_RADIUS + 11 * AXIS_GIZMO_DPR);
      const ly = cy - tip.rotated[1] * (AXIS_GIZMO_RADIUS + 11 * AXIS_GIZMO_DPR);
      axisGizmoCtx.fillText(tip.label, lx, ly);
    }
  }
}

// Tracks the last Camera Target index the panel was told about via
// notifyModelState — IS_SCROLL_ROUTE's own renderCubeFrame branch below sets
// cameraTargetActiveIndex directly every frame (never through
// goToCameraTarget, which is what calls notifyModelState for a manual 1/2/3
// press), so without this the panel's own cameraTargetActiveIndex — and so
// the bottom-left info card's per-target content — would never update while
// scrolling. Notifying every frame regardless would work but re-render the
// whole panel needlessly; this only fires when the index actually changes.
let scrollLastNotifiedTargetIndex = null;

function renderCubeFrame() {
  updateBatteryStackGeometry();
  gl.viewport(0, 0, canvas.width, canvas.height);
  // Clear alpha is 0 instead of the usual 1 while capturePhoto is mid-export
  // (see capturingTransparentPhoto) — the PNG then carries a true alpha
  // channel wherever no model geometry covers a pixel, rather than baking in
  // the on-screen background color/theme.
  const bgAlpha = capturingTransparentPhoto ? 0 : 1;
  if (blueprintEnabled) {
    const bg = BLUEPRINT_THEMES[shaderTheme].bg;
    gl.clearColor(bg[0], bg[1], bg[2], bgAlpha);
  } else {
    gl.clearColor(0, 0, 0, bgAlpha);
  }
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  if (videoRecording || pngSequenceExporting) {
    // Deliberately does nothing: both captureVideo() and capturePngSequence()
    // call advanceVideoTilt themselves, with their own frame-index-based t,
    // immediately before calling renderCubeFrame() for each frame — and
    // renderLoop pauses itself for the whole export either way (see its own
    // check), so this branch only exists to make sure nothing here (ambient
    // hover, a leftover rotation-reset tween) can clobber cubeParallaxX/Y in
    // between frames.
  } else if (cubeRotResetStartTime !== null) {
    // Fast ease-out cubic from the snapshot taken in tweenCubeRotationTo to
    // its target angle — cubeRotResetSuppressParallax additionally decays
    // the tilt itself back to zero over the same curve (overriding the
    // normal per-frame parallax easing below) for the fast reset-style
    // tweens; the slow load intro leaves it false so live hover keeps
    // running via the normal path underneath the rotation tween instead of
    // going dead for its whole 2s.
    const now = performance.now();
    // Rotation's own clock is offset by cubeRotResetDelayMs (0 for every
    // caller but loadBundledDefaultModel's intro) — clamped to 0 rather than
    // going negative so it just holds at the "from" snapshot (eased(0) = 0)
    // until the delay elapses, then plays out over cubeRotResetDurationMs
    // same as always. The zoom below deliberately does NOT get this offset;
    // it starts immediately at the tween's own t=0.
    const t = Math.min(1, Math.max(0, now - cubeRotResetStartTime - cubeRotResetDelayMs) / cubeRotResetDurationMs);
    const eased = cubeRotResetEasing(t);
    cubeRotX = cubeRotResetFrom.rotX + (cubeRotResetTargetX - cubeRotResetFrom.rotX) * eased;
    cubeRotY = cubeRotResetFrom.rotY + (cubeRotResetTargetY - cubeRotResetFrom.rotY) * eased;
    // Zoom runs on cubeRotResetZoomDurationMs, its own clock sharing only
    // the same start time — independent of the rotation's t/eased above so
    // it can keep easing (loadBundledDefaultModel's intro: through the
    // MODEL_LOAD_INTRO_PHASE_GAP_MS pause) after rotation has already
    // landed on its target.
    const zoomT = cubeRotResetZoomInFactor !== 0
      ? Math.min(1, (now - cubeRotResetStartTime) / cubeRotResetZoomDurationMs)
      : 1;
    if (cubeRotResetZoomInFactor !== 0) {
      const zoomEased = cubeRotResetZoomEasing(zoomT);
      // Same pivot-anchored scale path the "Model size" slider and
      // scroll-wheel zoom use (see applyCubeSizePercent) — batches the
      // persist+notify through the same rAF debounce scroll-zoom already
      // uses (scheduleWheelZoomSync) instead of hitting localStorage/the
      // panel every frame of the tween.
      applyCubeSizePercent(cubeRotResetFrom.sizePercent + (cubeRotResetTargetSizePercent - cubeRotResetFrom.sizePercent) * zoomEased);
      scheduleWheelZoomSync();
    }
    if (cubeRotResetSuppressParallax) {
      cubeParallaxTargetX = cubeRotResetFrom.parTargetX * (1 - eased);
      cubeParallaxTargetY = cubeRotResetFrom.parTargetY * (1 - eased);
      cubeParallaxX = cubeRotResetFrom.parX * (1 - eased);
      cubeParallaxY = cubeRotResetFrom.parY * (1 - eased);
    } else {
      advanceParallax();
    }
    if (t >= 1 && zoomT >= 1) {
      cubeRotResetStartTime = null;
      cubeRotResetFrom = null;
    }
  } else {
    advanceParallax();
  }

  if (introYawTweenActive) {
    // Runs after the block above so it has the final say over cubeRotY
    // whenever both are active — see introYawTweenActive's own comment.
    const yawT = Math.min(1, (performance.now() - introYawTweenStartTime) / introYawDurationMs);
    cubeRotY = introYawFrom + (introYawTo - introYawFrom) * introYawEasing(yawT);
    if (yawT >= 1) introYawTweenActive = false;
  }

  const rx = cubeRotX + cubeParallaxX;
  const ry = cubeRotY + cubeParallaxY;

  // Rotation (rx/ry) is untouched by camera-target mode — only the pan
  // offset's source and the extra zoom multiplier change, so drag/hover
  // rotation holds automatically regardless of target.
  const activeTargetName = cameraTargetActiveIndex !== null ? cameraTargetSlots[cameraTargetActiveIndex] : null;
  if (introCamTargetTweenActive) {
    // loadBundledDefaultModel's intro phase 2: fixed duration/easing
    // instead of the spring below (see startIntroCameraTargetTween) — the
    // goal was already resolved once, up front, rather than being re-read
    // every frame the way the spring's is.
    const introNow = performance.now();
    const posT = Math.min(1, (introNow - introCamTargetTweenStartTime) / introCamTargetPosDurationMs);
    const posEased = introCamTargetPosEasing(posT);
    cameraTargetCurrent = [0, 1, 2].map(
      (i) => introCamTargetTweenFromPos[i] + (introCamTargetTweenToPos[i] - introCamTargetTweenFromPos[i]) * posEased
    );
    // Zoom's own clock is offset by introCamTargetZoomDelayMs (0 unless a
    // caller passes one) — clamped to 0 rather than going negative so it
    // just holds at the "from" snapshot (eased(0) = 0) until the delay
    // elapses, same pattern as cubeRotResetDelayMs above.
    const zoomT = Math.min(1, Math.max(0, introNow - introCamTargetTweenStartTime - introCamTargetZoomDelayMs) / introCamTargetZoomDurationMs);
    const zoomEased = introCamTargetZoomEasing(zoomT);
    cameraTargetZoomCurrent = introCamTargetTweenFromZoom + (introCamTargetTweenToZoom - introCamTargetTweenFromZoom) * zoomEased;
    if (posT >= 1 && zoomT >= 1) {
      // Hand off cleanly to the spring path (below, from next frame on):
      // both are already sitting exactly at this slot's goal, so the spring
      // has nothing left to do until something (a manual switch, a resize)
      // gives it a new goal to chase.
      introCamTargetTweenActive = false;
      cameraTargetVelocity = [0, 0, 0];
      cameraTargetZoomVelocity = 0;
      cameraTargetSpringLastTime = null;
    }
    cameraTargetAtRest = false; // a target is active (or just finished activating) — never the manual-pan "at rest" state while this branch runs
  } else if (IS_SCROLL_ROUTE && !modelFlowDrawMode) {
    // Continuous scroll-scrubbed camera: instead of springing toward one
    // discrete Camera Target's goal (the else branch below, used by manual
    // 1/2/3 presses etc. — normally never reached on this route since
    // nothing here ever sets cameraTargetActiveIndex through
    // goToCameraTarget, EXCEPT arrow draw mode, excluded above — see
    // setModelFlowDraw's cameraTargetActiveIndex reset and the wheel
    // listener's own modelFlowDrawMode check: drawing needs scroll-to-zoom
    // and a still camera, not page-scroll stepping between targets mid-trace),
    // blend between the two targets straddling the current scroll position —
    // see #scroll-track in scroll.html — driven by scroll position every
    // rendered frame, however often that is; not tied to how often 'scroll'
    // events happen to fire.
    //
    // Only assigned slots count as stops — an empty one (cameraTargetSlots[i]
    // === null) is skipped entirely rather than blended through, so the
    // scroll range always divides evenly across however many of the up-to-
    // CAMERA_TARGET_SLOT_COUNT slots are actually in use. activeSlots maps
    // "position in the sequence" (0..numTargets-1) to "real slot index"
    // (0..CAMERA_TARGET_SLOT_COUNT-1) — everything below works in sequence
    // positions and only converts back to a real slot index right before
    // calling computeCameraTargetGoal/setting cameraTargetActiveIndex.
    const activeSlots = [];
    for (let i = 0; i < cameraTargetSlots.length; i++) {
      if (cameraTargetSlots[i]) activeSlots.push(i);
    }
    const numTargets = activeSlots.length;
    // Nothing assigned: nothing to blend toward, so this frame just leaves
    // cameraTargetCurrent/Zoom/ActiveIndex exactly as they already were
    // (skips the rest of this branch entirely) rather than blending toward
    // slot 0 the way treating an empty name as a valid stop would.
    if (numTargets > 0) {
    // Section-relative, via scrollTrackEl's own document position, rather
    // than the whole document's scrollHeight — so this same math works both
    // when #scroll-track spans the entire page (scroll.html/scroll-preview
    // .html today: sectionScrollTop is just 0, reducing to the old formula
    // exactly) and when it's embedded as one section of a longer FE page
    // with unrelated content before/after it (see scroll-embed.html). Reads
    // getBoundingClientRect fresh each frame instead of caching an offset —
    // cheap for one element, and stays correct across reflows (resize,
    // content above changing height, etc.) with no separate listener needed.
    const sectionScrollTop = scrollTrackEl.getBoundingClientRect().top + window.scrollY;
    const maxScroll = scrollTrackEl.offsetHeight - window.innerHeight;
    const progress = maxScroll > 0 ? Math.max(0, Math.min(1, (window.scrollY - sectionScrollTop) / maxScroll)) : 0;
    // The track reserves one leading SCROLL_INTRO_SPAN_VH_UNITS-tall span,
    // ahead of Target 1's own span, for the intro (see
    // updateScrollTrackHeight) — introFraction is that span's share of the
    // whole track. blendProgress remaps the remaining post-intro range back
    // to the plain "0..1 across the N targets" progress the
    // lowerPos/upperPos/frac math below was written against, clamped to 0
    // for the entire intro span so lowerPos/frac stay pinned at Target 1's
    // own goal (no blend at all) until scroll actually passes it — the
    // camera holds still while panel.tsx's own copy of this same split
    // instead slides the bottom-left info card in from below.
    const introFraction = SCROLL_INTRO_SPAN_VH_UNITS / (numTargets + SCROLL_INTRO_SPAN_VH_UNITS);
    const blendProgress = Math.max(0, Math.min(1, (progress - introFraction) / (1 - introFraction)));
    // lowerPos is clamped to numTargets - 2 (not just floored) so upperPos
    // (lowerPos + 1) always stays a valid sequence position, including
    // exactly at blendProgress === 1 — and, when numTargets is 1, both clamp
    // down to position 0, so lowerIndex/upperIndex end up equal and frac
    // becomes irrelevant: the single assigned target just sits still, no
    // blend.
    const lowerPos = Math.max(0, Math.min(numTargets - 2, Math.floor(blendProgress * (numTargets - 1))));
    const upperPos = Math.min(numTargets - 1, lowerPos + 1);
    const lowerIndex = activeSlots[lowerPos];
    const upperIndex = activeSlots[upperPos];
    const rawFrac = Math.max(0, Math.min(1, blendProgress * (numTargets - 1) - lowerPos));
    // Hold zones: SCROLL_HOLD_FRACTION of each span, at both ends, pins the
    // blend to whichever target it's nearest instead of moving right away —
    // so scrolling into a target keeps you sitting on it for a beat before
    // the next scrolling actually starts easing toward the next one. Reserves
    // the remaining middle (1 - 2*SCROLL_HOLD_FRACTION) of the span for the
    // actual transition. An interior target (between two spans) gets this
    // hold from both its neighboring spans — the tail of the one before it
    // and the head of the one after — so it reads as a longer pause there
    // than at the first/last target, which only get it from their one span.
    const SCROLL_HOLD_FRACTION = 0.25;
    const frac = rawFrac <= SCROLL_HOLD_FRACTION
      ? 0
      : rawFrac >= 1 - SCROLL_HOLD_FRACTION
        ? 1
        : (rawFrac - SCROLL_HOLD_FRACTION) / (1 - 2 * SCROLL_HOLD_FRACTION);
    // introProgress: 0 at scrollY 0, easing up to exactly 1 by the end of
    // the intro span (progress === introFraction), in lockstep with
    // panel.tsx's own copy of this same introProgress/eased pair driving the
    // info card's entrance — then pinned at 1 for the rest of the scroll.
    const introProgress = Math.max(0, Math.min(1, progress / introFraction));
    const introEased = 1 - (1 - introProgress) ** 3; // ease-out cubic, matches panel.tsx's card entrance
    const goalLower = computeCameraTargetGoal(lowerIndex);
    const goalUpper = computeCameraTargetGoal(upperIndex);
    const targetToTargetCenter = [0, 1, 2].map((i) => goalLower.center[i] + (goalUpper.center[i] - goalLower.center[i]) * frac);
    const targetToTargetZoom = goalLower.zoomGoal + (goalUpper.zoomGoal - goalLower.zoomGoal) * frac;
    // Target_Start (see findTargetStartObject): when the model names one,
    // the intro span eases the camera from ITS framing into Target 1's
    // (position and zoom both), using the same introEased curve that drives
    // the bottom-left info card's entrance, so the first scroll's camera
    // move and the card's slide-in land together. During the intro span,
    // lowerIndex/upperIndex/frac above are pinned to Target 1 (frac === 0 —
    // see blendProgress), so targetToTargetCenter/Zoom are just Target 1's
    // own goal here, and this blend is purely Target_Start -> Target 1;
    // introEased pinned at 1 for the rest of the scroll hands off seamlessly
    // to the ordinary target-to-target blend above. Falls back to the old
    // zoom-only pull-in — position pinned at Target 1 throughout the intro
    // span, only zoom easing in from (1 - SCROLL_INTRO_ZOOM_OUT_FRACTION) —
    // for models with no Target_Start, so untouched models keep their exact
    // previous behavior.
    const startObj = findTargetStartObject();
    let goalCenter, goalZoom;
    if (startObj) {
      const startGoal = computeCameraTargetGoalForObject(startObj);
      goalCenter = [0, 1, 2].map((i) => startGoal.center[i] + (targetToTargetCenter[i] - startGoal.center[i]) * introEased);
      goalZoom = startGoal.zoomGoal + (targetToTargetZoom - startGoal.zoomGoal) * introEased;
    } else {
      const introZoomMultiplier = 1 - SCROLL_INTRO_ZOOM_OUT_FRACTION * (1 - introEased);
      goalCenter = targetToTargetCenter;
      goalZoom = targetToTargetZoom * introZoomMultiplier;
    }
    // Eased toward the scroll-driven goal rather than snapped straight to it
    // — same lightweight per-frame exponential smoothing advanceParallax
    // uses for ambient hover tilt (see CUBE_PARALLAX_SMOOTHING), just
    // applied to the scroll-derived goal instead of cursor position. Keeps
    // the camera reading as continuously scroll-driven (not a discrete
    // snap), while smoothing over the raw, sometimes-choppy per-notch/
    // per-frame scrollY updates the browser itself delivers.
    const SCROLL_SCRUB_SMOOTHING = 0.05;
    cameraTargetCurrent = [0, 1, 2].map((i) => cameraTargetCurrent[i] + (goalCenter[i] - cameraTargetCurrent[i]) * SCROLL_SCRUB_SMOOTHING);
    cameraTargetZoomCurrent += (goalZoom - cameraTargetZoomCurrent) * SCROLL_SCRUB_SMOOTHING;
    cameraTargetVelocity = [0, 0, 0];
    cameraTargetZoomVelocity = 0;
    cameraTargetSpringLastTime = null;
    // Whichever target the blend is currently nearer to (by frac) — for the
    // 3D side any valid slot would do (see getObjectSpacePan's manual-pan
    // suppression/the pivot-orb/floor-guide visuals, neither reads it by
    // name off this route), but this is also what the panel's bottom-left
    // info card keys its per-step content off of, so during the transition
    // itself it switches at the halfway point rather than staying on the
    // departing target the whole way across.
    const nearestIndex = frac < 0.5 ? lowerIndex : upperIndex;
    cameraTargetActiveIndex = nearestIndex;
    cameraTargetAtRest = false;
    // See scrollLastNotifiedTargetIndex's own comment — only notify the
    // panel when this actually changes, not every frame.
    if (nearestIndex !== scrollLastNotifiedTargetIndex) {
      scrollLastNotifiedTargetIndex = nearestIndex;
      notifyModelState();
    }
    }
  } else {
    const goal = activeTargetName ? computeCameraTargetGoal(cameraTargetActiveIndex) : { center: [0, 0, 0], zoomGoal: 1 };
    const goalCenter = goal.center;
    const zoomGoal = goal.zoomGoal;
    // Step the damped spring toward this frame's goal (see stepSpring
    // above). Unlike a tween, there's nothing to "restart" when the goal
    // changes — switching targets mid-flight, or a resize nudging the
    // frame-to-fit zoom, just becomes a new goal the spring keeps pulling
    // toward from wherever it already is, carrying whatever velocity it
    // already had.
    const now = performance.now();
    const dt = cameraTargetSpringLastTime === null
      ? 0
      : Math.min(CAMERA_TARGET_SPRING_MAX_DT, (now - cameraTargetSpringLastTime) / 1000);
    cameraTargetSpringLastTime = now;
    const nextPos = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      [nextPos[i], cameraTargetVelocity[i]] = stepSpring(cameraTargetCurrent[i], cameraTargetVelocity[i], goalCenter[i], dt);
    }
    cameraTargetCurrent = nextPos;
    [cameraTargetZoomCurrent, cameraTargetZoomVelocity] = stepSpring(
      cameraTargetZoomCurrent, cameraTargetZoomVelocity, zoomGoal, dt,
      CAMERA_TARGET_ZOOM_SPRING_STIFFNESS, CAMERA_TARGET_ZOOM_SPRING_DAMPING,
    );
    // "At rest" (see getObjectSpacePan) only when there's no active target
    // AND the spring has actually settled at the origin/1x — not merely
    // whenever cameraTargetActiveIndex is null, since the spring is still
    // moving for a beat after a target's deactivated.
    cameraTargetAtRest = !activeTargetName
      && Math.hypot(...cameraTargetCurrent) < CAMERA_TARGET_SPRING_REST_EPSILON
      && Math.hypot(...cameraTargetVelocity) < CAMERA_TARGET_SPRING_REST_EPSILON
      && Math.abs(cameraTargetZoomCurrent - 1) < CAMERA_TARGET_SPRING_REST_EPSILON
      && Math.abs(cameraTargetZoomVelocity) < CAMERA_TARGET_SPRING_REST_EPSILON;
  }
  const s = CUBE_SCALE * cubeSizeScale * cameraTargetZoomCurrent;
  const [offsetX, offsetY] = getCurrentCameraOffset(rx, ry, s);
  const [panX, panY, panZ] = getObjectSpacePan();

  let modelView = mat4Translate(offsetX, offsetY, cameraOffsetZ);
  modelView = mat4Multiply(modelView, mat4RotateX(rx));
  modelView = mat4Multiply(modelView, mat4RotateY(ry));
  modelView = mat4Multiply(modelView, mat4Translate(panX, panY, panZ));
  modelView = mat4Multiply(modelView, mat4Scale(s));

  gl.useProgram(cubeProgram);
  gl.uniformMatrix4fv(uModelView, false, modelView);
  gl.uniformMatrix4fv(uProjection, false, cubeProjection);
  const azRad = (lightAzimuthValue * Math.PI) / 180;
  const elRad = (lightElevationValue * Math.PI) / 180;
  gl.uniform3f(uLightDir, Math.cos(elRad) * Math.cos(azRad), Math.sin(elRad), Math.cos(elRad) * Math.sin(azRad));
  gl.uniform1f(uLightIntensity, lightIntensityPercent / 100);
  gl.uniform1i(uBlueprint, blueprintEnabled ? 1 : 0);
  const blueprintFillColor = BLUEPRINT_THEMES[shaderTheme].fill;
  gl.uniform3f(uBlueprintFillColor, blueprintFillColor[0], blueprintFillColor[1], blueprintFillColor[2]);
  gl.uniform3f(uBlueprintFillColorGreen, BLUEPRINT_FILL_COLOR_GREEN[0], BLUEPRINT_FILL_COLOR_GREEN[1], BLUEPRINT_FILL_COLOR_GREEN[2]);
  const blueprintLineColor = BLUEPRINT_THEMES[shaderTheme].line;
  gl.uniform3f(uHatchLineColor, blueprintLineColor[0], blueprintLineColor[1], blueprintLineColor[2]);
  gl.uniform1f(uLineFrequency, lineFrequencyValue);
  gl.uniform1f(uDotFrequency, dotFrequencyValue);
  gl.uniform1f(uDotRadius, dotSizePercent / 100);
  gl.uniform1f(uPlusFrequency, plusFrequencyValue);
  const plusArmHalf = plusSizePercent / 100;
  gl.uniform1f(uPlusArmHalf, plusArmHalf);
  gl.uniform1f(uPlusThickness, plusArmHalf * PLUS_THICKNESS_RATIO);

  gl.bindBuffer(gl.ARRAY_BUFFER, customModelPositionBuffer);
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, customModelNormalBuffer);
  gl.enableVertexAttribArray(aNormal);
  gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, customModelColorBuffer);
  gl.enableVertexAttribArray(aColor);
  gl.vertexAttribPointer(aColor, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, customModelIsGreenBuffer);
  gl.enableVertexAttribArray(aIsGreen);
  gl.vertexAttribPointer(aIsGreen, 1, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, customModelFillPatternBuffer);
  gl.enableVertexAttribArray(aFillPattern);
  gl.vertexAttribPointer(aFillPattern, 1, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, customModelFlowCoordBuffer);
  gl.enableVertexAttribArray(aFlowCoord);
  gl.vertexAttribPointer(aFlowCoord, 1, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, customModelFlowPathLenBuffer);
  gl.enableVertexAttribArray(aFlowPathLen);
  gl.vertexAttribPointer(aFlowPathLen, 1, gl.FLOAT, false, 0, 0);

  // Traveling flow pulse: same Gaussian-band-over-time math as the image
  // mode's flow (see renderLoop's pulseLinear/pulseProgress/pulseSigma), just
  // parameterized by each vertex's normalized (0-1) position along its
  // nearest arrow instead of grid cells or an absolute arc length. flowWorldPos
  // below is the world-space distance traveled at the *reference* speed
  // (flowSpeedWorldPerMs) — CUBE_FRAGMENT_SHADER scales that up per-vertex
  // by sqrt(vFlowPathLen / MODEL_FLOW_REFERENCE_LENGTH), so longer arrows'
  // pulses move faster in absolute terms than shorter arrows', but not
  // proportionally faster (that would make every arrow's lap TIME equal,
  // i.e. back in sync) — arrows still drift out of phase with each other
  // instead of looping together (see recomputeModelFlowCoords/uFlowWorldPos
  // in CUBE_FRAGMENT_SHADER). Reuses pulseBandFraction (the shared "Pulse
  // width" slider) so one control governs both modes' pulse widths. Speed is
  // user-adjustable via flowSpeedPercent (the "Flow speed" slider). Computed
  // once here and reused for both the face pass (cubeProgram, below) and the
  // line pass (lineProgram, further down) rather than reading anything back
  // from the GPU.
  const flowActive = blueprintEnabled && customModelReady && modelFlowPaths.length > 0;
  let flowSigma = 0.02;
  let flowRange = 0;
  let flowPad = 0;
  let flowWorldPos = 0;
  let flowPulseDensity = 0;
  if (flowActive) {
    // Floored at a tiny epsilon (not 0.02 as before) so the "Pulse width"
    // slider's low end actually has an effect — 0.02 sat above every value
    // this expression produces for pulseWidthValue < ~3.33 (0.15 * 4 = 0.6,
    // so 0.6 * pulseWidthValue/100 < 0.02 whenever pulseWidthValue < 3.33),
    // silently flattening the slider's bottom third-plus into one identical
    // width. The real "don't let it disappear" floor already lives in the
    // shader (FLOW_MIN_SIGMA_PX, screen-space and zoom-aware) — this JS-side
    // floor only needs to keep flowSigma from hitting exactly 0.
    flowSigma = Math.max(0.0005, MODEL_FLOW_PULSE_BAND_FRACTION * pulseBandFraction * 4);
    flowPad = flowSigma * FLOW_PULSE_PAD_SIGMAS;
    flowRange = 1 + 2 * flowPad;
    // Linear for now (was an eased t^3 ease-in — the pulse noticeably
    // lingered at the start of each loop before accelerating through the
    // rest of the arrow). A MODEL_FLOW_REFERENCE_LENGTH-long arrow takes
    // FLOW_PULSE_PERIOD_BASE_MS to complete one lap (matching the old
    // fixed-period feel for a "typical" arrow); every other arrow's own
    // speed (and so its own lap time) follows from its own length via the
    // shader's sqrt scaling instead — see uFlowWorldPos's per-vertex use in
    // CUBE_FRAGMENT_SHADER. Recomputed fresh from absolute time each frame
    // rather than integrated, so — like the old pulseProgress — changing
    // the "Flow speed" slider mid-flight can nudge the current phase rather
    // than smoothly accelerate/decelerate it.
    const flowSpeedWorldPerMs = MODEL_FLOW_REFERENCE_LENGTH / (FLOW_PULSE_PERIOD_BASE_MS * (100 / flowSpeedPercent));
    flowWorldPos = performance.now() * flowSpeedWorldPerMs;
    // Pulses-per-MODEL_FLOW_REFERENCE_LENGTH-of-path-length — see
    // uFlowPulseDensity/FLOW_PULSE_FREQUENCY_MIN. CUBE_FRAGMENT_SHADER
    // multiplies this by each vertex's own vFlowPathLen (floored/capped) to
    // get that specific arrow's own pulse count, so it still reduces to
    // exactly flowPulseFrequencyValue for a MODEL_FLOW_REFERENCE_LENGTH-ish
    // arrow.
    flowPulseDensity = flowPulseFrequencyValue / MODEL_FLOW_REFERENCE_LENGTH;
  }
  gl.uniform1i(uFlowActive, flowActive ? 1 : 0);
  if (flowActive) {
    gl.uniform1f(uFlowWorldPos, flowWorldPos);
    gl.uniform1f(uFlowReferenceLength, MODEL_FLOW_REFERENCE_LENGTH);
    gl.uniform1f(uFlowRange, flowRange);
    gl.uniform1f(uFlowPad, flowPad);
    gl.uniform1f(uFlowPulseDensity, flowPulseDensity);
    gl.uniform1f(uFlowSigma, flowSigma);
    gl.uniform3f(uFlowColor, BLUEPRINT_FLOW_COLOR[0], BLUEPRINT_FLOW_COLOR[1], BLUEPRINT_FLOW_COLOR[2]);
    gl.uniform3f(uFlowCoreColor, BLUEPRINT_FLOW_CORE_COLOR[0], BLUEPRINT_FLOW_CORE_COLOR[1], BLUEPRINT_FLOW_CORE_COLOR[2]);
    // Absolute world-space head/core/tail reach — MODEL_FLOW_REFERENCE_LENGTH
    // stands in for "this specific arrow's own length" (see
    // aFlowPathLen/vFlowPathLen) so every arrow's head/core/tail covers the
    // same real distance instead of a distance proportional to its own length.
    gl.uniform1f(uFlowHeadWorldSigma, flowSigma * FLOW_COMET_HEAD_SIGMA_MULT * MODEL_FLOW_REFERENCE_LENGTH);
    gl.uniform1f(uFlowCoreWorldSigma, flowSigma * (flowCoreLengthPercent / 100) * MODEL_FLOW_REFERENCE_LENGTH);
    gl.uniform1f(uFlowTailWorldSigma, flowSigma * (flowTailLengthPercent / 100) * MODEL_FLOW_REFERENCE_LENGTH);
    gl.uniform1f(uFlowTailFalloffExponent, flowTailFalloffValue);
    gl.uniform1i(uFlowTailVisible, flowTailVisible ? 1 : 0);
  }

  // In blueprint mode the filled pass is nudged back with polygon offset so
  // the wireframe (drawn without it, right after) sits cleanly on top
  // instead of z-fighting with the coplanar filled faces underneath it.
  if (blueprintEnabled) {
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
  }

  // customModelVertexCount is 0 until a model's actually loaded (see
  // customModelReady/applyParsedModel), so this is a no-op draw call rather
  // than needing an explicit readiness guard — nothing renders until then.
  gl.drawArrays(gl.TRIANGLES, 0, customModelVertexCount);

  // Camera-target bounding-box overlay (see showCameraTargetBoxes/
  // buildBoxGeometry above) — independent of blueprint mode, since it's a
  // camera-target diagnostic rather than a wireframe-mode feature. Real 3D
  // geometry (actual modelView/cubeProjection), drawn right after the
  // opaque fill pass so its depth test correctly hides the far side behind
  // whatever the model itself already occludes.
  if (showCameraTargetBoxes && customModelReady) {
    const targetNames = [...new Set(cameraTargetSlots.filter(Boolean))];
    if (targetNames.length > 0) {
      gl.useProgram(lineProgram);
      gl.uniformMatrix4fv(uLineModelView, false, modelView);
      gl.uniformMatrix4fv(uLineProjection, false, cubeProjection);
      gl.enableVertexAttribArray(aLinePosition);
      gl.disableVertexAttribArray(aLineColor);
      gl.vertexAttrib3f(aLineColor, CAMERA_TARGET_BOX_COLOR[0], CAMERA_TARGET_BOX_COLOR[1], CAMERA_TARGET_BOX_COLOR[2]);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      // Faces skip the depth write (translucent box shouldn't occlude
      // anything drawn after it) while depth *testing* stays on, so the box
      // still correctly disappears behind opaque model geometry.
      gl.depthMask(false);
      for (const name of targetNames) {
        const obj = customModelObjects.find((o) => o.name === name);
        if (!obj || !obj.bounds) continue;
        const { fill, edges } = buildBoxGeometry(obj.bounds);

        gl.bindBuffer(gl.ARRAY_BUFFER, cameraTargetBoxFillBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, fill, gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(aLinePosition, 3, gl.FLOAT, false, 0, 0);
        gl.uniform1f(uLineAlpha, CAMERA_TARGET_BOX_FILL_OPACITY);
        gl.drawArrays(gl.TRIANGLES, 0, fill.length / 3);

        gl.bindBuffer(gl.ARRAY_BUFFER, cameraTargetBoxEdgeBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, edges, gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(aLinePosition, 3, gl.FLOAT, false, 0, 0);
        gl.uniform1f(uLineAlpha, CAMERA_TARGET_BOX_EDGE_OPACITY);
        gl.drawArrays(gl.LINES, 0, edges.length / 3);
      }
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.uniform1f(uLineAlpha, 1.0);
    }
  }

  // Target-material overlay (see showTargetMaterials/TARGET_MATERIAL_COLOR
  // above) — same real-3D/depth-tested/no-depth-write treatment as the
  // camera-target box fill just above: a translucent purple fill pass, then
  // its crease-edge wireframe (customModelTargetLineBuffer, built the same
  // way as the model's own blueprint wireframe — see targetLineData in
  // parseObj) drawn at higher opacity on top so the cube's actual shape
  // stays legible through the fill.
  if (showTargetMaterials && customModelReady && customModelTargetVertexCount > 0) {
    gl.useProgram(lineProgram);
    gl.uniformMatrix4fv(uLineModelView, false, modelView);
    gl.uniformMatrix4fv(uLineProjection, false, cubeProjection);
    gl.enableVertexAttribArray(aLinePosition);
    gl.disableVertexAttribArray(aLineColor);
    gl.vertexAttrib3f(aLineColor, TARGET_MATERIAL_COLOR[0], TARGET_MATERIAL_COLOR[1], TARGET_MATERIAL_COLOR[2]);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.bindBuffer(gl.ARRAY_BUFFER, customModelTargetFillBuffer);
    gl.vertexAttribPointer(aLinePosition, 3, gl.FLOAT, false, 0, 0);
    gl.uniform1f(uLineAlpha, TARGET_MATERIAL_OPACITY);
    gl.drawArrays(gl.TRIANGLES, 0, customModelTargetVertexCount);
    if (customModelTargetLineVertexCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, customModelTargetLineBuffer);
      gl.vertexAttribPointer(aLinePosition, 3, gl.FLOAT, false, 0, 0);
      gl.uniform1f(uLineAlpha, TARGET_MATERIAL_EDGE_OPACITY);
      gl.drawArrays(gl.LINES, 0, customModelTargetLineVertexCount);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.uniform1f(uLineAlpha, 1.0);
  }

  if (blueprintEnabled) {
    gl.disable(gl.POLYGON_OFFSET_FILL);

    gl.useProgram(lineProgram);
    gl.uniform1f(uLineAlpha, 1.0);

    // Shared by the wireframe ribbon branch below, the arrow ribbons further
    // down, and the pivot orb further still — projects object-space points
    // straight to NDC/clip space on the CPU (see buildArrowRibbonNDC's
    // comment for why: an orthographic projection composed with
    // rotate/scale/translate always has clip.w=1, so this *is* the final
    // NDC position, no perspective divide needed).
    const combined = mat4Multiply(cubeProjection, modelView);

    // While photo mode is active and the panel's "Uniform wireframe line
    // width" switch is on, draws the wireframe as a constant-pixel-width
    // ribbon — live, not just for the captured frame — so toggling the
    // switch or dragging the line-width slider previews exactly how the
    // exported photo's line width will look. Scaled so it reads the same
    // relative thickness at whatever resolution is currently rendering (see
    // photoLineWidthHalfPx) — live view and export alike — instead of
    // gl.LINES' ~1-device-pixel width that gets relatively thinner the
    // higher the resolution goes. Every other case (switch off, or photo
    // mode not active) falls through to the unchanged gl.LINES draw.
    if (photoMode && photoUniformLineWidth && customModelLinePositionsCache && customModelLinePositionsCache.length > 0) {
      const halfWidthPx = photoLineWidthHalfPx * (Math.max(canvas.width, canvas.height) / PHOTO_EXPORT_MAX_DIMENSION);
      const lineColors = buildLineColors(customModelLineIsGreenCache, BLUEPRINT_THEMES[shaderTheme].line);
      const ribbon = buildLineRibbonNDC(customModelLinePositionsCache, lineColors, combined, canvas.width, canvas.height, halfWidthPx);

      gl.uniformMatrix4fv(uLineModelView, false, IDENTITY_MAT4);
      gl.uniformMatrix4fv(uLineProjection, false, IDENTITY_MAT4);

      gl.bindBuffer(gl.ARRAY_BUFFER, customModelLineRibbonBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, ribbon.positions, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aLinePosition);
      gl.vertexAttribPointer(aLinePosition, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, customModelLineRibbonColorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, ribbon.colors, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aLineColor);
      gl.vertexAttribPointer(aLineColor, 3, gl.FLOAT, false, 0, 0);

      gl.drawArrays(gl.TRIANGLES, 0, ribbon.positions.length / 3);
    } else {
      gl.uniformMatrix4fv(uLineModelView, false, modelView);
      gl.uniformMatrix4fv(uLineProjection, false, cubeProjection);

      gl.bindBuffer(gl.ARRAY_BUFFER, customModelLineBuffer);
      gl.enableVertexAttribArray(aLinePosition);
      gl.vertexAttribPointer(aLinePosition, 3, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, customModelLineColorBuffer);
      gl.enableVertexAttribArray(aLineColor);
      gl.vertexAttribPointer(aLineColor, 3, gl.FLOAT, false, 0, 0);

      gl.drawArrays(gl.LINES, 0, customModelLineVertexCount);
    }

    // Draw every finalized arrow, plus the in-progress drag (if any), as a
    // bold guide ribbon (with an arrowhead marking its direction) on top, so
    // the user can see/verify what they've traced so far while still being
    // able to add more arrows — built in NDC space (see buildArrowRibbonNDC)
    // so its width reads as constant pixels regardless of zoom, which a
    // plain gl.LINES strip can't do. Needs its own identity model/
    // projection: the ribbon's vertices are already fully projected on the
    // CPU, so the shader must not reproject them. The selected arrow (see
    // setModelFlowSelectMode) is drawn as a separate batch in an amber
    // highlight color so it's obviously distinct before deleting it. The
    // in-progress drag (not yet double-clicked to finish — see
    // finalizeModelFlowDrag) is also its own batch, in gray, so it reads as
    // "still being drawn" until it's confirmed and turns blue like the rest.
    const unselectedPointLists = [];
    let selectedPointList = null;
    // Every finalized arrow's true source point (sourceOffset === 0 — the
    // very first point of the very first branch, see finalizeModelFlowDrag)
    // — collected here (where the actual path objects, not just their
    // .points arrays, are in scope) for the black origin dot below.
    const finishedOriginPoints = [];
    if (showModelFlowArrow) {
      modelFlowPaths.forEach((path, i) => {
        if (i === selectedFlowArrowIndex) selectedPointList = path.points;
        else unselectedPointLists.push(path.points);
        if (path.sourceOffset === 0) finishedOriginPoints.push(path.points[0]);
      });
    }
    // Every branch from this drawing session that isn't in modelFlowPaths
    // yet — branches already double-click-finished but still waiting on a
    // pending junction (see completedBranches/finalizeModelFlowDrag), plus
    // whichever branch is currently being clicked out — all rendered as one
    // batch so a multi-branch arrow reads as a single in-progress unit. Tied
    // to showModelFlowArrow same as finalized arrows below, so "Show arrows"
    // is a single master visibility switch rather than only hiding the ones
    // already finished.
    const dragPointLists = modelFlowDrag && showModelFlowArrow
      ? [
          ...modelFlowDrag.completedBranches.map((b) => b.points),
          ...(modelFlowDrag.points.length >= 2 ? [modelFlowDrag.points] : []),
        ]
      : [];

    if (unselectedPointLists.length > 0 || selectedPointList || dragPointLists.length > 0) {
      gl.uniformMatrix4fv(uLineModelView, false, IDENTITY_MAT4);
      gl.uniformMatrix4fv(uLineProjection, false, IDENTITY_MAT4);
      gl.enableVertexAttribArray(aLinePosition);
      gl.disableVertexAttribArray(aLineColor);
      // All three arrow ribbons render at partial opacity (see
      // MODEL_FLOW_ARROW_OPACITY) rather than the wireframe/orb's full 1.0,
      // so blending needs to be on for just this stretch of draw calls.
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(uLineAlpha, MODEL_FLOW_ARROW_OPACITY);

      if (unselectedPointLists.length > 0) {
        const ribbon = buildArrowRibbonNDC(unselectedPointLists, combined, canvas.width, canvas.height, MODEL_FLOW_ARROW_HALF_WIDTH_PX);
        gl.bindBuffer(gl.ARRAY_BUFFER, modelFlowOverlayBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, ribbon, gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(aLinePosition, 3, gl.FLOAT, false, 0, 0);
        gl.vertexAttrib3f(aLineColor, MODEL_FLOW_ARROW_COLOR[0], MODEL_FLOW_ARROW_COLOR[1], MODEL_FLOW_ARROW_COLOR[2]);
        gl.drawArrays(gl.TRIANGLES, 0, ribbon.length / 3);
      }

      if (selectedPointList) {
        const ribbon = buildArrowRibbonNDC([selectedPointList], combined, canvas.width, canvas.height, MODEL_FLOW_ARROW_HALF_WIDTH_PX);
        gl.bindBuffer(gl.ARRAY_BUFFER, modelFlowOverlayBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, ribbon, gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(aLinePosition, 3, gl.FLOAT, false, 0, 0);
        gl.vertexAttrib3f(aLineColor, MODEL_FLOW_ARROW_SELECTED_COLOR[0], MODEL_FLOW_ARROW_SELECTED_COLOR[1], MODEL_FLOW_ARROW_SELECTED_COLOR[2]);
        gl.drawArrays(gl.TRIANGLES, 0, ribbon.length / 3);
      }

      if (dragPointLists.length > 0) {
        const ribbon = buildArrowRibbonNDC(dragPointLists, combined, canvas.width, canvas.height, MODEL_FLOW_ARROW_HALF_WIDTH_PX);
        gl.bindBuffer(gl.ARRAY_BUFFER, modelFlowOverlayBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, ribbon, gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(aLinePosition, 3, gl.FLOAT, false, 0, 0);
        gl.vertexAttrib3f(aLineColor, MODEL_FLOW_ARROW_DRAG_COLOR[0], MODEL_FLOW_ARROW_DRAG_COLOR[1], MODEL_FLOW_ARROW_DRAG_COLOR[2]);
        gl.drawArrays(gl.TRIANGLES, 0, ribbon.length / 3);
      }

      gl.disable(gl.BLEND);
      gl.uniform1f(uLineAlpha, 1.0);
    }

    // Rubber-band preview: a dashed line from the last placed point out to
    // wherever the cursor currently raycasts (see modelFlowHoverClientPos —
    // raycast here, at most once per rendered frame, rather than per raw
    // mousemove event), previewing the segment a click would add next. Not
    // folded into the ribbon block above since it needs to show from the
    // very first point placed — before dragPointLists has the 2 points it
    // requires for an actual ribbon segment to exist yet.
    const hoverHit = showModelFlowArrow && modelFlowDrawMode && modelFlowDrag && modelFlowDrag.points.length > 0 && modelFlowHoverClientPos
      ? raycastGreenMesh(modelFlowHoverClientPos.x, modelFlowHoverClientPos.y)
      : null;
    if (hoverHit) {
      const lastPoint = modelFlowDrag.points[modelFlowDrag.points.length - 1];
      const dashes = buildDashedLineNDC(
        lastPoint, hoverHit.point, combined, canvas.width, canvas.height,
        MODEL_FLOW_HOVER_LINE_HALF_WIDTH_PX, MODEL_FLOW_HOVER_DASH_LENGTH_PX, MODEL_FLOW_HOVER_DASH_GAP_PX,
      );
      gl.uniformMatrix4fv(uLineModelView, false, IDENTITY_MAT4);
      gl.uniformMatrix4fv(uLineProjection, false, IDENTITY_MAT4);
      gl.enableVertexAttribArray(aLinePosition);
      gl.disableVertexAttribArray(aLineColor);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(uLineAlpha, MODEL_FLOW_ARROW_OPACITY);
      gl.bindBuffer(gl.ARRAY_BUFFER, modelFlowOverlayBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, dashes, gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(aLinePosition, 3, gl.FLOAT, false, 0, 0);
      gl.vertexAttrib3f(aLineColor, MODEL_FLOW_ARROW_DRAG_COLOR[0], MODEL_FLOW_ARROW_DRAG_COLOR[1], MODEL_FLOW_ARROW_DRAG_COLOR[2]);
      gl.drawArrays(gl.TRIANGLES, 0, dashes.length / 3);
      gl.disable(gl.BLEND);
      gl.uniform1f(uLineAlpha, 1.0);
    }

    // Point/junction dots — gated on showModelFlowPoints alone (independent
    // of "Show arrows"/showModelFlowArrow, which only covers the
    // ribbon/finalized-arrow lines themselves), covering two disjoint sets:
    // finalized arrows (below) and whichever branch is still being drawn
    // (further below, also requires draw mode). Shared uLineModelView/
    // uLineProjection/attrib setup, since both sections use the same
    // identity-projection NDC-marker technique.
    if (showModelFlowPoints && (unselectedPointLists.length > 0 || selectedPointList || (modelFlowDrawMode && modelFlowDrag && modelFlowDrag.points.length > 0))) {
      gl.uniformMatrix4fv(uLineModelView, false, IDENTITY_MAT4);
      gl.uniformMatrix4fv(uLineProjection, false, IDENTITY_MAT4);
      gl.enableVertexAttribArray(aLinePosition);
      gl.enableVertexAttribArray(aLineColor);

      // Finalized arrows: a point is inferred to be a (necessarily already
      // closed) junction purely by appearing in more than one path's own
      // points array — the exact same point object is shared across a
      // session's branches when one resumes from another (see
      // finalizeModelFlowDrag) — so no extra bookkeeping survives
      // finalizing an arrow, this is just reference-counting it back out.
      // Priority when a point qualifies as more than one (e.g. a junction
      // shift-clicked right before the branch it's on was itself finished
      // there): origin > junction > endpoint > plain.
      const finishedPathsPoints = selectedPointList ? [...unselectedPointLists, selectedPointList] : unselectedPointLists;
      if (finishedPathsPoints.length > 0) {
        const originRefs = new Set(finishedOriginPoints);
        const endpointRefs = new Set(finishedPathsPoints.map((points) => points[points.length - 1]));
        const refCounts = new Map();
        for (const points of finishedPathsPoints) {
          for (const p of points) {
            if (originRefs.has(p)) continue; // origin gets its own orange dot below, takes priority over the rest
            refCounts.set(p, (refCounts.get(p) || 0) + 1);
          }
        }
        const finishedPlainPoints = [];
        const finishedJunctionPoints = [];
        const finishedEndpointPoints = [];
        for (const [p, count] of refCounts) {
          if (count >= 2) finishedJunctionPoints.push(p);
          else if (endpointRefs.has(p)) finishedEndpointPoints.push(p);
          else finishedPlainPoints.push(p);
        }
        drawPointMarkerBatch(finishedPlainPoints, combined, MODEL_FLOW_POINT_RADIUS_PX, MODEL_FLOW_POINT_COLOR_CENTER, MODEL_FLOW_POINT_COLOR_EDGE);
        drawPointMarkerBatch(finishedJunctionPoints, combined, MODEL_FLOW_JUNCTION_RADIUS_PX, MODEL_FLOW_JUNCTION_CLOSED_COLOR_CENTER, MODEL_FLOW_JUNCTION_CLOSED_COLOR_EDGE);
        drawPointMarkerBatch(finishedEndpointPoints, combined, MODEL_FLOW_ENDPOINT_RADIUS_PX, MODEL_FLOW_ENDPOINT_COLOR_CENTER, MODEL_FLOW_ENDPOINT_COLOR_EDGE);
        drawPointMarkerBatch(finishedOriginPoints, combined, MODEL_FLOW_ORIGIN_RADIUS_PX, MODEL_FLOW_ORIGIN_COLOR_CENTER, MODEL_FLOW_ORIGIN_COLOR_EDGE);
      }

      // The arrow currently being drawn (see the draw-mode pointerdown
      // handler) — every point from every branch in this session, not just
      // the current one, so a closed-off junction's point stays visibly
      // marked while its sibling branch is being drawn. Only while draw
      // mode is on, so these never linger once nothing's actually mid-drag.
      if (modelFlowDrawMode && modelFlowDrag && modelFlowDrag.points.length > 0) {
        const unfinishedJunctionPoints = [
          ...modelFlowDrag.pendingJunctions.map((j) => j.point),
          // Still unfinished the moment it's resumed (popped off
          // pendingJunctions) and until the branch drawn from it actually
          // completes — see closedJunctions in finalizeModelFlowDrag.
          ...(modelFlowDrag.startingJunction && !modelFlowDrag.closedJunctions.includes(modelFlowDrag.startingJunction)
            ? [modelFlowDrag.startingJunction.point]
            : []),
        ];
        const closedJunctionPoints = modelFlowDrag.closedJunctions.map((j) => j.point);
        const junctionPointRefs = new Set([...unfinishedJunctionPoints, ...closedJunctionPoints]);

        // The session's one true source point: the very first point of the
        // very first branch (the one branch — current or already completed
        // — whose own startingJunction is null, i.e. it never resumed from
        // anywhere). Excluded below like the junctions, for its own black dot.
        const dragOriginBranch = modelFlowDrag.startingJunction === null
          ? modelFlowDrag
          : modelFlowDrag.completedBranches.find((b) => b.startingJunction === null);
        const dragOriginPoint = dragOriginBranch ? dragOriginBranch.points[0] : null;

        // Plain click points exclude junctions and the origin — those get
        // their own red/yellow/black dot below instead of a generic white one.
        const allDragPoints = modelFlowDrag.completedBranches
          .flatMap((b) => b.points)
          .concat(modelFlowDrag.points)
          .filter((p) => !junctionPointRefs.has(p) && p !== dragOriginPoint);

        drawPointMarkerBatch(allDragPoints, combined, MODEL_FLOW_POINT_RADIUS_PX, MODEL_FLOW_POINT_COLOR_CENTER, MODEL_FLOW_POINT_COLOR_EDGE);
        drawPointMarkerBatch(unfinishedJunctionPoints, combined, MODEL_FLOW_JUNCTION_RADIUS_PX, MODEL_FLOW_JUNCTION_UNFINISHED_COLOR_CENTER, MODEL_FLOW_JUNCTION_UNFINISHED_COLOR_EDGE);
        drawPointMarkerBatch(closedJunctionPoints, combined, MODEL_FLOW_JUNCTION_RADIUS_PX, MODEL_FLOW_JUNCTION_CLOSED_COLOR_CENTER, MODEL_FLOW_JUNCTION_CLOSED_COLOR_EDGE);
        drawPointMarkerBatch(dragOriginPoint ? [dragOriginPoint] : [], combined, MODEL_FLOW_ORIGIN_RADIUS_PX, MODEL_FLOW_ORIGIN_COLOR_CENTER, MODEL_FLOW_ORIGIN_COLOR_EDGE);
      }
    }

    // Pivot orb + floor guide (see buildPivotOrbNDC/buildDashedLineNDC
    // above): object-space location of the point drag/hover rotation and
    // zoom pivot around — the model's own center offset by the inverse of
    // the current pan (see getObjectSpacePan's comment for why that's the
    // pivot), or the active camera target's centroid when one's selected,
    // since that's what camera-target mode locks to screen-center instead.
    // Skipped outright while the panels are hidden (see panelsHidden) or
    // while photo/video mode is active — a presenter-facing dev aid, not
    // something that belongs in an otherwise clean shot or a captured
    // photo/video.
    if (!panelsHidden && !photoMode && !videoMode) {
      const activeTargetName = cameraTargetActiveIndex !== null ? cameraTargetSlots[cameraTargetActiveIndex] : null;
      const pivotObj = activeTargetName ? cameraTargetCurrent : [-panX / s, -panY / s, -panZ / s];
      gl.uniformMatrix4fv(uLineModelView, false, IDENTITY_MAT4);
      gl.uniformMatrix4fv(uLineProjection, false, IDENTITY_MAT4);

      // Dashed line down to the floor (object-space Y=0), skipped once the
      // pivot's basically already on it — a near-zero-length dashed line is
      // just visual noise.
      if (Math.abs(pivotObj[1]) > 1e-4) {
        const floorObj = [pivotObj[0], 0, pivotObj[2]];
        const dashes = buildDashedLineNDC(
          pivotObj, floorObj, combined, canvas.width, canvas.height,
          PIVOT_FLOOR_LINE_HALF_WIDTH_PX, PIVOT_FLOOR_DASH_LENGTH_PX, PIVOT_FLOOR_DASH_GAP_PX,
        );
        gl.bindBuffer(gl.ARRAY_BUFFER, pivotFloorLineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, dashes, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(aLinePosition);
        gl.vertexAttribPointer(aLinePosition, 3, gl.FLOAT, false, 0, 0);
        gl.disableVertexAttribArray(aLineColor);
        gl.vertexAttrib3f(aLineColor, PIVOT_FLOOR_LINE_COLOR[0], PIVOT_FLOOR_LINE_COLOR[1], PIVOT_FLOOR_LINE_COLOR[2]);
        gl.drawArrays(gl.TRIANGLES, 0, dashes.length / 3);
      }

      const cx = combined[0] * pivotObj[0] + combined[4] * pivotObj[1] + combined[8] * pivotObj[2] + combined[12];
      const cy = combined[1] * pivotObj[0] + combined[5] * pivotObj[1] + combined[9] * pivotObj[2] + combined[13];
      const cz = combined[2] * pivotObj[0] + combined[6] * pivotObj[1] + combined[10] * pivotObj[2] + combined[14];
      const orb = buildPivotOrbNDC([cx, cy, cz], canvas.width, canvas.height, PIVOT_ORB_RADIUS_PX);
      gl.bindBuffer(gl.ARRAY_BUFFER, pivotOrbBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, orb, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(aLinePosition);
      gl.vertexAttribPointer(aLinePosition, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(aLineColor);
      gl.vertexAttribPointer(aLineColor, 3, gl.FLOAT, false, 24, 12);
      gl.drawArrays(gl.TRIANGLES, 0, orb.length / 6);
    }
  }

  if (!IS_HERO) drawAxisGizmo(rx, ry);
}

// Dynamic resolution scaling: canvas's WebGL backing store renders at up to
// full native resolution (sharpest) by default, but the frame-time monitor
// (see updateDynamicRenderScale, driven from recordAndDisplayFrameTiming
// below) steps `renderScale` down when sustained frame time runs over the
// 60fps budget, and back up once there's sustained recovery — so quality
// only ever drops when the hardware genuinely can't keep up, never
// preemptively, and recovers automatically once it can again. Applied
// uniformly to both dimensions (see applyCanvasSize/resize) so it can never
// distort the aspect ratio updateCubeProjection is relying on.
const RENDER_SCALE_MIN = 0.5;
// Safety ceiling on the larger backing-store axis (e.g. a very large
// display at full DPR) — re-renders every frame, so an unbounded backing
// store costs real GPU time regardless of scene complexity. Scales both
// dimensions by the same factor when hit (see resize), so it can't distort
// aspect ratio the way clamping each axis independently would.
const CANVAS_MAX_DIMENSION = 4096;
let renderScale = 1;
let canvasBaseWidth = 0;
let canvasBaseHeight = 0;

function applyCanvasSize() {
  canvas.width = Math.max(1, Math.round(canvasBaseWidth * renderScale));
  canvas.height = Math.max(1, Math.round(canvasBaseHeight * renderScale));
}

// The larger axis of an export, in pixels — the other axis follows from the
// current viewport's own aspect ratio (window.innerWidth/innerHeight), so
// every export frames identically to whatever's on screen, just at a fixed
// resolution instead of whatever DPR/renderScale the live canvas happens to
// be running at. Shared by capturePhoto/captureVideo/capturePngSequence.
// Rounds to the nearest even integer — video codecs (AVC/HEVC, via WebCodecs)
// reject odd frame dimensions outright, and every other export path is
// indifferent to being off by at most 1px, so it's applied unconditionally
// rather than only for captureVideo.
function roundToEven(n) {
  return 2 * Math.round(n / 2);
}

function computeExportDimensions(maxDimension) {
  const aspect = window.innerWidth / window.innerHeight;
  return aspect >= 1
    ? { width: maxDimension, height: roundToEven(maxDimension / aspect) }
    : { width: roundToEven(maxDimension * aspect), height: maxDimension };
}

// Photo mode export (see photoMode/capturePhoto).
const PHOTO_EXPORT_MAX_DIMENSION = 3840;
// Cmd/Ctrl+Enter variant (see the keydown handler above) — same shot, just
// rendered at double the long-edge resolution for when 4K isn't enough
// (e.g. printing, or heavy cropping). Well within typical GPU renderbuffer
// limits (usually 16384px), so no extra capping is needed here.
const PHOTO_EXPORT_MAX_DIMENSION_2X = PHOTO_EXPORT_MAX_DIMENSION * 2;

// Gates the transparent clear in renderCubeFrame (see there) — true only for
// the single export-resolution frame capturePhoto renders, never for the
// live view or the restore-to-live-resolution frame right after, so the
// canvas on screen keeps its normal opaque background and only the
// downloaded PNG comes out with alpha.
let capturingTransparentPhoto = false;

// Half-width in device pixels at PHOTO_EXPORT_MAX_DIMENSION's long edge —
// renderCubeFrame scales this by (actual export long edge / that reference)
// so the line reads the same relative thickness regardless of which
// maxDimension a given capture renders at, rather than a flat pixel count
// that would look thinner the higher the export resolution goes (the exact
// bug this whole ribbon path exists to avoid). User-adjustable via the
// panel's line-width slider (setPhotoLineWidthHalfPx), shown only while
// photoUniformLineWidth is on.
const PHOTO_LINE_WIDTH_HALF_PX_MIN = 0.5;
const PHOTO_LINE_WIDTH_HALF_PX_MAX = 5;
let photoLineWidthHalfPx = restoreNumber('photoLineWidthHalfPx', 1.5);

function setPhotoLineWidthHalfPx(value) {
  photoLineWidthHalfPx = value;
  persistNumber('photoLineWidthHalfPx', value);
}

// Temporarily renders one frame at maxDimension resolution (long edge; see
// PHOTO_EXPORT_MAX_DIMENSION/PHOTO_EXPORT_MAX_DIMENSION_2X) and downloads it
// as a PNG, then restores the live backing-store size. Resizing
// `canvas.width`/`height` (rather than adding a separate offscreen canvas)
// keeps this on the exact same draw path — gl.viewport in renderCubeFrame
// reads canvas.width/height directly — and since the target keeps the
// current window's aspect ratio, cubeProjectionHalfX/Y (set for that same
// aspect by the last resize()) are already correct with no need to
// recompute them.
//
// canvas.toBlob snapshots the drawing buffer synchronously at the moment
// it's called (the actual PNG encode happens async, off that snapshot) —
// gl was created without preserveDrawingBuffer, so this only works because
// the resize-back below runs after that synchronous snapshot, not before.
//
// The wireframe's line-width behavior (plain gl.LINES vs the constant-
// pixel-width ribbon) isn't decided here — renderCubeFrame reads the panel's
// live photoUniformLineWidth switch on every frame, capture included, so
// whatever the live view was already previewing is exactly what gets
// exported.
function capturePhoto(maxDimension = PHOTO_EXPORT_MAX_DIMENSION) {
  const { width, height } = computeExportDimensions(maxDimension);
  canvas.width = width;
  canvas.height = height;
  capturingTransparentPhoto = true;
  renderCubeFrame();
  capturingTransparentPhoto = false;

  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `bluprint-model-${Date.now()}.png`;
    link.click();
    URL.revokeObjectURL(url);
  }, 'image/png');

  // Back to the live resolution immediately, so nothing looks broken on the
  // next composite — see the function comment above for why this is safe to
  // do before the async encode above has actually finished.
  applyCanvasSize();
  renderCubeFrame();
}

// Video mode export (see videoMode/captureVideo): fixed clip length,
// resolution, and frame rate for every capture. Kept as its own constants
// rather than reusing PNG_SEQUENCE_MAX_DIMENSION (below) so the two can be
// tuned independently — neither export's *performance* depends on this
// resolution anymore (see captureVideo's own comment), so this is just a
// quality choice.
// Fixed UHD 4K 16:9, unlike capturePhoto/capturePngSequence which match
// whatever aspect ratio the current window happens to be — a deliverable
// video benefits from a standard, predictable frame size more than it does
// from matching the live viewport.
const VIDEO_EXPORT_WIDTH = 3840;
const VIDEO_EXPORT_HEIGHT = 2160;
// The tilt loop (see advanceVideoTilt) always takes exactly this long, so
// this is also what sets its angular speed — raising it both lengthens the
// clip and slows the circling motion down, same lever for both. Shared by
// capturePngSequence too, for the same loop-length/frame-count math, even
// though neither export is actually bound to wall-clock time (see
// captureVideo's own comment).
const VIDEO_EXPORT_DURATION_MS = 10000;
const VIDEO_EXPORT_FPS = 60;
// ~64 Mbps — scaled up from the ~16 Mbps that was right for 1080p60 to match
// 4K60's 4x pixel count, so per-frame quality doesn't come out softer just
// because the frame is bigger.
const VIDEO_EXPORT_BITS_PER_SECOND = 64_000_000;

// True only while a captureVideo() or capturePngSequence() export is in
// flight. Checked by resize() so a mid-export window resize can't shift
// cubeProjectionHalfX/Y (and so the framing), or clobber the fixed
// canvas.width/height either export forces for its duration.
let videoExportInProgress = false;

// Encodes directly to a real MP4 via WebCodecs (through Mediabunny — see the
// import at the top of this file) instead of MediaRecorder+captureStream.
// The original real-time version of this function recorded a live
// captureStream while the ambient render loop kept running — which meant
// racing a hard ~16.7ms/frame deadline against however long rendering,
// scaling, and hardware-encoding a frame actually took, and silently
// repeating a stale frame (audible/visible stutter) whenever it lost that
// race. Rendering itself is no longer the bottleneck that made it lose (see
// git history — captureVideo used to blit a cheap live-res frame up to
// export resolution for exactly that reason), but a *guarantee* of zero
// dropped/duplicated frames can't come from a real-time pipeline at all, no
// matter how fast each piece is — there's always some slow machine/frame
// that blows the deadline.
//
// This version sidesteps the deadline entirely, the same way
// capturePngSequence already does: step through frames one at a time with an
// explicit, evenly-spaced timestamp (i / VIDEO_EXPORT_FPS seconds) instead of
// a real-clock one, rendering each directly onto the live WebGL canvas at
// full export resolution and handing it to Mediabunny's CanvasSource, which
// wraps WebCodecs' VideoEncoder. Its default latencyMode ('quality', not
// 'realtime') is documented to never drop a frame — encoding just takes as
// long as it takes per frame, with no deadline riding on it. A slow machine
// makes the export take longer in wall-clock time; it can no longer make the
// output choppier.
async function captureVideo() {
  if (videoRecording || pngSequenceExporting) return;
  // Claimed synchronously, before the async codec detection below — codec
  // detection awaits a promise, and without this a rapid second Enter press
  // during that gap would sail past the guard above (still false at that
  // point) and start a second, concurrent export fighting this one over the
  // same canvas.
  videoRecording = true;

  const width = VIDEO_EXPORT_WIDTH;
  const height = VIDEO_EXPORT_HEIGHT;
  // In preference order: H.264 first, since it's the format most readily
  // droppable straight into a deck/editor without transcoding; VP9/AV1 as
  // fallbacks for browsers that can't encode it. All three are valid inside
  // Mp4OutputFormat.
  //
  // AVC is checked twice: once with hardwareAcceleration forced, because
  // without that hint WebCodecs can silently pick a software AVC encoder
  // that caps out well below this function's ~4K export size (Level 4.1,
  // ~1920x1088) and report "can't encode avc" — which used to fall through
  // to VP9, a codec Premiere Pro/Media Encoder can't open even inside an mp4
  // container. But forcing hardwareAcceleration on *every* codec in one call
  // is wrong: most GPUs expose hardware AVC encode but not hardware VP9/AV1,
  // so that would make the whole lookup fail (and this function silently
  // bail) on any machine whose only hardware encoder is AVC. So: try AVC
  // hardware-only first, then fall back to the original unconstrained
  // detection across all three if that didn't pan out.
  let codec = await getFirstEncodableVideoCodec(['avc'], {
    width,
    height,
    hardwareAcceleration: 'prefer-hardware',
  });
  const hardwareAvc = codec === 'avc';
  if (!codec) {
    codec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { width, height });
  }
  if (!codec) {
    videoRecording = false;
    return;
  }

  canvas.width = width;
  canvas.height = height;
  // Unlike capturePhoto/capturePngSequence (which keep the live window's own
  // aspect ratio, so cubeProjectionHalfX/Y already match), this export's
  // fixed 16:9 frame generally doesn't match the window — recompute the
  // projection for it here, and back to the window's own aspect in the
  // resize() call during cleanup below.
  updateCubeProjection(width / height);
  videoExportInProgress = true;
  cubeRotResetStartTime = null; // hand cubeParallaxX/Y to this function's own advanceVideoTilt calls below
  notifyModelState(); // drives the panel's video-mode indicator into its "Recording…" text

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const videoSource = new CanvasSource(canvas, {
    codec,
    quality: new Quality({ bitrate: VIDEO_EXPORT_BITS_PER_SECOND }),
    ...(hardwareAvc ? { hardwareAcceleration: 'prefer-hardware' } : {}),
  });
  output.addVideoTrack(videoSource);
  await output.start();

  // Deliberately i < totalFrames, never reaching t=1 — that would duplicate
  // t=0's frame, which is what a *player* looping this file back-to-back
  // already does implicitly; an explicit duplicate would just show up as a
  // held/stuttered frame at the seam. (capturePngSequence, exporting loose
  // files rather than a file a player loops for you, deliberately makes the
  // opposite choice — see its own comment.)
  const totalFrames = Math.round((VIDEO_EXPORT_DURATION_MS / 1000) * VIDEO_EXPORT_FPS);
  const frameDuration = 1 / VIDEO_EXPORT_FPS;
  for (let i = 0; i < totalFrames; i++) {
    advanceVideoTilt(i / totalFrames);
    renderCubeFrame();
    await videoSource.add(i * frameDuration, frameDuration);
  }
  videoSource.close();
  await output.finalize();

  videoExportInProgress = false;
  videoRecording = false;
  // Same reasoning as capturePngSequence's own cleanup: ease back to the
  // neutral framed angle now that advanceVideoTilt no longer owns
  // cubeParallaxX/Y, so a retake starts clean.
  resetCubeRotation();
  // videoExportInProgress is already false at this point, so this runs its
  // full body — restoring canvas size *and* cubeProjectionHalfX/Y to the
  // live window's own aspect, undoing the fixed 16:9 projection set above.
  resize();
  renderCubeFrame();

  const url = URL.createObjectURL(new Blob([output.target.buffer], { type: 'video/mp4' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `bluprint-model-${Date.now()}.mp4`;
  link.click();
  URL.revokeObjectURL(url);

  notifyModelState();
}

// --- PNG sequence export ----------------------------------------------
//
// Cmd/Ctrl+Enter while video mode is active (see the keydown handler above)
// — an alternative to captureVideo() for manually assembling the clip
// yourself (ffmpeg, an NLE, whatever) instead of getting a ready-made MP4.
// Same frame-by-frame, non-real-time approach captureVideo now uses (see its
// own comment) — renders, captures, and packs one frame at a time, awaiting
// each PNG encode before starting the next — just producing loose files
// instead of a muxed video.

// Its own constant rather than reusing VIDEO_EXPORT_WIDTH/HEIGHT so the two
// stay independently tunable — this one still follows the window's own
// aspect ratio (see computeExportDimensions), unlike the fixed-16:9 video
// export.
const PNG_SEQUENCE_MAX_DIMENSION = 3840; // UHD 4K, long edge

// CRC-32 (the zlib/PNG/ZIP polynomial) — the one piece of real "format" math
// a ZIP entry needs; everything else below is just byte layout.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function capturePngSequence() {
  if (videoRecording || pngSequenceExporting) return;

  const { width, height } = computeExportDimensions(PNG_SEQUENCE_MAX_DIMENSION);
  canvas.width = width;
  canvas.height = height;

  pngSequenceExporting = true;
  pngSequenceProgress = 0;
  videoExportInProgress = true; // freezes resize(), same protection a captureVideo() recording gets
  cubeRotResetStartTime = null; // hand cubeParallaxX/Y to this function's own advanceVideoTilt calls below
  notifyModelState(); // drives the panel's video-mode indicator into its "Exporting…" text

  const loopFrames = Math.round((VIDEO_EXPORT_DURATION_MS / 1000) * VIDEO_EXPORT_FPS);
  // One extra frame beyond a full loop's worth (loopFrames), so the sequence
  // explicitly closes on itself: frame 0's t=0 and frame loopFrames's t=1
  // land on the exact same point on the circle (cos/sin are periodic), so
  // the first and last files in the sequence share the same tilt position —
  // useful for confirming the loop closes cleanly, or for tooling that
  // expects an explicit closing frame rather than inferring the wrap.
  const totalFrames = loopFrames + 1;
  const parts = []; // local file header + name + data, per frame, in file order — fed straight into the final Blob
  const centralDirectory = []; // { nameBytes, crc, size, offset } per frame, for the trailer written after the loop
  let offset = 0;

  for (let i = 0; i < totalFrames; i++) {
    advanceVideoTilt(i / loopFrames);
    renderCubeFrame();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const nameBytes = new TextEncoder().encode(`frame-${String(i).padStart(4, '0')}.png`);
    const crc = crc32(bytes);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true); // version needed to extract
    local.setUint16(6, 0, true); // general purpose bit flag
    local.setUint16(8, 0, true); // compression method: 0 = store
    local.setUint16(10, 0, true); // last mod file time — not meaningful for a synthetic export, left zeroed
    local.setUint16(12, 0, true); // last mod file date
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true); // compressed size == uncompressed size, store method
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true); // extra field length
    parts.push(new Uint8Array(local.buffer), nameBytes, bytes);
    centralDirectory.push({ nameBytes, crc, size: bytes.length, offset });
    offset += 30 + nameBytes.length + bytes.length;

    pngSequenceProgress = (i + 1) / totalFrames;
    notifyModelState();
  }

  // Central directory: one 46-byte record per frame, pointing back at that
  // frame's local header offset above — standard ZIP trailer layout.
  const centralDirStart = offset;
  for (const entry of centralDirectory) {
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); // central file header signature
    central.setUint16(4, 20, true); // version made by
    central.setUint16(6, 20, true); // version needed to extract
    central.setUint16(8, 0, true); // general purpose bit flag
    central.setUint16(10, 0, true); // compression method
    central.setUint16(12, 0, true); // last mod file time
    central.setUint16(14, 0, true); // last mod file date
    central.setUint32(16, entry.crc, true);
    central.setUint32(20, entry.size, true);
    central.setUint32(24, entry.size, true);
    central.setUint16(28, entry.nameBytes.length, true);
    central.setUint16(30, 0, true); // extra field length
    central.setUint16(32, 0, true); // file comment length
    central.setUint16(34, 0, true); // disk number start
    central.setUint16(36, 0, true); // internal file attributes
    central.setUint32(38, 0, true); // external file attributes
    central.setUint32(42, entry.offset, true); // relative offset of local header
    parts.push(new Uint8Array(central.buffer), entry.nameBytes);
    offset += 46 + entry.nameBytes.length;
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory signature
  end.setUint16(4, 0, true); // number of this disk
  end.setUint16(6, 0, true); // disk where central directory starts
  end.setUint16(8, centralDirectory.length, true); // central directory records on this disk
  end.setUint16(10, centralDirectory.length, true); // total central directory records
  end.setUint32(12, offset - centralDirStart, true); // size of central directory
  end.setUint32(16, centralDirStart, true); // offset of start of central directory
  end.setUint16(20, 0, true); // comment length
  parts.push(new Uint8Array(end.buffer));

  const url = URL.createObjectURL(new Blob(parts, { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `bluprint-model-frames-${Date.now()}.zip`;
  link.click();
  URL.revokeObjectURL(url);

  videoExportInProgress = false;
  pngSequenceExporting = false;
  // Same reasoning as captureVideo's onstop: ease back to the neutral framed
  // angle now that advanceVideoTilt no longer owns cubeParallaxX/Y, so a
  // retake starts clean.
  resetCubeRotation();
  applyCanvasSize();
  renderCubeFrame();
  notifyModelState();
}

function resize() {
  // Set for the duration of both captureVideo() and capturePngSequence() —
  // both render directly onto the live WebGL canvas at a fixed export
  // resolution for their whole export. A real window resize mid-export would
  // both change cubeProjectionHalfX/Y (and so the framing) partway through,
  // and clobber that fixed canvas.width/height outright.
  if (videoExportInProgress) return;
  // canvas.clientWidth/Height (the element's own actual CSS-rendered box),
  // not window.innerWidth/innerHeight — those two are usually the same, but
  // diverge on iOS Safari while the bottom URL bar auto-hides/shows during a
  // scroll: window.innerHeight tracks that animation's live layout-viewport
  // state, while the canvas's own CSS box (100vw/100vh) does not update on
  // the same schedule. Using window.innerHeight here made the projection's
  // aspect ratio momentarily disagree with the canvas's real on-screen box
  // every time the bar moved, which read as the model visibly stretching.
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  const rawWidth = Math.round(cssWidth * DPR);
  const rawHeight = Math.round(cssHeight * DPR);
  const capScale = Math.min(1, CANVAS_MAX_DIMENSION / Math.max(rawWidth, rawHeight));
  canvasBaseWidth = Math.round(rawWidth * capScale);
  canvasBaseHeight = Math.round(rawHeight * capScale);
  applyCanvasSize();
  // Aspect comes from the CSS/display size, not the (possibly capped or
  // render-scaled) backing store — capScale and renderScale both apply
  // uniformly to width and height, so the backing store's aspect always
  // matches this regardless of either one.
  updateCubeProjection(cssWidth / cssHeight);
  // Depends on the cubeProjectionHalfY updateCubeProjection just set, so
  // this has to run after it, not before.
  updateHeroVerticalBias();
  updateScrollMobileVerticalBias();
}

// A pixel counts as "mainly green" if that channel is dominant by a clear
// margin — avoids flagging grays/whites where channels are close. Used to
// detect green materials on the loaded model (see parseObj) and to shade
// blueprint mode's green-flagged parts.
const GREEN_DOMINANCE_MARGIN = 20;

function isGreenDominant(r, g, b) {
  return g - r > GREEN_DOMINANCE_MARGIN && g - b > GREEN_DOMINANCE_MARGIN;
}

// Maps a material name to one of the shader's technical-fill patterns (see
// aFillPattern / fillPatternUV) by name rather than by color, so it doesn't
// collide with GREEN_DOMINANCE_MARGIN or any other color-based rule — in
// Blender, assign the target face(s) a material named "Hatch", "Dot"
// (or "Dots"), or "Plus" (or "Cross") — case-insensitive, and tolerant of
// Blender's ".001"-style de-dupe suffixes — and it'll come through here as
// pattern 1, 2, or 3 respectively; anything else is 0 (no fill pattern).
// Each has its own frequency (and, for dots/plus, size) control, but all
// three share the same fill color — see uHatchLineColor.
function materialFillPatternId(name) {
  // Blender appends ".001", ".002", etc. to de-duplicate material names when
  // appending/merging scenes that each define their own "Hatch"/"Dot"/"Plus"
  // material — strip that suffix before matching so e.g. a merged file's
  // "Hatch.003" still resolves the same as a plain "Hatch".
  const trimmed = name.trim().toLowerCase().replace(/\.\d{3}$/, '');
  if (trimmed === 'hatch') return 1;
  if (trimmed === 'dot' || trimmed === 'dots') return 2;
  if (trimmed === 'plus' || trimmed === 'cross') return 3;
  return 0;
}

// Faces using a material named "Target" (case-insensitive, tolerant of
// Blender's ".001"-style de-dupe suffixes — same convention as
// materialFillPatternId above) are modeling-only placeholders: a cube dropped
// into the scene purely so its object bounding box (see the `objects` array
// built in parseObj, which feeds the Camera Target / /scroll sizing) can be
// positioned and scaled by hand, without needing to actually show up on
// screen. parseObj skips pushing render/wireframe data for these faces while
// still recording their object's bounds.
function isTargetMaterial(name) {
  return name.trim().toLowerCase().replace(/\.\d{3}$/, '') === 'target';
}

// FPS/frame-time overlay (top-center, see #perf-monitor in index.html).
// Written straight to the DOM via textContent rather than through the React
// panel/state, since that updates every frame — funneling it through React
// state would mean a full component re-render 60 times a second for a
// display the panel itself has no other reason to know about.
// #perf-monitor doesn't exist in the hero build's HTML — gated the same way
// as the axis gizmo above (see its comment). recordAndDisplayFrameTiming
// below still runs updateDynamicRenderScale for both builds (a genuine perf
// feature, not just a dev overlay); only the DOM-writing/sparkline part is
// hero-excluded.
const perfMonitorEl = IS_HERO ? null : document.getElementById('perf-monitor-text');
const PERF_DISPLAY_UPDATE_MS = 250; // readable refresh rate; measurement itself is still per-frame
let perfLastFrameTime = performance.now();
let perfFrameCount = 0;
let perfFrameTimeSum = 0;
let perfLastDisplayUpdate = perfLastFrameTime;

// Rolling FPS sparkline (last 10s) — one point per display update, so a
// dropped-frame stretch shows up as a visible dip instead of getting
// smoothed away by the running min/max text above it.
const perfHistoryCanvas = IS_HERO ? null : document.getElementById('perf-history');
const perfHistoryCtx = IS_HERO ? null : perfHistoryCanvas.getContext('2d');
const PERF_HISTORY_WINDOW_MS = 10000;
// Shared by drawPerfHistory's dashed reference line and its below-target red
// dots, so both read against the same fps line.
const PERF_HISTORY_TARGET_FPS = 45;
const PERF_HISTORY_DPR = Math.max(1, window.devicePixelRatio || 1);
if (!IS_HERO) {
  perfHistoryCanvas.width = perfHistoryCanvas.clientWidth * PERF_HISTORY_DPR || perfHistoryCanvas.width;
  perfHistoryCanvas.height = perfHistoryCanvas.clientHeight * PERF_HISTORY_DPR || perfHistoryCanvas.height;
}
let perfHistory = []; // { time, fps }[], oldest first

function drawPerfHistory() {
  const w = perfHistoryCanvas.width;
  const h = perfHistoryCanvas.height;
  perfHistoryCtx.clearRect(0, 0, w, h);
  if (perfHistory.length < 2) return;

  const now = perfHistory[perfHistory.length - 1].time;
  const windowStart = now - PERF_HISTORY_WINDOW_MS;
  // Ceiling follows the session's peak (at least 60, independent of
  // PERF_HISTORY_TARGET_FPS below) so the chart stays meaningful on both
  // capped-60 and high-refresh displays, while a fixed floor of 0 keeps drop
  // severity visually comparable.
  const ceiling = Math.max(60, perfMaxFps === -Infinity ? 60 : perfMaxFps);
  const x = (t) => ((t - windowStart) / PERF_HISTORY_WINDOW_MS) * w;
  const y = (fps) => h - (Math.min(fps, ceiling) / ceiling) * h;

  // Target reference line — shared with the below-target dot threshold
  // further down, so both read against the same fps line.
  perfHistoryCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  perfHistoryCtx.lineWidth = 1;
  perfHistoryCtx.setLineDash([2 * PERF_HISTORY_DPR, 2 * PERF_HISTORY_DPR]);
  perfHistoryCtx.beginPath();
  const targetY = Math.round(y(PERF_HISTORY_TARGET_FPS)) + 0.5;
  perfHistoryCtx.moveTo(0, targetY);
  perfHistoryCtx.lineTo(w, targetY);
  perfHistoryCtx.stroke();
  perfHistoryCtx.setLineDash([]);

  // Filled area under the line, tinted red wherever a point drops below
  // the target — the fill (not just the line) is what makes a brief dip
  // readable at a glance in a 140x32 sparkline.
  perfHistoryCtx.beginPath();
  perfHistoryCtx.moveTo(x(perfHistory[0].time), h);
  for (const point of perfHistory) perfHistoryCtx.lineTo(x(point.time), y(point.fps));
  perfHistoryCtx.lineTo(x(perfHistory[perfHistory.length - 1].time), h);
  perfHistoryCtx.closePath();
  perfHistoryCtx.fillStyle = 'rgba(120, 220, 255, 0.18)';
  perfHistoryCtx.fill();

  perfHistoryCtx.lineWidth = 1.5 * PERF_HISTORY_DPR;
  perfHistoryCtx.lineJoin = 'round';
  perfHistoryCtx.beginPath();
  perfHistory.forEach((point, i) => {
    const px = x(point.time);
    const py = y(point.fps);
    if (i === 0) perfHistoryCtx.moveTo(px, py);
    else perfHistoryCtx.lineTo(px, py);
  });
  perfHistoryCtx.strokeStyle = 'rgba(120, 220, 255, 0.9)';
  perfHistoryCtx.stroke();

  // Mark every sample below the target line above with a dot, so a single
  // bad frame is still visible in a sparkline this dense.
  perfHistoryCtx.fillStyle = 'rgba(255, 90, 90, 0.9)';
  for (const point of perfHistory) {
    if (point.fps >= PERF_HISTORY_TARGET_FPS) continue;
    perfHistoryCtx.beginPath();
    perfHistoryCtx.arc(x(point.time), y(point.fps), 1.5 * PERF_HISTORY_DPR, 0, Math.PI * 2);
    perfHistoryCtx.fill();
  }
}
// Session-long min/max (since page load), shown next to each current
// reading so a viewer can see the actual observed range, not just the
// instantaneous value — e.g. a brief stall during a model upload shows up
// as a low FPS / high ms bound that persists rather than disappearing on
// the next display refresh.
let perfMinFps = Infinity;
let perfMaxFps = -Infinity;
let perfMinMs = Infinity;
let perfMaxMs = -Infinity;

// Drives renderScale (see applyCanvasSize/resize above): steps resolution
// down after a sustained run of over-budget display windows, steps it back
// up after a longer sustained run of meeting-or-beating the 60fps target
// within RENDER_SCALE_RECOVER_MULT's small tolerance (recovering more
// cautiously than it drops — a longer sustained window, not a stricter
// frame-time margin — so it doesn't flap between two resolutions right at
// the boundary). That tolerance matters: a vsync-capped 60Hz display can
// never report a frame time measurably *faster* than the target, so a
// strict "<" comparison here left a healthy 60fps session stuck in a dead
// zone that never counted toward recovery once scale had already dropped
// (see RENDER_SCALE_RECOVER_MULT's own comment). The first few windows
// after load are ignored — first paint/shader compile is a one-off cost,
// not a sign the hardware can't sustain 60fps once warmed up.
const TARGET_FRAME_MS = 1000 / 60;
// Recovery's "under budget" check allows frame time up to this multiple of
// TARGET_FRAME_MS, not just strictly faster than it — a display vsync-capped
// at 60Hz can never report avgFrameMs *below* ~16.667ms (scheduling overhead
// usually pushes it a hair above, never below), so requiring strictly "<
// TARGET_FRAME_MS" meant a perfectly healthy 60fps session could never
// accumulate enough under-budget windows to recover once renderScale had
// dropped — it would just sit in the dead zone between this check and the
// 1.15x drop threshold below, resetting both counters forever. This margin
// only needs to comfortably clear vsync/measurement jitter, not open up a
// wide "good enough" band.
const RENDER_SCALE_RECOVER_MULT = 1.05;
const RENDER_SCALE_STEP = 0.1;
const RENDER_SCALE_DOWN_WINDOWS = 2; // ~500ms over budget before dropping resolution
const RENDER_SCALE_UP_WINDOWS = 8; // ~2s at/under target before restoring it
const RENDER_SCALE_WARMUP_WINDOWS = 4; // ~1s ignored after load
let perfWindowCount = 0;
let overBudgetWindows = 0;
let underBudgetWindows = 0;

function updateDynamicRenderScale(avgFrameMs) {
  // No explicit videoExportInProgress guard needed here: this is only ever
  // reached via recordAndDisplayFrameTiming, which renderLoop stops calling
  // entirely for the whole duration of a captureVideo()/capturePngSequence()
  // export (see renderLoop's own check) — so by the time either export is
  // forcing its own fixed canvas.width/height, this function simply isn't
  // running at all to fight it.
  perfWindowCount++;
  if (perfWindowCount <= RENDER_SCALE_WARMUP_WINDOWS) return;

  if (avgFrameMs > TARGET_FRAME_MS * 1.15) {
    overBudgetWindows++;
    underBudgetWindows = 0;
  } else if (avgFrameMs <= TARGET_FRAME_MS * RENDER_SCALE_RECOVER_MULT) {
    underBudgetWindows++;
    overBudgetWindows = 0;
  } else {
    overBudgetWindows = 0;
    underBudgetWindows = 0;
  }

  if (overBudgetWindows >= RENDER_SCALE_DOWN_WINDOWS && renderScale > RENDER_SCALE_MIN) {
    renderScale = Math.max(RENDER_SCALE_MIN, renderScale - RENDER_SCALE_STEP);
    applyCanvasSize();
    overBudgetWindows = 0;
  } else if (underBudgetWindows >= RENDER_SCALE_UP_WINDOWS && renderScale < 1) {
    renderScale = Math.min(1, renderScale + RENDER_SCALE_STEP);
    applyCanvasSize();
    underBudgetWindows = 0;
  }
}

function recordAndDisplayFrameTiming(now) {
  // The initial call below (`renderLoop()`, ahead of the rAF-driven ones)
  // passes no timestamp — fall back to performance.now() so that first
  // frame doesn't compute a NaN delta.
  now = now ?? performance.now();
  const frameMs = now - perfLastFrameTime;
  perfLastFrameTime = now;
  perfFrameCount++;
  perfFrameTimeSum += frameMs;

  if (now - perfLastDisplayUpdate >= PERF_DISPLAY_UPDATE_MS) {
    const avgFrameMs = perfFrameTimeSum / perfFrameCount;
    const fps = 1000 / avgFrameMs;
    perfMinFps = Math.min(perfMinFps, fps);
    perfMaxFps = Math.max(perfMaxFps, fps);
    perfMinMs = Math.min(perfMinMs, avgFrameMs);
    perfMaxMs = Math.max(perfMaxMs, avgFrameMs);
    updateDynamicRenderScale(avgFrameMs);
    if (!IS_HERO) {
      perfMonitorEl.textContent =
        `${Math.round(renderScale * 100)}% res\n` +
        `${avgFrameMs.toFixed(1)} ms (${perfMinMs.toFixed(1)}–${perfMaxMs.toFixed(1)})\n` +
        `${fps.toFixed(0)} FPS (${perfMinFps.toFixed(0)}–${perfMaxFps.toFixed(0)})`;

      perfHistory.push({ time: now, fps });
      const historyStart = now - PERF_HISTORY_WINDOW_MS;
      while (perfHistory.length > 0 && perfHistory[0].time < historyStart) perfHistory.shift();
      drawPerfHistory();
    }

    perfLastDisplayUpdate = now;
    perfFrameCount = 0;
    perfFrameTimeSum = 0;
  }
}

function renderLoop(now) {
  if (videoRecording || pngSequenceExporting) {
    // captureVideo()/capturePngSequence() own canvas.width/height and
    // cubeParallaxX/Y exclusively for the whole export (see their own
    // comments) — the ambient loop just idles rather than fighting either
    // one, and picks back up on its own once the export flips this back off.
    requestAnimationFrame(renderLoop);
    return;
  }
  renderCubeFrame();
  recordAndDisplayFrameTiming(now);
  requestAnimationFrame(renderLoop);
}

// --- Init -----------------------------------------------------------------

window.addEventListener('resize', resize);
resize();
renderLoop();
if (IS_BATTERY_ROUTE) loadBundledBatteryModel();
else loadBundledDefaultModel();

// --- React control panel bridge --------------------------------------------
//
// The one seam between this module (plain WebGL/canvas state) and the
// control panel (src/panel.tsx, a React/coss-ui component tree that owns its
// own UI state). `getInitialState` seeds the panel on mount; `subscribe`
// delivers changes this module makes on its own (a model finishing upload
// flips `customModelReady`/`cubeModelStatus`); the rest are the setters the
// panel calls in response to user interaction.
export const controls = {
  getInitialState() {
    return {
      // Fixed across the page's lifetime (see IS_SCROLL_ROUTE's own
      // declaration) — read once here rather than threaded through
      // getModelState/notifyModelState, since it never changes after mount.
      // Panel.tsx uses it to hide the photo/video mode indicator pills
      // entirely on the /scroll route, where P/V are wired up to nothing.
      isScrollRoute: IS_SCROLL_ROUTE,
      // Same "fixed across the page's lifetime" treatment — panel.tsx uses
      // this to keep the control panel permanently hidden with no H-key
      // escape hatch, see IS_PREVIEW_ROUTE's own comment above.
      isPreviewRoute: IS_PREVIEW_ROUTE,
      // Same again — panel.tsx only offers "Load NGEN battery" on /battery.
      isBatteryRoute: IS_BATTERY_ROUTE,
      pulseWidth: pulseWidthValue,
      flowPulseFrequency: flowPulseFrequencyValue,
      flowPulseFrequencyMin: FLOW_PULSE_FREQUENCY_MIN,
      flowPulseFrequencyMax: FLOW_PULSE_FREQUENCY_MAX,
      flowSpeed: flowSpeedPercent,
      flowSpeedMin: FLOW_SPEED_MIN,
      flowSpeedMax: FLOW_SPEED_MAX,
      flowCoreLength: flowCoreLengthPercent,
      flowCoreLengthMin: FLOW_CORE_LENGTH_MIN,
      flowCoreLengthMax: FLOW_CORE_LENGTH_MAX,
      flowTailVisible,
      flowTailLength: flowTailLengthPercent,
      flowTailLengthMin: FLOW_TAIL_LENGTH_MIN,
      flowTailLengthMax: FLOW_TAIL_LENGTH_MAX,
      flowTailFalloff: flowTailFalloffValue,
      flowTailFalloffMin: FLOW_TAIL_FALLOFF_MIN,
      flowTailFalloffMax: FLOW_TAIL_FALLOFF_MAX,
      cubeSize: cubeSizePercent,
      cubeSizeMin: CUBE_SIZE_MIN,
      cubeSizeMax: CUBE_SIZE_MAX,
      modelOffsetX: modelOffsetXPercent,
      modelOffsetY: modelOffsetYPercent,
      modelOffsetMin: MODEL_POSITION_MIN,
      modelOffsetMax: MODEL_POSITION_MAX,
      lightAzimuth: lightAzimuthValue,
      lightElevation: lightElevationValue,
      lightAzimuthMin: LIGHT_AZIMUTH_MIN,
      lightAzimuthMax: LIGHT_AZIMUTH_MAX,
      lightElevationMin: LIGHT_ELEVATION_MIN,
      lightElevationMax: LIGHT_ELEVATION_MAX,
      lightIntensity: lightIntensityPercent,
      lightIntensityMin: LIGHT_INTENSITY_MIN,
      lightIntensityMax: LIGHT_INTENSITY_MAX,
      blueprintEnabled,
      shaderTheme,
      lineFrequency: lineFrequencyValue,
      lineFrequencyMin: LINE_FREQUENCY_MIN,
      lineFrequencyMax: LINE_FREQUENCY_MAX,
      dotFrequency: dotFrequencyValue,
      dotFrequencyMin: DOT_FREQUENCY_MIN,
      dotFrequencyMax: DOT_FREQUENCY_MAX,
      dotSize: dotSizePercent,
      dotSizeMin: DOT_SIZE_MIN,
      dotSizeMax: DOT_SIZE_MAX,
      plusFrequency: plusFrequencyValue,
      plusFrequencyMin: PLUS_FREQUENCY_MIN,
      plusFrequencyMax: PLUS_FREQUENCY_MAX,
      plusSize: plusSizePercent,
      plusSizeMin: PLUS_SIZE_MIN,
      plusSizeMax: PLUS_SIZE_MAX,
      photoLineWidthHalfPx,
      photoLineWidthHalfPxMin: PHOTO_LINE_WIDTH_HALF_PX_MIN,
      photoLineWidthHalfPxMax: PHOTO_LINE_WIDTH_HALF_PX_MAX,
      hoverMovementPaused,
      rotationDisabled,
      showModelFlowPoints,
      ...getModelState(),
    };
  },
  subscribe(listener) {
    modelStateListeners.push(listener);
    return () => {
      const i = modelStateListeners.indexOf(listener);
      if (i !== -1) modelStateListeners.splice(i, 1);
    };
  },
  setPulseWidth,
  setFlowPulseFrequency,
  setFlowSpeedPercent,
  setFlowCoreLengthPercent,
  setFlowTailVisible,
  setFlowTailLengthPercent,
  setFlowTailFalloff,
  setCubeSizePercent,
  setModelOffsetXPercent,
  setModelOffsetYPercent,
  resetModelPosition,
  setLightAzimuth,
  setLightElevation,
  setLightIntensityPercent,
  setBlueprintEnabled,
  setPhotoExport2x,
  setPhotoUniformLineWidth,
  setPhotoLineWidthHalfPx,
  setShaderTheme,
  setLineFrequency,
  setDotFrequency,
  setDotSizePercent,
  setPlusFrequency,
  setPlusSizePercent,
  loadModelFiles: (files) => loadModelFromFiles(files),
  loadBatteryModel: loadBundledBatteryModel,
  setBatteryStackEnabled: (enabled) => configureBatteryStack(batteryStackCount, enabled),
  setBatteryStackCount: (count) => configureBatteryStack(count),
  setBatteryStackAnimation: (animation) => configureBatteryStack(batteryStackCount, batteryStackEnabled, animation),
  replayBatteryStack: () => configureBatteryStack(batteryStackCount, true, batteryStackAnimation, true),
  setModelFlowDraw,
  setModelFlowSelectMode,
  deleteSelectedModelFlowArrow,
  reverseSelectedFlowArrow,
  setFlowArrowObjectEnabled,
  clearModelFlow: clearModelFlowPath,
  undoModelFlowArrow: undoLastModelFlowArrow,
  setModelFlowArrowVisible,
  setModelFlowPointsVisible,
  setHoverMovementPaused,
  setRotationDisabled,
  resetRotation: resetCubeRotation,
  setCameraTargetSlot,
  goToCameraTarget,
  resetCameraTarget,
  setShowCameraTargetBoxes,
  setShowTargetMaterials,
  setEditingDefaultView,
  goToDefaultCameraView,
  setPanelsHidden,
};

// --- Hero trigger API --------------------------------------------------
//
// The hero build's only exposed surface: lets the FE team's homepage UI
// buttons switch between the 3 baked Camera Targets, reusing the exact same
// spring-eased goToCameraTarget/goToDefaultCameraView the tool's own "Go"
// buttons call — see PRODUCT.md/the plan doc for the full trigger-API
// contract. Auto-advance timing (switching targets on its own after the
// intro) is intentionally not implemented yet — this ships manual-only, FE
// button clicks only, until that follow-up pass lands.
if (IS_HERO) {
  window.heroScene = {
    goToTarget: (index) => goToCameraTarget(index),
    goToDefault: () => goToDefaultCameraView(),
    getActiveTarget: () => cameraTargetActiveIndex,
    onTargetChange: (callback) => {
      const listener = (state) => callback(state.cameraTargetActiveIndex);
      modelStateListeners.push(listener);
      return () => {
        const i = modelStateListeners.indexOf(listener);
        if (i !== -1) modelStateListeners.splice(i, 1);
      };
    },
  };
}
