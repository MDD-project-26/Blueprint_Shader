import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createSidewaysBatteryStack, mergeObjTexts } from '../battery-sideways-stack.js';
import { parser } from './helpers/battery-parser.js';

for (const model of ['EP5', 'EP12']) {
  const obj = readFileSync(new URL(`../public/models/${model}-battery-stack.obj`, import.meta.url), 'utf8');
  const mtl = readFileSync(new URL(`../public/models/${model}-battery-stack.mtl`, import.meta.url), 'utf8');
  const source = parser.parseObj(obj, parser.parseMtl(mtl));
  const visible = geometry => [...new Set(geometry.objectIndex)];

  test(`${model}: counts 1–4 preserve upright geometry, spacing and materials`, () => {
    const stack = createSidewaysBatteryStack(source);
    assert.ok(stack);
    for (let count = 1; count <= 4; count++) {
      stack.configure(count, true, false, count);
      const geometry = stack.update(count);
      assert.equal(visible(geometry).length, count);
      assert.equal(stack.activeNames.length, count);
      assert.equal(geometry.normals.length, geometry.positions.length);
      assert.equal(geometry.colors.length, geometry.positions.length);
      assert.equal(geometry.isGreen.length, geometry.positions.length / 3);
      assert.equal(geometry.lineIsGreen.length, geometry.linePositions.length / 6);
      assert.ok(geometry.isGreen.every(value => value === 1));
      for (const index of visible(geometry)) {
        assert.deepEqual(geometry.objects[index].bounds, { ...source.objects[index].bounds });
        if (index) assert.ok(geometry.objects[index].bounds.minZ > geometry.objects[index - 1].bounds.maxZ);
      }
      assert.ok(Array.from(geometry.positions).every(Number.isFinite));
      assert.equal(stack.update(count + .1), null, 'Resting geometry needs no upload');
    }
    stack.configure(1, false, false, 10);
    assert.deepEqual(Array.from(stack.update(10).positions), Array.from(source.positions));
    for (const count of [0, 5, 1.5]) assert.throws(() => stack.configure(count, true, true, 20), RangeError);
  });

  test(`${model}: added batteries slide sideways and fade, exits finish and reversals settle`, () => {
    const stack = createSidewaysBatteryStack(source);
    stack.configure(1, true, false, 0); stack.update(0);
    stack.configure(4, true, true, 100);
    const moving = stack.update(175);
    assert.equal(visible(moving).length, 4);
    assert.ok(moving.objects[1].center[0] > source.objects[1].center[0]);
    assert.equal(moving.objects[1].center[1], source.objects[1].center[1]);
    assert.equal(moving.objects[1].center[2], source.objects[1].center[2]);
    const distance = (source.objects[1].center[2] - source.objects[0].center[2]) * 1.4;
    assert.ok(Math.abs(moving.objects[1].center[0] - source.objects[1].center[0]
      - distance * (1 - Math.sin(Math.PI / 4))) < 1e-7,
    'Entry uses the vertical module’s +X direction and 150ms sine easing');
    assert.ok(moving.fades.some(fade => fade.opacity > 0 && fade.opacity < 1));
    const before = moving.objects.map(object => object.center[0]);
    stack.configure(2, true, true, 175);
    assert.deepEqual(stack.update(175).objects.map(object => object.center[0]), before, 'Reversing does not jump');
    stack.configure(4, true, true, 200); stack.update(220);
    stack.configure(1, true, true, 225);
    const settled = stack.update(2000);
    assert.equal(visible(settled).length, 1);
    assert.equal(settled.fades.length, 0);
    assert.equal(stack.animating, false);
    assert.equal(stack.update(2100), null);
    assert.deepEqual(source.positions, parser.parseObj(obj, parser.parseMtl(mtl)).positions);
  });

  test(`${model}: every shrink removes outer batteries first and every growth admits them last`, () => {
    for (let from = 1; from <= 4; from++) {
      for (let to = 1; to <= 4; to++) {
        if (from === to) continue;
        const stack = createSidewaysBatteryStack(source);
        stack.configure(from, true, false, 0); stack.update(0);
        stack.configure(to, true, true, 100);
        const starts = new Map(), finishes = new Map();
        let geometry = stack.update(100);
        const growing = to > from;
        const ordered = growing
          ? Array.from({ length: to - from }, (_, i) => from + i)
          : Array.from({ length: from - to }, (_, i) => from - i - 1);
        for (let time = 100; time <= 500; time++) {
          geometry = stack.update(time) || geometry;
          const present = new Set(visible(geometry));
          for (const index of ordered) {
            const x = geometry.objects[index].center[0] - source.objects[index].center[0];
            if (!starts.has(index) && (growing ? present.has(index) : x > 1e-7)) starts.set(index, time);
            if (!finishes.has(index) && (growing ? present.has(index) && Math.abs(x) < 1e-7 : !present.has(index))) finishes.set(index, time);
          }
        }
        assert.equal(starts.size, ordered.length);
        assert.equal(finishes.size, ordered.length);
        for (let i = 1; i < ordered.length; i++) {
          assert.ok(starts.get(ordered[i - 1]) < starts.get(ordered[i]), 'Turns start in stack order');
          assert.ok(finishes.get(ordered[i - 1]) < finishes.get(ordered[i]), 'Turns finish in stack order');
        }
        assert.equal(visible(geometry).length, to);
      }
    }
  });

  test(`${model}: rapid slider steps retain the same ordered motion as a direct change`, () => {
    for (const growing of [false, true]) {
      const initial = growing ? 1 : 4, target = growing ? 4 : 1;
      const direct = createSidewaysBatteryStack(source), stepped = createSidewaysBatteryStack(source);
      for (const stack of [direct, stepped]) {
        stack.configure(initial, true, false, 0); stack.update(0);
      }
      direct.configure(target, true, true, 100);
      stepped.configure(growing ? 2 : 3, true, true, 100);
      let a, b;
      for (let time = 100; time <= 400; time += 5) {
        if (time === 110) stepped.configure(growing ? 3 : 2, true, true, time);
        if (time === 120) stepped.configure(target, true, true, time);
        a = direct.update(time) || a;
        b = stepped.update(time) || b;
        if (time < 120) continue;
        assert.deepEqual(visible(b), visible(a), 'Rapid steps preserve arrival/removal order');
        assert.deepEqual(b.objects.map(object => object.center[0]), a.objects.map(object => object.center[0]),
          'Already scheduled batteries keep their timing and curve');
      }
      assert.equal(visible(b).length, target);
      assert.equal(stepped.animating, false);
    }
  });

  test(`${model}: three-battery intro holds opaque gaps, then settles sideways over 800ms`, () => {
    const stack = createSidewaysBatteryStack(source);
    stack.configure(3, true, true, 0);
    stack.spreadApart(2);
    const held = stack.update(0);
    assert.equal(visible(held).length, 3);
    assert.equal(held.fades.length, 0, 'Spread intro stays opaque like the vertical module');
    for (let index = 0; index < 3; index++) {
      assert.equal(held.objects[index].center[0], source.objects[index].center[0]);
      assert.equal(held.objects[index].center[1], source.objects[index].center[1]);
      assert.equal(held.objects[index].center[2], source.objects[index].center[2] + index * 2);
    }
    assert.equal(stack.animating, false);
    assert.equal(stack.update(1000), null);
    stack.settle(1000);
    const quarter = stack.update(1200);
    assert.equal(quarter.objects[1].center[2], source.objects[1].center[2] + 2 * (1 - 8 * .25 ** 4));
    const midway = stack.update(1400);
    for (let index = 0; index < 3; index++) {
      assert.equal(midway.objects[index].center[2], source.objects[index].center[2] + index);
    }
    const settled = stack.update(1800);
    for (let index = 0; index < 3; index++) {
      assert.equal(settled.objects[index].center[2], source.objects[index].center[2]);
    }
    assert.equal(stack.animating, false);
    stack.configure(4, true, false, 1900);
    assert.equal(visible(stack.update(1900)).length, 4);
    assert.equal(stack.animating, false, 'Reduced motion settles immediately');
  });
}

test('EP5 and EP12 sit side by side, change count together and focus moves only the view', () => {
  const read = (model, extension) => readFileSync(new URL(`../public/models/${model}-battery-stack.${extension}`, import.meta.url), 'utf8');
  const models = ['EP5', 'EP12'];
  const source = parser.parseObj(mergeObjTexts(models.map(model => read(model, 'obj'))), parser.parseMtl(read('EP5', 'mtl')));
  assert.equal(source.objects.length, 8);
  const stack = createSidewaysBatteryStack(source);
  assert.ok(stack);
  const [ep5, ep12] = stack.frames;
  assert.deepEqual([ep5.model, ep12.model], models);
  const diagonal = ({ bounds }) => Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ);
  assert.ok(Math.abs(Math.abs(ep5.center[2] - ep12.center[2]) - 4.5 * Math.max(diagonal(ep5), diagonal(ep12))) < 1e-9,
    'The models are spaced well beyond one viewport');

  stack.configure(4, true, false, 0);
  const full = stack.update(0);
  assert.equal(new Set(full.objectIndex).size, 8);
  for (const frame of [ep5, ep12]) {
    const members = full.objects.filter(object => object.name.startsWith(`${frame.model}_`));
    assert.equal(Math.min(...members.map(object => object.bounds.minZ)), frame.bounds.minZ);
    assert.equal(Math.max(...members.map(object => object.bounds.maxZ)), frame.bounds.maxZ);
  }
  assert.equal(stack.focusedModel, 'EP5');
  const ep5Offset = stack.centerOffset;
  stack.focus('EP12');
  assert.equal(stack.focusedModel, 'EP12');
  assert.ok(Math.abs(stack.centerOffset - ep5Offset - (ep12.center[2] - ep5.center[2])) < 1e-9);
  assert.equal(stack.update(1), null, 'Changing focus leaves the geometry alone');
  stack.focus('EP99');
  assert.equal(stack.focusedModel, 'EP12');

  stack.spreadApart(2, 'EP12');
  const held = stack.update(2);
  for (let index = 0; index < 8; index++) {
    const moved = held.objects[index].center[2] - full.objects[index].center[2];
    assert.equal(moved, index > 4 ? (index - 4) * 2 : 0, 'Only the focused row is held apart');
  }
  stack.settle(10, undefined, 300);
  assert.deepEqual(stack.update(300).objects.map(object => object.center), held.objects.map(object => object.center), 'The pose holds through the delay');
  assert.deepEqual(stack.update(1200).objects.map(object => object.center), full.objects.map(object => object.center));

  stack.configure(2, true, true, 100);
  const moving = stack.update(150);
  for (const offset of [0, 4]) {
    assert.ok(moving.objects[offset + 3].center[0] > source.objects[offset + 3].center[0], 'Both outer batteries leave at once');
  }
  const settled = stack.update(2000);
  assert.equal(new Set(settled.objectIndex).size, 4);
  assert.equal(stack.activeNames.filter(name => name.startsWith('EP5_')).length, 2);
  assert.equal(stack.activeNames.filter(name => name.startsWith('EP12_')).length, 2);
});
