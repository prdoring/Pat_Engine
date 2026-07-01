// Transient inline dialogs for the art editor's shape tree: Add shape, Wrap in a
// container, and Move into a container. Split out of tree.js. Each builds a small
// DOM panel inside the tree scroll area, mutates the art, then refreshes via the
// ctx.* callbacks (== buildSidebarShapeTree / buildShapeProps).

import { ctx, pathToKey, getParentShapesAtPath, SHAPE_ICONS, CONTAINER_TYPES } from '../ctx.js';
import { Button } from '/editors/shared/index.js';

export function showAddShapeDialog() {
  if (!ctx.currentArt) return;
  const art = ctx.currentArt;
  if (!art.shapes) art.shapes = [];

  const defaults = {
    path: { name: 'newPath', type: 'path', points: [[0, 0], [0.5, 0]], stroke: true },
    circle: { name: 'newCircle', type: 'circle', cx: 0, cy: 0, radius: 0.2, fill: true },
    lines: { name: 'newLines', type: 'lines', segments: [[[0, 0], [0.3, 0]]], stroke: true },
    conditional: { name: 'newConditional', type: 'conditional', visibleStates: [], shapes: [] },
    radialRepeat: { name: 'newRadialRepeat', type: 'radialRepeat', cx: 0, cy: 0, count: 6, shapes: [{ name: 'child', type: 'circle', cx: { r: 0.5 }, cy: 0, radius: 0.1, fill: true }] },
    effectRef: { name: 'newEffect', type: 'effectRef', effect: '', cx: 0, cy: 0, scale: 1 },
  };

  // `particles` is deprecated — author particle clouds in the VFX tab and embed
  // them via `effectRef`. Existing particles still render and remain editable.
  const types = ['circle', 'path', 'lines', 'arc', 'rect', 'roundedRect', 'effectRef', 'conditional', 'repeat', 'forEach', 'radialRepeat', 'boltCluster'];

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
    ctx.rebuildTree();
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

// ─── Container Wrap Helpers ─────────────────────────────────────────────────

const WRAP_DEFAULTS = {
  group: { cx: 0, cy: 0, rotation: 0 },
  conditional: { visibleStates: [] },
  radialRepeat: { cx: 0, cy: 0, count: 6 },
};

export function showWrapDialog() {
  if (!ctx.selectedShapePath || ctx.selectedShapePath.length === 0) return;
  const art = ctx.currentArt;
  if (!art) return;
  const parentShapes = getParentShapesAtPath(art, ctx.selectedShapePath);
  if (!parentShapes) return;
  const idx = ctx.selectedShapePath[ctx.selectedShapePath.length - 1];
  const shape = parentShapes[idx];

  const wrapTypes = [
    { type: 'group', label: 'Group' },
    { type: 'conditional', label: 'Conditional' },
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
      ctx.rebuildTree();
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

export function showMoveIntoDialog() {
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
      ctx.rebuildTree();
      ctx.rebuildProps();
    }, 'subtle');
    btn.el.style.cssText += 'padding:2px 6px;font-size:10px;margin:2px;display:block;';
    dialog.appendChild(btn.el);
  }

  if (canMoveOut) {
    const btn = Button('↑ Move out of parent', () => {
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
      ctx.rebuildTree();
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
