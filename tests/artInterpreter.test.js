import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockCtx } from './helpers/mocks.js';

import { drawUnifiedArt, evalAngle, resolveCoord } from '/engine/render/ArtInterpreter.js';

const now = 12345;

/**
 * A synthetic asset that exercises a broad mix of shape types in one tree:
 * circle, path, lines, arc, rect, roundedRect, group, repeat, forEach, a
 * radialRepeat spun by a keyframe `rotation` track, and an ambient "*" clip that
 * breathes a circle's `radiusAbs`. (The old oscillator/spinner animator system
 * was removed — motion is now keyframe `anim` tracks sampled by the interpreter.)
 */
const syntheticArt = {
  name: 'Synthetic',
  states: ['idle', 'active'],
  space: { widthFactor: 1.4, heightFactor: 0.8 },
  setup: { lineWidth: 1.5, alpha: 0.9 },
  animations: { '*': { duration: 1000, loop: true } },
  shapes: [
    { type: 'circle', fill: true, stroke: true, cx: 0, cy: 0, radius: 0.5 },
    { type: 'path', stroke: true, closed: true, points: [[-0.4, 0.4], [0.4, 0.4], [0, -0.4]] },
    { type: 'lines', stroke: true, segments: [[[-0.5, 0], [0.5, 0]], [[0, -0.5], [0, 0.5]]] },
    { type: 'arc', stroke: true, cx: 0, cy: 0, radius: 0.6, startAngle: '-PI*0.85', endAngle: 'PI*0.15' },
    { type: 'rect', fill: true, x: -0.3, y: -0.3, w: 0.6, h: 0.6 },
    { type: 'roundedRect', fill: true, stroke: true, x: -0.4, y: -0.4, width: 0.8, height: 0.8, cornerRadius: 0.1 },
    {
      type: 'group', cx: 0.1, cy: 0.1, rotation: 'PI*0.25',
      children: [{
        type: 'circle', fill: true, cx: 0, cy: 0, radiusAbs: { base: 3 },
        anim: { '*': { radiusAbs: [
          { t: 0, v: { base: 3 } },
          { t: 500, v: { base: 5 }, ease: 'easeInOutSine' },
          { t: 1000, v: { base: 3 }, ease: 'easeInOutSine' },
        ] } },
      }],
    },
    {
      type: 'repeat', var: 'k', from: -0.4, to: 0.4, step: 0.2,
      shapes: [{ type: 'circle', fill: true, cx: 'k', cy: 0, radiusAbs: 1 }],
    },
    {
      type: 'forEach', var: ['vx', 'vy'], items: [[-0.3, -0.3], [0.3, 0.3]],
      shapes: [{ type: 'circle', fill: true, cx: 'vx', cy: 'vy', radiusAbs: 1 }],
    },
    {
      // A radialRepeat spun by a keyframe rotation track on its group wrapper —
      // the conversion that replaced the old `spinner` shape.
      type: 'group', rotation: 0,
      anim: { '*': { rotation: [{ t: 0, v: 0 }, { t: 1000, v: 6.283185, ease: 'linear' }] } },
      children: [{
        type: 'radialRepeat', count: 4, cx: 0, cy: 0, radius: 0,
        children: [{ type: 'lines', stroke: true, segments: [[[0, -0.9], [0, -1.1]]] }],
      }],
    },
  ],
};

test('synthetic asset with many shape types renders without throwing', () => {
  const ctx = createMockCtx();
  for (const state of [undefined, 'idle', 'active']) {
    assert.doesNotThrow(
      () => drawUnifiedArt(ctx, 26, '#7cc6a0', syntheticArt, state, now),
      `state=${state}`,
    );
  }
});

test('drawing never mutates the input asset (keyframe sampling clones)', () => {
  const before = JSON.stringify(syntheticArt);
  const ctx = createMockCtx();
  drawUnifiedArt(ctx, 26, '#7cc6a0', syntheticArt, 'idle', now);
  assert.equal(JSON.stringify(syntheticArt), before, 'sampling must clone, not mutate the registry');
});

test('a keyframed radiusAbs samples a different value as the clip clock advances', () => {
  // The ambient circle breathes radiusAbs base 3 → 5 → 3 over 1000ms. Recording
  // ctx.arc radii at clip-local t=0 vs t=500 (pinned via transition.animTime)
  // must differ — only the breathing circle produces a radius of exactly 3.
  function radiiAt(localMs) {
    const recorded = [];
    const ctx = createMockCtx();
    ctx.arc = (cx, cy, rad) => recorded.push(rad);
    drawUnifiedArt(ctx, 10, '#fff', syntheticArt, 'idle', 0, { animTime: { '*': localMs } });
    return recorded;
  }
  const r0 = radiiAt(0);
  const r500 = radiiAt(500);
  assert.ok(r0.includes(3), `expected the breathing radius (3) at t=0, got ${r0}`);
  assert.ok(!r500.includes(3), `breathing radius should have moved off 3 by t=500, got ${r500}`);
});

test('a malformed angle expression renders without throwing and evaluates to 0', () => {
  // evalAngle is the safe arithmetic evaluator — malformed input yields 0, no throw.
  assert.equal(evalAngle('PI*'), 0);
  assert.equal(evalAngle('('), 0);
  assert.equal(evalAngle('1 +'), 0);   // dangling operator → no operand
  assert.equal(evalAngle('1 2'), 0);   // trailing input after a complete expr
  assert.equal(evalAngle('foo'), 0);
  assert.equal(evalAngle(''), 0);
  // Non-finite results (e.g. div-by-zero) are also guarded to 0.
  assert.equal(evalAngle('PI/0'), 0);

  const broken = {
    name: 'BrokenAngle',
    states: ['idle'],
    shapes: [
      { type: 'arc', stroke: true, cx: 0, cy: 0, radius: 0.6, startAngle: 'PI*', endAngle: 'oops(' },
    ],
  };
  const ctx = createMockCtx();
  assert.doesNotThrow(() => drawUnifiedArt(ctx, 26, '#7cc6a0', broken, 'idle', now));
});

test('valid arithmetic expressions evaluate correctly', () => {
  assert.ok(Math.abs(evalAngle('-PI*0.85') - (-Math.PI * 0.85)) < 1e-9);
  assert.ok(Math.abs(evalAngle('PI*0.15') - (Math.PI * 0.15)) < 1e-9);
  assert.ok(Math.abs(evalAngle('PI/2') - (Math.PI / 2)) < 1e-9);
  assert.equal(evalAngle('(1+2)*-3'), -9);
  assert.equal(evalAngle('.5 + .25'), 0.75);
  assert.equal(evalAngle(1.23), 1.23); // numbers pass through unchanged
});

test('the `base` key in a coordinate object is honored as an unscaled constant', () => {
  // Direct unit test of resolveCoord.
  const dc = { r: 10, w: 14, h: 8 };
  // base is additive and NOT multiplied by r; r-term still scales by r.
  assert.equal(resolveCoord({ base: 7, r: 0.2 }, dc, {}), 7 + 0.2 * 10); // 9
  assert.equal(resolveCoord({ base: 5 }, dc, {}), 5);
  // base composes with loop vars from varMap (repeat/forEach), which ARE r-scaled.
  assert.equal(resolveCoord({ base: 0, k: 0.12 }, dc, { k: 0.5 }), 0.12 * 0.5 * 10); // 0.6

  // Render-based check via a recording ctx: a circle whose cx uses { base, r }
  // must arc at the base-plus-scaled x, proving base reached the canvas.
  const recorded = [];
  const ctx = createMockCtx();
  ctx.arc = (cx, cy, rad) => recorded.push({ cx, cy, rad });
  const asset = {
    name: 'BaseCheck',
    states: ['idle'],
    shapes: [{ type: 'circle', fill: true, cx: { base: 7, r: 0.2 }, cy: 0, radiusAbs: 3 }],
  };
  drawUnifiedArt(ctx, 10, '#fff', asset, 'idle', 0);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].cx, 9); // 7 (base) + 0.2 * r(10)
});

test('an unknown shape type does not throw', () => {
  const asset = {
    name: 'Unknown',
    states: ['idle'],
    shapes: [
      { type: 'definitely-not-a-real-shape', cx: 0, cy: 0 },
      { type: 'circle', fill: true, cx: 0, cy: 0, radius: 0.5 }, // sibling still renders
    ],
  };
  const ctx = createMockCtx();
  assert.doesNotThrow(() => drawUnifiedArt(ctx, 26, '#7cc6a0', asset, 'idle', now));
});

test('repeat with a non-positive/non-finite step does not hang, forEach without items does not throw', () => {
  const ctx = createMockCtx();

  const badRepeat = {
    name: 'BadRepeat',
    states: ['idle'],
    shapes: [
      { type: 'repeat', var: 'k', from: 0, to: 1, step: 0, shapes: [{ type: 'circle', fill: true, cx: 'k', cy: 0, radiusAbs: 1 }] },
      { type: 'repeat', var: 'k', from: 0, to: 1, step: -0.1, shapes: [{ type: 'circle', fill: true, cx: 'k', cy: 0, radiusAbs: 1 }] },
    ],
  };
  assert.doesNotThrow(() => drawUnifiedArt(ctx, 26, '#7cc6a0', badRepeat, 'idle', now));

  const noItems = {
    name: 'NoItems',
    states: ['idle'],
    shapes: [{ type: 'forEach', var: ['a', 'b'], shapes: [{ type: 'circle', fill: true, cx: 'a', cy: 'b', radiusAbs: 1 }] }],
  };
  assert.doesNotThrow(() => drawUnifiedArt(ctx, 26, '#7cc6a0', noItems, 'idle', now));
});
