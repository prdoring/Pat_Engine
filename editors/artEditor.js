// Art Editor — entry point that wires all editor modules together.
// Uses drawUnifiedArt for WYSIWYG preview of any art asset.

import { ctx, FILE_DATA, normalizeArtData } from './artEditorCtx.js';
import { SaveManager, PreviewCanvas, Button, createResizer } from './editorShared.js';
import { loadManifest, getManifest } from './editorManifest.js';
import { buildSidebar } from './artEditorSidebar.js';
import { buildStateBar } from './artEditorStates.js';
import { buildSidebarShapeTree, deleteSelectedShape, duplicateSelectedShape, moveSelectedShape, mirrorSelectedShape } from './artEditorTree.js';
import { buildShapeProps } from './artEditorProps.js';
import { startAnimation, stopAnimation, buildControls, setupPreviewInteraction } from './artEditorPreview.js';

// ─── Mount / Unmount ─────────────────────────────────────────────────────────

export async function mount(el) {
  ctx.container = el;

  // Load art collections declared in the manifest.
  const manifest = await loadManifest();
  ctx.artCollections = manifest.artCollections;
  ctx.collections = {};
  ctx.saveManagers = {};
  await loadCollections();
  for (const col of ctx.artCollections) {
    ctx.saveManagers[col.id] = new SaveManager(col.file);
  }
  for (const [, sm] of Object.entries(ctx.saveManagers)) {
    sm.onDirtyChange(() => {
      const anyDirty = Object.values(ctx.saveManagers).some(s => s.isDirty());
      window.editorSetUnsaved?.('art', anyDirty);
    });
  }

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

  buildUI();
  startAnimation();
  document.addEventListener('keydown', handleEditorKeydown);
}

export function unmount() {
  stopAnimation();
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
  if (!ctx.currentArt || !ctx.selectedShapePath || ctx.selectedShapePath.length === 0) return;

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
  } else if (e.key === 'm' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    mirrorSelectedShape(e.shiftKey ? 'y' : 'x');
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
  topBar.style.cssText = 'display:flex;align-items:center;padding:6px 12px;border-bottom:1px solid #2a2a3a;gap:12px;flex-shrink:0;';

  const title = document.createElement('span');
  title.style.cssText = 'color:#d4a056;font-size:12px;font-weight:bold;';
  title.textContent = 'ART EDITOR';
  topBar.appendChild(title);

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
  ctx.sidebarEl = document.createElement('div');
  ctx.sidebarEl.className = 'editor-sidebar';
  ctx.sidebarEl.style.cssText = 'width:180px;display:flex;flex-direction:column;overflow:hidden;';
  main.appendChild(ctx.sidebarEl);
  main.appendChild(createResizer('horizontal', ctx.sidebarEl, { min: 120, max: 350 }).el);

  // Column 2: Shape tree
  ctx.treeColumnEl = document.createElement('div');
  ctx.treeColumnEl.className = 'editor-tree-col';
  ctx.treeColumnEl.style.cssText = 'width:200px;display:flex;flex-direction:column;overflow:hidden;';
  main.appendChild(ctx.treeColumnEl);
  main.appendChild(createResizer('horizontal', ctx.treeColumnEl, { min: 120, max: 400 }).el);

  // Center area: state bar + preview + controls
  const center = document.createElement('div');
  center.className = 'editor-center';

  ctx.stateBarEl = document.createElement('div');
  ctx.stateBarEl.className = 'art-state-bar';
  ctx.stateBarEl.style.display = 'none';
  center.appendChild(ctx.stateBarEl);

  ctx.previewArea = document.createElement('div');
  ctx.previewArea.style.cssText = 'flex:1 1 320px;min-height:0;display:flex;justify-content:center;align-items:center;padding:8px;overflow:hidden;';
  center.appendChild(ctx.previewArea);
  center.appendChild(createResizer('vertical', ctx.previewArea, { min: 150, max: 600, prop: 'flexBasis' }).el);

  ctx.controlsEl = document.createElement('div');
  ctx.controlsEl.style.cssText = 'display:flex;gap:8px;padding:4px 12px;align-items:center;flex-wrap:wrap;flex-shrink:0;';
  center.appendChild(ctx.controlsEl);

  main.appendChild(center);

  // Properties panel (right column) — resizer before it, inverted drag
  ctx.propsEl = document.createElement('div');
  ctx.propsEl.className = 'editor-right-panel';
  main.appendChild(createResizer('horizontal', ctx.propsEl, { min: 200, max: 600, invert: true }).el);
  main.appendChild(ctx.propsEl);

  ctx.container.appendChild(main);

  // Build preview canvas
  ctx.preview = new PreviewCanvas(ctx.previewArea, {
    background: '#060d18',
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
      if (!confirm('Revert all unsaved changes? This will reload from disk.')) return;
      await revertAll();
    }, 'subtle');
    revertBtn.el.style.cssText += 'color:#cc4422;border-color:#cc442244;';
    ctx.saveRow.appendChild(revertBtn.el);
  }
  const indicator = document.createElement('span');
  indicator.style.cssText = 'color:#5a4a30;font-size:11px;';
  const dirty = Object.entries(ctx.saveManagers).filter(([, s]) => s.isDirty()).map(([k]) => k);
  indicator.textContent = dirty.length ? `Unsaved: ${dirty.join(', ')}` : '';
  ctx.saveRow.appendChild(indicator);
}

/** Load (or reload) every manifest collection's file data into ctx.collections. */
async function loadCollections() {
  await Promise.all((getManifest()?.artCollections || ctx.artCollections).map(async col => {
    const data = await fetch(`/data/${col.file}`).then(r => r.json());
    const cloned = JSON.parse(JSON.stringify(data));
    normalizeArtData(cloned); // group+animators → standalone types for editing
    ctx.collections[col.id] = cloned;
  }));
}

async function revertAll() {
  await loadCollections();
  for (const sm of Object.values(ctx.saveManagers)) sm.markClean();
  ctx.selectedShapePath = null;
  ctx.clearProps();
  ctx.rebuildTree();
  rebuildSaveRow();
}

function markDirty() {
  if (!ctx.currentFileKey) return;
  ctx.saveManagers[ctx.currentFileKey].markDirty();
  rebuildSaveRow();
}

function clearProps() {
  if (ctx.propsEl) ctx.propsEl.innerHTML = '';
}
