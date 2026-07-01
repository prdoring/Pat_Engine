// Preview mouse interaction for the art editor: click-to-select shape picking,
// handle hit-testing, and drag gestures (move / vertex / radius / rotate). Split
// out of preview.js. Geometry + bounds + transforms come from ./previewGeometry.js;
// this module owns only the transient drag state and the canvas event wiring.

import { ctx, getShapeAtPath, editValueAt, commitShapeEdit } from '../ctx.js';
import { addPointDelta } from '../model/coordModel.js';
import {
  getShapeBounds, getShapeAnchor, getHandleGeometry, getEditablePoints, getRadiusHandle,
  resolveCoordSimple, collectLeafBounds, translateShape, rotateShapeAroundCenter, round3,
} from './previewGeometry.js';

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
