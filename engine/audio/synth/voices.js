/**
 * Synth voice construction: build a one-shot voice from a synth def, and render
 * MIDI-tune notes through a voice.
 *
 * Stateless: every function takes a `kit` bundling the AudioContext, the loaded
 * `buffers` Map, the shared `reverbConvolver`, and the SoundManager's stateful
 * node-builder methods (buildVoiceTail / buildNoiseLayer / buildVibrato /
 * applyReverbSend — they close over the instance's caches + reverb graph). The
 * class exposes `_buildSynthOneShot` / `_renderMidiNote` / `_renderMidiNotes`
 * thin wrappers that pass this kit, preserving the original instance surface.
 */

import { resolveSynth } from './randomize.js';
import { transposeSynth, midiVoiceSetup, midiNotesFor } from './midiVoice.js';

/**
 * Build a one-shot synth voice: layers (oscillator/noise/file) → shared envelope →
 * distortion/filter tail → outputNode, with optional vibrato, LFO, and reverb send.
 * Returns { oscillators, sources, gain: envelope, endTime }.
 */
export function buildSynthOneShot(kit, rawSynthDef, peakVolume, outputNode, startAt) {
  const { ctx, buffers, reverbConvolver, buildVoiceTail, buildNoiseLayer, buildVibrato, applyReverbSend } = kit;
  const synthDef = resolveSynth(rawSynthDef);
  // `startAt` lets MIDI notes schedule ahead on the audio clock; default = immediate.
  const now = startAt ?? ctx.currentTime;

  // Build layer list (backward compat: single-oscillator shorthand)
  const layers = synthDef.layers || [{
    type: synthDef.type || 'sine',
    freq: synthDef.freq || 440,
    freqEnd: synthDef.freqEnd,
    gain: 1.0,
    detune: synthDef.detune || 0,
  }];

  // Determine if envelope shaping is needed:
  // - Oscillator layers always need an envelope (they'd play forever otherwise)
  // - File-only layers with no explicit timing play at constant volume naturally
  const hasOscLayers = layers.some(l => l.type !== 'file');
  const hasExplicitEnvelope = synthDef.duration !== undefined ||
                              synthDef.attack !== undefined ||
                              synthDef.decay !== undefined;
  const useEnvelope = hasOscLayers || hasExplicitEnvelope;

  // Auto-detect duration: explicit > longest file buffer > 0.5s default
  let duration = synthDef.duration;
  if (!duration) {
    const fileDurations = layers
      .filter(l => l.type === 'file')
      .map(l => { const b = buffers.get(l.file); return b ? b.duration : 0; });
    duration = fileDurations.length > 0 ? Math.max(...fileDurations) : 0.5;
  }

  const attack = synthDef.attack || 0.005;
  const decay = synthDef.decay || (duration - attack);

  // Envelope gain node — shaped or flat depending on layer composition
  const envelope = ctx.createGain();
  if (useEnvelope) {
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(peakVolume, now + attack);
    envelope.gain.exponentialRampToValueAtTime(0.001, now + attack + decay);
  } else {
    // Flat gain — file layers play at natural volume, no fade
    envelope.gain.value = peakVolume;
  }
  // Post-envelope chain: distortion (guitar-amp grit) → tone filter. Tail feeds dry + reverb.
  const tail = buildVoiceTail(synthDef, envelope);
  tail.connect(outputNode);

  // Build layers — oscillators, noise, and file buffer sources share the same envelope
  const oscillators = [];
  const sources = [];
  for (const layer of layers) {
    if (layer.type === 'file') {
      // ── File layer ──
      const buffer = buffers.get(layer.file);
      if (!buffer) continue;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = layer.playbackRate || 1;

      if (layer.gain !== undefined && layer.gain !== 1.0) {
        const layerGain = ctx.createGain();
        layerGain.gain.value = layer.gain;
        source.connect(layerGain);
        layerGain.connect(envelope);
      } else {
        source.connect(envelope);
      }

      source.start(now);
      // Only force-stop files if envelope is shaping the duration
      if (useEnvelope) source.stop(now + duration + 0.05);
      sources.push(source);
    } else if (layer.type === 'noise') {
      // ── Noise layer ── (loops the noise buffer; envelope shapes it)
      const source = buildNoiseLayer(layer, envelope);
      source.start(now);
      if (useEnvelope) source.stop(now + duration + 0.05);
      sources.push(source);
    } else {
      // ── Oscillator layer ──
      const osc = ctx.createOscillator();
      osc.type = layer.type || 'sine';
      osc.frequency.setValueAtTime(layer.freq || 440, now);
      if (layer.freqEnd) {
        osc.frequency.exponentialRampToValueAtTime(layer.freqEnd, now + duration);
      }
      if (layer.detune) osc.detune.value = layer.detune;

      if (layer.gain !== undefined && layer.gain !== 1.0) {
        const layerGain = ctx.createGain();
        layerGain.gain.value = layer.gain;
        osc.connect(layerGain);
        layerGain.connect(envelope);
      } else {
        osc.connect(envelope);
      }

      osc.start(now);
      osc.stop(now + duration + 0.05);
      oscillators.push(osc);
    }
  }

  // Optional vibrato (pitch LFO) — modulates oscillator detune in cents.
  const vib = buildVibrato(synthDef.vibrato, oscillators, now);
  if (vib) vib.stop(now + duration + 0.05);

  // Optional LFO gain modulation (warble/pulse effect)
  if (synthDef.lfo) {
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = synthDef.lfo.freq || 4;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = peakVolume * (synthDef.lfo.depth || 0.5);
    lfo.connect(lfoGain);
    lfoGain.connect(envelope.gain);
    lfo.start(now);
    // Always stop the LFO — a file-only layer set (useEnvelope false) would
    // otherwise leak the oscillator forever. `duration` is defined on all paths.
    lfo.stop(now + duration + 0.05);
  }

  // Reverb send — split dry/wet so total volume stays constant
  if (synthDef.reverb && reverbConvolver) {
    const wet = typeof synthDef.reverb === 'number' ? synthDef.reverb : 0.4;
    const dryScale = 1 - wet * 0.5;
    if (useEnvelope) {
      envelope.gain.cancelScheduledValues(now);
      envelope.gain.setValueAtTime(0, now);
      envelope.gain.linearRampToValueAtTime(peakVolume * dryScale, now + attack);
      envelope.gain.exponentialRampToValueAtTime(0.001, now + attack + decay);
    } else {
      envelope.gain.value = peakVolume * dryScale;
    }

    // Tap the wet send post-filter so reverb is coloured by the tone filter too.
    applyReverbSend(tail, wet * peakVolume);
  }

  return { oscillators, sources, gain: envelope, endTime: now + duration };
}

/** Build ONE transposed voice for a MIDI note at absolute `when`. Returns {oscillators,sources,endTime}. */
export function renderMidiNote(kit, setup, note, peakVolume, outputNode, when, suppressReverb) {
  const noteFreq = 440 * Math.pow(2, (note.midi + setup.transpose - 69) / 12);
  const dur = Math.max(0.04, note.duration * setup.timeScale);
  const voice = transposeSynth(setup.instrument, noteFreq / setup.refFreq);
  voice.duration = dur;
  voice.attack = Math.min(setup.atk, dur * 0.4);
  delete voice.decay; // let decay fill the note (duration − attack)
  // For loops, the reverb send lives at the loop's output gain (so mute/fade kills the
  // wet too) — render notes dry to avoid a reverb wash that bypasses the loop gain.
  if (suppressReverb) delete voice.reverb;
  const gain = peakVolume * (0.3 + 0.7 * note.velocity); // velocity → loudness
  const built = buildSynthOneShot(kit, voice, gain, outputNode, when);
  return { oscillators: built.oscillators, sources: built.sources, endTime: built.endTime, lastEndNode: built.oscillators[0] || built.sources[0] };
}

/**
 * Render ONE pass of a parsed MIDI tune through `synthDef` — used by the one-shot path
 * (a tune is short, so a single burst is fine). The looping path schedules incrementally.
 */
export function renderMidiNotes(kit, synthDef, midiData, peakVolume, outputNode, startTime, suppressReverb = false) {
  const setup = midiVoiceSetup(synthDef);
  const oscillators = [], sources = [];
  let endTime = startTime, lastEndNode = null;
  for (const note of midiNotesFor(synthDef, midiData)) {
    const v = renderMidiNote(kit, setup, note, peakVolume, outputNode, startTime + note.time * setup.timeScale, suppressReverb);
    oscillators.push(...v.oscillators);
    sources.push(...v.sources);
    if (v.endTime >= endTime) { endTime = v.endTime; lastEndNode = v.lastEndNode; }
  }
  return { oscillators, sources, endTime, lastEndNode };
}
