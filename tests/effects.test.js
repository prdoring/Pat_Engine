import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockCtx } from './helpers/mocks.js';

// A ctx that records every moveTo/lineTo coordinate so we can assert finiteness.
function createRecordingCtx() {
  const ctx = createMockCtx();
  const coords = [];
  ctx.moveTo = (x, y) => { coords.push(x, y); };
  ctx.lineTo = (x, y) => { coords.push(x, y); };
  ctx._coords = coords;
  return ctx;
}

// A ctx that records every fillStyle assignment (spy on the setter).
function createFillSpyCtx() {
  const ctx = createMockCtx();
  const assigned = [];
  let value = ctx.fillStyle;
  Object.defineProperty(ctx, 'fillStyle', {
    get() { return value; },
    set(v) { value = v; assigned.push(v); },
    configurable: true,
  });
  ctx._fillAssigned = assigned;
  return ctx;
}

// ─── Bug #1: tether beam with a STRING entity id must not produce NaN ─────────
test('drawBeamEffect: string entityId yields only finite coordinates', async () => {
  const { drawBeamEffect } = await import('/engine/render/VFXInterpreter.js');
  const { VFX_DEFS } = await import('/engine/data/vfx.js');
  const def = VFX_DEFS.tether;
  assert.ok(def, 'tether def exists');

  const ctx = createRecordingCtx();
  // STRING id — the regression: Number coercion of "c12" is NaN, must fall back to 0.
  drawBeamEffect(ctx, def, 0, 0, 300, 120, 1234, { entityId: 'c12' });

  assert.ok(ctx._coords.length > 0, 'beam emitted line segments');
  for (const v of ctx._coords) {
    assert.ok(Number.isFinite(v), `coordinate must be finite, got ${v}`);
  }
});

// ─── Bug #2: bubble trail color resolves (no undefined) with empty opts ───────
test('drawTrailEffect: bubble trail never assigns an undefined fillStyle (empty opts)', async () => {
  const { drawTrailEffect } = await import('/engine/render/VFXInterpreter.js');
  const { VFX_DEFS } = await import('/engine/data/vfx.js');
  const def = VFX_DEFS.trailWander;
  assert.ok(def, 'trailWander def exists');

  const ctx = createFillSpyCtx();
  const now = 1000;
  const points = [
    { sx: 0, sy: 0, timestamp: now, speed: 50 },
    { sx: 10, sy: 5, timestamp: now, speed: 50 },
  ];
  drawTrailEffect(ctx, def, points, now, {}); // empty opts → treated as LOCAL

  assert.ok(ctx._fillAssigned.length > 0, 'fillStyle was assigned at least once');
  for (const c of ctx._fillAssigned) {
    assert.notEqual(c, undefined, 'fillStyle must never be undefined');
    assert.equal(typeof c, 'string', `fillStyle must be a string, got ${typeof c}`);
  }
});

// ─── Bug #2: resolveColor defaults to local when no opts ──────────────────────
test('resolveColor({local,remote}) with no opts returns local and does not throw', async () => {
  const { resolveColor } = await import('/engine/render/VFXInterpreter.js');
  assert.equal(resolveColor({ local: '#a', remote: '#b' }), '#a');
  // Explicit remote variant still works.
  assert.equal(resolveColor({ local: '#a', remote: '#b' }, { isLocal: false }), '#b');
  // Fallback when a variant is missing.
  assert.equal(resolveColor({ remote: '#b' }), '#b');
});

// ─── Bug #5: generic effects can be removed by id ─────────────────────────────
test('EffectsManager: addGenericEffect with id then removeGenericEffect empties the list', async () => {
  const { EffectsManager } = await import('/engine/fx/EffectsManager.js');
  const fx = new EffectsManager();
  const persistentDef = { type: 'phased' }; // no duration → persistent
  fx.addGenericEffect(persistentDef, 0, 0, { id: 'x', now: 0 });
  assert.equal(fx.getGenericEffects(0).length, 1);
  assert.equal(fx.getGenericEffects(0)[0].id, 'x');

  fx.removeGenericEffect('x');
  assert.equal(fx.getGenericEffects(0).length, 0);
});
