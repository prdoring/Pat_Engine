/**
 * VFX primitive renderers + dispatch table.
 *
 * Game-agnostic canvas drawers. Each entry in PRIMITIVE_RENDERERS resolves its
 * values via ./resolve.js then draws. Deterministic primitives (circle/ring/
 * spike) plus the randomized-cloud scatter primitives ported from the old art
 * `particles` emitters. Consumed by ../VFXInterpreter.js's phased dispatch.
 */

import { resolveColor, resolveValue, resolveShadow } from './resolve.js';

const PI2 = Math.PI * 2;

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

export const PRIMITIVE_RENDERERS = {
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
