// Drag-and-drop reordering / re-parenting for the art editor's shape tree. Split
// out of tree.js. The transient drag state is fully owned here: tree.js attaches a
// draggable node via attachShapeDrag() and guards its click handler with
// isDragging(); it never touches the state directly. Tree/props refreshes route
// through the ctx.* callbacks.

import { ctx, pathToKey, getShapeAtPath, getParentShapesAtPath, CONTAINER_TYPES } from '../ctx.js';

let dragState = null;   // { sourcePath, startY, active, indicator, dropTarget }

/** True while a tree drag is actively in progress (past the movement threshold). */
export function isDragging() {
  return !!(dragState && dragState.active);
}

/** Wire a tree node so a left-button drag reorders / re-parents its shape. */
export function attachShapeDrag(node, path, scroll) {
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
}

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
  ctx.rebuildTree();
  ctx.clearProps();
}

function cleanupDrag() {
  if (dragState && dragState.indicator) dragState.indicator.remove();
  document.querySelectorAll('.shape-tree-node.drag-source').forEach(n => n.classList.remove('drag-source'));
  dragState = null;
}
