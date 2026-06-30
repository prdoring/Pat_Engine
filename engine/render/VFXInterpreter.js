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
 *
 * Value types:
 *   static number:  0.5
 *   animated:       { from: 0, to: 1 }             — lerp over phase progress
 *   modulated:      { from: 0.8, to: 0, modulate: { freq, amp } }  — lerp + sin
 *   oscillating:    { base: 10, amplitude: 5, freq: 0.01 }         — sin wave (persistent)
 */

const PI2 = Math.PI * 2;

// ─── Dev-mode validation (warn once per unknown key) ─────────────────────────
const _warnedKeys = new Set();
function _warnOnce(key, msg) {
  if (_warnedKeys.has(key)) return;
  _warnedKeys.add(key);
  console.warn(msg);
}

// ─── Value resolution ────────────────────────────────────────────────────────

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
function resolveShadow(shadow, layerColor, phaseProgress, now, opts) {
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

// ─── Primitive renderers ─────────────────────────────────────────────────────

function _filledCircle(ctx, x, y, radius, color, alpha, shadow) {
  if (radius <= 0 || alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.fillStyle = color;
  ctx.shadowColor = shadow.color;
  ctx.shadowBlur = shadow.blur;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, PI2);
  ctx.fill();
  ctx.restore();
}

function _gradientCircle(ctx, x, y, radius, gradientStops, color, alpha, shadow) {
  if (radius <= 0 || alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
  if (gradientStops && gradientStops.length > 0) {
    for (const stop of gradientStops) {
      grad.addColorStop(stop.offset, stop.color);
    }
  } else {
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
  }
  ctx.fillStyle = grad;
  ctx.shadowColor = shadow.color;
  ctx.shadowBlur = shadow.blur;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, PI2);
  ctx.fill();
  ctx.restore();
}

function _strokeRing(ctx, x, y, radius, color, lineWidth, alpha, shadow) {
  if (radius <= 0 || alpha <= 0 || lineWidth <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.strokeStyle = color;
  ctx.shadowColor = shadow.color;
  ctx.shadowBlur = shadow.blur;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, PI2);
  ctx.stroke();
  ctx.restore();
}

function _dashedRing(ctx, x, y, radius, color, lineWidth, dashPattern, alpha, shadow) {
  if (radius <= 0 || alpha <= 0 || lineWidth <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.strokeStyle = color;
  ctx.shadowColor = shadow.color;
  ctx.shadowBlur = shadow.blur;
  ctx.lineWidth = lineWidth;
  ctx.setLineDash(dashPattern || [4, 6]);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, PI2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function _spikeLines(ctx, x, y, count, innerRadius, outerRadius, color, lineWidth, alpha, shadow) {
  if (count <= 0 || alpha <= 0 || innerRadius <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.strokeStyle = color;
  ctx.shadowColor = shadow.color;
  ctx.shadowBlur = shadow.blur;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const a = (i / count) * PI2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    ctx.moveTo(x + cos * innerRadius, y + sin * innerRadius);
    ctx.lineTo(x + cos * outerRadius, y + sin * outerRadius);
  }
  ctx.stroke();
  ctx.restore();
}

// ─── Primitive dispatch ──────────────────────────────────────────────────────

const PRIMITIVE_RENDERERS = {
  filledCircle(ctx, x, y, layer, pp, now, scale, opts) {
    const color = resolveColor(layer.color, opts);
    const radius = resolveValue(layer.radius, pp, now) * scale;
    const alpha = resolveValue(layer.alpha ?? 1, pp, now);
    const shadow = resolveShadow(layer.shadow, color, pp, now, opts);
    _filledCircle(ctx, x, y, radius, color, alpha, shadow);
  },

  gradientCircle(ctx, x, y, layer, pp, now, scale, opts) {
    const color = resolveColor(layer.color ?? '#ffffff', opts);
    const radius = resolveValue(layer.radius, pp, now) * scale;
    const alpha = resolveValue(layer.alpha ?? 1, pp, now);
    const shadow = resolveShadow(layer.shadow, color, pp, now, opts);
    _gradientCircle(ctx, x, y, radius, layer.gradient, color, alpha, shadow);
  },

  strokeRing(ctx, x, y, layer, pp, now, scale, opts) {
    const color = resolveColor(layer.color, opts);
    const radius = resolveValue(layer.radius, pp, now) * scale;
    const lineWidth = resolveValue(layer.lineWidth ?? 1, pp, now);
    const alpha = resolveValue(layer.alpha ?? 1, pp, now);
    const shadow = resolveShadow(layer.shadow, color, pp, now, opts);
    _strokeRing(ctx, x, y, radius, color, lineWidth, alpha, shadow);
  },

  dashedRing(ctx, x, y, layer, pp, now, scale, opts) {
    const color = resolveColor(layer.color, opts);
    const radius = resolveValue(layer.radius, pp, now) * scale;
    const lineWidth = resolveValue(layer.lineWidth ?? 1, pp, now);
    const alpha = resolveValue(layer.alpha ?? 1, pp, now);
    const shadow = resolveShadow(layer.shadow, color, pp, now, opts);
    _dashedRing(ctx, x, y, radius, color, lineWidth, layer.dashPattern, alpha, shadow);
  },

  spikeLines(ctx, x, y, layer, pp, now, scale, opts) {
    const color = resolveColor(layer.color, opts);
    const innerR = resolveValue(layer.innerRadius, pp, now) * scale;
    const outerR = resolveValue(layer.outerRadius, pp, now) * scale;
    const lineWidth = resolveValue(layer.lineWidth ?? 1, pp, now);
    const alpha = resolveValue(layer.alpha ?? 1, pp, now);
    const shadow = resolveShadow(layer.shadow, color, pp, now, opts);
    _spikeLines(ctx, x, y, layer.count || 8, innerR, outerR, color, lineWidth, alpha, shadow);
  },

  // ─── Scatter primitives (ported from the art `particles` emitters) ──────────
  // A cloud of N randomized instances. Randomized clouds have no equivalent among
  // the deterministic primitives above; porting them here makes the VFX tab the
  // single home for particle authoring (art references effects via `effectRef`).

  scatterDots(ctx, x, y, layer, pp, now, scale, opts) {
    const count = layer.count || 6;
    const offsetX = (layer.offsetX || 0) * scale;
    const spreadX = (layer.spreadX ?? 0.5) * scale;
    const spreadY = (layer.spreadY ?? 0.5) * scale;
    const sizeMin = (layer.sizeMin ?? 0.5) * scale;
    const sizeRange = (layer.sizeRange ?? 1) * scale;
    const alphaMin = layer.alphaMin ?? 0.3;
    const alphaRange = layer.alphaRange ?? 0.5;
    const colors = (layer.colors || ['#ffffff']).map(c => resolveColor(c, opts));
    const threshold = layer.colorThreshold ?? 0.5;
    ctx.save();
    if (layer.shadowColor) { ctx.shadowColor = layer.shadowColor; ctx.shadowBlur = (layer.shadowBlur || 0) * scale; }
    for (let i = 0; i < count; i++) {
      const px = x + offsetX + (Math.random() * 2 - 1) * spreadX;
      const py = y + (Math.random() * 2 - 1) * spreadY;
      const sz = Math.max(0.1, sizeMin + Math.random() * sizeRange);
      ctx.globalAlpha = Math.max(0, Math.min(1, alphaMin + Math.random() * alphaRange));
      ctx.fillStyle = colors.length > 1 ? (Math.random() < threshold ? colors[0] : colors[1]) : colors[0];
      ctx.beginPath(); ctx.arc(px, py, sz, 0, PI2); ctx.fill();
    }
    ctx.restore();
  },

  scatterLines(ctx, x, y, layer, pp, now, scale, opts) {
    const count = layer.count || 6;
    const color = resolveColor(layer.color ?? '#ffffff', opts);
    const lineWidth = layer.lineWidth || 1;
    const startOffset = (layer.startOffset || 0) * scale;
    const spreadFactor = (layer.spreadFactor ?? 0.5) * scale;
    const reachOffset = (layer.reachOffset || 0) * scale;
    const reachFactor = (layer.reachFactor ?? 0.5) * scale;
    const alphaMin = layer.alphaMin ?? 0.3;
    const alphaRange = layer.alphaRange ?? 0.5;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    for (let i = 0; i < count; i++) {
      const sy2 = y + (Math.random() * 2 - 1) * spreadFactor;
      const sx2 = x + startOffset;
      const reach = reachOffset + Math.random() * reachFactor;
      ctx.globalAlpha = Math.max(0, Math.min(1, alphaMin + Math.random() * alphaRange));
      ctx.beginPath(); ctx.moveTo(sx2, sy2); ctx.lineTo(sx2 + reach, sy2); ctx.stroke();
    }
    ctx.restore();
  },

  scatterStrips(ctx, x, y, layer, pp, now, scale, opts) {
    const count = layer.count || 8;
    const stripLength = (layer.stripLength ?? 0.15) * scale;
    const lineWidth = (layer.lineWidth ?? 0.05) * scale;
    const spread = (layer.spread ?? 1) * scale;
    const rotMin = layer.rotateSpeedMin ?? 0.002;
    const rotMax = layer.rotateSpeedMax ?? 0.006;
    const alphaMin = layer.alphaMin ?? 0.4;
    const alphaRange = layer.alphaRange ?? 0.5;
    const colors = (layer.colors || ['#ccddcc']).map(c => resolveColor(c, opts));
    ctx.save();
    ctx.lineWidth = Math.max(0.2, lineWidth);
    ctx.lineCap = 'round';
    if (layer.shadowColor) { ctx.shadowColor = layer.shadowColor; ctx.shadowBlur = (layer.shadowBlur || 0) * scale; }
    for (let i = 0; i < count; i++) {
      // Deterministic per-strip seed so positions are stable across frames.
      const h = Math.sin(i * 127.1 + 311.7) * 43758.5453;
      const rnd = (k) => { const v = Math.sin((i + 1) * 13.13 + k * 78.233) * 43758.5453; return v - Math.floor(v); };
      const ang0 = (h - Math.floor(h)) * PI2;
      const dist = rnd(1) * spread;
      const rotSpeed = rotMin + rnd(2) * (rotMax - rotMin);
      const rot = ang0 + now * rotSpeed;
      const cxp = x + Math.cos(ang0) * dist;
      const cyp = y + Math.sin(ang0) * dist;
      const hx = Math.cos(rot) * stripLength * 0.5;
      const hy = Math.sin(rot) * stripLength * 0.5;
      ctx.globalAlpha = Math.max(0, Math.min(1, alphaMin + rnd(3) * alphaRange));
      ctx.strokeStyle = colors[i % colors.length];
      ctx.beginPath(); ctx.moveTo(cxp - hx, cyp - hy); ctx.lineTo(cxp + hx, cyp + hy); ctx.stroke();
    }
    ctx.restore();
  },
};

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
    _warnOnce('phased:noDef', '[VFX] drawPhasedEffect called with falsy effectDef');
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
        _warnOnce('primitive:' + layer.primitive, `[VFX] unknown phased-layer primitive: ${layer.primitive}`);
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
    _warnOnce('trailType:' + type, `[VFX] unknown trail effect type: ${type}`);
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
    _warnOnce('beamType:' + beamDef.type, `[VFX] unknown beam effect type: ${beamDef.type}`);
  }
}
