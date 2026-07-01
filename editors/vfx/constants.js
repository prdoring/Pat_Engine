// Static data + category helpers for the VFX editor. Split out of vfxEditor.js.
// Pure: getCategory/categoryOrder read the manifest (via the shared loader); the
// rest are plain constant tables used to build the sidebar list and layer UI.

import { getManifest } from '/editors/shared/index.js';

// ─── VFX Type → category mapping (manifest-driven) ──────────────────────────
// The manifest's `vfxCategories` list each define { id, label, match: [...] }.
// An effect matches a category if its key contains one of the match substrings.
// Falls back to grouping by effect `type` when no manifest category matches.

export function getCategory(key, def) {
  const cats = getManifest()?.vfxCategories || [];
  for (const c of cats) {
    if ((c.match || []).some(m => key.toLowerCase().includes(m.toLowerCase()))) {
      return c.label || c.id;
    }
  }
  // Fallback: bucket by effect type so nothing is lost.
  if (def.type === 'bubbleTrail' || def.type === 'taperedTrail') return 'Trails';
  if (def.type === 'wiggleBeam') return 'Beams';
  if (def.lifecycle === 'persistent') return 'Persistent';
  return 'Effects';
}

export function categoryOrder() {
  // Manifest category labels first, then fallback buckets — deduped so a label
  // shared between the two (e.g. "Trails") isn't rendered twice.
  const manifestLabels = (getManifest()?.vfxCategories || []).map(c => c.label || c.id);
  return [...new Set([...manifestLabels, 'Persistent', 'Trails', 'Beams', 'Effects'])];
}

// ─── Primitives available for layers ─────────────────────────────────────────

export const PRIMITIVE_TYPES = ['filledCircle', 'gradientCircle', 'strokeRing', 'dashedRing', 'spikeLines',
  'scatterDots', 'scatterLines', 'scatterStrips'];

// Properties each primitive type expects (for building UI)
export const PRIMITIVE_PROPS = {
  filledCircle: ['radius', 'color', 'alpha', 'shadow'],
  gradientCircle: ['radius', 'gradient', 'color', 'alpha', 'shadow'],
  strokeRing: ['radius', 'color', 'lineWidth', 'alpha', 'shadow'],
  dashedRing: ['radius', 'color', 'lineWidth', 'dashPattern', 'alpha', 'shadow'],
  spikeLines: ['count', 'innerRadius', 'outerRadius', 'color', 'lineWidth', 'alpha', 'shadow'],
  // Scatter clouds (ported from the art `particles` emitters).
  scatterDots: ['count', 'spreadX', 'spreadY', 'sizeMin', 'sizeRange', 'alphaMin', 'alphaRange', 'colors', 'colorThreshold'],
  scatterLines: ['count', 'color', 'lineWidth', 'spreadFactor', 'reachOffset', 'reachFactor', 'alphaMin', 'alphaRange'],
  scatterStrips: ['count', 'stripLength', 'lineWidth', 'spread', 'rotateSpeedMin', 'rotateSpeedMax', 'alphaMin', 'alphaRange', 'colors'],
};

// Slider ranges for the scatter-cloud scalar fields.
export const SCATTER_RANGES = {
  spreadX: [0, 2, 0.05], spreadY: [0, 2, 0.05], sizeMin: [0, 5, 0.1], sizeRange: [0, 5, 0.1],
  alphaMin: [0, 1, 0.05], alphaRange: [0, 1, 0.05], colorThreshold: [0, 1, 0.05],
  spreadFactor: [0, 2, 0.05], reachOffset: [0, 2, 0.05], reachFactor: [0, 2, 0.05],
  stripLength: [0.01, 1, 0.01], spread: [0, 3, 0.05], rotateSpeedMin: [0, 0.02, 0.001], rotateSpeedMax: [0, 0.02, 0.001],
};

// ─── Default definitions for new effects ────────────────────────────────────

export const NEW_EFFECT_DEFAULTS = {
  phased: {
    type: 'phased', duration: 1200, defaultScale: 120,
    phases: [{
      name: 'flash', start: 0, end: 0.1,
      layers: [{
        primitive: 'filledCircle',
        radius: { from: 0.2, to: 0.4 },
        color: '#ccffff',
        alpha: { from: 0.8, to: 0 },
        shadow: { color: '#ccffff', blur: 30 },
      }],
    }],
  },
  'phased-persistent': {
    type: 'phased', lifecycle: 'persistent', defaultScale: 12,
    phases: [{
      name: 'body', start: 0, end: 1,
      layers: [{
        primitive: 'strokeRing',
        radius: 0.6, color: '#666666', lineWidth: 1.5, alpha: 0.7,
        shadow: { color: '#666666', blur: 4 },
      }],
    }],
  },
  bubbleTrail: {
    type: 'bubbleTrail', maxLength: 40, pointLifetime: 900,
    bubbleMinRadius: 1.0, bubbleMaxRadius: 3.5,
    colorInner: '#aadddd', colorOuter: '#224444',
    colorRemoteInner: '#bb8888', colorRemoteOuter: '#442222',
    maxSpeed: 120, glowBlur: 3,
    anchors: [{ x: -2.2, y: -0.375 }, { x: -2.2, y: 0.375 }],
  },
  taperedTrail: {
    type: 'taperedTrail', maxLength: 30, pointLifetime: 600,
    baseWidth: 3, tipWidth: 0.3,
    colorInner: '#cc7733', colorOuter: '#221808', glowBlur: 8,
  },
  wiggleBeam: {
    type: 'wiggleBeam', segments: 16, wiggleAmplitude: 4, wiggleAmplitudeVariation: 2,
    wiggleFreq: 8, colorLocal: '#33aaaa', colorRemote: '#2288aa',
    lineWidth: 1.5, glowWidth: 5, alpha: 0.7, glowAlpha: 0.2,
    shadowBlur: 8, glowShadowBlur: 15,
  },
};
