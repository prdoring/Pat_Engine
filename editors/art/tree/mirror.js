// Shape mirroring for the art editor's tree: reflect a shape (and its whole
// subtree + state overrides) across the X or Y axis, inserting the mirrored copy
// after the original. Split out of tree.js. Panel/tree refreshes route through
// the ctx.* callbacks (== buildSidebarShapeTree / buildShapeProps).

import { ctx, getParentShapesAtPath } from '../ctx.js';

/** Negate a coordinate value (number, object with coefficients, or string variable ref). */
function negateCoord(val) {
  if (typeof val === 'number') return -val;
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
    const result = {};
    for (const [k, v] of Object.entries(val)) result[k] = typeof v === 'number' ? -v : v;
    return result;
  }
  return val; // strings (variable refs) can't be negated
}

/** Negate the X or Y component of a point ([x,y] array or {x,y} object). */
function negatePointAxis(pt, axis) {
  if (Array.isArray(pt)) {
    const copy = [...pt];
    copy[axis === 'x' ? 0 : 1] = negateCoord(copy[axis === 'x' ? 0 : 1]);
    return copy;
  }
  if (typeof pt === 'object' && pt !== null) {
    const copy = { ...pt };
    if (copy[axis] !== undefined) copy[axis] = negateCoord(copy[axis]);
    return copy;
  }
  return pt;
}

/** Mirror angle for X-axis flip: PI - angle. For Y-axis flip: -angle. */
function mirrorAngle(val, axis) {
  if (typeof val === 'string') {
    // PI-based angle string — wrap with mirror transform
    return axis === 'x' ? `PI-(${val})` : `-(${val})`;
  }
  if (typeof val === 'number') {
    return axis === 'x' ? Math.PI - val : -val;
  }
  return val;
}

/**
 * Recursively mirror a shape (already deep-cloned) along the given axis ('x' or 'y').
 * Negates position coordinates on the specified axis throughout the shape tree.
 */
function mirrorShapeRecursive(shape, axis) {
  const pos = axis; // 'x' or 'y'
  const altPos = axis === 'x' ? 'y' : 'x';
  const cPos = axis === 'x' ? 'cx' : 'cy';

  // Position properties common to many shape types
  if (shape[cPos] !== undefined) shape[cPos] = negateCoord(shape[cPos]);

  switch (shape.type) {
    case 'circle':
    case 'boltCluster':
      // cx/cy already handled above
      break;

    case 'arc':
      if (axis === 'x') {
        // Mirror angles: swap and reflect through PI
        const sa = shape.startAngle, ea = shape.endAngle;
        shape.startAngle = mirrorAngle(ea, 'x');
        shape.endAngle = mirrorAngle(sa, 'x');
      } else {
        const sa = shape.startAngle, ea = shape.endAngle;
        shape.startAngle = mirrorAngle(ea, 'y');
        shape.endAngle = mirrorAngle(sa, 'y');
      }
      break;

    case 'path':
      if (shape.points) shape.points = shape.points.map(p => negatePointAxis(p, pos));
      break;

    case 'bezierPath':
      if (shape.start) shape.start = negatePointAxis(shape.start, pos);
      if (shape.curves) {
        shape.curves = shape.curves.map(c => ({
          ...c,
          cp1: negatePointAxis(c.cp1, pos),
          cp2: negatePointAxis(c.cp2, pos),
          to: negatePointAxis(c.to, pos),
        }));
      }
      break;

    case 'quadPath':
      if (shape.start) shape.start = negatePointAxis(shape.start, pos);
      if (shape.curves) {
        shape.curves = shape.curves.map(c => ({
          ...c,
          cp: negatePointAxis(c.cp, pos),
          to: negatePointAxis(c.to, pos),
        }));
      }
      break;

    case 'rect':
    case 'strokeRect':
      if (shape[pos] !== undefined) {
        // Mirror rect: new_x = -(x + w), new_y = -(y + h)
        const size = axis === 'x' ? (shape.w ?? 0) : (shape.h ?? 0);
        if (typeof shape[pos] === 'number' && typeof size === 'number') {
          shape[pos] = -(shape[pos] + size);
        } else {
          shape[pos] = negateCoord(shape[pos]);
        }
      }
      break;

    case 'roundedRect':
      if (shape[pos] !== undefined) {
        const size = axis === 'x' ? (shape.width ?? 0) : (shape.height ?? 0);
        if (typeof shape[pos] === 'number' && typeof size === 'number') {
          shape[pos] = -(shape[pos] + size);
        } else {
          shape[pos] = negateCoord(shape[pos]);
        }
      }
      break;

    case 'lines':
      if (shape.segments) {
        shape.segments = shape.segments.map(seg =>
          seg.map(p => negatePointAxis(p, pos))
        );
      }
      break;

    case 'particles':
      if (shape.emitters) {
        for (const em of shape.emitters) {
          if (em[cPos] !== undefined) em[cPos] = negateCoord(em[cPos]);
          if (axis === 'x' && em.offsetX !== undefined) em.offsetX = -em.offsetX;
          if (axis === 'y' && em.offsetY !== undefined) em.offsetY = -em.offsetY;
        }
      }
      break;

    case 'group':
      // cx/cy already handled above.
      // Mirroring through a translate+rotate transform: rotation simply negates
      // (children are recursively mirrored to handle the scale(-1,1) / scale(1,-1))
      if (shape.rotation !== undefined) {
        if (typeof shape.rotation === 'number') shape.rotation = -shape.rotation;
        else if (typeof shape.rotation === 'string') shape.rotation = `-(${shape.rotation})`;
      }
      break;
  }

  // Recurse into children for container types
  if (shape.shapes) {
    for (const child of shape.shapes) mirrorShapeRecursive(child, axis);
  }

  // Mirror state overrides (supports both `states` and legacy `stateOverrides` keys)
  const overridesMap = shape.states || shape.stateOverrides;
  if (overridesMap) {
    for (const overrides of Object.values(overridesMap)) {
      if (overrides[cPos] !== undefined) overrides[cPos] = negateCoord(overrides[cPos]);
      if (overrides[pos] !== undefined) overrides[pos] = negateCoord(overrides[pos]);
      if (overrides.points) overrides.points = overrides.points.map(p => negatePointAxis(p, pos));
      if (overrides.segments) overrides.segments = overrides.segments.map(seg => seg.map(p => negatePointAxis(p, pos)));
      if (overrides.start) overrides.start = negatePointAxis(overrides.start, pos);
      if (overrides.curves) {
        overrides.curves = overrides.curves.map(c => {
          const mc = { ...c };
          if (mc.cp1) mc.cp1 = negatePointAxis(mc.cp1, pos);
          if (mc.cp2) mc.cp2 = negatePointAxis(mc.cp2, pos);
          if (mc.cp) mc.cp = negatePointAxis(mc.cp, pos);
          if (mc.to) mc.to = negatePointAxis(mc.to, pos);
          return mc;
        });
      }
    }
  }
}

/** Mirror the selected shape along an axis and insert the mirrored copy after it. */
export function mirrorSelectedShape(axis) {
  if (!ctx.selectedShapePath || ctx.selectedShapePath.length === 0) return;
  const art = ctx.currentArt;
  if (!art) return;
  const parentShapes = getParentShapesAtPath(art, ctx.selectedShapePath);
  if (!parentShapes) return;
  const idx = ctx.selectedShapePath[ctx.selectedShapePath.length - 1];
  const copy = JSON.parse(JSON.stringify(parentShapes[idx]));
  if (copy.name) copy.name += (axis === 'x' ? ' mirrorX' : ' mirrorY');
  mirrorShapeRecursive(copy, axis);
  parentShapes.splice(idx + 1, 0, copy);
  ctx.selectedShapePath = [...ctx.selectedShapePath.slice(0, -1), idx + 1];
  ctx.markDirty();
  ctx.rebuildTree();
  ctx.rebuildProps();
}
