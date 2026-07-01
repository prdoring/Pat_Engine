/**
 * Coordinate / arithmetic / setup resolution for the unified art system.
 *
 * Game-agnostic pure leaf (no canvas state beyond applying a setup block; no
 * renderer import). The unified coordinate system: plain numbers are r-relative,
 * `{ base, r, w, h }` objects are linear combinations, `base`/`…Abs` are absolute.
 * The angle-expression evaluator is a tiny safe arithmetic parser — no eval /
 * new Function — so it runs under a strict CSP.
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
export function resolvePoint(pt, dc, varMap) {
  if (Array.isArray(pt)) {
    return [resolveCoord(pt[0], dc, varMap), resolveCoord(pt[1], dc, varMap)];
  }
  return [resolveCoord(pt.x, dc, varMap), resolveCoord(pt.y, dc, varMap)];
}

/**
 * Resolve a setup/size property value. Plain numbers pass through; the object
 * form `{ base: N }` sums its `base` term (keyframe tracks supply plain numbers,
 * but `radiusAbs` and friends may still be authored as `{ base: N }` coord-objects
 * so they interpolate with the same lerp as other coord values).
 */
export function resolveSetupVal(val, _dc) {
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
export function applySetupUnified(ctx, dc, setup) {
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
