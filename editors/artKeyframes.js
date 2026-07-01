// Pure, DOM-free keyframe-editing operations for the art editor's timeline.
// Mirrors the data the runtime samples: clip metadata at `art.animations[clipKey]`
// ({ duration, loop }) and per-shape tracks at `shape.anim[clipKey][propPath]`
// (arrays of { t, v, ease? }). Unit-tested in Node like artCoordModel / midiModel.
//
// Game-agnostic, no DOM: every function takes plain art / shape objects and mutates
// them in place (the editor snapshots the whole asset for undo, so that's fine).

import { unifyCoordKeys } from '/engine/render/interp.js';

const T_EPS = 1; // ms: keys within this of each other are the "same" time

// ── Clip metadata (art.animations) ───────────────────────────────────────────

/** Default clip loop mode: ambient "*" loops, per-state clips play once. */
export function defaultLoop(clipKey) { return clipKey === '*'; }

/** Ensure art.animations[clipKey] exists; returns the clip-meta object. */
export function ensureClip(art, clipKey, opts = {}) {
  if (!art.animations) art.animations = {};
  if (!art.animations[clipKey]) {
    art.animations[clipKey] = {
      duration: opts.duration ?? 2000,
      loop: opts.loop ?? defaultLoop(clipKey),
    };
  }
  return art.animations[clipKey];
}

export function clipMeta(art, clipKey) {
  return (art && art.animations && art.animations[clipKey]) || null;
}

export function clipKeys(art) {
  return art && art.animations ? Object.keys(art.animations) : [];
}

export function setClipMeta(art, clipKey, patch) {
  const clip = ensureClip(art, clipKey);
  if (patch.duration !== undefined) clip.duration = patch.duration;
  if (patch.loop !== undefined) clip.loop = patch.loop;
  return clip;
}

/** Remove a clip's metadata AND every shape's tracks for that clip. */
export function removeClip(art, clipKey) {
  if (art.animations) delete art.animations[clipKey];
  if (art.animations && Object.keys(art.animations).length === 0) delete art.animations;
  walkShapes(art.shapes, (shape) => {
    if (shape.anim && shape.anim[clipKey]) {
      delete shape.anim[clipKey];
      if (Object.keys(shape.anim).length === 0) delete shape.anim;
    }
  });
}

// ── Tracks (shape.anim) ──────────────────────────────────────────────────────

export function getTrack(shape, clipKey, prop) {
  return (shape.anim && shape.anim[clipKey] && shape.anim[clipKey][prop]) || null;
}

export function hasAnim(shape) {
  return !!(shape.anim && Object.keys(shape.anim).length);
}

/**
 * Insert or update a keyframe at time `t`. A key within T_EPS of `t` is updated
 * (value, and ease when provided); otherwise a new key is inserted and the track
 * is re-sorted. Coord-object tracks are normalized to a shared key set so JSON
 * stays clean and adjacent keys never snap a missing component. Returns the track.
 */
export function setKeyframe(shape, clipKey, prop, t, v, ease) {
  if (!shape.anim) shape.anim = {};
  if (!shape.anim[clipKey]) shape.anim[clipKey] = {};
  let track = shape.anim[clipKey][prop];
  if (!track) track = shape.anim[clipKey][prop] = [];
  const existing = track.find((k) => Math.abs(k.t - t) <= T_EPS);
  if (existing) {
    existing.v = v;
    if (ease !== undefined) { if (ease) existing.ease = ease; else delete existing.ease; }
  } else {
    const key = { t, v };
    if (ease) key.ease = ease;
    track.push(key);
    track.sort((a, b) => a.t - b.t);
  }
  shape.anim[clipKey][prop] = unifyCoordKeys(track);
  return shape.anim[clipKey][prop];
}

/** Delete a keyframe by index; prunes the now-empty track / clip / anim block. */
export function deleteKeyframe(shape, clipKey, prop, index) {
  const track = getTrack(shape, clipKey, prop);
  if (!track || index < 0 || index >= track.length) return;
  track.splice(index, 1);
  if (track.length === 0) {
    delete shape.anim[clipKey][prop];
    if (Object.keys(shape.anim[clipKey]).length === 0) delete shape.anim[clipKey];
    if (Object.keys(shape.anim).length === 0) delete shape.anim;
  }
}

/** Delete an entire track for a shape. */
export function deleteTrack(shape, clipKey, prop) {
  if (!shape.anim || !shape.anim[clipKey]) return;
  delete shape.anim[clipKey][prop];
  if (Object.keys(shape.anim[clipKey]).length === 0) delete shape.anim[clipKey];
  if (Object.keys(shape.anim).length === 0) delete shape.anim;
}

export function clampTime(t, duration) {
  return Math.max(0, Math.min(duration || 0, t));
}

/** Copy the first key's value onto a key at `duration`, so a loop is seamless. */
export function makeLoopable(shape, clipKey, prop, duration) {
  const track = getTrack(shape, clipKey, prop);
  if (!track || track.length === 0) return;
  const first = track[0];
  setKeyframe(shape, clipKey, prop, duration, cloneVal(first.v), first.ease);
}

// ── Listing (timeline rows) ──────────────────────────────────────────────────

/** Depth-first walk of a shapes tree; calls fn(shape, path) for every shape. */
export function walkShapes(shapes, fn, base = []) {
  if (!Array.isArray(shapes)) return;
  shapes.forEach((shape, i) => {
    const path = [...base, i];
    fn(shape, path);
    const kids = shape.shapes || shape.children;
    if (kids) walkShapes(kids, fn, path);
  });
}

/** All tracks for a clip across the whole asset: [{ path, shape, name, prop, keys }]. */
export function listTracks(art, clipKey) {
  const rows = [];
  walkShapes(art.shapes, (shape, path) => {
    const tracks = shape.anim && shape.anim[clipKey];
    if (!tracks) return;
    for (const prop of Object.keys(tracks)) {
      rows.push({ path, shape, name: shape.name || shape.type || '?', prop, keys: tracks[prop] });
    }
  });
  return rows;
}

// ── Part rows + pose ops (the part-centric timeline view) ─────────────────────
// A "part row" collapses all of one shape's property tracks into a single row;
// a diamond marks any time at which that part has >=1 keyed property (a "pose").
// Dragging a part diamond retimes the whole pose; deleting it removes the pose.

/** Sorted union of all key times across a shape's tracks in a clip, clustered
 *  within `tol` (keys closer than that are the same pose / one diamond). */
export function poseTimes(shape, clipKey, tol = T_EPS) {
  const tracks = shape.anim && shape.anim[clipKey];
  if (!tracks) return [];
  const times = [];
  for (const prop of Object.keys(tracks)) {
    for (const k of tracks[prop]) {
      if (k && typeof k.t === 'number') times.push(k.t);
    }
  }
  times.sort((a, b) => a - b);
  const out = [];
  for (const t of times) if (out.length === 0 || t - out[out.length - 1] > tol) out.push(t);
  return out;
}

/** One row per shape that has >=1 track in `clipKey`:
 *  { path, shape, name, depth, times, propCount }. The timeline appends the
 *  selected-but-unkeyed part itself, so this stays "parts that have keys." */
export function listPartRows(art, clipKey) {
  const rows = [];
  walkShapes(art.shapes, (shape, path) => {
    const tracks = shape.anim && shape.anim[clipKey];
    if (!tracks || Object.keys(tracks).length === 0) return;
    rows.push({
      path, shape,
      name: shape.name || shape.type || '?',
      depth: path.length - 1,
      times: poseTimes(shape, clipKey),
      propCount: Object.keys(tracks).length,
    });
  });
  return rows;
}

/** Retime every track's key near `fromT` to `toT` (merging if one already sits at
 *  `toT`). Tracks with no key near `fromT` are left alone. Returns count moved. */
export function movePose(shape, clipKey, fromT, toT, tol = T_EPS) {
  const tracks = shape.anim && shape.anim[clipKey];
  if (!tracks) return 0;
  const dst = Math.round(toT);
  let moved = 0;
  for (const prop of Object.keys(tracks)) {
    const track = tracks[prop];
    const idx = track.findIndex((k) => Math.abs(k.t - fromT) <= tol);
    if (idx < 0) continue;
    const { v, ease } = track[idx];
    track.splice(idx, 1);
    setKeyframe(shape, clipKey, prop, dst, v, ease);
    moved++;
  }
  return moved;
}

/** Delete every track's key near `t` (the whole pose at that time). Prunes empty
 *  tracks/clip/anim via deleteKeyframe. Returns count deleted. */
export function deletePose(shape, clipKey, t, tol = T_EPS) {
  const tracks = shape.anim && shape.anim[clipKey];
  if (!tracks) return 0;
  let deleted = 0;
  for (const prop of Object.keys(tracks)) {
    const track = tracks[prop];
    if (!track) continue;
    const idx = track.findIndex((k) => Math.abs(k.t - t) <= tol);
    if (idx >= 0) { deleteKeyframe(shape, clipKey, prop, idx); deleted++; }
  }
  return deleted;
}

/** Snapshot a pose at `t`: key each prop that already has a track in the clip
 *  (or every keyframeable prop when none exist yet — bootstrap) to `valueAt(prop)`.
 *  The caller supplies the effective (sampled-or-base) value so an insert into an
 *  existing curve is non-destructive. Returns the number of props keyed. */
export function keyPose(shape, clipKey, t, valueAt) {
  const tracked = (shape.anim && shape.anim[clipKey]) ? Object.keys(shape.anim[clipKey]) : [];
  const targets = tracked.length ? tracked : keyframeableProps(shape).map((p) => p.prop);
  const rt = Math.round(t);
  let n = 0;
  for (const prop of targets) {
    const v = valueAt(prop);
    if (v === undefined) continue;
    setKeyframe(shape, clipKey, prop, rt, coerceToTrack(getTrack(shape, clipKey, prop), cloneVal(v)));
    n++;
  }
  return n;
}

// ── Value-shape coercion (keep a track internally consistent) ─────────────────

/** A neutral default value for a keyframeable prop kind (used to seed a t=0 key
 *  when the effective rest is undefined). */
export function defaultFor(kind) {
  if (kind === 'coord') return { base: 0 };
  if (kind === 'color') return '#ffffff';
  return 0;
}

/** Conform `v` to the shape of a reference value `ref`: a plain number written
 *  against a coord-object track becomes `{ base: v }` (other terms get filled to 0
 *  by unifyCoordKeys); an object written against a scalar track flattens to its
 *  base. Colors / matching shapes pass through. */
export function coerceToShapeOf(ref, v) {
  if (ref && typeof ref === 'object' && !Array.isArray(ref) && typeof v === 'number') {
    return { base: v };
  }
  if (typeof ref === 'number' && v && typeof v === 'object' && !Array.isArray(v)) {
    return v.base ?? 0;
  }
  return v;
}

/** Conform a new value `v` to a track's existing first-key shape (empty track →
 *  unchanged), so number/coord-object tracks never end up mixed. */
export function coerceToTrack(track, v) {
  if (!Array.isArray(track) || track.length === 0) return v;
  return coerceToShapeOf(track[0].v, v);
}

// ── Keyframeable property model ───────────────────────────────────────────────

/** The path the renderer actually reads a color from for this shape. */
export function colorPropPath(shape, which = 'fill') {
  const key = which === 'stroke' ? 'strokeColor' : 'fillColor';
  if (which === 'fill' && shape.fillColor !== undefined) return 'fillColor';
  if (shape.setup && shape.setup[key] !== undefined) return 'setup.' + key;
  return 'setup.' + key;
}

/** Read the current authoring value at a (possibly dotted) prop path. */
export function getPropValue(shape, propPath) {
  const parts = propPath.split('.');
  let v = shape;
  for (const p of parts) {
    if (v == null) return undefined;
    v = v[/^\d+$/.test(p) ? Number(p) : p];
  }
  return v;
}

/** Properties this shape type can be keyframed on, for the timeline "add track" menu. */
export function keyframeableProps(shape) {
  const t = shape.type;
  const out = [];
  const add = (prop, label, kind) => out.push({ prop, label, kind });
  if (t === 'effectRef') {
    // A VFX effect attached to the art: keyframe where/how-big it draws, and a
    // `progress` (0..1) track to drive/fire its playback from the clip timeline.
    add('cx', 'Position X', 'coord'); add('cy', 'Position Y', 'coord');
    add('scale', 'Scale', 'number');
    add('progress', 'Effect progress (fire)', 'number');
    return out;
  }
  if (t === 'circle' || t === 'arc') {
    add('cx', 'Position X', 'coord'); add('cy', 'Position Y', 'coord');
    add(shape.radiusAbs !== undefined ? 'radiusAbs' : 'radius', 'Radius', 'coord');
  } else if (t === 'rect' || t === 'strokeRect' || t === 'roundedRect') {
    add('x', 'X', 'coord'); add('y', 'Y', 'coord');
    add(t === 'roundedRect' ? 'width' : 'w', 'Width', 'coord');
    add(t === 'roundedRect' ? 'height' : 'h', 'Height', 'coord');
  } else if (shape.cx !== undefined || shape.cy !== undefined) {
    add('cx', 'Position X', 'coord'); add('cy', 'Position Y', 'coord');
  }
  add('rotation', 'Rotation', 'number');
  add('setup.alpha', 'Opacity', 'number');
  add('setup.shadowBlur', 'Glow', 'number');
  add('setup.lineWidth', 'Line width', 'number');
  if (t !== 'group') add(colorPropPath(shape), 'Color', 'color');
  return out;
}

// ── State rename / clone / delete (keeps clips in sync) ───────────────────────

export function renameAnimState(art, oldKey, newKey) {
  if (art.animations && art.animations[oldKey] && !art.animations[newKey]) {
    art.animations[newKey] = art.animations[oldKey];
    delete art.animations[oldKey];
  }
  walkShapes(art.shapes, (shape) => {
    if (shape.anim && shape.anim[oldKey]) {
      shape.anim[newKey] = shape.anim[oldKey];
      delete shape.anim[oldKey];
    }
  });
}

export function cloneAnimState(art, srcKey, newKey) {
  if (art.animations && art.animations[srcKey]) {
    art.animations[newKey] = JSON.parse(JSON.stringify(art.animations[srcKey]));
  }
  walkShapes(art.shapes, (shape) => {
    if (shape.anim && shape.anim[srcKey]) {
      shape.anim[newKey] = JSON.parse(JSON.stringify(shape.anim[srcKey]));
    }
  });
}

export function deleteAnimState(art, key) { removeClip(art, key); }

function cloneVal(v) { return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; }
