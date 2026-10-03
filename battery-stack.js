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
  const slideDistance = pitch * 1.4;
  const slideDuration = 150;
  const masterDuration = 300;
  const staggerDuration = 35;
  const easeOut = t => Math.sin(Math.PI * t / 2);
  const inverseEaseOut = progress => Math.asin(progress) * 2 / Math.PI;

  // Crease edges use the original vertex positions; retain their object ownership.
  const vertexOwners = new Map();
  const key = (positions, offset) => `${positions[offset]},${positions[offset + 1]},${positions[offset + 2]}`;
  for (let i = 0; i < source.objectIndex.length; i++) vertexOwners.set(key(source.positions, i * 3), source.objectIndex[i]);
  const edgeOwners = [];
  for (let i = 0; i < source.linePositions.length; i += 6) edgeOwners.push(vertexOwners.get(key(source.linePositions, i)));
  if (edgeOwners.some(owner => owner === undefined)) return null;

  // Contiguous source ranges let each layout copy complete attribute blocks.
  const makeRanges = (owners, stride) => {
    const ranges = [];
    for (let start = 0; start < owners.length;) {
      const index = owners[start];
      let end = start + 1;
      while (end < owners.length && owners[end] === index) end++;
      ranges.push({ index, start: start * stride, end: end * stride });
      start = end;
    }
    return ranges;
  };
  const vertexRanges = makeRanges(source.objectIndex, 3);
  const lineRanges = makeRanges(edgeOwners, 6);
  const layoutCache = new Map();
  const changed = new Uint8Array(parts.length);
  let lastReturnedPacked;
  let objects = source.objects.slice();
  const objectOffsets = new Float64Array(parts.length).fill(NaN);
  const objectSlides = new Float64Array(parts.length).fill(NaN);

  let enabled = false, count = 9, animate = true, dirty = true, packed;
  const offsets = new Map(parts.map(part => [part.index, 0]));
  const slideOffsets = new Map(parts.map(part => [part.index, 0]));
  let active = new Set(parts.map(part => part.index));
  let motion = null;
  const clamp = value => Math.max(0, Math.min(1, value));
  const selected = () => enabled ? [parts[0], ...parts.slice(1, count - 1), master] : parts;
  const masterOffset = total => (total - 9) * pitch;

  // One forward timeline per change: every moving part uses the same ease-out.
  // Existing slides retain their elapsed phase when the destination changes.
  function sample(now) {
    if (!motion?.running) return;
    const time = Math.max(0, Math.min(motion.duration, motion.time + now - motion.at));
    motion.time = time;
    motion.at = now;
    motion.running = time < motion.duration;
    const visible = new Set();
    for (const track of motion.tracks) {
      const progress = easeOut(clamp((time - track.start) / track.duration));
      const y = track.lowY + (track.highY - track.lowY) * progress;
      const x = track.lowX + (track.highX - track.lowX) * progress;
      if (offsets.get(track.index) !== y || slideOffsets.get(track.index) !== x) dirty = true;
      offsets.set(track.index, y);
      slideOffsets.set(track.index, x);
      const visibleNow = track.leaving ? time < track.start + track.duration - 1e-7
        : !track.entering || time >= track.start - 1e-7;
      if (visibleNow) visible.add(track.index);
    }
    if (visible.size !== active.size || [...visible].some(index => !active.has(index))) {
      active = visible;
      packed = null;
      dirty = true;
    }
  }

  function configure(nextCount, nextEnabled, nextAnimate, now, replay = false) {
    if (!Number.isInteger(nextCount) || nextCount < 3 || nextCount > 9) throw new RangeError('Battery count must be an integer from 3 to 9.');
    sample(now);
    if (!replay && count === nextCount && enabled === nextEnabled && animate === nextAnimate) return;
    const previousCount = count;
    const wasEnabled = enabled;
    count = nextCount;
    enabled = nextEnabled;
    animate = nextAnimate;
    const wanted = new Set(selected().map(part => part.index));

    if (!animate || !enabled || !wasEnabled) {
      motion = null;
      active = wanted;
      for (const part of parts) {
        offsets.set(part.index, enabled && part === master ? masterOffset(count) : 0);
        slideOffsets.set(part.index, 0);
      }
    } else if (replay) {
      active = wanted;
      const tracks = selected().map((part, order) => ({
        index: part.index, start: order * staggerDuration, duration: masterDuration,
        lowY: (part === master ? masterOffset(count) : 0) + (order ? pitch * 2.2 : 0),
        highY: part === master ? masterOffset(count) : 0, lowX: 0, highX: 0,
      }));
      motion = { tracks, duration: masterDuration + (count - 1) * staggerDuration, time: 0, at: now, running: true, replay: true };
      sample(now);
    } else {
      // A different destination gets a new path from the current visible pose.
      if (motion?.replay) {
        for (const part of parts) {
          offsets.set(part.index, part === master ? masterOffset(previousCount) : 0);
          slideOffsets.set(part.index, 0);
        }
      }
      const currentY = offsets.get(master.index);
      const targetY = masterOffset(count);
      const growing = targetY >= currentY;
      const tracks = [];
      const continuingSlide = (index, targetX) => {
        const previous = !motion?.replay && motion?.tracks.find(track => track.index === index);
        if (!previous || previous.highX !== targetX || previous.lowX === targetX || motion.time < previous.start) return null;
        return { ...previous, start: previous.start - motion.time };
      };
      const departures = [];
      let masterDelay = 0;
      // Schedule each exit to finish before the eased master reaches that slot.
      // A partly completed exit keeps its phase, rather than starting over.
      if (!growing) {
        for (const part of parts.slice(1, 8)) {
          if (!active.has(part.index) || wanted.has(part.index)) continue;
          const continued = continuingSlide(part.index, slideDistance);
          const currentX = slideOffsets.get(part.index);
          const length = continued ? Math.max(0, continued.start + continued.duration)
            : Math.max(1, slideDuration * clamp(1 - currentX / slideDistance));
          const top = part.bounds.maxY + offsets.get(part.index) - seam;
          const clearanceTime = currentY > targetY
            ? inverseEaseOut(clamp((master.bounds.minY + currentY - top) / (currentY - targetY))) * masterDuration : 0;
          departures.push({ part, continued, length, clearanceTime, currentX });
          masterDelay = Math.max(masterDelay, length - clearanceTime);
        }
      }
      tracks.push({ index: master.index, start: masterDelay, duration: masterDuration,
        lowY: currentY, highY: targetY, lowX: 0, highX: 0 });
      let duration = masterDelay + masterDuration;
      for (const { part, continued, length, clearanceTime, currentX } of departures) {
        const track = continued || { index: part.index, start: masterDelay + clearanceTime - length, duration: length,
          lowY: offsets.get(part.index), highY: offsets.get(part.index), lowX: currentX, highX: slideDistance };
        tracks.push({ ...track, entering: false, leaving: true });
        duration = Math.max(duration, track.start + track.duration);
      }
      for (const part of parts.slice(0, 8)) {
        const visible = active.has(part.index);
        const retained = wanted.has(part.index);
        if (!retained) continue;
        const entering = !visible;
        const currentX = visible ? slideOffsets.get(part.index) : slideDistance;
        const currentOffset = offsets.get(part.index);
        if (entering || currentX !== 0) {
          const top = part.bounds.maxY - seam;
          const start = entering && growing && targetY > currentY
            ? inverseEaseOut(clamp((top - master.bounds.minY - currentY) / (targetY - currentY))) * masterDuration : 0;
          const track = continuingSlide(part.index, 0) || { index: part.index, start,
            duration: Math.max(1, slideDuration * clamp(currentX / slideDistance)),
            lowY: 0, highY: 0, lowX: currentX, highX: 0 };
          tracks.push({ ...track, entering, leaving: false });
          duration = Math.max(duration, track.start + track.duration);
        } else {
          tracks.push({ index: part.index, start: 0, duration: masterDuration,
            lowY: currentOffset, highY: 0, lowX: 0, highX: 0 });
        }
      }
      motion = { tracks, duration, time: 0, at: now, running: true };
      sample(now);
    }
    packed = null;
    dirty = true;
  }

  function pack() {
    const mask = [...active].reduce((mask, index) => mask | (1 << index), 0);
    if (layoutCache.has(mask)) {
      packed = layoutCache.get(mask);
      layoutCache.delete(mask);
      layoutCache.set(mask, packed);
      return;
    }
    const vertices = vertexRanges.filter(range => active.has(range.index));
    const lines = lineRanges.filter(range => active.has(range.index));
    const positionLength = vertices.reduce((total, range) => total + range.end - range.start, 0);
    const lineLength = lines.reduce((total, range) => total + range.end - range.start, 0);
    packed = {};
    for (const field of ['positions', 'normals', 'colors']) packed[field] = new Float32Array(positionLength);
    for (const field of ['isGreen', 'fillPattern', 'objectIndex']) packed[field] = new Float32Array(positionLength / 3);
    packed.linePositions = new Float32Array(lineLength);
    packed.lineIsGreen = new Array(lineLength / 6);
    packed.lineObjectIndex = new Int32Array(lineLength / 6);
    packed.vertexRanges = [];
    packed.lineRanges = [];
    let cursor = 0;
    for (const range of vertices) {
      const length = range.end - range.start;
      for (const field of ['positions', 'normals', 'colors']) packed[field].set(source[field].subarray(range.start, range.end), cursor);
      for (const field of ['isGreen', 'fillPattern', 'objectIndex']) packed[field].set(source[field].subarray(range.start / 3, range.end / 3), cursor / 3);
      packed.vertexRanges.push({ index: range.index, start: cursor, end: cursor + length });
      cursor += length;
    }
    cursor = 0;
    for (const range of lines) {
      const length = range.end - range.start;
      packed.linePositions.set(source.linePositions.subarray(range.start, range.end), cursor);
      for (let edge = 0; edge < length / 6; edge++) packed.lineIsGreen[cursor / 6 + edge] = source.lineIsGreen[range.start / 6 + edge];
      packed.lineObjectIndex.fill(range.index, cursor / 6, (cursor + length) / 6);
      packed.lineRanges.push({ index: range.index, start: cursor, end: cursor + length });
      cursor += length;
    }
    packed.basePositions = packed.positions.slice();
    packed.baseLinePositions = packed.linePositions.slice();
    packed.appliedOffsets = new Float64Array(parts.length).fill(NaN);
    packed.appliedSlides = new Float64Array(parts.length).fill(NaN);
    layoutCache.set(mask, packed);
    // Bound memory during rapid reversals while retaining recurring layouts.
    if (layoutCache.size > 16) layoutCache.delete(layoutCache.keys().next().value);
  }

  return {
    configure,
    update(now) {
      if (!dirty && !motion?.running) return null;
      sample(now);
      if (!packed) pack();
      const membershipChanged = packed !== lastReturnedPacked;
      let geometryChanged = false, objectsChanged = false;
      for (const part of parts) {
        const index = part.index;
        const offset = offsets.get(index), slide = slideOffsets.get(index);
        changed[index] = packed.appliedOffsets[index] !== offset || packed.appliedSlides[index] !== slide ? 1 : 0;
        packed.appliedOffsets[index] = offset;
        packed.appliedSlides[index] = slide;
        if (objectOffsets[index] !== offset || objectSlides[index] !== slide) {
          const object = source.objects[index];
          objects[index] = { ...object, center: [object.center[0] + slide, object.center[1] + offset, object.center[2]], bounds: {
            ...object.bounds,
            minX: object.bounds.minX + slide, maxX: object.bounds.maxX + slide,
            minY: object.bounds.minY + offset, maxY: object.bounds.maxY + offset,
          } };
          objectOffsets[index] = offset;
          objectSlides[index] = slide;
          objectsChanged = true;
        }
      }
      for (const range of packed.vertexRanges) {
        if (!changed[range.index]) continue;
        geometryChanged = true;
        const slide = packed.appliedSlides[range.index], offset = packed.appliedOffsets[range.index];
        for (let vertex = range.start; vertex < range.end; vertex += 3) {
          packed.positions[vertex] = packed.basePositions[vertex] + slide;
          packed.positions[vertex + 1] = packed.basePositions[vertex + 1] + offset;
        }
      }
      for (const range of packed.lineRanges) {
        if (!changed[range.index]) continue;
        const slide = packed.appliedSlides[range.index], offset = packed.appliedOffsets[range.index];
        for (let vertex = range.start; vertex < range.end; vertex += 3) {
          packed.linePositions[vertex] = packed.baseLinePositions[vertex] + slide;
          packed.linePositions[vertex + 1] = packed.baseLinePositions[vertex + 1] + offset;
        }
      }
      if (!dirty && !membershipChanged && !geometryChanged && !objectsChanged) return null;
      dirty = false;
      lastReturnedPacked = packed;
      return { ...packed, objects: objects.slice(), membershipChanged };
    },
    get activeNames() { return selected().map(part => part.name); },
    get animating() { return !!motion?.running; },
  };
}
