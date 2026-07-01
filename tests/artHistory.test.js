import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure undo/redo stack core for the art editor. Headless, no DOM. Matches the
// music editor's "top = current" snapshot convention.

const { createHistory } = await import('/editors/art/model/history.js');

test('init seeds one state; nothing to undo/redo yet', () => {
  const h = createHistory();
  h.init({ n: 0 });
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
  assert.deepEqual(h.current(), { n: 0 });
});

test('push then undo returns the prior state and enables redo', () => {
  const h = createHistory();
  h.init({ n: 0 });
  h.push({ n: 1 });
  assert.equal(h.canUndo(), true);
  assert.deepEqual(h.undo(), { n: 0 });
  assert.equal(h.canRedo(), true);
  assert.deepEqual(h.current(), { n: 0 });
});

test('redo replays the undone state', () => {
  const h = createHistory();
  h.init({ n: 0 });
  h.push({ n: 1 });
  h.undo();
  assert.deepEqual(h.redo(), { n: 1 });
  assert.deepEqual(h.current(), { n: 1 });
  assert.equal(h.canRedo(), false);
});

test('push dedupes an identical consecutive snapshot', () => {
  const h = createHistory();
  h.init({ n: 0 });
  assert.equal(h.push({ n: 0 }), false);
  assert.deepEqual(h.sizes(), { undo: 1, redo: 0 });
  assert.equal(h.push({ n: 1 }), true);
});

test('a fresh push after an undo clears the redo branch', () => {
  const h = createHistory();
  h.init({ n: 0 });
  h.push({ n: 1 });
  h.undo();                 // back to {n:0}, redo has {n:1}
  assert.equal(h.canRedo(), true);
  h.push({ n: 2 });          // diverge
  assert.equal(h.canRedo(), false);
  assert.deepEqual(h.current(), { n: 2 });
});

test('undo on the seed state is a no-op (returns null)', () => {
  const h = createHistory();
  h.init({ n: 0 });
  assert.equal(h.undo(), null);
  assert.deepEqual(h.current(), { n: 0 });
});

test('limit evicts the oldest snapshot', () => {
  const h = createHistory({ limit: 3 });
  h.init({ n: 0 });
  h.push({ n: 1 });
  h.push({ n: 2 });
  h.push({ n: 3 });          // would be 4 entries → oldest ({n:0}) evicted
  assert.deepEqual(h.sizes(), { undo: 3, redo: 0 });
  // walking back as far as possible lands on {n:1}, not {n:0}
  h.undo(); h.undo();
  assert.deepEqual(h.current(), { n: 1 });
  assert.equal(h.canUndo(), false);
});
