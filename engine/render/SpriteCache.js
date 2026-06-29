// Generic offscreen-canvas LRU memoizer. Expensive, frame-stable drawing (composing
// layered vector art, an occlusion pre-pass, blur halos…) is identical every frame
// for a given appearance, so rasterize it once to a bitmap tile and blit thereafter.
//
// The CALLER owns the cache key — it must encode everything that changes the pixels
// (art id, palette, state, size bucket) and EXCLUDE per-frame transforms (position,
// rotation, idle bob): apply those when blitting the returned canvas. The engine
// knows nothing about what is drawn — it just hands back a canvas and runs the
// caller's draw callback on a miss. Device pixel ratio is folded into the backing
// store (and the key) so tiles stay crisp on HiDPI without the caller managing it.

export class SpriteCache {
  /** @param {{max?: number, dprCap?: number}} [opts] max tiles (LRU), DPR cap. */
  constructor({ max = 64, dprCap = 3 } = {}) {
    this.max = max;
    this.dprCap = dprCap;
    this._map = new Map();      // key@dpr -> { canvas, w, h, dpr }
    this._capable = undefined;
  }

  // Can this environment back a tile cache? A real browser canvas → yes; Node or a
  // partial DOM shim with no 2D context → no, and the caller should fall back to
  // drawing straight to the target. Probed once.
  get capable() {
    if (this._capable === undefined) {
      this._capable = false;
      try {
        if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
          const c = document.createElement('canvas');
          this._capable = !!(c && typeof c.getContext === 'function' && c.getContext('2d'));
        }
      } catch { this._capable = false; }
    }
    return this._capable;
  }

  // Device pixel ratio, capped so tile backing stores stay bounded in memory.
  get dpr() {
    const d = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return Math.min(this.dprCap, Math.max(1, d));
  }

  /**
   * Return a cached w×h (logical px) offscreen canvas for `key`, painting it via
   * `draw(cctx, w, h)` on a miss. The context is pre-scaled by the (capped) device
   * pixel ratio, so `draw` works in logical px and the bitmap stays crisp on HiDPI.
   * Returns null when the environment can't back a canvas (caller draws directly).
   * @returns {{canvas: HTMLCanvasElement, w: number, h: number, dpr: number}|null}
   */
  get(key, w, h, draw) {
    if (!this.capable) return null;
    const dpr = this.dpr;
    const k = `${key}@${dpr}`;                 // DPR in the key → a DPR change re-rasterizes
    const hit = this._map.get(k);
    if (hit) { this._map.delete(k); this._map.set(k, hit); return hit; } // LRU touch
    const lw = Math.max(1, Math.round(w)), lh = Math.max(1, Math.round(h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(lw * dpr));
    canvas.height = Math.max(1, Math.round(lh * dpr));
    const cctx = canvas.getContext('2d');
    cctx.scale(dpr, dpr);
    draw(cctx, lw, lh);
    const tile = { canvas, w: lw, h: lh, dpr };
    this._map.set(k, tile);
    if (this._map.size > this.max) this._map.delete(this._map.keys().next().value); // evict oldest
    return tile;
  }

  /** Drop every cached tile (e.g. on a theme/palette change that invalidates all art). */
  clear() { this._map.clear(); }

  /** Number of tiles currently cached. */
  get size() { return this._map.size; }
}
