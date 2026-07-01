// Canvas + camera + resizer infrastructure for editor preview panels.
// PreviewCanvas: a pannable/zoomable 2D canvas with grid + world/screen transforms.
// EditorPreviewCamera: a minimal camera (used by sequences/vfx editors).
// createResizer: a draggable divider between flex siblings.
// Self-contained (browser DOM / ResizeObserver only).

// ─── PreviewCanvas ─────────────────────────────────────────────────────────

export class PreviewCanvas {
  constructor(container, options = {}) {
    const {
      width = 400, height = 300,
      background = '#060d18',
      grid = false,
      pannable = true,
      zoomable = true,
      fillContainer = false,
    } = options;

    this._bg = background;
    this._showGrid = grid;
    this._pannable = pannable;
    this._zoomable = zoomable;
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
    this._dragging = false;
    this._lastMouse = null;
    this._onPanCbs = [];
    this._onZoomCbs = [];
    this._resizeObserver = null;

    this._canvas = document.createElement('canvas');
    this._canvas.className = 'editor-preview-canvas';
    this._ctx = this._canvas.getContext('2d');

    if (fillContainer) {
      this._canvas.style.cssText = 'width:100%;height:100%;display:block;';
      const resize = () => {
        const rect = container.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          this._canvas.width = rect.width;
          this._canvas.height = rect.height;
        }
      };
      resize();
      this._resizeObserver = new ResizeObserver(resize);
      this._resizeObserver.observe(container);
    } else {
      this._canvas.width = width;
      this._canvas.height = height;
    }

    if (pannable) {
      this._canvas.addEventListener('mousedown', (e) => {
        if (e.button === 1 || e.shiftKey) {
          this._dragging = true;
          this._lastMouse = { x: e.clientX, y: e.clientY };
          e.preventDefault();
        }
      });
      this._canvas.addEventListener('mousemove', (e) => {
        if (!this._dragging) return;
        const dx = e.clientX - this._lastMouse.x;
        const dy = e.clientY - this._lastMouse.y;
        this._panX += dx;
        this._panY += dy;
        this._lastMouse = { x: e.clientX, y: e.clientY };
        this._onPanCbs.forEach(fn => fn(this._panX, this._panY));
      });
      const stopDrag = () => { this._dragging = false; };
      this._canvas.addEventListener('mouseup', stopDrag);
      this._canvas.addEventListener('mouseleave', stopDrag);
    }

    if (zoomable) {
      this._canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        this._zoom = Math.max(0.1, Math.min(20, this._zoom * delta));
        this._onZoomCbs.forEach(fn => fn(this._zoom));
      }, { passive: false });
    }

    container.appendChild(this._canvas);
  }

  get canvas() { return this._canvas; }
  getCtx() { return this._ctx; }
  getZoom() { return this._zoom; }
  getPan() { return { x: this._panX, y: this._panY }; }

  setSize(w, h) {
    this._canvas.width = w;
    this._canvas.height = h;
  }

  clear() {
    const { width, height } = this._canvas;
    this._ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._ctx.fillStyle = this._bg;
    this._ctx.fillRect(0, 0, width, height);
  }

  applyTransform() {
    const { width, height } = this._canvas;
    this._ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._ctx.translate(width / 2 + this._panX, height / 2 + this._panY);
    this._ctx.scale(this._zoom, this._zoom);
  }

  drawGrid(step = 10, color = 'rgba(212,160,86,0.08)') {
    if (!this._showGrid) return;
    const ctx = this._ctx;
    const { width, height } = this._canvas;
    const scaledStep = step * this._zoom;
    if (scaledStep < 4) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    const ox = (width / 2 + this._panX) % scaledStep;
    const oy = (height / 2 + this._panY) % scaledStep;
    for (let x = ox; x < width; x += scaledStep) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = oy; y < height; y += scaledStep) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    // Draw axes
    ctx.strokeStyle = 'rgba(212,160,86,0.2)';
    ctx.lineWidth = 1;
    const cx = width / 2 + this._panX;
    const cy = height / 2 + this._panY;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(width, cy); ctx.stroke();
    ctx.restore();
  }

  worldToScreen(x, y) {
    const { width, height } = this._canvas;
    return {
      x: width / 2 + this._panX + x * this._zoom,
      y: height / 2 + this._panY + y * this._zoom,
    };
  }

  screenToWorld(sx, sy) {
    const { width, height } = this._canvas;
    return {
      x: (sx - width / 2 - this._panX) / this._zoom,
      y: (sy - height / 2 - this._panY) / this._zoom,
    };
  }

  resetView() {
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
  }

  setZoom(z) { this._zoom = Math.max(0.1, Math.min(20, z)); }
  setGrid(show) { this._showGrid = show; }

  onPan(fn) { this._onPanCbs.push(fn); }
  onZoom(fn) { this._onZoomCbs.push(fn); }

  destroy() {
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this._canvas.remove();
  }
}

// ─── Resizer ────────────────────────────────────────────────────────────────
// Draggable divider between flex siblings, like VS Code split panes.
// direction: 'horizontal' (col-resize, adjusts width) or 'vertical' (row-resize, adjusts height/flex-basis)
// targetEl: the element whose size to adjust (the one BEFORE the resizer)
// options: { min, max, prop, invert } — min/max in px, prop = 'width'|'flexBasis'|'height',
// invert = true for panels AFTER the resizer (dragging left = grow)

export function createResizer(direction, targetEl, options = {}) {
  const isHorizontal = direction === 'horizontal';
  const {
    min = 80,
    max = 800,
    prop = isHorizontal ? 'width' : 'flexBasis',
    invert = false,
    onResize,
  } = options;

  const el = document.createElement('div');
  el.className = `editor-resizer editor-resizer-${direction}`;

  let startPos = 0;
  let startSize = 0;
  let dragging = false;

  function getSize() {
    return isHorizontal ? targetEl.getBoundingClientRect().width : targetEl.getBoundingClientRect().height;
  }

  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startPos = isHorizontal ? e.clientX : e.clientY;
    startSize = getSize();
    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    el.classList.add('active');
  });

  function onMouseMove(e) {
    if (!dragging) return;
    const raw = (isHorizontal ? e.clientX : e.clientY) - startPos;
    const delta = invert ? -raw : raw;
    const newSize = Math.max(min, Math.min(max, startSize + delta));
    targetEl.style[prop] = newSize + 'px';
    if (prop === 'flexBasis') {
      targetEl.style.flexGrow = '0';
      targetEl.style.flexShrink = '0';
    }
    if (onResize) onResize(newSize);
  }

  function onMouseUp() {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    el.classList.remove('active');
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  return {
    el,
    destroy: () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      el.remove();
    },
  };
}

// ─── PreviewCamera ──────────────────────────────────────────────────────────
// Minimal camera for editor previews. Centers the world at the canvas midpoint,
// optionally applies zoom. Used by sequencesEditor and vfxEditor.

export class EditorPreviewCamera {
  constructor(canvas) {
    this._canvas = canvas;
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
  }

  setZoom(z) { this._zoom = z; }
  getZoom() { return this._zoom; }
  setPan(x, y) { this._panX = x; this._panY = y; }
  getPan() { return { x: this._panX, y: this._panY }; }

  resetView() { this._zoom = 1; this._panX = 0; this._panY = 0; }

  worldToScreen(x, y) {
    return {
      sx: this._canvas.width / 2 + this._panX + x * this._zoom,
      sy: this._canvas.height / 2 + this._panY + y * this._zoom,
    };
  }

  worldToScreenWrapped(x, y) { return this.worldToScreen(x, y); }

  getVisibleBounds() {
    const hw = this._canvas.width / (2 * this._zoom);
    const hh = this._canvas.height / (2 * this._zoom);
    const cx = -this._panX / this._zoom;
    const cy = -this._panY / this._zoom;
    return { left: cx - hw, right: cx + hw, top: cy - hh, bottom: cy + hh };
  }

  /** Attach pan (middle/shift+drag) and zoom (wheel) handlers to a canvas element. */
  attachControls(canvasEl) {
    let dragging = false;
    let lastMouse = null;

    canvasEl.addEventListener('mousedown', (e) => {
      if (e.button === 1 || e.shiftKey) {
        dragging = true;
        lastMouse = { x: e.clientX, y: e.clientY };
        e.preventDefault();
      }
    });
    canvasEl.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      this._panX += e.clientX - lastMouse.x;
      this._panY += e.clientY - lastMouse.y;
      lastMouse = { x: e.clientX, y: e.clientY };
    });
    const stopDrag = () => { dragging = false; };
    canvasEl.addEventListener('mouseup', stopDrag);
    canvasEl.addEventListener('mouseleave', stopDrag);

    canvasEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      this._zoom = Math.max(0.1, Math.min(20, this._zoom * delta));
    }, { passive: false });
  }
}
