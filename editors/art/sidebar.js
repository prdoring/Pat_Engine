// Asset browser sidebar for the art editor.
// Builds the left sidebar with art asset categories and handles selection +
// asset CRUD (new / rename / duplicate / delete). Asset operations live in the
// DOM-free model/assetOps.js so they stay unit-testable; this file is the DOM shell.

import { ctx } from './ctx.js';
import { discoverStates } from './states.js';
import { startAnimation } from './preview/preview.js';
import { modalPrompt, modalConfirm, modalAlert } from '/editors/shared/index.js';
import {
  getAssetsMap, validateAssetId, newAssetTemplate,
  addAsset, duplicateAsset, deleteAsset, renameAsset,
} from './model/assetOps.js';

// ─── Sidebar ─────────────────────────────────────────────────────────────────

/** Build the asset browser sidebar with all art file sections. */
export function buildSidebar() {
  ctx.sidebarEl.innerHTML = '';

  // Top toolbar: create a new collection (folder).
  const topBar = document.createElement('div');
  topBar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:4px;padding:2px 0 4px;border-bottom:1px solid var(--ed-border-subtle);margin-bottom:4px;';
  const collapseBtn = document.createElement('button');
  collapseBtn.textContent = '‹';
  collapseBtn.title = 'Collapse collections sidebar';
  collapseBtn.style.cssText = 'padding:0 5px;font-size:13px;line-height:1;color:var(--ed-muted);background:transparent;border:1px solid var(--ed-border-subtle2);border-radius:3px;cursor:pointer;';
  collapseBtn.addEventListener('click', () => ctx.toggleSidebar?.(true));
  topBar.appendChild(collapseBtn);
  const topLabel = document.createElement('span');
  topLabel.textContent = 'COLLECTIONS';
  topLabel.style.cssText = 'color:var(--ed-muted);font-size:10px;font-weight:bold;letter-spacing:0.5px;flex:1;';
  topBar.appendChild(topLabel);
  const addColBtn = document.createElement('button');
  addColBtn.textContent = '+ Folder';
  addColBtn.title = 'Create a new art collection';
  addColBtn.style.cssText = 'padding:1px 6px;font-size:10px;color:var(--ed-accent);background:var(--ed-btn-warm);border:1px solid var(--ed-border);border-radius:3px;cursor:pointer;';
  addColBtn.addEventListener('click', handleNewCollection);
  topBar.appendChild(addColBtn);
  ctx.sidebarEl.appendChild(topBar);

  const assetBrowser = document.createElement('div');
  assetBrowser.style.cssText = 'overflow-y:auto;flex:1;';

  // One section per manifest art collection. Assets live under the collection's
  // `collectionKey` (the engine's standard nested art-file shape), or at the top
  // level if no key is given.
  for (const col of ctx.artCollections) {
    const fileData = ctx.collections[col.id];
    if (!fileData) continue;
    addSidebarSection(assetBrowser, col, getAssetsMap(fileData, col.collectionKey));
  }

  ctx.sidebarEl.appendChild(assetBrowser);

  // Re-apply the selection highlight after any rebuild.
  if (ctx.currentFileKey && ctx.currentLabel) {
    highlightAssetRow(`${ctx.currentFileKey}.${ctx.currentLabel}`);
  }

  // Shape tree container (in its own column)
  if (ctx.treeColumnEl) ctx.treeColumnEl.innerHTML = '';
  const treeContainer = document.createElement('div');
  treeContainer.id = 'shape-tree-container';
  treeContainer.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;';
  (ctx.treeColumnEl || ctx.sidebarEl).appendChild(treeContainer);
}

function addSidebarSection(parent, col, assets) {
  const section = document.createElement('div');
  section.style.cssText = 'margin-bottom:8px;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:6px;color:var(--ed-accent);font-size:11px;font-weight:bold;padding:4px 0;border-bottom:1px solid var(--ed-border-subtle);margin-bottom:2px;';
  const headerLabel = document.createElement('span');
  headerLabel.textContent = col.label || col.id;
  headerLabel.style.flex = '1';
  header.appendChild(headerLabel);
  const newBtn = document.createElement('button');
  newBtn.className = 'editor-btn';
  newBtn.textContent = '+ New';
  newBtn.title = `Add a new ${col.label || col.id} asset`;
  newBtn.style.cssText = 'padding:1px 6px;font-size:10px;color:var(--ed-accent);background:var(--ed-btn-warm);border:1px solid var(--ed-border);border-radius:3px;cursor:pointer;';
  newBtn.addEventListener('click', () => handleNewAsset(col));
  header.appendChild(newBtn);
  header.appendChild(actionBtn('✎', 'Rename collection', () => handleRenameCollection(col)));
  header.appendChild(actionBtn('×', 'Remove collection (file kept on disk)', () => handleDeleteCollection(col)));
  section.appendChild(header);

  for (const key of Object.keys(assets)) {
    section.appendChild(buildAssetRow(col, key, assets[key]));
  }

  parent.appendChild(section);
}

function buildAssetRow(col, key, asset) {
  const row = document.createElement('div');
  row.className = 'editor-sidebar-item';
  row.style.cssText = 'display:flex;align-items:center;gap:4px;padding:2px 8px;cursor:pointer;color:var(--ed-muted2);font-size:11px;border-radius:3px;';
  row.dataset.key = `${col.id}.${key}`;

  const isSelected = () => ctx.currentFileKey === col.id && ctx.currentLabel === key;

  const label = document.createElement('span');
  label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  label.textContent = asset?.name || key;
  row.appendChild(label);

  // Hover-revealed per-asset actions.
  const actions = document.createElement('span');
  actions.style.cssText = 'display:none;gap:2px;flex-shrink:0;';
  actions.appendChild(actionBtn('✎', 'Rename', () => handleRenameAsset(col, key)));
  actions.appendChild(actionBtn('⧉', 'Duplicate', () => handleDuplicateAsset(col, key)));
  actions.appendChild(actionBtn('×', 'Delete', () => handleDeleteAsset(col, key)));
  row.appendChild(actions);

  row.addEventListener('click', () => {
    selectAssetRow(row);
    selectAsset(col.id, asset, key);
  });
  row.addEventListener('mouseenter', () => {
    actions.style.display = 'flex';
    if (!isSelected()) row.style.background = 'var(--ed-surface)';
  });
  row.addEventListener('mouseleave', () => {
    actions.style.display = 'none';
    if (!isSelected()) row.style.background = '';
  });

  return row;
}

function actionBtn(glyph, title, fn) {
  const b = document.createElement('button');
  b.textContent = glyph;
  b.title = title;
  b.style.cssText = 'background:none;border:none;color:var(--ed-muted2);cursor:pointer;font-size:11px;padding:0 2px;line-height:1;';
  b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
  b.addEventListener('mouseenter', () => { b.style.color = 'var(--ed-accent)'; });
  b.addEventListener('mouseleave', () => { b.style.color = 'var(--ed-muted2)'; });
  return b;
}

function selectAssetRow(row) {
  ctx.sidebarEl.querySelectorAll('.editor-sidebar-item').forEach(el => {
    el.style.background = '';
    el.style.color = 'var(--ed-muted2)';
  });
  row.style.background = 'var(--ed-surface-sel)';
  row.style.color = 'var(--ed-accent)';
}

function highlightAssetRow(key) {
  const row = ctx.sidebarEl?.querySelector(`.editor-sidebar-item[data-key="${key}"]`);
  if (row) selectAssetRow(row);
}

// ─── Asset CRUD ──────────────────────────────────────────────────────────────

function markCollectionDirty(colId) {
  ctx.saveManagers?.[colId]?.markDirty();
  ctx.rebuildSaveRow?.();
}

// ─── Collection (folder) management ──────────────────────────────────────────

async function manageCollection(action, id, label) {
  let resp;
  try {
    resp = await fetch('/api/manage-collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, id, label }),
    }).then(r => r.json());
  } catch (e) {
    await modalAlert('Collection request failed: ' + e.message);
    return;
  }
  if (!resp || !resp.ok) {
    await modalAlert(resp?.error || 'Collection request failed.');
    return;
  }
  await ctx.reloadCollections?.(resp.manifest);
}

async function handleNewCollection() {
  const id = await modalPrompt('New collection id (lowercase; becomes <id>-art.json):', {
    title: 'New collection',
    placeholder: 'e.g. enemies',
    confirmLabel: 'Create',
    validate: (v) => {
      if (!v) return 'Enter an id';
      if (!/^[a-z][a-z0-9_]*$/.test(v)) return 'Lowercase letters, digits, underscore; start with a letter';
      if (ctx.artCollections.some(c => c.id === v)) return `"${v}" already exists`;
      return null;
    },
  });
  if (!id) return;
  await manageCollection('create', id);
}

async function handleRenameCollection(col) {
  const label = await modalPrompt('Collection display name:', {
    title: `Rename "${col.label || col.id}"`,
    value: col.label || col.id,
    confirmLabel: 'Rename',
    validate: (v) => (v ? null : 'Enter a name'),
  });
  if (!label || label === col.label) return;
  await manageCollection('rename', col.id, label);
}

async function handleDeleteCollection(col) {
  const ok = await modalConfirm(
    `Remove the "${col.label || col.id}" collection from the editor? Its file (${col.file}) stays on disk and can be re-added.`,
    { title: 'Remove collection', confirmLabel: 'Remove', danger: true },
  );
  if (!ok) return;
  await manageCollection('delete', col.id);
}

/** Rebuild the sidebar and select the asset `key` in collection `col`. */
function refreshAndSelect(col, key) {
  buildSidebar();
  const asset = getAssetsMap(ctx.collections[col.id], col.collectionKey)[key];
  if (asset) {
    selectAsset(col.id, asset, key);
    highlightAssetRow(`${col.id}.${key}`);
  }
}

async function handleNewAsset(col) {
  const fileData = ctx.collections[col.id];
  const id = await modalPrompt('New asset id — used in code & the manifest (its display name is editable later):', {
    title: `New ${col.label || col.id} asset`,
    placeholder: 'e.g. sprout',
    confirmLabel: 'Create',
    validate: (v) => validateAssetId(fileData, col.collectionKey, v),
  });
  if (!id) return;
  addAsset(fileData, col.collectionKey, id, newAssetTemplate(id));
  markCollectionDirty(col.id);
  refreshAndSelect(col, id);
}

async function handleRenameAsset(col, key) {
  const fileData = ctx.collections[col.id];
  const id = await modalPrompt('Rename asset id (the id that code & the manifest reference):', {
    title: `Rename "${key}"`,
    value: key,
    confirmLabel: 'Rename',
    validate: (v) => validateAssetId(fileData, col.collectionKey, v, { ignore: key }),
  });
  if (!id || id === key) return;
  renameAsset(fileData, col.collectionKey, key, id);
  markCollectionDirty(col.id);
  refreshAndSelect(col, id);
}

async function handleDuplicateAsset(col, key) {
  const fileData = ctx.collections[col.id];
  const id = await modalPrompt('Duplicate as:', {
    title: `Duplicate "${key}"`,
    value: `${key}Copy`,
    confirmLabel: 'Duplicate',
    validate: (v) => validateAssetId(fileData, col.collectionKey, v),
  });
  if (!id) return;
  duplicateAsset(fileData, col.collectionKey, key, id);
  markCollectionDirty(col.id);
  refreshAndSelect(col, id);
}

async function handleDeleteAsset(col, key) {
  const ok = await modalConfirm(`Delete asset "${key}"? You can still recover it with Revert All until you save.`, {
    title: 'Delete asset',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  deleteAsset(ctx.collections[col.id], col.collectionKey, key);
  markCollectionDirty(col.id);
  if (ctx.currentFileKey === col.id && ctx.currentLabel === key) {
    // The deleted asset was open — clear the editor panes.
    ctx.currentArt = null;
    ctx.currentFileKey = null;
    ctx.currentLabel = '';
    ctx.selectedShapePath = null;
    ctx.discoveredStates = [];
    ctx.previewState = null;
    ctx.rebuildStateBar();
    ctx.rebuildControls();
    ctx.rebuildTree();
    ctx.clearProps();
    ctx.historyInit?.();
  }
  buildSidebar();
}

/** Check if an art definition contains any particle shapes (recursively). */
function _hasParticles(artDef) {
  if (!artDef || !artDef.shapes) return false;
  const check = (shapes) => {
    for (const s of shapes) {
      if (s.type === 'particles') return true;
      if (s.shapes && check(s.shapes)) return true;
      if (s.children && check(s.children)) return true;
    }
    return false;
  };
  return check(artDef.shapes);
}

// ─── Selection ───────────────────────────────────────────────────────────────

function selectAsset(fileKey, artDef, label) {
  ctx.currentArt = artDef;
  ctx.currentFileKey = fileKey;
  ctx.currentLabel = label;
  ctx.selectedShapePath = null;
  ctx.hoveredShapePath = null;
  ctx.expandedPaths = new Set();
  ctx.editorHidden.clear();
  ctx.editorLocked.clear();
  ctx.editorSolo = null;
  ctx.currentEditState = 'BASE';
  ctx.previewTransition = { currentState: null, prevState: null, startTime: 0 };
  // Reset the keyframe timeline for the freshly-opened asset.
  ctx.playhead = 0;
  ctx.keyTargetClip = '*';
  ctx.selectedKeyframe = null;

  if (artDef) {
    ctx.discoveredStates = discoverStates(artDef);
    // Preview a representative non-base state (so state-gated shapes/particles show),
    // but EDIT in BASE by default — otherwise every edit silently becomes a state
    // override. The state bar lets the user opt into editing a specific state.
    ctx.previewState = ctx.discoveredStates.length > 1
      ? (ctx.discoveredStates.find(s => s !== 'BASE') || null)
      : null;
    ctx.currentEditState = 'BASE';
    // Auto-start animation if the asset has particles (strips need dc.now for rotation)
    if (!ctx.animPlaying && _hasParticles(artDef)) {
      startAnimation();
    }
  } else {
    ctx.discoveredStates = [];
    ctx.previewState = null;
  }

  ctx.rebuildStateBar();
  ctx.rebuildControls();
  ctx.rebuildTree();
  ctx.rebuildProps();   // no shape selected → shows the asset-level panel
  ctx.rebuildTimeline?.();
  ctx.historyInit?.();
  // No manual repaint: the always-on render loop draws the freshly-opened asset next frame.
}
