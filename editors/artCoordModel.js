// Pure helpers for EDITING art coordinate values (DOM-free, unit-tested).
//
// These operate on the coordinate *value shape*, they do NOT resolve coordinates
// to pixels — the interpreter's resolveCoord (engine/render/ArtInterpreter.js)
// stays the single source of truth for rendering. A coordinate value is one of:
//   number                      r-relative (value * r px)
//   { base, r, w, h, <animVar> } linear combination (base = unscaled px)
//   string                      a loop/anim variable reference
//
// The drag/handle code used to coerce any non-number coord to 0 before adding a
// delta, silently destroying `base`/`r`/`w`/`h`/anim terms. These helpers move or
// mirror a coordinate while preserving every term it carries.

function round3(v) { return Math.round(v * 1000) / 1000; }

/** A drag/handle can move this coord without losing meaning (not a var ref). */
export function isDraggableCoord(coord) {
  return typeof coord !== 'string';
}

/**
 * Move a coordinate by `dx` art-units (= dx*r pixels), preserving every term.
 *  - number → number + dx
 *  - object → adds dx to the `r` coefficient (creating it if absent), so base /
 *    w / h / anim terms are untouched and the rest position shifts by dx*r px.
 *  - string / null → returned unchanged (not draggable).
 */
export function addCoordDelta(coord, dx) {
  if (!dx) return coord;
  if (typeof coord === 'number') return round3(coord + dx);
  if (coord && typeof coord === 'object') {
    return { ...coord, r: round3((coord.r || 0) + dx) };
  }
  return coord;
}

/**
 * Mirror a coordinate across an axis (negate it), preserving object terms.
 *  - number → -number
 *  - object → negate every numeric term (base, r, w, h, anim coefficients)
 *  - string / null → unchanged
 */
export function negateCoord(coord) {
  if (typeof coord === 'number') return round3(-coord);
  if (coord && typeof coord === 'object') {
    const next = {};
    for (const [k, v] of Object.entries(coord)) next[k] = typeof v === 'number' ? round3(-v) : v;
    return next;
  }
  return coord;
}

/**
 * Move a point (a path vertex / control point) by (dx, dy), preserving each
 * axis's coord shape. A point is `[x, y]` or `{ x, y }`; x and y are themselves
 * coordinate values. Returns a new point of the same form.
 */
export function addPointDelta(pt, dx, dy) {
  if (Array.isArray(pt)) return [addCoordDelta(pt[0], dx), addCoordDelta(pt[1], dy)];
  if (pt && typeof pt === 'object') return { ...pt, x: addCoordDelta(pt.x, dx), y: addCoordDelta(pt.y, dy) };
  return pt;
}
