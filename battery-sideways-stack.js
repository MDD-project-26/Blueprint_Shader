// Independent EP5/EP12 layout with the same easing, slide/fade and intro
// timing as battery-stack.js. The imported row runs along Z; entry/exit uses
// +X just like the vertical module, while the intro closes gaps along Z.
export function createSidewaysBatteryStack(source) {
  const parts = source.objects.map((object, index) => ({ ...object, index }))
    .filter(object => /^EP(?:5|12)_Side-by-Side_-_Module_0[1-4]$/.test(object.name))
    .sort((a, b) => a.bounds.minZ - b.bounds.minZ);
  if (parts.length !== 4 || source.objects.length !== 4) return null;
  const pitch = parts[1].center[2] - parts[0].center[2];
  if (!(pitch > 0)) return null;
  const slideDistance = pitch * 1.4;
  const slideDuration = 150, staggerDuration = 35, settleDuration = 800;
  const clamp = value => Math.max(0, Math.min(1, value));
  const easeOut = t => Math.sin(Math.PI * t / 2);
  const easeInOutQuart = t => t < .5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2;
  const key = (positions, offset) => `${positions[offset]},${positions[offset + 1]},${positions[offset + 2]}`;
  const owners = new Map();
  source.objectIndex.forEach((owner, index) => owners.set(key(source.positions, index * 3), owner));
  const edgeOwners = [];
  for (let i = 0; i < source.linePositions.length; i += 6) edgeOwners.push(owners.get(key(source.linePositions, i)));
  if (edgeOwners.some(owner => owner === undefined)) return null;

  let count = 4, enabled = false, animate = true, dirty = true, spread = false;
  let active = new Set(parts.map(part => part.index)), tracks = [], packed = null;
  const offsets = new Float64Array(4);
  const slides = new Float64Array(4);
  const selected = () => enabled ? parts.slice(0, count) : parts;

  function sample(now) {
    const nextTracks = [];
    for (const track of tracks) {
      const phase = clamp((now - track.at - track.delay) / track.duration);
      const progress = track.settle ? easeInOutQuart(phase)
        : track.leaving ? 1 - easeOut(1 - phase) : easeOut(phase);
      const offset = track.from + (track.to - track.from) * progress;
      const values = track.spread ? offsets : slides;
      if (offset !== values[track.index]) dirty = true;
      values[track.index] = offset;
      if (track.entering && now >= track.at + track.delay && !active.has(track.index)) {
        active.add(track.index); packed = null; dirty = true;
      }
      if (phase === 1 && track.leaving) {
        active.delete(track.index); packed = null; dirty = true;
      }
      if (phase < 1) nextTracks.push(track);
    }
    tracks = nextTracks;
  }

  function configure(nextCount, nextEnabled, nextAnimate, now, replay = false) {
    if (!Number.isInteger(nextCount) || nextCount < 1 || nextCount > 4) throw new RangeError('Battery count must be an integer from 1 to 4.');
    sample(now);
    if (!replay && nextCount === count && nextEnabled === enabled && nextAnimate === animate) return;
    const wasEnabled = enabled;
    const wasSpread = spread || tracks.some(track => track.spread);
    count = nextCount; enabled = nextEnabled; animate = nextAnimate; spread = false;
    const wanted = new Set(selected().map(part => part.index));
    if (!animate || !enabled || !wasEnabled) {
      active = wanted; offsets.fill(0); slides.fill(0); tracks = [];
    } else if (replay) {
      active = wanted; slides.fill(0);
      tracks = selected().map((part, order) => {
        offsets[part.index] = order ? pitch * 2.2 : 0;
        return { index: part.index, at: now, delay: order * staggerDuration,
          duration: 300, from: offsets[part.index], to: 0, spread: true };
      });
    } else {
      // Count changes assemble any held intro pose, as in the vertical module.
      if (wasSpread) { offsets.fill(0); slides.fill(0); }
      const previousTracks = new Map(wasSpread ? [] : tracks.map(track => [track.index, track]));
      tracks = [];
      const departures = parts.filter(part => active.has(part.index) && !wanted.has(part.index)).reverse();
      const arrivals = parts.filter(part => wanted.has(part.index) && (!active.has(part.index) || slides[part.index] !== 0));
      const schedule = (orderedParts, leaving) => {
        let preceding = null;
        for (const part of orderedParts) {
          const index = part.index, visible = active.has(index);
          const to = leaving ? slideDistance : 0;
          const continuing = previousTracks.get(index);
          let track;
          if (continuing && continuing.to === to) {
            // Keep both elapsed motion and pending turns when the slider
            // advances again. Rebuilding these would delay the outer exit
            // and let a newly removed inner battery overtake it.
            track = continuing;
          } else {
            const from = visible ? slides[index] : slideDistance;
            slides[index] = from;
            const duration = Math.max(1, slideDuration * Math.abs(to - from) / slideDistance);
            const start = preceding
              ? Math.max(now, preceding.at + preceding.delay + staggerDuration,
                preceding.at + preceding.delay + preceding.duration - duration)
              : now;
            track = { index, at: now, delay: start - now, duration,
              from, to, entering: !leaving && !visible, leaving };
          }
          tracks.push(track);
          preceding = track;
        }
      };
      // Remove from the outside inward; insert from the inside outward.
      schedule(departures, true);
      schedule(arrivals, false);
    }
    packed = null; dirty = true;
  }

  function pack() {
    const copyRanges = (ownerList, stride) => {
      const ranges = [];
      let cursor = 0;
      for (const part of parts) {
        if (!active.has(part.index)) continue;
        for (let start = 0; start < ownerList.length;) {
          const index = ownerList[start];
          let end = start + 1;
          while (end < ownerList.length && ownerList[end] === index) end++;
          if (index === part.index) {
            const length = (end - start) * stride;
            ranges.push({ index, sourceStart: start * stride, start: cursor, end: cursor + length });
            cursor += length;
          }
          start = end;
        }
      }
      return { ranges, length: cursor };
    };
    const vertices = copyRanges(source.objectIndex, 3), lines = copyRanges(edgeOwners, 6);
    packed = { vertexRanges: vertices.ranges, lineRanges: lines.ranges };
    for (const field of ['positions', 'normals', 'colors']) packed[field] = new Float32Array(vertices.length);
    for (const field of ['isGreen', 'fillPattern', 'objectIndex']) packed[field] = new Float32Array(vertices.length / 3);
    packed.linePositions = new Float32Array(lines.length);
    packed.lineIsGreen = [];
    for (const range of vertices.ranges) {
      const length = range.end - range.start;
      for (const field of ['positions', 'normals', 'colors']) packed[field].set(source[field].subarray(range.sourceStart, range.sourceStart + length), range.start);
      for (const field of ['isGreen', 'fillPattern', 'objectIndex']) packed[field].set(source[field].subarray(range.sourceStart / 3, (range.sourceStart + length) / 3), range.start / 3);
    }
    for (const range of lines.ranges) {
      const length = range.end - range.start;
      packed.linePositions.set(source.linePositions.subarray(range.sourceStart, range.sourceStart + length), range.start);
      for (let edge = 0; edge < length / 6; edge++) packed.lineIsGreen[range.start / 6 + edge] = source.lineIsGreen[range.sourceStart / 6 + edge];
    }
  }

  return {
    configure,
    spreadApart(gap) {
      if (!enabled) return;
      tracks = []; spread = true; slides.fill(0); active = new Set(selected().map(part => part.index));
      selected().forEach((part, order) => { offsets[part.index] = order * gap; });
      packed = null; dirty = true;
    },
    settle(now, duration = settleDuration) {
      if (!spread) return;
      spread = false;
      tracks = selected().map(part => ({ index: part.index, at: now, delay: 0,
        duration, from: offsets[part.index], to: 0, settle: true, spread: true }));
      dirty = true;
    },
    update(now) {
      sample(now);
      if (!dirty) return null;
      const membershipChanged = !packed;
      if (!packed) pack();
      for (const [ranges, positions, original] of [
        [packed.vertexRanges, packed.positions, source.positions],
        [packed.lineRanges, packed.linePositions, source.linePositions],
      ]) {
        for (const range of ranges) {
          for (let vertex = range.start; vertex < range.end; vertex += 3) {
            const sourceVertex = range.sourceStart + vertex - range.start;
            positions[vertex] = original[sourceVertex] + slides[range.index];
            positions[vertex + 2] = original[sourceVertex + 2] + offsets[range.index];
          }
        }
      }
      dirty = false;
      const objects = source.objects.map((object, index) => ({ ...object,
        center: [object.center[0] + slides[index], object.center[1], object.center[2] + offsets[index]],
        bounds: { ...object.bounds,
          minX: object.bounds.minX + slides[index], maxX: object.bounds.maxX + slides[index],
          minZ: object.bounds.minZ + offsets[index], maxZ: object.bounds.maxZ + offsets[index],
        },
      }));
      const fades = [...active].filter(index => slides[index] > 0)
        .map(index => ({ index, opacity: 1 - clamp(slides[index] / slideDistance) }));
      return { ...packed, objects, fades, membershipChanged };
    },
    get activeNames() { return selected().map(part => part.name); },
    get centerOffset() { return enabled ? (count - 4) * pitch / 2 : 0; },
    get animating() { return tracks.length > 0; },
  };
}
