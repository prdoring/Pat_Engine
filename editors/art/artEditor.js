// Art Editor — entry point that wires all editor modules together.
// Uses drawUnifiedArt for WYSIWYG preview of any art asset.

import { ctx, FILE_DATA, normalizeArtData, getShapeAtPath, SHAPE_ICONS } from './ctx.js';
import { SaveManager, PreviewCanvas, Button, createResizer, isModalOpen, modalAlert, modalConfirm } from '/editors/shared/index.js';
import { loadManifest, getManifest } from '/editors/shared/index.js';
import { buildSidebar } from './sidebar.js';
import { buildStateBar, discoverStates } from './states.js';
import { createHistory } from './model/history.js';
import { buildSidebarShapeTree, deleteSelectedShape, duplicateSelectedShape, moveSelectedShape, mirrorSelectedShape, copySelectedShape, pasteShape } from './tree/tree.js';
import { buildShapeProps } from './props/props.js';
import { startAnimation, stopAnimation, startRenderLoop, stopRenderLoop, buildControls, setupPreviewInteraction, nudgeSelectedShape } from './preview/preview.js';
import { createArtTimeline } from './timeline.js';
import { deleteKeyframe } from './model/keyframes.js';

// ─── Mount / Unmount ─────────────────────────────────────────────────────────

export async function mount(el) {
  ctx.container = el;

  // Load art collections declared in the manifest.
  const manifest = await loadManifest();
  ctx.artCollections = manifest.artCollections;
  ctx.collections = {};
  ctx.saveManagers = {};
  await loadCollections();
  for (const col of ctx.artCollections) ensureSaveManager(col);

  // Wire cross-module callbacks
  ctx.rebuildTree = buildSidebarShapeTree;
  ctx.rebuildProps = buildShapeProps;
  ctx.rebuildStateBar = buildStateBar;
  ctx.rebuildControls = buildControls;
  ctx.clearProps = clearProps;
  ctx.markDirty = markDirty;
  ctx.rebuildSaveRow = rebuildSaveRow;
  ctx.startAnimation = startAnimation;
  ctx.stopAnimation = stopAnimation;
  ctx.historyInit = historyInit;
  ctx.reloadCollections = reloadCollections;
  ctx.rebuildTimeline = () => ctx.timeline?.refresh();

  buildUI();
  startRenderLoop();   // always-on preview repaint (independent of play/pause)
  document.addEventListener('keydown', handleEditorKeydown);
}

export function unmount() {
  stopRenderLoop();
  document.removeEventListener('keydown', handleEditorKeydown);
  ctx.container = null;
  ctx.preview = null;
}

export function save() {
  const data = FILE_DATA();
  for (const [key, sm] of Object.entries(ctx.saveManagers)) {
    if (sm.isDirty()) sm.save(data[key]);
  }
}

export function isDirty() {
  return Object.values(ctx.saveManagers).some(s => s.isDirty());
}

// ─── Keyboard Shortcuts ──────────────────────────────────────────────────────

function handleEditorKeydown(e) {
  if (!ctx.currentArt || isModalOpen()) return;

  // Undo / redo — work regardless of selection or focus (matches the music editor).
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); doRedo(); return; }

  const tag0 = document.activeElement?.tagName;
  const inField0 = tag0 === 'INPUT' || tag0 === 'TEXTAREA' || tag0 === 'SELECT';
  if (e.key === '?' && !inField0) { e.preventDefault(); showHelp(); return; }

  // Timeline transport + keyframe ops (take precedence over shape ops).
  if (e.code === 'Space' && !inField0) {
    e.preventDefault();
    if (ctx.animPlaying) stopAnimation(); else startAnimation();
    ctx.rebuildTimeline?.();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && ctx.selectedKeyframe && !inField0) {
    e.preventDefault();
    const sk = ctx.selectedKeyframe;
    const shape = getShapeAtPath(ctx.currentArt.shapes, sk.path);
    const track = shape && shape.anim && shape.anim[ctx.keyTargetClip] && shape.anim[ctx.keyTargetClip][sk.prop];
    const idx = track ? track.findIndex(k => Math.abs(k.t - sk.t) <= 1) : -1;
    if (idx >= 0) { deleteKeyframe(shape, ctx.keyTargetClip, sk.prop, idx); ctx.selectedKeyframe = null; markDirty(); ctx.rebuildTimeline?.(); }
    return;
  }

  if (!ctx.selectedShapePath || ctx.selectedShapePath.length === 0) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  if (e.key === 'Delete') {
    e.preventDefault();
    deleteSelectedShape();
  } else if (e.key === 'ArrowUp' && e.altKey) {
    e.preventDefault();
    moveSelectedShape(-1);
  } else if (e.key === 'ArrowDown' && e.altKey) {
    e.preventDefault();
    moveSelectedShape(1);
  } else if (e.key === 'd' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    duplicateSelectedShape();
  } else if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    copySelectedShape();
  } else if (e.key === 'v' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    pasteShape();
  } else if (e.key === 'm' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    mirrorSelectedShape(e.shiftKey ? 'y' : 'x');
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown')
             && !e.altKey && !e.ctrlKey && !e.metaKey) {
    // Plain arrows nudge the selected shape (Shift = ×10). Alt+arrows reorder in the tree.
    e.preventDefault();
    const step = e.shiftKey ? 0.1 : 0.01;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    nudgeSelectedShape(dx, dy);
  }
}

// ─── UI Construction ─────────────────────────────────────────────────────────

function buildUI() {
  ctx.container.innerHTML = '';
  ctx.container.style.flexDirection = 'column';
  ctx.container.style.height = '100%';

  // Top bar: save row
  const topBar = document.createElement('div');
  topBar.className = 'editor-top-bar';
  topBar.style.cssText = 'display:flex;align-items:center;padding:6px 12px;border-bottom:1px solid var(--ed-border-subtle);gap:12px;flex-shrink:0;';

  const title = document.createElement('span');
  title.style.cssText = 'color:var(--ed-accent);font-size:12px;font-weight:bold;';
  title.textContent = 'ART EDITOR';
  topBar.appendChild(title);

  // Help
  const helpBtn = Button('?', () => showHelp(), 'subtle');
  helpBtn.el.title = 'Coordinate model, icons & shortcuts';
  topBar.appendChild(helpBtn.el);

  // Undo / redo
  const undoBtn = Button('⤺', () => doUndo(), 'subtle');
  undoBtn.el.title = 'Undo (Ctrl+Z)';
  undoBtnEl = undoBtn.el;
  topBar.appendChild(undoBtn.el);
  const redoBtn = Button('⤻', () => doRedo(), 'subtle');
  redoBtn.el.title = 'Redo (Ctrl+Shift+Z / Ctrl+Y)';
  redoBtnEl = redoBtn.el;
  topBar.appendChild(redoBtn.el);
  updateUndoButtons();

  // Focus mode (collapse side panels) — wired after the columns exist.
  let focusMode = false;
  const focusBtn = Button('⛶', () => {}, 'subtle');
  focusBtn.el.title = 'Focus mode — collapse side panels';
  topBar.appendChild(focusBtn.el);

  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  topBar.appendChild(spacer);

  ctx.saveRow = document.createElement('div');
  ctx.saveRow.style.cssText = 'display:flex;gap:8px;align-items:center;';
  rebuildSaveRow();
  topBar.appendChild(ctx.saveRow);

  ctx.container.appendChild(topBar);

  // Main content: three-column layout
  const main = document.createElement('div');
  main.className = 'editor-three-col';

  // Column 1: Asset browser
  // Thin rail shown in place of the collapsed collections sidebar; click to reopen.
  const sidebarRail = document.createElement('div');
  sidebarRail.className = 'editor-collapse-rail';
  sidebarRail.style.cssText = 'display:none;width:16px;flex-shrink:0;cursor:pointer;background:rgba(var(--ed-panel-rgb),0.92);border-right:1px solid var(--ed-border-subtle);color:var(--ed-muted);font-size:11px;align-items:flex-start;justify-content:center;padding-top:8px;writing-mode:vertical-rl;';
  sidebarRail.textContent = '▸ Collections';
  sidebarRail.title = 'Show collections';
  main.appendChild(sidebarRail);

  ctx.sidebarEl = document.createElement('div');
  ctx.sidebarEl.className = 'editor-sidebar';
  ctx.sidebarEl.style.cssText = 'width:180px;display:flex;flex-direction:column;overflow:hidden;';
  main.appendChild(ctx.sidebarEl);
  const sidebarResizer = createResizer('horizontal', ctx.sidebarEl, { min: 120, max: 350 }).el;
  main.appendChild(sidebarResizer);

  // Collapse/expand the collections sidebar for more working room (the tree + canvas
  // grow into the freed space). State lives on ctx so sidebar rebuilds preserve it.
  ctx.toggleSidebar = (collapsed) => {
    ctx.sidebarCollapsed = collapsed;
    ctx.sidebarEl.style.display = collapsed ? 'none' : '';
    sidebarResizer.style.display = collapsed ? 'none' : '';
    sidebarRail.style.display = collapsed ? 'flex' : 'none';
  };
  sidebarRail.addEventListener('click', () => ctx.toggleSidebar(false));

  // Column 2: Shape tree
  ctx.treeColumnEl = document.createElement('div');
  ctx.treeColumnEl.className = 'editor-tree-col';
  ctx.treeColumnEl.style.cssText = 'width:200px;display:flex;flex-direction:column;overflow:hidden;';
  main.appendChild(ctx.treeColumnEl);
  const treeResizer = createResizer('horizontal', ctx.treeColumnEl, { min: 120, max: 400 }).el;
  main.appendChild(treeResizer);

  // Center area: state bar + preview + controls
  const center = document.createElement('div');
  center.className = 'editor-center';

  ctx.stateBarEl = document.createElement('div');
  ctx.stateBarEl.className = 'art-state-bar';
  ctx.stateBarEl.style.display = 'none';
  center.appendChild(ctx.stateBarEl);

  // Preview: a fixed-height, resizable pane. The timeline below is the column's
  // single elastic element, so this divider trades space between the two — drag it
  // up (shrink the preview) and the timeline grows to fill, with no whitespace
  // dead-zone. (Two fixed siblings in a flex column would pool the slack as a gap.)
  ctx.previewArea = document.createElement('div');
  ctx.previewArea.style.cssText = 'flex:0 1 auto;height:340px;min-height:120px;display:flex;justify-content:center;align-items:center;padding:8px;overflow:hidden;';
  center.appendChild(ctx.previewArea);
  // prop:'height' (not flexBasis) so the resizer never flips the preview to
  // flex-grow:0 — that lock is what broke the column's height distribution.
  center.appendChild(createResizer('vertical', ctx.previewArea, { min: 150, max: 680, prop: 'height' }).el);

  ctx.controlsEl = document.createElement('div');
  ctx.controlsEl.style.cssText = 'display:flex;gap:8px;padding:4px 12px;align-items:center;flex-wrap:wrap;flex-shrink:0;';
  center.appendChild(ctx.controlsEl);

  // Keyframe timeline — the elastic filler at the bottom of the center column. It
  // takes exactly the space the preview leaves; its canvas resizes to fill, and a
  // tall track list scrolls internally rather than overflowing or clipping.
  const timelineHost = document.createElement('div');
  timelineHost.style.cssText = 'flex:1 1 0;min-height:0;display:flex;flex-direction:column;overflow:hidden;';
  center.appendChild(timelineHost);
  ctx.timeline = createArtTimeline(timelineHost);

  main.appendChild(center);

  // Properties panel (right column) — resizer before it, inverted drag
  ctx.propsEl = document.createElement('div');
  ctx.propsEl.className = 'editor-right-panel';
  const propsResizer = createResizer('horizontal', ctx.propsEl, { min: 200, max: 600, invert: true }).el;
  main.appendChild(propsResizer);
  main.appendChild(ctx.propsEl);

  // Focus mode: collapse the side columns so the preview dominates.
  const sidePanels = [ctx.sidebarEl, sidebarResizer, ctx.treeColumnEl, treeResizer, propsResizer, ctx.propsEl];
  focusBtn.el.addEventListener('click', () => {
    focusMode = !focusMode;
    for (const el of sidePanels) el.style.display = focusMode ? 'none' : '';
    focusBtn.el.style.color = focusMode ? 'var(--ed-accent)' : '';
  });

  ctx.container.appendChild(main);

  // Build preview canvas
  ctx.preview = new PreviewCanvas(ctx.previewArea, {
    background: '--ed-bg-app',
    grid: ctx.showGrid,
    pannable: true,
    zoomable: true,
    fillContainer: true,
  });
  ctx.preview.setZoom(1);
  setupPreviewInteraction();

  buildSidebar();
  buildControls();
}

// ─── Save & Dirty Tracking ───────────────────────────────────────────────────

function rebuildSaveRow() {
  if (!ctx.saveRow) return;
  ctx.saveRow.innerHTML = '';
  const data = FILE_DATA();
  for (const [key, sm] of Object.entries(ctx.saveManagers)) {
    if (sm.isDirty()) {
      const btn = sm.getSaveButton(() => {
        sm.save(data[key]);
        rebuildSaveRow();
      });
      ctx.saveRow.appendChild(btn);
    }
  }
  const anyDirty = Object.values(ctx.saveManagers).some(s => s.isDirty());
  if (anyDirty) {
    const revertBtn = Button('Revert All', async () => {
      if (!(await modalConfirm('Revert all unsaved changes? This will reload from disk.', { title: 'Revert all', confirmLabel: 'Revert', danger: true }))) return;
      await revertAll();
    }, 'subtle');
    revertBtn.el.style.cssText += 'color:var(--ed-danger);border-color:rgba(var(--ed-danger-rgb),0.27);';
    ctx.saveRow.appendChild(revertBtn.el);
  }
  const indicator = document.createElement('span');
  indicator.style.cssText = 'color:var(--ed-faint);font-size:11px;';
  const dirty = Object.entries(ctx.saveManagers).filter(([, s]) => s.isDirty()).map(([k]) => k);
  indicator.textContent = dirty.length ? `Unsaved: ${dirty.join(', ')}` : '';
  ctx.saveRow.appendChild(indicator);
}

/** Load (or reload) every collection's file data into ctx.collections. */
async function loadCollections() {
  await Promise.all(ctx.artCollections.map(async col => {
    const data = await fetch(`/data/${col.file}?t=${Date.now()}`).then(r => r.json()).catch(() => ({}));
    const cloned = JSON.parse(JSON.stringify(data));
    normalizeArtData(cloned); // children → shapes; warn on legacy animator data
    ctx.collections[col.id] = cloned;
  }));
}

/** Create + wire a SaveManager for a collection if it doesn't have one. */
function ensureSaveManager(col) {
  if (ctx.saveManagers[col.id]) return;
  const sm = new SaveManager(col.file);
  sm.onDirtyChange(() => {
    const anyDirty = Object.values(ctx.saveManagers).some(s => s.isDirty());
    window.editorSetUnsaved?.('art', anyDirty);
  });
  ctx.saveManagers[col.id] = sm;
}

/** Re-sync collections after a server-side collection create/rename/delete. */
async function reloadCollections(newManifest) {
  if (newManifest?.artCollections) ctx.artCollections = newManifest.artCollections;
  // Drop the open selection if its collection is gone.
  if (ctx.currentFileKey && !ctx.artCollections.some(c => c.id === ctx.currentFileKey)) {
    ctx.currentArt = null; ctx.currentFileKey = null; ctx.currentLabel = '';
    ctx.selectedShapePath = null;
  }
  await loadCollections();
  for (const col of ctx.artCollections) ensureSaveManager(col);
  buildSidebar();
  ctx.rebuildStateBar();
  ctx.rebuildControls();
  ctx.rebuildTree();
  ctx.rebuildProps();
}

async function revertAll() {
  await loadCollections();
  for (const sm of Object.values(ctx.saveManagers)) sm.markClean();
  // Reloaded file data replaces the asset objects, so the open selection is stale.
  histories.clear();
  activeHistory = null;
  ctx.currentArt = null;
  ctx.currentFileKey = null;
  ctx.currentLabel = '';
  ctx.selectedShapePath = null;
  ctx.discoveredStates = [];
  ctx.previewState = null;
  buildSidebar();
  ctx.rebuildStateBar();
  ctx.rebuildControls();
  ctx.rebuildTree();
  ctx.clearProps();
  rebuildSaveRow();
  updateUndoButtons();
}

function markDirty() {
  if (!ctx.currentFileKey) return;
  ctx.saveManagers[ctx.currentFileKey].markDirty();
  rebuildSaveRow();
  scheduleCommit();
  // No renderPreview() needed: the always-on render loop (startRenderLoop) repaints
  // every frame, so edits/drags/undo show up on their own. Don't reintroduce manual
  // paint triggers here — that's the stale-preview foot-gun this architecture removed.
}

function clearProps() {
  if (ctx.propsEl) ctx.propsEl.innerHTML = '';
}

function showHelp() {
  const icons = Object.entries(SHAPE_ICONS).map(([t, g]) => `  ${g}  ${t}`).join('\n');
  const text =
`COORDINATE MODEL  (a value is a number, an object, or "…Abs")
  0.5            →  0.5 × radius  (r-relative; the default)
  { r: 0.5 }     →  same, in object form
  { w: 1, h: 1 } →  coefficients of the space width / height
  base: 18       →  absolute pixels, NOT scaled by radius
  radiusAbs      →  absolute-pixel radius
  { breathe: 6 } →  6 × the 'breathe' animator value × radius

SHAPE ICONS
${icons}

KEYBOARD
  Ctrl+Z / Ctrl+Shift+Z   Undo / Redo (Ctrl+Y also redoes)
  Delete                  Delete selected shape
  Ctrl+D                  Duplicate
  Ctrl+M / Ctrl+Shift+M   Mirror X / Y
  Arrow keys              Nudge selected shape (Shift = ×10)
  Alt + Arrows            Reorder in the tree
  Click a shape on canvas Select it · drag to move · drag the ring to rotate`;
  modalAlert(text, { title: 'Art editor help' });
}

// ─── Undo / Redo history ─────────────────────────────────────────────────────
// Per-asset snapshot history. markDirty() schedules a debounced commit, so a
// continuous edit (a slider or drag burst) collapses into one undo step while
// discrete ops settle into their own. Restores deep-assign into ctx.currentArt
// IN PLACE — never reassign the reference, since the sidebar/collection map hold
// the same object and save() reads from the collection map.

const histories = new Map();   // assetKey → history instance
let activeHistory = null;
let restoring = false;
let commitTimer = null;
let undoBtnEl = null, redoBtnEl = null;

function assetKey() {
  return ctx.currentFileKey && ctx.currentLabel ? `${ctx.currentFileKey}.${ctx.currentLabel}` : null;
}

function snapshot() {
  return {
    art: JSON.parse(JSON.stringify(ctx.currentArt)),
    sel: ctx.selectedShapePath ? [...ctx.selectedShapePath] : null,
    editState: ctx.currentEditState,
    expanded: [...ctx.expandedPaths],
  };
}

/** Get-or-create the history for the freshly-selected asset. */
function historyInit() {
  const key = assetKey();
  if (!key || !ctx.currentArt) { activeHistory = null; updateUndoButtons(); return; }
  if (!histories.has(key)) {
    const h = createHistory();
    h.init(snapshot());
    histories.set(key, h);
  }
  activeHistory = histories.get(key);
  updateUndoButtons();
}

function scheduleCommit() {
  if (restoring || !activeHistory) return;
  clearTimeout(commitTimer);
  commitTimer = setTimeout(commitHistory, 300);
}

function commitHistory() {
  clearTimeout(commitTimer); commitTimer = null;
  if (restoring || !activeHistory || !ctx.currentArt) return;
  if (activeHistory.push(snapshot())) updateUndoButtons();
}

function restoreSnapshot(snap) {
  if (!snap || !ctx.currentArt) return;
  restoring = true;
  const target = ctx.currentArt;
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, JSON.parse(JSON.stringify(snap.art)));
  ctx.currentEditState = snap.editState || 'BASE';
  ctx.expandedPaths = new Set(snap.expanded || []);
  ctx.discoveredStates = discoverStates(ctx.currentArt);
  // Clamp a possibly-stale selection path to one that still exists.
  ctx.selectedShapePath = (snap.sel && getShapeAtPath(ctx.currentArt.shapes, snap.sel)) ? snap.sel : null;
  // The restored asset may have dropped the keyed clip / keyframe under the cursor.
  ctx.selectedKeyframe = null;
  if (ctx.keyTargetClip !== '*' && !ctx.discoveredStates.includes(ctx.keyTargetClip)) ctx.keyTargetClip = '*';
  ctx.rebuildStateBar();
  ctx.rebuildControls();
  ctx.rebuildTree();
  if (ctx.selectedShapePath) ctx.rebuildProps(); else ctx.clearProps();
  ctx.rebuildTimeline?.();
  restoring = false;
}

function doUndo() {
  if (!activeHistory) return;
  commitHistory();              // finalize any pending edit first
  const snap = activeHistory.undo();
  if (!snap) { updateUndoButtons(); return; }
  restoreSnapshot(snap);
  markCurrentDirty();
  updateUndoButtons();
}

function doRedo() {
  if (!activeHistory) return;
  const snap = activeHistory.redo();
  if (!snap) return;
  restoreSnapshot(snap);
  markCurrentDirty();
  updateUndoButtons();
}

function markCurrentDirty() {
  if (!ctx.currentFileKey) return;
  ctx.saveManagers[ctx.currentFileKey]?.markDirty();
  rebuildSaveRow();
}

function updateUndoButtons() {
  if (undoBtnEl) undoBtnEl.disabled = !(activeHistory && activeHistory.canUndo());
  if (redoBtnEl) redoBtnEl.disabled = !(activeHistory && activeHistory.canRedo());
}
