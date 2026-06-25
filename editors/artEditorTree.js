// Shape tree UI and shape operations for the art editor.
// Builds the sidebar shape tree and handles add/delete/move/wrap/unwrap.

import { ctx, pathToKey, getShapeAtPath, getParentShapesAtPath, shapeHasStateRef, SHAPE_ICONS, CONTAINER_TYPES } from './artEditorCtx.js';
import { Button } from './editorShared.js';

// ─── Drag State ─────────────────────────────────────────────────────────────

let dragState = null;   // { sourcePath, startY, active, indicator }

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
  const upBtn = Button('\u2191', () => moveSelectedShape(-1), 'subtle');
  upBtn.el.style.cssText += 'padding:2px 6px;font-size:10px;';
  toolbar.appendChild(upBtn.el);
  const downBtn = Button('\u2193', () => moveSelectedShape(1), 'subtle');
  downBtn.el.style.cssText += 'padding:2px 6px;font-size:10px;';
  toolbar.appendChild(downBtn.el);
  const wrapBtn = Button('Wrap', () => showWrapDialog(), 'subtle');
  wrapBtn.el.style.cssText += 'padding:2px 6px;font-size:10px;';
  toolbar.appendChild(wrapBtn.el);
  const unwrapBtn = Button('Unwrap', () => unwrapSelectedShape(), 'subtle');
  unwrapBtn.el.style.cssText += 'padding:2px 6px;font-size:10px;';
  toolbar.appendChild(unwrapBtn.el);
  const moveIntoBtn = Button('Move\u2192', () => showMoveIntoDialog(), 'subtle');
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
      expandEl.textContent = expanded ? '\u25BE' : '\u25B8';
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

    node.addEventListener('click', () => {
      if (dragState && dragState.active) return;
      ctx.selectedShapePath = [...path];
      rebuildTreeNodes(searchInput.value.toLowerCase());
      ctx.rebuildProps();
    });

    node.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // Don't drag from expand toggle
      if (e.target.classList.contains('tree-expand')) return;
      dragState = { sourcePath: [...path], startY: e.clientY, active: false, indicator: null };
      const onMove = (me) => {
        if (!dragState) return;
        if (!dragState.active && Math.abs(me.clientY - dragState.startY) < 5) return;
        dragState.active = true;
        updateDropIndicator(me.clientY, scroll);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (dragState && dragState.active) {
          performDrop(scroll);
        }
        cleanupDrag();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

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
  renameItem.addEventListener('click', () => {
    menu.remove();
    const newName = prompt('Rename shape:', shape.name || shape.type);
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

// ─── Drag & Drop ────────────────────────────────────────────────────────────

/** Find the drop target: which node to drop before/after/into, based on mouse Y. */
function findDropTarget(clientY, scrollEl) {
  const nodes = scrollEl.querySelectorAll('.shape-tree-node');
  let best = null;
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    const nodePath = node.dataset.shapePath.split(',').map(Number);
    const midY = rect.top + rect.height / 2;
    const isContainer = CONTAINER_TYPES.has(getShapeAtPath(ctx.currentArt.shapes, nodePath)?.type);

    // Check if this is the source node — skip it as a target
    if (dragState && pathToKey(nodePath) === pathToKey(dragState.sourcePath)) continue;

    if (clientY >= rect.top && clientY <= rect.bottom) {
      const zone = (clientY - rect.top) / rect.height;
      if (isContainer && zone > 0.25 && zone < 0.75) {
        // Drop into container
        best = { path: nodePath, position: 'into', rect };
      } else if (zone <= 0.5) {
        best = { path: nodePath, position: 'before', rect };
      } else {
        best = { path: nodePath, position: 'after', rect };
      }
      break;
    } else if (clientY < rect.top) {
      best = { path: nodePath, position: 'before', rect };
      break;
    }
    // Track last node in case mouse is below all nodes
    best = { path: nodePath, position: 'after', rect };
  }
  return best;
}

function updateDropIndicator(clientY, scrollEl) {
  if (!dragState) return;
  // Remove old indicator
  if (dragState.indicator) dragState.indicator.remove();

  // Dim source node
  const srcKey = pathToKey(dragState.sourcePath);
  scrollEl.querySelectorAll('.shape-tree-node').forEach(n => {
    n.classList.toggle('drag-source', n.dataset.shapePath === srcKey);
  });

  const target = findDropTarget(clientY, scrollEl);
  if (!target) return;
  dragState.dropTarget = target;

  const indicator = document.createElement('div');
  indicator.className = 'shape-tree-drop-indicator';

  const scrollRect = scrollEl.getBoundingClientRect();

  if (target.position === 'into') {
    // Highlight the container node
    indicator.style.cssText = `
      position: absolute;
      left: ${target.rect.left - scrollRect.left}px;
      top: ${target.rect.top - scrollRect.top + scrollEl.scrollTop}px;
      width: ${target.rect.width}px;
      height: ${target.rect.height}px;
      border: 1px solid #33ddcc;
      border-radius: 3px;
      pointer-events: none;
    `;
  } else {
    // Line above or below the node
    const y = target.position === 'before'
      ? target.rect.top - scrollRect.top + scrollEl.scrollTop
      : target.rect.bottom - scrollRect.top + scrollEl.scrollTop;
    indicator.style.cssText = `
      position: absolute;
      left: 4px;
      right: 4px;
      top: ${y}px;
      height: 2px;
      background: #33ddcc;
      border-radius: 1px;
      pointer-events: none;
    `;
  }

  scrollEl.style.position = 'relative';
  scrollEl.appendChild(indicator);
  dragState.indicator = indicator;
}

function performDrop(scrollEl) {
  if (!dragState || !dragState.dropTarget || !ctx.currentArt) return;
  const art = ctx.currentArt;
  const srcPath = dragState.sourcePath;
  const target = dragState.dropTarget;

  // Don't drop onto self
  if (pathToKey(srcPath) === pathToKey(target.path)) return;
  // Don't drop a container into its own descendant
  const srcKey = pathToKey(srcPath);
  const targetKey = pathToKey(target.path);
  if (target.position === 'into' && targetKey.startsWith(srcKey + ',')) return;

  // Grab references to target shapes BEFORE removing source (indices may shift after)
  const targetShapeRef = getShapeAtPath(art.shapes, target.path);
  const targetParentRef = (target.position !== 'into') ? getParentShapesAtPath(art, target.path) : null;

  // Remove shape from source
  const srcParent = getParentShapesAtPath(art, srcPath);
  if (!srcParent) return;
  const srcIdx = srcPath[srcPath.length - 1];
  const shape = srcParent[srcIdx];
  srcParent.splice(srcIdx, 1);

  // Calculate destination using saved references (immune to index shifts)
  let destParent, destIdx;

  if (target.position === 'into') {
    if (!targetShapeRef) return;
    if (!targetShapeRef.shapes) targetShapeRef.shapes = [];
    destParent = targetShapeRef.shapes;
    destIdx = destParent.length;
    ctx.expandedPaths.add(targetKey);
  } else {
    if (!targetParentRef) return;
    destParent = targetParentRef;
    let targetIdx = destParent.indexOf(targetShapeRef);
    if (targetIdx < 0) targetIdx = target.path[target.path.length - 1];
    destIdx = target.position === 'before' ? targetIdx : targetIdx + 1;
  }

  destParent.splice(destIdx, 0, shape);

  // Update selection to point to the new location
  // (we don't know the exact new path without re-walking, so just clear and rebuild)
  ctx.selectedShapePath = null;
  ctx.markDirty();
  buildSidebarShapeTree();
  ctx.clearProps();
}

function cleanupDrag() {
  if (dragState && dragState.indicator) dragState.indicator.remove();
  document.querySelectorAll('.shape-tree-node.drag-source').forEach(n => n.classList.remove('drag-source'));
  dragState = null;
}

// ─── Shape Management ────────────────────────────────────────────────────────

function showAddShapeDialog() {
  if (!ctx.currentArt) return;
  const art = ctx.currentArt;
  if (!art.shapes) art.shapes = [];

  const defaults = {
    path: { name: 'newPath', type: 'path', points: [[0, 0], [0.5, 0]], stroke: true },
    circle: { name: 'newCircle', type: 'circle', cx: 0, cy: 0, radius: 0.2, fill: true },
    lines: { name: 'newLines', type: 'lines', segments: [[[0, 0], [0.3, 0]]], stroke: true },
    spinner: { name: 'newSpinner', type: 'spinner', cx: 0, cy: 0, rate: 0.01, copies: 4, shapes: [{ name: 'blade', type: 'lines', segments: [[[0, 0], [0.3, 0]]], stroke: true }] },
    oscillator: { name: 'newOscillator', type: 'oscillator', var: 'v', rate: 0.003, amplitude: 0.4, phase: 0, activeStates: [], defaultValue: 0, shapes: [] },
    conditional: { name: 'newConditional', type: 'conditional', visibleStates: [], shapes: [] },
    radialRepeat: { name: 'newRadialRepeat', type: 'radialRepeat', cx: 0, cy: 0, count: 6, shapes: [{ name: 'child', type: 'circle', cx: { r: 0.5 }, cy: 0, radius: 0.1, fill: true }] },
  };

  const types = ['circle', 'path', 'lines', 'arc', 'rect', 'roundedRect', 'spinner', 'oscillator', 'conditional', 'particles', 'repeat', 'forEach', 'radialRepeat', 'boltCluster'];

  const treeScroll = document.querySelector('.shape-tree-scroll');
  if (!treeScroll) return;

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:#1a1a2a;border:1px solid #3a3a4a;border-radius:4px;padding:6px;margin:4px;';

  const sel = document.createElement('select');
  sel.className = 'editor-select-input';
  sel.style.fontSize = '11px';
  types.forEach(t => {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = t;
    sel.appendChild(o);
  });
  dialog.appendChild(sel);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:4px;margin-top:4px;';
  const confirmBtn = Button('Add', () => {
    const type = sel.value;
    const shape = defaults[type]
      ? JSON.parse(JSON.stringify(defaults[type]))
      : { name: 'new' + type.charAt(0).toUpperCase() + type.slice(1), type };
    art.shapes.push(shape);
    ctx.selectedShapePath = [art.shapes.length - 1];
    ctx.markDirty();
    dialog.remove();
    buildSidebarShapeTree();
    ctx.rebuildProps();
  }, 'primary');
  confirmBtn.el.style.cssText += 'padding:2px 8px;font-size:10px;';
  const cancelBtn = Button('Cancel', () => dialog.remove(), 'subtle');
  cancelBtn.el.style.cssText += 'padding:2px 8px;font-size:10px;';
  row.appendChild(confirmBtn.el);
  row.appendChild(cancelBtn.el);
  dialog.appendChild(row);

  treeScroll.appendChild(dialog);
}

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

// ─── Mirror ─────────────────────────────────────────────────────────────────

/** Negate a coordinate value (number, object with coefficients, or string variable ref). */
function negateCoord(val) {
  if (typeof val === 'number') return -val;
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
    const result = {};
    for (const [k, v] of Object.entries(val)) result[k] = typeof v === 'number' ? -v : v;
    return result;
  }
  return val; // strings (variable refs) can't be negated
}

/** Negate the X or Y component of a point ([x,y] array or {x,y} object). */
function negatePointAxis(pt, axis) {
  if (Array.isArray(pt)) {
    const copy = [...pt];
    copy[axis === 'x' ? 0 : 1] = negateCoord(copy[axis === 'x' ? 0 : 1]);
    return copy;
  }
  if (typeof pt === 'object' && pt !== null) {
    const copy = { ...pt };
    if (copy[axis] !== undefined) copy[axis] = negateCoord(copy[axis]);
    return copy;
  }
  return pt;
}

/** Mirror angle for X-axis flip: PI - angle. For Y-axis flip: -angle. */
function mirrorAngle(val, axis) {
  if (typeof val === 'string') {
    // PI-based angle string — wrap with mirror transform
    return axis === 'x' ? `PI-(${val})` : `-(${val})`;
  }
  if (typeof val === 'number') {
    return axis === 'x' ? Math.PI - val : -val;
  }
  return val;
}

/**
 * Recursively mirror a shape (already deep-cloned) along the given axis ('x' or 'y').
 * Negates position coordinates on the specified axis throughout the shape tree.
 */
function mirrorShapeRecursive(shape, axis) {
  const pos = axis; // 'x' or 'y'
  const altPos = axis === 'x' ? 'y' : 'x';
  const cPos = axis === 'x' ? 'cx' : 'cy';

  // Position properties common to many shape types
  if (shape[cPos] !== undefined) shape[cPos] = negateCoord(shape[cPos]);

  switch (shape.type) {
    case 'circle':
    case 'boltCluster':
      // cx/cy already handled above
      break;

    case 'arc':
      if (axis === 'x') {
        // Mirror angles: swap and reflect through PI
        const sa = shape.startAngle, ea = shape.endAngle;
        shape.startAngle = mirrorAngle(ea, 'x');
        shape.endAngle = mirrorAngle(sa, 'x');
      } else {
        const sa = shape.startAngle, ea = shape.endAngle;
        shape.startAngle = mirrorAngle(ea, 'y');
        shape.endAngle = mirrorAngle(sa, 'y');
      }
      break;

    case 'path':
      if (shape.points) shape.points = shape.points.map(p => negatePointAxis(p, pos));
      break;

    case 'bezierPath':
      if (shape.start) shape.start = negatePointAxis(shape.start, pos);
      if (shape.curves) {
        shape.curves = shape.curves.map(c => ({
          ...c,
          cp1: negatePointAxis(c.cp1, pos),
          cp2: negatePointAxis(c.cp2, pos),
          to: negatePointAxis(c.to, pos),
        }));
      }
      break;

    case 'quadPath':
      if (shape.start) shape.start = negatePointAxis(shape.start, pos);
      if (shape.curves) {
        shape.curves = shape.curves.map(c => ({
          ...c,
          cp: negatePointAxis(c.cp, pos),
          to: negatePointAxis(c.to, pos),
        }));
      }
      break;

    case 'rect':
    case 'strokeRect':
      if (shape[pos] !== undefined) {
        // Mirror rect: new_x = -(x + w), new_y = -(y + h)
        const size = axis === 'x' ? (shape.w ?? 0) : (shape.h ?? 0);
        if (typeof shape[pos] === 'number' && typeof size === 'number') {
          shape[pos] = -(shape[pos] + size);
        } else {
          shape[pos] = negateCoord(shape[pos]);
        }
      }
      break;

    case 'roundedRect':
      if (shape[pos] !== undefined) {
        const size = axis === 'x' ? (shape.width ?? 0) : (shape.height ?? 0);
        if (typeof shape[pos] === 'number' && typeof size === 'number') {
          shape[pos] = -(shape[pos] + size);
        } else {
          shape[pos] = negateCoord(shape[pos]);
        }
      }
      break;

    case 'lines':
      if (shape.segments) {
        shape.segments = shape.segments.map(seg =>
          seg.map(p => negatePointAxis(p, pos))
        );
      }
      break;

    case 'particles':
      if (shape.emitters) {
        for (const em of shape.emitters) {
          if (em[cPos] !== undefined) em[cPos] = negateCoord(em[cPos]);
          if (axis === 'x' && em.offsetX !== undefined) em.offsetX = -em.offsetX;
          if (axis === 'y' && em.offsetY !== undefined) em.offsetY = -em.offsetY;
        }
      }
      break;

    case 'group':
      // cx/cy already handled above.
      // Mirroring through a translate+rotate transform: rotation simply negates
      // (children are recursively mirrored to handle the scale(-1,1) / scale(1,-1))
      if (shape.rotation !== undefined) {
        if (typeof shape.rotation === 'number') shape.rotation = -shape.rotation;
        else if (typeof shape.rotation === 'string') shape.rotation = `-(${shape.rotation})`;
      }
      break;

    case 'spinner':
      // cx/cy already handled; reverse spin direction
      if (shape.rate !== undefined) shape.rate = -shape.rate;
      break;
  }

  // Recurse into children for container types
  if (shape.shapes) {
    for (const child of shape.shapes) mirrorShapeRecursive(child, axis);
  }

  // Mirror state overrides (supports both `states` and legacy `stateOverrides` keys)
  const overridesMap = shape.states || shape.stateOverrides;
  if (overridesMap) {
    for (const overrides of Object.values(overridesMap)) {
      if (overrides[cPos] !== undefined) overrides[cPos] = negateCoord(overrides[cPos]);
      if (overrides[pos] !== undefined) overrides[pos] = negateCoord(overrides[pos]);
      if (overrides.points) overrides.points = overrides.points.map(p => negatePointAxis(p, pos));
      if (overrides.segments) overrides.segments = overrides.segments.map(seg => seg.map(p => negatePointAxis(p, pos)));
      if (overrides.start) overrides.start = negatePointAxis(overrides.start, pos);
      if (overrides.curves) {
        overrides.curves = overrides.curves.map(c => {
          const mc = { ...c };
          if (mc.cp1) mc.cp1 = negatePointAxis(mc.cp1, pos);
          if (mc.cp2) mc.cp2 = negatePointAxis(mc.cp2, pos);
          if (mc.cp) mc.cp = negatePointAxis(mc.cp, pos);
          if (mc.to) mc.to = negatePointAxis(mc.to, pos);
          return mc;
        });
      }
    }
  }
}

/** Mirror the selected shape along an axis and insert the mirrored copy after it. */
export function mirrorSelectedShape(axis) {
  if (!ctx.selectedShapePath || ctx.selectedShapePath.length === 0) return;
  const art = ctx.currentArt;
  if (!art) return;
  const parentShapes = getParentShapesAtPath(art, ctx.selectedShapePath);
  if (!parentShapes) return;
  const idx = ctx.selectedShapePath[ctx.selectedShapePath.length - 1];
  const copy = JSON.parse(JSON.stringify(parentShapes[idx]));
  if (copy.name) copy.name += (axis === 'x' ? ' mirrorX' : ' mirrorY');
  mirrorShapeRecursive(copy, axis);
  parentShapes.splice(idx + 1, 0, copy);
  ctx.selectedShapePath = [...ctx.selectedShapePath.slice(0, -1), idx + 1];
  ctx.markDirty();
  buildSidebarShapeTree();
  ctx.rebuildProps();
}

export function deleteSelectedShape() {
  if (!ctx.selectedShapePath || ctx.selectedShapePath.length === 0) return;
  const art = ctx.currentArt;
  if (!art) return;
  const parentShapes = getParentShapesAtPath(art, ctx.selectedShapePath);
  if (!parentShapes) return;
  const idx = ctx.selectedShapePath[ctx.selectedShapePath.length - 1];
  const shape = parentShapes[idx];
  const childCount = shape.shapes ? shape.shapes.length : 0;
  if (childCount > 0 && !confirm(`Delete "${shape.name || shape.type}" and its ${childCount} children?`)) return;
  parentShapes.splice(idx, 1);
  ctx.selectedShapePath = null;
  ctx.markDirty();
  buildSidebarShapeTree();
  ctx.clearProps();
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

function showWrapDialog() {
  if (!ctx.selectedShapePath || ctx.selectedShapePath.length === 0) return;
  const art = ctx.currentArt;
  if (!art) return;
  const parentShapes = getParentShapesAtPath(art, ctx.selectedShapePath);
  if (!parentShapes) return;
  const idx = ctx.selectedShapePath[ctx.selectedShapePath.length - 1];
  const shape = parentShapes[idx];

  const wrapTypes = [
    { type: 'group', label: 'Group' },
    { type: 'oscillator', label: 'Oscillator' },
    { type: 'conditional', label: 'Conditional' },
    { type: 'spinner', label: 'Spinner' },
    { type: 'repeat', label: 'Repeat', defaults: { var: 'i', from: -0.5, to: 0.5, step: 0.25 } },
    { type: 'radialRepeat', label: 'Radial Repeat', defaults: { cx: 0, cy: 0, count: 6 } },
  ];

  const treeScroll = document.querySelector('.shape-tree-scroll');
  if (!treeScroll) return;

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:#1a1a2a;border:1px solid #33ddcc44;border-radius:4px;padding:6px;margin:4px;';
  const label = document.createElement('div');
  label.style.cssText = 'color:#33ddcc;font-size:10px;margin-bottom:4px;';
  label.textContent = `Wrap "${shape.name || shape.type}" in:`;
  dialog.appendChild(label);

  for (const wt of wrapTypes) {
    const btn = Button(wt.label, () => {
      const defaults = wt.defaults || WRAP_DEFAULTS[wt.type];
      if (!defaults) return;
      const wrapper = {
        name: `${wt.type}Wrapper`,
        type: wt.type,
        ...JSON.parse(JSON.stringify(defaults)),
        shapes: [shape],
      };
      parentShapes[idx] = wrapper;
      ctx.expandedPaths.add(pathToKey(ctx.selectedShapePath));
      ctx.selectedShapePath = [...ctx.selectedShapePath, 0];
      ctx.markDirty();
      dialog.remove();
      buildSidebarShapeTree();
      ctx.rebuildProps();
    }, 'subtle');
    btn.el.style.cssText += 'padding:2px 6px;font-size:10px;margin:2px;';
    dialog.appendChild(btn.el);
  }

  const cancelBtn = Button('Cancel', () => dialog.remove(), 'subtle');
  cancelBtn.el.style.cssText += 'padding:2px 6px;font-size:10px;margin-top:4px;';
  dialog.appendChild(cancelBtn.el);
  treeScroll.appendChild(dialog);
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

function showMoveIntoDialog() {
  if (!ctx.selectedShapePath || ctx.selectedShapePath.length === 0) return;
  const art = ctx.currentArt;
  if (!art) return;
  const parentShapes = getParentShapesAtPath(art, ctx.selectedShapePath);
  if (!parentShapes) return;
  const idx = ctx.selectedShapePath[ctx.selectedShapePath.length - 1];
  const shape = parentShapes[idx];

  // Collect sibling containers the shape could move into
  const targets = [];
  for (let i = 0; i < parentShapes.length; i++) {
    if (i === idx) continue;
    const sib = parentShapes[i];
    if (CONTAINER_TYPES.has(sib.type) || sib.type === 'group') {
      targets.push({ index: i, shape: sib });
    }
  }
  // Also offer moving up (out of current container) if inside one
  const canMoveOut = ctx.selectedShapePath.length > 1;

  if (targets.length === 0 && !canMoveOut) return;

  const treeScroll = document.querySelector('.shape-tree-scroll');
  if (!treeScroll) return;

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:#1a1a2a;border:1px solid #33ddcc44;border-radius:4px;padding:6px;margin:4px;';
  const label = document.createElement('div');
  label.style.cssText = 'color:#33ddcc;font-size:10px;margin-bottom:4px;';
  label.textContent = `Move "${shape.name || shape.type}" into:`;
  dialog.appendChild(label);

  for (const t of targets) {
    const icon = SHAPE_ICONS[t.shape.type] || '?';
    const btn = Button(`${icon} ${t.shape.name || t.shape.type}`, () => {
      // Remove shape from current position
      parentShapes.splice(idx, 1);
      // Adjust target index if it was after the removed shape
      const targetShape = t.shape;
      if (!targetShape.shapes) targetShape.shapes = [];
      targetShape.shapes.push(shape);
      // Find the target's new index in parentShapes after removal
      const targetIdx = parentShapes.indexOf(targetShape);
      // Update selection to point to the moved shape inside the target
      const basePath = ctx.selectedShapePath.slice(0, -1);
      ctx.selectedShapePath = [...basePath, targetIdx, targetShape.shapes.length - 1];
      ctx.expandedPaths.add(pathToKey([...basePath, targetIdx]));
      ctx.markDirty();
      dialog.remove();
      buildSidebarShapeTree();
      ctx.rebuildProps();
    }, 'subtle');
    btn.el.style.cssText += 'padding:2px 6px;font-size:10px;margin:2px;display:block;';
    dialog.appendChild(btn.el);
  }

  if (canMoveOut) {
    const btn = Button('\u2191 Move out of parent', () => {
      // Remove from current parent
      parentShapes.splice(idx, 1);
      // Insert into grandparent after the current parent
      const parentPath = ctx.selectedShapePath.slice(0, -1);
      const grandparentShapes = getParentShapesAtPath(art, parentPath);
      if (!grandparentShapes) return;
      const parentIdx = parentPath[parentPath.length - 1];
      grandparentShapes.splice(parentIdx + 1, 0, shape);
      ctx.selectedShapePath = [...parentPath.slice(0, -1), parentIdx + 1];
      ctx.markDirty();
      dialog.remove();
      buildSidebarShapeTree();
      ctx.rebuildProps();
    }, 'subtle');
    btn.el.style.cssText += 'padding:2px 6px;font-size:10px;margin:2px;display:block;';
    dialog.appendChild(btn.el);
  }

  const cancelBtn = Button('Cancel', () => dialog.remove(), 'subtle');
  cancelBtn.el.style.cssText += 'padding:2px 6px;font-size:10px;margin-top:4px;';
  dialog.appendChild(cancelBtn.el);
  treeScroll.appendChild(dialog);
}

// ─── Animation Wrap/Unwrap Helpers ──────────────────────────────────────────

const WRAP_DEFAULTS = {
  group: { cx: 0, cy: 0, rotation: 0 },
  oscillator: { var: 'v', rate: 0.003, amplitude: 0.4, phase: 0, activeStates: [], defaultValue: 0 },
  conditional: { visibleStates: [] },
  spinner: { cx: 0, cy: 0, rate: 0.01, copies: 1 },
  radialRepeat: { cx: 0, cy: 0, count: 6 },
};

/** Wrap a shape at the given path in an animation container. Returns the new child path. */
export function wrapShapeInAnimation(artDef, path, animationType) {
  const parentShapes = getParentShapesAtPath(artDef, path);
  if (!parentShapes) return null;
  const defaults = WRAP_DEFAULTS[animationType];
  if (!defaults) return null;
  const idx = path[path.length - 1];
  const shape = parentShapes[idx];
  const wrapper = {
    name: `${animationType}Wrapper`,
    type: animationType,
    ...JSON.parse(JSON.stringify(defaults)),
    shapes: [shape],
  };
  // For spinners/oscillators, steal the child's cx/cy as the wrapper's pivot
  // and zero out the child so it sits at the wrapper's origin
  if ('cx' in wrapper && shape.cx !== undefined) {
    wrapper.cx = shape.cx;
    shape.cx = 0;
  }
  if ('cy' in wrapper && shape.cy !== undefined) {
    wrapper.cy = shape.cy;
    shape.cy = 0;
  }
  parentShapes[idx] = wrapper;
  return [...path, 0];
}

/** Remove the animation container parent of a shape. Returns the new path to the unwrapped shape. */
export function removeParentAnimation(artDef, childPath) {
  if (childPath.length < 2) return null;
  const parentPath = childPath.slice(0, -1);
  const grandParentShapes = getParentShapesAtPath(artDef, parentPath);
  if (!grandParentShapes) return null;
  const parentIdx = parentPath[parentPath.length - 1];
  const parent = grandParentShapes[parentIdx];
  if (!parent.shapes || parent.shapes.length === 0) return null;
  if (!CONTAINER_TYPES.has(parent.type)) return null;
  const childIdx = childPath[childPath.length - 1];
  const children = parent.shapes;
  grandParentShapes.splice(parentIdx, 1, ...children);
  return [...parentPath.slice(0, -1), parentIdx + childIdx];
}

/** Collect animation variables available at a given path (from ancestor oscillators/repeats). */
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
