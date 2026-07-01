/**
 * Per-shape state override merging + transition blending for the unified art
 * system. Game-agnostic pure leaf; the interpolation math lives in ../interp.js.
 */

import { lerpValue } from '../interp.js';

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
export function resolveState(shape, dc) {
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
