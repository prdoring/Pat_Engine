import { applyShipPhysics } from '/engine/physics/shipPhysics.js';
import { SPECIES, CRITTER_STATS, WORLD } from './config.js';

let _nextId = 1;

export class Critter {
  constructor(x, y, species) {
    this.id = 'c' + (_nextId++);
    this.species = species;
    const spec = SPECIES[species];
    this.radius = spec.radius;
    this.color = spec.color;
    this.trailRef = spec.trail;

    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.angle = Math.random() * Math.PI * 2;

    this.state = 'idle';      // idle | happy | scared | linked

    this.linkedTo = null;
    this.unlinkAt = 0;

    this._pickWanderTarget();
    this.wanderUntil = 0;
  }

  _pickWanderTarget() {
    const margin = 80;
    this.tx = margin + Math.random() * (WORLD.width - margin * 2);
    this.ty = margin + Math.random() * (WORLD.height - margin * 2);
  }

  /** Steer toward the wander target and integrate physics for dt seconds. */
  update(dt, now) {
    if (now > this.wanderUntil) {
      this._pickWanderTarget();
      this.wanderUntil = now + 2500 + Math.random() * 3000;
    }

    // Desired heading toward target.
    const desired = Math.atan2(this.ty - this.y, this.tx - this.x);
    let diff = desired - this.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;

    const input = {
      rotateLeft: diff < -0.05,
      rotateRight: diff > 0.05,
      // Thrust when roughly facing the target. Scared critters scurry harder.
      thrust: Math.abs(diff) < 0.7,
    };

    const stats = this.state === 'scared'
      ? { ...CRITTER_STATS, thrustForce: CRITTER_STATS.thrustForce * 1.8, maxSpeed: CRITTER_STATS.maxSpeed * 1.6 }
      : CRITTER_STATS;

    applyShipPhysics(this, input, dt, stats, WORLD);
  }

  get speed() {
    return Math.hypot(this.vx, this.vy);
  }
}
