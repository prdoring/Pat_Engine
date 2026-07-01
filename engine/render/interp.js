/**
 * Pure, canvas-free interpolation + keyframe-sampling math for the unified art
 * system. Shared by ArtInterpreter (runtime) and the art-editor timeline so there
 * is exactly one implementation of "what value is this track at time t".
 *
 * Game-agnostic: no game nouns, no DOM, no canvas, no `eval`/`new Function`.
 * IMPORTANT: never import ArtInterpreter.js (or any renderer) from here — keeping
 * this leaf-level avoids an import cycle when the interpreter imports `lerpValue`.
 */

const PI = Math.PI;

// ── Value interpolation ──────────────────────────────────────────────────────

/**
 * Interpolate between two values. Handles numbers, arrays (points), and nested
 * objects (coord-objects, setup). Non-numeric scalars snap to `b` when t >= 0.5.
 * (Moved here from ArtInterpreter; the state-crossfade reuses it unchanged.)
 */
export function lerpValue(a, b, t) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.max(a.length, b.length);
    const result = [];
    for (let i = 0; i < len; i++) result.push(lerpValue(a[i], b[i], t));
    return result;
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const result = {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) result[k] = lerpValue(a[k], b[k], t);
    return result;
  }
  return t < 0.5 ? a : b;
}

// ── Color interpolation ──────────────────────────────────────────────────────

function parseHex(h) {
  if (typeof h !== 'string' || h[0] !== '#') return null;
  let s = h.slice(1);
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (s.length !== 6) return null;
  const n = parseInt(s, 16);
  if (!Number.isFinite(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
/**
 * Interpolate two hex colors (#rgb or #rrggbb) in sRGB. Big hue swings band a
 * little at the midpoint — fine for shimmer/glow tweens. Non-hex snaps at t>=0.5.
 */
export function lerpColor(a, b, t) {
  const ca = parseHex(a), cb = parseHex(b);
  if (!ca || !cb) return t < 0.5 ? a : b;
  return toHex(ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t);
}

const isHex = (v) => typeof v === 'string' && v[0] === '#';

/**
 * Interpolate a single keyframe value pair. Colors tween via lerpColor; flat
 * coord-objects union their key sets treating a MISSING numeric term as 0 (so a
 * `{base:18}` → `{base:24, r:0.1}` segment grows `r` from 0 instead of snapping —
 * `lerpValue` alone would snap the missing term). Everything else → lerpValue.
 */
export function lerpKeyValue(a, b, t) {
  if (isHex(a) && isHex(b)) return lerpColor(a, b, t);
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out = {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const av = a[k] ?? 0, bv = b[k] ?? 0;
      out[k] = (typeof av === 'number' && typeof bv === 'number') ? av + (bv - av) * t : lerpValue(av, bv, t);
    }
    return out;
  }
  return lerpValue(a, b, t);
}

// ── Easing ───────────────────────────────────────────────────────────────────

/**
 * Easing curves on the normalized segment t∈[0,1]. `easeInOutSine` is the default
 * for keyframes: a min→max→min loop authored with it reproduces a sine wave
 * exactly, so converted oscillators are pixel-faithful.
 */
export const EASING = {
  linear: (t) => t,
  easeInSine: (t) => 1 - Math.cos((t * PI) / 2),
  easeOutSine: (t) => Math.sin((t * PI) / 2),
  easeInOutSine: (t) => -(Math.cos(PI * t) - 1) / 2,
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => 1 - (1 - t) * (1 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2),
  easeInCubic: (t) => t ** 3,
  easeOutCubic: (t) => 1 - (1 - t) ** 3,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - ((-2 * t + 2) ** 3) / 2),
};
export const EASE_NAMES = Object.keys(EASING);

export function applyEase(name, t) {
  const fn = EASING[name] || EASING.linear;
  return fn(t);
}

// ── Clip clock ───────────────────────────────────────────────────────────────

/**
 * Map wall-clock `now` (ms) to a clip-local time in [0, duration].
 * - loop: continuous modulo (ambient clips pass epoch 0 so they never reset);
 * - once: clamped (play-once clips pass the state-entry epoch and hold the end).
 * Guards a non-positive / NaN duration → 0 (no `% 0` → NaN canvas coords).
 */
export function clipLocalTime(now, epoch, duration, loop) {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const elapsed = (Number.isFinite(now) ? now : 0) - (Number.isFinite(epoch) ? epoch : 0);
  if (loop) {
    const m = elapsed % duration;
    return m < 0 ? m + duration : m;
  }
  return Math.max(0, Math.min(duration, elapsed));
}

// ── Keyframe sampling ────────────────────────────────────────────────────────

/**
 * Sample one track (array of { t, v, ease? }, ease applies to the segment ENDING
 * at that key) at clip-local time `localT`. Returns the held value before the
 * first / after the last key. Robust to unsorted keys (finds bracketing keys
 * without assuming order) and to empty input (returns undefined).
 */
export function sampleTrack(keys, localT) {
  if (!Array.isArray(keys) || keys.length === 0) return undefined;
  const t = Number.isFinite(localT) ? localT : 0;
  let lo = null, hi = null;
  for (const k of keys) {
    if (!k || typeof k.t !== 'number') continue;
    if (k.t <= t && (!lo || k.t > lo.t)) lo = k;
    if (k.t >= t && (!hi || k.t < hi.t)) hi = k;
  }
  if (!lo && !hi) return undefined;
  if (!lo) return hi.v;          // before the first key
  if (!hi) return lo.v;          // after the last key
  if (lo === hi || hi.t === lo.t) return hi.v; // exactly on a key
  let f = (t - lo.t) / (hi.t - lo.t);
  f = applyEase(hi.ease || 'linear', f);
  return lerpKeyValue(lo.v, hi.v, f);
}

/**
 * Sample every track of a shape's `anim` block into a flat { propPath: value }
 * override map. Composites the `"*"` (ambient) clip first, then the state clip
 * (state beats ambient for the same prop). `clocks` maps clipKey → local time;
 * only clips present in BOTH `shapeAnim` and `clocks` are sampled. Returns null
 * when nothing is sampled (so the caller can skip cloning the shape this frame).
 */
export function sampleClips(shapeAnim, state, clocks) {
  if (!shapeAnim || !clocks) return null;
  let out = null;
  for (const clipKey of ['*', state]) {
    if (clipKey == null) continue;
    const tracks = shapeAnim[clipKey];
    const localT = clocks[clipKey];
    if (!tracks || localT == null) continue;
    for (const prop in tracks) {
      const v = sampleTrack(tracks[prop], localT);
      if (v === undefined) continue;
      if (!out) out = {};
      out[prop] = v;
    }
  }
  return out;
}

// ── Pose application (sampled map → shape) ───────────────────────────────────
//
// A sampled clip yields a flat { propPath: value } map (see sampleClips). These
// helpers apply that map onto a shape (clone-on-write) and crossfade between two
// sampled poses during a state transition. Pure — no canvas, no renderer import —
// so runtime (ArtInterpreter) and the editor timeline share one implementation.

const _idxRe = /^\d+$/;
const _idx = (p) => (_idxRe.test(p) ? Number(p) : p);

/**
 * Merge a sampled { propPath: value } map onto a fresh clone of `shape`. Dotted
 * paths (`setup.alpha`, `points.2`, `segments.0.1`) clone-on-write down the path
 * so the registry/raw art is never mutated. Always shallow-clones the top level
 * and clones each nested container the first time it is touched.
 */
export function applySampledOverrides(shape, sampled) {
  const out = { ...shape };
  for (const path in sampled) {
    const v = sampled[path];
    const parts = path.split('.');
    if (parts.length === 1) { out[parts[0]] = v; continue; }
    let node = out, src = shape;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = _idx(parts[i]);
      const srcChild = src ? src[key] : undefined;
      if (node[key] === srcChild) {  // not yet cloned on this output branch
        node[key] = Array.isArray(srcChild) ? srcChild.slice() : { ...(srcChild || {}) };
      }
      node = node[key];
      src = srcChild;
    }
    node[_idx(parts[parts.length - 1])] = v;
  }
  return out;
}

/** Lerp two sampled pose maps (used for the state-entry/exit pose crossfade). */
export function lerpPoseMaps(from, to, t) {
  const out = {};
  const keys = new Set([...Object.keys(from), ...(to ? Object.keys(to) : [])]);
  for (const k of keys) {
    const a = from[k], b = to ? to[k] : undefined;
    if (a === undefined) out[k] = b;
    else if (b === undefined) out[k] = a;
    else out[k] = lerpKeyValue(a, b, t);
  }
  return out;
}

/**
 * Pose-snapshot crossfade. On a state change the entity's `transition` froze the
 * previous frame's composited pose per shape (`_snapPose`, keyed by the raw shape
 * object). While the static-override blend is in progress (`blendPrev`/`blendT`),
 * ease from that frozen pose into the freshly-sampled pose — killing the pop when
 * an ambient clip is at an arbitrary phase at entry, or a one-shot holds its end
 * frame at exit. Always records the (possibly blended) live pose so the next state
 * change snapshots a continuous value. No-op (returns `sampled`) when the entity
 * carries no pose store (props/title) or no blend window is open.
 */
export function applyPoseBlend(dc, rawShape, sampled) {
  const t = dc.transition;
  if (!t || !t._livePose) return sampled;
  let result = sampled;
  if (dc.blendPrev != null && dc.blendT < 1 && t._snapPose) {
    const from = t._snapPose.get(rawShape);
    if (from) result = lerpPoseMaps(from, sampled || {}, dc.blendT);
  }
  if (result) t._livePose.set(rawShape, result);
  return result;
}

// ── Authoring helper (editor) ────────────────────────────────────────────────

/**
 * Normalize a track's flat coord-object values to a shared key set (missing terms
 * filled with 0) so authored data and JSON diffs stay clean. Number/color/point
 * tracks are returned untouched. Pure; returns a new keys array (does not mutate).
 */
export function unifyCoordKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return keys;
  const allObjects = keys.every((k) => k && k.v && typeof k.v === 'object' && !Array.isArray(k.v));
  if (!allObjects) return keys;
  const union = new Set();
  for (const k of keys) for (const p of Object.keys(k.v)) union.add(p);
  return keys.map((k) => {
    const v = {};
    for (const p of union) v[p] = k.v[p] ?? 0;
    return { ...k, v };
  });
}
