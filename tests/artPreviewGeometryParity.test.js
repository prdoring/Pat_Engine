import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Art editor bounds/handle PARITY with the renderer's coordinate math ─────────
//
// The art preview's hit-targets, bounds and drag-handles must resolve coordinates
// the SAME way ArtInterpreter draws them, or you grab a shape where it isn't. The
// editor used to hand-roll coord resolution and dropped the `base` (absolute px)
// term, and circle bounds went NaN when radiusAbs was a { base: N } object. This
// pins that the editor now delegates to the engine resolver (parity by construction).

// Minimal DOM stubs so the editor module graph links (mirrors editorSmoke.test.js).
globalThis.document ??= {
  addEventListener() {}, removeEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  createElement() {
    return {
      style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild(c) { return c; }, append() {}, remove() {}, setAttribute() {},
      addEventListener() {}, removeEventListener() {}, getContext() { return null; },
      querySelector() { return null; }, querySelectorAll() { return []; },
    };
  },
  head: { appendChild() {} }, body: { appendChild() {}, style: {} },
};
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};

const { resolveCoordSimple, getShapeBounds } = await import('/editors/art/preview/previewGeometry.js');
const { resolveCoord } = await import('/engine/render/art/coords.js');

const dc = { r: 26, w: 40, h: 20, color: '#fff' };

test('editor coord resolver matches the engine resolver (incl. base term)', () => {
  const cases = [
    5,                                   // plain number → n*r
    { r: 0.5 },                          // r-relative
    { base: 10 },                        // absolute px — the dropped term
    { base: 10, r: 0.5 },                // mixed
    { base: -4, r: 0.25, w: 0.5, h: 1 }, // full linear combination
  ];
  for (const val of cases) {
    assert.equal(resolveCoordSimple(val, dc), resolveCoord(val, dc), `mismatch for ${JSON.stringify(val)}`);
  }
});

test('circle bounds with base-coords are finite and correct (no NaN)', () => {
  const shape = { type: 'circle', cx: { base: 10 }, cy: 0, radiusAbs: { base: 18 } };
  const b = getShapeBounds(shape, dc);
  assert.ok(Number.isFinite(b.x) && Number.isFinite(b.w), `bounds must be finite: ${JSON.stringify(b)}`);
  assert.equal(b.x, 10 - 18);   // cx.base - radius
  assert.equal(b.w, 36);        // 2 * radius
});

test('circle bounds with numeric radiusAbs still correct', () => {
  const b = getShapeBounds({ type: 'circle', cx: 0, cy: 0, radiusAbs: 12 }, dc);
  assert.equal(b.w, 24);
  assert.equal(b.x, -12);
});
