// Pure oscillator-sample helpers for the Soundboard editor's static waveform
// preview. Split out of soundboardEditor.js — no DOM, no editor state.

/** One oscillator sample at `phase` (0..1 within one cycle). */
export function oscillatorSample(type, phase) {
  // phase is 0..1 within one cycle
  switch (type) {
    case 'sine':     return Math.sin(phase * 2 * Math.PI);
    case 'square':   return phase < 0.5 ? 1 : -1;
    case 'sawtooth': return 2 * (phase - Math.floor(phase + 0.5));
    case 'triangle': return 4 * Math.abs(phase - 0.5) - 1;
    default:         return Math.sin(phase * 2 * Math.PI);
  }
}

/** Resolve a possibly-[min,max] synth value to a single number for the static preview. */
export const rv = (v) => (Array.isArray(v) ? v[0] : v);
