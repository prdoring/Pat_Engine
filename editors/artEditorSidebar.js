// Asset browser sidebar for the art editor.
// Builds the left sidebar with art asset categories and handles selection.

import { ctx } from './artEditorCtx.js';
import { discoverStates } from './artEditorStates.js';
import { startAnimation } from './artEditorPreview.js';

// ─── Sidebar ─────────────────────────────────────────────────────────────────

/** Build the asset browser sidebar with all art file sections. */
export function buildSidebar() {
  ctx.sidebarEl.innerHTML = '';

  const assetBrowser = document.createElement('div');
  assetBrowser.style.cssText = 'overflow-y:auto;flex:1;';

  // One section per manifest art collection. Assets live under the collection's
  // `collectionKey` (the engine's standard nested art-file shape), or at the top
  // level if no key is given.
  for (const col of ctx.artCollections) {
    const fileData = ctx.collections[col.id];
    if (!fileData) continue;
    const assets = (col.collectionKey && fileData[col.collectionKey]) || fileData;
    addSidebarSection(assetBrowser, col.label || col.id, Object.keys(assets).map(key => ({
      label: assets[key]?.name || key, key: `${col.id}.${key}`,
      onClick: () => selectAsset(col.id, assets[key], key),
    })));
  }

  ctx.sidebarEl.appendChild(assetBrowser);

  // Shape tree container (in its own column)
  if (ctx.treeColumnEl) ctx.treeColumnEl.innerHTML = '';
  const treeContainer = document.createElement('div');
  treeContainer.id = 'shape-tree-container';
  treeContainer.style.cssText = 'display:flex;flex-direction:column;flex:1;overflow:hidden;';
  (ctx.treeColumnEl || ctx.sidebarEl).appendChild(treeContainer);
}

function addSidebarSection(parent, title, items) {
  const section = document.createElement('div');
  section.style.cssText = 'margin-bottom:8px;';

  const header = document.createElement('div');
  header.style.cssText = 'color:#d4a056;font-size:11px;font-weight:bold;padding:4px 0;border-bottom:1px solid #2a2a3a;margin-bottom:2px;';
  header.textContent = title;
  section.appendChild(header);

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'editor-sidebar-item';
    row.style.cssText = 'padding:2px 8px;cursor:pointer;color:#8a7a5a;font-size:11px;border-radius:3px;';
    row.textContent = item.label;
    row.dataset.key = item.key;
    row.addEventListener('click', () => {
      ctx.sidebarEl.querySelectorAll('.editor-sidebar-item').forEach(el => {
        el.style.background = '';
        el.style.color = '#8a7a5a';
      });
      row.style.background = '#2a2a3a';
      row.style.color = '#d4a056';
      item.onClick();
    });
    row.addEventListener('mouseenter', () => {
      if (row.style.background !== 'rgb(42, 42, 58)') row.style.background = '#1a1a2a';
    });
    row.addEventListener('mouseleave', () => {
      if (row.style.background !== 'rgb(42, 42, 58)') row.style.background = '';
    });
    section.appendChild(row);
  }

  parent.appendChild(section);
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
  ctx.currentEditState = 'BASE';
  ctx.previewTransition = { currentState: null, prevState: null, startTime: 0 };

  if (artDef) {
    ctx.discoveredStates = discoverStates(artDef);
    // Auto-select first non-base state if the asset has states (so particles with state overrides show)
    if (ctx.discoveredStates.length > 1) {
      const firstState = ctx.discoveredStates.find(s => s !== 'BASE') || null;
      ctx.previewState = firstState;
      ctx.currentEditState = firstState || 'BASE';
    } else {
      ctx.previewState = null;
    }
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
  ctx.clearProps();
}
