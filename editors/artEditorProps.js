// Shape property panel and per-type editors for the art editor.
// Builds the right-side property panel when a shape is selected.

import { ctx, getShapeAtPath, SHAPE_ICONS, createStateProxy, createAnimProxy, editValueAt, commitShapeEdit } from './artEditorCtx.js';
import { collectAvailableVars } from './artEditorTree.js';
import { VFX_DEFS } from '/engine/data/vfx.js';
import { rotateShapeAroundCenter } from './artEditorPreview.js';
import {
  NumberSlider, ColorInput, Select, TextInput, Toggle, Button,
  PropertyGroup, CoordEditor, TagListEditor, setCoordReadout,
} from './editorShared.js';
import {
  keyframeableProps, getPropValue, getTrack, setKeyframe, deleteTrack, ensureClip, makeLoopable, clipMeta, keyPose,
} from './artKeyframes.js';

// Live "= N px" readout under each CoordEditor: resolves the static terms
// (base + r/w/h) at the current preview radius/space, and annotates anim-var
// terms symbolically (they vary each frame, so showing the decomposition is
// clearer than a flickering number). The art editor owns this because only it
// knows the radius/space; the generic widget stays game-agnostic.
function coordReadout(value) {
  const r = ctx.previewRadius || 60;
  const art = ctx.currentArt;
  const w = art && art.space ? r * (art.space.widthFactor || 1) : r;
  const h = art && art.space ? r * (art.space.heightFactor || 1) : r;
  if (typeof value === 'number') return `= ${(value * r).toFixed(1)}px`;
  if (value && typeof value === 'object') {
    let px = 0; const anim = [];
    for (const [k, v] of Object.entries(value)) {
      if (typeof v !== 'number') continue;
      if (k === 'base') px += v;
      else if (k === 'r') px += v * r;
      else if (k === 'w') px += v * w;
      else if (k === 'h') px += v * h;
      else anim.push(`${v}·${k}`);
    }
    return `= ${px.toFixed(1)}px` + (anim.length ? ` + (${anim.join(' + ')})·r` : '');
  }
  if (typeof value === 'string' && value) return `= ${value}·r`;
  return '';
}
setCoordReadout(coordReadout);

/** A subtle "enable this optional field" button. */
function addFieldButton(label, onClick) {
  const b = Button(label, onClick, 'subtle');
  b.el.style.cssText += 'font-size:10px;padding:1px 6px;margin:2px 0;color:#7a9a6a;';
  return b.el;
}
const radiusModeToggle = addFieldButton;

// ─── Main Shape Properties ───────────────────────────────────────────────────

/** Build the property panel for the currently selected shape. */
export function buildShapeProps() {
  ctx.propsEl.innerHTML = '';
  if (!ctx.currentArt) return;
  const art = ctx.currentArt;

  if (!ctx.selectedShapePath) { buildAssetPanel(art); return; }

  const rawShape = getShapeAtPath(art.shapes, ctx.selectedShapePath);
  if (!rawShape) { buildAssetPanel(art); return; }

  // Two composed proxies: the inner state proxy routes reads/writes through state
  // overrides when editing non-BASE; the outer anim proxy makes a keyframed prop
  // READ its sampled value at the playhead and an edit WRITE a keyframe (auto-key).
  // Per-type editors below are unchanged — they just see "the shape".
  const shape = createAnimProxy(
    createStateProxy(rawShape, ctx.currentEditState),
    rawShape,
    () => ctx.keyTargetClip || '*',
    () => ctx.playhead || 0,
    () => ctx.autoKey,
  );

  const onDirty = () => {
    ctx.markDirty();
    // An edit may have auto-keyed a diamond — reflect it on the timeline live
    // (lightweight re-list + redraw; no focus-stealing props rebuild).
    ctx.timeline?.redrawRows?.();
    // Refresh overrides summary without full rebuild (avoids losing focus)
    const existingOverrides = ctx.propsEl.querySelector('.overrides-section');
    if (existingOverrides) {
      existingOverrides.innerHTML = '';
      buildOverridesContent(existingOverrides, rawShape, onDirty);
    }
  };
  const set = (key, val) => { shape[key] = val; onDirty(); };
  const availableVars = collectAvailableVars(art, ctx.selectedShapePath);
  const stateNames = ctx.discoveredStates.filter(s => s !== 'BASE');

  // Header: icon + name + type + state indicator
  const header = document.createElement('div');
  header.className = 'props-header';
  const iconSpan = document.createElement('span');
  iconSpan.className = 'tree-icon';
  iconSpan.textContent = SHAPE_ICONS[rawShape.type] || '?';
  header.appendChild(iconSpan);
  const nameSpan = document.createElement('span');
  nameSpan.style.cssText = 'font-weight:bold;color:#d4a056;flex:1;';
  nameSpan.textContent = rawShape.name || rawShape.type;
  header.appendChild(nameSpan);
  const typeSpan = document.createElement('span');
  typeSpan.style.cssText = 'color:#5a4a30;font-size:11px;';
  typeSpan.textContent = rawShape.type;
  header.appendChild(typeSpan);
  if (ctx.currentEditState !== 'BASE') {
    const badge = document.createElement('span');
    badge.style.cssText = 'color:#33ddcc;font-size:10px;padding:1px 6px;border:1px solid #33ddcc44;border-radius:3px;margin-left:4px;';
    badge.textContent = ctx.currentEditState;
    header.appendChild(badge);
  }
  ctx.propsEl.appendChild(header);

  // Name field (always edits base shape — name is structural)
  const nameW = TextInput('Name', rawShape.name || '', v => { rawShape.name = v; onDirty(); });
  ctx.propsEl.appendChild(nameW.el);

  // Visible States — common to all shapes (controls visibility per state, empty/absent = always visible)
  if (stateNames.length > 0) {
    ctx.propsEl.appendChild(TagListEditor('Visible States', rawShape.visibleStates || [], stateNames, v => {
      if (v.length > 0) { rawShape.visibleStates = v; }
      else { delete rawShape.visibleStates; }
      onDirty();
    }).el);
  }

  // Type-specific properties (use proxy — auto-creates overrides in non-BASE state)
  switch (rawShape.type) {
    case 'group': buildGroupEditor(ctx.propsEl, shape, availableVars, onDirty); break;
    case 'circle': buildCircleEditor(ctx.propsEl, shape, availableVars, onDirty); break;
    case 'path': buildPathEditor(ctx.propsEl, shape, availableVars, onDirty); break;
    case 'bezierPath': case 'quadPath': buildBezierPathEditor(ctx.propsEl, shape, availableVars, onDirty); break;
    case 'lines': buildLinesEditor(ctx.propsEl, shape, availableVars, onDirty); break;
    case 'arc': buildArcEditor(ctx.propsEl, shape, availableVars, onDirty); break;
    case 'rect': buildRectEditor(ctx.propsEl, shape, availableVars, onDirty); break;
    case 'roundedRect': buildRoundedRectEditor(ctx.propsEl, shape, availableVars, onDirty); break;
    case 'boltCluster': buildBoltClusterEditor(ctx.propsEl, shape, availableVars, onDirty); break;
    case 'conditional': buildConditionalEditor(ctx.propsEl, shape, stateNames, onDirty); break;
    case 'particles': buildParticlesEditor(ctx.propsEl, shape, availableVars, stateNames, onDirty); break;
    case 'radialRepeat': buildRadialRepeatEditor(ctx.propsEl, shape, availableVars, onDirty); break;
    case 'repeat': buildRepeatEditor(ctx.propsEl, shape, availableVars, onDirty); break;
    case 'forEach': buildForEachEditor(ctx.propsEl, shape, onDirty); break;
    case 'effectRef': buildEffectRefEditor(ctx.propsEl, shape, availableVars, onDirty); break;
  }

  // Keyframe panel: Auto-key toggle + one "Key part" button, with per-channel
  // controls + the guided generator tucked under an "Advanced channels" disclosure.
  buildKeyframePanel(ctx.propsEl, rawShape, shape, onDirty);

  // Setup section (use proxy — auto-creates setup overrides in non-BASE state)
  buildSetupEditor(ctx.propsEl, shape, availableVars, onDirty);

  // State overrides section (uses rawShape to show actual override data)
  buildOverridesSection(ctx.propsEl, rawShape, onDirty);
}

// ─── Asset-level panel (shown when no shape is selected) ─────────────────────

function buildAssetPanel(art) {
  const onDirty = () => ctx.markDirty();

  const header = document.createElement('div');
  header.className = 'props-header';
  const title = document.createElement('span');
  title.style.cssText = 'font-weight:bold;color:#d4a056;flex:1;';
  title.textContent = `Asset: ${art.name || ctx.currentLabel || ''}`;
  header.appendChild(title);
  ctx.propsEl.appendChild(header);

  const hint = document.createElement('div');
  hint.style.cssText = 'color:#5a4a30;font-size:10px;padding:2px 4px 6px;';
  hint.textContent = 'Asset-level settings (no shape selected). Pick a shape to edit it.';
  ctx.propsEl.appendChild(hint);

  ctx.propsEl.appendChild(TextInput('Name', art.name || '', v => { art.name = v; onDirty(); }).el);

  // Space (aspect) — coords using w/h scale by these; never editable before.
  const spaceGroup = PropertyGroup('Space (aspect ratio)');
  const setW = (v) => { art.space = { widthFactor: v, heightFactor: art.space?.heightFactor ?? 1 }; onDirty(); };
  const setH = (v) => { art.space = { widthFactor: art.space?.widthFactor ?? 1, heightFactor: v }; onDirty(); };
  spaceGroup.addChild(NumberSlider('Width factor', 0.2, 3, 0.05, art.space?.widthFactor ?? 1, setW));
  spaceGroup.addChild(NumberSlider('Height factor', 0.2, 3, 0.05, art.space?.heightFactor ?? 1, setH));
  ctx.propsEl.appendChild(spaceGroup.el);

  // State transition blend time (also on the state bar; consolidated here).
  ctx.propsEl.appendChild(NumberSlider('Transition (ms)', 0, 2000, 50, art.transitionDuration || 0, v => {
    art.transitionDuration = v; onDirty();
  }).el);

  // Declared states — persisted so empty states survive a reload.
  const stateNames = (ctx.discoveredStates || []).filter(s => s !== 'BASE');
  const statesGroup = PropertyGroup(`Declared states (${stateNames.length})`);
  const note = document.createElement('div');
  note.style.cssText = 'color:#5a4a30;font-size:9px;padding:2px 4px;';
  note.textContent = stateNames.length ? stateNames.join(', ') : 'None — add states from the state bar above.';
  statesGroup.body.appendChild(note);
  ctx.propsEl.appendChild(statesGroup.el);

  // Asset-level setup (lineWidth/alpha/colors/etc. applied before all shapes).
  buildSetupEditor(ctx.propsEl, art, [], onDirty);
}

// ─── State Overrides ─────────────────────────────────────────────────────────

/** Get the overrides map for a raw shape (supports both 'states' and 'stateOverrides' keys). */
function getShapeOverridesMap(shape) {
  if (shape.states && typeof shape.states === 'object' && !Array.isArray(shape.states)) return shape.states;
  if (shape.stateOverrides && typeof shape.stateOverrides === 'object') return shape.stateOverrides;
  return null;
}

function buildOverridesSection(parent, rawShape, onDirty) {
  const container = document.createElement('div');
  container.className = 'overrides-section';
  buildOverridesContent(container, rawShape, onDirty);
  parent.appendChild(container);
}

function buildOverridesContent(container, rawShape, onDirty) {
  const state = ctx.currentEditState;
  const overridesMap = getShapeOverridesMap(rawShape);

  if (state === 'BASE') {
    // Read-only summary of all state overrides
    if (!overridesMap) return;
    const states = Object.keys(overridesMap);
    if (states.length === 0) return;

    const group = PropertyGroup(`State Overrides (${states.length} states)`);
    for (const [s, overrides] of Object.entries(overridesMap)) {
      const keys = Object.keys(overrides);
      const stateGroup = PropertyGroup(`${s} (${keys.length} props)`);
      for (const [k, v] of Object.entries(overrides)) {
        const lbl = document.createElement('div');
        lbl.style.cssText = 'color:#7a6a4a;font-size:10px;padding:2px 4px;';
        lbl.textContent = `${k}: ${JSON.stringify(v).slice(0, 50)}`;
        stateGroup.body.appendChild(lbl);
      }
      group.addChild(stateGroup);
    }
    container.appendChild(group.el);
    return;
  }

  // Non-BASE: show active overrides with reset buttons
  if (!overridesMap || !overridesMap[state]) return;
  const stateOverrides = overridesMap[state];
  if (Object.keys(stateOverrides).length === 0) return;

  const divider = document.createElement('div');
  divider.style.cssText = 'border-top:2px solid #33ddcc44;margin:8px 0 4px;padding-top:4px;';
  const label = document.createElement('div');
  label.style.cssText = 'color:#33ddcc;font-size:11px;font-weight:bold;margin-bottom:4px;';
  label.textContent = `Active Overrides: ${state}`;
  divider.appendChild(label);
  container.appendChild(divider);

  for (const [key, val] of Object.entries(stateOverrides)) {
    if (key === 'setup' && typeof val === 'object') {
      // Show setup overrides
      for (const [sk, sv] of Object.entries(val)) {
        addOverrideRow(container, `setup.${sk}`, sv, rawShape[sk], () => {
          delete val[sk];
          if (Object.keys(val).length === 0) delete stateOverrides.setup;
          if (Object.keys(stateOverrides).length === 0) delete overridesMap[state];
          onDirty();
          buildShapeProps();
          ctx.rebuildStateBar();
          ctx.rebuildTree();
        });
      }
    } else {
      addOverrideRow(container, key, val, rawShape[key], () => {
        delete stateOverrides[key];
        if (Object.keys(stateOverrides).length === 0) delete overridesMap[state];
        onDirty();
        buildShapeProps();
        ctx.rebuildStateBar();
        ctx.rebuildTree();
      });
    }
  }
}

function addOverrideRow(parent, key, val, baseVal, onReset) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:4px;padding:2px 0;';

  const keyEl = document.createElement('span');
  keyEl.style.cssText = 'color:#33ddcc;font-size:10px;min-width:80px;';
  keyEl.textContent = key;
  row.appendChild(keyEl);

  const valEl = document.createElement('span');
  valEl.style.cssText = 'color:#7a6a4a;font-size:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  valEl.textContent = JSON.stringify(val).slice(0, 40);
  row.appendChild(valEl);

  if (baseVal !== undefined) {
    const baseHint = document.createElement('span');
    baseHint.style.cssText = 'color:#5a4a30;font-size:9px;';
    baseHint.textContent = `base: ${JSON.stringify(baseVal).slice(0, 20)}`;
    row.appendChild(baseHint);
  }

  const resetBtn = Button('Reset', onReset, 'subtle');
  resetBtn.el.style.cssText += 'padding:1px 6px;font-size:9px;';
  resetBtn.el.className += ' editor-btn-danger';
  row.appendChild(resetBtn.el);

  parent.appendChild(row);
}

// ─── Per-Type Shape Editors ──────────────────────────────────────────────────

function buildGroupEditor(parent, shape, vars, onDirty) {
  const set = (k, v) => { shape[k] = v; onDirty(); };
  parent.appendChild(CoordEditor('cx', shape.cx || 0, vars, v => set('cx', v)).el);
  parent.appendChild(CoordEditor('cy', shape.cy || 0, vars, v => set('cy', v)).el);
  parent.appendChild(NumberSlider('Rotation', -Math.PI, Math.PI, 0.05, shape.rotation || 0, v => {
    const r = ctx.previewRadius;
    const art = ctx.currentArt;
    const w = art && art.space ? r * (art.space.widthFactor || 1) : r;
    const h = art && art.space ? r * (art.space.heightFactor || 1) : r;
    rotateShapeAroundCenter(shape, v, { r, w, h });
    onDirty();
  }).el);

  const info = document.createElement('div');
  info.style.cssText = 'color:#5a4a30;font-size:10px;padding:4px;';
  info.textContent = `${(shape.shapes || []).length} child shape(s) — select in tree to edit`;
  parent.appendChild(info);
}

function buildRadialRepeatEditor(parent, shape, vars, onDirty) {
  const set = (k, v) => { shape[k] = v; onDirty(); };
  parent.appendChild(CoordEditor('cx', shape.cx || 0, vars, v => set('cx', v)).el);
  parent.appendChild(CoordEditor('cy', shape.cy || 0, vars, v => set('cy', v)).el);
  parent.appendChild(CoordEditor('radius', shape.radius || 0, vars, v => set('radius', v)).el);
  parent.appendChild(NumberSlider('Count', 1, 24, 1, shape.count || 6, v => set('count', v)).el);

  const info = document.createElement('div');
  info.style.cssText = 'color:#5a4a30;font-size:10px;padding:4px;';
  info.textContent = `${(shape.shapes || []).length} child shape(s) — select in tree to edit`;
  parent.appendChild(info);
}

function buildCircleEditor(parent, shape, vars, onDirty) {
  const set = (k, v) => { shape[k] = v; onDirty(); };
  parent.appendChild(CoordEditor('cx', shape.cx, vars, v => set('cx', v)).el);
  parent.appendChild(CoordEditor('cy', shape.cy, vars, v => set('cy', v)).el);

  const r = ctx.previewRadius || 60;
  const clipKey = ctx.keyTargetClip || '*';
  if (shape.radiusAbs !== undefined) {
    const ra = shape.radiusAbs; // sampled value when this radius is keyframed
    const raTracked = !!getTrack(shape, clipKey, 'radiusAbs');
    if (typeof ra === 'object' && ra !== null && !raTracked) {
      // Static anim-var object (no keyframe track), e.g. { base: 18, breathe: 6 }:
      // the component editor preserves its terms (a NumberSlider would flatten it).
      parent.appendChild(buildAnimVarEditor('Radius (abs px)', shape, 'radiusAbs', vars, 0.1, 60, 0.5, onDirty));
    } else {
      // Plain number, or a KEYFRAMED radiusAbs (the proxy returns the sampled value
      // and routes the edit to a keyframe). Show the scalar so the slider edits the
      // pose at the playhead; coerceToTrack keeps a coord-object track object-shaped.
      const cur = (typeof ra === 'object' && ra !== null) ? (ra.base ?? 0) : ra;
      parent.appendChild(NumberSlider('Radius (abs px)', 0.1, 60, 0.5, cur, v => set('radiusAbs', v)).el);
    }
    parent.appendChild(radiusModeToggle('→ use r-relative radius', () => {
      const px = typeof shape.radiusAbs === 'object' ? (shape.radiusAbs.base || 0) : shape.radiusAbs;
      delete shape.radiusAbs;
      shape.radius = Math.round((px / r) * 1000) / 1000;
      onDirty(); buildShapeProps();
    }));
  } else {
    parent.appendChild(NumberSlider('Radius', 0.01, 1, 0.01, shape.radius || 0.1, v => set('radius', v)).el);
    parent.appendChild(radiusModeToggle('→ use absolute px radius', () => {
      shape.radiusAbs = Math.round((shape.radius || 0.1) * r * 10) / 10;
      delete shape.radius;
      onDirty(); buildShapeProps();
    }));
  }
  if (shape.radiusOffset !== undefined) {
    parent.appendChild(NumberSlider('Radius Offset', -5, 5, 0.5, shape.radiusOffset, v => set('radiusOffset', v)).el);
  } else {
    parent.appendChild(addFieldButton('+ Radius offset', () => { shape.radiusOffset = 0; onDirty(); buildShapeProps(); }));
  }
  parent.appendChild(NumberSlider('Rotation', -Math.PI, Math.PI, 0.05, shape.rotation || 0, v => set('rotation', v)).el);

  parent.appendChild(Toggle('Stroke', shape.stroke || false, v => set('stroke', v)).el);
  parent.appendChild(Toggle('Fill', shape.fill || false, v => set('fill', v)).el);
  if (shape.fillColor !== undefined) {
    parent.appendChild(ColorInput('Fill Color', shape.fillColor, v => set('fillColor', v)).el);
  }
}

// A time-aware [x,y] number row for an array-point at `propPath` (e.g. `points.2`,
// `segments.0.1`, `curves.1.cp`). Shows the value sampled at the playhead and routes
// edits through commitShapeEdit (keyframe / state override / base) — so the fields
// animate on scrub/playback and editing a coordinate keys it, exactly like a canvas
// drag of that vertex.
function livePointRow(rawShape, propPath, onDirty, labelText) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:4px;align-items:center;';
  if (labelText != null) {
    const lbl = document.createElement('span');
    lbl.style.cssText = 'color:#5a4a30;font-size:10px;width:30px;';
    lbl.textContent = labelText;
    row.appendChild(lbl);
  }
  const cur = () => { const v = editValueAt(rawShape, propPath); return Array.isArray(v) ? v : [0, 0]; };
  for (let ci = 0; ci < 2; ci++) {
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'editor-num-input';
    inp.style.width = '70px'; inp.step = 0.05; inp.value = cur()[ci];
    const idx = ci;
    inp.addEventListener('change', () => {
      const p = [...cur()]; p[idx] = parseFloat(inp.value) || 0;
      commitShapeEdit(rawShape, propPath, p); onDirty();
    });
    row.appendChild(inp);
  }
  return row;
}

function buildPathEditor(parent, shape, vars, onDirty) {
  const set = (k, v) => { shape[k] = v; onDirty(); };
  const rawShape = getShapeAtPath(ctx.currentArt.shapes, ctx.selectedShapePath) || shape;

  parent.appendChild(NumberSlider('Rotation', -Math.PI, Math.PI, 0.05, shape.rotation || 0, v => set('rotation', v)).el);
  parent.appendChild(Toggle('Closed', shape.closed || false, v => set('closed', v)).el);
  parent.appendChild(Toggle('Stroke', shape.stroke || false, v => set('stroke', v)).el);
  parent.appendChild(Toggle('Fill', shape.fill || false, v => set('fill', v)).el);
  if (shape.fillColor !== undefined) {
    parent.appendChild(ColorInput('Fill Color', shape.fillColor, v => set('fillColor', v)).el);
  }

  if (shape.points) {
    const group = PropertyGroup(`Points (${shape.points.length})`);
    parent.appendChild(group.el);

    // In non-BASE state, clone points into override on first edit so mutations
    // go to the override copy instead of modifying the base shape.
    let cloned = ctx.currentEditState === 'BASE';
    function ensureClone() {
      if (!cloned) {
        shape.points = JSON.parse(JSON.stringify(shape.points));
        cloned = true;
      }
    }
    // Get the point at index from the (possibly cloned) points array
    function pt(i) { return shape.points[i]; }

    function rebuildPoints() {
      group.body.innerHTML = '';
      shape.points.forEach((_pt, i) => {
        const isObj = typeof _pt === 'object' && !Array.isArray(_pt);
        const ptGroup = PropertyGroup(`[${i}]`);

        if (isObj) {
          ptGroup.addChild(CoordEditor('x', _pt.x, vars, v => { ensureClone(); pt(i).x = v; onDirty(); }));
          ptGroup.addChild(CoordEditor('y', _pt.y, vars, v => { ensureClone(); pt(i).y = v; onDirty(); }));
        } else if (Array.isArray(_pt)) {
          ptGroup.body.appendChild(livePointRow(rawShape, `points.${i}`, onDirty));
        }

        const delBtn = document.createElement('button');
        delBtn.className = 'editor-btn editor-btn-danger';
        delBtn.style.cssText = 'padding:1px 4px;font-size:10px;';
        delBtn.textContent = '\u00d7';
        delBtn.addEventListener('click', () => { ensureClone(); shape.points.splice(i, 1); onDirty(); rebuildPoints(); });
        ptGroup.body.appendChild(delBtn);

        group.addChild(ptGroup);
      });

      const addBtn = Button('+ Point', () => {
        ensureClone();
        shape.points.push({ x: { w: 0 }, y: { h: 0 } });
        onDirty();
        rebuildPoints();
      }, 'subtle');
      group.body.appendChild(addBtn.el);
    }
    rebuildPoints();
  }
}

function buildBezierPathEditor(parent, shape, vars, onDirty) {
  const set = (k, v) => { shape[k] = v; onDirty(); };
  const rawShape = getShapeAtPath(ctx.currentArt.shapes, ctx.selectedShapePath) || shape;

  parent.appendChild(NumberSlider('Rotation', -Math.PI, Math.PI, 0.05, shape.rotation || 0, v => set('rotation', v)).el);
  parent.appendChild(Toggle('Closed', shape.closed || false, v => set('closed', v)).el);
  parent.appendChild(Toggle('Stroke', shape.stroke || false, v => set('stroke', v)).el);
  parent.appendChild(Toggle('Fill', shape.fill || false, v => set('fill', v)).el);
  if (shape.fillColor !== undefined) {
    parent.appendChild(ColorInput('Fill Color', shape.fillColor, v => set('fillColor', v)).el);
  }

  // Start point
  if (shape.start && Array.isArray(shape.start)) {
    const startGroup = PropertyGroup('Start');
    startGroup.body.appendChild(livePointRow(rawShape, 'start', onDirty));
    parent.appendChild(startGroup.el);
  }

  // Curves
  if (shape.curves) {
    const isQuad = shape.type === 'quadPath';
    const group = PropertyGroup(`Curves (${shape.curves.length})`);
    parent.appendChild(group.el);

    function rebuildCurves() {
      group.body.innerHTML = '';
      shape.curves.forEach((c, i) => {
        const cGroup = PropertyGroup(`[${i}]`);
        const addPt = (key) => {
          if (c[key] && Array.isArray(c[key])) {
            const pg = PropertyGroup(key);
            pg.body.appendChild(livePointRow(rawShape, `curves.${i}.${key}`, onDirty));
            cGroup.addChild(pg);
          }
        };
        addPt('cp1'); addPt('cp'); addPt('cp2'); addPt('to');

        const delBtn = document.createElement('button');
        delBtn.className = 'editor-btn editor-btn-danger';
        delBtn.style.cssText = 'padding:1px 4px;font-size:10px;';
        delBtn.textContent = '\u00d7';
        delBtn.addEventListener('click', () => { shape.curves.splice(i, 1); onDirty(); rebuildCurves(); });
        cGroup.body.appendChild(delBtn);

        group.addChild(cGroup);
      });

      const addBtn = Button('+ Curve', () => {
        const last = shape.curves.length > 0 ? shape.curves[shape.curves.length - 1].to : shape.start;
        const base = Array.isArray(last) ? last : [0, 0];
        if (isQuad) {
          shape.curves.push({ cp: [base[0] + 0.1, base[1]], to: [base[0] + 0.2, base[1]] });
        } else {
          shape.curves.push({ cp1: [base[0] + 0.1, base[1]], cp2: [base[0] + 0.15, base[1]], to: [base[0] + 0.2, base[1]] });
        }
        onDirty();
        rebuildCurves();
      }, 'subtle');
      group.body.appendChild(addBtn.el);
    }
    rebuildCurves();
  }
}

function buildLinesEditor(parent, shape, vars, onDirty) {
  const set = (k, v) => { shape[k] = v; onDirty(); };
  const rawShape = getShapeAtPath(ctx.currentArt.shapes, ctx.selectedShapePath) || shape;

  parent.appendChild(NumberSlider('Rotation', -Math.PI, Math.PI, 0.05, shape.rotation || 0, v => set('rotation', v)).el);
  parent.appendChild(Toggle('Stroke', shape.stroke || false, v => set('stroke', v)).el);
  parent.appendChild(Toggle('Fill', shape.fill || false, v => set('fill', v)).el);
  if (shape.fillColor !== undefined) {
    parent.appendChild(ColorInput('Fill Color', shape.fillColor, v => set('fillColor', v)).el);
  }

  if (shape.segments) {
    const group = PropertyGroup(`Segments (${shape.segments.length})`);
    parent.appendChild(group.el);

    // In non-BASE state, clone segments into override on first edit
    let cloned = ctx.currentEditState === 'BASE';
    function ensureClone() {
      if (!cloned) {
        shape.segments = JSON.parse(JSON.stringify(shape.segments));
        cloned = true;
      }
    }
    function seg(i) { return shape.segments[i]; }

    function rebuildSegments() {
      group.body.innerHTML = '';
      shape.segments.forEach((_seg, i) => {
        const segGroup = PropertyGroup(`Segment ${i}`);

        _seg.forEach((_pt, pi) => {
          const isObj = typeof _pt === 'object' && !Array.isArray(_pt);
          const label = pi === 0 ? 'from' : 'to';

          if (isObj) {
            segGroup.addChild(CoordEditor(`${label}.x`, _pt.x, vars, v => { ensureClone(); seg(i)[pi].x = v; onDirty(); }));
            segGroup.addChild(CoordEditor(`${label}.y`, _pt.y, vars, v => { ensureClone(); seg(i)[pi].y = v; onDirty(); }));
          } else if (Array.isArray(_pt)) {
            segGroup.body.appendChild(livePointRow(rawShape, `segments.${i}.${pi}`, onDirty, label));
          }
        });

        const delBtn = Button('\u00d7 Del', () => { ensureClone(); shape.segments.splice(i, 1); onDirty(); rebuildSegments(); }, 'subtle');
        delBtn.el.className += ' editor-btn-danger';
        delBtn.el.style.cssText += 'padding:1px 4px;font-size:10px;';
        segGroup.body.appendChild(delBtn.el);
        group.addChild(segGroup);
      });

      const addBtn = Button('+ Segment', () => {
        ensureClone();
        shape.segments.push([[0, 0], [0.3, 0]]);
        onDirty();
        rebuildSegments();
      }, 'subtle');
      group.body.appendChild(addBtn.el);
    }
    rebuildSegments();
  }
}

function buildArcEditor(parent, shape, vars, onDirty) {
  const set = (k, v) => { shape[k] = v; onDirty(); };
  parent.appendChild(CoordEditor('cx', shape.cx, vars, v => set('cx', v)).el);
  parent.appendChild(CoordEditor('cy', shape.cy, vars, v => set('cy', v)).el);
  parent.appendChild(NumberSlider('Radius', 0.01, 2, 0.01, shape.radius || 0.5, v => set('radius', v)).el);
  parent.appendChild(TextInput('Start Angle', String(shape.startAngle ?? 0), v => { shape.startAngle = isNaN(+v) ? v : +v; onDirty(); }).el);
  parent.appendChild(TextInput('End Angle', String(shape.endAngle ?? 'PI*2'), v => { shape.endAngle = isNaN(+v) ? v : +v; onDirty(); }).el);
  parent.appendChild(NumberSlider('Rotation', -Math.PI, Math.PI, 0.05, shape.rotation || 0, v => set('rotation', v)).el);
  parent.appendChild(Toggle('Stroke', shape.stroke || false, v => set('stroke', v)).el);
  parent.appendChild(Toggle('Fill', shape.fill || false, v => set('fill', v)).el);
}

function buildRectEditor(parent, shape, vars, onDirty) {
  const set = (k, v) => { shape[k] = v; onDirty(); };
  parent.appendChild(CoordEditor('x', shape.x, vars, v => set('x', v)).el);
  parent.appendChild(CoordEditor('y', shape.y, vars, v => set('y', v)).el);
  parent.appendChild(CoordEditor('w', shape.w, vars, v => set('w', v)).el);
  parent.appendChild(CoordEditor('h', shape.h, vars, v => set('h', v)).el);
  parent.appendChild(NumberSlider('Rotation', -Math.PI, Math.PI, 0.05, shape.rotation || 0, v => set('rotation', v)).el);
  parent.appendChild(Toggle('Stroke', shape.stroke || false, v => set('stroke', v)).el);
  parent.appendChild(Toggle('Fill', shape.fill || false, v => set('fill', v)).el);
}

function buildRoundedRectEditor(parent, shape, vars, onDirty) {
  const set = (k, v) => { shape[k] = v; onDirty(); };
  parent.appendChild(CoordEditor('x', shape.x, vars, v => set('x', v)).el);
  parent.appendChild(CoordEditor('y', shape.y, vars, v => set('y', v)).el);
  parent.appendChild(CoordEditor('width', shape.width, vars, v => set('width', v)).el);
  parent.appendChild(CoordEditor('height', shape.height, vars, v => set('height', v)).el);
  parent.appendChild(NumberSlider('Corner Radius', 0, 0.5, 0.01, shape.cornerRadius || 0.1, v => set('cornerRadius', v)).el);
  parent.appendChild(NumberSlider('Rotation', -Math.PI, Math.PI, 0.05, shape.rotation || 0, v => set('rotation', v)).el);
  parent.appendChild(Toggle('Stroke', shape.stroke || false, v => set('stroke', v)).el);
  parent.appendChild(Toggle('Fill', shape.fill || false, v => set('fill', v)).el);
}

function buildBoltClusterEditor(parent, shape, vars, onDirty) {
  const set = (k, v) => { shape[k] = v; onDirty(); };
  parent.appendChild(CoordEditor('cx', shape.cx, vars, v => set('cx', v)).el);
  parent.appendChild(CoordEditor('cy', shape.cy, vars, v => set('cy', v)).el);
  parent.appendChild(NumberSlider('Spacing', 0.01, 1, 0.01, shape.spacing || 0.1, v => set('spacing', v)).el);
  parent.appendChild(NumberSlider('Dot Radius', 0.1, 3, 0.1, shape.dotRadius || 0.8, v => set('dotRadius', v)).el);
  parent.appendChild(NumberSlider('Rotation', -Math.PI, Math.PI, 0.05, shape.rotation || 0, v => set('rotation', v)).el);
  if (shape.fillColor !== undefined) {
    parent.appendChild(ColorInput('Fill Color', shape.fillColor, v => set('fillColor', v)).el);
  }
}

// ─── Keyframe panel (timeline keying + guided generator) ─────────────────────

const _kfCloneVal = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

/** Bump a value's dominant term by `amount` (for the guided looping generator). */
function _kfBump(v, amount) {
  if (typeof v === 'number') return v + amount;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const term = ('base' in v) ? 'base' : 'r';
    return { ...v, [term]: (v[term] || 0) + amount };
  }
  return v;
}

/**
 * Keyframe controls for the selected shape. The headline flow is AUTO-KEY: with
 * Auto-key ON, scrubbing the timeline and tweaking this part writes keyframes (done
 * transparently by the anim proxy in buildShapeProps). This panel surfaces the
 * toggle, a single "Key part" snapshot button, and — under a collapsed "Advanced
 * channels" disclosure — per-property keying / clear and the guided looping-motion
 * generator. `shape` is the anim proxy (effective sampled-or-base values); keyframe
 * writes target `rawShape`.
 */
function buildKeyframePanel(parent, rawShape, shape, onDirty) {
  if (!rawShape) return;
  const props = keyframeableProps(rawShape);
  if (!props.length) return;
  const art = ctx.currentArt;
  const clipKey = ctx.keyTargetClip || '*';
  const clipLabel = clipKey === '*' ? 'Always (every state)' : clipKey;
  const t = Math.round(ctx.playhead || 0);
  const partName = rawShape.name || rawShape.type || 'part';

  const group = PropertyGroup(`Keyframes → ${clipLabel}`);

  // Headline: Auto-key toggle + a one-click "Key part" snapshot at the playhead.
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 4px;';
  head.appendChild(Toggle('Auto-key', ctx.autoKey, (v) => {
    ctx.autoKey = v; ctx.rebuildProps?.(); ctx.rebuildTimeline?.();
  }).el);
  const keyBtn = Button(`◆ Key ${partName.slice(0, 12)} @ ${t}ms`, () => {
    ensureClip(art, clipKey);
    keyPose(rawShape, clipKey, ctx.playhead || 0, (prop) => _kfCloneVal(getPropValue(shape, prop)));
    onDirty(); ctx.rebuildTimeline?.(); ctx.rebuildProps?.();
  }, 'primary');
  keyBtn.el.title = 'Snapshot this part’s animated channels (or every channel, first time) as a keyframe at the playhead';
  head.appendChild(keyBtn.el);
  group.body.appendChild(head);

  const hint = document.createElement('div');
  hint.style.cssText = 'color:#5a4a30;font-size:9px;padding:1px 4px;';
  hint.textContent = ctx.autoKey
    ? 'Auto-key ON · scrub the timeline, then tweak this part — each change keys at the playhead.'
    : 'Auto-key OFF · edits change the base value. Use “Key part” or the channels below to key.';
  group.body.appendChild(hint);

  // Advanced channels: per-property key / loop / clear + the guided generator.
  const adv = PropertyGroup('Advanced channels');
  for (const p of props) {
    const track = getTrack(rawShape, clipKey, p.prop);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:1px 4px;font-size:11px;';
    const lbl = document.createElement('span');
    lbl.style.cssText = `flex:1;color:${track ? '#d4a056' : '#8a7a5a'};`;
    lbl.textContent = p.label + (track ? `  ◆${track.length}` : '');
    row.appendChild(lbl);
    if (track) {
      const loopBtn = Button('loop', () => {
        const clip = clipMeta(art, clipKey);
        makeLoopable(rawShape, clipKey, p.prop, clip ? clip.duration : 2000);
        onDirty(); ctx.rebuildTimeline?.(); ctx.rebuildProps?.();
      }, 'subtle');
      loopBtn.el.title = 'Copy the first key to t=end (seamless loop)';
      loopBtn.el.style.cssText += 'font-size:9px;padding:1px 5px;';
      row.appendChild(loopBtn.el);
      const clrBtn = Button('✕', () => {
        deleteTrack(rawShape, clipKey, p.prop);
        onDirty(); ctx.rebuildTimeline?.(); ctx.rebuildProps?.();
      }, 'subtle');
      clrBtn.el.title = 'Delete this channel’s track';
      clrBtn.el.className += ' editor-btn-danger';
      clrBtn.el.style.cssText += 'font-size:9px;padding:1px 5px;';
      row.appendChild(clrBtn.el);
    }
    const keyBtn2 = Button('◆ key', () => {
      ensureClip(art, clipKey);
      const v = getPropValue(shape, p.prop); // effective (sampled-or-base) value
      setKeyframe(rawShape, clipKey, p.prop, Math.round(ctx.playhead || 0), _kfCloneVal(v ?? 0));
      onDirty(); ctx.rebuildTimeline?.(); ctx.rebuildProps?.();
    }, 'subtle');
    keyBtn2.el.title = `Set a keyframe for ${p.label} at the playhead`;
    keyBtn2.el.style.cssText += 'font-size:9px;padding:1px 6px;color:#d4a056;';
    row.appendChild(keyBtn2.el);
    adv.body.appendChild(row);
  }

  // Guided generator: a one-click looping motion (min → max → min, easeInOutSine).
  const gen = document.createElement('div');
  gen.style.cssText = 'border-top:1px solid #2a2a3a;margin-top:4px;padding-top:4px;';
  let genIdx = 0, amount = 0.1, periodSec = 2;
  gen.appendChild(Select('Add motion', props.map((p, i) => ({ value: String(i), label: p.label })), '0', v => { genIdx = +v; }).el);
  gen.appendChild(NumberSlider('Amount (±)', 0.01, 2, 0.01, amount, v => { amount = v; }).el);
  gen.appendChild(NumberSlider('Period (s)', 0.2, 12, 0.1, periodSec, v => { periodSec = v; }).el);
  gen.appendChild(Button('Add looping motion', () => {
    const target = props[genIdx];
    const durMs = Math.round(periodSec * 1000);
    const existing = clipMeta(art, clipKey);
    ensureClip(art, clipKey, { duration: existing ? existing.duration : durMs });
    const dur = clipMeta(art, clipKey).duration;
    const base = getPropValue(shape, target.prop) ?? (target.kind === 'coord' ? { base: 0 } : 0);
    const peak = _kfBump(_kfCloneVal(base), amount);
    setKeyframe(rawShape, clipKey, target.prop, 0, _kfCloneVal(base), 'easeInOutSine');
    setKeyframe(rawShape, clipKey, target.prop, Math.round(dur / 2), peak, 'easeInOutSine');
    setKeyframe(rawShape, clipKey, target.prop, dur, _kfCloneVal(base), 'easeInOutSine');
    onDirty(); ctx.rebuildTimeline?.(); ctx.rebuildProps?.();
  }, 'primary').el);
  adv.body.appendChild(gen);

  // Start the Advanced disclosure collapsed (it's the de-emphasized path).
  adv.el.querySelector('.editor-prop-group-header')?.click();
  group.body.appendChild(adv.el);

  parent.appendChild(group.el);
}

function buildEffectRefEditor(parent, shape, vars, onDirty) {
  const set = (k, v) => { shape[k] = v; onDirty(); };
  const ids = Object.keys(VFX_DEFS || {});
  const opts = ids.map(id => ({ value: id, label: id + (VFX_DEFS[id]?.lifecycle === 'persistent' ? '' : ' (one-shot)') }));
  if (!shape.effect || !ids.includes(shape.effect)) opts.unshift({ value: shape.effect || '', label: shape.effect || '(pick an effect)' });
  parent.appendChild(Select('VFX Effect', opts, shape.effect || '', v => { set('effect', v); buildShapeProps(); }).el);
  parent.appendChild(CoordEditor('cx', shape.cx || 0, vars, v => set('cx', v)).el);
  parent.appendChild(CoordEditor('cy', shape.cy || 0, vars, v => set('cy', v)).el);
  parent.appendChild(NumberSlider('Scale (×r)', 0.1, 5, 0.05, shape.scale ?? 1, v => set('scale', v)).el);

  // Playback control: an attached VFX runs INDEPENDENTLY (its own clock — speed,
  // looping) by default; a keyframe `progress` track in the key-target clip is the
  // explicit opt-in that drives/fires it from the art timeline.
  const def = VFX_DEFS[shape.effect];
  const persistent = def && def.lifecycle === 'persistent';
  const art = ctx.currentArt;
  const clipKey = ctx.keyTargetClip || '*';
  const clipLabel = clipKey === '*' ? 'every state' : clipKey;
  const driven = !!getTrack(shape, clipKey, 'progress');

  const grp = PropertyGroup('Playback');
  const info = document.createElement('div');
  info.style.cssText = 'color:#7fb0d8;font-size:9px;padding:2px 4px;line-height:1.5;';
  if (!def) {
    info.textContent = 'References a VFX effect by id. Author effects in the VFX tab.';
  } else if (driven) {
    info.textContent = `Timeline-driven: the "${clipLabel}" clip plays this effect via a progress 0→1 track (drag its keys on the timeline). Clear it to hand playback back to the effect's own clock.`;
  } else if (persistent) {
    info.textContent = `Persistent — runs continuously on its own clock, independent of the timeline. Keyframe cx/cy/scale to move it, or add a progress track to sync/fire it with the "${clipLabel}" clip.`;
  } else {
    info.textContent = `One-shot — draws frozen until driven. Add a progress 0→1 track so the "${clipLabel}" clip fires it (a burst tied to the animation). Tip: limit it with Visible States.`;
  }
  grp.body.appendChild(info);

  if (def) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:2px;';
    const fireBtn = Button(driven ? `↻ Re-fire over ${clipLabel}` : `▶ Fire over ${clipLabel}`, () => {
      const c = ensureClip(art, clipKey);
      setKeyframe(shape, clipKey, 'progress', 0, 0, 'linear');
      setKeyframe(shape, clipKey, 'progress', c.duration, 1, 'linear');
      onDirty(); ctx.rebuildTimeline?.(); ctx.rebuildProps?.();
    }, 'primary');
    fireBtn.el.title = `Write a progress 0→1 ramp across the "${clipLabel}" clip so the effect plays in sync with the animation`;
    row.appendChild(fireBtn.el);
    if (driven) {
      const clr = Button('Clear firing', () => {
        deleteTrack(shape, clipKey, 'progress');
        onDirty(); ctx.rebuildTimeline?.(); ctx.rebuildProps?.();
      }, 'subtle');
      clr.el.className += ' editor-btn-danger';
      row.appendChild(clr.el);
    }
    grp.body.appendChild(row);
  }
  parent.appendChild(grp.el);
}

function buildConditionalEditor(parent, shape, _stateNames, _onDirty) {
  const info = document.createElement('div');
  info.style.cssText = 'color:#5a4a30;font-size:10px;padding:4px;';
  info.textContent = `${(shape.shapes || []).length} child shape(s) \u2014 select in tree to edit`;
  parent.appendChild(info);
}

function buildParticlesEditor(parent, shape, vars, stateNames, onDirty) {
  if (shape.emitters) {
    shape.emitters.forEach((emitter, ei) => {
      const emGroup = PropertyGroup(`Emitter ${ei} (${emitter.kind})`);
      parent.appendChild(emGroup.el);

      const emSet = (k, v) => { emitter[k] = v; onDirty(); };

      emGroup.addChild(Select('Kind', ['dots', 'lines', 'strips'], emitter.kind || 'dots', v => emSet('kind', v)));
      emGroup.addChild(CoordEditor('cx', emitter.cx, vars, v => emSet('cx', v)));
      emGroup.addChild(CoordEditor('cy', emitter.cy, vars, v => emSet('cy', v)));
      emGroup.addChild(NumberSlider('Count', 1, 100, 1, emitter.count || 1, v => emSet('count', v)));

      if (emitter.kind === 'dots') {
        if (emitter.offsetX !== undefined) emGroup.addChild(NumberSlider('Offset X', -2, 2, 0.05, emitter.offsetX, v => emSet('offsetX', v)));
        emGroup.addChild(NumberSlider('Spread X', 0, 2, 0.05, emitter.spreadX || 0.5, v => emSet('spreadX', v)));
        emGroup.addChild(NumberSlider('Spread Y', 0, 2, 0.05, emitter.spreadY || 0.5, v => emSet('spreadY', v)));
        emGroup.addChild(NumberSlider('Size Min', 0.1, 5, 0.1, emitter.sizeMin || 0.5, v => emSet('sizeMin', v)));
        emGroup.addChild(NumberSlider('Size Range', 0, 5, 0.1, emitter.sizeRange || 1, v => emSet('sizeRange', v)));
        emGroup.addChild(NumberSlider('Alpha Min', 0, 1, 0.05, emitter.alphaMin || 0.3, v => emSet('alphaMin', v)));
        emGroup.addChild(NumberSlider('Alpha Range', 0, 1, 0.05, emitter.alphaRange || 0.5, v => emSet('alphaRange', v)));
        if (emitter.colorThreshold !== undefined) emGroup.addChild(NumberSlider('Color Threshold', 0, 1, 0.05, emitter.colorThreshold, v => emSet('colorThreshold', v)));

        if (emitter.colors) {
          emitter.colors.forEach((c, ci) => {
            emGroup.addChild(ColorInput(`Color [${ci}]`, c, v => { emitter.colors[ci] = v; onDirty(); }));
          });
        }
        if (emitter.shadowColor) emGroup.addChild(ColorInput('Shadow Color', emitter.shadowColor, v => emSet('shadowColor', v)));
        if (emitter.shadowBlur !== undefined) emGroup.addChild(NumberSlider('Shadow Blur', 0, 30, 1, emitter.shadowBlur, v => emSet('shadowBlur', v)));
      } else if (emitter.kind === 'lines') {
        if (emitter.startOffset !== undefined) emGroup.addChild(NumberSlider('Start Offset', 0, 2, 0.05, emitter.startOffset, v => emSet('startOffset', v)));
        if (emitter.spreadFactor !== undefined) emGroup.addChild(NumberSlider('Spread Factor', 0, 2, 0.05, emitter.spreadFactor, v => emSet('spreadFactor', v)));
        if (emitter.reachOffset !== undefined) emGroup.addChild(NumberSlider('Reach Offset', 0, 2, 0.05, emitter.reachOffset, v => emSet('reachOffset', v)));
        if (emitter.reachFactor !== undefined) emGroup.addChild(NumberSlider('Reach Factor', 0, 2, 0.05, emitter.reachFactor, v => emSet('reachFactor', v)));
        emGroup.addChild(NumberSlider('Alpha Min', 0, 1, 0.05, emitter.alphaMin || 0.3, v => emSet('alphaMin', v)));
        emGroup.addChild(NumberSlider('Alpha Range', 0, 1, 0.05, emitter.alphaRange || 0.5, v => emSet('alphaRange', v)));
        emGroup.addChild(ColorInput('Color', emitter.color || '#ffffff', v => emSet('color', v)));
        emGroup.addChild(NumberSlider('Line Width', 0.1, 5, 0.1, emitter.lineWidth || 1, v => emSet('lineWidth', v)));
      } else if (emitter.kind === 'strips') {
        emGroup.addChild(NumberSlider('Spread', 0.1, 2, 0.05, emitter.spread || 0.9, v => emSet('spread', v)));
        emGroup.addChild(NumberSlider('Strip Length', 0.01, 0.5, 0.01, emitter.stripLength || 0.12, v => emSet('stripLength', v)));
        emGroup.addChild(NumberSlider('Line Width', 0.005, 0.1, 0.005, emitter.lineWidth || 0.02, v => emSet('lineWidth', v)));
        emGroup.addChild(NumberSlider('Rotate Speed Min', 0, 0.02, 0.001, emitter.rotateSpeedMin || 0.002, v => emSet('rotateSpeedMin', v)));
        emGroup.addChild(NumberSlider('Rotate Speed Max', 0, 0.02, 0.001, emitter.rotateSpeedMax || 0.008, v => emSet('rotateSpeedMax', v)));
        emGroup.addChild(NumberSlider('Alpha Min', 0, 1, 0.05, emitter.alphaMin || 0.35, v => emSet('alphaMin', v)));
        emGroup.addChild(NumberSlider('Alpha Range', 0, 1, 0.05, emitter.alphaRange || 0.5, v => emSet('alphaRange', v)));
        if (emitter.colors) {
          emitter.colors.forEach((c, ci) => {
            emGroup.addChild(ColorInput(`Color [${ci}]`, c, v => { emitter.colors[ci] = v; onDirty(); }));
          });
        }
        if (emitter.shadowColor) emGroup.addChild(ColorInput('Shadow Color', emitter.shadowColor, v => emSet('shadowColor', v)));
        if (emitter.shadowBlur !== undefined) emGroup.addChild(NumberSlider('Shadow Blur', 0, 30, 1, emitter.shadowBlur, v => emSet('shadowBlur', v)));
      }

      const delBtn = Button('Delete Emitter', () => {
        shape.emitters.splice(ei, 1);
        onDirty();
        buildShapeProps();
      }, 'subtle');
      delBtn.el.className += ' editor-btn-danger';
      emGroup.body.appendChild(delBtn.el);
    });

    const addEmBtn = Button('+ Add Emitter', () => {
      shape.emitters.push({
        kind: 'dots', count: 3, cx: 0, cy: 0,
        spreadX: 0.5, spreadY: 0.5, sizeMin: 0.5, sizeRange: 1,
        alphaMin: 0.3, alphaRange: 0.5, colors: ['#ff0', '#fff'],
        shadowColor: '#ff0', shadowBlur: 4,
      });
      onDirty();
      buildShapeProps();
    }, 'subtle');
    parent.appendChild(addEmBtn.el);
  }
}

function buildRepeatEditor(parent, shape, vars, onDirty) {
  const set = (k, v) => { shape[k] = v; onDirty(); };
  const explain = document.createElement('div');
  explain.style.cssText = 'color:#7a6a4a;font-size:9px;padding:2px 4px;';
  explain.textContent = `Draws the children once per "${shape.var || 'i'}" value, stepping from\u2192to.`;
  parent.appendChild(explain);
  parent.appendChild(TextInput('Variable', shape.var || 'i', v => set('var', v)).el);
  parent.appendChild(CoordEditor('From', shape.from, vars, v => set('from', v)).el);
  parent.appendChild(CoordEditor('To', shape.to, vars, v => set('to', v)).el);
  parent.appendChild(NumberSlider('Step', 0.01, 2, 0.01, shape.step || 0.25, v => set('step', v)).el);

  const fromN = typeof shape.from === 'number' ? shape.from : (shape.from?.r ?? 0);
  const toN = typeof shape.to === 'number' ? shape.to : (shape.to?.r ?? 0);
  const stepN = shape.step || 0.25;
  const copies = stepN > 0 ? Math.floor((toN - fromN) / stepN) + 1 : 0;
  const info = document.createElement('div');
  info.style.cssText = 'color:#5a4a30;font-size:10px;padding:4px;';
  info.textContent = `\u2248 ${copies > 0 ? copies : 0} copies \u00d7 ${(shape.shapes || []).length} child shape(s)`;
  parent.appendChild(info);
}

function buildForEachEditor(parent, shape, onDirty) {
  const explain = document.createElement('div');
  explain.style.cssText = 'color:#7a6a4a;font-size:9px;padding:2px 4px;';
  explain.textContent = 'Draws the children once per item. One var name, or comma-separated for tuples.';
  parent.appendChild(explain);
  parent.appendChild(TextInput('Variable(s)', Array.isArray(shape.var) ? shape.var.join(', ') : shape.var || 'p', v => {
    shape.var = v.includes(',') ? v.split(',').map(s => s.trim()) : v;
    onDirty();
  }).el);

  const itemsInput = TextInput('Items (JSON)', JSON.stringify(shape.items || []), () => {});
  const err = document.createElement('div');
  err.style.cssText = 'color:#e08a6a;font-size:9px;min-height:11px;padding:0 4px;';
  itemsInput.el.querySelector('input')?.addEventListener('input', (e) => {
    try {
      const parsed = JSON.parse(e.target.value);
      if (!Array.isArray(parsed)) { err.textContent = 'Must be a JSON array.'; return; }
      shape.items = parsed; err.textContent = `${parsed.length} item(s)`; onDirty();
    } catch { err.textContent = 'Invalid JSON.'; }
  });
  parent.appendChild(itemsInput.el);
  parent.appendChild(err);

  const info = document.createElement('div');
  info.style.cssText = 'color:#5a4a30;font-size:10px;padding:4px;';
  info.textContent = `\u2248 ${(shape.items || []).length} copies \u00d7 ${(shape.shapes || []).length} child shape(s)`;
  parent.appendChild(info);
}

// ─── Setup Editor ────────────────────────────────────────────────────────────

function buildSetupEditor(parent, shape, availableVars, onDirty) {
  if (!shape.setup && !shape.fillColor) {
    const addBtn = Button('+ Add Setup', () => {
      shape.setup = {};
      onDirty();
      buildShapeProps();
    }, 'subtle');
    parent.appendChild(addBtn.el);
    return;
  }

  const group = PropertyGroup('Setup');
  parent.appendChild(group.el);

  if (shape.setup) {
    const s = shape.setup;
    const ss = (k, v) => { s[k] = v; onDirty(); };

    // Numeric setup properties — support both plain numbers and anim-var objects
    const numericKeys = [
      { key: 'lineWidth', label: 'Line Width', min: 0.1, max: 5, step: 0.1 },
      { key: 'alpha', label: 'Alpha', min: 0, max: 1, step: 0.05 },
      { key: 'shadow', label: 'Shadow', min: 0, max: 30, step: 1 },
      { key: 'shadowBlur', label: 'Shadow Blur', min: 0, max: 30, step: 1 },
    ];
    for (const { key, label, min, max, step } of numericKeys) {
      if (s[key] === undefined) continue;
      if (typeof s[key] === 'object' && s[key] !== null) {
        // Anim-var object: { base: 0.5, pulse: 0.3 }
        group.body.appendChild(buildAnimVarEditor(label, s, key, availableVars, min, max, step, onDirty));
      } else {
        group.addChild(NumberSlider(label, min, max, step, s[key], v => ss(key, v)));
      }
    }

    // Color and enum setup properties
    if (s.fillColor !== undefined) group.addChild(ColorInput('Fill Color', s.fillColor, v => ss('fillColor', v)));
    if (s.strokeColor !== undefined) group.addChild(ColorInput('Stroke Color', s.strokeColor, v => ss('strokeColor', v)));
    if (s.shadowColor !== undefined) group.addChild(ColorInput('Shadow Color', s.shadowColor, v => ss('shadowColor', v)));
    if (s.lineCap !== undefined) group.addChild(Select('Line Cap', ['butt', 'round', 'square'], s.lineCap, v => ss('lineCap', v)));
    if (s.lineJoin !== undefined) group.addChild(Select('Line Join', ['miter', 'round', 'bevel'], s.lineJoin, v => ss('lineJoin', v)));

    const allSetupKeys = ['lineWidth', 'alpha', 'shadow', 'shadowBlur', 'fillColor', 'strokeColor', 'shadowColor', 'lineCap', 'lineJoin'];
    const missing = allSetupKeys.filter(k => s[k] === undefined);
    if (missing.length > 0) {
      const addRow = document.createElement('div');
      addRow.style.cssText = 'margin-top:4px;';
      const addSel = document.createElement('select');
      addSel.className = 'editor-select-input';
      addSel.style.cssText = 'width:auto;font-size:10px;padding:1px 4px;';
      const ph = document.createElement('option');
      ph.textContent = '+ Add property...';
      ph.value = '';
      addSel.appendChild(ph);
      missing.forEach(k => {
        const o = document.createElement('option');
        o.value = k; o.textContent = k;
        addSel.appendChild(o);
      });
      addSel.addEventListener('change', () => {
        if (!addSel.value) return;
        const k = addSel.value;
        const defaults = { lineWidth: 1, alpha: 1, shadow: 0, shadowBlur: 0, fillColor: '#ffffff', strokeColor: '#ffffff', shadowColor: '#ffffff', lineCap: 'butt', lineJoin: 'miter' };
        s[k] = defaults[k];
        onDirty();
        buildShapeProps();
      });
      addRow.appendChild(addSel);
      group.body.appendChild(addRow);
    }
  }
}

/**
 * Build an editor for an anim-var object like { base: 0.5, pulse: 0.3 }.
 * Shows each component with a slider and the ability to add/remove variable references.
 */
function buildAnimVarEditor(label, setupObj, key, availableVars, min, max, step, onDirty) {
  const container = document.createElement('div');
  container.className = 'editor-widget coord-editor';

  const lbl = document.createElement('div');
  lbl.className = 'coord-editor-label';
  lbl.textContent = label;
  container.appendChild(lbl);

  const body = document.createElement('div');
  container.appendChild(body);

  function rebuild() {
    body.innerHTML = '';
    const obj = setupObj[key];

    for (const [comp, val] of Object.entries(obj)) {
      const row = document.createElement('div');
      row.className = 'coord-component';

      const keyEl = document.createElement('span');
      keyEl.className = 'comp-key';
      keyEl.textContent = comp;
      row.appendChild(keyEl);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = comp === 'base' ? min : -5;
      slider.max = comp === 'base' ? max : 5;
      slider.step = step;
      slider.value = val;
      slider.className = 'editor-slider';

      const numInput = document.createElement('input');
      numInput.type = 'number';
      numInput.step = step;
      numInput.value = val;
      numInput.className = 'editor-num-input';
      numInput.style.width = '60px';

      const syncComp = comp;
      const syncFn = (v) => { obj[syncComp] = parseFloat(v) || 0; onDirty(); };
      slider.addEventListener('input', () => { numInput.value = slider.value; syncFn(slider.value); });
      numInput.addEventListener('change', () => { slider.value = numInput.value; syncFn(numInput.value); });

      row.appendChild(slider);
      row.appendChild(numInput);

      // Delete component (but not 'base')
      if (comp !== 'base') {
        const delBtn = document.createElement('button');
        delBtn.className = 'comp-del';
        delBtn.textContent = '\u00d7';
        delBtn.addEventListener('click', () => {
          delete obj[syncComp];
          if (Object.keys(obj).length <= 1 && obj.base !== undefined) {
            setupObj[key] = obj.base;
          }
          onDirty();
          buildShapeProps();
        });
        row.appendChild(delBtn);
      }

      body.appendChild(row);
    }

    // Add variable reference
    const existing = new Set(Object.keys(obj));
    const addable = ['base', ...availableVars].filter(k => !existing.has(k));
    if (addable.length > 0) {
      const addRow = document.createElement('div');
      addRow.style.cssText = 'margin-top:2px;';
      const addSel = document.createElement('select');
      addSel.className = 'editor-select-input';
      addSel.style.cssText = 'width:auto;font-size:10px;padding:1px 4px;';
      const ph = document.createElement('option');
      ph.textContent = '+ Add var...';
      ph.value = '';
      addSel.appendChild(ph);
      addable.forEach(k => {
        const o = document.createElement('option');
        o.value = k; o.textContent = k;
        addSel.appendChild(o);
      });
      addSel.addEventListener('change', () => {
        if (!addSel.value) return;
        obj[addSel.value] = 0;
        onDirty();
        rebuild();
      });
      addRow.appendChild(addSel);
      body.appendChild(addRow);
    }
  }

  rebuild();
  return container;
}

