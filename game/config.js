// Critter Garden configuration — the only game-balance numbers live here.

export const WORLD = { width: 2400, height: 1800 };

export const PALETTE = {
  base: '#0e1712',   // garden ground (canvas clear color)
  hud: '#cfe6d8',
  hudDim: '#6f8a7c',
};

// Soft garden parallax background (passed to the engine BackgroundRenderer).
export const BACKGROUND_LAYERS = [
  { parallax: 0.15, tileSize: 512, count: 36, sizeMin: 1.0, sizeMax: 2.5, color: '90,140,110', opacityMin: 0.08, opacityMax: 0.20, driftSpeed: 0.3, pulseSpeed: 0.0007 },
  { parallax: 0.45, tileSize: 512, count: 24, sizeMin: 1.5, sizeMax: 3.5, color: '120,170,130', opacityMin: 0.10, opacityMax: 0.24, driftSpeed: 0.7, pulseSpeed: 0.0011 },
  { parallax: 0.80, tileSize: 512, count: 14, sizeMin: 2.0, sizeMax: 4.5, color: '160,200,150', opacityMin: 0.12, opacityMax: 0.30, driftSpeed: 1.1, pulseSpeed: 0.0014 },
];

export const SPECIES = {
  blob:   { radius: 26, color: '#7cc6a0', trail: 'trailWander' },
  sprout: { radius: 24, color: '#cad27a', trail: 'trailDash' },
};

// Wander physics (fed straight into engine applyShipPhysics).
export const CRITTER_STATS = {
  thrustForce: 140,
  maxSpeed: 70,
  rotationSpeed: 2.4,
  forwardDrag: 0.96,
  lateralDrag: 0.85,
};

export const CAMERA_PAN_SPEED = 600; // px/sec
export const ZOOM_STEP = 1.12;       // per wheel notch
export const CURSOR_EASE = 12;       // follower snappiness (higher = tighter)
export const CURSOR_TRAIL = 'trailDash'; // VFX def for the cursor firefly trail
export const PAIR_RANGE = 70;        // critters this close may pair
export const PAIR_CHANCE = 0.004;    // per eligible pair per frame
export const PAIR_DURATION = 6000;   // ms a pair stays linked
export const MAX_CRITTERS = 40;      // safety cap
