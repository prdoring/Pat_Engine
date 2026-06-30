import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockCtx } from './helpers/mocks.js';

// Render-path tests for keyframe-animation sampling inside drawUnifiedArt:
// clone isolation (never mutate / throw on frozen art), dotted-path application,
// per-clip epoch (ambient loops don't reset on a state change), and play-once
// epoch + replay. Drives the interpreter headlessly via a recording mock ctx.

const { drawUnifiedArt } = await import('/engine/render/ArtInterpreter.js');

function deepFreeze(o) {
  if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
}
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
function arcRecorder() { const arcs = []; const ctx = createMockCtx(); ctx.arc = (cx, cy, rad) => arcs.push({ cx, cy, rad }); return { ctx, arcs }; }

test('keyframed radiusAbs reaches the canvas at the interpolated value', () => {
  const asset = {
    name: 'Pulse', states: ['idle'],
    animations: { '*': { duration: 2000, loop: true } },
    shapes: [{
      type: 'circle', fill: true, cx: 0, cy: 0, radiusAbs: { base: 99 },
      anim: { '*': { radiusAbs: [{ t: 0, v: { base: 10 } }, { t: 1000, v: { base: 20 } }] } },
    }],
  };
  const { ctx, arcs } = arcRecorder();
  drawUnifiedArt(ctx, 10, '#fff', asset, 'idle', 500); // localT 500 → base 15
  assert.equal(arcs.length, 1);
  approx(arcs[0].rad, 15);
});

test('does not mutate (or throw on) a deep-frozen asset — clone isolation', () => {
  const asset = deepFreeze({
    name: 'Frozen', states: ['idle', 'happy'],
    animations: { '*': { duration: 2000, loop: true } },
    shapes: [{
      type: 'path', stroke: true, closed: true,
      points: [[-0.4, 0.4], [0.4, 0.4], [0, -0.4]],
      setup: { alpha: 1 },
      anim: { '*': { 'points.2': [{ t: 0, v: [0, -0.4] }, { t: 1000, v: [0, -0.8] }], 'setup.alpha': [{ t: 0, v: 1 }, { t: 1000, v: 0.4 }] } },
    }],
  });
  const before = JSON.parse(JSON.stringify(asset));
  const ctx = createMockCtx();
  for (const now of [0, 250, 500, 1500]) {
    assert.doesNotThrow(() => drawUnifiedArt(ctx, 10, '#fff', asset, 'idle', now));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(asset)), before, 'asset must be untouched after draw');
});

test('dotted path points.N moves the right vertex, leaving siblings untouched', () => {
  const asset = {
    name: 'Vertex', states: ['idle'],
    animations: { '*': { duration: 1000, loop: true } },
    shapes: [{
      type: 'path', stroke: true,
      points: [[-0.4, 0.4], [0.4, 0.4], [0, -0.4]],
      anim: { '*': { 'points.2': [{ t: 0, v: [0, -0.4] }, { t: 1000, v: [0, -0.8] }] } },
    }],
  };
  const moves = []; const lines = [];
  const ctx = createMockCtx();
  ctx.moveTo = (x, y) => moves.push([x, y]);
  ctx.lineTo = (x, y) => lines.push([x, y]);
  drawUnifiedArt(ctx, 10, '#fff', asset, 'idle', 500); // points[2] → [0,-0.6]
  // moveTo points[0]; lineTo points[1] (unchanged); lineTo points[2] (keyframed)
  approx(moves[0][0], -4); approx(moves[0][1], 4);
  approx(lines[0][0], 4); approx(lines[0][1], 4);   // sibling vertex untouched
  approx(lines[1][0], 0); approx(lines[1][1], -6);  // keyframed vertex
});

test('dotted path setup.alpha is applied to the context', () => {
  const asset = {
    name: 'Fade', states: ['idle'],
    animations: { '*': { duration: 1000, loop: true } },
    shapes: [{
      type: 'circle', fill: true, cx: 0, cy: 0, radiusAbs: 5, setup: { alpha: 1 },
      anim: { '*': { 'setup.alpha': [{ t: 0, v: 1 }, { t: 1000, v: 0 }] } },
    }],
  };
  const alphas = [];
  const ctx = createMockCtx();
  Object.defineProperty(ctx, 'globalAlpha', { set(v) { alphas.push(v); }, get() { return 1; }, configurable: true });
  drawUnifiedArt(ctx, 10, '#fff', asset, 'idle', 250); // alpha → 0.75
  assert.ok(alphas.some((a) => Math.abs(a - 0.75) < 1e-9), `expected 0.75 in ${alphas}`);
});

test('ambient "*" clip uses epoch 0 — it does NOT reset on a state change', () => {
  const asset = {
    name: 'Ambient', states: ['idle', 'happy'],
    animations: { '*': { duration: 2000, loop: true } },
    shapes: [{
      type: 'circle', fill: true, cx: 0, cy: 0, radiusAbs: { base: 99 },
      anim: { '*': { radiusAbs: [{ t: 0, v: { base: 10 } }, { t: 1000, v: { base: 30 } }, { t: 2000, v: { base: 10 } }] } },
    }],
  };
  const transition = {};
  // First draw establishes idle; then a state change to happy at now=600.
  let r = arcRecorder(); drawUnifiedArt(r.ctx, 10, '#fff', asset, 'idle', 500, transition);
  r = arcRecorder(); drawUnifiedArt(r.ctx, 10, '#fff', asset, 'happy', 600, transition);
  // Ambient localT must be 600 (continuous), so base = 10 + 20*(600/1000) = 22 — NOT reset to 10.
  approx(r.arcs[0].rad, 22);
});

test('play-once state clip keys off startTime, holds the end, and replays on epoch reset', () => {
  const asset = {
    name: 'Cheer', states: ['idle', 'happy'],
    animations: { happy: { duration: 1000, loop: false } },
    shapes: [{
      type: 'circle', fill: true, cx: 0, cy: { base: 0 }, radiusAbs: 5,
      anim: { happy: { cy: [{ t: 0, v: { base: 0 } }, { t: 1000, v: { base: 10 } }] } },
    }],
  };
  const transition = {};
  // Enter happy at now=1000 → startTime=1000, localT=0 → cy 0.
  let r = arcRecorder(); drawUnifiedArt(r.ctx, 10, '#fff', asset, 'happy', 1000, transition);
  approx(r.arcs[0].cy, 0);
  // Mid-clip.
  r = arcRecorder(); drawUnifiedArt(r.ctx, 10, '#fff', asset, 'happy', 1500, transition);
  approx(r.arcs[0].cy, 5);
  // Past the end → held at the final frame.
  r = arcRecorder(); drawUnifiedArt(r.ctx, 10, '#fff', asset, 'happy', 3000, transition);
  approx(r.arcs[0].cy, 10);
  // Replay (restartClip stamps a fresh epoch) → back to t=0.
  transition.startTime = 3000;
  r = arcRecorder(); drawUnifiedArt(r.ctx, 10, '#fff', asset, 'happy', 3000, transition);
  approx(r.arcs[0].cy, 0);
});

test('editor scrub override (transition.animTime) pins a per-clip local time', () => {
  const asset = {
    name: 'Scrub', states: ['idle'],
    animations: { '*': { duration: 2000, loop: true } },
    shapes: [{
      type: 'circle', fill: true, cx: 0, cy: 0, radiusAbs: { base: 99 },
      anim: { '*': { radiusAbs: [{ t: 0, v: { base: 10 } }, { t: 1000, v: { base: 30 } }] } },
    }],
  };
  const { ctx, arcs } = arcRecorder();
  drawUnifiedArt(ctx, 10, '#fff', asset, 'idle', 999999, { animTime: { '*': 250 } });
  approx(arcs[0].rad, 15); // pinned to localT 250 regardless of `now`
});
