export class Camera {
  /**
   * @param {HTMLCanvasElement|{width:number,height:number}} canvas
   * @param {object} [opts]
   * @param {number} [opts.minZoom=0.4] - lower zoom clamp
   * @param {number} [opts.maxZoom=3]   - upper zoom clamp
   */
  constructor(canvas, { minZoom = 0.4, maxZoom = 3 } = {}) {
    this.canvas = canvas;
    this.x = 0;
    this.y = 0;
    this.zoom = 1;
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
  }

  follow(target) {
    if (target) {
      this.x = target.x;
      this.y = target.y;
    }
  }

  worldToScreen(wx, wy) {
    return {
      sx: (wx - this.x) * this.zoom + this.canvas.width / 2,
      sy: (wy - this.y) * this.zoom + this.canvas.height / 2,
    };
  }

  // Kept for compatibility — now identical to worldToScreen
  worldToScreenWrapped(wx, wy) {
    return this.worldToScreen(wx, wy);
  }

  // Inverse of worldToScreen — for click/cursor → world coordinates.
  screenToWorld(sx, sy) {
    return {
      x: (sx - this.canvas.width / 2) / this.zoom + this.x,
      y: (sy - this.canvas.height / 2) / this.zoom + this.y,
    };
  }

  getZoom() { return this.zoom; }

  setZoom(z) {
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, z));
  }

  /** Multiply zoom by `factor`, keeping the world point under (sx, sy) fixed. */
  zoomAt(factor, sx, sy) {
    const before = this.screenToWorld(sx, sy);
    this.setZoom(this.zoom * factor);
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  getVisibleBounds() {
    const hw = this.canvas.width / 2 / this.zoom;
    const hh = this.canvas.height / 2 / this.zoom;
    return { left: this.x - hw, right: this.x + hw, top: this.y - hh, bottom: this.y + hh };
  }
}
