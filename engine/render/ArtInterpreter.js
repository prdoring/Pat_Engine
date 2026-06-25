/**
 * Generic declarative Canvas2D art renderer.
 * Renders art definitions from JSON — all coordinates are radius-relative
 * (multiplied by `r` at render time) unless marked with `Abs` suffix.
 */

const PI = Math.PI;

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
 * - object: { base: c, r: f, w: f, h: f, <animVar>: f } — linear combination
 *   result = c + f_r * r + f_w * w + f_h * h + f_var * var * r
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
      else if (dc.animVars && dc.animVars[k] !== undefined) { result += dc.animVars[k] * v * dc.r; }
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
 * Resolve a setup property value. Supports plain numbers and anim-var objects.
 * Object form: { base: 0.5, pulse: 0.5 } → 0.5 + animVars.pulse * 0.5
 */
function resolveSetupVal(val, dc) {
  if (typeof val === 'number') return val;
  if (typeof val === 'object' && val !== null) {
    let result = 0;
    for (const [k, v] of Object.entries(val)) {
      if (k === 'base') { result += v; }
      else if (dc.animVars && dc.animVars[k] !== undefined) { result += dc.animVars[k] * v; }
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

/**
 * Interpolate between two values. Handles numbers, coordinate objects,
 * arrays (points), and nested objects (anim-var, setup). Non-numeric values
 * snap to `b` when t >= 0.5.
 */
function lerpValue(a, b, t) {
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

/** Structural keys that should not be interpolated between states. */
const BLEND_SKIP = new Set([
  'type', 'name', 'shapes', 'children', 'states', 'stateOverrides',
  'animators', 'activeStates', 'visibleStates', 'var',
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
 * Process animators on a shape/group, updating the draw context.
 * Returns { dc, spinner } — the (possibly modified) dc and any spinner animator.
 * If a spinner is found, the caller must handle the copies/rotation loop.
 */
function processAnimators(dc, animators, varMap) {
  let currentDc = dc;
  let spinnerAnimator = null;

  if (!animators) return { dc: currentDc, spinner: null };

  for (const anim of animators) {
    switch (anim.type) {
      case 'oscillator': {
        const isActive = !anim.activeStates || anim.activeStates.length === 0 || anim.activeStates.includes(dc.state);
        const phase = typeof anim.phase === 'string' && varMap && varMap[anim.phase] !== undefined
          ? varMap[anim.phase]
          : (anim.phase || 0);
        const value = isActive
          ? Math.sin(dc.now * anim.rate + phase) * anim.amplitude + (anim.base || 0)
          : (anim.defaultValue ?? 0);
        currentDc = { ...currentDc, animVars: { ...currentDc.animVars, [anim.var]: value } };
        break;
      }
      case 'spinner': {
        // Only one spinner per shape — last one wins
        spinnerAnimator = anim;
        break;
      }
    }
  }

  return { dc: currentDc, spinner: spinnerAnimator };
}

/**
 * Get the children array from a container shape.
 * Supports both `children` (preferred for groups) and `shapes` (for repeat/forEach).
 */
function getChildren(shape) {
  return shape.children || shape.shapes || [];
}

/** Dedup sets/flags for one-time dev warnings (avoid console spam per frame). */
const _unknownShapeTypes = new Set();
let _repeatWarned = false;

/**
 * Draw a single shape in the unified art system.
 */
function drawShapeU(ctx, dc, shape, varMap) {
  // Visibility check (during transitions, show if visible in either prev or current state)
  if (shape.visibleStates) {
    const visInCurr = shape.visibleStates.includes(dc.state);
    const visInPrev = dc.blendPrev && dc.blendT < 1 && shape.visibleStates.includes(dc.blendPrev);
    if (!visInCurr && !visInPrev) return;
  }

  // Merge state overrides (with optional transition blending)
  shape = resolveState(shape, dc);

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
      const { dc: innerDc, spinner } = processAnimators(dc, shape.animators, varMap);
      const children = getChildren(shape);

      if (spinner) {
        // Spinner: translate to pivot, rotate copies, optional orbit radius
        const cx = resolveCoord(spinner.cx, innerDc, varMap);
        const cy = resolveCoord(spinner.cy, innerDc, varMap);
        const angle = (innerDc.now * spinner.rate) % (PI * 2);
        const copies = spinner.copies || 1;
        const orb = spinner.orbitRadius ? resolveCoord(spinner.orbitRadius, innerDc, varMap) : 0;
        for (let c = 0; c < copies; c++) {
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(angle + (c * PI * 2 / copies));
          if (orb) ctx.translate(orb, 0);
          for (const child of children) {
            ctx.save();
            drawShapeU(ctx, innerDc, child, varMap);
            ctx.restore();
          }
          ctx.restore();
        }
      } else {
        // Plain group: apply cx/cy translation and static rotation
        const hasTx = shape.cx !== undefined || shape.cy !== undefined || shape.rotation !== undefined;
        if (hasTx) {
          ctx.save();
          const cx = shape.cx ? resolveCoord(shape.cx, innerDc, varMap) : 0;
          const cy = shape.cy ? resolveCoord(shape.cy, innerDc, varMap) : 0;
          if (cx || cy) ctx.translate(cx, cy);
          if (shape.rotation) ctx.rotate(evalAngle(shape.rotation));
        }
        for (const child of children) {
          ctx.save();
          drawShapeU(ctx, innerDc, child, varMap);
          ctx.restore();
        }
        if (hasTx) ctx.restore();
      }
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

    // ── Legacy Animation Shape Types (standalone, without group wrapper) ──

    case 'spinner': {
      const cx = resolveCoord(shape.cx, dc, varMap);
      const cy = resolveCoord(shape.cy, dc, varMap);
      const angle = (dc.now * shape.rate) % (PI * 2);
      const copies = shape.copies || 1;
      const orb = shape.orbitRadius ? resolveCoord(shape.orbitRadius, dc, varMap) : 0;
      const children = getChildren(shape);
      for (let c = 0; c < copies; c++) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle + (c * PI * 2 / copies));
        if (orb) ctx.translate(orb, 0);
        for (const child of children) {
          ctx.save();
          drawShapeU(ctx, dc, child, varMap);
          ctx.restore();
        }
        ctx.restore();
      }
      break;
    }

    case 'oscillator': {
      const isActive = !shape.activeStates || shape.activeStates.length === 0 || shape.activeStates.includes(dc.state);
      const phase = typeof shape.phase === 'string' && varMap && varMap[shape.phase] !== undefined
        ? varMap[shape.phase]
        : (shape.phase || 0);
      const value = isActive
        ? Math.sin(dc.now * shape.rate + phase) * shape.amplitude + (shape.base || 0)
        : (shape.defaultValue ?? 0);
      const newDc = { ...dc, animVars: { ...dc.animVars, [shape.var]: value } };
      const children = getChildren(shape);
      for (const child of children) {
        ctx.save();
        drawShapeU(ctx, newDc, child, varMap);
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
 * @param {object} [transition] — optional mutable object for smooth state transitions:
 *   { currentState, prevState, startTime } — managed automatically per call
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
    }
    if (duration > 0 && transition.prevState !== undefined && transition.prevState !== transition.currentState) {
      const elapsed = t - (transition.startTime || 0);
      if (elapsed < duration) {
        blendT = elapsed / duration;
        blendPrev = transition.prevState;
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
    animVars: {},
    blendPrev,
    blendT,
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
