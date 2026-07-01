/**
 * Deprecated in-art particle emitters (dots / lines / strips).
 *
 * Extracted verbatim from ArtInterpreter's `case 'particles'` block. Kept for
 * backwards compatibility with existing art; new particle clouds should be
 * authored in the VFX tab and embedded via an `effectRef` shape. Game-agnostic;
 * visibility (`visibleStates`) is already checked by the caller.
 */

import { resolveCoord } from './coords.js';

const PI = Math.PI;

/**
 * Render a `particles` shape's emitters. `dc` is the interpreter draw context
 * (r, now, …); `shape.emitters` is the authored emitter list.
 */
export function drawParticles(ctx, dc, shape, varMap) {
  for (const emitter of shape.emitters) {
    const ecx = resolveCoord(emitter.cx, dc, varMap);
    const ecy = resolveCoord(emitter.cy, dc, varMap);

    if (emitter.kind === 'dots') {
      if (emitter.shadowColor) { ctx.shadowColor = emitter.shadowColor; ctx.shadowBlur = emitter.shadowBlur || 0; }
      for (let i = 0; i < emitter.count; i++) {
        const ox = (emitter.offsetX || 0) * dc.r + (Math.random() - 0.5) * emitter.spreadX * dc.r;
        const oy = (Math.random() - 0.5) * emitter.spreadY * dc.r;
        const sz = emitter.sizeMin + Math.random() * emitter.sizeRange;
        ctx.globalAlpha = emitter.alphaMin + Math.random() * emitter.alphaRange;
        const colors = emitter.colors;
        ctx.fillStyle = Math.random() < (emitter.colorThreshold || 0.5) ? colors[1] : colors[0];
        ctx.beginPath();
        ctx.arc(ecx + ox, ecy + oy, sz, 0, PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    } else if (emitter.kind === 'lines') {
      ctx.strokeStyle = emitter.color;
      ctx.lineWidth = emitter.lineWidth || 1;
      for (let i = 0; i < emitter.count; i++) {
        const sx = ecx + (emitter.startOffset || 0) * dc.r;
        const sy = ecy + (Math.random() - 0.5) * emitter.spreadFactor * dc.r;
        const ex = sx + (emitter.reachOffset || 0) * dc.r + Math.random() * emitter.reachFactor * dc.r;
        const ey = sy + (Math.random() - 0.5) * emitter.spreadFactor * dc.r;
        ctx.globalAlpha = emitter.alphaMin + Math.random() * emitter.alphaRange;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      }
    } else if (emitter.kind === 'strips') {
      // Deterministic rotating strips — small line segments at seeded positions,
      // each spinning independently. Used for chaff-like particle clouds.
      const colors = emitter.colors || ['#ccddcc'];
      const halfLen = (emitter.stripLength || 0.15) * 0.5 * dc.r;
      const lw = (emitter.lineWidth || 0.05) * dc.r;
      const spread = (emitter.spread || 1) * dc.r;
      const minSpeed = emitter.rotateSpeedMin || 0.002;
      const speedRange = (emitter.rotateSpeedMax || 0.006) - minSpeed;
      const alphaMin = emitter.alphaMin || 0.4;
      const alphaRange = emitter.alphaRange || 0.5;
      if (emitter.shadowColor) { ctx.shadowColor = emitter.shadowColor; ctx.shadowBlur = emitter.shadowBlur || 0; }
      ctx.lineWidth = lw;
      for (let i = 0; i < emitter.count; i++) {
        // Hash each property with a different seed for decorrelated values
        const hash = (v) => { v = ((v >>> 16) ^ v) * 0x45d9f3b | 0; v = ((v >>> 16) ^ v) * 0x45d9f3b | 0; return ((v >>> 16) ^ v) >>> 0; };
        const h1 = hash(i * 7 + 1) / 4294967296;
        const h2 = hash(i * 13 + 2) / 4294967296;
        const h3 = hash(i * 19 + 3) / 4294967296;
        const h4 = hash(i * 31 + 4) / 4294967296;
        const h5 = hash(i * 37 + 5) / 4294967296;
        // Position within circular spread
        const angle = h1 * PI * 2;
        const dist = Math.sqrt(h2) * spread;
        const px = ecx + Math.cos(angle) * dist;
        const py = ecy + Math.sin(angle) * dist;
        // Rotation: each strip spins at its own speed and direction
        const speed = minSpeed + h3 * speedRange;
        const dir = h4 < 0.5 ? 1 : -1;
        const rot = (h5 * PI * 2) + dc.now * speed * dir;
        const dx = Math.cos(rot) * halfLen;
        const dy = Math.sin(rot) * halfLen;
        ctx.globalAlpha = alphaMin + h3 * alphaRange;
        ctx.strokeStyle = colors[Math.floor(h4 * colors.length)];
        ctx.beginPath();
        ctx.moveTo(px - dx, py - dy);
        ctx.lineTo(px + dx, py + dy);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }
  }
}
