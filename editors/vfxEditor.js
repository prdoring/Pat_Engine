// VFX Editor — visual editor for VFX definitions in vfx.json
// Uses VFXInterpreter.drawPhasedEffect() for WYSIWYG preview (single rendering path).

import { VFX_DEFS } from '/engine/data/vfx.js';
import { EffectsRenderer } from '/engine/render/EffectsRenderer.js';
import { drawPhasedEffect, drawTrailEffect, drawBeamEffect } from '/engine/render/VFXInterpreter.js';
import {
  SaveManager, EditorPreviewCamera,
  NumberSlider, ColorInput, PropertyGroup, Select, TextInput, Toggle,
  createResizer,
} from './editorShared.js';
import { loadManifest, getManifest } from './editorManifest.js';

// ─── VFX Type → category mapping (manifest-driven) ──────────────────────────
// The manifest's `vfxCategories` list each define { id, label, match: [...] }.
// An effect matches a category if its key contains one of the match substrings.
// Falls back to grouping by effect `type` when no manifest category matches.

function getCategory(key, def) {
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

function categoryOrder() {
  // Manifest category labels first, then fallback buckets — deduped so a label
  // shared between the two (e.g. "Trails") isn't rendered twice.
  const manifestLabels = (getManifest()?.vfxCategories || []).map(c => c.label || c.id);
  return [...new Set([...manifestLabels, 'Persistent', 'Trails', 'Beams', 'Effects'])];
}

// ─── Primitives available for layers ─────────────────────────────────────────

const PRIMITIVE_TYPES = ['filledCircle', 'gradientCircle', 'strokeRing', 'dashedRing', 'spikeLines'];

// Properties each primitive type expects (for building UI)
const PRIMITIVE_PROPS = {
  filledCircle: ['radius', 'color', 'alpha', 'shadow'],
  gradientCircle: ['radius', 'gradient', 'color', 'alpha', 'shadow'],
  strokeRing: ['radius', 'color', 'lineWidth', 'alpha', 'shadow'],
  dashedRing: ['radius', 'color', 'lineWidth', 'dashPattern', 'alpha', 'shadow'],
  spikeLines: ['count', 'innerRadius', 'outerRadius', 'color', 'lineWidth', 'alpha', 'shadow'],
};

// ─── Default definitions for new effects ────────────────────────────────────

const NEW_EFFECT_DEFAULTS = {
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

// ─── Effect simulation state ────────────────────────────────────────────────

class EffectSimulator {
  constructor() { this.reset(); }

  reset() {
    this.debris = [];
    this._lastUpdate = null;
    this._startTime = null;
    this._def = null;
    this._opts = {};
    this._progress = 0;
    // Trail simulation
    this.trailPoints = {};
    this._motionAngle = 0;
    this._motionPos = { x: 0, y: 0 };
  }

  play(def, opts = {}) {
    this.reset();
    const now = performance.now();
    this._startTime = now;
    this._def = def;
    this._opts = opts;
    this._progress = 0;

    // Spawn debris for phased effects
    if (def.type === 'phased' && def.debris) {
      for (const d of def.debris) {
        this._spawnDebrisBurst(now, 0, 0, d.count, d.speed, d.lifetime, d.size, d.color);
      }
    }

    // Trail motion init
    if (def.type === 'bubbleTrail' || def.type === 'taperedTrail') {
      this.trailPoints = { trail0: [] };
      this._motionPos = { x: -150, y: 0 };
      this._motionAngle = 0;
    }
  }

  update(now, speedMult = 1) {
    if (!this._def) return;
    const dt = this._lastUpdate ? (now - this._lastUpdate) * speedMult : 0;
    this._lastUpdate = now;

    const def = this._def;

    // Update progress for one-shot phased effects
    if (def.type === 'phased' && def.lifecycle !== 'persistent' && def.duration) {
      this._progress = Math.min(1, (now - this._startTime) / def.duration);
    }

    // Update debris physics
    const dtSec = dt / 1000;
    this.debris = this.debris.filter(d => {
      const age = now - d.startTime;
      if (age >= d.lifetime) return false;
      d.x += d.vx * dtSec;
      d.y += d.vy * dtSec;
      d.vx *= 0.96;
      d.vy *= 0.96;
      d.alpha = 1 - age / d.lifetime;
      return true;
    });

    // Trail motion simulation
    if (def.type === 'bubbleTrail' || def.type === 'taperedTrail') {
      const speed = 200 * speedMult;
      this._motionPos.x += Math.cos(this._motionAngle) * speed * dtSec;
      this._motionPos.y += Math.sin(this._motionAngle) * speed * dtSec;

      if (Math.abs(this._motionPos.x) > 180) {
        this._motionAngle = Math.PI - this._motionAngle;
        this._motionPos.x = Math.max(-180, Math.min(180, this._motionPos.x));
      }
      if (Math.abs(this._motionPos.y) > 120) {
        this._motionAngle = -this._motionAngle;
        this._motionPos.y = Math.max(-120, Math.min(120, this._motionPos.y));
      }

      const trail = this.trailPoints.trail0;
      trail.push({ x: this._motionPos.x, y: this._motionPos.y, timestamp: now, speed });

      const lifetime = def.pointLifetime || 600;
      const maxLen = def.maxLength || 30;
      while (trail.length > 0 && now - trail[0].timestamp > lifetime) trail.shift();
      while (trail.length > maxLen) trail.shift();
    }

    // Auto-replay one-shot phased effects
    if (def.type === 'phased' && def.lifecycle !== 'persistent' && this._progress >= 1 && this.debris.length === 0) {
      this.play(def, this._opts);
    }
  }

  getProgress() { return this._progress; }
  getDef() { return this._def; }

  _spawnDebrisBurst(now, x, y, count, speed, lifetime, size, color) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.6);
      this.debris.push({
        x, y, vx: Math.cos(angle) * v, vy: Math.sin(angle) * v,
        startTime: now, lifetime, size: size * (0.5 + Math.random() * 0.5),
        color, alpha: 1,
      });
    }
  }
}

// ─── Module state ───────────────────────────────────────────────────────────

let container = null;
let saveManager = null;
let workingData = null;
let selectedId = null;
let selectedPhaseIdx = 0;
let simulator = null;
let previewCanvas = null;
let previewCamera = null;
let effectsRenderer = null;
let animFrame = null;
let playing = true;
let speedMult = 1;

// DOM refs
let sidebarEl = null;
let propsEl = null;
let previewWrapEl = null;
let controlsEl = null;

// ─── Public interface ───────────────────────────────────────────────────────

export async function mount(el) {
  container = el;
  container.innerHTML = '';
  container.style.height = '100%';

  await loadManifest(); // categories come from the manifest
  workingData = JSON.parse(JSON.stringify(VFX_DEFS));
  saveManager = new SaveManager('vfx.json');
  saveManager.onDirtyChange(dirty => {
    if (window.editorSetUnsaved) window.editorSetUnsaved('vfx', dirty);
  });
  simulator = new EffectSimulator();

  buildLayout();
  buildSidebar();
  startPreviewLoop();
}

export function unmount() {
  if (animFrame) cancelAnimationFrame(animFrame);
  animFrame = null;
  container = null;
  effectsRenderer = null;
  previewCanvas = null;
  previewCamera = null;
  simulator = null;
}

export async function save() {
  if (!saveManager || !workingData) return;
  await saveManager.save({ effects: workingData });
}

export function isDirty() {
  return saveManager ? saveManager.isDirty() : false;
}

// ─── Layout ─────────────────────────────────────────────────────────────────

function buildLayout() {
  sidebarEl = document.createElement('div');
  sidebarEl.className = 'vfx-sidebar';
  sidebarEl.style.cssText = 'width:220px;min-width:180px;overflow-y:auto;display:flex;flex-direction:column;';

  const mainEl = document.createElement('div');
  mainEl.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden;';

  // Top section: preview + controls (resizable as a unit)
  const topSection = document.createElement('div');
  topSection.style.cssText = 'flex:0 0 360px;display:flex;flex-direction:column;overflow:hidden;';

  previewWrapEl = document.createElement('div');
  previewWrapEl.style.cssText = 'position:relative;flex:1;overflow:hidden;background:#060d18;';

  controlsEl = document.createElement('div');
  controlsEl.style.cssText = 'display:flex;gap:6px;align-items:center;padding:6px 10px;flex-wrap:wrap;flex-shrink:0;';
  buildControls();

  topSection.appendChild(previewWrapEl);
  topSection.appendChild(controlsEl);

  propsEl = document.createElement('div');
  propsEl.style.cssText = 'flex:1;overflow-y:auto;padding:10px;';

  mainEl.appendChild(topSection);
  mainEl.appendChild(createResizer('vertical', topSection, { min: 120, max: 600, prop: 'flexBasis' }).el);
  mainEl.appendChild(propsEl);

  container.appendChild(sidebarEl);
  container.appendChild(createResizer('horizontal', sidebarEl, { min: 120, max: 400 }).el);
  container.appendChild(mainEl);

  const cvs = document.createElement('canvas');
  cvs.style.cssText = 'width:100%;height:100%;display:block;';
  previewWrapEl.appendChild(cvs);

  const resizeCanvas = () => {
    const rect = previewWrapEl.getBoundingClientRect();
    cvs.width = rect.width;
    cvs.height = rect.height;
  };
  resizeCanvas();
  const ro = new ResizeObserver(resizeCanvas);
  ro.observe(previewWrapEl);

  previewCamera = new EditorPreviewCamera(cvs);
  effectsRenderer = new EffectsRenderer(cvs.getContext('2d'), previewCamera, cvs);
  previewCanvas = cvs;
}

// ─── Sidebar ────────────────────────────────────────────────────────────────

function buildSidebar() {
  sidebarEl.innerHTML = '';

  const header = document.createElement('div');
  header.style.cssText = 'padding:8px;border-bottom:1px solid #3a2a10;';

  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search...';
  search.className = 'editor-text-field';
  search.style.cssText = 'width:100%;margin-bottom:6px;';
  search.addEventListener('input', () => rebuildList(search.value.toLowerCase()));
  header.appendChild(search);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:4px;';
  const newBtn = mkBtn('+ New', createNewEffect, 'editor-btn editor-btn-primary');
  const dupBtn = mkBtn('Dup', duplicateSelected, 'editor-btn editor-btn-subtle');
  const delBtn = mkBtn('Delete', deleteSelected, 'editor-btn editor-btn-danger');
  for (const b of [newBtn, dupBtn, delBtn]) b.style.cssText += 'flex:1;font-size:11px;';
  dupBtn.style.cssText += 'flex:0;';
  btnRow.append(newBtn, dupBtn, delBtn);
  header.appendChild(btnRow);

  const saveRow = document.createElement('div');
  saveRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:6px;';
  saveRow.appendChild(saveManager.getStatusIndicator());
  saveRow.appendChild(saveManager.getSaveButton(() => save()));
  header.appendChild(saveRow);

  sidebarEl.appendChild(header);

  const listEl = document.createElement('div');
  listEl.style.cssText = 'flex:1;overflow-y:auto;';
  listEl.id = 'vfx-list';
  sidebarEl.appendChild(listEl);

  rebuildList('');
}

function rebuildList(filter) {
  const listEl = sidebarEl.querySelector('#vfx-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const groups = {};
  for (const cat of categoryOrder()) groups[cat] = [];

  for (const [key, def] of Object.entries(workingData)) {
    if (filter && !key.toLowerCase().includes(filter)) continue;
    const cat = getCategory(key, def);
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(key);
  }

  for (const cat of [...categoryOrder(), 'Other']) {
    const items = groups[cat];
    if (!items || items.length === 0) continue;

    const catEl = document.createElement('div');
    catEl.style.cssText = 'margin-top:4px;';

    const catHeader = document.createElement('div');
    catHeader.style.cssText = 'padding:4px 8px;color:#7a6a4a;font-size:10px;text-transform:uppercase;letter-spacing:1px;cursor:pointer;';
    catHeader.textContent = `${cat} (${items.length})`;
    let collapsed = false;
    const itemsContainer = document.createElement('div');

    catHeader.addEventListener('click', () => {
      collapsed = !collapsed;
      itemsContainer.style.display = collapsed ? 'none' : '';
    });

    for (const key of items) {
      const item = document.createElement('div');
      item.style.cssText = 'padding:4px 12px;cursor:pointer;font-size:12px;color:#b8a878;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      item.textContent = key;
      if (key === selectedId) {
        item.style.background = '#2a2210';
        item.style.color = '#d4a056';
      }
      item.addEventListener('click', () => selectEffect(key));
      itemsContainer.appendChild(item);
    }

    catEl.appendChild(catHeader);
    catEl.appendChild(itemsContainer);
    listEl.appendChild(catEl);
  }
}

// ─── Controls bar ───────────────────────────────────────────────────────────

function buildControls() {
  controlsEl.innerHTML = '';

  const playBtn = mkBtn('Replay', () => { playing = true; if (selectedId) simulator.play(workingData[selectedId], getPlayOpts()); });
  const pauseBtn = mkBtn(playing ? 'Pause' : 'Resume', () => {
    playing = !playing;
    pauseBtn.textContent = playing ? 'Pause' : 'Resume';
  });

  const speedSel = document.createElement('select');
  speedSel.className = 'editor-select-input';
  speedSel.style.cssText = 'width:60px;font-size:11px;';
  for (const s of [0.25, 0.5, 1, 2]) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = s + 'x';
    if (s === speedMult) o.selected = true;
    speedSel.appendChild(o);
  }
  speedSel.addEventListener('change', () => { speedMult = parseFloat(speedSel.value); });

  const speedLabel = document.createElement('span');
  speedLabel.style.cssText = 'color:#7a6a4a;font-size:11px;';
  speedLabel.textContent = 'Speed:';

  const scaleLabel = document.createElement('span');
  scaleLabel.style.cssText = 'color:#7a6a4a;font-size:11px;margin-left:8px;';
  scaleLabel.textContent = 'Scale:';

  const scaleInput = document.createElement('input');
  scaleInput.type = 'number';
  scaleInput.value = '120';
  scaleInput.min = '1';
  scaleInput.max = '500';
  scaleInput.className = 'editor-num-input';
  scaleInput.style.cssText = 'width:55px;font-size:11px;';
  scaleInput.id = 'vfx-scale';

  controlsEl.append(playBtn, pauseBtn, speedLabel, speedSel, scaleLabel, scaleInput);
}

function mkBtn(text, onClick, className) {
  const btn = document.createElement('button');
  btn.className = className || 'editor-btn editor-btn-subtle';
  btn.textContent = text;
  btn.style.fontSize = '11px';
  btn.addEventListener('click', onClick);
  return btn;
}

function getPlayOpts() {
  const el = document.getElementById('vfx-scale');
  return { scale: el ? parseFloat(el.value) || 120 : 120 };
}

// ─── Selection ──────────────────────────────────────────────────────────────

function selectEffect(id) {
  selectedId = id;
  selectedPhaseIdx = 0;
  rebuildList('');
  buildPropsPanel();
  const def = workingData[id];
  if (def) {
    simulator.play(def, getPlayOpts());
    playing = true;
    // Update scale input to match effect's defaultScale
    const scaleInput = document.getElementById('vfx-scale');
    if (scaleInput && def.defaultScale) scaleInput.value = def.defaultScale;
  }
}

// ─── Properties panel ───────────────────────────────────────────────────────

function buildPropsPanel() {
  propsEl.innerHTML = '';
  if (!selectedId || !workingData[selectedId]) {
    propsEl.innerHTML = '<div style="color:#7a6a4a;padding:20px;text-align:center;">Select an effect to edit</div>';
    return;
  }

  const def = workingData[selectedId];

  // Name
  const nameEl = document.createElement('div');
  nameEl.style.cssText = 'color:#d4a056;font-size:14px;margin-bottom:8px;font-weight:bold;';
  nameEl.textContent = selectedId;
  propsEl.appendChild(nameEl);

  // Type badge
  const typeEl = document.createElement('div');
  typeEl.style.cssText = 'color:#7a6a4a;font-size:11px;margin-bottom:12px;';
  const lifecycle = def.lifecycle === 'persistent' ? ' (persistent)' : '';
  typeEl.textContent = `Type: ${def.type}${lifecycle}`;
  propsEl.appendChild(typeEl);

  if (def.type === 'phased') {
    buildPhasedEffectProps(def);
  } else {
    buildLegacyProps(def);
  }
}

function markDirtyAndReplay() {
  saveManager.markDirty();
  if (selectedId) simulator.play(workingData[selectedId], getPlayOpts());
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASED EFFECT EDITOR
// ═══════════════════════════════════════════════════════════════════════════

function buildPhasedEffectProps(def) {
  // ─── Effect-level settings ──────────────────────────────
  const settingsGroup = PropertyGroup('Effect Settings');
  propsEl.appendChild(settingsGroup.el);

  if (def.lifecycle !== 'persistent') {
    const dur = NumberSlider('Duration (ms)', 100, 5000, 50, def.duration || 1200, v => { def.duration = v; markDirtyAndReplay(); });
    settingsGroup.body.appendChild(dur.el);
  }

  const scale = NumberSlider('Default Scale', 1, 500, 1, def.defaultScale || 1, v => { def.defaultScale = v; markDirtyAndReplay(); });
  settingsGroup.body.appendChild(scale.el);

  const persistToggle = Toggle('Persistent', def.lifecycle === 'persistent', v => {
    if (v) { def.lifecycle = 'persistent'; delete def.duration; }
    else { delete def.lifecycle; def.duration = 1200; }
    markDirtyAndReplay();
    buildPropsPanel();
  });
  settingsGroup.body.appendChild(persistToggle.el);

  // ─── Debris editor ──────────────────────────────────────
  if (def.lifecycle !== 'persistent') {
    const debrisGroup = PropertyGroup('Debris Bursts');
    propsEl.appendChild(debrisGroup.el);
    buildDebrisBursts(def, debrisGroup.body);
  }

  // ─── Phase timeline ─────────────────────────────────────
  buildPhaseTimeline(def);

  // ─── Selected phase properties ──────────────────────────
  if (def.phases && def.phases.length > 0) {
    const pi = Math.min(selectedPhaseIdx, def.phases.length - 1);
    selectedPhaseIdx = pi;
    buildPhaseProps(def, pi);
  }
}

// ─── Debris bursts ────────────────────────────────────────────────────────

function buildDebrisBursts(def, parent) {
  parent.innerHTML = '';
  const bursts = def.debris || [];

  bursts.forEach((d, i) => {
    const group = document.createElement('div');
    group.style.cssText = 'border:1px solid #3a2a10;padding:4px;margin:2px 0;';

    const fields = [
      { key: 'count', label: 'Count', min: 0, max: 30, step: 1 },
      { key: 'speed', label: 'Speed', min: 0, max: 500, step: 10 },
      { key: 'lifetime', label: 'Lifetime', min: 0, max: 3000, step: 50 },
      { key: 'size', label: 'Size', min: 0.5, max: 10, step: 0.5 },
    ];
    for (const f of fields) {
      const w = NumberSlider(f.label, f.min, f.max, f.step, d[f.key] || 0, v => {
        bursts[i][f.key] = v; def.debris = [...bursts]; markDirtyAndReplay();
      });
      group.appendChild(w.el);
    }
    const cw = ColorInput('Color', d.color || '#888888', v => { bursts[i].color = v; def.debris = [...bursts]; markDirtyAndReplay(); });
    group.appendChild(cw.el);

    const rmBtn = document.createElement('button');
    rmBtn.className = 'editor-btn editor-btn-danger'; rmBtn.textContent = 'Remove'; rmBtn.style.fontSize = '10px';
    rmBtn.addEventListener('click', () => { bursts.splice(i, 1); def.debris = bursts.length ? [...bursts] : undefined; markDirtyAndReplay(); buildPropsPanel(); });
    group.appendChild(rmBtn);
    parent.appendChild(group);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'editor-btn editor-btn-subtle'; addBtn.textContent = '+ Add Burst'; addBtn.style.fontSize = '10px';
  addBtn.addEventListener('click', () => {
    if (!def.debris) def.debris = [];
    def.debris.push({ count: 8, speed: 200, lifetime: 900, size: 2, color: '#7a8888' });
    markDirtyAndReplay(); buildPropsPanel();
  });
  parent.appendChild(addBtn);
}

// ─── Phase timeline ──────────────────────────────────────────────────────

function buildPhaseTimeline(def) {
  const timelineGroup = PropertyGroup('Phase Timeline');
  propsEl.appendChild(timelineGroup.el);

  const phases = def.phases || [];

  // Visual timeline bars
  const timelineEl = document.createElement('div');
  timelineEl.style.cssText = 'position:relative;height:' + (phases.length * 28 + 4) + 'px;background:#0a0a14;border:1px solid #3a2a10;border-radius:3px;margin-bottom:8px;';

  phases.forEach((phase, i) => {
    const bar = document.createElement('div');
    const left = (phase.start * 100).toFixed(1) + '%';
    const width = ((phase.end - phase.start) * 100).toFixed(1) + '%';
    const isSelected = i === selectedPhaseIdx;
    const hue = (i * 60) % 360;
    bar.style.cssText = `position:absolute;left:${left};width:${width};top:${i * 28 + 2}px;height:24px;`
      + `background:hsla(${hue},50%,40%,${isSelected ? 0.7 : 0.35});border:1px solid hsla(${hue},60%,50%,${isSelected ? 1 : 0.5});`
      + `border-radius:2px;cursor:pointer;display:flex;align-items:center;padding:0 4px;overflow:hidden;`;
    bar.title = `${phase.name} [${phase.start.toFixed(2)} - ${phase.end.toFixed(2)}]`;

    const label = document.createElement('span');
    label.style.cssText = 'font-size:10px;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;';
    label.textContent = phase.name || `Phase ${i}`;
    bar.appendChild(label);

    bar.addEventListener('click', () => {
      selectedPhaseIdx = i;
      buildPropsPanel();
    });
    timelineEl.appendChild(bar);
  });

  timelineGroup.body.appendChild(timelineEl);

  // Add/remove phase buttons
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:4px;';

  const addPhaseBtn = document.createElement('button');
  addPhaseBtn.className = 'editor-btn editor-btn-subtle';
  addPhaseBtn.textContent = '+ Add Phase';
  addPhaseBtn.style.fontSize = '10px';
  addPhaseBtn.addEventListener('click', () => {
    if (!def.phases) def.phases = [];
    const lastEnd = def.phases.length > 0 ? def.phases[def.phases.length - 1].end : 0;
    def.phases.push({
      name: 'new', start: lastEnd, end: Math.min(1, lastEnd + 0.2),
      layers: [{ primitive: 'filledCircle', radius: 0.3, color: '#ffffff', alpha: 0.5, shadow: { color: '#ffffff', blur: 10 } }],
    });
    selectedPhaseIdx = def.phases.length - 1;
    markDirtyAndReplay(); buildPropsPanel();
  });
  btnRow.appendChild(addPhaseBtn);

  if (phases.length > 0) {
    const removePhaseBtn = document.createElement('button');
    removePhaseBtn.className = 'editor-btn editor-btn-danger';
    removePhaseBtn.textContent = 'Remove Selected';
    removePhaseBtn.style.fontSize = '10px';
    removePhaseBtn.addEventListener('click', () => {
      if (def.phases.length <= 1) return;
      def.phases.splice(selectedPhaseIdx, 1);
      selectedPhaseIdx = Math.min(selectedPhaseIdx, def.phases.length - 1);
      markDirtyAndReplay(); buildPropsPanel();
    });
    btnRow.appendChild(removePhaseBtn);
  }

  timelineGroup.body.appendChild(btnRow);
}

// ─── Phase properties ────────────────────────────────────────────────────

function buildPhaseProps(def, phaseIdx) {
  const phase = def.phases[phaseIdx];

  const phaseGroup = PropertyGroup(`Phase: ${phase.name || 'unnamed'}`);
  propsEl.appendChild(phaseGroup.el);

  // Phase name
  const nameInput = TextInput('Name', phase.name || '', v => { phase.name = v; markDirtyAndReplay(); buildPropsPanel(); });
  phaseGroup.body.appendChild(nameInput.el);

  // Start/End sliders
  const startSlider = NumberSlider('Start', 0, 1, 0.01, phase.start, v => { phase.start = v; markDirtyAndReplay(); buildPropsPanel(); });
  phaseGroup.body.appendChild(startSlider.el);

  const endSlider = NumberSlider('End', 0, 1, 0.01, phase.end, v => { phase.end = v; markDirtyAndReplay(); buildPropsPanel(); });
  phaseGroup.body.appendChild(endSlider.el);

  // Phase reorder buttons
  if (def.phases.length > 1) {
    const reorderRow = document.createElement('div');
    reorderRow.style.cssText = 'display:flex;gap:4px;margin-top:4px;';
    if (phaseIdx > 0) {
      const upBtn = mkBtn('Move Up', () => {
        [def.phases[phaseIdx - 1], def.phases[phaseIdx]] = [def.phases[phaseIdx], def.phases[phaseIdx - 1]];
        selectedPhaseIdx = phaseIdx - 1;
        markDirtyAndReplay(); buildPropsPanel();
      });
      reorderRow.appendChild(upBtn);
    }
    if (phaseIdx < def.phases.length - 1) {
      const downBtn = mkBtn('Move Down', () => {
        [def.phases[phaseIdx], def.phases[phaseIdx + 1]] = [def.phases[phaseIdx + 1], def.phases[phaseIdx]];
        selectedPhaseIdx = phaseIdx + 1;
        markDirtyAndReplay(); buildPropsPanel();
      });
      reorderRow.appendChild(downBtn);
    }
    phaseGroup.body.appendChild(reorderRow);
  }

  // ─── Layers ──────────────────────────────────────────────
  const layersHeader = document.createElement('div');
  layersHeader.style.cssText = 'color:#d4a056;font-size:12px;margin-top:12px;margin-bottom:4px;font-weight:bold;';
  layersHeader.textContent = 'Layers';
  propsEl.appendChild(layersHeader);

  const layers = phase.layers || [];
  layers.forEach((_layer, li) => {
    buildLayerEditor(def, phaseIdx, li);
  });

  // Add layer button
  const addLayerBtn = document.createElement('button');
  addLayerBtn.className = 'editor-btn editor-btn-subtle';
  addLayerBtn.textContent = '+ Add Layer';
  addLayerBtn.style.cssText = 'font-size:11px;margin-top:4px;';
  addLayerBtn.addEventListener('click', () => {
    phase.layers.push({
      primitive: 'filledCircle', radius: 0.3, color: '#ffffff',
      alpha: 0.5, shadow: { color: '#ffffff', blur: 10 },
    });
    markDirtyAndReplay(); buildPropsPanel();
  });
  propsEl.appendChild(addLayerBtn);
}

// ─── Layer editor ────────────────────────────────────────────────────────

function buildLayerEditor(def, phaseIdx, layerIdx) {
  const phase = def.phases[phaseIdx];
  const layer = phase.layers[layerIdx];

  const layerGroup = PropertyGroup(`[${layerIdx + 1}] ${layer.primitive}`);
  propsEl.appendChild(layerGroup.el);

  const setLayer = (field, val) => {
    layer[field] = val;
    markDirtyAndReplay();
  };

  // Primitive type selector
  const primSelect = Select('Primitive', PRIMITIVE_TYPES, layer.primitive, v => {
    layer.primitive = v;
    markDirtyAndReplay(); buildPropsPanel();
  });
  layerGroup.body.appendChild(primSelect.el);

  // Build property widgets based on primitive type
  const props = PRIMITIVE_PROPS[layer.primitive] || [];

  for (const prop of props) {
    switch (prop) {
      case 'radius':
        buildAnimatableWidget(layerGroup.body, 'Radius', layer, 'radius', 0, 2, 0.01, setLayer);
        break;
      case 'innerRadius':
        buildAnimatableWidget(layerGroup.body, 'Inner Radius', layer, 'innerRadius', 0, 2, 0.01, setLayer);
        break;
      case 'outerRadius':
        buildAnimatableWidget(layerGroup.body, 'Outer Radius', layer, 'outerRadius', 0, 2, 0.01, setLayer);
        break;
      case 'color':
        buildColorWidget(layerGroup.body, 'Color', layer, 'color', setLayer);
        break;
      case 'lineWidth':
        buildAnimatableWidget(layerGroup.body, 'Line Width', layer, 'lineWidth', 0, 10, 0.25, setLayer);
        break;
      case 'alpha':
        buildAnimatableWidget(layerGroup.body, 'Alpha', layer, 'alpha', 0, 1, 0.01, setLayer);
        break;
      case 'count':
        addWidgetTo(layerGroup.body, NumberSlider('Count', 1, 32, 1, layer.count || 8, v => setLayer('count', v)));
        break;
      case 'gradient':
        buildGradientEditor(layerGroup.body, layer, setLayer);
        break;
      case 'dashPattern': {
        const dp = layer.dashPattern || [4, 6];
        const dpGroup = PropertyGroup('Dash Pattern');
        addWidgetTo(dpGroup.body, NumberSlider('On', 1, 20, 1, dp[0], v => { dp[0] = v; setLayer('dashPattern', [...dp]); }));
        addWidgetTo(dpGroup.body, NumberSlider('Off', 1, 20, 1, dp[1], v => { dp[1] = v; setLayer('dashPattern', [...dp]); }));
        layerGroup.body.appendChild(dpGroup.el);
        break;
      }
      case 'shadow':
        buildShadowEditor(layerGroup.body, layer, setLayer);
        break;
    }
  }

  // startAt (optional layer delay)
  const hasStartAt = layer.startAt != null;
  const startAtToggle = Toggle('Delay Start', hasStartAt, v => {
    if (v) layer.startAt = 0.1;
    else delete layer.startAt;
    markDirtyAndReplay(); buildPropsPanel();
  });
  layerGroup.body.appendChild(startAtToggle.el);
  if (hasStartAt) {
    addWidgetTo(layerGroup.body, NumberSlider('Start At', 0, 0.99, 0.01, layer.startAt, v => setLayer('startAt', v)));
  }

  // State overrides (for persistent effects)
  if (def.lifecycle === 'persistent' && def.states && def.states.length > 0) {
    buildStateOverrides(layerGroup.body, layer, def.states, setLayer);
  }

  // Layer action buttons (remove, reorder)
  const actionRow = document.createElement('div');
  actionRow.style.cssText = 'display:flex;gap:4px;margin-top:4px;';

  if (phase.layers.length > 1) {
    if (layerIdx > 0) {
      actionRow.appendChild(mkBtn('Up', () => {
        [phase.layers[layerIdx - 1], phase.layers[layerIdx]] = [phase.layers[layerIdx], phase.layers[layerIdx - 1]];
        markDirtyAndReplay(); buildPropsPanel();
      }));
    }
    if (layerIdx < phase.layers.length - 1) {
      actionRow.appendChild(mkBtn('Down', () => {
        [phase.layers[layerIdx], phase.layers[layerIdx + 1]] = [phase.layers[layerIdx + 1], phase.layers[layerIdx]];
        markDirtyAndReplay(); buildPropsPanel();
      }));
    }
  }

  const rmLayerBtn = mkBtn('Remove Layer', () => {
    phase.layers.splice(layerIdx, 1);
    markDirtyAndReplay(); buildPropsPanel();
  }, 'editor-btn editor-btn-danger');
  rmLayerBtn.style.fontSize = '10px';
  actionRow.appendChild(rmLayerBtn);
  layerGroup.body.appendChild(actionRow);
}

// ─── Animatable value widget ─────────────────────────────────────────────
// Handles static number, animated {from,to}, oscillating {base,amplitude,freq}

function buildAnimatableWidget(parent, label, layer, field, min, max, step, setLayer) {
  const val = layer[field];
  const group = PropertyGroup(label);
  parent.appendChild(group.el);

  // Determine current mode
  let mode = 'static';
  if (val && typeof val === 'object') {
    if ('from' in val) mode = 'animated';
    else if ('base' in val) mode = 'oscillating';
  }

  const modeSelect = Select('Mode', [
    { value: 'static', label: 'Static' },
    { value: 'animated', label: 'Animated' },
    { value: 'oscillating', label: 'Oscillating' },
  ], mode, newMode => {
    if (newMode === 'static') {
      const current = typeof val === 'number' ? val : (val?.from ?? val?.base ?? 0.5);
      layer[field] = current;
    } else if (newMode === 'animated') {
      const current = typeof val === 'number' ? val : (val?.from ?? val?.base ?? 0);
      layer[field] = { from: current, to: 0 };
    } else if (newMode === 'oscillating') {
      const current = typeof val === 'number' ? val : (val?.base ?? val?.from ?? 0.5);
      layer[field] = { base: current, amplitude: 0.2, freq: 0.001 };
    }
    setLayer(field, layer[field]);
    buildPropsPanel();
  });
  group.body.appendChild(modeSelect.el);

  if (mode === 'static') {
    const v = typeof val === 'number' ? val : 0;
    addWidgetTo(group.body, NumberSlider('Value', min, max, step, v, nv => setLayer(field, nv)));
  } else if (mode === 'animated') {
    addWidgetTo(group.body, NumberSlider('From', min, max, step, val.from ?? 0, nv => { val.from = nv; setLayer(field, { ...val }); }));
    addWidgetTo(group.body, NumberSlider('To', min, max, step, val.to ?? 0, nv => { val.to = nv; setLayer(field, { ...val }); }));

    // Modulate toggle
    const hasMod = !!val.modulate;
    const modToggle = Toggle('Modulate', hasMod, v => {
      if (v) val.modulate = { freq: 10, amp: 0.1 };
      else delete val.modulate;
      setLayer(field, { ...val });
      buildPropsPanel();
    });
    group.body.appendChild(modToggle.el);

    if (hasMod) {
      addWidgetTo(group.body, NumberSlider('Mod Freq', 0.1, 100, 0.1, val.modulate.freq || 10, nv => { val.modulate.freq = nv; setLayer(field, { ...val }); }));
      addWidgetTo(group.body, NumberSlider('Mod Amp', 0, 1, 0.01, val.modulate.amp || 0, nv => { val.modulate.amp = nv; setLayer(field, { ...val }); }));
    }
  } else if (mode === 'oscillating') {
    addWidgetTo(group.body, NumberSlider('Base', min, max, step, val.base ?? 0, nv => { val.base = nv; setLayer(field, { ...val }); }));
    addWidgetTo(group.body, NumberSlider('Amplitude', 0, max, step, val.amplitude ?? 0, nv => { val.amplitude = nv; setLayer(field, { ...val }); }));
    addWidgetTo(group.body, NumberSlider('Freq', 0.0001, 0.1, 0.0001, val.freq ?? 0.001, nv => { val.freq = nv; setLayer(field, { ...val }); }));
  }
}

// ─── Color widget ────────────────────────────────────────────────────────
// Handles string or {local, remote} entity color

function buildColorWidget(parent, label, layer, field, setLayer) {
  const val = layer[field];
  const group = PropertyGroup(label);
  parent.appendChild(group.el);

  const isEntity = val && typeof val === 'object' && ('local' in val || 'remote' in val);

  const modeSelect = Select('Mode', [
    { value: 'static', label: 'Static' },
    { value: 'entity', label: 'Local/Remote' },
  ], isEntity ? 'entity' : 'static', newMode => {
    if (newMode === 'static') {
      layer[field] = typeof val === 'string' ? val : (val?.local || '#ffffff');
    } else {
      layer[field] = { local: typeof val === 'string' ? val : '#33aaaa', remote: '#2288aa' };
    }
    setLayer(field, layer[field]);
    buildPropsPanel();
  });
  group.body.appendChild(modeSelect.el);

  if (isEntity) {
    addWidgetTo(group.body, ColorInput('Local', val.local || '#ffffff', nv => { val.local = nv; setLayer(field, { ...val }); }));
    addWidgetTo(group.body, ColorInput('Remote', val.remote || '#ffffff', nv => { val.remote = nv; setLayer(field, { ...val }); }));
  } else {
    addWidgetTo(group.body, ColorInput('Color', typeof val === 'string' ? val : '#ffffff', nv => setLayer(field, nv)));
  }
}

// ─── Gradient editor ──────────────────────────────────────────────────────

function buildGradientEditor(parent, layer, setLayer) {
  const group = PropertyGroup('Gradient Stops');
  parent.appendChild(group.el);

  const stops = layer.gradient || [];

  stops.forEach((s, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:4px;align-items:center;margin:2px 0;';
    const offIn = document.createElement('input');
    offIn.type = 'number'; offIn.step = '0.1'; offIn.min = '0'; offIn.max = '1'; offIn.value = s.offset;
    offIn.className = 'editor-num-input'; offIn.style.width = '45px';
    const colIn = document.createElement('input');
    colIn.type = 'text'; colIn.value = s.color;
    colIn.className = 'editor-num-input'; colIn.style.width = '120px';
    const rmBtn = document.createElement('button');
    rmBtn.className = 'editor-btn editor-btn-danger'; rmBtn.textContent = '\u00d7'; rmBtn.style.fontSize = '10px';

    offIn.addEventListener('change', () => { stops[i].offset = parseFloat(offIn.value) || 0; setLayer('gradient', [...stops]); });
    colIn.addEventListener('change', () => { stops[i].color = colIn.value; setLayer('gradient', [...stops]); });
    rmBtn.addEventListener('click', () => { stops.splice(i, 1); setLayer('gradient', stops.length ? [...stops] : undefined); buildPropsPanel(); });

    row.append(offIn, colIn, rmBtn);
    group.body.appendChild(row);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'editor-btn editor-btn-subtle'; addBtn.textContent = '+ Add Stop'; addBtn.style.fontSize = '10px';
  addBtn.addEventListener('click', () => {
    if (!layer.gradient) layer.gradient = [];
    layer.gradient.push({ offset: 1, color: 'rgba(0,0,0,0)' });
    setLayer('gradient', [...layer.gradient]);
    buildPropsPanel();
  });
  group.body.appendChild(addBtn);
}

// ─── Shadow editor ────────────────────────────────────────────────────────

function buildShadowEditor(parent, layer, setLayer) {
  const group = PropertyGroup('Shadow');
  parent.appendChild(group.el);

  const shadow = layer.shadow || { color: 'transparent', blur: 0 };

  // Shadow color — support "$color" reference
  const colorVal = shadow.color || 'transparent';
  const isRef = colorVal === '$color';

  const refToggle = Toggle('Use Layer Color', isRef, v => {
    shadow.color = v ? '$color' : '#ffffff';
    setLayer('shadow', { ...shadow });
    buildPropsPanel();
  });
  group.body.appendChild(refToggle.el);

  if (!isRef) {
    addWidgetTo(group.body, ColorInput('Color', colorVal, nv => { shadow.color = nv; setLayer('shadow', { ...shadow }); }));
  }

  // Shadow blur — can be animatable
  const blurVal = shadow.blur;
  if (typeof blurVal === 'object' && 'base' in blurVal) {
    addWidgetTo(group.body, NumberSlider('Blur Base', 0, 60, 1, blurVal.base || 0, nv => { shadow.blur = { ...blurVal, base: nv }; setLayer('shadow', { ...shadow }); }));
    addWidgetTo(group.body, NumberSlider('Blur Amplitude', 0, 30, 1, blurVal.amplitude || 0, nv => { shadow.blur = { ...blurVal, amplitude: nv }; setLayer('shadow', { ...shadow }); }));
    addWidgetTo(group.body, NumberSlider('Blur Freq', 0.0001, 0.1, 0.0001, blurVal.freq || 0.001, nv => { shadow.blur = { ...blurVal, freq: nv }; setLayer('shadow', { ...shadow }); }));
  } else {
    addWidgetTo(group.body, NumberSlider('Blur', 0, 60, 1, typeof blurVal === 'number' ? blurVal : 0, nv => { shadow.blur = nv; setLayer('shadow', { ...shadow }); }));
  }
}

// ─── State overrides (persistent effects) ─────────────────────────────────

function buildStateOverrides(parent, layer, states, setLayer) {
  const group = PropertyGroup('State Overrides');
  parent.appendChild(group.el);

  if (!layer.stateOverrides) layer.stateOverrides = {};

  for (const state of states) {
    const overrides = layer.stateOverrides[state] || {};
    const stateGroup = PropertyGroup(state);
    group.body.appendChild(stateGroup.el);

    const hasOverride = !!layer.stateOverrides[state];
    const enableToggle = Toggle('Override', hasOverride, v => {
      if (v) layer.stateOverrides[state] = {};
      else delete layer.stateOverrides[state];
      setLayer('stateOverrides', { ...layer.stateOverrides });
      buildPropsPanel();
    });
    stateGroup.body.appendChild(enableToggle.el);

    if (hasOverride) {
      // Show overridable properties based on primitive type
      const info = document.createElement('div');
      info.style.cssText = 'color:#7a6a4a;font-size:10px;margin:4px 0;';
      info.textContent = 'Override fields: color, alpha, shadow, lineWidth';
      stateGroup.body.appendChild(info);

      // Color override
      if (overrides.color !== undefined) {
        addWidgetTo(stateGroup.body, ColorInput('Color', overrides.color, v => { overrides.color = v; setLayer('stateOverrides', { ...layer.stateOverrides }); }));
      } else {
        stateGroup.body.appendChild(mkBtn('+ Color', () => { overrides.color = '#cc3333'; layer.stateOverrides[state] = overrides; setLayer('stateOverrides', { ...layer.stateOverrides }); buildPropsPanel(); }));
      }

      // Alpha override
      if (overrides.alpha !== undefined) {
        buildAnimatableWidget(stateGroup.body, 'Alpha', overrides, 'alpha', 0, 1, 0.01, (f, v) => { overrides[f] = v; setLayer('stateOverrides', { ...layer.stateOverrides }); });
      } else {
        stateGroup.body.appendChild(mkBtn('+ Alpha', () => { overrides.alpha = 0.5; layer.stateOverrides[state] = overrides; setLayer('stateOverrides', { ...layer.stateOverrides }); buildPropsPanel(); }));
      }

      // Shadow override
      if (overrides.shadow !== undefined) {
        const sGroup = PropertyGroup('Shadow Override');
        stateGroup.body.appendChild(sGroup.el);
        addWidgetTo(sGroup.body, ColorInput('Color', overrides.shadow.color || '#cc3333', v => { overrides.shadow.color = v; setLayer('stateOverrides', { ...layer.stateOverrides }); }));
        addWidgetTo(sGroup.body, NumberSlider('Blur', 0, 60, 1, typeof overrides.shadow.blur === 'number' ? overrides.shadow.blur : 10, v => { overrides.shadow.blur = v; setLayer('stateOverrides', { ...layer.stateOverrides }); }));
      } else {
        stateGroup.body.appendChild(mkBtn('+ Shadow', () => { overrides.shadow = { color: '#cc3333', blur: 10 }; layer.stateOverrides[state] = overrides; setLayer('stateOverrides', { ...layer.stateOverrides }); buildPropsPanel(); }));
      }
    }
  }
}

function addWidgetTo(parent, widget) {
  parent.appendChild(widget.el);
}

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY EFFECT PROPERTIES (trail/beam types)
// ═══════════════════════════════════════════════════════════════════════════

function buildLegacyProps(def) {
  const set = (field, val) => {
    def[field] = val;
    markDirtyAndReplay();
  };

  switch (def.type) {
    case 'bubbleTrail': buildBubbleTrailProps(def, set); break;
    case 'taperedTrail': buildTaperedTrailProps(def, set); break;
    case 'wiggleBeam': buildWiggleBeamProps(def, set); break;
    default:
      propsEl.innerHTML += '<div style="color:#7a6a4a;">Unknown VFX type: ' + def.type + '</div>';
  }
}

function buildBubbleTrailProps(def, set) {
  addWidgetTo(propsEl, NumberSlider('Max Length', 5, 100, 1, def.maxLength, v => set('maxLength', v)));
  addWidgetTo(propsEl, NumberSlider('Point Lifetime (ms)', 100, 3000, 50, def.pointLifetime, v => set('pointLifetime', v)));
  addWidgetTo(propsEl, NumberSlider('Bubble Min Radius', 0.1, 10, 0.1, def.bubbleMinRadius, v => set('bubbleMinRadius', v)));
  addWidgetTo(propsEl, NumberSlider('Bubble Max Radius', 0.5, 15, 0.1, def.bubbleMaxRadius, v => set('bubbleMaxRadius', v)));
  addWidgetTo(propsEl, NumberSlider('Max Speed (alpha modulation)', 0, 300, 5, def.maxSpeed, v => set('maxSpeed', v)));
  addWidgetTo(propsEl, NumberSlider('Glow Blur', 0, 20, 1, def.glowBlur, v => set('glowBlur', v)));

  const localColors = PropertyGroup('Local Colors', [
    ColorInput('Inner', def.colorInner, v => set('colorInner', v)),
    ColorInput('Outer', def.colorOuter, v => set('colorOuter', v)),
  ]);
  propsEl.appendChild(localColors.el);

  const remoteColors = PropertyGroup('Remote Colors', [
    ColorInput('Inner', def.colorRemoteInner, v => set('colorRemoteInner', v)),
    ColorInput('Outer', def.colorRemoteOuter, v => set('colorRemoteOuter', v)),
  ]);
  propsEl.appendChild(remoteColors.el);

  // Anchors list
  const anchorsGroup = PropertyGroup('Anchors');
  propsEl.appendChild(anchorsGroup.el);
  buildAnchorsList(def, set, anchorsGroup.body);
}

function buildAnchorsList(def, set, parent) {
  parent.innerHTML = '';
  const anchors = def.anchors || [];
  anchors.forEach((a, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:4px;align-items:center;margin:2px 0;';
    const xIn = document.createElement('input');
    xIn.type = 'number'; xIn.step = '0.05'; xIn.value = a.x;
    xIn.className = 'editor-num-input'; xIn.style.width = '55px';
    const yIn = document.createElement('input');
    yIn.type = 'number'; yIn.step = '0.05'; yIn.value = a.y;
    yIn.className = 'editor-num-input'; yIn.style.width = '55px';
    const lbl = document.createElement('span');
    lbl.style.cssText = 'color:#7a6a4a;font-size:10px;';
    lbl.textContent = `#${i}`;
    const rmBtn = document.createElement('button');
    rmBtn.className = 'editor-btn editor-btn-danger';
    rmBtn.textContent = '\u00d7';
    rmBtn.style.fontSize = '10px';

    xIn.addEventListener('change', () => { anchors[i].x = parseFloat(xIn.value) || 0; set('anchors', [...anchors]); });
    yIn.addEventListener('change', () => { anchors[i].y = parseFloat(yIn.value) || 0; set('anchors', [...anchors]); });
    rmBtn.addEventListener('click', () => { anchors.splice(i, 1); set('anchors', [...anchors]); buildAnchorsList(def, set, parent); });

    row.append(lbl, xIn, yIn, rmBtn);
    parent.appendChild(row);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'editor-btn editor-btn-subtle';
  addBtn.textContent = '+ Add Anchor';
  addBtn.style.fontSize = '10px';
  addBtn.addEventListener('click', () => { anchors.push({ x: 0, y: 0 }); set('anchors', [...anchors]); buildAnchorsList(def, set, parent); });
  parent.appendChild(addBtn);
}

function buildTaperedTrailProps(def, set) {
  addWidgetTo(propsEl, NumberSlider('Max Length', 5, 100, 1, def.maxLength, v => set('maxLength', v)));
  addWidgetTo(propsEl, NumberSlider('Point Lifetime (ms)', 100, 3000, 50, def.pointLifetime, v => set('pointLifetime', v)));
  addWidgetTo(propsEl, NumberSlider('Base Width', 0.5, 15, 0.5, def.baseWidth, v => set('baseWidth', v)));
  addWidgetTo(propsEl, NumberSlider('Tip Width', 0.05, 5, 0.05, def.tipWidth, v => set('tipWidth', v)));
  addWidgetTo(propsEl, ColorInput('Inner Color', def.colorInner, v => set('colorInner', v)));
  addWidgetTo(propsEl, ColorInput('Outer Color', def.colorOuter, v => set('colorOuter', v)));
  addWidgetTo(propsEl, NumberSlider('Glow Blur', 0, 20, 1, def.glowBlur, v => set('glowBlur', v)));
}

function buildWiggleBeamProps(def, set) {
  addWidgetTo(propsEl, NumberSlider('Segments', 4, 40, 1, def.segments, v => set('segments', v)));
  addWidgetTo(propsEl, NumberSlider('Wiggle Amplitude', 0, 20, 0.5, def.wiggleAmplitude, v => set('wiggleAmplitude', v)));
  addWidgetTo(propsEl, NumberSlider('Wiggle Variation', 0, 10, 0.5, def.wiggleAmplitudeVariation, v => set('wiggleAmplitudeVariation', v)));
  addWidgetTo(propsEl, NumberSlider('Wiggle Freq', 1, 30, 1, def.wiggleFreq, v => set('wiggleFreq', v)));
  addWidgetTo(propsEl, ColorInput('Local Color', def.colorLocal, v => set('colorLocal', v)));
  addWidgetTo(propsEl, ColorInput('Remote Color', def.colorRemote, v => set('colorRemote', v)));
  addWidgetTo(propsEl, NumberSlider('Line Width', 0.5, 8, 0.5, def.lineWidth, v => set('lineWidth', v)));
  addWidgetTo(propsEl, NumberSlider('Glow Width', 1, 15, 0.5, def.glowWidth, v => set('glowWidth', v)));
  addWidgetTo(propsEl, NumberSlider('Alpha', 0, 1, 0.05, def.alpha, v => set('alpha', v)));
  addWidgetTo(propsEl, NumberSlider('Glow Alpha', 0, 1, 0.05, def.glowAlpha, v => set('glowAlpha', v)));
  addWidgetTo(propsEl, NumberSlider('Shadow Blur', 0, 30, 1, def.shadowBlur, v => set('shadowBlur', v)));
  addWidgetTo(propsEl, NumberSlider('Glow Shadow Blur', 0, 40, 1, def.glowShadowBlur, v => set('glowShadowBlur', v)));
}

// ═══════════════════════════════════════════════════════════════════════════
// CRUD
// ═══════════════════════════════════════════════════════════════════════════

function createNewEffect() {
  const typeOptions = Object.keys(NEW_EFFECT_DEFAULTS);
  const type = prompt(`New effect type:\n${typeOptions.join(', ')}`, 'phased');
  if (!type || !NEW_EFFECT_DEFAULTS[type]) return;
  const name = prompt('Effect name (camelCase):', 'newEffect');
  if (!name || workingData[name]) { alert(name ? 'Name already exists' : 'Cancelled'); return; }
  workingData[name] = JSON.parse(JSON.stringify(NEW_EFFECT_DEFAULTS[type]));
  saveManager.markDirty();
  selectEffect(name);
}

function deleteSelected() {
  if (!selectedId) return;
  if (!confirm(`Delete "${selectedId}"?`)) return;
  delete workingData[selectedId];
  saveManager.markDirty();
  selectedId = null;
  rebuildList('');
  buildPropsPanel();
}

function duplicateSelected() {
  if (!selectedId || !workingData[selectedId]) return;
  const name = prompt('New name for duplicate:', selectedId + 'Copy');
  if (!name || workingData[name]) { alert(name ? 'Name already exists' : 'Cancelled'); return; }
  workingData[name] = JSON.parse(JSON.stringify(workingData[selectedId]));
  saveManager.markDirty();
  selectEffect(name);
}

// ═══════════════════════════════════════════════════════════════════════════
// PREVIEW RENDERING
// ═══════════════════════════════════════════════════════════════════════════

function startPreviewLoop() {
  function frame() {
    if (!previewCanvas || !effectsRenderer) return;
    animFrame = requestAnimationFrame(frame);

    const now = performance.now();
    if (playing) simulator.update(now, speedMult);

    const ctx = previewCanvas.getContext('2d');
    const w = previewCanvas.width;
    const h = previewCanvas.height;

    // Clear
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#060d18';
    ctx.fillRect(0, 0, w, h);

    // Subtle grid
    ctx.strokeStyle = 'rgba(212,160,86,0.06)';
    ctx.lineWidth = 0.5;
    const step = 20;
    for (let x = w / 2 % step; x < w; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = h / 2 % step; y < h; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    // Crosshair axes
    ctx.strokeStyle = 'rgba(212,160,86,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();

    if (!selectedId || !workingData[selectedId]) return;

    const def = workingData[selectedId];
    const type = def.type;
    const cx = w / 2;
    const cy = h / 2;

    try {
      if (type === 'phased') {
        // Use VFXInterpreter directly — single rendering path
        const progress = def.lifecycle === 'persistent' ? null : simulator.getProgress();
        const scaleEl = document.getElementById('vfx-scale');
        const scale = scaleEl ? parseFloat(scaleEl.value) || def.defaultScale || 120 : def.defaultScale || 120;
        drawPhasedEffect(ctx, cx, cy, def, progress, scale, now, { isLocal: true });

        // Progress bar for one-shot effects
        if (def.lifecycle !== 'persistent' && progress !== null) {
          ctx.save();
          ctx.fillStyle = 'rgba(212,160,86,0.3)';
          ctx.fillRect(10, h - 8, (w - 20) * progress, 4);
          ctx.strokeStyle = 'rgba(212,160,86,0.15)';
          ctx.strokeRect(10, h - 8, w - 20, 4);
          ctx.restore();
        }
      } else if (type === 'bubbleTrail') {
        // drawTrails takes [{ def, points }] with world-space points that the
        // preview camera transforms to screen — mirrors the in-game trail path.
        const points = simulator.trailPoints.trail0 || [];
        effectsRenderer.drawTrails([{ def, points }], now, { isLocal: true });
      } else if (type === 'taperedTrail') {
        const pts = (simulator.trailPoints.trail0 || []).map(pt => ({
          sx: cx + pt.x, sy: cy + pt.y, timestamp: pt.timestamp,
        }));
        drawTrailEffect(ctx, def, pts, now);
      } else if (type === 'wiggleBeam') {
        const shipX = cx - 60, shipY = cy;
        const targetX = cx + 60, targetY = cy;
        drawBeamEffect(ctx, def, shipX, shipY, targetX, targetY, now, { isLocal: true, entityId: 0 });
      }

      // Draw debris on top
      effectsRenderer.drawDebris(simulator.debris.map(d => ({
        x: d.x, y: d.y, size: d.size, color: d.color, alpha: d.alpha,
      })));
    } catch (err) {
      console.warn('VFX editor preview error:', err.message);
    }
  }

  animFrame = requestAnimationFrame(frame);
}

