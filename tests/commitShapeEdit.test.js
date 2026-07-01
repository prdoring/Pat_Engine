// Unit tests for the unified canvas/panel edit router (editors/art/ctx.js).
// commitShapeEdit routes an edit to keyframe / state-override / base per the same
// rule the props panel uses; editValueAt reads the on-screen value at the playhead.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ctx, commitShapeEdit, editValueAt } = await import('/editors/art/ctx.js');

/** Reset the shared editor ctx to a known editing context + fresh asset/shape. */
function setup({ state = 'BASE', clip = '*', playhead = 0, autoKey = true, playing = false, shape } = {}) {
  const sh = shape || { type: 'circle', cx: 0.2, cy: -0.1, radiusAbs: 12 };
  const art = { animations: {}, shapes: [sh] };
  ctx.currentArt = art;
  ctx.currentEditState = state;
  ctx.keyTargetClip = clip;
  ctx.playhead = playhead;
  ctx.autoKey = autoKey;
  ctx.animPlaying = playing;
  return { art, sh };
}

test('auto-key at t>0 creates a track and seeds a t=0 rest key from the base', () => {
  const { sh } = setup({ playhead: 500 });
  const where = commitShapeEdit(sh, 'cx', 0.6);
  assert.equal(where, 'key');
  const track = sh.anim['*'].cx;
  assert.deepEqual(track.map((k) => k.t), [0, 500]);
  assert.equal(track[0].v, 0.2); // seeded from the base rest value
  assert.equal(track[1].v, 0.6); // the edit at the playhead
  assert.equal(sh.cx, 0.2);      // base untouched
});

test('an existing track always keys — even with auto-key OFF', () => {
  const { sh } = setup({ playhead: 300, autoKey: false });
  // Pre-existing track:
  sh.anim = { '*': { cx: [{ t: 0, v: 0.2 }, { t: 600, v: 0.9 }] } };
  const where = commitShapeEdit(sh, 'cx', 0.4);
  assert.equal(where, 'key');
  const at300 = sh.anim['*'].cx.find((k) => k.t === 300);
  assert.equal(at300.v, 0.4);
});

test('at t=0 on BASE with no track → edits the base (no keyframe)', () => {
  const { sh } = setup({ playhead: 0 });
  const where = commitShapeEdit(sh, 'cx', 0.5);
  assert.equal(where, 'base');
  assert.equal(sh.cx, 0.5);
  assert.ok(!sh.anim);
});

test('auto-key OFF at t>0 with no track → base edit (not a keyframe)', () => {
  const { sh } = setup({ playhead: 400, autoKey: false });
  const where = commitShapeEdit(sh, 'cx', 0.5);
  assert.equal(where, 'base');
  assert.equal(sh.cx, 0.5);
  assert.ok(!sh.anim);
});

test('editing on a specific state without keyframing → that state\'s override', () => {
  const { sh } = setup({ state: 'happy', playhead: 0 });
  const where = commitShapeEdit(sh, 'cx', 0.7);
  assert.equal(where, 'state');
  assert.equal(sh.states.happy.cx, 0.7);
  assert.equal(sh.cx, 0.2); // base untouched
});

test('never keys while playing (playhead is advancing) — falls through to base', () => {
  const { sh } = setup({ playhead: 500, playing: true });
  const where = commitShapeEdit(sh, 'cx', 0.5);
  assert.equal(where, 'base');
  assert.ok(!sh.anim);
});

test('keyframes an individual vertex ([x,y] point) at a dotted path', () => {
  const sh = { type: 'path', points: [[-0.2, 0.24], [0, 0.32], [0.2, 0.24]] };
  setup({ playhead: 300, shape: sh });
  const where = commitShapeEdit(sh, 'points.1', [0.05, 0.5]);
  assert.equal(where, 'key');
  const track = sh.anim['*']['points.1'];
  assert.deepEqual(track.map((k) => k.t), [0, 300]);
  assert.deepEqual(track[0].v, [0, 0.32]);   // seeded from base point 1
  assert.deepEqual(track[1].v, [0.05, 0.5]); // the dragged value
  assert.deepEqual(sh.points[1], [0, 0.32]); // base point untouched
});

test('state override of one vertex clones the whole points array into the override', () => {
  const sh = { type: 'path', points: [[-0.2, 0.24], [0, 0.32], [0.2, 0.24]] };
  setup({ state: 'happy', playhead: 0, shape: sh });
  const where = commitShapeEdit(sh, 'points.1', [0.9, 0.9]);
  assert.equal(where, 'state');
  assert.deepEqual(sh.states.happy.points, [[-0.2, 0.24], [0.9, 0.9], [0.2, 0.24]]);
  assert.deepEqual(sh.points[1], [0, 0.32]); // base array untouched
  assert.notEqual(sh.states.happy.points, sh.points); // distinct array (cloned)
});

test('editValueAt returns the sampled value when a track exists, else the rest', () => {
  const sh = { type: 'circle', cx: 0.2, cy: 0, radiusAbs: 10 };
  setup({ playhead: 250, shape: sh });
  // No track yet → effective rest:
  assert.equal(editValueAt(sh, 'cx'), 0.2);
  // With a track, editValueAt samples at the playhead (midpoint of 0..500):
  sh.anim = { '*': { cx: [{ t: 0, v: 0 }, { t: 500, v: 1 }] } };
  assert.equal(editValueAt(sh, 'cx'), 0.5);
});

test('editValueAt reads the selected state override as the rest value', () => {
  const sh = { type: 'circle', cx: 0.2, cy: 0, radiusAbs: 10, states: { happy: { cx: 0.8 } } };
  setup({ state: 'happy', playhead: 0, shape: sh });
  assert.equal(editValueAt(sh, 'cx'), 0.8);
});
