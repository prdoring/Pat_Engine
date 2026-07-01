// Sequence Editor — visual timeline editor for FX sequences (SFX + VFX + loops + signals).

import { FX_SEQUENCES } from '/engine/data/fxSequences.js';
import { SOUND_CONFIG } from '/engine/data/sounds.js';
import { VFX_DEFS } from '/engine/data/vfx.js';
import { SoundManager } from '/engine/audio/SoundManager.js';
import { FXSequenceRunner } from '/engine/fx/FXSequenceRunner.js';
import { EffectsRenderer } from '/engine/render/EffectsRenderer.js';
import { drawUnifiedArt } from '/engine/render/ArtInterpreter.js';
import { themeColor, themeColorRgba } from '/editors/shared/theme.js';
import { loadManifest } from '/editors/shared/index.js';
import {
  SaveManager,
  NumberSlider, Select, TextInput, Toggle, Button,
  PropertyGroup, EditorPreviewCamera, createResizer,
} from '/editors/shared/index.js';
import {
  TRACK_ORDER, TRACK_LABELS, TRACK_COLORS,
  TIMELINE_TRACK_HEIGHT, TIMELINE_HEADER_HEIGHT, TIMELINE_PADDING, MARKER_RADIUS,
  KNOWN_SIGNALS,
} from './constants.js';

// ─── State ───────────────────────────────────────────────────────────────────

let container = null;
let soundManager = null;
let runner = null;        // real engine FXSequenceRunner — the SAME interpreter the game uses
let saveManager = null;
let workingData = null;   // deep copy of fx-sequences.json sequences
let selectedSeqId = null;
let selectedStepIdx = -1;
let singleStepFolderOpen = false;

// Timeline state
let timeScale = 0.5;     // pixels per ms
let timeOffset = 0;       // horizontal pan offset in px
let playheadTime = 0;
let isPlaying = false;
let playStartReal = 0;
let playStartOffset = 0;
let autoStopTimer = null;
let animFrame = null;

// Drag state
let draggingStep = null;
let dragStartX = 0;
let dragStartDelay = 0;

// DOM refs
let sidebarEl = null;
let searchInput = null;
let timelineCanvas = null;
let timelineCtx = null;
let controlsEl = null;
let propsEl = null;
let saveRow = null;

// VFX preview state
let previewCanvas = null;
let previewCtx = null;
let previewCamera = null;
let effectsRenderer = null;
let vfxEffects = [];
let vfxDebris = [];
let vfxLastUpdate = 0;

// Art preview state
let artPreviewType = 'none'; // 'none' | a manifest previewEntity id
let artPreviewBaseState = null; // user-chosen base state for preview (null = first available)
let artPreviewState = null;  // dynamic state set by setState signals during playback
let artPreviewTransition = {};  // mutable transition object for blending
let artPreviewDurationOverride = undefined;  // transition duration override from signal
let artRegistry = {};      // collection id -> { assetId -> artDef }
let previewEntities = [];  // from the editor manifest
let artLoading = false;

// ─── Mount / Unmount ─────────────────────────────────────────────────────────

export function mount(el) {
  container = el;
  workingData = JSON.parse(JSON.stringify(FX_SEQUENCES));

  soundManager = new SoundManager();
  soundManager.init();

  // Drive the preview through the REAL engine sequence interpreter, so what the
  // editor plays is byte-for-byte what the game plays (repeat/positional/offset+
  // angle/volume/loop-by-handle/signal semantics all come from FXSequenceRunner,
  // never re-implemented here). VFX are routed into the same EffectsRenderer the
  // game uses via a thin effects-sink; signals drive the art-preview state.
  runner = new FXSequenceRunner(soundManager, makePreviewEffectsSink(), onPreviewSignal);

  saveManager = new SaveManager('fx-sequences.json');
  saveManager.onDirtyChange(dirty => {
    window.editorSetUnsaved?.('sequences', dirty);
  });

  buildUI();
  loadArtData();
  startAnimLoop();
}

export function unmount() {
  stopPlayback();
  stopAnimLoop();
  soundManager = null;
  runner = null;
  effectsRenderer = null;
  previewCanvas = null;
  previewCamera = null;
  container = null;
}

export function save() { doSave(); }
export function isDirty() { return saveManager?.isDirty() ?? false; }

// ─── Animation Loop ──────────────────────────────────────────────────────────

function startAnimLoop() {
  const tick = () => {
    const now = performance.now();
    if (isPlaying) {
      playheadTime = playStartOffset + (now - playStartReal);
    }
    renderTimeline();
    renderVfxPreview(now);
    animFrame = requestAnimationFrame(tick);
  };
  animFrame = requestAnimationFrame(tick);
}

function stopAnimLoop() {
  if (animFrame) cancelAnimationFrame(animFrame);
  animFrame = null;
}

// ─── UI Construction ─────────────────────────────────────────────────────────

function buildUI() {
  container.innerHTML = '';
  container.style.flexDirection = 'column';
  container.style.height = '100%';

  // Top bar
  const topBar = document.createElement('div');
  topBar.style.cssText = 'display:flex;align-items:center;padding:6px 12px;border-bottom:1px solid var(--ed-border-subtle);gap:12px;flex-shrink:0;';

  const title = document.createElement('span');
  title.style.cssText = 'color:var(--ed-accent);font-weight:bold;font-size:13px;';
  title.textContent = 'SEQUENCE EDITOR';
  topBar.appendChild(title);

  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  topBar.appendChild(spacer);

  saveRow = document.createElement('div');
  saveRow.style.cssText = 'display:flex;gap:8px;align-items:center;';
  topBar.appendChild(saveRow);
  rebuildSaveRow();

  container.appendChild(topBar);

  // Main: sidebar + center
  const main = document.createElement('div');
  main.style.cssText = 'display:flex;flex:1;overflow:hidden;';

  // Sidebar
  sidebarEl = document.createElement('div');
  sidebarEl.style.cssText = 'width:190px;overflow-y:auto;flex-shrink:0;padding:8px;';
  main.appendChild(sidebarEl);
  main.appendChild(createResizer('horizontal', sidebarEl, { min: 120, max: 350 }).el);

  // Center
  const center = document.createElement('div');
  center.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden;';

  // Controls
  controlsEl = document.createElement('div');
  controlsEl.style.cssText = 'display:flex;gap:8px;padding:6px 12px;align-items:center;flex-wrap:wrap;flex-shrink:0;border-bottom:1px solid var(--ed-surface);';
  center.appendChild(controlsEl);

  // VFX Preview canvas
  const previewWrap = document.createElement('div');
  previewWrap.style.cssText = 'flex:0 0 140px;position:relative;overflow:hidden;background:var(--ed-bg-app);';
  previewCanvas = document.createElement('canvas');
  previewCanvas.style.cssText = 'width:100%;height:100%;display:block;';
  previewWrap.appendChild(previewCanvas);
  center.appendChild(previewWrap);
  center.appendChild(createResizer('vertical', previewWrap, { min: 80, max: 400, prop: 'flexBasis' }).el);

  // Size preview canvas
  const resizePreview = () => {
    const rect = previewWrap.getBoundingClientRect();
    previewCanvas.width = rect.width;
    previewCanvas.height = rect.height;
  };
  resizePreview();
  const previewRo = new ResizeObserver(resizePreview);
  previewRo.observe(previewWrap);

  // Setup preview renderer
  previewCtx = previewCanvas.getContext('2d');
  previewCamera = new EditorPreviewCamera(previewCanvas);
  previewCamera.attachControls(previewCanvas);
  effectsRenderer = new EffectsRenderer(previewCtx, previewCamera, previewCanvas);

  // Timeline canvas
  const timelineWrap = document.createElement('div');
  timelineWrap.style.cssText = 'flex:0 0 200px;position:relative;overflow:hidden;';
  timelineCanvas = document.createElement('canvas');
  timelineCanvas.style.cssText = 'width:100%;height:100%;display:block;';
  timelineWrap.appendChild(timelineCanvas);
  timelineCtx = timelineCanvas.getContext('2d');
  center.appendChild(timelineWrap);

  // Setup timeline interactions
  setupTimelineEvents();

  center.appendChild(createResizer('vertical', timelineWrap, { min: 80, max: 500, prop: 'flexBasis' }).el);

  // Properties panel
  propsEl = document.createElement('div');
  propsEl.style.cssText = 'flex:1;overflow-y:auto;padding:8px 12px;';
  center.appendChild(propsEl);

  main.appendChild(center);
  container.appendChild(main);

  buildSidebar();
  buildControls();
  clearProps();

  // Resize timeline canvas to fit
  const ro = new ResizeObserver(() => resizeTimelineCanvas(timelineWrap));
  ro.observe(timelineWrap);
  resizeTimelineCanvas(timelineWrap);
}

function resizeTimelineCanvas(wrap) {
  const rect = wrap.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  timelineCanvas.width = rect.width * dpr;
  timelineCanvas.height = rect.height * dpr;
  // DPR transform applied per-frame in renderTimeline
}

function rebuildSaveRow() {
  if (!saveRow) return;
  saveRow.innerHTML = '';
  const btn = saveManager.getSaveButton(() => doSave());
  saveRow.appendChild(btn);
  const indicator = saveManager.getStatusIndicator();
  saveRow.appendChild(indicator);
}

function doSave() {
  saveManager.save({ sequences: workingData });
  rebuildSaveRow();
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

function buildSidebar() {
  sidebarEl.innerHTML = '';

  // Search
  searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search...';
  searchInput.className = 'editor-search';
  searchInput.style.cssText = 'width:100%;margin-bottom:8px;background:var(--ed-surface);border:1px solid var(--ed-border-subtle);color:var(--ed-accent);padding:4px 6px;border-radius:3px;font-size:11px;';
  searchInput.addEventListener('input', rebuildSequenceList);
  sidebarEl.appendChild(searchInput);

  // New sequence button
  const newBtn = Button('+ New Sequence', () => {
    const id = prompt('Sequence ID (camelCase):');
    if (!id || workingData[id]) return;
    workingData[id] = { steps: [] };
    saveManager.markDirty();
    rebuildSaveRow();
    selectSequence(id);
    rebuildSequenceList();
  }, 'subtle');
  newBtn.el.style.cssText += 'width:100%;margin-bottom:8px;font-size:11px;';
  sidebarEl.appendChild(newBtn.el);

  // Sequence list container
  const listEl = document.createElement('div');
  listEl.id = 'seq-list';
  sidebarEl.appendChild(listEl);

  rebuildSequenceList();
}

function buildSequenceRow(id, parentEl) {
  const row = document.createElement('div');
  row.style.cssText = `padding:3px 8px;cursor:pointer;font-size:11px;border-radius:3px;margin:1px 0;
    color:${id === selectedSeqId ? 'var(--ed-accent)' : 'var(--ed-muted2)'};
    background:${id === selectedSeqId ? 'var(--ed-surface-sel)' : ''};`;

  const seq = workingData[id];
  const posTag = seq.positional ? ' [P]' : '';
  row.textContent = `${id}${posTag} (${seq.steps.length})`;

  row.addEventListener('click', () => selectSequence(id));
  row.addEventListener('mouseenter', () => {
    if (id !== selectedSeqId) row.style.background = 'var(--ed-surface)';
  });
  row.addEventListener('mouseleave', () => {
    if (id !== selectedSeqId) row.style.background = '';
  });
  parentEl.appendChild(row);
}

function rebuildSequenceList() {
  const listEl = sidebarEl.querySelector('#seq-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const filter = (searchInput?.value || '').toLowerCase();
  const ids = Object.keys(workingData).sort();

  // Partition into multi-step and single-step sequences
  const multiStep = [];
  const singleStep = [];
  for (const id of ids) {
    if (filter && !id.toLowerCase().includes(filter)) continue;
    const stepCount = workingData[id].steps.length;
    if (stepCount <= 1) singleStep.push(id);
    else multiStep.push(id);
  }

  // If the selected sequence just became multi-step, it's no longer in the folder
  if (selectedSeqId && multiStep.includes(selectedSeqId)) {
    // No action needed — it naturally appears in the main list
  }
  // If selected sequence is single-step, auto-expand the folder so it's visible
  if (selectedSeqId && singleStep.includes(selectedSeqId)) {
    singleStepFolderOpen = true;
  }

  // Render multi-step sequences
  for (const id of multiStep) {
    buildSequenceRow(id, listEl);
  }

  // Render single-step folder (only if there are any)
  if (singleStep.length > 0) {
    const folder = document.createElement('div');
    folder.style.cssText = 'margin-top:4px;';

    const header = document.createElement('div');
    header.style.cssText = `padding:3px 8px;cursor:pointer;font-size:11px;border-radius:3px;margin:1px 0;
      color:var(--ed-faint);user-select:none;`;
    header.textContent = `${singleStepFolderOpen ? '\u25BC' : '\u25B6'} Simple (${singleStep.length})`;
    header.addEventListener('click', () => {
      singleStepFolderOpen = !singleStepFolderOpen;
      rebuildSequenceList();
    });
    header.addEventListener('mouseenter', () => { header.style.background = 'var(--ed-surface)'; });
    header.addEventListener('mouseleave', () => { header.style.background = ''; });
    folder.appendChild(header);

    if (singleStepFolderOpen) {
      const contents = document.createElement('div');
      contents.style.cssText = 'padding-left:8px;';
      for (const id of singleStep) {
        buildSequenceRow(id, contents);
      }
      folder.appendChild(contents);
    }

    listEl.appendChild(folder);
  }

  // Delete button at bottom
  if (selectedSeqId) {
    const delBtn = Button('Delete Sequence', () => {
      if (!confirm(`Delete sequence "${selectedSeqId}"?`)) return;
      delete workingData[selectedSeqId];
      saveManager.markDirty();
      rebuildSaveRow();
      selectedSeqId = null;
      selectedStepIdx = -1;
      rebuildSequenceList();
      buildControls();
      clearProps();
    }, 'danger');
    delBtn.el.style.cssText += 'width:100%;margin-top:8px;font-size:11px;';
    listEl.appendChild(delBtn.el);
  }
}

function selectSequence(id) {
  selectedSeqId = id;
  selectedStepIdx = -1;
  playheadTime = 0;
  stopPlayback();

  // Fit timeline scale to sequence duration
  const maxDelay = getMaxDelay();
  if (maxDelay > 0) {
    timeScale = Math.max(0.1, Math.min(2, 300 / maxDelay));
  }
  timeOffset = 0;

  rebuildSequenceList();
  buildControls();
  clearProps();
}

// ─── Controls ────────────────────────────────────────────────────────────────

function buildControls() {
  controlsEl.innerHTML = '';

  if (!selectedSeqId) {
    const note = document.createElement('span');
    note.style.cssText = 'color:var(--ed-faint);font-size:11px;';
    note.textContent = 'Select a sequence to edit';
    controlsEl.appendChild(note);
    return;
  }

  // Play/Stop
  const playBtn = Button(isPlaying ? 'Stop' : 'Play', () => {
    if (isPlaying) stopPlayback();
    else startPlayback();
    buildControls();
  }, 'primary');
  controlsEl.appendChild(playBtn.el);

  // Reset
  const resetBtn = Button('Reset', () => {
    playheadTime = 0;
    stopPlayback();
    buildControls();
  }, 'subtle');
  controlsEl.appendChild(resetBtn.el);

  // Positional toggle
  const seq = workingData[selectedSeqId];
  const posW = Toggle('Positional', !!seq.positional, v => {
    seq.positional = v || undefined;
    if (!v) delete seq.positional;
    saveManager.markDirty();
    rebuildSaveRow();
    rebuildSequenceList();
  });
  controlsEl.appendChild(posW.el);

  // Zoom controls
  const zoomLabel = document.createElement('span');
  zoomLabel.style.cssText = 'color:var(--ed-faint);font-size:10px;margin-left:12px;';
  zoomLabel.textContent = `Zoom: ${timeScale.toFixed(2)}px/ms`;
  controlsEl.appendChild(zoomLabel);

  const zoomInBtn = Button('+', () => { timeScale = Math.min(5, timeScale * 1.3); }, 'subtle');
  const zoomOutBtn = Button('-', () => { timeScale = Math.max(0.05, timeScale / 1.3); }, 'subtle');
  controlsEl.appendChild(zoomOutBtn.el);
  controlsEl.appendChild(zoomInBtn.el);

  // Add step
  const addBtn = Button('+ Add Step', () => addStep(), 'subtle');
  addBtn.el.style.marginLeft = '12px';
  controlsEl.appendChild(addBtn.el);

  // Art preview selector — built from the manifest's previewEntities.
  const artOpts = [{ value: 'none', label: 'No Art' },
    ...previewEntities.map(e => ({ value: e.id, label: e.label || e.id }))];
  const artSel = Select('Art Preview', artOpts, artPreviewType, v => {
    artPreviewType = v;
    artPreviewBaseState = null; // reset base state when switching asset
    if (v !== 'none') loadArtData();
    buildControls(); // rebuild to show state dropdown
  });
  artSel.el.style.marginLeft = '12px';
  controlsEl.appendChild(artSel.el);

  // State selector — shown when the selected art asset has states
  const artDef = getSelectedArtDef();
  if (artDef && artDef.states && artDef.states.length > 0) {
    const stateOpts = artDef.states.map(s => ({ value: s, label: s }));
    const currentBase = artPreviewBaseState || artDef.states[0];
    const stateSel = Select('State', stateOpts, currentBase, v => {
      artPreviewBaseState = v;
    });
    controlsEl.appendChild(stateSel.el);
  }

  // Reset view button
  const resetViewBtn = Button('Reset View', () => previewCamera.resetView(), 'subtle');
  controlsEl.appendChild(resetViewBtn.el);
}

// ─── Timeline Rendering ──────────────────────────────────────────────────────

function renderTimeline() {
  if (!timelineCanvas || !timelineCtx) return;

  const ctx = timelineCtx;
  const dpr = devicePixelRatio || 1;
  const w = timelineCanvas.width / dpr;
  const h = timelineCanvas.height / dpr;
  if (w === 0 || h === 0) return;

  // Apply DPR transform so drawing coords match CSS pixels
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Clear (timeline chrome reuses the shared --ed-kf-* keyframe-timeline tokens,
  // read fresh each frame so a theme switch is picked up automatically)
  ctx.fillStyle = themeColor('--ed-kf-bg');
  ctx.fillRect(0, 0, w, h);

  if (!selectedSeqId || !workingData[selectedSeqId]) return;

  const seq = workingData[selectedSeqId];
  const steps = seq.steps;

  // Time axis helpers
  const timeToX = (ms) => TIMELINE_PADDING + timeOffset + ms * timeScale;
  const xToTime = (x) => (x - TIMELINE_PADDING - timeOffset) / timeScale;

  // Draw time axis
  ctx.fillStyle = themeColor('--ed-kf-field-bg');
  ctx.fillRect(0, 0, w, TIMELINE_HEADER_HEIGHT);
  ctx.strokeStyle = themeColor('--ed-kf-border');
  ctx.lineWidth = 1;

  // Time ticks
  const tickInterval = getTickInterval();
  const startTime = Math.max(0, Math.floor(xToTime(0) / tickInterval) * tickInterval);
  const endTime = xToTime(w);

  ctx.fillStyle = themeColor('--ed-kf-text');
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  for (let t = startTime; t <= endTime; t += tickInterval) {
    const x = timeToX(t);
    if (x < 0 || x > w) continue;

    ctx.beginPath();
    ctx.moveTo(x, TIMELINE_HEADER_HEIGHT - 6);
    ctx.lineTo(x, TIMELINE_HEADER_HEIGHT);
    ctx.strokeStyle = themeColor('--ed-kf-border');
    ctx.stroke();

    ctx.fillText(`${t}ms`, x, TIMELINE_HEADER_HEIGHT - 8);

    // Grid line
    ctx.strokeStyle = themeColor('--ed-kf-border-dim');
    ctx.beginPath();
    ctx.moveTo(x, TIMELINE_HEADER_HEIGHT);
    ctx.lineTo(x, h);
    ctx.stroke();
  }

  // Draw tracks
  const tracks = {};
  for (const type of TRACK_ORDER) {
    tracks[type] = [];
  }
  steps.forEach((step, i) => {
    const track = tracks[step.type];
    if (track) track.push({ step, index: i });
  });

  let trackY = TIMELINE_HEADER_HEIGHT + 4;
  for (const type of TRACK_ORDER) {
    if (tracks[type].length === 0) continue;

    // Track label
    ctx.fillStyle = TRACK_COLORS[type];
    ctx.globalAlpha = 0.5;
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(TRACK_LABELS[type], 4, trackY + TIMELINE_TRACK_HEIGHT / 2 + 3);
    ctx.globalAlpha = 1;

    // Track background stripe
    ctx.fillStyle = themeColorRgba('--ed-accent-rgb', 0.04);
    ctx.fillRect(0, trackY, w, TIMELINE_TRACK_HEIGHT);

    // Step markers
    for (const { step, index } of tracks[type]) {
      const x = timeToX(step.delay || 0);
      const cy = trackY + TIMELINE_TRACK_HEIGHT / 2;
      const isSelected = index === selectedStepIdx;
      const color = TRACK_COLORS[type];

      // Duration bar (for loops)
      if (type === 'loopStart') {
        const stopStep = findLoopStop(steps, step.handle);
        const endX = stopStep ? timeToX(stopStep.delay || 0) : w;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.15;
        ctx.fillRect(x, cy - 4, endX - x, 8);
        ctx.globalAlpha = 1;
      }

      // Step label
      const label = getStepLabel(step);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.7;
      ctx.font = '9px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(label, x + MARKER_RADIUS + 4, cy + 3);
      ctx.globalAlpha = 1;

      // Marker dot
      ctx.beginPath();
      ctx.arc(x, cy, MARKER_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? themeColor('--ed-kf-key-hi') : color;
      ctx.fill();
      if (isSelected) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    trackY += TIMELINE_TRACK_HEIGHT;
  }

  // Playhead
  const phX = timeToX(playheadTime);
  if (phX >= 0 && phX <= w) {
    ctx.strokeStyle = themeColor('--ed-kf-playhead');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(phX, 0);
    ctx.lineTo(phX, h);
    ctx.stroke();

    // Playhead triangle
    ctx.fillStyle = themeColor('--ed-kf-playhead');
    ctx.beginPath();
    ctx.moveTo(phX - 5, 0);
    ctx.lineTo(phX + 5, 0);
    ctx.lineTo(phX, 8);
    ctx.closePath();
    ctx.fill();
  }
}

function getTickInterval() {
  const intervals = [10, 25, 50, 100, 200, 500, 1000, 2000, 5000];
  for (const iv of intervals) {
    if (iv * timeScale >= 40) return iv; // at least 40px between ticks
  }
  return 5000;
}

function getMaxDelay() {
  if (!selectedSeqId || !workingData[selectedSeqId]) return 0;
  return workingData[selectedSeqId].steps.reduce((max, s) => Math.max(max, s.delay || 0), 0);
}

function findLoopStop(steps, handle) {
  if (!handle) return null;
  return steps.find(s => s.type === 'loopStop' && s.handle === handle) || null;
}

function getStepLabel(step) {
  switch (step.type) {
    case 'sfx': return step.sound + (step.volume !== undefined ? ` (${step.volume})` : '');
    case 'vfx': return step.effect || '?';
    case 'loopStart': return `${step.handle || step.sound}`;
    case 'loopStop': return `${step.handle}`;
    case 'signal': return step.name;
    default: return step.type;
  }
}

// ─── VFX Preview Rendering ───────────────────────────────────────────────────

function loadArtData() {
  if (artLoading || previewEntities.length) return;
  artLoading = true;
  loadManifest().then(async (manifest) => {
    previewEntities = manifest.previewEntities || [];
    // Load each art collection's file and resolve its nested asset map.
    await Promise.all((manifest.artCollections || []).map(async col => {
      const data = await fetch(`/data/${col.file}`).then(r => r.json());
      artRegistry[col.id] = (col.collectionKey && data[col.collectionKey]) || data;
    }));
    artLoading = false;
    buildControls(); // rebuild dropdown + state selector with loaded data
  }).catch(() => { artLoading = false; });
}

/** The preview entity selected in the dropdown (or null). */
function getPreviewEntity() {
  if (artPreviewType === 'none') return null;
  return previewEntities.find(e => e.id === artPreviewType) || null;
}

function getSelectedArtDef() {
  const e = getPreviewEntity();
  if (!e) return null;
  return artRegistry[e.artCollection]?.[e.artId] || null;
}

// Generic preview: draw the selected entity's art at its manifest radius/color.
// Game-specific chrome (health bars, labels, etc.) is intentionally NOT here —
// the engine preview shows the art itself, exactly as the interpreter renders it.
function drawArtPreview(ctx, now) {
  const e = getPreviewEntity();
  if (!e) return;
  const artDef = artRegistry[e.artCollection]?.[e.artId];
  if (!artDef) return;
  const state = artPreviewState ?? artPreviewBaseState ?? (e.states && e.states[0]) ?? null;
  ctx.save();
  drawUnifiedArt(ctx, e.radius || 26, e.color || '#d4a056', artDef, state, now, artPreviewTransition, artPreviewDurationOverride);
  ctx.restore();
}

function renderVfxPreview(now) {
  if (!previewCanvas || !previewCtx) return;

  const ctx = previewCtx;
  const w = previewCanvas.width;
  const h = previewCanvas.height;
  if (w === 0 || h === 0) return;

  // Clear (theme-driven — matches the art preview + the rest of the editor chrome)
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = themeColor('--ed-bg-app');
  ctx.fillRect(0, 0, w, h);

  // Camera center (with pan offset)
  const pan = previewCamera.getPan();
  const zoom = previewCamera.getZoom();
  const cx = w / 2 + pan.x;
  const cy = h / 2 + pan.y;

  // Subtle grid (follows camera)
  ctx.strokeStyle = themeColorRgba('--ed-accent-rgb', 0.04);
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();

  // Draw art preview behind VFX (apply camera transform)
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(zoom, zoom);
  drawArtPreview(ctx, now);
  ctx.restore();

  // Label (only when no effects and no art)
  if (vfxEffects.length === 0 && vfxDebris.length === 0 && artPreviewType === 'none') {
    ctx.fillStyle = themeColor('--ed-kf-text-empty');
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('VFX Preview', w / 2 + pan.x, h / 2 + pan.y + 4);
    return;
  }

  // Update physics
  const dt = vfxLastUpdate ? (now - vfxLastUpdate) / 1000 : 0;
  vfxLastUpdate = now;

  // Update effect progress
  for (const e of vfxEffects) {
    e.progress = Math.min(1, (now - e.startTime) / e.duration);
  }
  vfxEffects = vfxEffects.filter(e => e.progress < 1);

  // Update debris physics
  vfxDebris = vfxDebris.filter(d => {
    const age = now - d.startTime;
    if (age >= d.lifetime) return false;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.vx *= Math.pow(0.96, dt * 60);
    d.vy *= Math.pow(0.96, dt * 60);
    d.alpha = 1 - age / d.lifetime;
    return true;
  });

  // Draw via EffectsRenderer (guarded to prevent rendering errors from breaking the editor)
  if (effectsRenderer) {
    try {
      if (vfxEffects.length > 0) {
        effectsRenderer.drawGenericEffects(vfxEffects, now);
      }
      if (vfxDebris.length > 0) {
        effectsRenderer.drawDebris(vfxDebris.map(d => ({
          x: d.x, y: d.y, size: d.size, color: d.color, alpha: d.alpha,
        })));
      }
    } catch (err) {
      console.warn('VFX preview render error:', err.message);
    }
  }
}

// Minimal EffectsManager-shaped sink handed to FXSequenceRunner. The runner has
// already resolved the world position (offset + entity-angle rotation) and scale,
// so we just stage the effect for the preview render loop — which draws it through
// the game's EffectsRenderer. This keeps VFX positioning/lifecycle identical to the
// game while letting the runner own all the step interpretation.
function makePreviewEffectsSink() {
  return {
    addGenericEffect(vfxDef, x, y, opts = {}) {
      if (!vfxDef) return;
      const now = performance.now();
      vfxLastUpdate = now;
      vfxEffects.push({
        x, y, vfxDef, startTime: now,
        duration: vfxDef.duration, progress: 0,
        scale: opts.scale || vfxDef.defaultScale || 120,
      });
      if (vfxDef.debris) {
        for (const d of vfxDef.debris) {
          spawnVfxDebrisBurst(now, d.count, d.speed, d.lifetime, d.size, d.color, x, y);
        }
      }
    },
  };
}

// Signal handler for preview playback. Mirrors the game's onSignal (game/main.js)
// for the presentational signals the preview can honor: state changes drive the
// art preview; restartClip re-stamps the transition clock. removeEntity is a no-op
// (there is no removable entity in the single-asset preview).
function onPreviewSignal(name, data) {
  if (name === 'setState') {
    artPreviewState = data?.state ?? null;
    artPreviewDurationOverride = data?.transitionDuration;
  } else if (name === 'clearState') {
    artPreviewState = null;
    artPreviewDurationOverride = undefined;
  } else if (name === 'restartClip') {
    artPreviewTransition = { ...artPreviewTransition, startTime: performance.now() };
  }
}

function spawnVfxDebrisBurst(now, count, speed, lifetime, size, color, ox = 0, oy = 0) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const v = speed * (0.4 + Math.random() * 0.6);
    vfxDebris.push({
      x: ox, y: oy, vx: Math.cos(angle) * v, vy: Math.sin(angle) * v,
      startTime: now, lifetime,
      size: size * (0.5 + Math.random() * 0.5),
      color, alpha: 1,
    });
  }
}

// ─── Timeline Interactions ───────────────────────────────────────────────────

function setupTimelineEvents() {
  timelineCanvas.addEventListener('mousedown', (e) => {
    const rect = timelineCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Check if clicking on a step marker
    const hitStep = hitTestStep(x, y);
    if (hitStep !== null) {
      selectedStepIdx = hitStep;
      buildStepProps();
      rebuildSequenceList();

      // Start drag
      const step = workingData[selectedSeqId].steps[hitStep];
      draggingStep = hitStep;
      dragStartX = x;
      dragStartDelay = step.delay || 0;
      return;
    }

    // Click on time axis — set playhead
    if (y < TIMELINE_HEADER_HEIGHT) {
      const time = (x - TIMELINE_PADDING - timeOffset) / timeScale;
      playheadTime = Math.max(0, time);
      return;
    }

    // Shift+drag for panning
    if (e.shiftKey) {
      const startPan = timeOffset;
      const startMX = e.clientX;
      const moveHandler = (me) => {
        timeOffset = startPan + (me.clientX - startMX);
      };
      const upHandler = () => {
        window.removeEventListener('mousemove', moveHandler);
        window.removeEventListener('mouseup', upHandler);
      };
      window.addEventListener('mousemove', moveHandler);
      window.addEventListener('mouseup', upHandler);
      return;
    }

    // Deselect
    selectedStepIdx = -1;
    clearProps();
  });

  timelineCanvas.addEventListener('mousemove', (e) => {
    if (draggingStep === null) return;
    const rect = timelineCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const dx = x - dragStartX;
    const newDelay = Math.max(0, Math.round(dragStartDelay + dx / timeScale));

    const step = workingData[selectedSeqId].steps[draggingStep];
    step.delay = newDelay;
    saveManager.markDirty();
    rebuildSaveRow();
    // Re-render step props if open
    if (selectedStepIdx === draggingStep) buildStepProps();
  });

  timelineCanvas.addEventListener('mouseup', () => {
    draggingStep = null;
  });

  timelineCanvas.addEventListener('mouseleave', () => {
    draggingStep = null;
  });

  // Zoom with wheel
  timelineCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.85 : 1.15;
    timeScale = Math.max(0.05, Math.min(5, timeScale * delta));
  }, { passive: false });
}

function hitTestStep(x, y) {
  if (!selectedSeqId || !workingData[selectedSeqId]) return null;

  const steps = workingData[selectedSeqId].steps;
  const timeToX = (ms) => TIMELINE_PADDING + timeOffset + ms * timeScale;

  // Build track positions
  const trackPositions = {};
  let trackY = TIMELINE_HEADER_HEIGHT + 4;
  for (const type of TRACK_ORDER) {
    const hasSteps = steps.some(s => s.type === type);
    if (hasSteps) {
      trackPositions[type] = trackY + TIMELINE_TRACK_HEIGHT / 2;
      trackY += TIMELINE_TRACK_HEIGHT;
    }
  }

  // Check each step (reverse for z-order)
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const sx = timeToX(step.delay || 0);
    const sy = trackPositions[step.type];
    if (sy === undefined) continue;

    const dx = x - sx;
    const dy = y - sy;
    if (dx * dx + dy * dy <= (MARKER_RADIUS + 4) * (MARKER_RADIUS + 4)) {
      return i;
    }
  }

  return null;
}

// ─── Playback ────────────────────────────────────────────────────────────────

function startPlayback() {
  if (!selectedSeqId || !workingData[selectedSeqId] || !runner) return;

  stopPlayback();

  // Play from the top through the real engine runner. (The runner schedules every
  // step from t=0, so playback always starts at the beginning — the playhead is
  // reset to match.) The preview places the target at world origin, which the
  // preview camera centers; `entity` rides to signal steps just like in-game.
  isPlaying = true;
  playheadTime = 0;
  playStartReal = performance.now();
  playStartOffset = 0;

  // Clear VFX preview state
  vfxEffects = [];
  vfxDebris = [];

  soundManager.resume();
  runner.play(selectedSeqId, { x: 0, y: 0, entity: { id: 'seqPreview' } });

  // Auto-stop after the sequence completes.
  const stopDelay = getMaxDelay() + 500;
  autoStopTimer = setTimeout(() => {
    stopPlayback();
    buildControls();
  }, stopDelay);
}

function stopPlayback() {
  isPlaying = false;
  if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
  runner?.stopAll();   // stops the runner's step/repeat timers + loops (by handle)
  artPreviewState = null;
  artPreviewTransition = {};
  artPreviewDurationOverride = undefined;
}

// ─── Step CRUD ───────────────────────────────────────────────────────────────

function addStep() {
  if (!selectedSeqId) return;
  const seq = workingData[selectedSeqId];
  const newStep = { type: 'sfx', sound: getFirstSoundId(), delay: Math.round(playheadTime) };
  seq.steps.push(newStep);
  selectedStepIdx = seq.steps.length - 1;
  saveManager.markDirty();
  rebuildSaveRow();
  buildStepProps();
}

function deleteStep(idx) {
  if (!selectedSeqId) return;
  const seq = workingData[selectedSeqId];
  seq.steps.splice(idx, 1);
  if (selectedStepIdx === idx) selectedStepIdx = -1;
  else if (selectedStepIdx > idx) selectedStepIdx--;
  saveManager.markDirty();
  rebuildSaveRow();
  buildStepProps();
}

function duplicateStep(idx) {
  if (!selectedSeqId) return;
  const seq = workingData[selectedSeqId];
  const copy = JSON.parse(JSON.stringify(seq.steps[idx]));
  copy.delay = (copy.delay || 0) + 100;
  seq.steps.splice(idx + 1, 0, copy);
  selectedStepIdx = idx + 1;
  saveManager.markDirty();
  rebuildSaveRow();
  buildStepProps();
}

// ─── Properties Panel ────────────────────────────────────────────────────────

function clearProps() {
  propsEl.innerHTML = '<div style="color:var(--ed-muted);padding:20px;text-align:center;">Select a step on the timeline to edit</div>';
}

function buildStepProps() {
  propsEl.innerHTML = '';
  if (!selectedSeqId || selectedStepIdx < 0) { clearProps(); return; }

  const seq = workingData[selectedSeqId];
  const step = seq.steps[selectedStepIdx];
  if (!step) { clearProps(); return; }

  const set = (key, val) => {
    step[key] = val;
    saveManager.markDirty();
    rebuildSaveRow();
  };

  // Step header
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:8px;';
  const stepLabel = document.createElement('span');
  stepLabel.style.cssText = 'color:var(--ed-accent);font-weight:bold;font-size:12px;';
  stepLabel.textContent = `Step ${selectedStepIdx}: ${step.type}`;
  header.appendChild(stepLabel);

  const dupBtn = Button('Duplicate', () => duplicateStep(selectedStepIdx), 'subtle');
  const delBtn = Button('Delete', () => deleteStep(selectedStepIdx), 'danger');
  header.appendChild(dupBtn.el);
  header.appendChild(delBtn.el);
  propsEl.appendChild(header);

  // Type selector
  const typeSel = Select('Type', TRACK_ORDER.map(t => ({ value: t, label: TRACK_LABELS[t] })), step.type, v => {
    // Reset type-specific fields
    const delay = step.delay || 0;
    const keys = Object.keys(step);
    for (const k of keys) { if (k !== 'type' && k !== 'delay') delete step[k]; }
    step.type = v;
    step.delay = delay;

    // Set defaults for new type
    switch (v) {
      case 'sfx': step.sound = getFirstSoundId(); break;
      case 'vfx': step.effect = getFirstVfxId(); break;
      case 'loopStart': step.sound = getFirstSoundId(); step.handle = 'loop1'; step.fadeIn = 0.3; break;
      case 'loopStop': step.handle = 'loop1'; step.fadeOut = 0.3; break;
      case 'signal': step.name = 'setState'; step.data = { state: 'idle' }; break;
    }

    saveManager.markDirty();
    rebuildSaveRow();
    buildStepProps();
  });
  propsEl.appendChild(typeSel.el);

  // Delay
  const delayW = NumberSlider('Delay (ms)', 0, 5000, 10, step.delay || 0, v => set('delay', Math.round(v)));
  propsEl.appendChild(delayW.el);

  // Type-specific properties
  switch (step.type) {
    case 'sfx': buildSfxProps(step, set); break;
    case 'vfx': buildVfxProps(step, set); break;
    case 'loopStart': buildLoopStartProps(step, set); break;
    case 'loopStop': buildLoopStopProps(step, set); break;
    case 'signal': buildSignalProps(step, set); break;
  }
}

function buildSfxProps(step, set) {
  // Sound dropdown
  const soundIds = Object.keys(SOUND_CONFIG).sort();
  const soundOpts = soundIds.map(id => ({ value: id, label: `${id} (${SOUND_CONFIG[id].category})` }));
  const soundSel = Select('Sound', soundOpts, step.sound || '', v => set('sound', v));
  propsEl.appendChild(soundSel.el);

  // Preview button
  const previewBtn = Button('Preview Sound', () => {
    if (step.sound && soundManager) {
      soundManager.resume();
      soundManager.playUI(step.sound, { volume: step.volume });
    }
  }, 'subtle');
  propsEl.appendChild(previewBtn.el);

  // Volume
  const volW = NumberSlider('Volume', 0, 1, 0.05, step.volume ?? 1, v => {
    if (v === 1) delete step.volume;
    else set('volume', v);
  });
  propsEl.appendChild(volW.el);

  // Repeat
  const hasRepeat = step.repeat !== undefined;
  const repeatToggle = Toggle('Repeat', hasRepeat, v => {
    if (v) {
      step.repeat = 2;
      step.repeatDelay = 100;
    } else {
      delete step.repeat;
      delete step.repeatDelay;
    }
    saveManager.markDirty();
    rebuildSaveRow();
    buildStepProps();
  });
  propsEl.appendChild(repeatToggle.el);

  if (hasRepeat) {
    if (Array.isArray(step.repeat)) {
      const repeatGroup = PropertyGroup('Repeat Range');
      repeatGroup.addChild(NumberSlider('Min', 1, 20, 1, step.repeat[0], v => {
        step.repeat[0] = Math.round(v);
        saveManager.markDirty();
        rebuildSaveRow();
      }));
      repeatGroup.addChild(NumberSlider('Max', 1, 20, 1, step.repeat[1], v => {
        step.repeat[1] = Math.round(v);
        saveManager.markDirty();
        rebuildSaveRow();
      }));
      propsEl.appendChild(repeatGroup.el);

      const fixedBtn = Button('Use Fixed Count', () => {
        step.repeat = step.repeat[0];
        saveManager.markDirty();
        rebuildSaveRow();
        buildStepProps();
      }, 'subtle');
      propsEl.appendChild(fixedBtn.el);
    } else {
      const repeatW = NumberSlider('Repeat Count', 1, 20, 1, step.repeat, v => set('repeat', Math.round(v)));
      propsEl.appendChild(repeatW.el);

      const rangeBtn = Button('Use Random Range', () => {
        step.repeat = [step.repeat, step.repeat + 2];
        saveManager.markDirty();
        rebuildSaveRow();
        buildStepProps();
      }, 'subtle');
      propsEl.appendChild(rangeBtn.el);
    }

    const delayW = NumberSlider('Repeat Delay (ms)', 0, 1000, 10, step.repeatDelay || 0, v => set('repeatDelay', Math.round(v)));
    propsEl.appendChild(delayW.el);
  }
}

function buildVfxProps(step, set) {
  const vfxIds = Object.keys(VFX_DEFS).sort();
  const vfxOpts = vfxIds.map(id => ({ value: id, label: `${id} (${VFX_DEFS[id].type})` }));
  const vfxSel = Select('Effect', vfxOpts, step.effect || '', v => set('effect', v));
  propsEl.appendChild(vfxSel.el);

  // Preview button — fire this one step through the real runner (offset + angle
  // handled by the engine, identical to in-game placement).
  const previewBtn = Button('Preview VFX', () => {
    runner?.playStep(step, { x: 0, y: 0 });
  }, 'subtle');
  propsEl.appendChild(previewBtn.el);

  // Fixed Offset
  const hasOffset = !!step.offset;
  const offsetToggle = Toggle('Fixed Offset', hasOffset, v => {
    if (v) {
      step.offset = { x: 0, y: 0 };
    } else {
      delete step.offset;
    }
    saveManager.markDirty();
    rebuildSaveRow();
    buildStepProps();
  });
  propsEl.appendChild(offsetToggle.el);

  if (hasOffset) {
    const offsetGroup = PropertyGroup('Offset (px)');
    offsetGroup.addChild(NumberSlider('X', -200, 200, 1, step.offset.x || 0, v => {
      step.offset.x = Math.round(v);
      saveManager.markDirty();
      rebuildSaveRow();
    }));
    offsetGroup.addChild(NumberSlider('Y', -200, 200, 1, step.offset.y || 0, v => {
      step.offset.y = Math.round(v);
      saveManager.markDirty();
      rebuildSaveRow();
    }));
    propsEl.appendChild(offsetGroup.el);
  }

  // Random Offset Range
  const hasOffsetRange = !!step.offsetRange;
  const rangeToggle = Toggle('Random Offset', hasOffsetRange, v => {
    if (v) {
      step.offsetRange = { x: [-20, 20], y: [-20, 20] };
    } else {
      delete step.offsetRange;
    }
    saveManager.markDirty();
    rebuildSaveRow();
    buildStepProps();
  });
  propsEl.appendChild(rangeToggle.el);

  if (hasOffsetRange) {
    const rangeGroup = PropertyGroup('Offset Range (px)');
    rangeGroup.addChild(NumberSlider('X Min', -200, 200, 1, step.offsetRange.x?.[0] ?? -20, v => {
      if (!step.offsetRange.x) step.offsetRange.x = [-20, 20];
      step.offsetRange.x[0] = Math.round(v);
      saveManager.markDirty();
      rebuildSaveRow();
    }));
    rangeGroup.addChild(NumberSlider('X Max', -200, 200, 1, step.offsetRange.x?.[1] ?? 20, v => {
      if (!step.offsetRange.x) step.offsetRange.x = [-20, 20];
      step.offsetRange.x[1] = Math.round(v);
      saveManager.markDirty();
      rebuildSaveRow();
    }));
    rangeGroup.addChild(NumberSlider('Y Min', -200, 200, 1, step.offsetRange.y?.[0] ?? -20, v => {
      if (!step.offsetRange.y) step.offsetRange.y = [-20, 20];
      step.offsetRange.y[0] = Math.round(v);
      saveManager.markDirty();
      rebuildSaveRow();
    }));
    rangeGroup.addChild(NumberSlider('Y Max', -200, 200, 1, step.offsetRange.y?.[1] ?? 20, v => {
      if (!step.offsetRange.y) step.offsetRange.y = [-20, 20];
      step.offsetRange.y[1] = Math.round(v);
      saveManager.markDirty();
      rebuildSaveRow();
    }));
    propsEl.appendChild(rangeGroup.el);
  }
}

function buildLoopStartProps(step, set) {
  const soundIds = Object.keys(SOUND_CONFIG).sort();
  const soundOpts = soundIds.map(id => ({ value: id, label: id }));
  const soundSel = Select('Sound', soundOpts, step.sound || '', v => set('sound', v));
  propsEl.appendChild(soundSel.el);

  const handleW = TextInput('Handle', step.handle || '', v => set('handle', v));
  propsEl.appendChild(handleW.el);

  const fadeInW = NumberSlider('Fade In (s)', 0, 5, 0.1, step.fadeIn || 0, v => set('fadeIn', v));
  propsEl.appendChild(fadeInW.el);

  const volW = NumberSlider('Volume', 0, 1, 0.05, step.volume ?? 1, v => {
    if (v === 1) delete step.volume;
    else set('volume', v);
  });
  propsEl.appendChild(volW.el);
}

function buildLoopStopProps(step, set) {
  // Show handles defined by loopStart steps in this sequence
  const seq = workingData[selectedSeqId];
  const handles = seq.steps
    .filter(s => s.type === 'loopStart' && s.handle)
    .map(s => s.handle);
  const uniqueHandles = [...new Set(handles)];

  if (uniqueHandles.length > 0) {
    const handleSel = Select('Handle', uniqueHandles, step.handle || '', v => set('handle', v));
    propsEl.appendChild(handleSel.el);
  } else {
    const handleW = TextInput('Handle', step.handle || '', v => set('handle', v));
    propsEl.appendChild(handleW.el);
  }

  const fadeOutW = NumberSlider('Fade Out (s)', 0, 5, 0.1, step.fadeOut || 0, v => set('fadeOut', v));
  propsEl.appendChild(fadeOutW.el);
}

function buildSignalProps(step, set) {
  const isKnown = KNOWN_SIGNALS.some(s => s.value === step.name);
  const selValue = isKnown ? step.name : '_custom';

  const sigSel = Select('Signal', KNOWN_SIGNALS, selValue, v => {
    if (v === '_custom') {
      step.name = step.name || 'signalName';
    } else {
      step.name = v;
      // Reset data for known signals
      if (v === 'setState') {
        step.data = { state: step.data?.state || 'idle' };
      } else if (v === 'clearState' || v === 'stopAllLoops') {
        delete step.data;
      }
    }
    saveManager.markDirty();
    rebuildSaveRow();
    buildStepProps();
  });
  propsEl.appendChild(sigSel.el);

  // Type-specific fields
  switch (step.name) {
    case 'setState': {
      const stateW = TextInput('State', step.data?.state || '', v => {
        step.data = { ...step.data, state: v };
        saveManager.markDirty();
        rebuildSaveRow();
      });
      propsEl.appendChild(stateW.el);
      const durW = NumberSlider('Transition (ms)', 0, 2000, 50, step.data?.transitionDuration ?? 0, v => {
        step.data = { ...step.data, transitionDuration: v || undefined };
        saveManager.markDirty();
        rebuildSaveRow();
      });
      propsEl.appendChild(durW.el);
      break;
    }
    default: {
      // Custom or unknown — show name + raw data
      if (!isKnown) {
        const nameW = TextInput('Signal Name', step.name || '', v => set('name', v));
        propsEl.appendChild(nameW.el);
      }
      const dataW = TextInput('Data (JSON)', step.data ? JSON.stringify(step.data) : '', v => {
        if (!v) { delete step.data; saveManager.markDirty(); rebuildSaveRow(); return; }
        try { step.data = JSON.parse(v); saveManager.markDirty(); rebuildSaveRow(); } catch { /* ignore */ }
      });
      dataW.el.querySelector('input').style.fontFamily = 'monospace';
      propsEl.appendChild(dataW.el);
      break;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getFirstSoundId() {
  const ids = Object.keys(SOUND_CONFIG);
  return ids.length > 0 ? ids.sort()[0] : '';
}

function getFirstVfxId() {
  const ids = Object.keys(VFX_DEFS);
  return ids.length > 0 ? ids.sort()[0] : '';
}
