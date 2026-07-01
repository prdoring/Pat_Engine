// Static timeline/track configuration for the Sequence editor. Split out of
// sequencesEditor.js — pure data tables consumed by the timeline renderer, the
// track ordering, and the step property panels.

export const TRACK_ORDER = ['sfx', 'vfx', 'loopStart', 'loopStop', 'signal'];
export const TRACK_LABELS = { sfx: 'SFX', vfx: 'VFX', loopStart: 'Loop ▶', loopStop: 'Loop ■', signal: 'SIG' };
export const TRACK_COLORS = {
  sfx: '#d4a056',
  vfx: '#33ddcc',
  loopStart: '#66cc66',
  loopStop: '#cc6666',
  signal: '#aa88dd',
};
export const TIMELINE_BG = '#0a0e16';
export const TIMELINE_TRACK_HEIGHT = 32;
export const TIMELINE_HEADER_HEIGHT = 24;
export const TIMELINE_PADDING = 8;
export const MARKER_RADIUS = 6;

export const KNOWN_SIGNALS = [
  { value: 'setState', label: 'Set Art State' },
  { value: 'clearState', label: 'Clear Art State' },
  { value: 'stopAllLoops', label: 'Stop All Loops' },
  { value: 'removeEntity', label: 'Remove Entity' },
  { value: '_custom', label: 'Custom...' },
];
