/**
 * VFX value / color / shadow resolution + dev-warn dedup.
 *
 * Game-agnostic pure leaf — no canvas, no imports. Shared by the VFX entry
 * (../VFXInterpreter.js) and the primitive renderers (./primitives.js) so the
 * "warn once" Set is genuinely shared across both (a single home avoids the
 * dedup double-firing that two copies would cause).
 *
 * Value types:
 *   static number:  0.5
 *   animated:       { from: 0, to: 1 }                            — lerp over phase progress
 *   modulated:      { from: 0.8, to: 0, modulate: { freq, amp } } — lerp + sin
 *   oscillating:    { base: 10, amplitude: 5, freq: 0.01 }        — sin wave (persistent)
 */

const PI2 = Math.PI * 2;

// ─── Dev-mode validation (warn once per unknown key) ─────────────────────────
const _warnedKeys = new Set();
export function warnOnce(key, msg) {
  if (_warnedKeys.has(key)) return;
  _warnedKeys.add(key);
  console.warn(msg);
}

/**
 * Resolve a numeric value given phase progress and current time.
 * @param {number|object} val - Static, animated, modulated, or oscillating value
 * @param {number|null} phaseProgress - 0-1 within the phase (null for persistent)
 * @param {number} now - performance.now() for oscillating values
 * @returns {number}
 */
export function resolveValue(val, phaseProgress, now) {
  if (typeof val === 'number') return val;
  if (val == null) return 0;
  if (typeof val !== 'object') return 0;

  // Animated: { from, to } with optional modulate
  if ('from' in val && 'to' in val) {
    const t = phaseProgress ?? 0;
    let result = val.from + (val.to - val.from) * t;
    if (val.modulate) {
      const m = val.modulate;
      result += Math.sin((phaseProgress ?? 0) * (m.freq || 1) * PI2) * (m.amp || 0);
    }
    return result;
  }

  // Oscillating: { base, amplitude, freq }
  if ('base' in val) {
    return val.base + Math.sin(now * (val.freq || 1) * PI2) * (val.amplitude || 0);
  }

  return 0;
}

/**
 * Resolve a color value, handling entity color variants.
 * @param {string|object} val - Color string or { local, remote } object (two-variant entity color)
 * @param {object} opts - { isLocal }
 * @returns {string}
 */
export function resolveColor(val, opts) {
  if (typeof val === 'string') return val;
  if (val && typeof val === 'object' && ('local' in val || 'remote' in val)) {
    // Missing/undefined isLocal is treated as LOCAL (single-player default).
    const isLocal = !opts || opts.isLocal !== false;
    return isLocal ? (val.local || val.remote) : (val.remote || val.local);
  }
  return '#ffffff';
}

/**
 * Resolve a shadow config.
 * @param {object} shadow - { color, blur } where blur may be animatable
 * @param {string} layerColor - Resolved layer color (for "$color" references)
 * @param {number|null} phaseProgress
 * @param {number} now
 * @param {object} opts
 * @returns {{ color: string, blur: number }}
 */
export function resolveShadow(shadow, layerColor, phaseProgress, now, opts) {
  if (!shadow) return { color: 'transparent', blur: 0 };
  const color = shadow.color === '$color' ? layerColor : resolveColor(shadow.color, opts);
  const blur = resolveValue(shadow.blur, phaseProgress, now);
  return { color, blur };
}

/**
 * Apply state overrides to a layer definition (shallow merge).
 * Returns a new object with overrides applied, or the original if no match.
 */
export function applyStateOverrides(layer, state) {
  if (!state || !layer.stateOverrides || !layer.stateOverrides[state]) return layer;
  return { ...layer, ...layer.stateOverrides[state] };
}
