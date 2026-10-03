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
  const base = visible.find(part => part.name.endsWith('with_Legs'));
  assert.deepEqual(base.center, Array.from(source.objects[0].center), 'The slave with legs stays fixed');
}

test('every upward change eases out and admits slaves only at clearance', () => {
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
        const progress = Math.min(1, (time - 100) / 300);
        const expectedY = startY + (targetY - startY) * Math.sin(Math.PI * progress / 2);
        const masterY = geometry.objects.at(-1).bounds.minY;
        assert.ok(Math.abs(masterY - expectedY) < 1e-7, 'Master travels directly to its final height in 300ms, without overshooting or settling back down');
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

test('new slaves fly along positive X into place with matching wireframes and bounds', () => {
  const stack = createBatteryStack(source);
  stack.configure(3, true, false, 0); stack.update(0);
  stack.configure(4, true, true, 100);
  const hidden = stack.update(399);
  assert.equal(new Set(hidden.objectIndex).has(2), false);
  const entry = stack.update(400);
  const quarter = stack.update(437.5);
  const halfway = stack.update(475);
  const initialSlide = entry.objects[2].center[0] - source.objects[2].center[0];
  assert.ok(initialSlide > 0, 'Slave begins on the positive X side of its slot');
  assert.ok(quarter.objects[2].center[0] - source.objects[2].center[0] < initialSlide * .75, 'Insertion starts promptly without easing in');
  const halfwaySlide = initialSlide * (1 - Math.SQRT1_2);
  assert.ok(Math.abs(halfway.objects[2].center[0] - source.objects[2].center[0] - halfwaySlide) < 1e-7, 'Insertion eases out');
  assert.deepEqual(entry.fades.map(fade => fade.index), [2], 'Only the arriving slave fades');
  assert.ok(entry.fades[0].opacity < 1e-9, 'It appears fully transparent');
  assert.ok(Math.abs(halfway.fades[0].opacity - Math.SQRT1_2) < 1e-9, 'Opacity rises with the slide');
  assert.equal(halfway.objects[2].bounds.minY, source.objects[2].bounds.minY, 'Insertion stays at the cleared slot height');
  const vertex = Array.from(halfway.objectIndex).indexOf(2);
  for (const axis of [0, 2]) {
    const offset = axis === 0 ? halfwaySlide : 0;
    assert.ok(Math.abs(halfway.positions[vertex * 3 + axis] - halfway.basePositions[vertex * 3 + axis] - offset) < 1e-6);
    const edge = halfway.lineObjectIndex.indexOf(2);
    for (const endpoint of [edge * 6, edge * 6 + 3]) assert.ok(Math.abs(halfway.linePositions[endpoint + axis] - halfway.baseLinePositions[endpoint + axis] - offset) < 1e-6);
  }
  assert.equal(halfway.objects[2].center[2], source.objects[2].center[2], 'Z stays fixed');
  assert.equal(halfway.objects[2].bounds.minZ, source.objects[2].bounds.minZ);
  assert.equal(stack.animating, true, 'Insertion continues after the master stops');
  const threeQuarter = stack.update(512.5);
  assert.ok(threeQuarter.objects[2].center[0] - source.objects[2].center[0] < initialSlide * .25, 'Insertion slows near its destination');
  const settled = stack.update(550);
  assert.deepEqual(settled.objects[2].center, Array.from(source.objects[2].center));
  assert.deepEqual(settled.fades, [], 'A slave in its slot is solid');
  assert.equal(stack.animating, false);
  assert.equal(stack.update(600), null);
});

test('removed slaves replay their entry backwards along positive X before the master descends', () => {
  const stack = createBatteryStack(source);
  stack.configure(9, true, false, 0);
  const before = stack.update(0);
  stack.configure(3, true, true, 100);
  const start = stack.update(100);
  assert.equal(new Set(start.objectIndex).size, 9, 'Nothing disappears on the change itself');
  assert.deepEqual(start.objects.map(part => part.center), before.objects.map(part => part.center), 'Nothing jumps');
  const quarter = stack.update(137.5);
  const departure = stack.update(175);
  const pitch = source.objects[2].bounds.minY - source.objects[1].bounds.minY;
  const slide = pitch * 1.4;
  const exitOffset = slide * (1 - Math.SQRT1_2);
  assert.ok(quarter.objects[7].center[0] - source.objects[7].center[0] < slide * .1, 'The exit starts gently, as the entry ends');
  assert.ok(Math.abs(departure.objects[7].center[0] - source.objects[7].center[0] - exitOffset) < 1e-7, 'The top slave mirrors the insertion curve');
  assert.deepEqual(start.fades, [], 'Slaves waiting their turn stay solid');
  assert.ok(Math.abs(departure.fades.find(fade => fade.index === 7).opacity - Math.SQRT1_2) < 1e-9, 'Opacity falls with the slide');
  assert.ok(departure.fades.every(fade => fade.index >= 5), 'Only slaves already on their way out fade');
  assert.equal(departure.objects[1].center[0], source.objects[1].center[0], 'Bottom middle slave stays in place');
  assert.equal(departure.objects[8].center[1], before.objects[8].center[1], 'The resting master waits for the slave beneath it');
  const vertex = Array.from(departure.objectIndex).indexOf(7);
  assert.ok(Math.abs(departure.positions[vertex * 3] - departure.basePositions[vertex * 3] - exitOffset) < 1e-6);
  const edge = departure.lineObjectIndex.indexOf(7);
  for (const endpoint of [edge * 6, edge * 6 + 3]) assert.ok(Math.abs(departure.linePositions[endpoint] - departure.baseLinePositions[endpoint] - exitOffset) < 1e-6);
  assert.equal(departure.objects[7].center[1], source.objects[7].center[1]);
  assert.equal(departure.objects[7].center[2], source.objects[7].center[2]);
  assertMasterClear(departure);
  const nearlyOut = stack.update(249);
  assert.ok(nearlyOut.fades.find(fade => fade.index === 7).opacity < .02, 'It is transparent by the time it is removed');
  const firstRemoved = stack.update(250);
  assert.equal(new Set(firstRemoved.objectIndex).has(7), false, 'The uppermost slave leaves first');
  assert.equal(new Set(firstRemoved.objectIndex).has(2), true, 'Lower slaves leave later');
  const settled = stack.update(550);
  assert.equal(new Set(settled.objectIndex).size, 3);
  assert.equal(stack.animating, false);
  assertMasterClear(settled);
  stack.configure(4, true, true, 600); stack.update(1050);
  stack.configure(4, false, false, 1051);
  const restored = stack.update(1051);
  assert.deepEqual(Array.from(restored.positions), Array.from(source.positions));
  assert.deepEqual(Array.from(restored.linePositions), Array.from(source.linePositions));
});

test('every downward count change slides each slave out just before the eased master reaches its slot', () => {
  const pitch = source.objects[2].bounds.minY - source.objects[1].bounds.minY;
  const seam = source.objects[7].bounds.maxY - source.objects[8].bounds.minY;
  const clamp = value => Math.max(0, Math.min(1, value));
  for (let lower = 3; lower < 9; lower++) {
    for (let upper = lower + 1; upper <= 9; upper++) {
      const stack = createBatteryStack(source);
      stack.configure(upper, true, false, 0);
      let geometry = stack.update(0);
      const startY = geometry.objects[8].bounds.minY;
      const targetY = source.objects[8].bounds.minY + (lower - 9) * pitch;
      stack.configure(lower, true, true, 100);
      for (let time = 0; time <= 450; time += 5) {
        geometry = stack.update(100 + time) || geometry;
        const expectedY = startY + (targetY - startY) * Math.sin(Math.PI * clamp((time - 150) / 300) / 2);
        assert.ok(Math.abs(geometry.objects[8].bounds.minY - expectedY) < 1e-7, 'The master keeps its 300ms ease-out once the top slave has left');
        const visible = new Set(geometry.objectIndex);
        for (let index = lower - 1; index <= upper - 2; index++) {
          const top = source.objects[index].bounds.maxY - seam;
          const start = Math.asin(clamp((startY - top) / (startY - targetY))) * 2 / Math.PI * 300;
          const elapsed = time - start;
          const expectedX = pitch * 1.4 * (1 - Math.cos(Math.PI * clamp(elapsed / 150) / 2));
          assert.ok(Math.abs(geometry.objects[index].center[0] - source.objects[index].center[0] - expectedX) < 1e-6, 'Every slave accelerates out along positive X');
          assert.equal(visible.has(index), elapsed < 150 - 1e-7, 'Slave remains visible until its slide finishes');
          assert.equal(geometry.objects[index].center[1], source.objects[index].center[1], 'Exit stays at the same slot height');
          assert.equal(geometry.objects[index].center[2], source.objects[index].center[2], 'Exit stays on the X axis');
        }
        for (let index = 0; index < lower - 1; index++) assert.deepEqual(geometry.objects[index].center, Array.from(source.objects[index].center), 'Retained slaves do not move');
        assertMasterClear(geometry);
      }
      assert.equal(new Set(geometry.objectIndex).size, lower);
      assert.equal(stack.animating, false);
      assert.equal(stack.update(600), null);
    }
  }
});

test('insertion starts at the eased clearance time rather than the old linear schedule', () => {
  const stack = createBatteryStack(source);
  stack.configure(3, true, false, 0); stack.update(0);
  stack.configure(6, true, true, 100);
  const early = stack.update(160);
  assert.equal(new Set(early.objectIndex).has(2), false, 'First slave waits for actual master clearance');
  const entering = stack.update(165);
  assert.equal(new Set(entering.objectIndex).has(2), true);
  const pitch = source.objects[2].bounds.minY - source.objects[1].bounds.minY;
  assert.ok(entering.objects[2].center[0] - source.objects[2].center[0] > pitch * 1.4 * .99, 'Slave begins its slide when the eased master clears its slot');
  assertMasterClear(entering);
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

test('recurring stack layouts reuse geometry and idle frames do no work', () => {
  const stack = createBatteryStack(source);
  stack.configure(3, true, false, 0);
  const three = stack.update(0);
  stack.configure(9, true, false, 1); stack.update(1);
  stack.configure(3, true, false, 2);
  const restored = stack.update(2);
  assert.equal(restored.positions, three.positions);
  assert.equal(restored.linePositions, three.linePositions);
  assert.equal(restored.normals, three.normals);
  assert.equal(restored.membershipChanged, true);
  stack.configure(3, true, false, 3);
  assert.equal(stack.update(3), null, 'An unchanged count does not restart or upload anything');
  stack.configure(3, true, true, 10, true);
  stack.update(10);
  assert.equal(stack.animating, true);
  assert.equal(stack.update(20), null, 'Unchanged frames during a replay delay skip geometry uploads');
});

function createRendererHarness(stack) {
  let time = 0, buffer;
  const uploads = [];
  const gl = {
    ARRAY_BUFFER: 1, DYNAMIC_DRAW: 2,
    bindBuffer(_target, value) { buffer = value; },
    bufferData(_target, values) { uploads.push({ buffer, kind: 'allocate', length: values.length }); },
    bufferSubData(_target, offset, values) { assert.equal(offset, 0); uploads.push({ buffer, kind: 'reuse', length: values.length }); },
  };
  const harness = runInNewContext(`
    let customModelVertexCount, customModelLineVertexCount, customModelObjects;
    let customModelPositionsCache, customModelObjectIndexCache, customModelIsGreenCache;
    let customModelLinePositionsCache, customModelLineIsGreenCache;
    let greenTriPositionsCache, greenTriObjectIndexCache;
    let batteryGreenTriangleRanges = [], batteryAllTrianglesGreen = false;
    let batteryVertexRanges, batteryLineRanges, batteryFades;
    ${functionSource('updateBatteryStackGeometry')}
    ({update: updateBatteryStackGeometry, state: () => ({
      positions: customModelPositionsCache, flags: customModelIsGreenCache,
      owners: customModelObjectIndexCache, green: greenTriPositionsCache, greenOwners: greenTriObjectIndexCache
    })})
  `, {
    gl, batteryStack: stack, performance: { now: () => time },
    customModelPositionBuffer: 'positions', customModelLineBuffer: 'lines',
    customModelNormalBuffer: 'normals', customModelColorBuffer: 'colors',
    customModelIsGreenBuffer: 'green', customModelFillPatternBuffer: 'patterns',
    refreshBlueprintLineColors() {}, recomputeModelFlowCoords() {},
  });
  return { uploads, state: harness.state, update(now) { time = now; harness.update(); } };
}

test('renderer reuses GPU storage and the live NGEN mesh for raycasting between layout changes', () => {
  const stack = createBatteryStack(source);
  const renderer = createRendererHarness(stack);
  stack.configure(3, true, false, 0); renderer.update(0);
  assert.equal(renderer.uploads.filter(upload => upload.kind === 'allocate').length, 6);
  assert.equal(renderer.state().green, renderer.state().positions, 'All-green meshes need no triangle copy');
  const owners = renderer.state().greenOwners;
  renderer.uploads.length = 0;
  stack.configure(9, true, true, 100); renderer.update(100); renderer.update(120);
  assert.ok(renderer.uploads.every(upload => upload.kind === 'reuse'), 'Movement uses bufferSubData');
  assert.equal(renderer.state().greenOwners, owners, 'Raycast ownership is not rebuilt during movement');
  renderer.uploads.length = 0;
  renderer.update(150);
  assert.equal(renderer.uploads.filter(upload => upload.kind === 'allocate').length, 6, 'New modules allocate correctly sized buffers');
  renderer.update(600);
  renderer.uploads.length = 0;
  renderer.update(610);
  assert.equal(renderer.uploads.length, 0, 'Settled frames do not touch the GPU');
});

test('mixed-material raycast caches contain only green triangles and stay current during animation', () => {
  const flags = source.isGreen.slice();
  for (let triangle = 0; triangle < flags.length; triangle += 6) flags.fill(0, triangle, triangle + 3);
  const stack = createBatteryStack({ ...source, isGreen: flags });
  const renderer = createRendererHarness(stack);
  stack.configure(3, true, false, 0); renderer.update(0);
  stack.configure(9, true, true, 100);
  for (const time of [100, 120, 150, 160, 300, 600]) {
    renderer.update(time);
    const state = renderer.state();
    const triangles = [], owners = [];
    for (let vertex = 0; vertex < state.flags.length; vertex += 3) {
      if (!state.flags[vertex]) continue;
      triangles.push(...state.positions.subarray(vertex * 3, vertex * 3 + 9));
      owners.push(state.owners[vertex]);
    }
    assert.deepEqual(Array.from(state.green), triangles);
    assert.deepEqual(Array.from(state.greenOwners), owners);
  }
});

test('reversing during insertion sends slaves back out from their current pose without a jump', () => {
  for (let lower = 3; lower < 9; lower++) {
    for (let upper = lower + 1; upper <= 9; upper++) {
      for (const reverseAt of [50, 175, 325, 425]) {
        const stack = createBatteryStack(source);
        stack.configure(lower, true, false, 0); stack.update(0);
        stack.configure(upper, true, true, 100);
        const before = stack.update(100 + reverseAt);
        stack.configure(lower, true, true, 100 + reverseAt);
        let current = stack.update(100 + reverseAt) || before;
        for (const index of new Set(current.objectIndex)) {
          current.objects[index].center.forEach((value, axis) => assert.ok(Math.abs(value - before.objects[index].center[axis]) < 1e-9, 'Changing direction does not jump a visible module'));
        }
        for (let elapsed = 5; elapsed <= 800; elapsed += 5) {
          const next = stack.update(100 + reverseAt + elapsed) || current;
          for (const index of new Set(next.objectIndex)) {
            if (index > lower - 2 && index < 8) assert.ok(next.objects[index].center[0] >= current.objects[index].center[0] - 1e-9, 'Outgoing slaves only ever move toward positive X');
          }
          current = next;
          assertMasterClear(current);
        }
        assert.equal(stack.animating, false);
        assert.equal(new Set(current.objectIndex).size, lower);
      }
    }
  }
});

test('repeated slider values preserve timing and reversing an exit back in is continuous', () => {
  const stack = createBatteryStack(source);
  stack.configure(3, true, false, 0); stack.update(0);
  stack.configure(9, true, true, 100);
  stack.update(250);
  stack.configure(9, true, true, 250);
  const at = stack.update(300);
  const pitch = source.objects[2].bounds.minY - source.objects[1].bounds.minY;
  const expected = source.objects[8].center[1] - 6 * pitch + 6 * pitch * Math.sin(Math.PI / 3);
  assert.ok(Math.abs(at.objects[8].center[1] - expected) < 1e-7, 'Duplicate events preserve the original timing');
  stack.configure(9, true, true, 550);
  const settled = stack.update(550);
  stack.configure(3, true, true, 600);
  const goingOut = stack.update(680);
  stack.configure(9, true, true, 680);
  const sameFrame = stack.update(680);
  for (const index of new Set(goingOut.objectIndex)) {
    assert.deepEqual(sameFrame.objects[index].center, goingOut.objects[index].center, 'Retained modules do not jump');
  }
  assert.equal(new Set(sameFrame.objectIndex).size, 9, 'Departing slaves are still present to return');
  assert.ok(sameFrame.objects[7].center[0] > source.objects[7].center[0], 'The departing slave returns from where it had reached');
  assertMasterClear(sameFrame);
  const backIn = stack.update(1200);
  assert.deepEqual(Array.from(backIn.positions), Array.from(settled.positions));
  assert.equal(new Set(backIn.objectIndex).size, 9);
  assert.equal(stack.animating, false);
});

test('new destinations during a partial movement settle at the requested count and height', () => {
  const stack = createBatteryStack(source);
  stack.configure(3, true, false, 0); stack.update(0);
  let time = 10;
  for (const count of [9, 5, 9, 4, 8, 6, 3, 7]) {
    stack.configure(count, true, true, time);
    stack.update(time + 65);
    time += 80;
  }
  const actual = stack.update(time + 1000);
  const reference = createBatteryStack(source);
  reference.configure(7, true, false, 0);
  const expected = reference.update(0);
  assert.deepEqual(Array.from(actual.positions), Array.from(expected.positions));
  assert.deepEqual(Array.from(actual.linePositions), Array.from(expected.linePositions));
  assert.equal(stack.animating, false);
});

test('another decrement during a departure keeps the exit under way and adds no extra wait', () => {
  const stack = createBatteryStack(source);
  stack.configure(9, true, false, 0);
  const before = stack.update(0);
  stack.configure(8, true, true, 100);
  const departing = stack.update(150);
  stack.configure(7, true, true, 150);
  const continued = stack.update(150) || departing;
  assert.equal(new Set(continued.objectIndex).size, 9);
  assert.ok(Math.abs(continued.objects[7].center[0] - departing.objects[7].center[0]) < 1e-9, 'The departing slave keeps its current position');
  const mid = stack.update(200);
  assert.ok(mid.objects[7].center[0] > continued.objects[7].center[0], 'Its exit carries on rather than starting over');
  const afterExit = stack.update(275);
  assert.equal(new Set(afterExit.objectIndex).has(7), false, 'The original departure still finishes at 250ms');
  assert.ok(afterExit.objects[8].center[1] < before.objects[8].center[1], 'The master descends without another full exit delay');
  assertMasterClear(afterExit);
  const settled = stack.update(600);
  assert.equal(stack.animating, false);
  assert.equal(new Set(settled.objectIndex).size, 7);
});

test('a master caught in flight keeps moving while every removed slave still plays its full exit', () => {
  const pitch = source.objects[2].bounds.minY - source.objects[1].bounds.minY;
  for (const [from, first, then] of [[9, 8, 5], [9, 8, 3], [3, 9, 3], [4, 9, 5], [9, 6, 3]]) {
    for (let changeAt = 110; changeAt <= 700; changeAt += 10) {
      const stack = createBatteryStack(source);
      stack.configure(from, true, false, 0);
      let current = stack.update(0);
      stack.configure(first, true, true, 100);
      current = stack.update(changeAt) || current;
      stack.configure(then, true, true, changeAt);
      const targetY = source.objects[8].center[1] + (then - 9) * pitch;
      let held = 0;
      for (let time = changeAt + 5; time <= changeAt + 800; time += 5) {
        const next = stack.update(time) || current;
        const visible = new Set(next.objectIndex);
        const master = next.objects[8], top = Math.max(...[...visible].filter(index => index !== 8).map(index => next.objects[index].bounds.maxY));
        // The frame on which a slave vanishes may still show the master where it rested on it.
        const hanging = stack.animating && master.center[1] > targetY + 1e-6 && master.bounds.minY - top > .03
          && master.center[1] >= current.objects[8].center[1];
        held = hanging ? held + 1 : 0;
        assert.ok(held < 2, 'The master never hangs in mid-air');
        for (const index of new Set(current.objectIndex)) {
          if (visible.has(index)) continue;
          const travelled = current.objects[index].center[0] - source.objects[index].center[0];
          assert.ok(travelled > pitch * 1.4 * .6, 'A slave only disappears at the end of its slide');
        }
        assertMasterClear(next);
        current = next;
      }
      assert.equal(stack.animating, false);
      assert.equal(new Set(current.objectIndex).size, then);
    }
  }
});

test('the opening pose holds the parts apart until settle eases them into place', () => {
  const stack = createBatteryStack(source);
  stack.configure(3, true, false, 0);
  const assembled = stack.update(0).objects.map(part => part.center[1]);
  stack.configure(3, true, true, 0);
  stack.spreadApart(5);
  const apart = stack.update(10);
  assert.deepEqual([...new Set(apart.objectIndex)], [0, 1, 8]);
  assert.equal(apart.objects[0].center[1], assembled[0], 'The base stays where it is');
  assert.ok(Math.abs(apart.objects[1].center[1] - assembled[1] - 5) < 1e-9);
  assert.ok(Math.abs(apart.objects[8].center[1] - assembled[8] - 10) < 1e-9, 'Each part sits a further gap above the one below');
  assert.equal(stack.animating, false);
  assert.equal(stack.update(5000), null, 'It holds still until triggered');
  stack.settle(6000);
  let previous = stack.update(6000) || apart;
  assert.ok(Math.abs(previous.objects[8].center[1] - assembled[8] - 10) < 1e-9, 'Settling starts from the held pose');
  const early = stack.update(6080);
  assert.ok(Math.abs(early.objects[8].center[1] - assembled[8] - 10 * (1 - 8 * .1 ** 4)) < 1e-9, 'Ease-in-out quart: barely moving at first');
  const halfway = stack.update(6400);
  assert.ok(Math.abs(halfway.objects[8].center[1] - assembled[8] - 5) < 1e-9, 'Half way there at half time');
  previous = halfway;
  for (let time = 6410; time <= 6800; time += 10) {
    const next = stack.update(time);
    for (const index of [1, 8]) assert.ok(next.objects[index].center[1] < previous.objects[index].center[1], 'Every part keeps moving down');
    const gapBelow = next.objects[1].center[1] - assembled[1], gapAbove = next.objects[8].center[1] - assembled[8] - gapBelow;
    assert.ok(Math.abs(gapBelow - gapAbove) < 1e-9, 'The gaps close together');
    assertMasterClear(next);
    previous = next;
  }
  assert.equal(stack.animating, false, 'It takes 800ms');
  assert.deepEqual(previous.objects.map(part => part.center[1]), assembled);
  stack.spreadApart(5); stack.update(8000);
  stack.configure(5, true, true, 8000);
  const changed = stack.update(8000);
  assert.equal(changed.objects[8].center[1], assembled[8], 'A count change assembles the stack before animating');
});
