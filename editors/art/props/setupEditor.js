// Setup-section editors for the art editor's property panel: the generic per-shape
// setup block (line width / alpha / shadow / colors / caps / joins) and the anim-var
// component editor for values like { base: 0.5, pulse: 0.3 }. Split out of props.js.
// Panel rebuilds route through ctx.rebuildProps() (== buildShapeProps) to avoid a
// back-import into the props orchestrator.

import { ctx } from '../ctx.js';
import { Button, PropertyGroup, NumberSlider, ColorInput, Select } from '/editors/shared/index.js';

export function buildSetupEditor(parent, shape, availableVars, onDirty) {
  if (!shape.setup && !shape.fillColor) {
    const addBtn = Button('+ Add Setup', () => {
      shape.setup = {};
      onDirty();
      ctx.rebuildProps();
    }, 'subtle');
    parent.appendChild(addBtn.el);
    return;
  }

  const group = PropertyGroup('Setup');
  parent.appendChild(group.el);

  if (shape.setup) {
    const s = shape.setup;
    const ss = (k, v) => { s[k] = v; onDirty(); };

    // Numeric setup properties — support both plain numbers and anim-var objects
    const numericKeys = [
      { key: 'lineWidth', label: 'Line Width', min: 0.1, max: 5, step: 0.1 },
      { key: 'alpha', label: 'Alpha', min: 0, max: 1, step: 0.05 },
      { key: 'shadow', label: 'Shadow', min: 0, max: 30, step: 1 },
      { key: 'shadowBlur', label: 'Shadow Blur', min: 0, max: 30, step: 1 },
    ];
    for (const { key, label, min, max, step } of numericKeys) {
      if (s[key] === undefined) continue;
      if (typeof s[key] === 'object' && s[key] !== null) {
        // Anim-var object: { base: 0.5, pulse: 0.3 }
        group.body.appendChild(buildAnimVarEditor(label, s, key, availableVars, min, max, step, onDirty));
      } else {
        group.addChild(NumberSlider(label, min, max, step, s[key], v => ss(key, v)));
      }
    }

    // Color and enum setup properties
    if (s.fillColor !== undefined) group.addChild(ColorInput('Fill Color', s.fillColor, v => ss('fillColor', v)));
    if (s.strokeColor !== undefined) group.addChild(ColorInput('Stroke Color', s.strokeColor, v => ss('strokeColor', v)));
    if (s.shadowColor !== undefined) group.addChild(ColorInput('Shadow Color', s.shadowColor, v => ss('shadowColor', v)));
    if (s.lineCap !== undefined) group.addChild(Select('Line Cap', ['butt', 'round', 'square'], s.lineCap, v => ss('lineCap', v)));
    if (s.lineJoin !== undefined) group.addChild(Select('Line Join', ['miter', 'round', 'bevel'], s.lineJoin, v => ss('lineJoin', v)));

    const allSetupKeys = ['lineWidth', 'alpha', 'shadow', 'shadowBlur', 'fillColor', 'strokeColor', 'shadowColor', 'lineCap', 'lineJoin'];
    const missing = allSetupKeys.filter(k => s[k] === undefined);
    if (missing.length > 0) {
      const addRow = document.createElement('div');
      addRow.style.cssText = 'margin-top:4px;';
      const addSel = document.createElement('select');
      addSel.className = 'editor-select-input';
      addSel.style.cssText = 'width:auto;font-size:10px;padding:1px 4px;';
      const ph = document.createElement('option');
      ph.textContent = '+ Add property...';
      ph.value = '';
      addSel.appendChild(ph);
      missing.forEach(k => {
        const o = document.createElement('option');
        o.value = k; o.textContent = k;
        addSel.appendChild(o);
      });
      addSel.addEventListener('change', () => {
        if (!addSel.value) return;
        const k = addSel.value;
        const defaults = { lineWidth: 1, alpha: 1, shadow: 0, shadowBlur: 0, fillColor: '#ffffff', strokeColor: '#ffffff', shadowColor: '#ffffff', lineCap: 'butt', lineJoin: 'miter' };
        s[k] = defaults[k];
        onDirty();
        ctx.rebuildProps();
      });
      addRow.appendChild(addSel);
      group.body.appendChild(addRow);
    }
  }
}

/**
 * Build an editor for an anim-var object like { base: 0.5, pulse: 0.3 }.
 * Shows each component with a slider and the ability to add/remove variable references.
 */
export function buildAnimVarEditor(label, setupObj, key, availableVars, min, max, step, onDirty) {
  const container = document.createElement('div');
  container.className = 'editor-widget coord-editor';

  const lbl = document.createElement('div');
  lbl.className = 'coord-editor-label';
  lbl.textContent = label;
  container.appendChild(lbl);

  const body = document.createElement('div');
  container.appendChild(body);

  function rebuild() {
    body.innerHTML = '';
    const obj = setupObj[key];

    for (const [comp, val] of Object.entries(obj)) {
      const row = document.createElement('div');
      row.className = 'coord-component';

      const keyEl = document.createElement('span');
      keyEl.className = 'comp-key';
      keyEl.textContent = comp;
      row.appendChild(keyEl);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = comp === 'base' ? min : -5;
      slider.max = comp === 'base' ? max : 5;
      slider.step = step;
      slider.value = val;
      slider.className = 'editor-slider';

      const numInput = document.createElement('input');
      numInput.type = 'number';
      numInput.step = step;
      numInput.value = val;
      numInput.className = 'editor-num-input';
      numInput.style.width = '60px';

      const syncComp = comp;
      const syncFn = (v) => { obj[syncComp] = parseFloat(v) || 0; onDirty(); };
      slider.addEventListener('input', () => { numInput.value = slider.value; syncFn(slider.value); });
      numInput.addEventListener('change', () => { slider.value = numInput.value; syncFn(numInput.value); });

      row.appendChild(slider);
      row.appendChild(numInput);

      // Delete component (but not 'base')
      if (comp !== 'base') {
        const delBtn = document.createElement('button');
        delBtn.className = 'comp-del';
        delBtn.textContent = '×';
        delBtn.addEventListener('click', () => {
          delete obj[syncComp];
          if (Object.keys(obj).length <= 1 && obj.base !== undefined) {
            setupObj[key] = obj.base;
          }
          onDirty();
          ctx.rebuildProps();
        });
        row.appendChild(delBtn);
      }

      body.appendChild(row);
    }

    // Add variable reference
    const existing = new Set(Object.keys(obj));
    const addable = ['base', ...availableVars].filter(k => !existing.has(k));
    if (addable.length > 0) {
      const addRow = document.createElement('div');
      addRow.style.cssText = 'margin-top:2px;';
      const addSel = document.createElement('select');
      addSel.className = 'editor-select-input';
      addSel.style.cssText = 'width:auto;font-size:10px;padding:1px 4px;';
      const ph = document.createElement('option');
      ph.textContent = '+ Add var...';
      ph.value = '';
      addSel.appendChild(ph);
      addable.forEach(k => {
        const o = document.createElement('option');
        o.value = k; o.textContent = k;
        addSel.appendChild(o);
      });
      addSel.addEventListener('change', () => {
        if (!addSel.value) return;
        obj[addSel.value] = 0;
        onDirty();
        rebuild();
      });
      addRow.appendChild(addSel);
      body.appendChild(addRow);
    }
  }

  rebuild();
  return container;
}
