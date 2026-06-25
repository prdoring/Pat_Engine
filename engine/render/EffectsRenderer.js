// Bridge between the game-aware EffectsManager and the game-agnostic
// VFXInterpreter: applies camera transforms (world → screen) and delegates to
// the three interpreter entry points. No game knowledge.

import { drawPhasedEffect, drawTrailEffect, drawBeamEffect } from './VFXInterpreter.js';

export class EffectsRenderer {
  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} camera - exposes worldToScreen(x,y)->{sx,sy} and optional getZoom()
   */
  constructor(ctx, camera) {
    this.ctx = ctx;
    this.camera = camera;
  }

  /**
   * Draw all emitter trails from EffectsManager.getTrails().
   * @param {Array<{id, def, points}>} trails
   */
  drawTrails(trails, now, opts = {}) {
    const zoom = this.camera.getZoom?.() ?? 1;
    for (const { def, points } of trails) {
      if (!def || !points || points.length < 1) continue;
      const screenPoints = points.map(pt => {
        const { sx, sy } = this.camera.worldToScreen(pt.x, pt.y);
        return { sx, sy, timestamp: pt.timestamp, speed: pt.speed };
      });
      drawTrailEffect(this.ctx, def, screenPoints, now, { ...opts, zoom });
    }
  }

  /** Draw a single beam between two WORLD-space endpoints. */
  drawBeam(x1, y1, x2, y2, beamDef, now, opts = {}) {
    const zoom = this.camera.getZoom?.() ?? 1;
    const a = this.camera.worldToScreen(x1, y1);
    const b = this.camera.worldToScreen(x2, y2);
    drawBeamEffect(this.ctx, beamDef, a.sx, a.sy, b.sx, b.sy, now, { ...opts, zoom });
  }

  /**
   * Draw phased generic effects from EffectsManager.getGenericEffects(now).
   * Persistent effects have progress === null.
   */
  drawGenericEffects(effects, now) {
    const zoom = this.camera.getZoom?.() ?? 1;
    const ctx = this.ctx;
    for (const e of effects) {
      if (e.vfxDef.type !== 'phased') continue;
      const { sx, sy } = this.camera.worldToScreen(e.x, e.y);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(zoom, zoom); // scale size + shadow/glow uniformly with zoom
      drawPhasedEffect(ctx, 0, 0, e.vfxDef, e.progress, e.scale, now);
      ctx.restore();
    }
  }

  /**
   * Draw a single phased effect at a WORLD position. Use for per-entity
   * persistent effects (e.g. an aura attached to a live entity each frame).
   * progress null = persistent.
   */
  drawEffectAt(effectDef, x, y, progress, scale, now, opts = {}) {
    const zoom = this.camera.getZoom?.() ?? 1;
    const { sx, sy } = this.camera.worldToScreen(x, y);
    // Scale via transform so the effect's shadow/glow scales with zoom too.
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(sx, sy);
    ctx.scale(zoom, zoom);
    drawPhasedEffect(ctx, 0, 0, effectDef, progress, scale, now, opts);
    ctx.restore();
  }

  /** Draw debris particles from EffectsManager.getDebris(now). */
  drawDebris(debrisList) {
    const ctx = this.ctx;
    const zoom = this.camera.getZoom?.() ?? 1;
    for (const d of debrisList) {
      const { sx, sy } = this.camera.worldToScreen(d.x, d.y);
      ctx.save();
      ctx.globalAlpha = d.alpha * 0.9;
      ctx.fillStyle = d.color;
      ctx.shadowColor = d.color;
      ctx.shadowBlur = 4 * zoom;
      ctx.beginPath();
      ctx.arc(sx, sy, d.size * zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}
