import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockCtx } from './helpers/mocks.js';

import critterArt from '/data/critter-art.json' with { type: 'json' };
import propArt from '/data/prop-art.json' with { type: 'json' };
import { drawUnifiedArt } from '/engine/render/ArtInterpreter.js';
import { drawPhasedEffect, drawTrailEffect, drawBeamEffect } from '/engine/render/VFXInterpreter.js';
import { buildArtRegistry } from '/engine/data/art.js';
import { VFX_DEFS } from '/engine/data/vfx.js';
import { SOUND_CONFIG } from '/engine/data/sounds.js';
import { FX_SEQUENCES } from '/engine/data/fxSequences.js';
import { FXSequenceRunner } from '/engine/fx/FXSequenceRunner.js';

const now = 12345;

test('every art asset renders in every declared state without throwing', () => {
  const ctx = createMockCtx();
  const reg = buildArtRegistry({ critters: critterArt, props: propArt });
  for (const [collection, assets] of Object.entries(reg)) {
    for (const [id, def] of Object.entries(assets)) {
      const states = [undefined, ...(def.states || [])];
      for (const state of states) {
        assert.doesNotThrow(
          () => drawUnifiedArt(ctx, 26, '#7cc6a0', def, state, now),
          `${collection}/${id} state=${state}`
        );
      }
    }
  }
});

test('every VFX effect renders through the right interpreter entry point', () => {
  const ctx = createMockCtx();
  const points = [
    { sx: 0, sy: 0, timestamp: now - 200, speed: 20 },
    { sx: 10, sy: 5, timestamp: now - 100, speed: 20 },
    { sx: 22, sy: 9, timestamp: now, speed: 20 },
  ];
  for (const [name, def] of Object.entries(VFX_DEFS)) {
    if (def.type === 'phased') {
      const progress = def.lifecycle === 'persistent' ? null : 0.5;
      assert.doesNotThrow(
        () => drawPhasedEffect(ctx, 0, 0, def, progress, def.defaultScale || 1, now),
        `phased ${name}`
      );
    } else if (def.type === 'bubbleTrail' || def.type === 'taperedTrail') {
      assert.doesNotThrow(() => drawTrailEffect(ctx, def, points, now), `trail ${name}`);
    } else if (def.type === 'wiggleBeam') {
      assert.doesNotThrow(() => drawBeamEffect(ctx, def, 0, 0, 100, 40, now), `beam ${name}`);
    } else {
      assert.fail(`Unknown VFX type for ${name}: ${def.type}`);
    }
  }
});

test('sfx catalog is structurally valid', () => {
  for (const [id, cfg] of Object.entries(SOUND_CONFIG)) {
    assert.equal(typeof cfg.volume, 'number', `${id}.volume`);
    assert.equal(typeof cfg.category, 'string', `${id}.category`);
    assert.ok(cfg.synth, `${id}.synth`);
    const layers = cfg.synth.layers || [cfg.synth];
    for (const l of layers) {
      const t = l.type || 'sine';
      assert.ok(['sine', 'square', 'sawtooth', 'triangle', 'file', 'noise'].includes(t), `${id} layer type ${t}`);
      if (t === 'file') assert.ok(l.file?.startsWith('/SFX/'), `${id} file path`);
    }
  }
});

test('every sequence plays without throwing and dispatches its immediate steps', () => {
  for (const [seqId, seq] of Object.entries(FX_SEQUENCES)) {
    const sfxCalls = [];
    const vfxCalls = [];
    const signalCalls = [];
    const loops = [];
    const sound = {
      playUI: (id) => sfxCalls.push(id),
      playPositional: (id) => sfxCalls.push(id),
      startLoop: (id) => { loops.push(id); return loops.length; },
      startUILoop: (id) => { loops.push(id); return loops.length; },
      stopLoop: () => {},
    };
    const effects = { addGenericEffect: (def) => vfxCalls.push(def) };
    const runner = new FXSequenceRunner(sound, effects, (name, data, opts) => signalCalls.push({ name, data, opts }));

    assert.doesNotThrow(
      () => runner.play(seqId, { x: 100, y: 100, angle: 0, entity: { id: 'e1' } }),
      `play ${seqId}`
    );

    // Steps with delay 0 must have dispatched synchronously.
    const immediate = seq.steps.filter(s => (s.delay || 0) === 0);
    for (const step of immediate) {
      if (step.type === 'sfx') assert.ok(sfxCalls.includes(step.sound), `${seqId}: sfx ${step.sound}`);
      if (step.type === 'vfx') assert.ok(vfxCalls.length > 0, `${seqId}: vfx ${step.effect}`);
      if (step.type === 'signal') assert.ok(signalCalls.some(s => s.name === step.name), `${seqId}: signal ${step.name}`);
    }
    runner.stopAll(); // clear any pending timers so they don't fire after the test
  }
});

test('vfx effects referenced by sequences exist', () => {
  for (const [seqId, seq] of Object.entries(FX_SEQUENCES)) {
    for (const step of seq.steps) {
      if (step.type === 'vfx') assert.ok(VFX_DEFS[step.effect], `${seqId} → missing vfx ${step.effect}`);
      if (step.type === 'sfx' || step.type === 'loopStart') {
        assert.ok(SOUND_CONFIG[step.sound], `${seqId} → missing sound ${step.sound}`);
      }
    }
  }
});
