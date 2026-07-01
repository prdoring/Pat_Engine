/**
 * Web Audio node builders for synth voices — stateless: each takes the
 * AudioContext (and any already-resolved buffers/curves) as parameters and
 * returns nodes. The SoundManager owns the instance state (the noise-buffer and
 * distortion-curve memo caches, the shared reverb convolver) and calls these
 * through thin `_build*` wrappers, so per-instance caching and the reverb graph
 * stay in the class while the construction logic lives here. Game-agnostic.
 */

/** Build a 2s mono white-noise buffer for `type:"noise"` layers (caller caches it). */
export function createNoiseBuffer(ctx) {
  const length = Math.floor(ctx.sampleRate * 2);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** WaveShaper curve for a distortion `amount` (0..1). Classic soft-clip shape (caller caches it). */
export function makeDistortionCurve(amount) {
  const k = amount * 400, n = 2048, deg = Math.PI / 180;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

/**
 * Build a BiquadFilter from a resolved filter def and wire `inputNode → filter`.
 * Returns the filter (the new tail) or null when there's no filter def.
 * Used for both the synth-level tone filter and per-noise-layer colouring.
 */
export function buildSynthFilter(ctx, filterDef, inputNode) {
  if (!filterDef) return null;
  const filter = ctx.createBiquadFilter();
  filter.type = filterDef.type || 'lowpass';
  filter.frequency.value = filterDef.freq ?? 2000;
  if (filterDef.q !== undefined) filter.Q.value = filterDef.q;
  inputNode.connect(filter);
  return filter;
}

/** Build a WaveShaper distortion from a precomputed `curve` and wire `inputNode → shaper`. */
export function buildDistortion(ctx, curve, inputNode) {
  const ws = ctx.createWaveShaper();
  ws.curve = curve;
  ws.oversample = '2x';
  inputNode.connect(ws);
  return ws;
}

/**
 * Build a vibrato (pitch LFO) oscillator modulating every oscillator's `detune`
 * (in cents) and start it. Returns the LFO oscillator (caller stops it) or null.
 */
export function buildVibrato(ctx, vibratoDef, oscillators, now) {
  if (!vibratoDef || !oscillators.length) return null;
  const vib = ctx.createOscillator();
  vib.type = 'sine';
  vib.frequency.value = vibratoDef.freq || 5;
  const vibGain = ctx.createGain();
  vibGain.gain.value = vibratoDef.depth || 15; // cents
  vib.connect(vibGain);
  for (const osc of oscillators) vibGain.connect(osc.detune);
  vib.start(now);
  return vib;
}

/**
 * Wire a reverb send: sourceNode → gain(wet) → shared reverb convolver.
 * No-op when there's no reverb graph or `wet` is falsy. Returns the send gain or null.
 */
export function applyReverbSend(ctx, reverbConvolver, sourceNode, wet) {
  if (!reverbConvolver || !wet) return null;
  const reverbSend = ctx.createGain();
  reverbSend.gain.value = wet;
  sourceNode.connect(reverbSend);
  reverbSend.connect(reverbConvolver);
  return reverbSend;
}
