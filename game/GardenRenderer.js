import { drawUnifiedArt } from '/engine/render/ArtInterpreter.js';

// Draws the garden: static props, critters (vector art), and all effects
// (trails, persistent auras, one-shot effects, debris, tether beams) via the
// engine's ArtInterpreter + EffectsRenderer.
export class GardenRenderer {
  constructor(ctx, camera, art, vfx, effectsRenderer) {
    this.ctx = ctx;
    this.camera = camera;
    this.art = art;                 // { critters: {...}, props: {...} }
    this.vfx = vfx;                 // VFX_DEFS
    this.fx = effectsRenderer;
  }

  _drawArtAt(def, worldX, worldY, r, color, state, now, transition) {
    const zoom = this.camera.getZoom?.() ?? 1;
    const { sx, sy } = this.camera.worldToScreen(worldX, worldY);
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(sx, sy);
    // Scale via the canvas transform (not r*zoom) so EVERYTHING scales with zoom:
    // r-relative coords, absolute `…Abs` radii, line widths, AND shadow blur (the glow).
    ctx.scale(zoom, zoom);
    drawUnifiedArt(ctx, r, color, def, state, now, transition);
    ctx.restore();
  }

  // A glowing "firefly" that eases toward the mouse and pulses (its trail is
  // emitted into EffectsManager and drawn by drawTrails).
  drawCursorFollower(x, y, now) {
    const zoom = this.camera.getZoom?.() ?? 1;
    const { sx, sy } = this.camera.worldToScreen(x, y);
    const r = (5 + 1.5 * Math.sin(now * 0.006)) * zoom;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = '#fff7d8';
    ctx.shadowColor = '#ffe08a';
    ctx.shadowBlur = 16 * zoom;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawProps(props, now) {
    for (const p of props) {
      const def = this.art.props[p.artId];
      if (def) this._drawArtAt(def, p.x, p.y, p.r, p.color || '#9fb0a4', 'idle', now);
    }
  }

  drawTrails(trails, now) {
    this.fx.drawTrails(trails, now);
  }

  drawCritters(critters, now) {
    for (const c of critters) {
      const def = this.art.critters[c.species];
      // Per-entity transition object: carries the play-once keyframe epoch
      // (startTime), the pose-crossfade snapshot, and state-blend tracking.
      if (def) {
        c._artTransition = c._artTransition || {};
        this._drawArtAt(def, c.x, c.y, c.radius, c.color, c.state, now, c._artTransition);
      }
    }
  }

  // Persistent aura under happy critters.
  drawAuras(critters, now) {
    const aura = this.vfx.sparkleAura;
    if (!aura) return;
    for (const c of critters) {
      if (c.state === 'happy') {
        this.fx.drawEffectAt(aura, c.x, c.y, null, c.radius / 26, now);
      }
    }
  }

  // Continuous tether beams between linked pairs.
  drawTethers(pairs, now) {
    const beam = this.vfx.tether;
    if (!beam) return;
    for (const [a, b] of pairs) {
      this.fx.drawBeam(a.x, a.y, b.x, b.y, beam, now, { entityId: a.id });
    }
  }

  drawEffects(effectsManager, now) {
    this.fx.drawGenericEffects(effectsManager.getGenericEffects(now), now);
    this.fx.drawDebris(effectsManager.getDebris(now));
  }
}
