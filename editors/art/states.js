// State system management for the art editor.
// Handles state discovery, state bar UI, rename/delete state operations.

import { ctx } from './ctx.js';
import { modalPrompt } from '/editors/shared/index.js';
import { renameAnimState, cloneAnimState, deleteAnimState } from './model/keyframes.js';

// ─── State Discovery ─────────────────────────────────────────────────────────

/**
 * Scan an art definition for all state names — from the declared `states` list,
 * per-state keyframe clips (`animations` / shape `anim`, excluding the ambient
 * "*" clip), shape state overrides, and `visibleStates`.
 */
export function discoverStates(artDef) {
  const states = new Set();
  if (artDef.states) artDef.states.forEach(s => states.add(s));
  if (artDef.animations) Object.keys(artDef.animations).forEach(s => { if (s !== '*') states.add(s); });
  function scan(shape) {
    if (shape.stateOverrides) Object.keys(shape.stateOverrides).forEach(s => states.add(s));
    if (shape.states && typeof shape.states === 'object' && !Array.isArray(shape.states)) {
      Object.keys(shape.states).forEach(s => states.add(s));
    }
    if (shape.visibleStates) shape.visibleStates.forEach(s => states.add(s));
    if (shape.anim) Object.keys(shape.anim).forEach(s => { if (s !== '*') states.add(s); });
    if (shape.shapes) shape.shapes.forEach(scan);
    if (shape.children) shape.children.forEach(scan);
  }
  if (artDef.shapes) artDef.shapes.forEach(scan);
  return ['BASE', ...states];
}

/** Count how many shapes reference a given state name. */
function countStateRefs(artDef, stateName) {
  let count = 0;
  function scan(shape) {
    if (shape.stateOverrides && shape.stateOverrides[stateName]) count++;
    if (shape.states && typeof shape.states === 'object' && !Array.isArray(shape.states) && shape.states[stateName]) count++;
    if (shape.visibleStates && shape.visibleStates.includes(stateName)) count++;
    if (shape.anim && shape.anim[stateName]) count++;
    if (shape.shapes) shape.shapes.forEach(scan);
    if (shape.children) shape.children.forEach(scan);
  }
  if (artDef.shapes) artDef.shapes.forEach(scan);
  return count;
}

// ─── State Bar UI ────────────────────────────────────────────────────────────

/** Build the state tab bar for art assets with multiple states. */
export function buildStateBar() {
  if (!ctx.stateBarEl) return;
  if (!ctx.currentArt || ctx.discoveredStates.length <= 1) {
    ctx.stateBarEl.style.display = 'none';
    return;
  }
  ctx.stateBarEl.style.display = '';
  ctx.stateBarEl.innerHTML = '';

  for (const state of ctx.discoveredStates) {
    const tab = document.createElement('button');
    const isBase = state === 'BASE';
    const isActive = state === ctx.currentEditState;
    tab.className = 'state-tab' + (isBase ? ' base' : '') + (isActive ? ' active' : '');
    tab.textContent = state;

    if (!isBase) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = ` (${countStateRefs(ctx.currentArt, state)})`;
      tab.appendChild(badge);
    }

    tab.addEventListener('click', () => {
      ctx.currentEditState = state;
      ctx.previewState = isBase ? null : state;
      buildStateBar();
      rebuildPropsForState();
    });

    if (!isBase) {
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showStateContextMenu(e.clientX, e.clientY, state);
      });
    }

    ctx.stateBarEl.appendChild(tab);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'state-tab-add';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', () => showAddStateInput());
  ctx.stateBarEl.appendChild(addBtn);

  // Transition duration slider — controls smooth interpolation between states
  const art = ctx.currentArt;
  const tdRow = document.createElement('div');
  tdRow.style.cssText = 'display:flex;align-items:center;gap:4px;margin-left:auto;';
  const tdLabel = document.createElement('span');
  tdLabel.style.cssText = 'color:#7a6a4a;font-size:10px;white-space:nowrap;';
  tdLabel.textContent = 'Transition:';
  tdRow.appendChild(tdLabel);
  const tdSlider = document.createElement('input');
  tdSlider.type = 'range';
  tdSlider.min = '0'; tdSlider.max = '2000'; tdSlider.step = '50';
  tdSlider.value = String(art.transitionDuration || 0);
  tdSlider.style.cssText = 'width:80px;accent-color:#33ddcc;';
  tdRow.appendChild(tdSlider);
  const tdVal = document.createElement('span');
  tdVal.style.cssText = 'color:#33ddcc;font-size:10px;min-width:32px;';
  tdVal.textContent = `${(art.transitionDuration || 0)}ms`;
  tdRow.appendChild(tdVal);
  tdSlider.addEventListener('input', () => {
    const ms = parseInt(tdSlider.value) || 0;
    art.transitionDuration = ms;
    tdVal.textContent = `${ms}ms`;
    ctx.markDirty();
  });
  ctx.stateBarEl.appendChild(tdRow);
}

// ─── State Operations ────────────────────────────────────────────────────────

function showAddStateInput() {
  const input = document.createElement('input');
  input.className = 'editor-text-field';
  input.style.cssText = 'width:100px;font-size:11px;padding:2px 6px;';
  input.placeholder = 'state name';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      const name = input.value.trim();
      if (!ctx.discoveredStates.includes(name)) {
        ctx.discoveredStates.push(name);
      }
      // Persist as a declared state so an empty state survives a reload.
      const art = ctx.currentArt;
      if (art && !(art.states || []).includes(name)) {
        art.states = [...(art.states || []), name];
        ctx.markDirty?.();
      }
      ctx.currentEditState = name;
      ctx.previewState = name;
      buildStateBar();
      rebuildPropsForState();
    } else if (e.key === 'Escape') {
      buildStateBar();
    }
  });
  input.addEventListener('blur', () => buildStateBar());
  ctx.stateBarEl.lastChild.replaceWith(input);
  input.focus();
}

function showStateContextMenu(x, y, stateName) {
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
    const newName = await modalPrompt('Rename state:', { title: 'Rename state', value: stateName, confirmLabel: 'Rename' });
    if (newName && newName !== stateName && !ctx.discoveredStates.includes(newName)) {
      renameStateEverywhere(ctx.currentArt, stateName, newName);
      const idx = ctx.discoveredStates.indexOf(stateName);
      if (idx >= 0) ctx.discoveredStates[idx] = newName;
      if (ctx.currentEditState === stateName) ctx.currentEditState = newName;
      if (ctx.previewState === stateName) ctx.previewState = newName;
      ctx.markDirty();
      buildStateBar();
      rebuildPropsForState();
    }
  });
  menu.appendChild(renameItem);

  const cloneItem = document.createElement('div');
  cloneItem.className = 'editor-context-menu-item';
  cloneItem.textContent = 'Clone';
  cloneItem.addEventListener('click', async () => {
    menu.remove();
    const newName = await modalPrompt('Clone state as:', { title: 'Clone state', value: stateName + '_copy', confirmLabel: 'Clone' });
    if (newName && newName !== stateName && !ctx.discoveredStates.includes(newName)) {
      cloneStateEverywhere(ctx.currentArt, stateName, newName);
      ctx.discoveredStates.push(newName);
      ctx.currentEditState = newName;
      ctx.previewState = newName;
      ctx.markDirty();
      buildStateBar();
      rebuildPropsForState();
    }
  });
  menu.appendChild(cloneItem);

  const deleteItem = document.createElement('div');
  deleteItem.className = 'editor-context-menu-item danger';
  deleteItem.textContent = 'Delete';
  deleteItem.addEventListener('click', () => {
    menu.remove();
    deleteStateEverywhere(ctx.currentArt, stateName);
    ctx.discoveredStates = ctx.discoveredStates.filter(s => s !== stateName);
    if (ctx.currentEditState === stateName) ctx.currentEditState = 'BASE';
    if (ctx.previewState === stateName) ctx.previewState = ctx.discoveredStates.length > 1 ? ctx.discoveredStates[1] : null;
    ctx.markDirty();
    buildStateBar();
    rebuildPropsForState();
  });
  menu.appendChild(deleteItem);

  document.body.appendChild(menu);

  const close = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close); }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

function renameStateEverywhere(artDef, oldName, newName) {
  function scan(shape) {
    if (shape.stateOverrides && shape.stateOverrides[oldName]) {
      shape.stateOverrides[newName] = shape.stateOverrides[oldName];
      delete shape.stateOverrides[oldName];
    }
    if (shape.states && typeof shape.states === 'object' && !Array.isArray(shape.states) && shape.states[oldName]) {
      shape.states[newName] = shape.states[oldName];
      delete shape.states[oldName];
    }
    if (shape.visibleStates) {
      const idx = shape.visibleStates.indexOf(oldName);
      if (idx >= 0) shape.visibleStates[idx] = newName;
    }
    if (shape.shapes) shape.shapes.forEach(scan);
    if (shape.children) shape.children.forEach(scan);
  }
  if (artDef.states) {
    const idx = artDef.states.indexOf(oldName);
    if (idx >= 0) artDef.states[idx] = newName;
  }
  if (artDef.shapes) artDef.shapes.forEach(scan);
  // Move the per-state keyframe clip (art.animations[state] + every shape.anim[state]).
  renameAnimState(artDef, oldName, newName);
}

function cloneStateEverywhere(artDef, srcName, newName) {
  function scan(shape) {
    const overridesMap = shape.states || shape.stateOverrides;
    if (overridesMap && overridesMap[srcName]) {
      overridesMap[newName] = JSON.parse(JSON.stringify(overridesMap[srcName]));
    }
    if (shape.visibleStates && shape.visibleStates.includes(srcName)) {
      shape.visibleStates.push(newName);
    }
    if (shape.shapes) shape.shapes.forEach(scan);
    if (shape.children) shape.children.forEach(scan);
  }
  if (artDef.states) {
    artDef.states.push(newName);
  }
  if (artDef.shapes) artDef.shapes.forEach(scan);
  // Duplicate the per-state keyframe clip onto the new state.
  cloneAnimState(artDef, srcName, newName);
}

function deleteStateEverywhere(artDef, stateName) {
  function scan(shape) {
    if (shape.stateOverrides) delete shape.stateOverrides[stateName];
    if (shape.states && typeof shape.states === 'object' && !Array.isArray(shape.states)) {
      delete shape.states[stateName];
    }
    if (shape.visibleStates) {
      shape.visibleStates = shape.visibleStates.filter(s => s !== stateName);
    }
    if (shape.shapes) shape.shapes.forEach(scan);
    if (shape.children) shape.children.forEach(scan);
  }
  if (artDef.states) {
    artDef.states = artDef.states.filter(s => s !== stateName);
  }
  if (artDef.shapes) artDef.shapes.forEach(scan);
  // Drop the per-state keyframe clip (art.animations[state] + every shape.anim[state]).
  deleteAnimState(artDef, stateName);
}

function rebuildPropsForState() {
  // A state change must move EVERY state-aware pane together so an edit always lands
  // in the state you see selected — no decoupled panes.
  // The state bar is the single state selector, so keep the timeline's key-target in
  // lockstep: key into the selected state's clip (BASE → the ambient "*" clip). The
  // timeline's "Key" toggle can still switch to ambient without leaving the state.
  ctx.keyTargetClip = (ctx.currentEditState && ctx.currentEditState !== 'BASE') ? ctx.currentEditState : '*';
  ctx.rebuildTimeline?.();          // timeline tracks + Key toggle
  ctx.rebuildTree?.();              // per-state override dots (tree.js keys on currentEditState)
  if (ctx.selectedShapePath !== null) {
    ctx.rebuildProps();            // props panel write-target + keyframe clip label
  } else {
    ctx.clearProps();
  }
  // No manual repaint: the always-on render loop reflects the new state next frame.
}
