import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure interpolation + keyframe-sampling math shared by the art interpreter and
// the editor timeline. Headless, no DOM/canvas.

const {
  lerpValue, lerpColor, lerpKeyValue, EASING, EASE_NAMES, applyEase,
  clipLocalTime, sampleTrack, sampleClips, unifyCoordKeys,
} = await import('/engine/render/interp.js');

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

// ── easing ──
test('easing: every curve maps endpoints 0→0 and 1→1', () => {
  for (const name of EASE_NAMES) {
    approx(EASING[name](0), 0);
    approx(EASING[name](1), 1);
  }
});

test('easing: easeInOutSine reproduces a half-cosine (sine motion)', () => {
  // (1 - cos(pi*t))/2
  for (const t of [0, 0.25, 0.5, 0.75, 1]) approx(EASING.easeInOutSine(t), (1 - Math.cos(Math.PI * t)) / 2);
});

test('easing: monotonic non-decreasing across the unit interval', () => {
  for (const name of EASE_NAMES) {
    let prev = -Infinity;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = EASING[name](t);
      assert.ok(v >= prev - 1e-9, `${name} not monotonic at ${t}`);
      prev = v;
    }
  }
});

test('applyEase: unknown name falls back to linear', () => {
  approx(applyEase('nope', 0.3), 0.3);
});

// ── lerpColor ──
test('lerpColor: midpoint of black↔white is mid-grey', () => {
  assert.equal(lerpColor('#000000', '#ffffff', 0.5), '#808080');
});
test('lerpColor: shorthand hex expands', () => {
  assert.equal(lerpColor('#000', '#fff', 0), '#000000');
  assert.equal(lerpColor('#000', '#fff', 1), '#ffffff');
});
test('lerpColor: non-hex snaps at t>=0.5', () => {
  assert.equal(lerpColor('red', 'blue', 0.4), 'red');
  assert.equal(lerpColor('red', 'blue', 0.6), 'blue');
});

// ── lerpKeyValue (coord-objects + colors + missing terms) ──
test('lerpKeyValue: missing coord term grows from 0, not snap', () => {
  const out = lerpKeyValue({ base: 18 }, { base: 24, r: 0.1 }, 0.5);
  approx(out.base, 21);
  approx(out.r, 0.05); // missing on the left side → treated as 0
});
test('lerpKeyValue: hex strings tween as color', () => {
  assert.equal(lerpKeyValue('#000000', '#ffffff', 0.5), '#808080');
});
test('lerpKeyValue: plain numbers interpolate', () => {
  approx(lerpKeyValue(0, 10, 0.25), 2.5);
});

// ── clipLocalTime ──
test('clipLocalTime: loop wraps with epoch 0 (ambient never resets)', () => {
  approx(clipLocalTime(0, 0, 1000, true), 0);
  approx(clipLocalTime(1500, 0, 1000, true), 500);
  approx(clipLocalTime(3200, 0, 1000, true), 200);
});
test('clipLocalTime: once clamps to [0,duration] off the epoch', () => {
  approx(clipLocalTime(1000, 1000, 700, false), 0);   // exactly at epoch
  approx(clipLocalTime(1350, 1000, 700, false), 350); // mid-clip
  approx(clipLocalTime(5000, 1000, 700, false), 700); // past end → held
  approx(clipLocalTime(900, 1000, 700, false), 0);    // before epoch → clamp 0
});
test('clipLocalTime: duration<=0 / NaN guards to 0 (no %0 NaN)', () => {
  assert.equal(clipLocalTime(500, 0, 0, true), 0);
  assert.equal(clipLocalTime(500, 0, NaN, true), 0);
  assert.equal(clipLocalTime(500, 0, -10, false), 0);
});

// ── sampleTrack ──
const bob = [
  { t: 0, v: 0 },
  { t: 1000, v: 10, ease: 'linear' },
  { t: 2000, v: 0, ease: 'linear' },
];
test('sampleTrack: before first / after last hold the endpoints', () => {
  approx(sampleTrack(bob, -50), 0);
  approx(sampleTrack(bob, 5000), 0);
});
test('sampleTrack: within a segment interpolates with the segment-end ease', () => {
  approx(sampleTrack(bob, 500), 5);   // halfway up, linear
  approx(sampleTrack(bob, 1500), 5);  // halfway down, linear
});
test('sampleTrack: exactly on a key returns that key value', () => {
  approx(sampleTrack(bob, 1000), 10);
});
test('sampleTrack: empty/garbage → undefined; single key → its value', () => {
  assert.equal(sampleTrack([], 100), undefined);
  assert.equal(sampleTrack(null, 100), undefined);
  approx(sampleTrack([{ t: 0, v: 7 }], 999), 7);
});
test('sampleTrack: tolerates unsorted keys', () => {
  const unsorted = [{ t: 2000, v: 0 }, { t: 0, v: 0 }, { t: 1000, v: 10 }];
  approx(sampleTrack(unsorted, 500), 5);
  approx(sampleTrack(unsorted, 1500), 5);
});
test('sampleTrack: NaN localT coerces to 0', () => {
  approx(sampleTrack(bob, NaN), 0);
});

// ── sampleClips (composite "*" then state) ──
test('sampleClips: state clip overrides the ambient clip for the same prop', () => {
  const anim = {
    '*': { 'setup.alpha': [{ t: 0, v: 0.1 }, { t: 1000, v: 0.2 }], cy: [{ t: 0, v: 0 }, { t: 1000, v: 5 }] },
    happy: { 'setup.alpha': [{ t: 0, v: 0.5 }, { t: 700, v: 0.9 }] },
  };
  const out = sampleClips(anim, 'happy', { '*': 500, happy: 350 });
  approx(out['setup.alpha'], 0.7); // happy wins (0.5→0.9 @ 350/700)
  approx(out.cy, 2.5);             // ambient-only prop still sampled (0→5 @ 500/1000)
});
test('sampleClips: independent clocks per clip', () => {
  const anim = { '*': { cy: [{ t: 0, v: 0 }, { t: 1000, v: 10 }] } };
  approx(sampleClips(anim, 'idle', { '*': 250 }).cy, 2.5);
  approx(sampleClips(anim, 'idle', { '*': 750 }).cy, 7.5);
});
test('sampleClips: null when nothing applies', () => {
  assert.equal(sampleClips(null, 'idle', { '*': 0 }), null);
  assert.equal(sampleClips({ '*': { cy: [{ t: 0, v: 0 }] } }, 'idle', {}), null); // no clock → skip
  assert.equal(sampleClips({ happy: { cy: [{ t: 0, v: 1 }] } }, 'idle', { '*': 0 }), null); // wrong state
});

// ── unifyCoordKeys ──
test('unifyCoordKeys: unions coord-object key sets, filling missing with 0', () => {
  const out = unifyCoordKeys([{ t: 0, v: { base: 18 } }, { t: 1000, v: { base: 24, r: 0.1 } }]);
  assert.deepEqual(out[0].v, { base: 18, r: 0 });
  assert.deepEqual(out[1].v, { base: 24, r: 0.1 });
});
test('unifyCoordKeys: leaves number/color tracks untouched', () => {
  const nums = [{ t: 0, v: 0 }, { t: 1, v: 5 }];
  assert.equal(unifyCoordKeys(nums), nums);
});
