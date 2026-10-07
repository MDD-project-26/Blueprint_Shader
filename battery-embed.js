// The battery scenes as a plain ES module for a host site to drive: one
// export, createBatteryScene, covering the vertical NGEN stack and the
// sideways EP5/EP12 pair. No UI, no stylesheet, no element ids — the host
// builds its own slider and buttons and calls setCount/setModel.
//
// Only builds through vite.battery-embed.config.ts, which compiles main.js
// into the createScene factory imported here (see IS_EMBED in main.js): each
// call is one independent scene, so a page can hold several and a single-page
// app can create and destroy them as its sections mount and unmount.
//
// The contract is typed in battery-embed.d.ts and explained for the host's
// developers in handover/HANDOVER.md, Part E.
import { createScene } from './main.js';

const COUNT_RANGES = { vertical: [3, 9], sideways: [1, 4] };
const MODELS = { ep5: 'EP5', ep12: 'EP12' };

export function createBatteryScene(root, options) {
  const { variant, count, model = 'ep5', reducedMotion = false, modelBaseUrl, onReady, onError } = options;
  const range = COUNT_RANGES[variant];
  if (!range) throw new TypeError(`createBatteryScene: unknown variant "${variant}".`);
  const checkCount = (value) => {
    if (!Number.isInteger(value) || value < range[0] || value > range[1]) {
      throw new RangeError(`createBatteryScene: ${variant} count must be an integer from ${range[0]} to ${range[1]}, got ${value}.`);
    }
  };
  const checkModel = (value) => {
    if (!(value in MODELS)) throw new TypeError(`createBatteryScene: unknown model "${value}".`);
  };
  const canvas = root.querySelector('canvas[data-battery-canvas]');
  if (!canvas) throw new TypeError('createBatteryScene: root has no canvas[data-battery-canvas].');
  if (typeof modelBaseUrl !== 'string') throw new TypeError('createBatteryScene: modelBaseUrl is required.');
  checkCount(count);
  checkModel(model);

  // The canvas fills root, whatever the host's own CSS says about it; root is
  // the box the host sizes. Put back as found on destroy.
  const { display, width, height, cursor } = canvas.style;
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%' });

  const teardown = new AbortController();
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    teardown.abort();
    Object.assign(canvas.style, { display, width, height, cursor });
  };

  const scene = {
    root,
    canvas,
    teardown,
    sideways: variant === 'sideways',
    count,
    model: MODELS[model],
    reducedMotion: !!reducedMotion,
    modelBaseUrl: modelBaseUrl.endsWith('/') ? modelBaseUrl : `${modelBaseUrl}/`,
    onReady: () => onReady?.(),
    onError: (error) => onError?.(error),
  };
  try {
    createScene(scene);
  } catch (error) {
    // No WebGL, most likely. Reported the same way a failed model load is,
    // after this call has returned, so the host always gets its handle first.
    destroy();
    queueMicrotask(() => onError?.(error));
    return { setCount() {}, setModel() {}, destroy() {} };
  }

  return {
    setCount(value) {
      checkCount(value);
      if (!destroyed) scene.handle.setCount(value);
    },
    // Moves the view between the two sideways models; the vertical stack has
    // only the one, so there it does nothing.
    setModel(value) {
      checkModel(value);
      if (!destroyed) scene.handle.setModel(MODELS[value]);
    },
    destroy,
  };
}
