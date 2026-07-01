/**
 * Generic declarative Canvas2D art renderer.
 * Renders art definitions from JSON — all coordinates are radius-relative
 * (multiplied by `r` at render time) unless marked with `Abs` suffix.
 *
 * This entry owns the top-level orchestration (`drawUnifiedArt`): transition
 * blending, the per-clip keyframe clocks, and the top-level shape loop. The
 * internals live in sibling leaves: coordinate/setup math → ./art/coords.js,
 * state blending → ./art/state.js, the recursive shape renderer → ./art/shapes.js,
 * the host effect resolver → ./art/effectResolver.js, and the pure
 * interpolation/keyframe-sampling math → ./interp.js. Public helpers are
 * re-exported below so existing importers keep working.
 */

import { drawShapeU } from './art/shapes.js';
import { evalAngle, resolveCoord, applySetupUnified } from './art/coords.js';
import { setEffectResolver } from './art/effectResolver.js';
import { lerpValue, clipLocalTime } from './interp.js';

// Re-export the public helpers so `import { … } from './ArtInterpreter.js'`
// keeps resolving. `lerpValue` lives in the canvas-free interp module; the
// coord/angle helpers and the effect-resolver setter live in ./art/*.
export { lerpValue, evalAngle, resolveCoord, setEffectResolver };

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
