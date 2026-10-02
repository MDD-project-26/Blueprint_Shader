import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createBatteryStack } from '../battery-stack.js';

// Exercise the renderer's actual OBJ parser against the supplied asset without
// initializing its browser-only WebGL canvas. Only top-level pure functions run.
const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const functionSource = name => {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing parser helper ${name}`);
  return main.slice(start, main.indexOf('\n}', start) + 2);
};
const parser = runInNewContext([
  'const CUSTOM_MODEL_ROTATE_Y_RAD = -Math.PI / 2;',
  'const CREASE_ANGLE_DOT_THRESHOLD = Math.cos(25 * Math.PI / 180);',
  'const GREEN_DOMINANCE_MARGIN = 20;',
  'const BLUEPRINT_LINE_COLOR_GREEN_PART = [0,0,0];',
  'const BLUEPRINT_THEMES = {dark:{line:[.48,.52,.56]}}; const shaderTheme = "dark";',
  ...['parseMtl', 'parseObj', 'buildCreaseEdgeLines', 'buildLineColors', 'isGreenDominant', 'materialFillPatternId', 'isTargetMaterial'].map(functionSource),
  '({parseObj,parseMtl})',
].join('\n'));
const obj = readFileSync(new URL('../public/models/NGEN_assets.obj', import.meta.url), 'utf8');
const mtl = readFileSync(new URL('../public/models/NGEN_assets.mtl', import.meta.url), 'utf8');
const source = parser.parseObj(obj, parser.parseMtl(mtl));

test('all seven counts keep the base, put the master on top, and retain material attributes', () => {
  const stack = createBatteryStack(source);
  assert.ok(stack);
  for (let count = 3; count <= 9; count++) {
    stack.configure(count, true, false, 0);
    const geometry = stack.update(0);
    const selected = [...new Set(geometry.objectIndex)];
    assert.equal(selected.length, count);
    assert.ok(geometry.objects[selected[0]].name.endsWith('with_Legs'));
    assert.ok(geometry.objects[selected.at(-1)].name.endsWith('Master'));
    const lower = geometry.objects[selected.at(-2)].bounds;
    const master = geometry.objects[selected.at(-1)].bounds;
    assert.ok(Math.abs(master.minY - lower.maxY) < .02, 'Master meets the top slave');
    assert.equal(geometry.normals.length, geometry.positions.length);
    assert.equal(geometry.colors.length, geometry.positions.length);
    assert.equal(geometry.isGreen.length, geometry.positions.length / 3);
    assert.equal(geometry.lineIsGreen.length, geometry.linePositions.length / 6);
    assert.ok(Array.from(geometry.positions).every(Number.isFinite));
  }
});

test('turning stacking off restores the exact original mesh and wireframe', () => {
  const stack = createBatteryStack(source);
  stack.configure(3, true, false, 0); stack.update(0);
  stack.configure(3, false, false, 1);
  const restored = stack.update(1);
  assert.deepEqual(Array.from(restored.positions), Array.from(source.positions));
  assert.deepEqual(Array.from(restored.linePositions), Array.from(source.linePositions));
});

test('replay and rapid count reversals finish with valid, settled geometry', () => {
  const stack = createBatteryStack(source);
  stack.configure(3, true, true, 0, true); stack.update(100);
  stack.configure(9, true, true, 150); stack.update(200);
  stack.configure(5, true, true, 220); stack.update(300);
  const settled = stack.update(3000);
  assert.equal(new Set(settled.objectIndex).size, 5);
  assert.equal(stack.animating, false);
  assert.equal(stack.update(3100), null, 'Settled frames do not re-upload geometry');
  assert.deepEqual(Array.from(source.positions), Array.from(parser.parseObj(obj, parser.parseMtl(mtl)).positions), 'Source geometry remains unchanged');
});

function assertMasterClear(geometry) {
  const visible = [...new Set(geometry.objectIndex)].map(index => geometry.objects[index]);
  const master = visible.find(part => part.name.endsWith('Master'));
  const top = Math.max(...visible.filter(part => part !== master).map(part => part.bounds.maxY));
  assert.ok(master.bounds.minY >= top - .02, 'Master stays above every visible slave');
}

test('every upward change uses the downward timing in reverse and reveals slaves only at clearance', () => {
  for (let from = 3; from < 9; from++) {
    for (let to = from + 1; to <= 9; to++) {
      const stack = createBatteryStack(source);
      stack.configure(from, true, false, 0);
      const before = stack.update(0);
      const startY = before.objects.at(-1).bounds.minY;
      const pitch = source.objects[2].bounds.minY - source.objects[1].bounds.minY;
      const targetY = source.objects.at(-1).bounds.minY + (to - 9) * pitch;
      const seam = source.objects[7].bounds.maxY - source.objects.at(-1).bounds.minY;
      stack.configure(to, true, true, 100);
      let geometry = stack.update(100);
      assert.equal(geometry.objects.at(-1).bounds.minY, before.objects.at(-1).bounds.minY, 'Master does not jump');
      assert.equal(new Set(geometry.objectIndex).size, from, 'Incoming slaves wait for clearance');
      for (let time = 100; time <= 1600; time += 10) {
        geometry = stack.update(time) || geometry;
        assertMasterClear(geometry);
        const progress = Math.min(1, (time - 100) / 600);
        const expectedY = startY + (targetY - startY) * (1 - (1 - progress) ** 3);
        const masterY = geometry.objects.at(-1).bounds.minY;
        assert.ok(Math.abs(masterY - expectedY) < 1e-7, 'Master travels directly to its final height in 600ms, without overshooting or settling back down');
        const visible = new Set(geometry.objectIndex);
        for (let index = from - 1; index <= to - 2; index++) {
          const cleared = masterY >= source.objects[index].bounds.maxY - seam - 1e-7;
          assert.equal(visible.has(index), cleared, 'Each new slave appears as soon as its slot clears');
          assert.equal(geometry.objects[index].bounds.minY, source.objects[index].bounds.minY, 'Added slaves stay in their final slots');
        }
      }
      assert.equal(new Set(geometry.objectIndex).size, to);
      assert.equal(stack.animating, false);
      const topSlave = geometry.objects[to - 2];
      assert.ok(Math.abs(geometry.objects.at(-1).bounds.minY - topSlave.bounds.maxY) < .02);
    }
  }
});

test('rapid growth, shrinkage and replay keep the master clear throughout', () => {
  const stack = createBatteryStack(source);
  stack.configure(3, true, false, 0);
  let geometry = stack.update(0);
  const changes = new Map([[10, [9]], [110, [5]], [180, [8]], [430, [4]], [500, [9]], [850, [7]], [1200, [8]], [2200, [8, true]]]);
  for (let time = 10; time <= 3600; time += 10) {
    if (changes.has(time)) {
      const [count, replay = false] = changes.get(time);
      stack.configure(count, true, true, time, replay);
    }
    geometry = stack.update(time) || geometry;
    assertMasterClear(geometry);
  }
  assert.equal(new Set(geometry.objectIndex).size, 8);
  assert.equal(stack.animating, false);
});

test('invalid counts and unrelated models are rejected', () => {
  const stack = createBatteryStack(source);
  for (const count of [2, 10, 3.5, NaN]) assert.throws(() => stack.configure(count, true, false, 0), RangeError);
  assert.equal(createBatteryStack({...source, objects: source.objects.slice(1)}), null);
});
