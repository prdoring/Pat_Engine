// Geometry, bounds, hit-target and highlight-drawing helpers for the art editor
// preview. Split out of preview.js. Pure math + canvas drawing (the caller passes
// the 2D context); no event wiring lives here. Shape mutations (translate / rotate /
// nudge) route every write through commitShapeEdit so a move keyframes / state-
// overrides / edits base per the current editor context, exactly like the props panel.

import { ctx, getShapeAtPath, CONTAINER_TYPES, editValueAt, commitShapeEdit } from '../ctx.js';
import { addCoordDelta, addPointDelta } from '../model/coordModel.js';
import { resolveCoord, resolveSetupVal } from '/engine/render/art/coords.js';

// ─── Coordinate resolution (static, editor-space) ─────────────────────────────
// Delegate to the ENGINE resolver so the editor's bounds / hit-targets / handles
// agree with what the renderer actually draws — including the `base` (absolute px)
// term that a hand-rolled copy here used to drop. Parity by construction.

export function resolveCoordSimple(val, dc) {
  return resolveCoord(val, dc);
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

// ─── Shape Bounds & Anchors ───────────────────────────────────────────────────

export function getShapeBounds(rawShape, dc) {
  const shape = effectiveShape(rawShape);
  switch (shape.type) {
    case 'circle': {
      const cx = resolveCoordSimple(shape.cx, dc);
      const cy = resolveCoordSimple(shape.cy, dc);
      // radiusAbs may be a plain number OR a { base: N } coord-object — resolveSetupVal
      // handles both (a raw object here previously produced NaN bounds).
      const rad = shape.radiusAbs !== undefined
        ? resolveSetupVal(shape.radiusAbs, dc)
        : (shape.radius || 0.1) * dc.r;
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
export function getShapeAnchor(rawShape, dc) {
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
export function getHandleGeometry(shape, dc) {
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
export function getEditablePoints(shape, dc) {
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
export function getRadiusHandle(shape, dc) {
  if (shape.type !== 'circle') return null;
  const cx = resolveCoordSimple(shape.cx, dc);
  const cy = resolveCoordSimple(shape.cy, dc);
  const rad = shape.radiusAbs !== undefined
    ? resolveSetupVal(shape.radiusAbs, dc)
    : (shape.radius || 0.1) * dc.r;
  return { x: cx + rad, y: cy, cx, cy };
}

// ─── Highlight Drawing ────────────────────────────────────────────────────────

export function drawShapeHighlight(canvasCtx, dc, shape, style) {
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

// ─── Shape Transforms (write through commitShapeEdit) ─────────────────────────

/** Translate a shape's position by dx/dy in art-coordinate space (values / r). */
export function translateShape(shape, dx, dy) {
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
export function round3(v) { return Math.round(v * 1000) / 1000; }

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

// ─── Shape picking (leaf bounds in draw order) ────────────────────────────────

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
export function collectLeafBounds(shapes, basePath, dc, ox, oy, out) {
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
export function getAssetBounds(dc) {
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
