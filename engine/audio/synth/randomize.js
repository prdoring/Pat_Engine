/**
 * Synth-definition randomization: resolve `[min, max]` range arrays to concrete
 * numbers (per-trigger variation). Pure — no Web Audio, no `this`. The
 * SoundManager exposes these via thin `_resolve*` delegating methods so callers
 * (and the soundboard editor / tests) keep the same instance-method surface.
 */

/** Resolve a value that may be a number or a [min, max] range array. */
export function resolveValue(v) {
  if (Array.isArray(v)) return v[0] + Math.random() * (v[1] - v[0]);
  return v;
}

/** Resolve a filter sub-def ({type, freq?, q?}), randomizing freq/q ranges. */
export function resolveFilter(filterDef) {
  const r = { type: filterDef.type };
  if (filterDef.freq !== undefined) r.freq = resolveValue(filterDef.freq);
  if (filterDef.q !== undefined) r.q = resolveValue(filterDef.q);
  return r;
}

/** Deep-clone a synth definition, resolving any [min, max] ranges to concrete numbers. */
export function resolveSynth(synthDef) {
  const resolved = {};

  // Top-level numeric params
  for (const key of ['freq', 'freqEnd', 'duration', 'attack', 'decay', 'detune', 'reverb', 'distortion']) {
    if (synthDef[key] !== undefined) resolved[key] = resolveValue(synthDef[key]);
  }

  // Pass through non-randomizable params
  if (synthDef.type) resolved.type = synthDef.type;

  // Layers
  if (synthDef.layers) {
    resolved.layers = synthDef.layers.map(layer => {
      const r = {};
      if (layer.type) r.type = layer.type;

      if (layer.type === 'file') {
        // File layer — pass through path, resolve randomizable gain/playbackRate
        r.file = layer.file;
        if (layer.gain !== undefined) r.gain = resolveValue(layer.gain);
        if (layer.playbackRate !== undefined) r.playbackRate = resolveValue(layer.playbackRate);
      } else if (layer.type === 'noise') {
        // Noise layer — resolve gain + optional shaping filter
        if (layer.gain !== undefined) r.gain = resolveValue(layer.gain);
        if (layer.filter) r.filter = resolveFilter(layer.filter);
      } else {
        // Oscillator layer
        for (const key of ['freq', 'freqEnd', 'gain', 'detune']) {
          if (layer[key] !== undefined) r[key] = resolveValue(layer[key]);
        }
      }
      return r;
    });
  }

  // LFO (amplitude/tremolo)
  if (synthDef.lfo) {
    resolved.lfo = {};
    if (synthDef.lfo.freq !== undefined) resolved.lfo.freq = resolveValue(synthDef.lfo.freq);
    if (synthDef.lfo.depth !== undefined) resolved.lfo.depth = resolveValue(synthDef.lfo.depth);
  }

  // Vibrato (pitch LFO — depth in cents)
  if (synthDef.vibrato) {
    resolved.vibrato = {};
    if (synthDef.vibrato.freq !== undefined) resolved.vibrato.freq = resolveValue(synthDef.vibrato.freq);
    if (synthDef.vibrato.depth !== undefined) resolved.vibrato.depth = resolveValue(synthDef.vibrato.depth);
  }

  // Synth-level tone filter
  if (synthDef.filter) resolved.filter = resolveFilter(synthDef.filter);

  return resolved;
}
