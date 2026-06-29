import { test } from 'node:test';
import assert from 'node:assert/strict';

// Validates the synth-definition resolver for the expanded synth DSP: vibrato
// (pitch LFO), distortion, a synth-level tone filter, and noise layers — including
// [min,max] randomization. `_resolveSynth` is pure (no AudioContext), so these
// run headless in Node like the rest of the engine smoke tests.

const { SoundManager } = await import('/engine/audio/SoundManager.js');
const sm = new SoundManager(); // no AudioContext needed for _resolveSynth

test('vibrato resolves fixed freq/depth', () => {
  const r = sm._resolveSynth({ vibrato: { freq: 5, depth: 20 } });
  assert.equal(r.vibrato.freq, 5);
  assert.equal(r.vibrato.depth, 20);
});

test('vibrato resolves [min,max] ranges within bounds', () => {
  for (let i = 0; i < 50; i++) {
    const r = sm._resolveSynth({ vibrato: { freq: [4, 6], depth: [10, 30] } });
    assert.ok(r.vibrato.freq >= 4 && r.vibrato.freq <= 6, `freq ${r.vibrato.freq}`);
    assert.ok(r.vibrato.depth >= 10 && r.vibrato.depth <= 30, `depth ${r.vibrato.depth}`);
  }
});

test('distortion resolves as a fixed value and a [min,max] range', () => {
  assert.equal(sm._resolveSynth({ distortion: 0.3 }).distortion, 0.3);
  for (let i = 0; i < 30; i++) {
    const r = sm._resolveSynth({ distortion: [0.1, 0.5] });
    assert.ok(r.distortion >= 0.1 && r.distortion <= 0.5, `distortion ${r.distortion}`);
  }
});

test('synth-level filter resolves type + randomized freq/q', () => {
  const fixed = sm._resolveSynth({ filter: { type: 'lowpass', freq: 2000, q: 1.5 } });
  assert.equal(fixed.filter.type, 'lowpass');
  assert.equal(fixed.filter.freq, 2000);
  assert.equal(fixed.filter.q, 1.5);

  for (let i = 0; i < 50; i++) {
    const r = sm._resolveSynth({ filter: { type: 'bandpass', freq: [800, 1200] } });
    assert.equal(r.filter.type, 'bandpass');
    assert.ok(r.filter.freq >= 800 && r.filter.freq <= 1200, `freq ${r.filter.freq}`);
  }
});

test('noise layer resolves gain + optional colour filter', () => {
  const r = sm._resolveSynth({
    layers: [{ type: 'noise', gain: 0.5, filter: { type: 'bandpass', freq: [400, 600], q: 2 } }],
  });
  const layer = r.layers[0];
  assert.equal(layer.type, 'noise');
  assert.equal(layer.gain, 0.5);
  assert.equal(layer.filter.type, 'bandpass');
  assert.ok(layer.filter.freq >= 400 && layer.filter.freq <= 600, `freq ${layer.filter.freq}`);
  assert.equal(layer.filter.q, 2);
  // Noise layers must not leak oscillator-only fields.
  assert.equal(layer.freq, undefined);
});

test('mixed oscillator + noise layers both survive resolution', () => {
  const r = sm._resolveSynth({
    layers: [
      { type: 'sawtooth', freq: 220, gain: 0.4, detune: 4 },
      { type: 'noise', gain: [0.2, 0.3] },
    ],
    filter: { type: 'lowpass', freq: 2600 },
    vibrato: { freq: 5.5, depth: 18 },
  });
  assert.equal(r.layers[0].type, 'sawtooth');
  assert.equal(r.layers[0].freq, 220);
  assert.equal(r.layers[1].type, 'noise');
  assert.ok(r.layers[1].gain >= 0.2 && r.layers[1].gain <= 0.3);
  assert.equal(r.filter.freq, 2600);
  assert.equal(r.vibrato.depth, 18);
});
