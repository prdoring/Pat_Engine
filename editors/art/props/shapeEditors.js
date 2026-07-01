// Per-type shape editors for the art editor's property panel. Each function builds
// the type-specific controls for one shape kind (circle / path / rect / arc / …),
// the container pseudo-shapes (group / radialRepeat / repeat / forEach / conditional),
// the VFX effect reference, and the particles emitters. Split out of props.js — the
// dispatcher (buildShapeProps) lives there and calls these by shape type. Panel
// rebuilds route through ctx.rebuildProps() (== buildShapeProps) to avoid a
// back-import into the props orchestrator.

import { ctx, getShapeAtPath, editValueAt, commitShapeEdit } from '../ctx.js';
import { VFX_DEFS } from '/engine/data/vfx.js';
import { rotateShapeAroundCenter } from '../preview/preview.js';
import {
  NumberSlider, ColorInput, Select, TextInput, Toggle, Button, PropertyGroup, CoordEditor,
} from '/editors/shared/index.js';
import { getTrack, setKeyframe, deleteTrack, ensureClip } from '../model/keyframes.js';
import { buildAnimVarEditor } from './setupEditor.js';

/** A subtle "enable this optional field" button. */
function addFieldButton(label, onClick) {
  const b = Button(label, onClick, 'subtle');
  b.el.style.cssText += 'font-size:10px;padding:1px 6px;margin:2px 0;color:var(--ed-green);';
  return b.el;
}
const radiusModeToggle = addFieldButton;

// ─── Per-Type Shape Editors ──────────────────────────────────────────────────

export function buildGroupEditor(parent, shape, vars, onDirty) {
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
  info.style.cssText = 'color:var(--ed-faint);font-size:10px;padding:4px;';
  info.textContent = `${(shape.shapes || []).length} child shape(s) — select in tree to edit`;
  parent.appendChild(info);
}

export function buildRadialRepeatEditor(parent, shape, vars, onDirty) {
  const set = (k, v) => { shape[k] = v; onDirty(); };
  parent.appendChild(CoordEditor('cx', shape.cx || 0, vars, v => set('cx', v)).el);
  parent.appendChild(CoordEditor('cy', shape.cy || 0, vars, v => set('cy', v)).el);
  parent.appendChild(CoordEditor('radius', shape.radius || 0, vars, v => set('radius', v)).el);
  parent.appendChild(NumberSlider('Count', 1, 24, 1, shape.count || 6, v => set('count', v)).el);

  const info = document.createElement('div');
  info.style.cssText = 'color:var(--ed-faint);font-size:10px;padding:4px;';
  info.textContent = `${(shape.shapes || []).length} child shape(s) — select in tree to edit`;
  parent.appendChild(info);
}

export function buildCircleEditor(parent, shape, vars, onDirty) {
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
      onDirty(); ctx.rebuildProps();
    }));
  } else {
    parent.appendChild(NumberSlider('Radius', 0.01, 1, 0.01, shape.radius || 0.1, v => set('radius', v)).el);
    parent.appendChild(radiusModeToggle('→ use absolute px radius', () => {
      shape.radiusAbs = Math.round((shape.radius || 0.1) * r * 10) / 10;
      delete shape.radius;
      onDirty(); ctx.rebuildProps();
    }));
  }
  if (shape.radiusOffset !== undefined) {
    parent.appendChild(NumberSlider('Radius Offset', -5, 5, 0.5, shape.radiusOffset, v => set('radiusOffset', v)).el);
  } else {
    parent.appendChild(addFieldButton('+ Radius offset', () => { shape.radiusOffset = 0; onDirty(); ctx.rebuildProps(); }));
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
    lbl.style.cssText = 'color:var(--ed-faint);font-size:10px;width:30px;';
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

export function buildPathEditor(parent, shape, vars, onDirty) {
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
        delBtn.textContent = '×';
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

export function buildBezierPathEditor(parent, shape, vars, onDirty) {
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
        delBtn.textContent = '×';
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

export function buildLinesEditor(parent, shape, vars, onDirty) {
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

        const delBtn = Button('× Del', () => { ensureClone(); shape.segments.splice(i, 1); onDirty(); rebuildSegments(); }, 'subtle');
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

export function buildArcEditor(parent, shape, vars, onDirty) {
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

export function buildRectEditor(parent, shape, vars, onDirty) {
  const set = (k, v) => { shape[k] = v; onDirty(); };
  parent.appendChild(CoordEditor('x', shape.x, vars, v => set('x', v)).el);
  parent.appendChild(CoordEditor('y', shape.y, vars, v => set('y', v)).el);
  parent.appendChild(CoordEditor('w', shape.w, vars, v => set('w', v)).el);
  parent.appendChild(CoordEditor('h', shape.h, vars, v => set('h', v)).el);
  parent.appendChild(NumberSlider('Rotation', -Math.PI, Math.PI, 0.05, shape.rotation || 0, v => set('rotation', v)).el);
  parent.appendChild(Toggle('Stroke', shape.stroke || false, v => set('stroke', v)).el);
  parent.appendChild(Toggle('Fill', shape.fill || false, v => set('fill', v)).el);
}

export function buildRoundedRectEditor(parent, shape, vars, onDirty) {
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

export function buildBoltClusterEditor(parent, shape, vars, onDirty) {
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

export function buildEffectRefEditor(parent, shape, vars, onDirty) {
  const set = (k, v) => { shape[k] = v; onDirty(); };
  const ids = Object.keys(VFX_DEFS || {});
  const opts = ids.map(id => ({ value: id, label: id + (VFX_DEFS[id]?.lifecycle === 'persistent' ? '' : ' (one-shot)') }));
  if (!shape.effect || !ids.includes(shape.effect)) opts.unshift({ value: shape.effect || '', label: shape.effect || '(pick an effect)' });
  parent.appendChild(Select('VFX Effect', opts, shape.effect || '', v => { set('effect', v); ctx.rebuildProps(); }).el);
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
  info.style.cssText = 'color:var(--ed-blue);font-size:9px;padding:2px 4px;line-height:1.5;';
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

export function buildConditionalEditor(parent, shape, _stateNames, _onDirty) {
  const info = document.createElement('div');
  info.style.cssText = 'color:var(--ed-faint);font-size:10px;padding:4px;';
  info.textContent = `${(shape.shapes || []).length} child shape(s) — select in tree to edit`;
  parent.appendChild(info);
}

export function buildParticlesEditor(parent, shape, vars, stateNames, onDirty) {
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
        ctx.rebuildProps();
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
      ctx.rebuildProps();
    }, 'subtle');
    parent.appendChild(addEmBtn.el);
  }
}

export function buildRepeatEditor(parent, shape, vars, onDirty) {
  const set = (k, v) => { shape[k] = v; onDirty(); };
  const explain = document.createElement('div');
  explain.style.cssText = 'color:var(--ed-muted);font-size:9px;padding:2px 4px;';
  explain.textContent = `Draws the children once per "${shape.var || 'i'}" value, stepping from→to.`;
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
  info.style.cssText = 'color:var(--ed-faint);font-size:10px;padding:4px;';
  info.textContent = `≈ ${copies > 0 ? copies : 0} copies × ${(shape.shapes || []).length} child shape(s)`;
  parent.appendChild(info);
}

export function buildForEachEditor(parent, shape, onDirty) {
  const explain = document.createElement('div');
  explain.style.cssText = 'color:var(--ed-muted);font-size:9px;padding:2px 4px;';
  explain.textContent = 'Draws the children once per item. One var name, or comma-separated for tuples.';
  parent.appendChild(explain);
  parent.appendChild(TextInput('Variable(s)', Array.isArray(shape.var) ? shape.var.join(', ') : shape.var || 'p', v => {
    shape.var = v.includes(',') ? v.split(',').map(s => s.trim()) : v;
    onDirty();
  }).el);

  const itemsInput = TextInput('Items (JSON)', JSON.stringify(shape.items || []), () => {});
  const err = document.createElement('div');
  err.style.cssText = 'color:var(--ed-error);font-size:9px;min-height:11px;padding:0 4px;';
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
  info.style.cssText = 'color:var(--ed-faint);font-size:10px;padding:4px;';
  info.textContent = `≈ ${(shape.items || []).length} copies × ${(shape.shapes || []).length} child shape(s)`;
  parent.appendChild(info);
}
