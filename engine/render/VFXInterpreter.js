/**
 * Generic data-driven VFX renderer.
 * Renders all effect types from JSON definitions — no game-specific knowledge.
 *
 * Entry points:
 *   drawPhasedEffect()  — one-shot & persistent effects (explosions, indicators)
 *   drawTrailEffect()   — point-stream trails (bubble, tapered)
 *   drawBeamEffect()    — endpoint-to-endpoint beams (wiggle)
 *
 * Effect definitions use composable rendering primitives organized into
 * time-windowed phases (phased) or direct parametric rendering (trail/beam).
 * Internals: value/color/shadow resolution → ./vfx/resolve.js; the phased
 * primitive renderers + dispatch table → ./vfx/primitives.js. This entry keeps
 * the phased-effect orchestration and the trail/beam renderers, and re-exports
 * the pure resolvers so existing importers keep working.
 */

import { resolveValue, resolveColor, applyStateOverrides, warnOnce } from './vfx/resolve.js';
import { PRIMITIVE_RENDERERS } from './vfx/primitives.js';

// Re-export the pure resolvers (they now live in the canvas-free ./vfx/resolve.js
// leaf) so `import { resolveValue, resolveColor, applyStateOverrides }` still resolves.
export { resolveValue, resolveColor, applyStateOverrides };

const PI2 = Math.PI * 2;

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Render a phased effect definition.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} sx - Screen X (already camera-transformed)
 * @param {number} sy - Screen Y
 * @param {object} effectDef - The JSON effect definition (type: "phased")
 * @param {number|null} progress - 0-1 for one-shot, null for persistent
 * @param {number} scale - Runtime scale (blastRadius, maxRadius, etc.)
 * @param {number} now - performance.now()
 * @param {object} [opts={}] - { isLocal, state }
 */
export function drawPhasedEffect(ctx, sx, sy, effectDef, progress, scale, now, opts = {}) {
  if (!effectDef) {
    warnOnce('phased:noDef', '[VFX] drawPhasedEffect called with falsy effectDef');
    return;
  }
  const phases = effectDef.phases;
  if (!phases) return;

  const isPersistent = effectDef.lifecycle === 'persistent';

  for (const phase of phases) {
    // Determine if this phase is active and compute phase progress
    let phaseProgress;

    if (isPersistent || progress === null) {
      // Persistent effects: all phases always active, no progress-based animation
      phaseProgress = null;
    } else {
      // One-shot: check if effect progress falls within this phase's time window
      if (progress < phase.start || progress >= phase.end) continue;
      phaseProgress = (progress - phase.start) / (phase.end - phase.start);
    }

    // Render each layer in the phase
    for (const rawLayer of phase.layers) {
      // Apply state overrides if applicable
      const layer = applyStateOverrides(rawLayer, opts.state);

      // Check layer startAt threshold
      if (layer.startAt != null && phaseProgress != null && phaseProgress < layer.startAt) {
        continue;
      }

      // Adjust progress for layers with startAt
      let layerProgress = phaseProgress;
      if (layer.startAt != null && phaseProgress != null) {
        layerProgress = (phaseProgress - layer.startAt) / (1 - layer.startAt);
      }

      // Dispatch to primitive renderer
      const renderer = PRIMITIVE_RENDERERS[layer.primitive];
      if (renderer) {
        renderer(ctx, sx, sy, layer, layerProgress, now, scale, opts);
      } else {
        warnOnce('primitive:' + layer.primitive, `[VFX] unknown phased-layer primitive: ${layer.primitive}`);
      }
    }
  }
}

// ─── Trail / Beam renderers ─────────────────────────────────────────────────

/**
 * Render a bubble trail from screen-space points.
 * Each point is an individual bubble with hash-based variation for drift, size, and wobble.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} def - bubbleTrail JSON definition
 * @param {Array} points - [{ sx, sy, timestamp, speed? }]
 * @param {number} now
 * @param {object} opts - { isLocal, maxSpeed, zoom }
 */
function _bubbleTrail(ctx, def, points, now, opts) {
  const zoom = opts.zoom ?? 1;
  const minR = def.bubbleMinRadius;
  const maxR = def.bubbleMaxRadius;
  // Missing/undefined isLocal is treated as LOCAL; fall back to the other variant.
  const isLocal = opts.isLocal !== false;
  const colorInner = isLocal ? (def.colorInner ?? def.colorRemoteInner) : (def.colorRemoteInner ?? def.colorInner);
  const colorOuter = isLocal ? (def.colorOuter ?? def.colorRemoteOuter) : (def.colorRemoteOuter ?? def.colorOuter);
  const maxSpeed = def.maxSpeed ?? opts.maxSpeed ?? 1;

  ctx.save();

  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const age = now - pt.timestamp;
    const life = Math.max(0, 1 - age / def.pointLifetime);
    const speedFactor = pt.speed !== undefined
      ? Math.min(1, pt.speed / maxSpeed) : 1;

    // Hash from timestamp for per-bubble uniqueness (stable across frames)
    const seed = pt.timestamp * 2654435761 >>> 0; // Knuth multiplicative hash
    const h1 = (seed % 1000) / 1000;
    const h2 = ((seed * 7919) % 1000) / 1000;
    const h3 = ((seed * 6271) % 1000) / 1000;

    // Per-bubble size variation (0.6x to 1.4x)
    const sizeMult = 0.6 + h1 * 0.8;

    // Bubbles expand then shrink, with unique timing per bubble
    const expand = age / def.pointLifetime;
    const peakTime = 0.2 + h2 * 0.2;
    const sizeT = expand < peakTime
      ? expand / peakTime
      : 1 - (expand - peakTime) / (1 - peakTime);
    const bubbleR = Math.max(0, (minR + (maxR - minR) * sizeT) * sizeMult) * zoom;

    // Lateral drift: bubbles float sideways as they age
    const driftAngle = (h3 - 0.5) * Math.PI;
    const driftDist = age * 0.004 * (0.5 + h1);
    const driftX = Math.cos(driftAngle) * driftDist;
    const driftY = Math.sin(driftAngle) * driftDist;

    // Subtle wobble animation (sinusoidal, unique phase per bubble)
    const wobblePhase = h2 * PI2;
    const wobbleX = Math.sin(age * 0.008 + wobblePhase) * 1.2;
    const wobbleY = Math.cos(age * 0.006 + wobblePhase * 1.3) * 1.0;

    const bx = pt.sx + driftX + wobbleX;
    const by = pt.sy + driftY + wobbleY;

    // Outer wash circle (larger, dimmer)
    ctx.globalAlpha = life * speedFactor * 0.15;
    ctx.fillStyle = colorOuter;
    ctx.shadowColor = colorOuter;
    ctx.shadowBlur = def.glowBlur * zoom;
    ctx.beginPath();
    ctx.arc(bx, by, bubbleR * 2.5, 0, PI2);
    ctx.fill();

    // Inner bubble (brighter, smaller)
    ctx.globalAlpha = life * speedFactor * 0.5;
    ctx.fillStyle = colorInner;
    ctx.shadowColor = colorInner;
    ctx.shadowBlur = def.glowBlur * zoom;
    ctx.beginPath();
    ctx.arc(bx, by, bubbleR, 0, PI2);
    ctx.fill();

    // Highlight speck (white-ish dot on newer bubbles)
    if (life > 0.5) {
      ctx.globalAlpha = (life - 0.5) * 2 * speedFactor * 0.3;
      ctx.fillStyle = '#ddeeff';
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(bx - bubbleR * 0.3, by - bubbleR * 0.3, bubbleR * 0.3, 0, PI2);
      ctx.fill();
    }
  }

  ctx.restore();
}

/**
 * Render a tapered trail from screen-space points.
 * Width tapers from baseWidth (oldest) to tipWidth (newest). Two-pass: core + heat haze.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} def - taperedTrail JSON definition
 * @param {Array} points - [{ sx, sy, timestamp }]
 * @param {number} now
 * @param {object} [opts={}] - { zoom }
 */
function _taperedTrail(ctx, def, points, now, opts = {}) {
  const zoom = opts.zoom ?? 1;
  ctx.save();
  ctx.lineCap = 'round';

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];

    const age = (now - p0.timestamp + (now - p1.timestamp)) / 2;
    const alpha = Math.max(0, 1 - age / def.pointLifetime);
    const t = i / (points.length - 1);
    const width = (def.tipWidth + (def.baseWidth - def.tipWidth) * t) * zoom;

    // Hot core
    ctx.globalAlpha = alpha * 0.9;
    ctx.strokeStyle = def.colorInner;
    ctx.shadowColor = def.colorInner;
    ctx.shadowBlur = def.glowBlur * zoom;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(p0.sx, p0.sy);
    ctx.lineTo(p1.sx, p1.sy);
    ctx.stroke();

    // Outer heat haze
    ctx.globalAlpha = alpha * 0.25;
    ctx.strokeStyle = def.colorOuter;
    ctx.lineWidth = width * 3;
    ctx.shadowBlur = def.glowBlur * 2 * zoom;
    ctx.beginPath();
    ctx.moveTo(p0.sx, p0.sy);
    ctx.lineTo(p1.sx, p1.sy);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Render a wiggle beam between two screen-space endpoints.
 * Sinusoidal displacement perpendicular to beam axis. Two-pass: main stroke + glow.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} def - wiggleBeam JSON definition
 * @param {number} x1 - Start X (screen space)
 * @param {number} y1 - Start Y
 * @param {number} x2 - End X
 * @param {number} y2 - End Y
 * @param {number} now
 * @param {object} opts - { isLocal, entityId, zoom }
 */
function _wiggleBeam(ctx, def, x1, y1, x2, y2, now, opts) {
  const zoom = opts.zoom ?? 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) return;

  const nx = -dy / dist;
  const ny = dx / dist;
  const segments = def.segments;
  // Coerce entity id to a number; non-numeric (e.g. "c12") → 0 to avoid NaN.
  const seed = Number(opts.entityId) || 0;
  const wiggleAmp = (def.wiggleAmplitude + Math.sin(now * 0.003 + seed) * def.wiggleAmplitudeVariation) * zoom;
  const wiggleFreq = def.wiggleFreq;
  // Missing/undefined isLocal is treated as LOCAL; fall back to the other variant.
  const isLocal = opts.isLocal !== false;
  const color = isLocal ? (def.colorLocal ?? def.colorRemote) : (def.colorRemote ?? def.colorLocal);

  ctx.save();

  // Main stroke
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = def.shadowBlur * zoom;
  ctx.lineWidth = def.lineWidth * zoom;
  ctx.globalAlpha = def.alpha;

  ctx.beginPath();
  ctx.moveTo(x1, y1);
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const baseX = x1 + dx * t;
    const baseY = y1 + dy * t;
    const wiggle = Math.sin(t * wiggleFreq + now * 0.006 + seed * 1.7) * wiggleAmp * (1 - Math.abs(t - 0.5) * 2);
    ctx.lineTo(baseX + nx * wiggle, baseY + ny * wiggle);
  }
  ctx.stroke();

  // Glow pass
  ctx.globalAlpha = def.glowAlpha;
  ctx.lineWidth = def.glowWidth * zoom;
  ctx.shadowBlur = def.glowShadowBlur * zoom;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const baseX = x1 + dx * t;
    const baseY = y1 + dy * t;
    const wiggle = Math.sin(t * wiggleFreq + now * 0.006 + seed * 1.7) * wiggleAmp * (1 - Math.abs(t - 0.5) * 2);
    ctx.lineTo(baseX + nx * wiggle, baseY + ny * wiggle);
  }
  ctx.stroke();

  ctx.restore();
}

// ─── Trail / Beam entry points ──────────────────────────────────────────────

/**
 * Render a trail effect from screen-space points.
 * Dispatches to bubbleTrail or taperedTrail based on def.type.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} trailDef - JSON definition (type: bubbleTrail or taperedTrail)
 * @param {Array} screenPoints - [{ sx, sy, timestamp, speed? }] already camera-transformed
 * @param {number} now - performance.now()
 * @param {object} [opts={}] - { isLocal, maxSpeed, zoom }
 */
export function drawTrailEffect(ctx, trailDef, screenPoints, now, opts = {}) {
  if (!screenPoints || screenPoints.length < 1) return;
  const type = trailDef.type;
  if (type === 'bubbleTrail') {
    _bubbleTrail(ctx, trailDef, screenPoints, now, opts);
  } else if (type === 'taperedTrail') {
    if (screenPoints.length < 2) return;
    _taperedTrail(ctx, trailDef, screenPoints, now, opts);
  } else {
    warnOnce('trailType:' + type, `[VFX] unknown trail effect type: ${type}`);
  }
}

/**
 * Render a beam effect between two screen-space endpoints.
 * Dispatches to wiggleBeam based on def.type.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} beamDef - JSON definition (type: wiggleBeam)
 * @param {number} x1 - Start X (screen space)
 * @param {number} y1 - Start Y
 * @param {number} x2 - End X
 * @param {number} y2 - End Y
 * @param {number} now - performance.now()
 * @param {object} [opts={}] - { isLocal, entityId, zoom }
 */
export function drawBeamEffect(ctx, beamDef, x1, y1, x2, y2, now, opts = {}) {
  if (beamDef.type === 'wiggleBeam') {
    _wiggleBeam(ctx, beamDef, x1, y1, x2, y2, now, opts);
  } else {
    warnOnce('beamType:' + beamDef.type, `[VFX] unknown beam effect type: ${beamDef.type}`);
  }
}
