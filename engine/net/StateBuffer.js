// Client-side interpolation buffer. Generalized from Sub Game's StateBuffer,
// which interpolated a hardcoded set of submarine fields. Here interpolation is
// driven by a field-descriptor config so any entity shape works.
//
// Runs in the browser (client). OPTIONAL engine module — not used by the
// example. See net/README.md.

function lerp(a, b, t) { return a + (b - a) * t; }

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class StateBuffer {
  /**
   * @param {object} opts
   * @param {number} [opts.renderDelay=100] - ms behind real time to render (smoothing)
   * @param {number} [opts.maxSnapshots=12]
   * @param {string} [opts.entitiesKey='entities'] - key on each snapshot holding the id→entity map
   * @param {object} [opts.fields] - { lerp:[...], lerpAngle:[...], copy:[...] } per-entity field descriptors
   */
  constructor({ renderDelay = 100, maxSnapshots = 12, entitiesKey = 'entities', fields = {} } = {}) {
    this.renderDelay = renderDelay;
    this.maxSnapshots = maxSnapshots;
    this.entitiesKey = entitiesKey;
    this.lerpFields = fields.lerp || ['x', 'y'];
    this.lerpAngleFields = fields.lerpAngle || ['angle'];
    this.copyFields = fields.copy || [];
    this.snapshots = []; // [{ t, state }] sorted by t ascending
  }

  /** Push a server snapshot. `t` defaults to performance.now() in the browser. */
  push(state, t) {
    if (t === undefined) t = (typeof performance !== 'undefined') ? performance.now() : 0;
    this.snapshots.push({ t, state });
    while (this.snapshots.length > this.maxSnapshots) this.snapshots.shift();
  }

  /**
   * Get the interpolated state for render time (now - renderDelay).
   * Returns null if no snapshots; the latest snapshot if outside the buffer range.
   */
  getInterpolated(now) {
    if (this.snapshots.length === 0) return null;
    const target = now - this.renderDelay;
    const latest = this.snapshots[this.snapshots.length - 1];
    if (this.snapshots.length === 1 || target >= latest.t) return latest.state;

    let before = this.snapshots[0], after = latest;
    for (let i = 0; i < this.snapshots.length - 1; i++) {
      if (this.snapshots[i].t <= target && this.snapshots[i + 1].t >= target) {
        before = this.snapshots[i];
        after = this.snapshots[i + 1];
        break;
      }
    }
    const span = after.t - before.t;
    const t = span > 0 ? (target - before.t) / span : 0;
    return this._interp(before.state, after.state, t);
  }

  _interp(a, b, t) {
    const result = { ...b }; // copy top-level (non-entity) fields from the latest
    const aEnts = a[this.entitiesKey] || {};
    const bEnts = b[this.entitiesKey] || {};
    const out = {};
    for (const id in bEnts) {
      const be = bEnts[id];
      const ae = aEnts[id];
      if (!ae) { out[id] = be; continue; }
      const e = { ...be };
      for (const f of this.lerpFields) if (typeof ae[f] === 'number' && typeof be[f] === 'number') e[f] = lerp(ae[f], be[f], t);
      for (const f of this.lerpAngleFields) if (typeof ae[f] === 'number' && typeof be[f] === 'number') e[f] = lerpAngle(ae[f], be[f], t);
      for (const f of this.copyFields) e[f] = be[f];
      out[id] = e;
    }
    result[this.entitiesKey] = out;
    return result;
  }
}
