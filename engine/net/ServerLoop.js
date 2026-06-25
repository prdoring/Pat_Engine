// Fixed-timestep authoritative server loop. Generalized from Sub Game's GameLoop
// timing core: instead of a hardcoded list of submarine systems, it drives a
// registry of systems you push, then calls a broadcast hook each tick.
//
// Runs in Node. OPTIONAL engine module — not used by the example. See net/README.md.

const DEFAULT_TICK_MS = 50; // 20 Hz

export class ServerLoop {
  /**
   * @param {object} opts
   * @param {object} opts.state            - your authoritative world state (passed to systems)
   * @param {number} [opts.tickMs=50]
   * @param {function} [opts.broadcast]    - called after systems each tick: (state, tick) => void
   */
  constructor({ state, tickMs = DEFAULT_TICK_MS, broadcast = () => {} } = {}) {
    this.state = state;
    this.tickMs = tickMs;
    this.broadcast = broadcast;
    this.systems = [];     // [{ update(state, dt, tick) }]
    this.tick = 0;
    this._interval = null;
  }

  /** Register a system. Systems run in registration order each tick. */
  addSystem(system) { this.systems.push(system); return this; }

  start() {
    if (this._interval) return;
    const dt = this.tickMs / 1000;
    this._interval = setInterval(() => {
      this.tick++;
      for (const sys of this.systems) {
        try { sys.update(this.state, dt, this.tick); }
        catch (err) { console.error('System error:', err); }
      }
      try { this.broadcast(this.state, this.tick); }
      catch (err) { console.error('Broadcast error:', err); }
    }, this.tickMs);
  }

  stop() {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  }
}
