import { test } from 'node:test';
import assert from 'node:assert/strict';

// Validates that every Tier-0 engine module imports cleanly in Node (correct
// moved import paths + path-loader remap + JSON module loading).

test('art + vfx interpreters export their entry points', async () => {
  const art = await import('/engine/render/ArtInterpreter.js');
  assert.equal(typeof art.drawUnifiedArt, 'function');
  const vfx = await import('/engine/render/VFXInterpreter.js');
  assert.equal(typeof vfx.drawPhasedEffect, 'function');
  assert.equal(typeof vfx.drawTrailEffect, 'function');
  assert.equal(typeof vfx.drawBeamEffect, 'function');
});

test('data loaders load JSON and export registries', async () => {
  const vfx = await import('/engine/data/vfx.js');
  assert.equal(typeof vfx.VFX_DEFS, 'object');
  const seq = await import('/engine/data/fxSequences.js');
  assert.equal(typeof seq.FX_SEQUENCES, 'object');
  assert.equal(seq.seqRefToId('engine_start'), 'engineStart');
  const snd = await import('/engine/data/sounds.js');
  assert.equal(typeof snd.SOUND_CONFIG, 'object');
  assert.equal(typeof snd.SoundCategory, 'object');
  assert.equal(typeof snd.SoundId, 'object');
});

test('audio + fx classes construct', async () => {
  const { SoundManager } = await import('/engine/audio/SoundManager.js');
  const sm = new SoundManager(); // no AudioContext until init/resume
  assert.ok(sm);
  const { EntityLoopManager } = await import('/engine/audio/EntityLoopManager.js');
  const elm = new EntityLoopManager(sm);
  assert.equal(elm.size, 0);
  const { FXSequenceRunner } = await import('/engine/fx/FXSequenceRunner.js');
  const runner = new FXSequenceRunner(sm, null, () => {});
  assert.equal(typeof runner.play, 'function');
});

test('physics math is callable', async () => {
  const col = await import('/engine/physics/collision.js');
  assert.equal(col.getCircleOverlap(0, 0, 5, 1, 0, 5).overlap > 0, true);
  assert.equal(col.getCircleOverlap(0, 0, 5, 100, 0, 5), null);
  const phys = await import('/engine/physics/shipPhysics.js');
  assert.equal(typeof phys.applyShipPhysics, 'function');
});
