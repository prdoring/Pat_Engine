// Preview rendering and controls for the art editor.
// Handles the preview canvas, shape highlighting, and control bar.

import { drawUnifiedArt, setEffectResolver } from '/engine/render/ArtInterpreter.js';
import { VFX_DEFS } from '/engine/data/vfx.js';
import { ctx, getShapeAtPath, CONTAINER_TYPES, editValueAt, commitShapeEdit } from './artEditorCtx.js';

// Let `effectRef` shapes resolve to VFX effects by id in the preview.
setEffectResolver((id) => VFX_DEFS[id]);
import { Select, NumberSlider, Toggle, Button } from './editorShared.js';
import { getManifest } from './editorManifest.js';
import { addCoordDelta, addPointDelta } from './artCoordModel.js';

// ─── Render Loop ───────────────────────────────────────────────────────────────
// The preview repaints EVERY frame for as long as the editor is mounted, regardless
// of the transport. This is deliberate and load-bearing: "playing" controls only
// whether animation TIME advances; painting the current state is unconditional. That
// way the preview is always a faithful, live reflection of editor state — zoom, pan,
// undo/redo, edits, selection, state switches — WITHOUT every mutation site having to
// remember to call renderPreview(). Do NOT gate rendering on ctx.animPlaying, and do
// NOT scatter one-shot renderPreview() calls after mutations to "make changes show":
// that is the push-based, hand-maintained-trigger-list model that caused a long tail
// of "the preview is stale until I move/play" bugs. The loop is the single source of
// truth for what's on screen.

export function startRenderLoop() {
  if (ctx.renderLoopFrame) return;          // idempotent — never stack loops
  let last = performance.now();
  const tick = () => {
    const t = performance.now();
    const dt = t - last; last = t;
    ctx.animNow = t;
    // Advance the keyframe playhead (loop / hold-at-end) ONLY while the transport is
    // playing and no handle drag has frozen time. Painting still happens below either
    // way, so a paused preview stays live for everything except time itself.
    if (ctx.animPlaying && ctx.frozenNow == null && ctx.timeline) ctx.timeline.advance(dt);
    renderPreview();
    // While playing, the playhead advances every frame, so the props-panel values are
    // stale unless we re-read them. Sync them here (throttled) so the numbers animate
    // with the preview instead of freezing until pause. (Scrub-while-paused is synced
    // by the timeline's refreshPropsForScrub.)
    if (ctx.animPlaying && ctx.frozenNow == null) syncPlaybackProps(t);
    ctx.renderLoopFrame = requestAnimationFrame(tick);
  };
  ctx.renderLoopFrame = requestAnimationFrame(tick);
}

// Re-read the props panel's displayed values from the animating shape while playing.
// A full rebuild is fine at this cadence and reuses the proxy's playhead sampling;
// throttled to stay cheap, skipped when a props field is focused (don't nuke an edit)
// and scroll is preserved so the panel doesn't jump.
let _lastPlaybackPropsSync = 0;
function syncPlaybackProps(now) {
  if (!ctx.selectedShapePath) return;
  if (now - _lastPlaybackPropsSync < 66) return;   // ~15 Hz — visibly live, cheap
  if (ctx.propsEl && ctx.propsEl.contains(document.activeElement)) return;
  _lastPlaybackPropsSync = now;
  const scroll = ctx.propsEl ? ctx.propsEl.scrollTop : 0;
  ctx.rebuildProps?.();
  if (ctx.propsEl) ctx.propsEl.scrollTop = scroll;
}

export function stopRenderLoop() {
  if (ctx.renderLoopFrame) cancelAnimationFrame(ctx.renderLoopFrame);
  ctx.renderLoopFrame = null;
}

// ─── Transport ─────────────────────────────────────────────────────────────────
// Play/pause toggles ONLY whether animation time advances. Rendering is owned by the
// always-on render loop above, so these must not touch the rAF.

export function startAnimation() { ctx.animPlaying = true; }
export function stopAnimation() { ctx.animPlaying = false; }

// ─── Preview Controls ────────────────────────────────────────────────────────

/** Build the preview control bar (play/pause, color, radius, grid, zoom). */
export function buildControls() {
  ctx.controlsEl.innerHTML = '';

  if (!ctx.currentArt) return;

  if (ctx.currentArt) {
    const playBtn = Button(ctx.animPlaying ? 'Pause' : 'Play', () => {
      if (ctx.animPlaying) stopAnimation(); else startAnimation();
      buildControls();
    }, 'subtle');
    ctx.controlsEl.appendChild(playBtn.el);
  }

  // Color swatches: derived from the manifest's preview entities, with neutral
  // fallbacks when no entity colors are declared (game-agnostic).
  const swatchSeen = new Set();
  const colorOptions = [];
  for (const e of (getManifest()?.previewEntities || [])) {
    if (!e.color || swatchSeen.has(e.color)) continue;
    swatchSeen.add(e.color);
    colorOptions.push({ value: e.color, label: e.label || e.id });
  }
  if (colorOptions.length === 0) {
    colorOptions.push(
      { value: '#d4a056', label: 'Amber' },
      { value: '#7c9cc6', label: 'Blue' },
      { value: '#7cc6a0', label: 'Green' },
      { value: '#cccccc', label: 'Gray' },
    );
  }
  // Keep the dropdown in sync with the active preview color.
  if (!colorOptions.some(o => o.value === ctx.previewColor)) {
    ctx.previewColor = colorOptions[0].value;
  }
  const colorSel = Select('Color', colorOptions, ctx.previewColor, v => { ctx.previewColor = v; });
  ctx.controlsEl.appendChild(colorSel.el);

  const radiusSl = NumberSlider('Radius', 3, 200, 1, ctx.previewRadius, v => { ctx.previewRadius = v; });
  radiusSl.el.style.maxWidth = '200px';
  ctx.controlsEl.appendChild(radiusSl.el);

  const gridToggle = Toggle('Grid', ctx.showGrid, v => {
    ctx.showGrid = v;
    ctx.preview.setGrid(v);
  });
  ctx.controlsEl.appendChild(gridToggle.el);

  const resetBtn = Button('Reset View', () => {
    ctx.preview.resetView();
    ctx.preview.setZoom(1);
  }, 'subtle');
  ctx.controlsEl.appendChild(resetBtn.el);

  const fitBtn = Button('Fit', () => {
    const r = ctx.previewRadius;
    const w = ctx.currentArt.space ? r * (ctx.currentArt.space.widthFactor || 1) : r;
    const h = ctx.currentArt.space ? r * (ctx.currentArt.space.heightFactor || 1) : r;
    const b = getAssetBounds({ r, w, h });
    ctx.preview.resetView();
    if (b && b.w > 0 && b.h > 0) {
      const cw = ctx.preview.canvas.clientWidth || ctx.preview.canvas.width;
      const ch = ctx.preview.canvas.clientHeight || ctx.preview.canvas.height;
      const fit = Math.min(cw / b.w, ch / b.h) * 0.8;
      ctx.preview.setZoom(Math.max(0.2, Math.min(20, fit)));
    } else {
      ctx.preview.setZoom(1);
    }
  }, 'subtle');
  fitBtn.el.title = 'Fit the asset to the viewport';
  ctx.controlsEl.appendChild(fitBtn.el);

  const snapToggle = Toggle('Snap', !!ctx.snapGrid, v => { ctx.snapGrid = v; });
  ctx.controlsEl.appendChild(snapToggle.el);

  addControlLabel(`Zoom: ${ctx.preview.getZoom().toFixed(1)}x`);
  ctx.preview.onZoom(() => {
    const zoomLabel = ctx.controlsEl.querySelector('.zoom-label');
    if (zoomLabel) zoomLabel.textContent = `Zoom: ${ctx.preview.getZoom().toFixed(1)}x`;
  });
}

function addControlLabel(text) {
  const lbl = document.createElement('span');
  lbl.className = 'zoom-label';
  lbl.style.cssText = 'color:#7a6a4a;font-size:11px;';
  lbl.textContent = text;
  ctx.controlsEl.appendChild(lbl);
}

// ─── Preview Rendering ───────────────────────────────────────────────────────

/** Main preview render loop — called each animation frame. */
export function renderPreview() {
  if (!ctx.preview) return;
  ctx.preview.clear();
  ctx.preview.drawGrid(ctx.previewRadius);
  ctx.preview.applyTransform();

  const canvasCtx = ctx.preview.getCtx();

  if (ctx.currentArt && ctx.currentArt.shapes) {
    canvasCtx.save();
    const restoreVis = applyEditorVisibility(ctx.currentArt);
    // While a handle/drag is active, freeze time so animated shapes stop moving
    // under the cursor (otherwise the thing you're grabbing oscillates away).
    const now = ctx.frozenNow != null ? ctx.frozenNow : (ctx.animPlaying ? ctx.animNow : 0);
    // Pin the key-target keyframe clip to the timeline playhead so the preview shows
    // exactly the scrubbed frame; other composited clips free-run on `now`.
    const kc = ctx.keyTargetClip;
    ctx.previewTransition.animTime = (kc && ctx.currentArt.animations && ctx.currentArt.animations[kc])
      ? { [kc]: ctx.playhead || 0 } : null;
    try {
      drawUnifiedArt(canvasCtx, ctx.previewRadius, ctx.previewColor, ctx.currentArt, ctx.previewState, now, ctx.previewTransition);
    } finally {
      if (restoreVis) restoreVis();
    }
    canvasCtx.restore();

    const r = ctx.previewRadius;
    const w = ctx.currentArt.space ? r * (ctx.currentArt.space.widthFactor || 1) : r;
    const h = ctx.currentArt.space ? r * (ctx.currentArt.space.heightFactor || 1) : r;
    const dc = { r, w, h };

    if (ctx.hoveredShapePath && ctx.hoveredShapePath.length > 0) {
      const shape = getShapeAtPath(ctx.currentArt.shapes, ctx.hoveredShapePath);
      if (shape) drawShapeHighlight(canvasCtx, dc, shape, 'hover');
    }
    if (ctx.selectedShapePath && ctx.selectedShapePath.length > 0) {
      const shape = getShapeAtPath(ctx.currentArt.shapes, ctx.selectedShapePath);
      if (shape) drawShapeHighlight(canvasCtx, dc, shape, 'selected');
    }
  }

  canvasCtx.setTransform(1, 0, 0, 1, 0, 0);
  canvasCtx.globalAlpha = 1;
  canvasCtx.shadowBlur = 0;
}

const EDITOR_HIDDEN_STATE = '__editorHidden__';

/**
 * Apply editor-only hide / solo to the art for one draw by temporarily setting
 * the affected shapes' `visibleStates` to a state that is never active, then
 * restoring them. Keeps the interpreter untouched (no editor concept leaks into
 * the engine) and never mutates persisted data. Returns a restore fn, or null.
 */
function applyEditorVisibility(art) {
  const hidden = ctx.editorHidden;
  const solo = ctx.editorSolo;
  if ((!hidden || !hidden.size) && !solo) return null;

  const saved = [];
  const hideShape = (shape) => {
    saved.push([shape, Object.prototype.hasOwnProperty.call(shape, 'visibleStates') ? shape.visibleStates : undefined]);
    shape.visibleStates = [EDITOR_HIDDEN_STATE];
  };
  const walk = (shapes, base) => {
    shapes.forEach((shape, i) => {
      const key = [...base, i].join(',');
      let hide = hidden && hidden.has(key);
      if (solo) {
        const onBranch = key === solo || key.startsWith(solo + ',') || solo.startsWith(key + ',');
        if (!onBranch) hide = true;
      }
      if (hide) { hideShape(shape); return; } // whole subtree goes with it
      const children = shape.shapes || shape.children;
      if (children) walk(children, [...base, i]);
    });
  };
  walk(art.shapes, []);

  return () => {
    for (const [shape, orig] of saved) {
      if (orig === undefined) delete shape.visibleStates;
      else shape.visibleStates = orig;
    }
  };
}

// ─── Shape Bounds & Highlighting ─────────────────────────────────────────────

function resolveCoordSimple(val, dc) {
  if (typeof val === 'number') return val * dc.r;
  if (typeof val === 'string') return 0;
  if (typeof val === 'object' && val !== null) {
    let result = 0;
    for (const [k, v] of Object.entries(val)) {
      if (k === 'r') result += v * dc.r;
      else if (k === 'w') result += v * dc.w;
      else if (k === 'h') result += v * dc.h;
    }
    return result;
  }
  return 0;
}

function resolvePointSimple(pt, dc) {
  if (Array.isArray(pt)) return [resolveCoordSimple(pt[0], dc), resolveCoordSimple(pt[1], dc)];
  if (typeof pt === 'object' && pt !== null) return [resolveCoordSimple(pt.x, dc), resolveCoordSimple(pt.y, dc)];
  return [0, 0];
}

/**
 * Return a shallow view of shape with the current edit state's overrides applied.
 * Mirrors what ArtInterpreter.applyStateOverrides does so bounds/translate see the
 * same data that the preview renders.
 */
function effectiveShape(shape) {
  const state = ctx.currentEditState === 'BASE' ? ctx.previewState : ctx.currentEditState;
  if (!state) return shape;
  const overridesMap = shape.states || shape.stateOverrides;
  if (!overridesMap || !overridesMap[state]) return shape;
  return { ...shape, ...overridesMap[state] };
}

function getShapeBounds(rawShape, dc) {
  const shape = effectiveShape(rawShape);
  switch (shape.type) {
    case 'circle': {
      const cx = resolveCoordSimple(shape.cx, dc);
      const cy = resolveCoordSimple(shape.cy, dc);
      const rad = shape.radiusAbs !== undefined ? shape.radiusAbs : (shape.radius || 0.1) * dc.r;
      return { x: cx - rad, y: cy - rad, w: rad * 2, h: rad * 2 };
    }
    case 'path': {
      if (!shape.points || shape.points.length === 0) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pt of shape.points) {
        const [px, py] = resolvePointSimple(pt, dc);
        minX = Math.min(minX, px); minY = Math.min(minY, py);
        maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    case 'bezierPath': {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      if (shape.start) {
        const [sx, sy] = resolvePointSimple(shape.start, dc);
        minX = Math.min(minX, sx); minY = Math.min(minY, sy);
        maxX = Math.max(maxX, sx); maxY = Math.max(maxY, sy);
      }
      if (shape.curves) {
        for (const c of shape.curves) {
          for (const key of ['cp1', 'cp2', 'to']) {
            if (c[key]) {
              const [px, py] = resolvePointSimple(c[key], dc);
              minX = Math.min(minX, px); minY = Math.min(minY, py);
              maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
            }
          }
        }
      }
      if (minX === Infinity) return null;
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    case 'quadPath': {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      if (shape.start) {
        const [sx, sy] = resolvePointSimple(shape.start, dc);
        minX = Math.min(minX, sx); minY = Math.min(minY, sy);
        maxX = Math.max(maxX, sx); maxY = Math.max(maxY, sy);
      }
      if (shape.curves) {
        for (const c of shape.curves) {
          for (const key of ['cp', 'to']) {
            if (c[key]) {
              const [px, py] = resolvePointSimple(c[key], dc);
              minX = Math.min(minX, px); minY = Math.min(minY, py);
              maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
            }
          }
        }
      }
      if (minX === Infinity) return null;
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    case 'lines': {
      if (!shape.segments || shape.segments.length === 0) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const seg of shape.segments) {
        for (const pt of seg) {
          const [px, py] = resolvePointSimple(pt, dc);
          minX = Math.min(minX, px); minY = Math.min(minY, py);
          maxX = Math.max(maxX, px); maxY = Math.max(maxY, py);
        }
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    case 'arc': {
      const cx = resolveCoordSimple(shape.cx, dc);
      const cy = resolveCoordSimple(shape.cy, dc);
      const rad = (shape.radius || 0.5) * dc.r;
      return { x: cx - rad, y: cy - rad, w: rad * 2, h: rad * 2 };
    }
    case 'rect': case 'strokeRect': {
      const rx = resolveCoordSimple(shape.x, dc);
      const ry = resolveCoordSimple(shape.y, dc);
      const rw = resolveCoordSimple(shape.w, dc);
      const rh = resolveCoordSimple(shape.h, dc);
      return { x: rx, y: ry, w: rw, h: rh };
    }
    case 'roundedRect': {
      const rx = resolveCoordSimple(shape.x, dc);
      const ry = resolveCoordSimple(shape.y, dc);
      const rw = resolveCoordSimple(shape.width, dc);
      const rh = resolveCoordSimple(shape.height, dc);
      return { x: rx, y: ry, w: rw, h: rh };
    }
    case 'boltCluster': {
      const cx = resolveCoordSimple(shape.cx, dc);
      const cy = resolveCoordSimple(shape.cy, dc);
      const s = (shape.spacing || 0.1) * dc.r;
      return { x: cx - s - 1, y: cy - s - 1, w: (s + 1) * 2, h: (s + 1) * 2 };
    }
    default: {
      if (shape.shapes && shape.shapes.length > 0) {
        // Container offset — groups/spinners/etc translate children by cx/cy
        const ox = shape.cx !== undefined ? resolveCoordSimple(shape.cx, dc) : 0;
        const oy = shape.cy !== undefined ? resolveCoordSimple(shape.cy, dc) : 0;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const child of shape.shapes) {
          const cb = getShapeBounds(child, dc);
          if (cb) {
            minX = Math.min(minX, cb.x + ox); minY = Math.min(minY, cb.y + oy);
            maxX = Math.max(maxX, cb.x + cb.w + ox); maxY = Math.max(maxY, cb.y + cb.h + oy);
          }
        }
        if (minX !== Infinity) return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      }
      if (shape.emitters && shape.emitters.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const em of shape.emitters) {
          const ex = resolveCoordSimple(em.cx, dc);
          const ey = resolveCoordSimple(em.cy, dc);
          const sx = em.spread !== undefined ? em.spread * dc.r : (em.spreadX || 0.5) * dc.r;
          const sy = em.spread !== undefined ? em.spread * dc.r : (em.spreadY || 0.5) * dc.r;
          minX = Math.min(minX, ex - sx); minY = Math.min(minY, ey - sy);
          maxX = Math.max(maxX, ex + sx); maxY = Math.max(maxY, ey + sy);
        }
        if (minX !== Infinity) return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      }
      return null;
    }
  }
}

/**
 * Get the anchor point of a shape — where it lives in parent space.
 * For shapes with cx/cy this is that point; for others it's the bounds center.
 * Returns pixel coordinates (already multiplied by r).
 */
function getShapeAnchor(rawShape, dc) {
  const shape = effectiveShape(rawShape);
  switch (shape.type) {
    case 'circle': case 'arc': case 'boltCluster':
      return { x: resolveCoordSimple(shape.cx, dc), y: resolveCoordSimple(shape.cy, dc) };
    case 'rect': case 'strokeRect': {
      const rx = resolveCoordSimple(shape.x, dc);
      const ry = resolveCoordSimple(shape.y, dc);
      const rw = resolveCoordSimple(shape.w, dc);
      const rh = resolveCoordSimple(shape.h, dc);
      return { x: rx + rw / 2, y: ry + rh / 2 };
    }
    case 'roundedRect': {
      const rx = resolveCoordSimple(shape.x, dc);
      const ry = resolveCoordSimple(shape.y, dc);
      const rw = resolveCoordSimple(shape.width, dc);
      const rh = resolveCoordSimple(shape.height, dc);
      return { x: rx + rw / 2, y: ry + rh / 2 };
    }
    default: {
      // Containers (group, radialRepeat, etc.) use cx/cy as their origin
      if (shape.cx !== undefined || shape.cy !== undefined) {
        return {
          x: resolveCoordSimple(shape.cx ?? 0, dc),
          y: resolveCoordSimple(shape.cy ?? 0, dc),
        };
      }
      // Fall back to bounds center
      const bounds = getShapeBounds(rawShape, dc);
      if (bounds) return { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
      return { x: 0, y: 0 };
    }
  }
}

/** Get the local-space bounding radius of a shape from its anchor. */
function getShapeExtent(shape, dc) {
  const anchor = getShapeAnchor(shape, dc);
  const bounds = getShapeBounds(shape, dc);
  if (!bounds) return dc.r * 0.5;
  // Max distance from anchor to any corner of bounds
  const corners = [
    [bounds.x, bounds.y],
    [bounds.x + bounds.w, bounds.y],
    [bounds.x, bounds.y + bounds.h],
    [bounds.x + bounds.w, bounds.y + bounds.h],
  ];
  let maxD = 0;
  for (const [cx, cy] of corners) {
    maxD = Math.max(maxD, Math.hypot(cx - anchor.x, cy - anchor.y));
  }
  return maxD;
}

/** Get the rotation value of a shape (only groups have rotation). */
function getShapeRotation(shape) {
  if (shape.rotation !== undefined) {
    return typeof shape.rotation === 'number' ? shape.rotation : 0;
  }
  return 0;
}

/**
 * Compute the handle geometry for a selected shape.
 * All values in world-pixel coords (same space as screenToWorld).
 */
function getHandleGeometry(shape, dc) {
  const anchor = getShapeAnchor(shape, dc);
  const extent = getShapeExtent(shape, dc);
  const z = ctx.preview.getZoom();

  // Ring radius: enough to clear the shape + 12 screen-px padding
  const ringR = extent + 12 / z;
  const handleR = 5 / z;
  const rot = getShapeRotation(shape);

  return { anchor, ringR, handleR, rot };
}

/** Editable vertices / control-points of a shape, in world coords, tagged with the
 *  keyframeable propPath (`points.2`, `segments.0.1`, `curves.1.cp`) so a drag can
 *  route through commitShapeEdit. `get` reads the raw point (for handle drawing). */
function getEditablePoints(shape, dc) {
  const pts = [];
  const add = (container, key, path) => {
    if (container[key] == null) return;
    const [wx, wy] = resolvePointSimple(container[key], dc);
    pts.push({ wx, wy, path, get: () => container[key] });
  };
  if (shape.type === 'path' && shape.points) shape.points.forEach((_, i) => add(shape.points, i, `points.${i}`));
  else if (shape.type === 'lines' && shape.segments) shape.segments.forEach((seg, s) => seg.forEach((_, i) => add(seg, i, `segments.${s}.${i}`)));
  else if (shape.type === 'bezierPath') { if (shape.start) add(shape, 'start', 'start'); (shape.curves || []).forEach((c, ci) => ['cp1', 'cp2', 'to'].forEach(k => c[k] && add(c, k, `curves.${ci}.${k}`))); }
  else if (shape.type === 'quadPath') { if (shape.start) add(shape, 'start', 'start'); (shape.curves || []).forEach((c, ci) => ['cp', 'to'].forEach(k => c[k] && add(c, k, `curves.${ci}.${k}`))); }
  return pts;
}

/** The drag handle for a circle's radius (world coords), or null. */
function getRadiusHandle(shape, dc) {
  if (shape.type !== 'circle') return null;
  const cx = resolveCoordSimple(shape.cx, dc);
  const cy = resolveCoordSimple(shape.cy, dc);
  const rad = shape.radiusAbs !== undefined
    ? (typeof shape.radiusAbs === 'object' ? (shape.radiusAbs.base || 0) : shape.radiusAbs)
    : (shape.radius || 0.1) * dc.r;
  return { x: cx + rad, y: cy, cx, cy };
}

function drawShapeHighlight(canvasCtx, dc, shape, style) {
  const bounds = getShapeBounds(shape, dc);
  if (!bounds) return;

  const z = ctx.preview.getZoom();
  const pad = 4 / z;

  // Draw bounding box — for rotated shapes, draw rotated around anchor
  const rot = getShapeRotation(shape);
  const anchor = getShapeAnchor(shape, dc);

  canvasCtx.save();
  canvasCtx.strokeStyle = style === 'selected' ? '#33ddcc' : '#33ddcc88';
  canvasCtx.lineWidth = (style === 'selected' ? 1.5 : 1) / z;
  canvasCtx.globalAlpha = style === 'selected' ? 0.8 : 0.5;
  canvasCtx.shadowBlur = 0;
  if (style === 'hover') {
    canvasCtx.setLineDash([3 / z, 3 / z]);
  }

  if (rot) {
    canvasCtx.translate(anchor.x, anchor.y);
    canvasCtx.rotate(rot);
    canvasCtx.strokeRect(
      bounds.x - anchor.x - pad, bounds.y - anchor.y - pad,
      bounds.w + pad * 2, bounds.h + pad * 2
    );
  } else {
    canvasCtx.strokeRect(bounds.x - pad, bounds.y - pad, bounds.w + pad * 2, bounds.h + pad * 2);
  }
  canvasCtx.restore();

  // Draw position handle + rotation ring for selected shapes only
  if (style !== 'selected') return;

  const hg = getHandleGeometry(shape, dc);

  // Rotation ring
  canvasCtx.save();
  canvasCtx.strokeStyle = 'rgba(51,221,204,0.4)';
  canvasCtx.lineWidth = 2 / z;
  canvasCtx.setLineDash([4 / z, 4 / z]);
  canvasCtx.beginPath();
  canvasCtx.arc(hg.anchor.x, hg.anchor.y, hg.ringR, 0, Math.PI * 2);
  canvasCtx.stroke();
  canvasCtx.setLineDash([]);
  canvasCtx.restore();

  // Rotation handle on the ring
  const rhx = hg.anchor.x + Math.cos(hg.rot) * hg.ringR;
  const rhy = hg.anchor.y + Math.sin(hg.rot) * hg.ringR;
  canvasCtx.save();
  canvasCtx.beginPath();
  canvasCtx.arc(rhx, rhy, hg.handleR, 0, Math.PI * 2);
  canvasCtx.fillStyle = '#ffcc44';
  canvasCtx.globalAlpha = 0.9;
  canvasCtx.fill();
  canvasCtx.strokeStyle = '#fff';
  canvasCtx.lineWidth = 1 / z;
  canvasCtx.stroke();
  canvasCtx.restore();

  // Position handle at anchor
  canvasCtx.save();
  canvasCtx.beginPath();
  canvasCtx.arc(hg.anchor.x, hg.anchor.y, hg.handleR, 0, Math.PI * 2);
  canvasCtx.fillStyle = '#33ddcc';
  canvasCtx.globalAlpha = 0.9;
  canvasCtx.fill();
  canvasCtx.strokeStyle = '#fff';
  canvasCtx.lineWidth = 1 / z;
  canvasCtx.stroke();
  canvasCtx.restore();

  // Vertex / control-point handles (path/lines/bezier/quad)
  for (const v of getEditablePoints(shape, dc)) {
    canvasCtx.save();
    canvasCtx.beginPath();
    canvasCtx.arc(v.wx, v.wy, hg.handleR * 0.85, 0, Math.PI * 2);
    canvasCtx.fillStyle = '#ffaa44';
    canvasCtx.globalAlpha = 0.9;
    canvasCtx.fill();
    canvasCtx.strokeStyle = '#fff';
    canvasCtx.lineWidth = 1 / z;
    canvasCtx.stroke();
    canvasCtx.restore();
  }

  // Radius handle (circle)
  const rh = getRadiusHandle(shape, dc);
  if (rh) {
    canvasCtx.save();
    canvasCtx.beginPath();
    canvasCtx.arc(rh.x, rh.y, hg.handleR, 0, Math.PI * 2);
    canvasCtx.fillStyle = '#aa88ff';
    canvasCtx.globalAlpha = 0.9;
    canvasCtx.fill();
    canvasCtx.strokeStyle = '#fff';
    canvasCtx.lineWidth = 1 / z;
    canvasCtx.stroke();
    canvasCtx.restore();
  }
}

/** Translate a shape's position by dx/dy in art-coordinate space (values / r). */
function translateShape(shape, dx, dy) {
  // Route every affected coordinate through commitShapeEdit so a move keyframes /
  // state-overrides / edits base per the current context (same rule as the props
  // panel). Read each coord's on-screen value (editValueAt) so the drag starts where
  // the shape actually is at the playhead; addCoordDelta/addPointDelta PRESERVE
  // object-valued coords ({ base, r, w, h, … }) instead of flattening to a number.
  const eff = effectiveShape(shape);
  const mv = (path, d) => commitShapeEdit(shape, path, addCoordDelta(editValueAt(shape, path) ?? 0, d));
  const mvPt = (path) => commitShapeEdit(shape, path, addPointDelta(editValueAt(shape, path), dx, dy));

  switch (shape.type) {
    case 'circle':
    case 'arc':
    case 'boltCluster':
      mv('cx', dx); mv('cy', dy); break;
    case 'rect': case 'strokeRect':
    case 'roundedRect':
      mv('x', dx); mv('y', dy); break;
    case 'path': {
      const pts = eff.points || [];
      for (let i = 0; i < pts.length; i++) mvPt(`points.${i}`);
      break;
    }
    case 'bezierPath': {
      if (eff.start) mvPt('start');
      (eff.curves || []).forEach((c, ci) => ['cp1', 'cp2', 'to'].forEach(k => { if (c[k]) mvPt(`curves.${ci}.${k}`); }));
      break;
    }
    case 'quadPath': {
      if (eff.start) mvPt('start');
      (eff.curves || []).forEach((c, ci) => ['cp', 'to'].forEach(k => { if (c[k]) mvPt(`curves.${ci}.${k}`); }));
      break;
    }
    case 'lines': {
      const segs = eff.segments || [];
      for (let s = 0; s < segs.length; s++) for (let p = 0; p < segs[s].length; p++) mvPt(`segments.${s}.${p}`);
      break;
    }
    default:
      // Containers (group, radialRepeat, …) — translate cx/cy (seeds from 0 if absent)
      mv('cx', dx); mv('cy', dy); break;
  }
}

function toNum(v) { return typeof v === 'number' ? v : 0; }
function round3(v) { return Math.round(v * 1000) / 1000; }

/** Nudge the selected shape by (dx, dy) art-units (used by arrow-key shortcuts). */
export function nudgeSelectedShape(dx, dy) {
  if (!ctx.currentArt || !ctx.selectedShapePath) return;
  if (ctx.editorLocked && ctx.editorLocked.has(ctx.selectedShapePath.join(','))) return;
  const shape = getShapeAtPath(ctx.currentArt.shapes, ctx.selectedShapePath);
  if (!shape) return;
  translateShape(shape, dx, dy);
  ctx.markDirty();
  ctx.rebuildProps();
}

/**
 * Rotate a shape to newRot, compensating cx/cy for groups so the visual center
 * stays in place. Primitives rotate natively around their center (ArtInterpreter
 * handles it), so no compensation needed.
 */
export function rotateShapeAroundCenter(shape, newRot, dc) {
  // Route writes through commitShapeEdit (keyframe / state override / base per context).
  if (shape.type !== 'group' && !CONTAINER_TYPES.has(shape.type)) {
    commitShapeEdit(shape, 'rotation', round3(newRot));
    return;
  }

  const anchor = getShapeAnchor(shape, dc);
  const bounds = getShapeBounds(shape, dc);
  if (!bounds) { commitShapeEdit(shape, 'rotation', round3(newRot)); return; }

  // Children's center in local art-coords (relative to group origin)
  const lcx = (bounds.x + bounds.w / 2 - anchor.x) / dc.r;
  const lcy = (bounds.y + bounds.h / 2 - anchor.y) / dc.r;

  const oldRot = getShapeRotation(shape);
  const cosOld = Math.cos(oldRot), sinOld = Math.sin(oldRot);
  const cosNew = Math.cos(newRot), sinNew = Math.sin(newRot);

  // Adjust cx/cy so the visual center stays put as rotation changes.
  const curCx = toNum(editValueAt(shape, 'cx'));
  const curCy = toNum(editValueAt(shape, 'cy'));
  commitShapeEdit(shape, 'cx', round3(curCx + lcx * (cosOld - cosNew) - lcy * (sinOld - sinNew)));
  commitShapeEdit(shape, 'cy', round3(curCy + lcx * (sinOld - sinNew) + lcy * (cosOld - cosNew)));
  commitShapeEdit(shape, 'rotation', round3(newRot));
}

// ─── Preview Mouse Interaction ──────────────────────────────────────────────

// ─── Shape picking (click-to-select) ────────────────────────────────────────

/** The state whose visibility/overrides the preview is currently showing. */
function activePreviewState() {
  return ctx.currentEditState === 'BASE' ? ctx.previewState : ctx.currentEditState;
}

/** Whether a shape is rendered in the current state (mirrors the interpreter). */
function shapeVisibleNow(shape) {
  const vs = shape.visibleStates;
  if (!vs || !vs.length) return true;
  const st = activePreviewState();
  return st != null && vs.includes(st);
}

/**
 * Collect world-space bounds of every pickable leaf shape, in draw order, with
 * accumulated parent (cx/cy) offsets. Editor-hidden shapes (A5) are skipped.
 */
function collectLeafBounds(shapes, basePath, dc, ox, oy, out) {
  shapes.forEach((shape, i) => {
    const path = [...basePath, i];
    if (!shapeVisibleNow(shape)) return;
    if (ctx.editorHidden && ctx.editorHidden.has(path.join(','))) return;
    const eff = effectiveShape(shape);
    const children = eff.shapes || eff.children;
    if (children && children.length) {
      const cox = ox + (eff.cx !== undefined ? resolveCoordSimple(eff.cx, dc) : 0);
      const coy = oy + (eff.cy !== undefined ? resolveCoordSimple(eff.cy, dc) : 0);
      collectLeafBounds(children, path, dc, cox, coy, out);
    } else {
      const b = getShapeBounds(shape, dc);
      if (b) out.push({ path, bounds: { x: b.x + ox, y: b.y + oy, w: b.w, h: b.h } });
    }
  });
}

/** Union bounds of the whole asset in world px (for fit-to-view). */
function getAssetBounds(dc) {
  if (!ctx.currentArt?.shapes) return null;
  const targets = [];
  collectLeafBounds(ctx.currentArt.shapes, [], dc, 0, 0, targets);
  if (!targets.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of targets) {
    minX = Math.min(minX, t.bounds.x); minY = Math.min(minY, t.bounds.y);
    maxX = Math.max(maxX, t.bounds.x + t.bounds.w); maxY = Math.max(maxY, t.bounds.y + t.bounds.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

let previewDrag = null;

export function setupPreviewInteraction() {
  const canvas = ctx.preview.canvas;

  /** Convert a mouse event to world coordinates, accounting for CSS/buffer mismatch. */
  function eventToWorld(e) {
    const rect = canvas.getBoundingClientRect();
    // CSS coords → buffer coords (canvas buffer may differ from CSS display size)
    const bx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const by = (e.clientY - rect.top) * (canvas.height / rect.height);
    return ctx.preview.screenToWorld(bx, by);
  }

  function getDc() {
    const r = ctx.previewRadius;
    const w = ctx.currentArt.space ? r * (ctx.currentArt.space.widthFactor || 1) : r;
    const h = ctx.currentArt.space ? r * (ctx.currentArt.space.heightFactor || 1) : r;
    return { r, w, h };
  }

  function hitTestHandles(worldX, worldY) {
    if (!ctx.selectedShapePath || !ctx.currentArt) return null;
    const shape = getShapeAtPath(ctx.currentArt.shapes, ctx.selectedShapePath);
    if (!shape) return null;

    const dc = getDc();
    const bounds = getShapeBounds(shape, dc);
    if (!bounds) return null;

    const hg = getHandleGeometry(shape, dc);
    const z = ctx.preview.getZoom();
    const ringTol = 6 / z; // tolerance band around the ring
    const ptTol = 8 / z;

    // Vertex / control-point handles take priority (you're aiming at a dot).
    for (const v of getEditablePoints(shape, dc)) {
      if (Math.hypot(worldX - v.wx, worldY - v.wy) < ptTol) return { type: 'vertex', point: v };
    }
    // Circle radius handle.
    const rh = getRadiusHandle(shape, dc);
    if (rh && Math.hypot(worldX - rh.x, worldY - rh.y) < ptTol) return { type: 'radius' };

    // Hit test rotation ring (click anywhere near the ring circumference)
    const distFromAnchor = Math.hypot(worldX - hg.anchor.x, worldY - hg.anchor.y);
    if (Math.abs(distFromAnchor - hg.ringR) < ringTol) {
      return { type: 'rotate', cx: hg.anchor.x, cy: hg.anchor.y };
    }

    // Hit test move — anywhere inside the bounding box (padded)
    const pad = 6 / z;
    if (worldX >= bounds.x - pad && worldX <= bounds.x + bounds.w + pad &&
        worldY >= bounds.y - pad && worldY <= bounds.y + bounds.h + pad) {
      return { type: 'move' };
    }

    // Also hit position handle dot (in case bounds are tiny/zero-size)
    if (Math.hypot(worldX - hg.anchor.x, worldY - hg.anchor.y) < 10 / z) {
      return { type: 'move' };
    }

    return null;
  }

  /** Pick the top-most leaf shape under the cursor; returns its path or null. */
  function pickShapeAt(worldX, worldY) {
    if (!ctx.currentArt || !ctx.currentArt.shapes) return null;
    const dc = getDc();
    const targets = [];
    collectLeafBounds(ctx.currentArt.shapes, [], dc, 0, 0, targets);
    const pad = 4 / ctx.preview.getZoom();
    for (let i = targets.length - 1; i >= 0; i--) { // last drawn = top-most
      const b = targets[i].bounds;
      if (worldX >= b.x - pad && worldX <= b.x + b.w + pad &&
          worldY >= b.y - pad && worldY <= b.y + b.h + pad) {
        return targets[i].path;
      }
    }
    return null;
  }

  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.shiftKey) return;

    const world = eventToWorld(e);
    const hit = hitTestHandles(world.x, world.y);
    if (!hit) {
      // No handle of the current selection — try to pick a shape under the cursor.
      const picked = pickShapeAt(world.x, world.y);
      if (picked) {
        e.preventDefault();
        e.stopPropagation();
        ctx.selectedShapePath = picked;
        ctx.rebuildTree();
        ctx.rebuildProps();
        // Start moving it in the same gesture (unless the shape is locked).
        if (!(ctx.editorLocked && ctx.editorLocked.has(picked.join(',')))) {
          previewDrag = { type: 'move', startWorld: world };
        }
        return;
      }
      if (ctx.selectedShapePath) {
        ctx.selectedShapePath = null;
        ctx.rebuildTree();
        ctx.rebuildProps();   // back to the asset-level panel
      }
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    // A locked shape selects but won't transform.
    if (ctx.editorLocked && ctx.selectedShapePath && ctx.editorLocked.has(ctx.selectedShapePath.join(','))) return;

    if (hit.type === 'move') {
      previewDrag = { type: 'move', startWorld: world };
    } else if (hit.type === 'vertex') {
      previewDrag = { type: 'vertex', point: hit.point, startWorld: world };
    } else if (hit.type === 'radius') {
      previewDrag = { type: 'radius' };
    } else if (hit.type === 'rotate') {
      const shape = getShapeAtPath(ctx.currentArt.shapes, ctx.selectedShapePath);
      if (!shape) return;
      const dc = getDc();
      const anchor = getShapeAnchor(shape, dc);
      const bounds = getShapeBounds(shape, dc);
      previewDrag = {
        type: 'rotate',
        visualCenterX: bounds ? bounds.x + bounds.w / 2 : anchor.x,
        visualCenterY: bounds ? bounds.y + bounds.h / 2 : anchor.y,
      };
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    const world = eventToWorld(e);

    if (previewDrag) {
      if (!ctx.selectedShapePath || !ctx.currentArt) return;
      const shape = getShapeAtPath(ctx.currentArt.shapes, ctx.selectedShapePath);
      if (!shape) return;

      // Freeze animation for the duration of the drag (grab a still target).
      if (ctx.frozenNow == null) ctx.frozenNow = ctx.animPlaying ? ctx.animNow : 0;

      const r = ctx.previewRadius;

      if (previewDrag.type === 'move' || previewDrag.type === 'vertex') {
        let dx = (world.x - previewDrag.startWorld.x) / r;
        let dy = (world.y - previewDrag.startWorld.y) / r;
        if (ctx.snapGrid) {
          const G = 0.05;
          dx = Math.round(dx / G) * G; dy = Math.round(dy / G) * G;
          if (dx === 0 && dy === 0) return;
          previewDrag.startWorld = { x: previewDrag.startWorld.x + dx * r, y: previewDrag.startWorld.y + dy * r };
        } else {
          previewDrag.startWorld = world;
        }
        if (previewDrag.type === 'move') {
          translateShape(shape, dx, dy);
        } else {
          // Vertex/control-point: route the moved point through the editor's edit
          // rule (keyframe / state override / base), reading its on-screen value.
          const p = previewDrag.point;
          commitShapeEdit(shape, p.path, addPointDelta(editValueAt(shape, p.path), dx, dy));
        }
        ctx.markDirty();
        ctx.rebuildProps();
      } else if (previewDrag.type === 'radius') {
        const dc = getDc();
        const cx = resolveCoordSimple(shape.cx, dc);
        const cy = resolveCoordSimple(shape.cy, dc);
        const newRadPx = Math.max(0.5, Math.hypot(world.x - cx, world.y - cy));
        if (shape.radiusAbs !== undefined) {
          const cur = editValueAt(shape, 'radiusAbs');
          const nv = (cur && typeof cur === 'object') ? { ...cur, base: round3(newRadPx) } : round3(newRadPx);
          commitShapeEdit(shape, 'radiusAbs', nv);
        } else {
          commitShapeEdit(shape, 'radius', round3(newRadPx / r));
        }
        ctx.markDirty();
        ctx.rebuildProps();
      } else if (previewDrag.type === 'rotate') {
        const d = previewDrag;
        const newRot = Math.atan2(world.y - d.visualCenterY, world.x - d.visualCenterX);
        rotateShapeAroundCenter(shape, newRot, getDc());
        ctx.markDirty();
        ctx.rebuildProps();
      }
    } else {
      // Cursor feedback
      const hit = hitTestHandles(world.x, world.y);
      canvas.style.cursor = hit
        ? (hit.type === 'rotate' ? 'crosshair' : (hit.type === 'vertex' || hit.type === 'radius' ? 'pointer' : 'grab'))
        : '';
    }
  });

  const stopDrag = () => {
    const wasDragging = previewDrag != null;
    previewDrag = null;
    ctx.frozenNow = null;   // resume live animation
    canvas.style.cursor = '';
    // A drag may have auto-keyed new poses — re-list the timeline rows so the fresh
    // diamonds show up.
    if (wasDragging) ctx.rebuildTimeline?.();
  };
  canvas.addEventListener('mouseup', stopDrag);
  canvas.addEventListener('mouseleave', stopDrag);
}

