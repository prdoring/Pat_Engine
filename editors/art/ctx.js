// Shared state and utility functions for the art editor modules.
// All editor modules import ctx and use it for shared mutable state.
// Cross-module function calls go through callbacks wired by artEditor.js.

import { sampleTrack } from '/engine/render/interp.js';
import {
  keyframeableProps, getTrack, setKeyframe, ensureClip, deleteTrack,
  coerceToTrack, coerceToShapeOf, defaultFor, getPropValue,
} from './model/keyframes.js';

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
  renderLoopFrame: null,     // rAF handle for the ALWAYS-ON preview repaint loop (see startRenderLoop)
  animNow: 0,
  animPlaying: true,         // transport only: whether animation TIME advances (NOT whether we paint)
  previewColor: '#d4a056',
  previewRadius: 60,
  showGrid: true,
  previewTransition: { currentState: null, prevState: null, startTime: 0 },

  // Keyframe timeline
  timeline: null,            // the createArtTimeline() instance
  keyTargetClip: '*',        // which clip (state or "*") edits/auto-keys write into
  playhead: 0,               // current clip-local time (ms) shown in the preview
  autoKey: true,             // when on, editing a keyframeable prop writes a keyframe at the playhead
  selectedKeyframe: null,    // { path, prop, t } of the picked diamond, or null

  // DOM refs
  container: null,
  sidebarCollapsed: false,   // collections sidebar collapsed for more working room
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
  toggleSidebar: null,
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

// ─── Anim (keyframe) Edit Proxy ──────────────────────────────────────────────

const ANIM_T_EPS = 1; // ms — keep in sync with artKeyframes' T_EPS
const _animClone = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

/**
 * Wrap a (state-proxied) shape so the props panel READS the sampled value of a
 * keyframed property at the playhead and an edit WRITES a keyframe instead of the
 * base. Composes OUTSIDE createStateProxy so the per-type editors are unchanged.
 *
 * SET keys off track-EXISTENCE, not the auto-key toggle:
 *   - a track exists           → always write a keyframe at the playhead;
 *   - else auto-key ON & t>0   → create the track (+ seed a t=0 key from the rest);
 *   - else                     → fall through to the base/override edit (today's path).
 * The t>0 gate keeps static authoring intact: editing at the start (t=0) with no
 * track yet sets the rest/base value; you create animation by scrubbing to a time
 * and tweaking. (Explicit "Key part" / double-click can still key at t=0, and once
 * any track exists the symmetry rule keys it at t=0 too.) Keyframe ops always
 * target `rawShape`; clip/time/auto-key are read live via getters so a scrub or
 * toggle is reflected without rebuilding the proxy.
 */
export function createAnimProxy(delegate, rawShape, getClipKey, getPlayhead, getAutoKey) {
  const props = keyframeableProps(rawShape);
  const keyable = new Set(props.map((p) => p.prop));
  const kindOf = new Map(props.map((p) => [p.prop, p.kind]));
  const setupKeyable = new Set(
    [...keyable].filter((p) => p.startsWith('setup.')).map((p) => p.slice(6)),
  );
  const hasSetupKeyframes = (ck) => {
    const t = rawShape.anim && rawShape.anim[ck];
    return !!t && Object.keys(t).some((p) => p.startsWith('setup.'));
  };
  const playT = () => Math.round(getPlayhead() || 0);

  function writeKey(prop, v) {
    const ck = getClipKey();
    ensureClip(ctx.currentArt, ck);
    setKeyframe(rawShape, ck, prop, playT(), coerceToTrack(getTrack(rawShape, ck, prop), _animClone(v)));
  }
  // First-ever key on a track at t>0: seed a t=0 key from the rest pose so the
  // change animates rest→pose (shape-matched to the edited value).
  function seedRest(prop, v, rest) {
    const ck = getClipKey();
    if (playT() <= ANIM_T_EPS || getTrack(rawShape, ck, prop)) return;
    const base = (rest !== undefined) ? rest : defaultFor(kindOf.get(prop) || 'number');
    setKeyframe(rawShape, ck, prop, 0, coerceToShapeOf(v, _animClone(base)));
  }
  // Returns true if the SET was handled as a keyframe; false → caller delegates.
  function keySet(prop, v, rest) {
    if (ctx.animPlaying) return false; // playing → playhead advances; don't scatter keys
    if (getTrack(rawShape, getClipKey(), prop)) { writeKey(prop, v); return true; }
    if (getAutoKey() && playT() > ANIM_T_EPS) { seedRest(prop, v, rest); writeKey(prop, v); return true; }
    return false;
  }

  function animSetupProxy() {
    return new Proxy({}, {
      get(_t, key) {
        if (typeof key === 'symbol') return undefined;
        if (setupKeyable.has(key)) {
          const track = getTrack(rawShape, getClipKey(), 'setup.' + key);
          if (track) return sampleTrack(track, getPlayhead() || 0);
        }
        const sd = delegate.setup;
        return sd ? sd[key] : undefined;
      },
      set(_t, key, value) {
        if (typeof key !== 'symbol' && setupKeyable.has(key)) {
          const sd = delegate.setup;
          if (keySet('setup.' + key, value, sd ? sd[key] : undefined)) return true;
        }
        if (!delegate.setup) delegate.setup = {};
        delegate.setup[key] = value;
        return true;
      },
      has(_t, key) { const sd = delegate.setup; return sd ? (key in sd) : false; },
      ownKeys() { const sd = delegate.setup; return sd ? Reflect.ownKeys(sd) : []; },
      getOwnPropertyDescriptor(_t, key) {
        const sd = delegate.setup; if (!sd) return undefined;
        const d = Reflect.getOwnPropertyDescriptor(sd, key);
        if (d) d.configurable = true; // target is {}, so reported keys must be configurable
        return d;
      },
    });
  }

  return new Proxy(rawShape, {
    get(target, prop) {
      if (typeof prop === 'symbol') return Reflect.get(delegate, prop);
      if (prop === 'setup') {
        // Surface a setup proxy only when there's a setup to edit (or setup tracks)
        // so buildSetupEditor's "+ Add Setup" affordance still appears otherwise.
        if (delegate.setup !== undefined || hasSetupKeyframes(getClipKey())) return animSetupProxy();
        return undefined;
      }
      if (keyable.has(prop)) {
        const track = getTrack(rawShape, getClipKey(), prop);
        if (track) return sampleTrack(track, getPlayhead() || 0);
      }
      return Reflect.get(delegate, prop);
    },
    set(target, prop, value) {
      if (typeof prop !== 'symbol' && keyable.has(prop)) {
        if (keySet(prop, value, Reflect.get(delegate, prop))) return true;
      }
      Reflect.set(delegate, prop, value);
      return true;
    },
    has(target, prop) { return Reflect.has(delegate, prop); },
    ownKeys(target) { return Reflect.ownKeys(delegate); },
    getOwnPropertyDescriptor(target, prop) { return Reflect.getOwnPropertyDescriptor(delegate, prop); },
    deleteProperty(target, prop) {
      if (typeof prop !== 'symbol' && keyable.has(prop)) deleteTrack(rawShape, getClipKey(), prop);
      return Reflect.deleteProperty(delegate, prop);
    },
  });
}

// ─── Unified edit routing (canvas drags ↔ props panel) ───────────────────────
// On-canvas drags and the props-panel widgets must land an edit in the SAME layer,
// so "however you tweak it, the change goes to the right place." The rule (mirrors
// the props panel's createAnimProxy over createStateProxy), for a prop `propPath`
// (possibly dotted: `cx`, `points.2`, `segments.0.1`, `curves.1.cp`) → value:
//   1. KEYFRAME into the key-target clip at the playhead (seed a t=0 rest key on
//      first creation) — when a track already exists for the prop, OR auto-key is on
//      and the playhead is past 0. Never while playing (the playhead is moving).
//   2. else STATE OVERRIDE (`states[state][…]`) — when a specific state is selected.
//   3. else BASE.
// Dotted paths are sampled/applied deeply by the runtime (ArtInterpreter
// .applySampledOverrides), so keying an individual vertex (`points.2`) animates.

const _idxRe = /^\d+$/;
const _pathIdx = (p) => (_idxRe.test(p) ? Number(p) : p);
const _editState = () =>
  (ctx.currentEditState && ctx.currentEditState !== 'BASE') ? ctx.currentEditState : null;

/** Read a (possibly dotted) prop's authoring value with the selected state's static
 *  override applied — the pre-keyframe "rest" pose (used to seed the t=0 key). */
function readEffectiveProp(rawShape, propPath) {
  const st = _editState();
  const eff = (st && rawShape.states && rawShape.states[st])
    ? { ...rawShape, ...rawShape.states[st] } : rawShape;
  return getPropValue(eff, propPath);
}

/**
 * The value of `propPath` as currently shown at the playhead: the key-target clip's
 * sampled value when a track exists, else the effective rest value. Canvas drags read
 * this as the drag's starting value so a grab begins from what's on screen and the
 * written keyframe matches where you dragged to (never clobbers a keyed offset).
 */
export function editValueAt(rawShape, propPath) {
  const ck = ctx.keyTargetClip || '*';
  const track = getTrack(rawShape, ck, propPath);
  if (track) {
    const v = sampleTrack(track, ctx.playhead || 0);
    if (v !== undefined) return v;
  }
  return readEffectiveProp(rawShape, propPath);
}

/** Deep-write `value` at dotted `propPath` on `target`, cloning the parent from
 *  `source` when `target` doesn't own it yet (so a state override gets its own copy
 *  of e.g. `points` before we edit one vertex; base edits mutate in place). */
function writeDeepPath(target, propPath, value, source) {
  const parts = propPath.split('.');
  if (parts.length === 1) { target[parts[0]] = value; return; }
  const top = parts[0];
  if (target !== source && target[top] === undefined) {
    const s = source ? source[top] : undefined;
    target[top] = Array.isArray(s) ? _animClone(s) : { ...(s || {}) };
  }
  let node = target[top];
  for (let i = 1; i < parts.length - 1; i++) {
    const k = _pathIdx(parts[i]);
    if (node[k] === undefined) node[k] = _idxRe.test(parts[i + 1]) ? [] : {};
    node = node[k];
  }
  node[_pathIdx(parts[parts.length - 1])] = value;
}

/**
 * Commit an edit of `propPath` → `value` on `rawShape`, routing to keyframe /
 * state-override / base per the rules above. Callers (canvas drag handlers, arrow-key
 * nudge) pass the FINAL value. Returns where it landed ('key' | 'state' | 'base').
 */
export function commitShapeEdit(rawShape, propPath, value) {
  const ck = ctx.keyTargetClip || '*';
  if (!ctx.animPlaying) {
    const existing = getTrack(rawShape, ck, propPath);
    const ph = Math.round(ctx.playhead || 0);
    if (existing || (ctx.autoKey && ph > ANIM_T_EPS)) {
      ensureClip(ctx.currentArt, ck);
      if (!existing && ph > ANIM_T_EPS) {
        const rest = readEffectiveProp(rawShape, propPath);
        if (rest !== undefined) {
          setKeyframe(rawShape, ck, propPath, 0, coerceToShapeOf(value, _animClone(rest)));
        }
      }
      setKeyframe(rawShape, ck, propPath, ph,
        coerceToTrack(getTrack(rawShape, ck, propPath), _animClone(value)));
      return 'key';
    }
  }
  const st = _editState();
  if (st) {
    if (!rawShape.states) rawShape.states = {};
    if (!rawShape.states[st]) rawShape.states[st] = {};
    writeDeepPath(rawShape.states[st], propPath, value, { ...rawShape, ...rawShape.states[st] });
    return 'state';
  }
  writeDeepPath(rawShape, propPath, value, rawShape);
  return 'base';
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const SHAPE_ICONS = {
  group: '{}', path: '/', bezierPath: '~', quadPath: '~', arc: '(', circle: 'O',
  rect: '[]', strokeRect: '[]', lines: '=', repeat: '#', forEach: '*',
  boltCluster: '::', conditional: '?',
  particles: '.:', roundedRect: '[R]', radialRepeat: '(*)', effectRef: '✦',
};

export const CONTAINER_TYPES = new Set(['group', 'conditional', 'repeat', 'forEach', 'particles', 'radialRepeat']);
