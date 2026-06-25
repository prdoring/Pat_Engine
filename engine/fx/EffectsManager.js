// Generic effects manager — game-agnostic.
//
// Manages three kinds of transient visual state:
//   1. One-shot/persistent "generic effects" (phased VFX defs) spawned by gameplay
//      or by the FXSequenceRunner via addGenericEffect().
//   2. Per-emitter trails: the game calls emitTrail(id, ...) each frame for any
//      moving thing; the manager accumulates + prunes points by lifetime/length.
//   3. Debris particles spawned from a VFX def's `debris` array.
//
// This replaces Sub Game's version, which hardcoded ship/torpedo/rocket trails
// against MODULE_DEFAULTS/PAYLOAD_DEFAULTS. Here trails are fully generic.

const DEBRIS_DRAG = 0.96;
const DEFAULT_POINT_LIFETIME = 600; // ms
const DEFAULT_MAX_LENGTH = 40;

/** Prune expired/excess trail points in O(1) amortized via a single splice. */
function pruneTrail(points, now, lifetime, maxLen) {
  let cutoff = 0;
  while (cutoff < points.length && now - points[cutoff].timestamp > lifetime) cutoff++;
  const excess = (points.length - cutoff) - maxLen;
  if (excess > 0) cutoff += excess;
  if (cutoff > 0) points.splice(0, cutoff);
}

export class EffectsManager {
  constructor() {
    /** @type {Map<string, {def: object, points: object[]}>} */
    this.trails = new Map();
    this.genericEffects = [];
    this.debris = [];
    this.lastDebrisUpdate = null;
  }

  // ─── Per-frame update ────────────────────────────────────────────
  update(now) {
    this._pruneTrails(now);
    this._updateDebris(now);
    this._cleanupEffects(now);
  }

  // ─── Trails ──────────────────────────────────────────────────────
  /** Pre-register a trail's def (optional — emitTrail can carry it too). */
  registerTrail(id, def) {
    if (!this.trails.has(id)) this.trails.set(id, { def, points: [] });
    else if (def) this.trails.get(id).def = def;
  }

  /**
   * Push a point to an emitter's trail. Auto-registers on first call if `def`
   * is provided. `extra` is merged into the point (e.g. { speed }).
   */
  emitTrail(id, x, y, now, extra = {}, def = null) {
    let entry = this.trails.get(id);
    if (!entry) {
      entry = { def: def || null, points: [] };
      this.trails.set(id, entry);
    } else if (def) {
      entry.def = def;
    }
    entry.points.push({ x, y, timestamp: now, ...extra });
  }

  clearTrail(id) { this.trails.delete(id); }

  _pruneTrails(now) {
    for (const [id, entry] of this.trails) {
      const def = entry.def || {};
      const lifetime = def.pointLifetime ?? DEFAULT_POINT_LIFETIME;
      const maxLen = def.maxLength ?? DEFAULT_MAX_LENGTH;
      pruneTrail(entry.points, now, lifetime, maxLen);
      if (entry.points.length === 0) this.trails.delete(id);
    }
  }

  /** @returns {Array<{id, def, points}>} */
  getTrails() {
    const out = [];
    for (const [id, entry] of this.trails) out.push({ id, def: entry.def, points: entry.points });
    return out;
  }

  // ─── Generic phased effects (+ debris) ───────────────────────────
  /**
   * Spawn a phased VFX effect at (x, y). Called directly or by FXSequenceRunner.
   * opts: { blastRadius?, scale?, now?, id? }
   * Pass opts.id to get a removal handle for persistent effects (see removeGenericEffect).
   */
  addGenericEffect(vfxDef, x, y, opts = {}) {
    const now = opts.now ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.genericEffects.push({
      x, y, vfxDef,
      id: opts.id,
      startTime: now,
      duration: vfxDef.duration,
      scale: opts.blastRadius || opts.scale || vfxDef.defaultScale || 1,
    });
    if (vfxDef.debris) {
      for (const d of vfxDef.debris) {
        this._spawnDebris(now, x, y, d.count, d.speed, d.lifetime, d.size, d.color);
      }
    }
  }

  /** Remove generic effect(s) by the id supplied to addGenericEffect. */
  removeGenericEffect(id) {
    if (id == null) return;
    this.genericEffects = this.genericEffects.filter(e => e.id !== id);
  }

  getGenericEffects(now) {
    return this.genericEffects.map(e => ({
      x: e.x, y: e.y, vfxDef: e.vfxDef, scale: e.scale, id: e.id,
      // Persistent effects (no duration) report null progress.
      progress: e.duration ? (now - e.startTime) / e.duration : null,
    }));
  }

  _cleanupEffects(now) {
    this.genericEffects = this.genericEffects.filter(
      e => !e.duration || now - e.startTime < e.duration
    );
  }

  // ─── Debris particles ────────────────────────────────────────────
  _spawnDebris(now, x, y, count, speed, lifetime, size, color) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.6);
      this.debris.push({
        x, y,
        vx: Math.cos(angle) * v, vy: Math.sin(angle) * v,
        startTime: now, lifetime,
        size: size * (0.5 + Math.random() * 0.5),
        color,
      });
    }
  }

  _updateDebris(now) {
    // Clamp dt so a backgrounded tab (large now gap) doesn't teleport debris.
    const dt = this.lastDebrisUpdate ? Math.min(0.05, (now - this.lastDebrisUpdate) / 1000) : 0.016;
    this.lastDebrisUpdate = now;
    this.debris = this.debris.filter(d => {
      const age = now - d.startTime;
      if (age >= d.lifetime) return false;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.vx *= DEBRIS_DRAG;
      d.vy *= DEBRIS_DRAG;
      return true;
    });
  }

  getDebris(now) {
    return this.debris.map(d => ({
      x: d.x, y: d.y, size: d.size, color: d.color,
      alpha: 1 - (now - d.startTime) / d.lifetime,
    }));
  }

  // ─── Lifecycle ───────────────────────────────────────────────────
  stopAll() {
    this.trails.clear();
    this.genericEffects = [];
    this.debris = [];
    this.lastDebrisUpdate = null;
  }
}
