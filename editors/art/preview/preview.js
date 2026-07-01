// Preview rendering and controls for the art editor.
// Handles the preview canvas, the always-on render loop, transport, and control bar.
// Geometry / bounds / highlight drawing live in ./previewGeometry.js and the mouse
// interaction (pick / drag handles) in ./previewInteraction.js.

import { drawUnifiedArt, setEffectResolver } from '/engine/render/ArtInterpreter.js';
import { VFX_DEFS } from '/engine/data/vfx.js';
import { ctx, getShapeAtPath } from '../ctx.js';
import { Select, NumberSlider, Toggle, Button, getManifest } from '/editors/shared/index.js';
import { drawShapeHighlight, getAssetBounds } from './previewGeometry.js';

// Let `effectRef` shapes resolve to VFX effects by id in the preview.
setEffectResolver((id) => VFX_DEFS[id]);

// nudgeSelectedShape / rotateShapeAroundCenter live in ./previewGeometry.js and
// setupPreviewInteraction in ./previewInteraction.js; re-exported here so external
// importers (artEditor.js, shapeEditors.js) keep resolving them via preview.js.
export { nudgeSelectedShape, rotateShapeAroundCenter } from './previewGeometry.js';
export { setupPreviewInteraction } from './previewInteraction.js';

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
