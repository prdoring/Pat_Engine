import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure coordinate value-model helpers used by the art editor's drag/mirror code.
// The contract that matters: a drag/mirror must never flatten an object coord
// (which would delete its base/anim terms). Headless, no DOM.

const {
  isDraggableCoord, addCoordDelta, negateCoord, addPointDelta,
} = await import('/editors/artCoordModel.js');

test('isDraggableCoord: numbers and objects yes, var-ref strings no', () => {
  assert.ok(isDraggableCoord(0.5));
  assert.ok(isDraggableCoord({ base: 18, breathe: 6 }));
  assert.ok(!isDraggableCoord('loopVar'));
});

test('addCoordDelta: number adds directly', () => {
  assert.equal(addCoordDelta(0.5, 0.25), 0.75);
  assert.equal(addCoordDelta(0.5, 0), 0.5);
});

test('addCoordDelta: object preserves every term, shifts the r coefficient', () => {
  const out = addCoordDelta({ base: 18, breathe: 6 }, 0.2);
  assert.deepEqual(out, { base: 18, breathe: 6, r: 0.2 });
});

test('addCoordDelta: object with existing r accumulates', () => {
  const out = addCoordDelta({ r: 0.5, sway: 0.12 }, 0.1);
  assert.deepEqual(out, { r: 0.6, sway: 0.12 });
});

test('addCoordDelta: does NOT mutate the input object', () => {
  const input = { base: 1, r: 0.2 };
  addCoordDelta(input, 0.3);
  assert.deepEqual(input, { base: 1, r: 0.2 });
});

test('addCoordDelta: var-ref string is left untouched', () => {
  assert.equal(addCoordDelta('myVar', 0.4), 'myVar');
});

test('negateCoord: number flips sign', () => {
  assert.equal(negateCoord(0.3), -0.3);
});

test('negateCoord: object negates all numeric terms', () => {
  assert.deepEqual(negateCoord({ base: 18, r: 0.5, sway: 0.12 }), { base: -18, r: -0.5, sway: -0.12 });
});

test('addPointDelta: array point moves both axes, preserving forms', () => {
  assert.deepEqual(addPointDelta([0.2, 0.24], 0.1, -0.05), [0.3, 0.19]);
  assert.deepEqual(addPointDelta([{ base: 0, sway: 0.12 }, -0.82], 0.1, 0.0),
    [{ base: 0, sway: 0.12, r: 0.1 }, -0.82]);
});

test('addPointDelta: object point moves x/y, preserving the object', () => {
  assert.deepEqual(addPointDelta({ x: { w: 0 }, y: { h: 0 } }, 0.1, 0.2),
    { x: { w: 0, r: 0.1 }, y: { h: 0, r: 0.2 } });
});
