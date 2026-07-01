// Effect simulation state for the VFX editor preview. Split out of vfxEditor.js.
// A self-contained clock/particle simulator: drives one-shot progress, debris
// physics, and the demo trail motion path. No editor state, no DOM — the preview
// loop reads getProgress()/trailPoints/debris and hands them to the renderers.

export class EffectSimulator {
  constructor() { this.reset(); }

  reset() {
    this.debris = [];
    this._lastUpdate = null;
    this._startTime = null;
    this._def = null;
    this._opts = {};
    this._progress = 0;
    // Trail simulation
    this.trailPoints = {};
    this._motionAngle = 0;
    this._motionPos = { x: 0, y: 0 };
  }

  play(def, opts = {}) {
    this.reset();
    const now = performance.now();
    this._startTime = now;
    this._def = def;
    this._opts = opts;
    this._progress = 0;

    // Spawn debris for phased effects
    if (def.type === 'phased' && def.debris) {
      for (const d of def.debris) {
        this._spawnDebrisBurst(now, 0, 0, d.count, d.speed, d.lifetime, d.size, d.color);
      }
    }

    // Trail motion init
    if (def.type === 'bubbleTrail' || def.type === 'taperedTrail') {
      this.trailPoints = { trail0: [] };
      this._motionPos = { x: -150, y: 0 };
      this._motionAngle = 0;
    }
  }

  update(now, speedMult = 1) {
    if (!this._def) return;
    const dt = this._lastUpdate ? (now - this._lastUpdate) * speedMult : 0;
    this._lastUpdate = now;

    const def = this._def;

    // Update progress for one-shot phased effects
    if (def.type === 'phased' && def.lifecycle !== 'persistent' && def.duration) {
      this._progress = Math.min(1, (now - this._startTime) / def.duration);
    }

    // Update debris physics
    const dtSec = dt / 1000;
    this.debris = this.debris.filter(d => {
      const age = now - d.startTime;
      if (age >= d.lifetime) return false;
      d.x += d.vx * dtSec;
      d.y += d.vy * dtSec;
      d.vx *= 0.96;
      d.vy *= 0.96;
      d.alpha = 1 - age / d.lifetime;
      return true;
    });

    // Trail motion simulation
    if (def.type === 'bubbleTrail' || def.type === 'taperedTrail') {
      const speed = 200 * speedMult;
      this._motionPos.x += Math.cos(this._motionAngle) * speed * dtSec;
      this._motionPos.y += Math.sin(this._motionAngle) * speed * dtSec;

      if (Math.abs(this._motionPos.x) > 180) {
        this._motionAngle = Math.PI - this._motionAngle;
        this._motionPos.x = Math.max(-180, Math.min(180, this._motionPos.x));
      }
      if (Math.abs(this._motionPos.y) > 120) {
        this._motionAngle = -this._motionAngle;
        this._motionPos.y = Math.max(-120, Math.min(120, this._motionPos.y));
      }

      const trail = this.trailPoints.trail0;
      trail.push({ x: this._motionPos.x, y: this._motionPos.y, timestamp: now, speed });

      const lifetime = def.pointLifetime || 600;
      const maxLen = def.maxLength || 30;
      while (trail.length > 0 && now - trail[0].timestamp > lifetime) trail.shift();
      while (trail.length > maxLen) trail.shift();
    }

    // Auto-replay one-shot phased effects
    if (def.type === 'phased' && def.lifecycle !== 'persistent' && this._progress >= 1 && this.debris.length === 0) {
      this.play(def, this._opts);
    }
  }

  getProgress() { return this._progress; }
  getDef() { return this._def; }

  _spawnDebrisBurst(now, x, y, count, speed, lifetime, size, color) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.6);
      this.debris.push({
        x, y, vx: Math.cos(angle) * v, vy: Math.sin(angle) * v,
        startTime: now, lifetime, size: size * (0.5 + Math.random() * 0.5),
        color, alpha: 1,
      });
    }
  }
}
