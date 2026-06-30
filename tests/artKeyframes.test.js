import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure keyframe-editing ops for the art-editor timeline. Headless, no DOM.

const {
  ensureClip, clipMeta, clipKeys, setClipMeta, removeClip, defaultLoop,
  getTrack, hasAnim, setKeyframe, deleteKeyframe, deleteTrack, makeLoopable,
  walkShapes, listTracks, keyframeableProps, colorPropPath, getPropValue,
  renameAnimState, cloneAnimState, deleteAnimState,
} = await import('/editors/artKeyframes.js');

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
