/**
 * Generic declarative Canvas2D art renderer.
 * Renders art definitions from JSON — all coordinates are radius-relative
 * (multiplied by `r` at render time) unless marked with `Abs` suffix.
 */

import { drawPhasedEffect } from './VFXInterpreter.js';
import { lerpValue, lerpKeyValue, sampleClips, clipLocalTime } from './interp.js';

// Re-export so existing importers of lerpValue keep working (it now lives in the
// pure, canvas-free interp module shared with the editor timeline).
export { lerpValue };

const PI = Math.PI;

// Optional VFX-effect resolver, injected by the host (game / editor / shots) so
// the pure interpreter never imports project data. `effectRef` shapes name a VFX
// effect by id; the host resolves id → definition. Left null → effectRef is a no-op.
let _effectResolver = null;
export function setEffectResolver(fn) { _effectResolver = fn; }
const _effectWarn = new Set();

/**
 * Parse a tiny arithmetic expression with a recursive-descent parser.
 * Grammar:
 *   expr   := term (('+' | '-') term)*
 *   term   := factor (('*' | '/') factor)*
 *   factor := ('-' | '+') factor | '(' expr ')' | number | 'PI'
 * Supports decimal numbers, + - * /, parentheses, unary minus/plus, and the
 * constant PI (= Math.PI). No eval / new Function — runs under a strict CSP
 * with no `unsafe-eval`. Throws on malformed input (callers catch).
 * @returns {number}
 */
function parseArithmetic(str) {
  const s = str;
  let i = 0;

  const skipWs = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++; };

  function parseFactor() {
    skipWs();
    const c = s[i];
    if (c === '-') { i++; return -parseFactor(); }
    if (c === '+') { i++; return parseFactor(); }
    if (c === '(') {
      i++;
      const value = parseExpr();
      skipWs();
      if (s[i] !== ')') throw new Error('expected )');
      i++;
      return value;
    }
    if (s.startsWith('PI', i)) { i += 2; return PI; }
    // decimal number (digits, optional fraction; or leading-dot fraction)
    const start = i;
    while (i < s.length && s[i] >= '0' && s[i] <= '9') i++;
    if (s[i] === '.') { i++; while (i < s.length && s[i] >= '0' && s[i] <= '9') i++; }
    if (i === start) throw new Error('expected number');
    const num = Number(s.slice(start, i));
    if (!Number.isFinite(num)) throw new Error('bad number');
    return num;
  }

  function parseTerm() {
    let value = parseFactor();
    for (;;) {
      skipWs();
      const c = s[i];
      if (c === '*') { i++; value *= parseFactor(); }
      else if (c === '/') { i++; value /= parseFactor(); }
      else break;
    }
    return value;
  }

  function parseExpr() {
    let value = parseTerm();
    for (;;) {
      skipWs();
      const c = s[i];
      if (c === '+') { i++; value += parseTerm(); }
      else if (c === '-') { i++; value -= parseTerm(); }
      else break;
    }
    return value;
  }

  const result = parseExpr();
  skipWs();
  if (i !== s.length) throw new Error('unexpected trailing input');
  return result;
}

/**
 * Evaluate an angle value. Strings like "-PI*0.7" are parsed; numbers pass
 * through. On ANY parse error returns 0 (never throws) so a malformed value
 * can't kill the render frame. Results are cached so repeated identical
 * expressions are O(1).
 */
const _angleCache = new Map();
let _angleWarned = false;
export function evalAngle(val) {
  if (typeof val === 'number') return val;
  if (typeof val !== 'string') return 0;
  if (_angleCache.has(val)) return _angleCache.get(val);
  let result;
  try {
    result = parseArithmetic(val);
    if (typeof result !== 'number' || !Number.isFinite(result)) result = 0;
  } catch {
    if (!_angleWarned) {
      _angleWarned = true;
      console.warn(`[ArtInterpreter] Failed to parse angle expression ${JSON.stringify(val)} (returning 0). Further angle-parse warnings suppressed.`);
    }
    result = 0;
  }
  _angleCache.set(val, result);
  return result;
}

/**
 * Finish a shape — fill and/or stroke based on flags.
 * Fill first, then stroke (standard convention) so a distinctly-colored
 * outline paints on top of the fill at its full weight.
 */
function finishShape(ctx, shape) {
  if (shape.fill) ctx.fill();
  if (shape.stroke) ctx.stroke();
}

/**
 * Resolve a coordinate value in the unified coordinate system.
 * - number: val * r (backwards compatible with module art)
 * - object: { base: c, r: f, w: f, h: f } — linear combination
 *   result = c + f_r * r + f_w * w + f_h * h
 *   `base` is an ABSOLUTE (non-r-scaled) additive constant term, consistent
 *   with how `resolveSetupVal` treats `base`.
 * - string: look up in varMap (for forEach/repeat loop vars), multiply by r
 */
export function resolveCoord(val, dc, varMap) {
  if (typeof val === 'number') return val * dc.r;
  if (typeof val === 'string') {
    if (varMap && varMap[val] !== undefined) return varMap[val] * dc.r;
    return 0;
  }
  if (typeof val === 'object' && val !== null) {
    let result = 0;
    for (const [k, v] of Object.entries(val)) {
      if (k === 'base') { result += v; }
      else if (k === 'r') { result += v * dc.r; }
      else if (k === 'w') { result += v * dc.w; }
      else if (k === 'h') { result += v * dc.h; }
      else if (varMap && varMap[k] !== undefined) { result += varMap[k] * v * dc.r; }
    }
    return result;
  }
  return 0;
}

/**
 * Resolve a point — supports both [x, y] (legacy r-relative) and { x, y } (multi-base).
 */
function resolvePoint(pt, dc, varMap) {
  if (Array.isArray(pt)) {
    return [resolveCoord(pt[0], dc, varMap), resolveCoord(pt[1], dc, varMap)];
  }
  return [resolveCoord(pt.x, dc, varMap), resolveCoord(pt.y, dc, varMap)];
}

/**
 * Draw a rounded rectangle path (used by roundedRect shape).
 */
function drawRoundedRectPath(ctx, x, y, w2, h2, cr) {
  ctx.beginPath();
  ctx.moveTo(x + cr, y);
  ctx.lineTo(x + w2 - cr, y);
  ctx.arcTo(x + w2, y, x + w2, y + cr, cr);
  ctx.lineTo(x + w2, y + h2 - cr);
  ctx.arcTo(x + w2, y + h2, x + w2 - cr, y + h2, cr);
  ctx.lineTo(x + cr, y + h2);
  ctx.arcTo(x, y + h2, x, y + h2 - cr, cr);
  ctx.lineTo(x, y + cr);
  ctx.arcTo(x, y, x + cr, y, cr);
  ctx.closePath();
}

/**
 * Resolve a setup/size property value. Plain numbers pass through; the object
 * form `{ base: N }` sums its `base` term (keyframe tracks supply plain numbers,
 * but `radiusAbs` and friends may still be authored as `{ base: N }` coord-objects
 * so they interpolate with the same lerp as other coord values).
 */
function resolveSetupVal(val, _dc) {
  if (typeof val === 'number') return val;
  if (typeof val === 'object' && val !== null) {
    let result = 0;
    for (const [k, v] of Object.entries(val)) {
      if (k === 'base') { result += v; }
    }
    return result;
  }
  return val;
}

/**
 * Apply a setup block to the canvas context.
 * Setup values can be plain numbers or anim-var objects.
 */
function applySetupUnified(ctx, dc, setup) {
  if (!setup) return;
  if (setup.lineWidth !== undefined) ctx.lineWidth = resolveSetupVal(setup.lineWidth, dc);
  if (setup.alpha !== undefined) ctx.globalAlpha = resolveSetupVal(setup.alpha, dc);
  if (setup.shadow !== undefined) {
    ctx.shadowColor = setup.shadowColor || dc.color;
    ctx.shadowBlur = resolveSetupVal(setup.shadow, dc);
  }
  if (setup.shadowBlur !== undefined) {
    ctx.shadowColor = setup.shadowColor || dc.color;
    ctx.shadowBlur = resolveSetupVal(setup.shadowBlur, dc);
  }
  if (setup.fillColor) ctx.fillStyle = setup.fillColor;
  if (setup.strokeColor) ctx.strokeStyle = setup.strokeColor;
  if (setup.lineCap) ctx.lineCap = setup.lineCap;
  if (setup.lineJoin) ctx.lineJoin = setup.lineJoin;
}

/**
 * Merge state overrides into a shape for a given state.
 * Supports both `states` (new) and `stateOverrides` (legacy) keys.
 */
function applyStateOverrides(shape, state) {
  if (!state) return shape;
  const overridesMap = shape.states || shape.stateOverrides;
  if (!overridesMap || !overridesMap[state]) return shape;
  const overrides = overridesMap[state];
  const result = { ...shape };
  for (const [k, v] of Object.entries(overrides)) {
    if (k === 'setup') {
      result.setup = { ...shape.setup, ...v };
    } else if (k === 'emitters' && Array.isArray(v) && Array.isArray(shape.emitters)) {
      // Merge emitter overrides element-by-element
      result.emitters = shape.emitters.map((baseEm, i) => {
        if (!v[i]) return baseEm;
        return { ...baseEm, ...v[i] };
      });
    } else if (k !== 'states' && k !== 'stateOverrides') {
      result[k] = v;
    }
  }
  return result;
}

/** Structural keys that should not be interpolated between states. */
const BLEND_SKIP = new Set([
  'type', 'name', 'shapes', 'children', 'states', 'stateOverrides',
  'visibleStates', 'anim',
]);

/**
 * Resolve state for a shape, with optional blending between two states.
 * dc.blendPrev/dc.blendT are set when a transition is in progress.
 */
function resolveState(shape, dc) {
  const curr = applyStateOverrides(shape, dc.state);
  if (!dc.blendPrev || dc.blendT >= 1) return curr;
  const prev = applyStateOverrides(shape, dc.blendPrev);
  if (prev === curr) return curr;

  // Blend all non-structural properties
  const t = dc.blendT;
  const result = { ...curr };
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  for (const k of allKeys) {
    if (BLEND_SKIP.has(k)) continue;
    if (k === 'setup') {
      const ps = prev.setup || {};
      const cs = curr.setup || {};
      result.setup = {};
      const sKeys = new Set([...Object.keys(ps), ...Object.keys(cs)]);
      for (const sk of sKeys) result.setup[sk] = lerpValue(ps[sk], cs[sk], t);
      continue;
    }
    result[k] = lerpValue(prev[k], curr[k], t);
  }
  return result;
}

/**
 * Get the children array from a container shape.
 * Supports both `children` (preferred for groups) and `shapes` (for repeat/forEach).
 */
function getChildren(shape) {
  return shape.children || shape.shapes || [];
}

// ── Keyframe sampling (timeline animation) ──────────────────────────────────
//
// A shape may carry `anim: { <clipKey>: { <propPath>: [ {t,v,ease?} ] } }`, with
// clip metadata (duration/loop) at `artDef.animations[clipKey]`. The interpreter
// samples each applicable clip's tracks at its clip-local time and merges the
// resulting { propPath: value } map over the shape — a time-varying analogue of
// `applyStateOverrides`. This is a generic primitive: no game noun, no gameplay
// branch. The actual interpolation math lives in interp.js.

const _idxRe = /^\d+$/;
const _idx = (p) => (_idxRe.test(p) ? Number(p) : p);

/**
 * Merge a sampled { propPath: value } map onto a fresh clone of `shape`. Dotted
 * paths (`setup.alpha`, `points.2`, `segments.0.1`) clone-on-write down the path
 * so the registry/raw art is never mutated. `shape` is already a clone produced
 * by resolveState only when overrides existed — so we ALWAYS shallow-clone here
 * and clone each nested container the first time it's touched.
 */
function applySampledOverrides(shape, sampled) {
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
function lerpPoseMaps(from, to, t) {
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
function applyPoseBlend(dc, rawShape, sampled) {
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

/** Dedup sets/flags for one-time dev warnings (avoid console spam per frame). */
const _unknownShapeTypes = new Set();
let _repeatWarned = false;
let _legacyAnimWarned = false;

/**
 * Draw a single shape in the unified art system.
 */
function drawShapeU(ctx, dc, shape, varMap) {
  const rawShape = shape; // stable identity for the keyframe pose store

  // Visibility check (during transitions, show if visible in either prev or current state)
  if (shape.visibleStates) {
    const visInCurr = shape.visibleStates.includes(dc.state);
    const visInPrev = dc.blendPrev && dc.blendT < 1 && shape.visibleStates.includes(dc.blendPrev);
    if (!visInCurr && !visInPrev) return;
  }

  // Merge state overrides (with optional transition blending)
  shape = resolveState(shape, dc);

  // Merge keyframe-animation samples (timeline). Sampled values are absolute and
  // win over static state overrides for the same property; applied before setup /
  // rotation below so keyframed setup.* / rotation take effect this frame.
  if (rawShape.anim && dc.clocks) {
    let sampled = sampleClips(rawShape.anim, dc.state, dc.clocks);
    sampled = applyPoseBlend(dc, rawShape, sampled);
    if (sampled) shape = applySampledOverrides(shape, sampled);
  }

  // Per-shape setup
  if (shape.setup) applySetupUnified(ctx, dc, shape.setup);
  if (shape.fillColor) ctx.fillStyle = shape.fillColor;

  // Per-shape rotation (primitive shapes rotate around their natural center)
  if (shape.rotation && shape.type !== 'group') {
    let px = 0, py = 0;
    if (shape.cx !== undefined) {
      px = resolveCoord(shape.cx, dc, varMap);
      py = resolveCoord(shape.cy !== undefined ? shape.cy : 0, dc, varMap);
    } else if (shape.x !== undefined) {
      const rw = resolveCoord(shape.w || shape.width || 0, dc, varMap);
      const rh = resolveCoord(shape.h || shape.height || 0, dc, varMap);
      px = resolveCoord(shape.x, dc, varMap) + rw / 2;
      py = resolveCoord(shape.y || 0, dc, varMap) + rh / 2;
    } else if (shape.points?.length) {
      // Rotate around bounding box center, not first point
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of shape.points) {
        const [x, y] = resolvePoint(pt, dc, varMap);
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      px = (minX + maxX) / 2;
      py = (minY + maxY) / 2;
    } else if (shape.start) {
      // Rotate bezier/quad paths around bounding box center
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const [sx, sy] = resolvePoint(shape.start, dc, varMap);
      minX = Math.min(minX, sx); minY = Math.min(minY, sy);
      maxX = Math.max(maxX, sx); maxY = Math.max(maxY, sy);
      if (shape.curves) {
        for (const c of shape.curves) {
          for (const key of ['cp1', 'cp2', 'cp', 'to']) {
            if (c[key]) {
              const [cx, cy] = resolvePoint(c[key], dc, varMap);
              minX = Math.min(minX, cx); minY = Math.min(minY, cy);
              maxX = Math.max(maxX, cx); maxY = Math.max(maxY, cy);
            }
          }
        }
      }
      px = (minX + maxX) / 2;
      py = (minY + maxY) / 2;
    }
    ctx.translate(px, py);
    ctx.rotate(evalAngle(shape.rotation));
    ctx.translate(-px, -py);
  }

  switch (shape.type) {
    case 'path': {
      ctx.beginPath();
      const pts = shape.points;
      const [mx, my] = resolvePoint(pts[0], dc, varMap);
      ctx.moveTo(mx, my);
      for (let i = 1; i < pts.length; i++) {
        const [lx, ly] = resolvePoint(pts[i], dc, varMap);
        ctx.lineTo(lx, ly);
      }
      if (shape.closed) ctx.closePath();
      finishShape(ctx, shape);
      break;
    }

    case 'bezierPath': {
      ctx.beginPath();
      const [sx, sy] = resolvePoint(shape.start, dc, varMap);
      ctx.moveTo(sx, sy);
      for (const curve of shape.curves) {
        const [c1x, c1y] = resolvePoint(curve.cp1, dc, varMap);
        const [c2x, c2y] = resolvePoint(curve.cp2, dc, varMap);
        const [tx, ty] = resolvePoint(curve.to, dc, varMap);
        ctx.bezierCurveTo(c1x, c1y, c2x, c2y, tx, ty);
      }
      if (shape.closed) ctx.closePath();
      finishShape(ctx, shape);
      break;
    }

    case 'quadPath': {
      ctx.beginPath();
      const [sx, sy] = resolvePoint(shape.start, dc, varMap);
      ctx.moveTo(sx, sy);
      for (const curve of shape.curves) {
        const [cpx, cpy] = resolvePoint(curve.cp, dc, varMap);
        const [tx, ty] = resolvePoint(curve.to, dc, varMap);
        ctx.quadraticCurveTo(cpx, cpy, tx, ty);
      }
      if (shape.closed) ctx.closePath();
      finishShape(ctx, shape);
      break;
    }

    case 'arc': {
      const cx = resolveCoord(shape.cx, dc, varMap);
      const cy = resolveCoord(shape.cy, dc, varMap);
      const arcR = resolveCoord(shape.radius, dc, varMap);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0, arcR), evalAngle(shape.startAngle), evalAngle(shape.endAngle));
      finishShape(ctx, shape);
      break;
    }

    case 'circle': {
      let cr = shape.radiusAbs !== undefined ? resolveSetupVal(shape.radiusAbs, dc) : resolveCoord(shape.radius, dc, varMap);
      if (shape.radiusOffset) cr += shape.radiusOffset;
      const cx = resolveCoord(shape.cx, dc, varMap);
      const cy = resolveCoord(shape.cy, dc, varMap);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0, cr), 0, PI * 2);
      finishShape(ctx, shape);
      break;
    }

    case 'rect': {
      const rx = resolveCoord(shape.x, dc, varMap);
      const ry = resolveCoord(shape.y, dc, varMap);
      const rw = resolveCoord(shape.w, dc, varMap);
      const rh = resolveCoord(shape.h, dc, varMap);
      ctx.beginPath();
      ctx.rect(rx, ry, rw, rh);
      finishShape(ctx, shape);
      break;
    }

    case 'strokeRect': {
      const rx = resolveCoord(shape.x, dc, varMap);
      const ry = resolveCoord(shape.y, dc, varMap);
      const rw = resolveCoord(shape.w, dc, varMap);
      const rh = resolveCoord(shape.h, dc, varMap);
      ctx.strokeRect(rx, ry, rw, rh);
      break;
    }

    case 'roundedRect': {
      const rx = resolveCoord(shape.x, dc, varMap);
      const ry = resolveCoord(shape.y, dc, varMap);
      const rw = resolveCoord(shape.width, dc, varMap);
      const rh = resolveCoord(shape.height, dc, varMap);
      const cr = resolveCoord(shape.cornerRadius, dc, varMap);
      drawRoundedRectPath(ctx, rx, ry, rw, rh, Math.max(0, cr));
      finishShape(ctx, shape);
      break;
    }

    case 'lines': {
      ctx.beginPath();
      for (const seg of shape.segments) {
        const [x1, y1] = resolvePoint(seg[0], dc, varMap);
        const [x2, y2] = resolvePoint(seg[1], dc, varMap);
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      finishShape(ctx, shape);
      break;
    }

    case 'boltCluster': {
      const bcx = resolveCoord(shape.cx, dc, varMap);
      const bcy = resolveCoord(shape.cy, dc, varMap);
      const s = shape.spacing * dc.r;
      const dr = shape.dotRadius !== undefined ? shape.dotRadius : 0.8;
      for (const [dx, dy] of [[-s, -s], [s, -s], [-s, s], [s, s]]) {
        ctx.beginPath();
        ctx.arc(bcx + dx, bcy + dy, dr, 0, PI * 2);
        ctx.fill();
      }
      break;
    }

    // ── Container Types ──

    case 'group': {
      if (shape.animators && !_legacyAnimWarned) {
        _legacyAnimWarned = true;
        console.warn('[ArtInterpreter] group.animators is no longer supported — convert to keyframe `anim` tracks. Ignored. Further warnings suppressed.');
      }
      const children = getChildren(shape);
      // Apply cx/cy translation and rotation (any of which may be keyframed —
      // `shape` already carries the sampled values from drawShapeU's merge).
      const hasTx = shape.cx !== undefined || shape.cy !== undefined || shape.rotation !== undefined;
      if (hasTx) {
        ctx.save();
        const cx = shape.cx ? resolveCoord(shape.cx, dc, varMap) : 0;
        const cy = shape.cy ? resolveCoord(shape.cy, dc, varMap) : 0;
        if (cx || cy) ctx.translate(cx, cy);
        if (shape.rotation) ctx.rotate(evalAngle(shape.rotation));
      }
      for (const child of children) {
        ctx.save();
        drawShapeU(ctx, dc, child, varMap);
        ctx.restore();
      }
      if (hasTx) ctx.restore();
      break;
    }

    case 'repeat': {
      let fromVal = typeof shape.from === 'object' ? resolveCoord(shape.from, dc, varMap) / dc.r : shape.from;
      let toVal = typeof shape.to === 'object' ? resolveCoord(shape.to, dc, varMap) / dc.r : shape.to;
      const stepVal = typeof shape.step === 'object' ? resolveCoord(shape.step, dc, varMap) / dc.r : shape.step;
      // Guard against an infinite/hanging loop: bounds must be finite and the
      // step must be a positive finite number.
      if (!Number.isFinite(fromVal) || !Number.isFinite(toVal) || !Number.isFinite(stepVal) || stepVal <= 0) {
        if (!_repeatWarned) {
          _repeatWarned = true;
          console.warn('[ArtInterpreter] Skipping "repeat" shape with non-finite bounds or step <= 0. Further warnings suppressed.');
        }
        return;
      }
      const varName = shape.var;
      const children = getChildren(shape);
      for (let val = fromVal; val <= toVal + 0.001; val += stepVal) {
        const innerVarMap = { ...varMap, [varName]: val };
        for (const child of children) {
          ctx.save();
          drawShapeU(ctx, dc, child, innerVarMap);
          ctx.restore();
        }
      }
      break;
    }

    case 'forEach': {
      const varNames = shape.var;
      const children = getChildren(shape);
      const items = Array.isArray(shape.items) ? shape.items : [];
      for (const item of items) {
        const innerVarMap = { ...varMap };
        if (Array.isArray(varNames)) {
          for (let i = 0; i < varNames.length; i++) {
            innerVarMap[varNames[i]] = item[i];
          }
        } else {
          innerVarMap[varNames] = item;
        }
        for (const child of children) {
          ctx.save();
          drawShapeU(ctx, dc, child, innerVarMap);
          ctx.restore();
        }
      }
      break;
    }

    case 'radialRepeat': {
      const cx = resolveCoord(shape.cx || 0, dc, varMap);
      const cy = resolveCoord(shape.cy || 0, dc, varMap);
      const rad = shape.radius != null ? resolveCoord(shape.radius, dc, varMap) : 0;
      const count = shape.count;
      const children = getChildren(shape);
      for (let i = 0; i < count; i++) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((i / count) * PI * 2);
        if (rad) ctx.translate(rad, 0);
        for (const child of children) {
          ctx.save();
          drawShapeU(ctx, dc, child, varMap);
          ctx.restore();
        }
        ctx.restore();
      }
      break;
    }

    case 'conditional': {
      // visibleStates already checked at top of function
      const children = getChildren(shape);
      for (const child of children) {
        ctx.save();
        drawShapeU(ctx, dc, child, varMap);
        ctx.restore();
      }
      break;
    }

    case 'particles': {
      // visibleStates already checked at top of function
      for (const emitter of shape.emitters) {
        const ecx = resolveCoord(emitter.cx, dc, varMap);
        const ecy = resolveCoord(emitter.cy, dc, varMap);

        if (emitter.kind === 'dots') {
          if (emitter.shadowColor) { ctx.shadowColor = emitter.shadowColor; ctx.shadowBlur = emitter.shadowBlur || 0; }
          for (let i = 0; i < emitter.count; i++) {
            const ox = (emitter.offsetX || 0) * dc.r + (Math.random() - 0.5) * emitter.spreadX * dc.r;
            const oy = (Math.random() - 0.5) * emitter.spreadY * dc.r;
            const sz = emitter.sizeMin + Math.random() * emitter.sizeRange;
            ctx.globalAlpha = emitter.alphaMin + Math.random() * emitter.alphaRange;
            const colors = emitter.colors;
            ctx.fillStyle = Math.random() < (emitter.colorThreshold || 0.5) ? colors[1] : colors[0];
            ctx.beginPath();
            ctx.arc(ecx + ox, ecy + oy, sz, 0, PI * 2);
            ctx.fill();
          }
          ctx.shadowBlur = 0;
        } else if (emitter.kind === 'lines') {
          ctx.strokeStyle = emitter.color;
          ctx.lineWidth = emitter.lineWidth || 1;
          for (let i = 0; i < emitter.count; i++) {
            const sx = ecx + (emitter.startOffset || 0) * dc.r;
            const sy = ecy + (Math.random() - 0.5) * emitter.spreadFactor * dc.r;
            const ex = sx + (emitter.reachOffset || 0) * dc.r + Math.random() * emitter.reachFactor * dc.r;
            const ey = sy + (Math.random() - 0.5) * emitter.spreadFactor * dc.r;
            ctx.globalAlpha = emitter.alphaMin + Math.random() * emitter.alphaRange;
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(ex, ey);
            ctx.stroke();
          }
        } else if (emitter.kind === 'strips') {
          // Deterministic rotating strips — small line segments at seeded positions,
          // each spinning independently. Used for chaff-like particle clouds.
          const colors = emitter.colors || ['#ccddcc'];
          const halfLen = (emitter.stripLength || 0.15) * 0.5 * dc.r;
          const lw = (emitter.lineWidth || 0.05) * dc.r;
          const spread = (emitter.spread || 1) * dc.r;
          const minSpeed = emitter.rotateSpeedMin || 0.002;
          const speedRange = (emitter.rotateSpeedMax || 0.006) - minSpeed;
          const alphaMin = emitter.alphaMin || 0.4;
          const alphaRange = emitter.alphaRange || 0.5;
          if (emitter.shadowColor) { ctx.shadowColor = emitter.shadowColor; ctx.shadowBlur = emitter.shadowBlur || 0; }
          ctx.lineWidth = lw;
          for (let i = 0; i < emitter.count; i++) {
            // Hash each property with a different seed for decorrelated values
            const hash = (v) => { v = ((v >>> 16) ^ v) * 0x45d9f3b | 0; v = ((v >>> 16) ^ v) * 0x45d9f3b | 0; return ((v >>> 16) ^ v) >>> 0; };
            const h1 = hash(i * 7 + 1) / 4294967296;
            const h2 = hash(i * 13 + 2) / 4294967296;
            const h3 = hash(i * 19 + 3) / 4294967296;
            const h4 = hash(i * 31 + 4) / 4294967296;
            const h5 = hash(i * 37 + 5) / 4294967296;
            // Position within circular spread
            const angle = h1 * PI * 2;
            const dist = Math.sqrt(h2) * spread;
            const px = ecx + Math.cos(angle) * dist;
            const py = ecy + Math.sin(angle) * dist;
            // Rotation: each strip spins at its own speed and direction
            const speed = minSpeed + h3 * speedRange;
            const dir = h4 < 0.5 ? 1 : -1;
            const rot = (h5 * PI * 2) + dc.now * speed * dir;
            const dx = Math.cos(rot) * halfLen;
            const dy = Math.sin(rot) * halfLen;
            ctx.globalAlpha = alphaMin + h3 * alphaRange;
            ctx.strokeStyle = colors[Math.floor(h4 * colors.length)];
            ctx.beginPath();
            ctx.moveTo(px - dx, py - dy);
            ctx.lineTo(px + dx, py + dy);
            ctx.stroke();
          }
          ctx.shadowBlur = 0;
        }
      }
      break;
    }

    case 'effectRef': {
      // Embed a referenced VFX effect (generic primitive — no game noun).
      // Playback is decoupled from the keyframe timeline by default: with no
      // `progress`, a PERSISTENT effect runs on its own clock (independent speed /
      // looping) and a one-shot draws frozen. A keyframed `progress` (0..1) is the
      // explicit opt-in that DRIVES the effect's lifecycle from the clip timeline —
      // ramp 0→1 to fire/sync a burst with the animation. `cx/cy/scale` may be
      // keyframed to move/grow the effect regardless of which mode it's in.
      if (!_effectResolver) break;
      const def = _effectResolver(shape.effect);
      if (!def) {
        if (!_effectWarn.has('miss:' + shape.effect)) {
          _effectWarn.add('miss:' + shape.effect);
          console.warn(`[ArtInterpreter] effectRef ${JSON.stringify(shape.effect)} not found (ignored).`);
        }
        break;
      }
      const driven = typeof shape.progress === 'number';
      const progress = driven ? Math.max(0, Math.min(1, shape.progress)) : null;
      if (def.lifecycle !== 'persistent' && !driven && !_effectWarn.has('np:' + shape.effect)) {
        _effectWarn.add('np:' + shape.effect);
        console.warn(`[ArtInterpreter] effectRef ${JSON.stringify(shape.effect)} is a one-shot with no keyframed 'progress'; it draws frozen. Add a progress track to fire it from the timeline.`);
      }
      const ecx = resolveCoord(shape.cx, dc, varMap);
      const ecy = resolveCoord(shape.cy, dc, varMap);
      const scale = (shape.scale != null ? resolveSetupVal(shape.scale, dc) : 1) * dc.r;
      drawPhasedEffect(ctx, ecx, ecy, def, progress, scale, dc.now, { state: dc.state });
      break;
    }

    default: {
      // Unknown shape type — warn once per type so authors get feedback,
      // but never throw or spam the console each frame.
      if (shape.type && !_unknownShapeTypes.has(shape.type)) {
        _unknownShapeTypes.add(shape.type);
        console.warn(`[ArtInterpreter] Unknown shape type ${JSON.stringify(shape.type)} (ignored).`);
      }
      break;
    }
  }
}

/**
 * Draw an art asset using the unified format.
 * Game-agnostic: knows nothing about modules, NPCs, or world objects.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} r — radius scale factor
 * @param {string} color — base stroke/fill color (provided by game code)
 * @param {object} artDef — art asset definition: { name?, states?, space?, setup?, shapes }
 * @param {string|null} state — current state name (null for stateless assets)
 * @param {number} now — timestamp for animations (0 for static assets)
 * @param {object} [transition] — optional mutable object for smooth state transitions
 *   AND the per-entity keyframe clock: { currentState, prevState, startTime,
 *   animTime?, _livePose?, _snapPose? } — managed automatically per call. The
 *   editor passes `animTime` (a { clipKey: ms } scrub override map).
 * @param {number} [durationOverride] — optional override for artDef.transitionDuration (ms)
 */
export function drawUnifiedArt(ctx, r, color, artDef, state, now, transition, durationOverride) {
  if (!artDef || !artDef.shapes) return;

  // Transition blending: track state changes and compute blend factor
  let blendPrev = null;
  let blendT = 1;
  const duration = durationOverride !== undefined ? durationOverride : (artDef.transitionDuration || 0);
  if (transition) {
    const t = now || 0;
    // Always track current state so overrides can blend from the correct previous state
    if (transition.currentState !== (state || null)) {
      transition.prevState = transition.currentState;
      transition.startTime = t;
      transition.currentState = state || null;
      // Snapshot the last composited keyframe pose so it can crossfade into the
      // new clip (swap is O(1); _livePose repopulates this frame).
      if (artDef.animations) {
        transition._snapPose = transition._livePose || null;
        transition._livePose = new WeakMap();
      }
    }
    if (artDef.animations && !transition._livePose) transition._livePose = new WeakMap();
    if (duration > 0 && transition.prevState !== undefined && transition.prevState !== transition.currentState) {
      const elapsed = t - (transition.startTime || 0);
      if (elapsed < duration) {
        blendT = elapsed / duration;
        blendPrev = transition.prevState;
      }
    }
  }

  // Per-clip keyframe clocks: the applicable clips are the ambient "*" and the
  // current state. Looping clips are absolute-time (epoch 0 → never reset on a
  // state change); play-once clips key off the state-entry epoch (startTime) and
  // hold their end frame. The editor overrides per-clip time via transition.animTime.
  let clocks = null;
  if (artDef.animations) {
    const t = now || 0;
    const animTime = transition && transition.animTime;
    for (const clipKey of ['*', state || null]) {
      if (clipKey == null) continue;
      const clip = artDef.animations[clipKey];
      if (!clip) continue;
      if (!clocks) clocks = {};
      if (animTime && animTime[clipKey] != null) {
        clocks[clipKey] = animTime[clipKey];
      } else {
        const loop = clip.loop !== false;
        const epoch = loop ? 0 : (transition && transition.startTime) || 0;
        clocks[clipKey] = clipLocalTime(t, epoch, clip.duration, loop);
      }
    }
  }

  // Build draw context
  const dc = {
    r,
    w: artDef.space ? r * artDef.space.widthFactor : r,
    h: artDef.space ? r * artDef.space.heightFactor : r,
    state: state || null,
    now: now || 0,
    color,
    blendPrev,
    blendT,
    clocks,
    transition: transition || null,
  };

  // Apply top-level setup and base color
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  applySetupUnified(ctx, dc, artDef.setup);

  // Draw each shape in the tree
  for (const shape of artDef.shapes) {
    ctx.save();
    try {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      drawShapeU(ctx, dc, shape, null);
    } finally {
      ctx.restore();
    }
  }

  // Reset canvas state
  ctx.globalAlpha = 1.0;
  ctx.shadowBlur = 0;
}
