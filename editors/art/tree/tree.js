// Shape tree UI and shape operations for the art editor.
// Builds the sidebar shape tree and handles add/delete/move/wrap/unwrap.
// Mirroring lives in ./mirror.js, the drag-and-drop lifecycle in ./treeDragDrop.js,
// and the add/wrap/move-into inline dialogs in ./treeDialogs.js.

import { ctx, pathToKey, getShapeAtPath, getParentShapesAtPath, shapeHasStateRef, SHAPE_ICONS, CONTAINER_TYPES } from '../ctx.js';
import { Button, modalPrompt, modalConfirm } from '/editors/shared/index.js';
import { showAddShapeDialog, showWrapDialog, showMoveIntoDialog } from './treeDialogs.js';
import { mirrorSelectedShape } from './mirror.js';
import { attachShapeDrag, isDragging } from './treeDragDrop.js';

// ─── Shape Tree ──────────────────────────────────────────────────────────────

/** Build the sidebar shape tree for the currently selected art asset. */
export function buildSidebarShapeTree() {
  const container = document.getElementById('shape-tree-container');
  if (!container) return;
  container.innerHTML = '';

  if (!ctx.currentArt) return;
  const art = ctx.currentArt;

  // Search/filter
  const searchDiv = document.createElement('div');
  searchDiv.className = 'shape-tree-search';
  const searchInput = document.createElement('input');
  searchInput.placeholder = 'Filter shapes...';
  searchInput.addEventListener('input', () => rebuildTreeNodes(searchInput.value.toLowerCase()));
  searchDiv.appendChild(searchInput);
  container.appendChild(searchDiv);

  // Shape toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'shape-tree-toolbar';
  toolbar.innerHTML = '';
  const addBtn = Button('+ Add', () => showAddShapeDialog(), 'subtle');
  addBtn.el.style.cssText += 'padding:2px 6px;font-size:10px;';
  toolbar.appendChild(addBtn.el);
  const dupBtn = Button('Dup', () => duplicateSelectedShape(), 'subtle');
  dupBtn.el.style.cssText += 'padding:2px 6px;font-size:10px;';
  toolbar.appendChild(dupBtn.el);
  const delBtn = Button('Del', () => deleteSelectedShape(), 'subtle');
  delBtn.el.style.cssText += 'padding:2px 6px;font-size:10px;';
  delBtn.el.className += ' editor-btn-danger';
  toolbar.appendChild(delBtn.el);
  const upBtn = Button('↑', () => moveSelectedShape(-1), 'subtle');
  upBtn.el.style.cssText += 'padding:2px 6px;font-size:10px;';
  toolbar.appendChild(upBtn.el);
  const downBtn = Button('↓', () => moveSelectedShape(1), 'subtle');
  downBtn.el.style.cssText += 'padding:2px 6px;font-size:10px;';
  toolbar.appendChild(downBtn.el);
  const wrapBtn = Button('Wrap', () => showWrapDialog(), 'subtle');
  wrapBtn.el.style.cssText += 'padding:2px 6px;font-size:10px;';
  toolbar.appendChild(wrapBtn.el);
  const unwrapBtn = Button('Unwrap', () => unwrapSelectedShape(), 'subtle');
  unwrapBtn.el.style.cssText += 'padding:2px 6px;font-size:10px;';
  toolbar.appendChild(unwrapBtn.el);
  const moveIntoBtn = Button('Move→', () => showMoveIntoDialog(), 'subtle');
  moveIntoBtn.el.style.cssText += 'padding:2px 6px;font-size:10px;';
  moveIntoBtn.el.title = 'Move shape into a container';
  toolbar.appendChild(moveIntoBtn.el);
  const mirrorXBtn = Button('MirX', () => mirrorSelectedShape('x'), 'subtle');
  mirrorXBtn.el.style.cssText += 'padding:2px 6px;font-size:10px;';
  mirrorXBtn.el.title = 'Mirror horizontally (flip X)';
  toolbar.appendChild(mirrorXBtn.el);
  const mirrorYBtn = Button('MirY', () => mirrorSelectedShape('y'), 'subtle');
  mirrorYBtn.el.style.cssText += 'padding:2px 6px;font-size:10px;';
  mirrorYBtn.el.title = 'Mirror vertically (flip Y)';
  toolbar.appendChild(mirrorYBtn.el);
  container.appendChild(toolbar);

  // Scrollable tree area
  const scroll = document.createElement('div');
  scroll.className = 'shape-tree-scroll';
  container.appendChild(scroll);

  function rebuildTreeNodes(filter) {
    scroll.innerHTML = '';
    if (art.shapes) {
      renderTreeLevel(scroll, art.shapes, [], filter);
    }
  }

  function renderTreeLevel(parent, shapes, basePath, filter) {
    shapes.forEach((shape, i) => {
      const path = [...basePath, i];
      const name = shape.name || shape.type;
      const icon = SHAPE_ICONS[shape.type] || '?';
      const isContainer = CONTAINER_TYPES.has(shape.type) && shape.shapes && shape.shapes.length > 0;

      if (filter && !matchesFilter(shape, filter)) return;

      const node = createTreeNode(name, icon, path, shape, isContainer);
      if (node) parent.appendChild(node);

      if (isContainer && shape.shapes) {
        const childContainer = document.createElement('div');
        childContainer.style.display = ctx.expandedPaths.has(pathToKey(path)) ? '' : 'none';
        childContainer.dataset.treePath = pathToKey(path);
        renderTreeLevel(childContainer, shape.shapes, path, filter);
        parent.appendChild(childContainer);
      }
    });
  }

  function matchesFilter(shape, filter) {
    const name = (shape.name || shape.type || '').toLowerCase();
    if (name.includes(filter)) return true;
    if (shape.shapes) return shape.shapes.some(s => matchesFilter(s, filter));
    return false;
  }

  function createTreeNode(name, icon, path, shape, isContainer) {
    const isSelected = ctx.selectedShapePath !== null && pathToKey(ctx.selectedShapePath) === pathToKey(path);
    const depth = path.length;

    const node = document.createElement('div');
    node.className = 'shape-tree-node' + (isSelected ? ' selected' : '');
    node.dataset.shapePath = pathToKey(path);

    if (depth > 0) {
      const indent = document.createElement('span');
      indent.style.width = (depth * 12) + 'px';
      indent.style.flexShrink = '0';
      node.appendChild(indent);
    }

    const expandEl = document.createElement('span');
    expandEl.className = 'tree-expand';
    if (isContainer) {
      const expanded = ctx.expandedPaths.has(pathToKey(path));
      expandEl.textContent = expanded ? '▾' : '▸';
      expandEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = pathToKey(path);
        if (ctx.expandedPaths.has(key)) ctx.expandedPaths.delete(key);
        else ctx.expandedPaths.add(key);
        rebuildTreeNodes(searchInput.value.toLowerCase());
      });
    }
    node.appendChild(expandEl);

    const iconEl = document.createElement('span');
    iconEl.className = 'tree-icon';
    iconEl.textContent = icon;
    node.appendChild(iconEl);

    const nameEl = document.createElement('span');
    nameEl.className = 'tree-name';
    nameEl.textContent = name;
    node.appendChild(nameEl);

    if (ctx.currentEditState !== 'BASE' && shapeHasStateRef(shape, ctx.currentEditState)) {
      const dot = document.createElement('span');
      dot.className = 'state-dot override';
      node.appendChild(dot);
    }

    // Editor-only view toggles: Hide / Solo / Lock.
    const key = pathToKey(path);
    const hidden = ctx.editorHidden.has(key);
    const locked = ctx.editorLocked.has(key);
    const soloed = ctx.editorSolo === key;
    if (hidden) { nameEl.style.opacity = '0.4'; nameEl.style.textDecoration = 'line-through'; }
    if (locked) nameEl.style.fontStyle = 'italic';

    const toggles = document.createElement('span');
    toggles.style.cssText = 'margin-left:auto;display:flex;gap:4px;flex-shrink:0;padding-left:6px;';
    const mkToggle = (glyph, on, color, title, onClick) => {
      const b = document.createElement('span');
      b.textContent = glyph;
      b.title = title;
      b.style.cssText = `cursor:pointer;font-size:10px;line-height:1;color:${on ? color : '#4a4030'};`;
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); rebuildTreeNodes(searchInput.value.toLowerCase()); });
      return b;
    };
    toggles.appendChild(mkToggle('H', hidden, '#d4a056', 'Hide in preview', () => {
      if (ctx.editorHidden.has(key)) ctx.editorHidden.delete(key); else ctx.editorHidden.add(key);
    }));
    toggles.appendChild(mkToggle('S', soloed, '#33ddcc', 'Solo (show only this)', () => {
      ctx.editorSolo = soloed ? null : key;
    }));
    toggles.appendChild(mkToggle('L', locked, '#cc6644', 'Lock (prevent edits)', () => {
      if (ctx.editorLocked.has(key)) ctx.editorLocked.delete(key); else ctx.editorLocked.add(key);
    }));
    node.appendChild(toggles);

    node.addEventListener('click', () => {
      if (isDragging()) return;
      ctx.selectedShapePath = [...path];
      rebuildTreeNodes(searchInput.value.toLowerCase());
      ctx.rebuildProps();
    });

    attachShapeDrag(node, path, scroll);

    node.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      ctx.selectedShapePath = [...path];
      rebuildTreeNodes(searchInput.value.toLowerCase());
      ctx.rebuildProps();
      showShapeContextMenu(e.clientX, e.clientY, path, shape);
    });

    node.addEventListener('mouseenter', () => { ctx.hoveredShapePath = [...path]; });
    node.addEventListener('mouseleave', () => { ctx.hoveredShapePath = null; });

    return node;
  }

  rebuildTreeNodes('');
}

// ─── Shape Context Menu ─────────────────────────────────────────────────────

function showShapeContextMenu(x, y, path, shape) {
  document.querySelectorAll('.editor-context-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'editor-context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  const renameItem = document.createElement('div');
  renameItem.className = 'editor-context-menu-item';
  renameItem.textContent = 'Rename';
  renameItem.addEventListener('click', async () => {
    menu.remove();
    const newName = await modalPrompt('Rename shape:', { title: 'Rename shape', value: shape.name || shape.type, confirmLabel: 'Rename' });
    if (newName !== null && newName !== shape.name) {
      shape.name = newName;
      ctx.markDirty();
      buildSidebarShapeTree();
      ctx.rebuildProps();
    }
  });
  menu.appendChild(renameItem);

  const dupItem = document.createElement('div');
  dupItem.className = 'editor-context-menu-item';
  dupItem.textContent = 'Duplicate';
  dupItem.addEventListener('click', () => {
    menu.remove();
    duplicateSelectedShape();
  });
  menu.appendChild(dupItem);

  const mirXItem = document.createElement('div');
  mirXItem.className = 'editor-context-menu-item';
  mirXItem.textContent = 'Mirror X (horizontal)';
  mirXItem.addEventListener('click', () => {
    menu.remove();
    mirrorSelectedShape('x');
  });
  menu.appendChild(mirXItem);

  const mirYItem = document.createElement('div');
  mirYItem.className = 'editor-context-menu-item';
  mirYItem.textContent = 'Mirror Y (vertical)';
  mirYItem.addEventListener('click', () => {
    menu.remove();
    mirrorSelectedShape('y');
  });
  menu.appendChild(mirYItem);

  const sep = document.createElement('div');
  sep.className = 'editor-context-menu-sep';
  menu.appendChild(sep);

  const deleteItem = document.createElement('div');
  deleteItem.className = 'editor-context-menu-item danger';
  deleteItem.textContent = 'Delete';
  deleteItem.addEventListener('click', () => {
    menu.remove();
    deleteSelectedShape();
  });
  menu.appendChild(deleteItem);

  document.body.appendChild(menu);

  const close = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close); }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

// ─── Shape Management ────────────────────────────────────────────────────────

export function duplicateSelectedShape() {
  if (!ctx.selectedShapePath || ctx.selectedShapePath.length === 0) return;
  const art = ctx.currentArt;
  if (!art) return;
  const parentShapes = getParentShapesAtPath(art, ctx.selectedShapePath);
  if (!parentShapes) return;
  const idx = ctx.selectedShapePath[ctx.selectedShapePath.length - 1];
  const copy = JSON.parse(JSON.stringify(parentShapes[idx]));
  if (copy.name) copy.name += ' copy';
  parentShapes.splice(idx + 1, 0, copy);
  ctx.selectedShapePath = [...ctx.selectedShapePath.slice(0, -1), idx + 1];
  ctx.markDirty();
  buildSidebarShapeTree();
  ctx.rebuildProps();
}

export async function deleteSelectedShape() {
  if (!ctx.selectedShapePath || ctx.selectedShapePath.length === 0) return;
  const art = ctx.currentArt;
  if (!art) return;
  const parentShapes = getParentShapesAtPath(art, ctx.selectedShapePath);
  if (!parentShapes) return;
  const idx = ctx.selectedShapePath[ctx.selectedShapePath.length - 1];
  const shape = parentShapes[idx];
  const childCount = shape.shapes ? shape.shapes.length : 0;
  if (childCount > 0 && !(await modalConfirm(`Delete "${shape.name || shape.type}" and its ${childCount} children?`, { title: 'Delete shape', confirmLabel: 'Delete', danger: true }))) return;
  parentShapes.splice(idx, 1);
  ctx.selectedShapePath = null;
  ctx.markDirty();
  buildSidebarShapeTree();
  ctx.rebuildProps();
}

/** Copy the selected shape to the clipboard (deep clone — pasteable into any asset). */
export function copySelectedShape() {
  if (!ctx.selectedShapePath || !ctx.currentArt) return;
  const shape = getShapeAtPath(ctx.currentArt.shapes, ctx.selectedShapePath);
  if (shape) ctx.clipboard = JSON.parse(JSON.stringify(shape));
}

/** Paste the clipboard shape as a sibling after the selection (or at the asset root). */
export function pasteShape() {
  if (!ctx.clipboard || !ctx.currentArt) return;
  const clone = JSON.parse(JSON.stringify(ctx.clipboard));
  if (clone.name) clone.name += ' copy';
  let parentShapes, insertIdx, basePath;
  if (ctx.selectedShapePath && ctx.selectedShapePath.length) {
    parentShapes = getParentShapesAtPath(ctx.currentArt, ctx.selectedShapePath);
    insertIdx = ctx.selectedShapePath[ctx.selectedShapePath.length - 1] + 1;
    basePath = ctx.selectedShapePath.slice(0, -1);
  } else {
    parentShapes = ctx.currentArt.shapes;
    insertIdx = parentShapes.length;
    basePath = [];
  }
  if (!parentShapes) return;
  parentShapes.splice(insertIdx, 0, clone);
  ctx.selectedShapePath = [...basePath, insertIdx];
  ctx.markDirty();
  buildSidebarShapeTree();
  ctx.rebuildProps();
}

export function moveSelectedShape(direction) {
  if (!ctx.selectedShapePath || ctx.selectedShapePath.length === 0) return;
  const art = ctx.currentArt;
  if (!art) return;
  const parentShapes = getParentShapesAtPath(art, ctx.selectedShapePath);
  if (!parentShapes) return;
  const idx = ctx.selectedShapePath[ctx.selectedShapePath.length - 1];
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= parentShapes.length) return;
  const temp = parentShapes[idx];
  parentShapes[idx] = parentShapes[newIdx];
  parentShapes[newIdx] = temp;
  ctx.selectedShapePath = [...ctx.selectedShapePath.slice(0, -1), newIdx];
  ctx.markDirty();
  buildSidebarShapeTree();
}

function unwrapSelectedShape() {
  if (!ctx.selectedShapePath || ctx.selectedShapePath.length === 0) return;
  const art = ctx.currentArt;
  if (!art) return;
  const parentShapes = getParentShapesAtPath(art, ctx.selectedShapePath);
  if (!parentShapes) return;
  const idx = ctx.selectedShapePath[ctx.selectedShapePath.length - 1];
  const shape = parentShapes[idx];

  if (!shape.shapes || shape.shapes.length === 0) return;
  if (!CONTAINER_TYPES.has(shape.type)) return;

  const children = shape.shapes;
  parentShapes.splice(idx, 1, ...children);
  ctx.selectedShapePath = [...ctx.selectedShapePath.slice(0, -1), idx];
  ctx.markDirty();
  buildSidebarShapeTree();
  ctx.rebuildProps();
}

// ─── Loop Variables ──────────────────────────────────────────────────────────

/** Collect loop variables available at a given path (from ancestor repeat/forEach). */
export function collectAvailableVars(artDef, path) {
  const vars = [];
  if (!path || path.length === 0) return vars;
  let shapes = artDef.shapes;
  for (let i = 0; i < path.length - 1; i++) {
    const ancestor = shapes[path[i]];
    if (!ancestor) break;
    if (ancestor.var) vars.push(ancestor.var);
    shapes = ancestor.shapes || [];
  }
  return vars;
}

// mirrorSelectedShape lives in ./mirror.js; re-exported so artEditor.js's tree
// import (and any toolbar/keyboard binding) resolves through this module unchanged.
export { mirrorSelectedShape };
