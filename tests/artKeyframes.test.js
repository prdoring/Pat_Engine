import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure keyframe-editing ops for the art-editor timeline. Headless, no DOM.

const {
  ensureClip, clipMeta, clipKeys, setClipMeta, removeClip, defaultLoop,
  getTrack, hasAnim, setKeyframe, deleteKeyframe, deleteTrack, makeLoopable,
  walkShapes, listTracks, keyframeableProps, colorPropPath, getPropValue,
  renameAnimState, cloneAnimState, deleteAnimState,
  poseTimes, listPartRows, movePose, deletePose, keyPose,
  defaultFor, coerceToShapeOf, coerceToTrack,
} = await import('/editors/art/model/keyframes.js');

function fixture() {
  return {
    name: 'T', states: ['idle', 'happy'],
    shapes: [
      { name: 'Glow', type: 'circle', cx: 0, cy: 0, radiusAbs: 5, setup: { alpha: 1 } },
      { name: 'Body', type: 'circle', cx: 0, cy: 0, radius: 0.7, fillColor: '#7cc6a0' },
      { name: 'Grp', type: 'group', rotation: 0, shapes: [{ name: 'ray', type: 'lines', segments: [[[0, 0], [0, 1]]] }] },
    ],
  };
}

test('ensureClip: defaults — "*" loops, state plays once', () => {
  const art = fixture();
  const a = ensureClip(art, '*');
  assert.equal(a.loop, true); assert.equal(a.duration, 2000);
  const h = ensureClip(art, 'happy');
  assert.equal(h.loop, false);
  assert.deepEqual(clipKeys(art).sort(), ['*', 'happy']);
  assert.equal(defaultLoop('*'), true);
  assert.equal(defaultLoop('happy'), false);
});

test('setClipMeta / clipMeta update duration + loop', () => {
  const art = fixture();
  setClipMeta(art, '*', { duration: 3142, loop: true });
  assert.deepEqual(clipMeta(art, '*'), { duration: 3142, loop: true });
});

test('setKeyframe: inserts sorted, updates in place within epsilon', () => {
  const art = fixture();
  const s = art.shapes[0];
  setKeyframe(s, '*', 'setup.alpha', 1000, 0.5, 'easeInOutSine');
  setKeyframe(s, '*', 'setup.alpha', 0, 0.1);
  setKeyframe(s, '*', 'setup.alpha', 2000, 0.1);
  const track = getTrack(s, '*', 'setup.alpha');
  assert.deepEqual(track.map((k) => k.t), [0, 1000, 2000]); // sorted
  assert.equal(track[1].v, 0.5);
  assert.equal(track[1].ease, 'easeInOutSine');
  // update at ~same time
  setKeyframe(s, '*', 'setup.alpha', 1000.4, 0.9);
  assert.equal(getTrack(s, '*', 'setup.alpha').length, 3);
  assert.equal(getTrack(s, '*', 'setup.alpha')[1].v, 0.9);
});

test('setKeyframe: coord-object track is normalized to a shared key set', () => {
  const art = fixture();
  const s = art.shapes[0];
  setKeyframe(s, '*', 'radiusAbs', 0, { base: 18 });
  setKeyframe(s, '*', 'radiusAbs', 1000, { base: 24, r: 0.1 });
  const track = getTrack(s, '*', 'radiusAbs');
  assert.deepEqual(track[0].v, { base: 18, r: 0 }); // filled missing term
  assert.deepEqual(track[1].v, { base: 24, r: 0.1 });
});

test('deleteKeyframe: prunes empty track, clip, and anim block', () => {
  const art = fixture();
  const s = art.shapes[0];
  setKeyframe(s, '*', 'cy', 0, 0);
  setKeyframe(s, '*', 'cy', 1000, 5);
  deleteKeyframe(s, '*', 'cy', 1);
  assert.equal(getTrack(s, '*', 'cy').length, 1);
  deleteKeyframe(s, '*', 'cy', 0);
  assert.equal(hasAnim(s), false); // fully pruned
  assert.equal(s.anim, undefined);
});

test('deleteTrack removes the whole track and prunes', () => {
  const art = fixture();
  const s = art.shapes[0];
  setKeyframe(s, '*', 'cy', 0, 0);
  deleteTrack(s, '*', 'cy');
  assert.equal(s.anim, undefined);
});

test('makeLoopable copies the first key value to t=duration', () => {
  const art = fixture();
  const s = art.shapes[0];
  setKeyframe(s, '*', 'cy', 0, { base: 0 });
  setKeyframe(s, '*', 'cy', 1000, { base: 8 });
  makeLoopable(s, '*', 'cy', 2000);
  const track = getTrack(s, '*', 'cy');
  assert.equal(track[track.length - 1].t, 2000);
  assert.deepEqual(track[track.length - 1].v, { base: 0 });
});

test('listTracks: gathers every track for a clip with correct tree paths', () => {
  const art = fixture();
  setKeyframe(art.shapes[0], '*', 'setup.alpha', 0, 1);
  setKeyframe(art.shapes[2].shapes[0], '*', 'cy', 0, 0); // nested ray
  const rows = listTracks(art, '*');
  assert.equal(rows.length, 2);
  const ray = rows.find((r) => r.name === 'ray');
  assert.deepEqual(ray.path, [2, 0]);
  assert.equal(ray.prop, 'cy');
});

test('walkShapes visits nested shapes with paths matching getShapeAtPath', () => {
  const art = fixture();
  const seen = [];
  walkShapes(art.shapes, (s, p) => seen.push([s.name, p.join(',')]));
  assert.deepEqual(seen, [['Glow', '0'], ['Body', '1'], ['Grp', '2'], ['ray', '2,0']]);
});

test('keyframeableProps: circle exposes coords/radius/rotation/setup/color', () => {
  const props = keyframeableProps({ type: 'circle', cx: 0, cy: 0, radiusAbs: 5, setup: { fillColor: '#fff' } });
  const names = props.map((p) => p.prop);
  assert.ok(names.includes('cx') && names.includes('cy') && names.includes('radiusAbs'));
  assert.ok(names.includes('rotation') && names.includes('setup.alpha'));
  assert.ok(names.includes('setup.fillColor')); // color path the shape actually uses
});

test('keyframeableProps: effectRef exposes position/scale + a progress (fire) track', () => {
  const props = keyframeableProps({ type: 'effectRef', effect: 'poof', cx: 0, cy: 0, scale: 1 });
  const names = props.map((p) => p.prop);
  assert.deepEqual(names, ['cx', 'cy', 'scale', 'progress']);
  // No rotation/alpha/color — the embedded VFX ignores those (only transform + progress).
  assert.ok(!names.includes('rotation') && !names.includes('setup.alpha'));
});

test('colorPropPath prefers the path the shape actually reads', () => {
  assert.equal(colorPropPath({ type: 'circle', fillColor: '#abc' }), 'fillColor');
  assert.equal(colorPropPath({ type: 'circle', setup: { fillColor: '#abc' } }), 'setup.fillColor');
  assert.equal(colorPropPath({ type: 'circle' }), 'setup.fillColor'); // sensible default
});

test('getPropValue reads dotted + nested paths', () => {
  const s = { cx: 0.5, setup: { alpha: 0.8 }, points: [[0, 0], [1, 2]] };
  assert.equal(getPropValue(s, 'cx'), 0.5);
  assert.equal(getPropValue(s, 'setup.alpha'), 0.8);
  assert.deepEqual(getPropValue(s, 'points.1'), [1, 2]);
});

test('renameAnimState moves clip meta + every shape track', () => {
  const art = fixture();
  ensureClip(art, 'happy');
  setKeyframe(art.shapes[1], 'happy', 'cy', 0, 0);
  renameAnimState(art, 'happy', 'cheer');
  assert.ok(clipMeta(art, 'cheer') && !clipMeta(art, 'happy'));
  assert.ok(getTrack(art.shapes[1], 'cheer', 'cy'));
  assert.equal(getTrack(art.shapes[1], 'happy', 'cy'), null);
});

test('cloneAnimState deep-copies clip meta + tracks; deleteAnimState removes both', () => {
  const art = fixture();
  ensureClip(art, 'happy', { duration: 700, loop: false });
  setKeyframe(art.shapes[1], 'happy', 'cy', 0, 3);
  cloneAnimState(art, 'happy', 'happy2');
  assert.deepEqual(clipMeta(art, 'happy2'), { duration: 700, loop: false });
  assert.equal(getTrack(art.shapes[1], 'happy2', 'cy')[0].v, 3);
  // independence
  getTrack(art.shapes[1], 'happy2', 'cy')[0].v = 9;
  assert.equal(getTrack(art.shapes[1], 'happy', 'cy')[0].v, 3);
  deleteAnimState(art, 'happy');
  assert.equal(clipMeta(art, 'happy'), null);
  assert.equal(getTrack(art.shapes[1], 'happy', 'cy'), null);
});

test('removeClip drops meta and every shape track for that clip', () => {
  const art = fixture();
  ensureClip(art, '*');
  setKeyframe(art.shapes[0], '*', 'cy', 0, 0);
  setKeyframe(art.shapes[1], '*', 'cy', 0, 0);
  removeClip(art, '*');
  assert.equal(clipMeta(art, '*'), null);
  assert.equal(hasAnim(art.shapes[0]), false);
  assert.equal(hasAnim(art.shapes[1]), false);
});

// ── Part rows + pose ops ──────────────────────────────────────────────────────

test('poseTimes: unions key times across a shape\'s tracks and clusters within tol', () => {
  const art = fixture();
  const s = art.shapes[0];
  setKeyframe(s, '*', 'cy', 0, 0);
  setKeyframe(s, '*', 'cy', 900, 1);
  setKeyframe(s, '*', 'setup.alpha', 0, 0.5);   // same pose at t=0 → one diamond
  setKeyframe(s, '*', 'setup.alpha', 1800, 0.2);
  assert.deepEqual(poseTimes(s, '*'), [0, 900, 1800]);
});

test('listPartRows: one row per shape with tracks, carrying depth + pose times', () => {
  const art = fixture();
  setKeyframe(art.shapes[0], '*', 'cy', 0, 0);            // Glow (depth 0)
  setKeyframe(art.shapes[0], '*', 'cy', 900, 1);
  setKeyframe(art.shapes[2].shapes[0], '*', 'cy', 500, 0); // nested ray (depth 1)
  const rows = listPartRows(art, '*');
  assert.equal(rows.length, 2);
  const glow = rows.find((r) => r.name === 'Glow');
  assert.deepEqual(glow.path, [0]);
  assert.equal(glow.depth, 0);
  assert.deepEqual(glow.times, [0, 900]);
  assert.equal(glow.propCount, 1);
  const ray = rows.find((r) => r.name === 'ray');
  assert.deepEqual(ray.path, [2, 0]);
  assert.equal(ray.depth, 1);
});

test('movePose: retimes every track keyed near a pose time, merging at the target', () => {
  const art = fixture();
  const s = art.shapes[0];
  setKeyframe(s, '*', 'cy', 200, 5);
  setKeyframe(s, '*', 'setup.alpha', 200, 0.4);
  setKeyframe(s, '*', 'cy', 1000, 9);          // a later key that must not move
  const moved = movePose(s, '*', 200, 600);
  assert.equal(moved, 2);
  assert.deepEqual(getTrack(s, '*', 'cy').map((k) => k.t), [600, 1000]);
  assert.deepEqual(getTrack(s, '*', 'setup.alpha').map((k) => k.t), [600]);
  assert.equal(getTrack(s, '*', 'cy').find((k) => k.t === 600).v, 5);
});

test('movePose: no-op for tracks with no key near fromT', () => {
  const art = fixture();
  const s = art.shapes[0];
  setKeyframe(s, '*', 'cy', 0, 0);
  setKeyframe(s, '*', 'setup.alpha', 900, 1);  // only this track has a key near 900
  const moved = movePose(s, '*', 900, 1200);
  assert.equal(moved, 1);
  assert.deepEqual(getTrack(s, '*', 'cy').map((k) => k.t), [0]); // untouched
  assert.deepEqual(getTrack(s, '*', 'setup.alpha').map((k) => k.t), [1200]);
});

test('deletePose: removes the whole pose at a time and prunes empties', () => {
  const art = fixture();
  const s = art.shapes[0];
  setKeyframe(s, '*', 'cy', 0, 0);
  setKeyframe(s, '*', 'cy', 900, 1);
  setKeyframe(s, '*', 'setup.alpha', 900, 0.5);
  const n = deletePose(s, '*', 900);
  assert.equal(n, 2);
  assert.deepEqual(getTrack(s, '*', 'cy').map((k) => k.t), [0]);
  assert.equal(getTrack(s, '*', 'setup.alpha'), null); // pruned (was its only key)
});

test('keyPose: keys all currently-tracked props at a time via valueAt', () => {
  const art = fixture();
  const s = art.shapes[0];
  setKeyframe(s, '*', 'cy', 0, 0);
  setKeyframe(s, '*', 'setup.alpha', 0, 1);
  const n = keyPose(s, '*', 500, (prop) => (prop === 'cy' ? 3 : 0.4));
  assert.equal(n, 2);
  assert.equal(getTrack(s, '*', 'cy').find((k) => k.t === 500).v, 3);
  assert.equal(getTrack(s, '*', 'setup.alpha').find((k) => k.t === 500).v, 0.4);
});

test('keyPose: bootstraps every keyframeable prop when the clip has none yet', () => {
  const art = fixture();
  const s = art.shapes[0]; // circle Glow
  const n = keyPose(s, '*', 0, () => 1);
  assert.ok(n >= 5); // cx, cy, radiusAbs, rotation, setup.* , color …
  assert.ok(getTrack(s, '*', 'cx'));
  assert.ok(getTrack(s, '*', 'rotation'));
});

// ── Value-shape coercion ──────────────────────────────────────────────────────

test('defaultFor: neutral value per kind', () => {
  assert.deepEqual(defaultFor('coord'), { base: 0 });
  assert.equal(defaultFor('number'), 0);
  assert.equal(defaultFor('color'), '#ffffff');
});

test('coerceToShapeOf: number↔coord-object conform; colors pass through', () => {
  assert.deepEqual(coerceToShapeOf({ base: 10, r: 0.1 }, 7), { base: 7 });
  assert.equal(coerceToShapeOf(5, { base: 9, r: 0.2 }), 9);
  assert.equal(coerceToShapeOf('#abc', '#def'), '#def');
  assert.equal(coerceToShapeOf(5, 8), 8);
});

test('coerceToTrack: conforms a number write to an existing coord-object track', () => {
  const art = fixture();
  const s = art.shapes[0];
  setKeyframe(s, '*', 'radiusAbs', 0, { base: 16 });
  const track = getTrack(s, '*', 'radiusAbs');
  assert.deepEqual(coerceToTrack(track, 21), { base: 21 });
  assert.equal(coerceToTrack([], 21), 21); // empty track → unchanged
});
