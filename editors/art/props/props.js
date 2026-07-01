// Shape property panel for the art editor: the dispatcher that builds the right-side
// panel when a shape (or the asset) is selected, plus the state-overrides section.
// Per-type shape editors live in ./shapeEditors.js, the keyframe controls in
// ./keyframePanel.js, and the setup / anim-var editors in ./setupEditor.js.

import { ctx, getShapeAtPath, SHAPE_ICONS, createStateProxy, createAnimProxy } from '../ctx.js';
import { collectAvailableVars } from '../tree/tree.js';
import {
  NumberSlider, TextInput, PropertyGroup, TagListEditor, Button, setCoordReadout,
} from '/editors/shared/index.js';
import {
  buildGroupEditor, buildRadialRepeatEditor, buildCircleEditor, buildPathEditor,
  buildBezierPathEditor, buildLinesEditor, buildArcEditor, buildRectEditor,
  buildRoundedRectEditor, buildBoltClusterEditor, buildConditionalEditor,
  buildParticlesEditor, buildRepeatEditor, buildForEachEditor, buildEffectRefEditor,
} from './shapeEditors.js';
import { buildKeyframePanel } from './keyframePanel.js';
import { buildSetupEditor } from './setupEditor.js';

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
  nameSpan.style.cssText = 'font-weight:bold;color:var(--ed-accent);flex:1;';
  nameSpan.textContent = rawShape.name || rawShape.type;
  header.appendChild(nameSpan);
  const typeSpan = document.createElement('span');
  typeSpan.style.cssText = 'color:var(--ed-faint);font-size:11px;';
  typeSpan.textContent = rawShape.type;
  header.appendChild(typeSpan);
  if (ctx.currentEditState !== 'BASE') {
    const badge = document.createElement('span');
    badge.style.cssText = 'color:var(--ed-info);font-size:10px;padding:1px 6px;border:1px solid rgba(var(--ed-info-rgb),0.27);border-radius:3px;margin-left:4px;';
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
  title.style.cssText = 'font-weight:bold;color:var(--ed-accent);flex:1;';
  title.textContent = `Asset: ${art.name || ctx.currentLabel || ''}`;
  header.appendChild(title);
  ctx.propsEl.appendChild(header);

  const hint = document.createElement('div');
  hint.style.cssText = 'color:var(--ed-faint);font-size:10px;padding:2px 4px 6px;';
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
  note.style.cssText = 'color:var(--ed-faint);font-size:9px;padding:2px 4px;';
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
        lbl.style.cssText = 'color:var(--ed-muted);font-size:10px;padding:2px 4px;';
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
  divider.style.cssText = 'border-top:2px solid rgba(var(--ed-info-rgb),0.27);margin:8px 0 4px;padding-top:4px;';
  const label = document.createElement('div');
  label.style.cssText = 'color:var(--ed-info);font-size:11px;font-weight:bold;margin-bottom:4px;';
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
  keyEl.style.cssText = 'color:var(--ed-info);font-size:10px;min-width:80px;';
  keyEl.textContent = key;
  row.appendChild(keyEl);

  const valEl = document.createElement('span');
  valEl.style.cssText = 'color:var(--ed-muted);font-size:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  valEl.textContent = JSON.stringify(val).slice(0, 40);
  row.appendChild(valEl);

  if (baseVal !== undefined) {
    const baseHint = document.createElement('span');
    baseHint.style.cssText = 'color:var(--ed-faint);font-size:9px;';
    baseHint.textContent = `base: ${JSON.stringify(baseVal).slice(0, 20)}`;
    row.appendChild(baseHint);
  }

  const resetBtn = Button('Reset', onReset, 'subtle');
  resetBtn.el.style.cssText += 'padding:1px 6px;font-size:9px;';
  resetBtn.el.className += ' editor-btn-danger';
  row.appendChild(resetBtn.el);

  parent.appendChild(row);
}
