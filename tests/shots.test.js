// Shot-harness smoke test (Node, headless). Not an image backend — it proves that the
// runner + every declared shot's renderShot path executes without throwing and emits
// drawing calls, using a recording ctx (no pixels). Catches a broken shot, a renderShot
// regression, or a stale shot.state shape. The browser /shots page is the image path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runShots } from '/engine/harness/runShots.js';
import { createRecordingCtx } from './helpers/mocks.js';
import shotsManifest from '/data/shots.json' with { type: 'json' };

// The game seam is reached the same way the browser page reaches it: via the
// data-declared `render` path (never a static import of game/ from engine/test land).
const { renderShot } = await import(shotsManifest.render);

function makeRecordingCanvas(w, h) {
  const ctx = createRecordingCtx();
  return { width: w, height: h, getContext: () => ctx };
}

test('shots.json declares a render seam and at least one shot', () => {
  assert.equal(typeof shotsManifest.render, 'string', 'has a render seam path');
  assert.ok(Array.isArray(shotsManifest.shots) && shotsManifest.shots.length > 0, 'has shots');
});

test('every shot renders through renderShot without throwing and emits draws', () => {
  const results = runShots({
    shots: shotsManifest.shots,
    renderShot,
    makeCanvas: makeRecordingCanvas,
  });
  assert.equal(results.length, shotsManifest.shots.length, 'one result per shot');
  for (const r of results) {
    assert.ok(r.canvas.getContext('2d')._draws > 0, `shot "${r.id}" emitted draw calls`);
  }
});

test('seeded RNG makes a shot byte-stable across runs (same draw count)', () => {
  const one = runShots({ shots: shotsManifest.shots, renderShot, makeCanvas: makeRecordingCanvas });
  const two = runShots({ shots: shotsManifest.shots, renderShot, makeCanvas: makeRecordingCanvas });
  for (let i = 0; i < one.length; i++) {
    assert.equal(
      one[i].canvas.getContext('2d')._draws,
      two[i].canvas.getContext('2d')._draws,
      `shot "${one[i].id}" is deterministic`,
    );
  }
});
