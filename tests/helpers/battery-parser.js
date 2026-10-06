import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the renderer's actual OBJ parser against the supplied asset without
// initializing its browser-only WebGL canvas. Only top-level pure functions run.
const main = readFileSync(new URL('../../main.js', import.meta.url), 'utf8');
export const functionSource = name => {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing parser helper ${name}`);
  return main.slice(start, main.indexOf('\n}', start) + 2);
};
export const parser = runInNewContext([
  'const CUSTOM_MODEL_ROTATE_Y_RAD = -Math.PI / 2;',
  'const CREASE_ANGLE_DOT_THRESHOLD = Math.cos(25 * Math.PI / 180);',
  'const GREEN_DOMINANCE_MARGIN = 20;',
  'const BLUEPRINT_LINE_COLOR_GREEN_PART = [0,0,0];',
  'const BLUEPRINT_THEMES = {dark:{line:[.48,.52,.56]}}; const shaderTheme = "dark";',
  ...['parseMtl', 'parseObj', 'buildCreaseEdgeLines', 'buildLineColors', 'isGreenDominant', 'materialFillPatternId', 'isTargetMaterial'].map(functionSource),
  '({parseObj,parseMtl})',
].join('\n'));
