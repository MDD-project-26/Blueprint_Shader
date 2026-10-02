// Geometry-only extension: the existing renderer, materials and shaders stay intact.
// The supplied asset has a bottom slave with legs, seven middle slaves and a master.
export function createBatteryStack(source) {
  const parts = source.objects.map((object, index) => ({ ...object, index }))
    .filter(object => /^Battery_Nine_Stack_-_(Slave(?:_with_Legs|_\d+)?|Master)$/.test(object.name))
    .sort((a, b) => a.bounds.minY - b.bounds.minY);
  if (parts.length !== 9 || source.objects.length !== 9 || !parts[0].name.endsWith('with_Legs') || !parts[8].name.endsWith('Master')) return null;
  const pitch = parts[2].bounds.minY - parts[1].bounds.minY;
  if (!(pitch > 0)) return null;
  const master = parts[8];
  const seam = parts[7].bounds.maxY - master.bounds.minY;

  // Crease edges use the original vertex positions; retain their object ownership.
  const vertexOwners = new Map();
  const key = (positions, offset) => `${positions[offset]},${positions[offset + 1]},${positions[offset + 2]}`;
  for (let i = 0; i < source.objectIndex.length; i++) vertexOwners.set(key(source.positions, i * 3), source.objectIndex[i]);
  const edgeOwners = [];
  for (let i = 0; i < source.linePositions.length; i += 6) edgeOwners.push(vertexOwners.get(key(source.linePositions, i)));
  if (edgeOwners.some(owner => owner === undefined)) return null;

  let enabled = false, count = 9, animate = true, dirty = true, packed;
  const offsets = new Map(parts.map(part => [part.index, 0]));
  let transitions = new Map();
  let active = new Set(parts.map(part => part.index));
  let pending = new Map();
  const selected = () => enabled ? [...parts.slice(0, count - 1), parts[8]] : parts;
  const destination = index => enabled && index === parts[8].index ? (count - 9) * pitch : 0;

  function configure(nextCount, nextEnabled, nextAnimate, now, replay = false) {
    if (!Number.isInteger(nextCount) || nextCount < 3 || nextCount > 9) throw new RangeError('Battery count must be an integer from 3 to 9.');
    // Snapshot in-flight offsets before a fast slider change reverses the motion.
    sample(now);
    count = nextCount; enabled = nextEnabled; animate = nextAnimate;
    const nextActive = new Set(selected().map(part => part.index));
    pending = new Map();
    transitions = new Map();
    selected().forEach((part, order) => {
      const target = destination(part.index);
      const entering = !active.has(part.index);
      // Count changes reverse the downward master motion exactly. Added slaves
      // stay in their final slots, hidden until the master clears each slot.
      const waitForClearance = animate && enabled && !replay && entering && part !== master;
      const from = waitForClearance ? target : animate && enabled && order > 0 && (replay || entering)
        ? target + pitch * 2.2
        : offsets.get(part.index);
      offsets.set(part.index, animate ? from : target);
      if (animate && from !== target) transitions.set(part.index, { from, target, start: now + (replay || entering ? order * 70 : 0), duration: 600 });
      if (waitForClearance) {
        nextActive.delete(part.index);
        pending.set(part.index, part.bounds.maxY - seam);
      }
    });
    active = nextActive;
    packed = null;
    dirty = true;
  }

  function sample(now) {
    for (const [index, transition] of transitions) {
      const t = Math.max(0, Math.min(1, (now - transition.start) / transition.duration));
      offsets.set(index, transition.from + (transition.target - transition.from) * (1 - (1 - t) ** 3));
      if (t === 1) transitions.delete(index);
    }
    const masterBottom = master.bounds.minY + offsets.get(master.index);
    for (const [index, top] of pending) {
      if (masterBottom >= top - 1e-7) {
        active.add(index);
        pending.delete(index);
        packed = null;
        dirty = true;
      }
    }
  }

  function pack() {
    const arrays = { positions: [], normals: [], colors: [], isGreen: [], fillPattern: [], objectIndex: [], linePositions: [], lineIsGreen: [] };
    for (let i = 0; i < source.objectIndex.length; i++) {
      const index = source.objectIndex[i];
      if (!active.has(index)) continue;
      for (const field of ['positions', 'normals', 'colors']) arrays[field].push(...source[field].subarray(i * 3, i * 3 + 3));
      for (const field of ['isGreen', 'fillPattern', 'objectIndex']) arrays[field].push(source[field][i]);
    }
    const lineObjectIndex = [];
    for (let i = 0; i < edgeOwners.length; i++) {
      if (!active.has(edgeOwners[i])) continue;
      arrays.linePositions.push(...source.linePositions.subarray(i * 6, i * 6 + 6));
      arrays.lineIsGreen.push(source.lineIsGreen[i]);
      lineObjectIndex.push(edgeOwners[i]);
    }
    packed = Object.fromEntries(Object.entries(arrays).map(([field, values]) => [field, field === 'lineIsGreen' ? values : new Float32Array(values)]));
    packed.basePositions = packed.positions.slice();
    packed.baseLinePositions = packed.linePositions.slice();
    packed.lineObjectIndex = lineObjectIndex;
  }

  return {
    configure,
    update(now) {
      if (!dirty && transitions.size === 0 && pending.size === 0) return null;
      sample(now);
      const membershipChanged = !packed;
      if (!packed) pack();
      for (let i = 0; i < packed.objectIndex.length; i++) packed.positions[i * 3 + 1] = packed.basePositions[i * 3 + 1] + offsets.get(packed.objectIndex[i]);
      for (let i = 0; i < packed.lineObjectIndex.length; i++) {
        const offset = offsets.get(packed.lineObjectIndex[i]);
        packed.linePositions[i * 6 + 1] = packed.baseLinePositions[i * 6 + 1] + offset;
        packed.linePositions[i * 6 + 4] = packed.baseLinePositions[i * 6 + 4] + offset;
      }
      const objects = source.objects.map((object, index) => {
        const offset = offsets.get(index) || 0;
        return { ...object, center: [object.center[0], object.center[1] + offset, object.center[2]], bounds: { ...object.bounds, minY: object.bounds.minY + offset, maxY: object.bounds.maxY + offset } };
      });
      dirty = false;
      return { ...packed, objects, membershipChanged };
    },
    get activeNames() { return selected().map(part => part.name); },
    get animating() { return transitions.size > 0 || pending.size > 0; },
  };
}
