import { test } from 'node:test';
import assert from 'node:assert/strict';

test('all Tier-1 bridge modules import in Node', async () => {
  await import('/engine/core/Game.js');
  await import('/engine/core/Scene.js');
  await import('/engine/core/VolumeControl.js');
  await import('/engine/render/EffectsRenderer.js');
  await import('/engine/render/BackgroundRenderer.js');
  await import('/engine/fx/EffectsManager.js');
  await import('/engine/data/art.js');
});

test('buildArtRegistry unwraps, flattens, and deep-clones', async () => {
  const { buildArtRegistry, getAsset } = await import('/engine/data/art.js');
  const critters = { critters: { blob: { name: 'Blob', shapes: [] } } }; // wrapped
  const props = { flower: { name: 'Flower', shapes: [] } };               // flat
  const reg = buildArtRegistry({ critters, props });
  assert.equal(reg.critters.blob.name, 'Blob');
  assert.equal(reg.props.flower.name, 'Flower');
  // Deep clone: mutating the registry must not touch the source.
  reg.critters.blob.name = 'Changed';
  assert.equal(critters.critters.blob.name, 'Blob');
  assert.equal(getAsset(reg, 'critters', 'blob').name, 'Changed');
  assert.equal(getAsset(reg, 'critters', 'nope'), null);
});

test('EffectsManager: trail emit + prune by length', async () => {
  const { EffectsManager } = await import('/engine/fx/EffectsManager.js');
  const fx = new EffectsManager();
  const def = { type: 'bubbleTrail', pointLifetime: 100000, maxLength: 3 };
  for (let i = 0; i < 6; i++) fx.emitTrail('a', i, 0, 1000 + i, { speed: 1 }, def);
  fx.update(2000);
  const trails = fx.getTrails();
  assert.equal(trails.length, 1);
  assert.ok(trails[0].points.length <= 3, `expected <=3 points, got ${trails[0].points.length}`);
});

test('EffectsManager: trail prunes by lifetime then drops empty', async () => {
  const { EffectsManager } = await import('/engine/fx/EffectsManager.js');
  const fx = new EffectsManager();
  fx.emitTrail('a', 0, 0, 0, {}, { pointLifetime: 50, maxLength: 100 });
  fx.update(1000); // way past lifetime → pruned → entry removed
  assert.equal(fx.getTrails().length, 0);
});

test('EffectsManager: generic effect progress + debris spawn', async () => {
  const { EffectsManager } = await import('/engine/fx/EffectsManager.js');
  const fx = new EffectsManager();
  const def = { type: 'phased', duration: 1000, debris: [{ count: 5, speed: 50, lifetime: 500, size: 3, color: '#fff' }] };
  fx.addGenericEffect(def, 10, 20, { now: 0 });
  const effects = fx.getGenericEffects(500);
  assert.equal(effects.length, 1);
  assert.ok(Math.abs(effects[0].progress - 0.5) < 1e-9);
  assert.equal(fx.getDebris(0).length, 5);
  // After duration elapses, the effect is cleaned up.
  fx.update(2000);
  assert.equal(fx.getGenericEffects(2000).length, 0);
});

test('persistent effect (no duration) reports null progress and is not culled', async () => {
  const { EffectsManager } = await import('/engine/fx/EffectsManager.js');
  const fx = new EffectsManager();
  fx.addGenericEffect({ type: 'phased' }, 0, 0, { now: 0 });
  fx.update(99999);
  const effects = fx.getGenericEffects(99999);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].progress, null);
});

test('shipPhysics: thrust moves the body along its heading', async () => {
  const { applyShipPhysics } = await import('/engine/physics/shipPhysics.js');
  const ship = { x: 100, y: 100, vx: 0, vy: 0, angle: 0 };
  const stats = { thrustForce: 200, maxSpeed: 300, rotationSpeed: 3, forwardDrag: 0.99, lateralDrag: 0.8 };
  applyShipPhysics(ship, { thrust: true }, 0.1, stats, { width: 4000, height: 4000 });
  assert.ok(ship.x > 100, 'should have moved +x at angle 0');
  assert.ok(Math.abs(ship.y - 100) < 1e-6, 'no lateral drift at angle 0');
});

test('shipPhysics: rotation input changes heading in the right direction', async () => {
  const { applyShipPhysics } = await import('/engine/physics/shipPhysics.js');
  const stats = { thrustForce: 0, maxSpeed: 300, rotationSpeed: 3, forwardDrag: 0.99, lateralDrag: 0.8 };
  const right = { x: 0, y: 0, vx: 0, vy: 0, angle: 1 };
  applyShipPhysics(right, { rotateRight: true }, 0.1, stats);
  assert.ok(right.angle > 1, 'rotateRight increases angle');
  const left = { x: 0, y: 0, vx: 0, vy: 0, angle: 1 };
  applyShipPhysics(left, { rotateLeft: true }, 0.1, stats);
  assert.ok(left.angle < 1, 'rotateLeft decreases angle');
  // Angle stays normalized to [0, 2*PI).
  assert.ok(right.angle >= 0 && right.angle < Math.PI * 2);
});

test('shipPhysics: thrust accelerates along heading (velocity check)', async () => {
  const { applyShipPhysics } = await import('/engine/physics/shipPhysics.js');
  const stats = { thrustForce: 200, maxSpeed: 300, rotationSpeed: 3, forwardDrag: 0.99, lateralDrag: 0.8 };
  const ship = { x: 0, y: 0, vx: 0, vy: 0, angle: Math.PI / 2 }; // facing +y
  applyShipPhysics(ship, { thrust: true }, 0.1, stats, { width: 4000, height: 4000 });
  assert.ok(ship.vy > 0, 'gains +y velocity facing +y');
  assert.ok(Math.abs(ship.vx) < 1e-6, 'no +x velocity facing +y');
});

test('shipPhysics: speed never exceeds maxSpeed cap', async () => {
  const { applyShipPhysics } = await import('/engine/physics/shipPhysics.js');
  const stats = { thrustForce: 200, maxSpeed: 300, rotationSpeed: 3, forwardDrag: 0.99, lateralDrag: 0.99 };
  // Start well over the cap; one tick must clamp it (drag then trims further).
  const ship = { x: 100, y: 100, vx: 5000, vy: 0, angle: 0 };
  applyShipPhysics(ship, {}, 0.1, stats, { width: 100000, height: 100000 });
  const speed = Math.hypot(ship.vx, ship.vy);
  assert.ok(speed <= stats.maxSpeed + 1e-6, `speed ${speed} should be capped at ${stats.maxSpeed}`);
});

test('shipPhysics: drag is frame-rate independent (two half-steps ≈ one full step)', async () => {
  const { applyShipPhysics } = await import('/engine/physics/shipPhysics.js');
  // Coasting body, no input, velocity aligned with heading so all drag is forward.
  const stats = { thrustForce: 0, maxSpeed: 1000, rotationSpeed: 0, forwardDrag: 0.96, lateralDrag: 0.85 };
  const bounds = { width: 100000, height: 100000 };
  const full = { x: 0, y: 0, vx: 100, vy: 0, angle: 0 };
  applyShipPhysics(full, {}, 0.1, stats, bounds);
  const half = { x: 0, y: 0, vx: 100, vy: 0, angle: 0 };
  applyShipPhysics(half, {}, 0.05, stats, bounds);
  applyShipPhysics(half, {}, 0.05, stats, bounds);
  // Velocity decay is exact under exponential (60 Hz referenced) drag.
  assert.ok(Math.abs(full.vx - half.vx) < 1e-9, `vx ${full.vx} vs ${half.vx}`);
  // Position differs only by Euler integration error — keep tolerance loose.
  assert.ok(Math.abs(full.x - half.x) < 1, `x ${full.x} vs ${half.x}`);
});

test('collision: resolveElasticCollision defaults restitution (no NaN)', async () => {
  const { resolveElasticCollision } = await import('/engine/physics/collision.js');
  const a = { x: 0, y: 0, vx: 50, vy: 0 };
  const b = { x: 8, y: 0, vx: -50, vy: 0 };
  const res = resolveElasticCollision(a, 5, b, 5); // no restitution arg
  assert.ok(res, 'overlapping bodies resolve');
  assert.ok(Number.isFinite(a.vx) && Number.isFinite(b.vx), 'velocities stay finite');
  assert.ok(a.vx < 50 && b.vx > -50, 'approaching bodies are slowed/reversed');
});

test('Camera worldToScreen centers on the viewport', async () => {
  const { Camera } = await import('/engine/core/Camera.js');
  const cam = new Camera({ width: 800, height: 600 });
  const { sx, sy } = cam.worldToScreen(0, 0);
  assert.equal(sx, 400);
  assert.equal(sy, 300);
});

test('Camera zoom: world/screen round-trips and zoomAt anchors the cursor point', async () => {
  const { Camera } = await import('/engine/core/Camera.js');
  const cam = new Camera({ width: 800, height: 600 });
  cam.x = 100; cam.y = 50; cam.setZoom(2);
  // round-trip
  const s = cam.worldToScreen(130, 70);
  const w = cam.screenToWorld(s.sx, s.sy);
  assert.ok(Math.abs(w.x - 130) < 1e-6 && Math.abs(w.y - 70) < 1e-6);
  // zoomAt keeps the world point under (sx,sy) fixed
  const sx = 600, sy = 200;
  const worldBefore = cam.screenToWorld(sx, sy);
  cam.zoomAt(1.5, sx, sy);
  const worldAfter = cam.screenToWorld(sx, sy);
  assert.ok(Math.abs(worldBefore.x - worldAfter.x) < 1e-6, 'x anchor');
  assert.ok(Math.abs(worldBefore.y - worldAfter.y) < 1e-6, 'y anchor');
  // clamp
  cam.setZoom(999);
  assert.ok(cam.getZoom() <= cam.maxZoom);
});
