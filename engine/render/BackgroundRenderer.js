// Parallax particle background. Game-agnostic: the layer set (colors, parallax,
// density, drift) is passed in by the game; a neutral default is used otherwise.

const DEFAULT_LAYERS = [
  { parallax: 0.15, tileSize: 512, count: 40, sizeMin: 1.0, sizeMax: 3.0, color: '120,130,150', opacityMin: 0.10, opacityMax: 0.25, driftSpeed: 0.5, pulseSpeed: 0.0008 },
  { parallax: 0.40, tileSize: 512, count: 30, sizeMin: 1.5, sizeMax: 4.0, color: '150,160,180', opacityMin: 0.12, opacityMax: 0.28, driftSpeed: 1.0, pulseSpeed: 0.0012 },
  { parallax: 0.70, tileSize: 512, count: 20, sizeMin: 2.0, sizeMax: 5.0, color: '180,190,210', opacityMin: 0.15, opacityMax: 0.35, driftSpeed: 1.5, pulseSpeed: 0.0015 },
];

export class BackgroundRenderer {
  /**
   * @param {object} camera - has { x, y } and optional getZoom()
   * @param {HTMLCanvasElement} canvas
   * @param {Array} [layers] - parallax layer configs (see DEFAULT_LAYERS for shape)
   */
  constructor(camera, canvas, layers) {
    this.camera = camera;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layers = layers || DEFAULT_LAYERS;
  }

  draw(now) {
    for (let i = 0; i < this.layers.length; i++) {
      this._drawLayer(this.layers[i], i, now);
    }
  }

  _drawLayer(layer, layerIndex, now) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const ts = layer.tileSize;
    const zoom = this.camera.getZoom?.() ?? 1;
    const cx = w / 2;
    const cy = h / 2;

    const camX = this.camera.x * layer.parallax;
    const camY = this.camera.y * layer.parallax;

    // Continuous vertical drift — wraps at exactly one tile so the seam is invisible
    const tilePeriodMs = ts / layer.driftSpeed * 1000;
    const driftY = -(layer.driftSpeed * ((now % tilePeriodMs) / 1000));

    // Expand the sampled world span by 1/zoom so tiles still cover the screen
    // when zoomed out (particles compress toward center at zoom < 1).
    const halfW = (w / 2) / zoom;
    const halfH = (h / 2) / zoom;
    const worldLeft = camX - halfW;
    const worldTop = camY - halfH;
    const worldRight = camX + halfW;
    const worldBottom = camY + halfH;

    const tileMinX = Math.floor(worldLeft / ts) - 1;
    const tileMaxX = Math.floor(worldRight / ts) + 1;
    const tileMinY = Math.floor(worldTop / ts) - 1;
    const tileMaxY = Math.floor(worldBottom / ts) + 1;

    ctx.save();
    ctx.fillStyle = `rgb(${layer.color})`;

    for (let tx = tileMinX; tx <= tileMaxX; tx++) {
      for (let ty = tileMinY; ty <= tileMaxY; ty++) {
        const particles = this._generateTileParticles(tx, ty, layerIndex, layer);

        for (let p = 0; p < particles.length; p++) {
          const pt = particles[p];
          // Screen position about viewport center, then scaled about the center
          // by zoom so the background tracks the zoomable world. zoom=1 is a no-op.
          const baseX = tx * ts + pt.lx - camX + cx;
          const baseY = ty * ts + pt.ly + driftY - camY + cy;
          const sx = cx + (baseX - cx) * zoom;
          const sy = cy + (baseY - cy) * zoom;
          const size = pt.size * zoom;
          if (sx < -10 || sx > w + 10 || sy < -10 || sy > h + 10) continue;

          const pulse = 0.7 + 0.3 * Math.sin(now * layer.pulseSpeed + pt.phase);
          ctx.globalAlpha = pt.opacity * pulse;

          if (size < 2) {
            ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
          } else {
            ctx.beginPath();
            ctx.arc(sx, sy, size / 2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }

    ctx.restore();
  }

  _generateTileParticles(tx, ty, layerIndex, layer) {
    const rng = this._seedRng(tx, ty, layerIndex);
    const particles = [];
    for (let i = 0; i < layer.count; i++) {
      particles.push({
        lx: rng() * layer.tileSize,
        ly: rng() * layer.tileSize,
        size: layer.sizeMin + rng() * (layer.sizeMax - layer.sizeMin),
        opacity: layer.opacityMin + rng() * (layer.opacityMax - layer.opacityMin),
        phase: rng() * Math.PI * 2,
      });
    }
    return particles;
  }

  _seedRng(tx, ty, layerIndex) {
    let seed = (tx * 374761393 + ty * 668265263 + layerIndex * 2147483647) | 0;
    return () => {
      seed += 0x9e3779b9;
      let z = seed;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      z = (z ^ (z >>> 16)) >>> 0;
      return z / 4294967296;
    };
  }
}
