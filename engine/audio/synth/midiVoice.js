/**
 * Pure MIDI-tune helpers: pick a track's notes, per-tune voice setup, transpose a
 * synth by a frequency ratio, and total note-list duration. No Web Audio, no
 * `this`. The SoundManager exposes these via thin delegating methods and the
 * voice renderers (./voices.js) import them directly.
 */

/** Clone a synth def, scaling oscillator-layer freq/freqEnd by `ratio` (noise/file untouched). */
export function transposeSynth(instrument, ratio) {
  const scale = (v) => Array.isArray(v) ? [v[0] * ratio, v[1] * ratio] : v * ratio;
  const clone = { ...instrument };
  if (instrument.layers) {
    clone.layers = instrument.layers.map(l => {
      if (l.type === 'file' || l.type === 'noise') return { ...l };
      const r = { ...l };
      if (l.freq !== undefined) r.freq = scale(l.freq);
      if (l.freqEnd !== undefined) r.freqEnd = scale(l.freqEnd);
      return r;
    });
  } else {
    if (instrument.freq !== undefined) clone.freq = scale(instrument.freq);
    if (instrument.freqEnd !== undefined) clone.freqEnd = scale(instrument.freqEnd);
  }
  return clone;
}

/**
 * Resolve which note list a synth plays from a parsed MIDI file: a specific track
 * (by name or index, via `synth.midi.track`) for multi-instrument songs, else the
 * merged note list. Falls back to merged if the track isn't found.
 */
export function midiNotesFor(synthDef, midiData) {
  const m = synthDef.midi;
  const track = (m && typeof m === 'object') ? m.track : undefined;
  if (track === undefined || track === null || !midiData.tracks) return midiData.notes;
  const t = typeof track === 'number'
    ? midiData.tracks[track]
    : midiData.tracks.find(x => x.name === track);
  return (t && t.notes) || midiData.notes;
}

/** One-time per-tune setup shared by every note: instrument timbre, ref pitch, transpose, tempo. */
export function midiVoiceSetup(synthDef) {
  const cfg = synthDef.midi;
  const transpose = (cfg && typeof cfg === 'object' && cfg.transpose) || 0;
  const tempo = (cfg && typeof cfg === 'object' && cfg.tempo) || 1; // >1 = faster
  const timeScale = tempo > 0 ? 1 / tempo : 1;
  const { midi, ...instrument } = synthDef; // instrument = synth minus the `midi` key
  const layers = instrument.layers || [{ type: instrument.type || 'sine', freq: instrument.freq || 440 }];
  const ref = layers.find(l => l.type !== 'file' && l.type !== 'noise');
  let refFreq = ref ? (Array.isArray(ref.freq) ? ref.freq[0] : ref.freq) : 440;
  if (!refFreq) refFreq = 440;
  let atk = Array.isArray(instrument.attack) ? instrument.attack[0] : instrument.attack;
  if (typeof atk !== 'number') atk = 0.01;
  return { instrument, refFreq, atk, transpose, timeScale };
}

/** Total length (seconds) spanned by a seconds-based note list. */
export function notesDuration(notes) {
  return (notes || []).reduce((m, n) => Math.max(m, (n.time || 0) + (n.duration || 0)), 0);
}
