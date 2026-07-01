/**
 * Per-shape renderer + container dispatch for the unified art system.
 *
 * `drawShapeU` is the recursive heart of the interpreter: it merges state
 * overrides + keyframe samples, applies setup/rotation, then draws the shape or
 * recurses through container types (group/repeat/forEach/radialRepeat/conditional).
 * Game-agnostic; coordinate/state/keyframe/particle/effect helpers are imported
 * from sibling leaves. `effectRef` reads the host-injected resolver at draw time.
 */

import { resolveCoord, resolvePoint, resolveSetupVal, applySetupUnified, evalAngle } from './coords.js';
import { resolveState } from './state.js';
import { sampleClips, applySampledOverrides, applyPoseBlend } from '../interp.js';
import { getEffectResolver } from './effectResolver.js';
import { drawParticles } from './particles.js';
import { drawPhasedEffect } from '../VFXInterpreter.js';

const PI = Math.PI;

/** Dedup sets/flags for one-time dev warnings (avoid console spam per frame). */
const _effectWarn = new Set();
const _unknownShapeTypes = new Set();
let _repeatWarned = false;
let _legacyAnimWarned = false;

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
 * Get the children array from a container shape.
 * Supports both `children` (preferred for groups) and `shapes` (for repeat/forEach).
 */
function getChildren(shape) {
  return shape.children || shape.shapes || [];
}

/**
 * Draw a single shape in the unified art system.
 */
export function drawShapeU(ctx, dc, shape, varMap) {
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
      drawParticles(ctx, dc, shape, varMap);
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
      const resolver = getEffectResolver();
      if (!resolver) break;
      const def = resolver(shape.effect);
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
