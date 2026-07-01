// Static config for the Soundboard editor. Split out of soundboardEditor.js.

// The 8 Web Audio BiquadFilter types the engine supports (SoundManager._resolveFilter
// passes `type` straight through). Shared by the voice filter and noise-layer filters.
export const FILTER_TYPES = [
  { value: 'lowpass', label: 'Low-pass' },
  { value: 'highpass', label: 'High-pass' },
  { value: 'bandpass', label: 'Band-pass' },
  { value: 'lowshelf', label: 'Low-shelf' },
  { value: 'highshelf', label: 'High-shelf' },
  { value: 'peaking', label: 'Peaking' },
  { value: 'notch', label: 'Notch' },
  { value: 'allpass', label: 'All-pass' },
];
