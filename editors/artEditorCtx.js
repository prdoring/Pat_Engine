// Shared state and utility functions for the art editor modules.
// All editor modules import ctx and use it for shared mutable state.
// Cross-module function calls go through callbacks wired by artEditor.js.

/** Shared mutable state for the art editor. */
export const ctx = {
  // Art collections, manifest-driven. `collections[id]` = parsed file data
  // (e.g. { critters: { blob: {...} } }); `artCollections` = manifest entries.
  collections: {},
  artCollections: [],

  // Current selection
  currentArt: null,
  currentFileKey: null,   // = the selected asset's collection id (keys saveManagers)
  currentLabel: '',

  // State system
  previewState: null,
  currentEditState: 'BASE',
  discoveredStates: [],

  // Shape tree
  selectedShapePath: null,
  hoveredShapePath: null,
  expandedPaths: new Set(),

  // Editor-only view state (path-key strings; never serialized to art data)
  editorHidden: new Set(),   // shapes hidden from the preview + un-pickable
  editorLocked: new Set(),   // shapes that can't be dragged/nudged
  editorSolo: null,          // path-key of the sole visible branch, or null
  clipboard: null,           // a copied shape (deep clone), pasteable into any asset
  snapGrid: false,           // snap on-canvas drags to a coarse grid
  frozenNow: null,           // freeze animation time during a drag (null = live)

  // Preview
  saveManagers: {},
  preview: null,
  animFrame: null,
  animNow: 0,
  animPlaying: true,
  previewColor: '#d4a056',
  previewRadius: 60,
  showGrid: true,
  previewTransition: { currentState: null, prevState: null, startTime: 0 },

  // Keyframe timeline
  timeline: null,            // the createArtTimeline() instance
  keyTargetClip: '*',        // which clip (state or "*") edits/auto-keys write into
  playhead: 0,               // current clip-local time (ms) shown in the preview
  autoKey: false,            // when on, editing a property writes a keyframe at the playhead
  selectedKeyframe: null,    // { path, prop, t } of the picked diamond, or null

  // DOM refs
  container: null,
  sidebarEl: null,
  treeColumnEl: null,
  stateBarEl: null,
  previewArea: null,
  controlsEl: null,
  propsEl: null,
  saveRow: null,

  // Cross-module callbacks (wired by artEditor.js after import)
  rebuildTree: null,
  rebuildProps: null,
  rebuildStateBar: null,
  rebuildControls: null,
  rebuildTimeline: null,
  clearProps: null,
  markDirty: null,
  rebuildSaveRow: null,
  startAnimation: null,
  stopAnimation: null,
};

// ─── File Data Helper ────────────────────────────────────────────────────────

/** Returns all art collection file-data keyed by collection id. */
export function FILE_DATA() {
  return ctx.collections;
}

// ─── Shape Normalization ─────────────────────────────────────────────────────

let _legacyAnimWarned = false;

/**
 * Recursively walk any nested object and normalize all shapes arrays found —
 * the renderer accepts both `children` and `shapes` for container kids, but the
 * editor works in one format (`shapes`), so we rename `children` → `shapes` on
 * load. Animation is now keyframe tracks (`shape.anim`), not nested animator
 * shapes, so there's nothing else to convert; legacy oscillator/spinner/animator
 * data is detected and warned about (see normalizeShapes) rather than migrated.
 */
export function normalizeArtData(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  // If this object has a shapes/children array, normalize it
  if (Array.isArray(obj.shapes)) normalizeShapes(obj.shapes);
  if (Array.isArray(obj.children)) {
    obj.shapes = obj.children;
    delete obj.children;
    normalizeShapes(obj.shapes);
  }
  // Recurse into all values
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) normalizeArtData(v);
  }
}

function normalizeShapes(shapes) {
  if (!Array.isArray(shapes)) return;
  for (let i = 0; i < shapes.length; i++) {
    const shape = shapes[i];
    if (!_legacyAnimWarned && (shape.animators || shape.type === 'oscillator' || shape.type === 'spinner')) {
      _legacyAnimWarned = true;
      console.warn('[artEditor] This asset uses the old oscillator/spinner animation system, which has been removed. Re-author its motion with keyframe tracks in the timeline. Legacy animation data is ignored. Further warnings suppressed.');
    }
    // Recurse into children
    const children = shapes[i].shapes || shapes[i].children;
    if (children) {
      // Normalize key to 'shapes'
      if (shapes[i].children && !shapes[i].shapes) {
        shapes[i].shapes = shapes[i].children;
        delete shapes[i].children;
      }
      normalizeShapes(shapes[i].shapes);
    }
  }
}

// ─── Path Helpers ────────────────────────────────────────────────────────────

/** Convert a path array to a string key for use in sets/maps. */
export function pathToKey(path) { return path.join(','); }

/** Navigate a shapes array by path to get the shape at that location. */
export function getShapeAtPath(shapes, path) {
  let current = shapes[path[0]];
  for (let i = 1; i < path.length; i++) {
    if (!current || !current.shapes) return null;
    current = current.shapes[path[i]];
  }
  return current;
}

/** Get the parent's shapes array for a shape at the given path. */
export function getParentShapesAtPath(artDef, path) {
  if (path.length === 0) return null;
  if (path.length === 1) return artDef.shapes;
  let parent = artDef.shapes[path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    if (!parent || !parent.shapes) return null;
    parent = parent.shapes[path[i]];
  }
  return parent ? parent.shapes : null;
}

/** Check if a shape has a reference to a specific state name. */
export function shapeHasStateRef(shape, stateName) {
  if (stateName === 'BASE') return false;
  if (shape.stateOverrides && shape.stateOverrides[stateName]) return true;
  if (shape.states && typeof shape.states === 'object' && !Array.isArray(shape.states) && shape.states[stateName]) return true;
  if (shape.visibleStates && shape.visibleStates.includes(stateName)) return true;
  return false;
}

// ─── State Edit Proxy ────────────────────────────────────────────────────────

/** Keys that always read/write the base shape, never go to overrides. */
const STRUCTURAL_KEYS = new Set([
  'name', 'type', 'shapes', 'children', 'states', 'stateOverrides',
  'visibleStates', 'var', 'anim',
]);

/**
 * Get the overrides map for a shape. Uses 'states' (matching JSON data format).
 * Guards against 'states' being an array (which only happens at artDef level, not shape level).
 */
function getOverridesMap(shape) {
  if (shape.states && typeof shape.states === 'object' && !Array.isArray(shape.states)) {
    return shape.states;
  }
  if (shape.stateOverrides && typeof shape.stateOverrides === 'object') {
    return shape.stateOverrides;
  }
  // Create new 'states' object
  shape.states = {};
  return shape.states;
}

/**
 * Create a proxy around a shape for state-aware editing.
 * In BASE state, returns the shape directly.
 * In non-BASE state:
 *   GET: returns override value if exists, else base value
 *   SET: writes to shape.states[stateName], not to base shape
 *   setup: returns a nested proxy for setup overrides
 */
export function createStateProxy(shape, stateName) {
  if (!stateName || stateName === 'BASE') return shape;

  function ensureStateObj() {
    const map = getOverridesMap(shape);
    if (!map[stateName]) map[stateName] = {};
    return map[stateName];
  }

  function getStateObj() {
    const map = getOverridesMap(shape);
    return map[stateName];
  }

  function createSetupProxy() {
    const baseSetup = shape.setup || {};
    return new Proxy(baseSetup, {
      get(target, prop) {
        if (typeof prop === 'symbol') return target[prop];
        const stateObj = getStateObj();
        if (stateObj && stateObj.setup && prop in stateObj.setup) return stateObj.setup[prop];
        return target[prop];
      },
      set(target, prop, value) {
        const ov = ensureStateObj();
        if (!ov.setup) ov.setup = {};
        ov.setup[prop] = value;
        return true;
      },
      has(target, prop) {
        const stateObj = getStateObj();
        if (stateObj && stateObj.setup && prop in stateObj.setup) return true;
        return prop in target;
      },
      ownKeys(target) {
        const stateObj = getStateObj();
        const keys = new Set(Object.keys(target));
        if (stateObj && stateObj.setup) Object.keys(stateObj.setup).forEach(k => keys.add(k));
        return [...keys];
      },
      getOwnPropertyDescriptor(target, prop) {
        const stateObj = getStateObj();
        if (stateObj && stateObj.setup && prop in stateObj.setup) {
          return { value: stateObj.setup[prop], writable: true, enumerable: true, configurable: true };
        }
        if (prop in target) {
          return { value: target[prop], writable: true, enumerable: true, configurable: true };
        }
        return undefined;
      },
    });
  }

  function createEmitterProxy(index) {
    const baseEmitter = (shape.emitters || [])[index] || {};
    return new Proxy(baseEmitter, {
      get(target, prop) {
        if (typeof prop === 'symbol') return target[prop];
        const stateObj = getStateObj();
        if (stateObj && stateObj.emitters && stateObj.emitters[index] && prop in stateObj.emitters[index]) {
          return stateObj.emitters[index][prop];
        }
        return target[prop];
      },
      set(target, prop, value) {
        const ov = ensureStateObj();
        if (!ov.emitters) ov.emitters = [];
        if (!ov.emitters[index]) ov.emitters[index] = {};
        ov.emitters[index][prop] = value;
        return true;
      },
    });
  }

  function createEmittersProxy() {
    const baseEmitters = shape.emitters || [];
    return new Proxy(baseEmitters, {
      get(target, prop) {
        if (typeof prop === 'symbol') return target[prop];
        const idx = Number(prop);
        if (!isNaN(idx) && idx >= 0 && idx < target.length) return createEmitterProxy(idx);
        return target[prop];
      },
    });
  }

  return new Proxy(shape, {
    get(target, prop) {
      if (typeof prop === 'symbol') return target[prop];
      if (STRUCTURAL_KEYS.has(prop)) return target[prop];
      if (prop === 'setup') return createSetupProxy();
      if (prop === 'emitters') return createEmittersProxy();
      const stateObj = getStateObj();
      if (stateObj && prop in stateObj && prop !== 'setup') return stateObj[prop];
      return target[prop];
    },
    set(target, prop, value) {
      if (typeof prop === 'symbol' || STRUCTURAL_KEYS.has(prop)) {
        target[prop] = value;
        return true;
      }
      if (prop === 'setup') {
        const ov = ensureStateObj();
        ov.setup = value;
        return true;
      }
      if (prop === 'emitters') {
        const ov = ensureStateObj();
        ov.emitters = value;
        return true;
      }
      const ov = ensureStateObj();
      ov[prop] = value;
      return true;
    },
    has(target, prop) { return Reflect.has(target, prop); },
    ownKeys(target) { return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, prop) { return Reflect.getOwnPropertyDescriptor(target, prop); },
    deleteProperty(target, prop) {
      if (STRUCTURAL_KEYS.has(prop)) return Reflect.deleteProperty(target, prop);
      // Delete from override, not base
      const stateObj = getStateObj();
      if (stateObj && prop in stateObj) delete stateObj[prop];
      return true;
    },
  });
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const SHAPE_ICONS = {
  group: '{}', path: '/', bezierPath: '~', quadPath: '~', arc: '(', circle: 'O',
  rect: '[]', strokeRect: '[]', lines: '=', repeat: '#', forEach: '*',
  boltCluster: '::', conditional: '?',
  particles: '.:', roundedRect: '[R]', radialRepeat: '(*)', effectRef: '✦',
};

export const CONTAINER_TYPES = new Set(['group', 'conditional', 'repeat', 'forEach', 'particles', 'radialRepeat']);
