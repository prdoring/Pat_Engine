// Shared editor input/display widgets. Every widget returns
// { el, getValue, setValue, onChange, destroy } (some add setOptions/refresh/etc.).
// Self-contained (browser DOM only); the only shared privates (makeLabel/makeRow,
// _coordReadout) live in this file.

// ─── Widget Helpers ────────────────────────────────────────────────────────

function makeLabel(text) {
  const el = document.createElement('label');
  el.className = 'editor-label';
  el.textContent = text;
  return el;
}

function makeRow(...children) {
  const row = document.createElement('div');
  row.className = 'editor-row';
  children.forEach(c => row.appendChild(c));
  return row;
}

// ─── NumberSlider ──────────────────────────────────────────────────────────

export function NumberSlider(label, min, max, step, value, onChange) {
  const container = document.createElement('div');
  container.className = 'editor-widget editor-number-slider';

  const lbl = makeLabel(label);
  const row = document.createElement('div');
  row.className = 'editor-row';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = min;
  slider.max = max;
  slider.step = step;
  slider.value = value;
  slider.className = 'editor-slider';

  const numInput = document.createElement('input');
  numInput.type = 'number';
  numInput.min = min;
  numInput.step = step;
  numInput.value = value;
  numInput.className = 'editor-num-input';

  let currentVal = value;

  slider.addEventListener('input', () => {
    currentVal = parseFloat(slider.value);
    numInput.value = currentVal;
    onChange(currentVal);
  });

  numInput.addEventListener('change', () => {
    let v = parseFloat(numInput.value);
    if (isNaN(v)) v = min;
    v = Math.max(min, v);
    currentVal = v;
    slider.value = Math.min(v, max); // slider stays within its range
    numInput.value = v;
    onChange(currentVal);
  });

  row.appendChild(slider);
  row.appendChild(numInput);
  container.appendChild(lbl);
  container.appendChild(row);

  return {
    el: container,
    getValue: () => currentVal,
    setValue: (v) => {
      currentVal = v;
      slider.value = v;
      numInput.value = v;
    },
    setMin: (v) => {
      slider.min = v;
      numInput.min = v;
      if (currentVal < v) { currentVal = v; slider.value = v; numInput.value = v; onChange(v); }
    },
    onChange: (fn) => { onChange = fn; },
    destroy: () => container.remove(),
  };
}

// ─── RangeInput ────────────────────────────────────────────────────────────

export function RangeInput(label, minBound, maxBound, step, value, onChange) {
  const container = document.createElement('div');
  container.className = 'editor-widget editor-range-input';

  const lbl = makeLabel(label);
  const row = document.createElement('div');
  row.className = 'editor-row';

  const isRange = Array.isArray(value);
  let rangeMode = isRange;
  let currentVal = isRange ? [...value] : value;

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'editor-btn editor-btn-subtle editor-range-toggle';
  toggleBtn.textContent = rangeMode ? '[R]' : '[F]';
  toggleBtn.title = rangeMode ? 'Range mode (click for fixed)' : 'Fixed mode (click for range)';

  const inputA = document.createElement('input');
  inputA.type = 'number';
  inputA.min = minBound;
  inputA.max = maxBound;
  inputA.step = step;
  inputA.className = 'editor-num-input';

  const separator = document.createElement('span');
  separator.textContent = ' — ';
  separator.className = 'editor-range-sep';
  separator.style.display = rangeMode ? '' : 'none';

  const inputB = document.createElement('input');
  inputB.type = 'number';
  inputB.min = minBound;
  inputB.max = maxBound;
  inputB.step = step;
  inputB.className = 'editor-num-input';
  inputB.style.display = rangeMode ? '' : 'none';

  function syncInputs() {
    if (rangeMode) {
      inputA.value = currentVal[0];
      inputB.value = currentVal[1];
    } else {
      inputA.value = currentVal;
    }
  }
  syncInputs();

  toggleBtn.addEventListener('click', () => {
    rangeMode = !rangeMode;
    toggleBtn.textContent = rangeMode ? '[R]' : '[F]';
    toggleBtn.title = rangeMode ? 'Range mode (click for fixed)' : 'Fixed mode (click for range)';
    separator.style.display = rangeMode ? '' : 'none';
    inputB.style.display = rangeMode ? '' : 'none';
    if (rangeMode) {
      const v = typeof currentVal === 'number' ? currentVal : parseFloat(inputA.value);
      currentVal = [v, v];
    } else {
      currentVal = Array.isArray(currentVal) ? currentVal[0] : currentVal;
    }
    syncInputs();
    onChange(currentVal);
  });

  inputA.addEventListener('change', () => {
    const v = Math.max(minBound, Math.min(maxBound, parseFloat(inputA.value) || minBound));
    if (rangeMode) {
      currentVal = [v, currentVal[1]];
    } else {
      currentVal = v;
    }
    syncInputs();
    onChange(currentVal);
  });

  inputB.addEventListener('change', () => {
    const v = Math.max(minBound, Math.min(maxBound, parseFloat(inputB.value) || minBound));
    currentVal = [currentVal[0], v];
    syncInputs();
    onChange(currentVal);
  });

  row.appendChild(toggleBtn);
  row.appendChild(inputA);
  row.appendChild(separator);
  row.appendChild(inputB);
  container.appendChild(lbl);
  container.appendChild(row);

  return {
    el: container,
    getValue: () => currentVal,
    setValue: (v) => {
      rangeMode = Array.isArray(v);
      currentVal = rangeMode ? [...v] : v;
      toggleBtn.textContent = rangeMode ? '[R]' : '[F]';
      separator.style.display = rangeMode ? '' : 'none';
      inputB.style.display = rangeMode ? '' : 'none';
      syncInputs();
    },
    onChange: (fn) => { onChange = fn; },
    destroy: () => container.remove(),
  };
}

// ─── RandomizableSlider ─────────────────────────────────────────────────────

/**
 * A NumberSlider that can flip to a [min,max] random range. Fixed mode shows the
 * slider + number input + an [F] toggle; clicking it switches to [R] range mode —
 * the slider is hidden and a second number input appears (min — max). `value` may
 * be a number or a [min,max] array; getValue()/onChange emit the same shape, which
 * is exactly what the engine's synth resolver consumes (Array → randomized per play).
 */
export function RandomizableSlider(label, min, max, step, value, onChange) {
  const container = document.createElement('div');
  container.className = 'editor-widget editor-number-slider editor-randomizable';

  const lbl = makeLabel(label);
  const row = document.createElement('div');
  row.className = 'editor-row';

  let rangeMode = Array.isArray(value);
  let currentVal = rangeMode ? [...value] : value;

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'editor-btn editor-btn-subtle editor-range-toggle';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = min; slider.max = max; slider.step = step;
  slider.className = 'editor-slider';

  const inputA = document.createElement('input');
  inputA.type = 'number';
  inputA.min = min; inputA.max = max; inputA.step = step;
  inputA.className = 'editor-num-input';

  const sep = document.createElement('span');
  sep.textContent = ' — ';
  sep.className = 'editor-range-sep';

  const inputB = document.createElement('input');
  inputB.type = 'number';
  inputB.min = min; inputB.max = max; inputB.step = step;
  inputB.className = 'editor-num-input';

  const clamp = (v) => Math.max(min, Math.min(max, isNaN(v) ? min : v));

  function syncDom() {
    toggleBtn.textContent = rangeMode ? '[R]' : '[F]';
    toggleBtn.title = rangeMode ? 'Random range (click for fixed)' : 'Fixed (click for random range)';
    slider.style.display = rangeMode ? 'none' : '';
    sep.style.display = rangeMode ? '' : 'none';
    inputB.style.display = rangeMode ? '' : 'none';
    if (rangeMode) {
      inputA.value = currentVal[0];
      inputB.value = currentVal[1];
    } else {
      inputA.value = currentVal;
      slider.value = Math.min(Math.max(currentVal, min), max);
    }
  }
  syncDom();

  slider.addEventListener('input', () => {
    currentVal = parseFloat(slider.value);
    inputA.value = currentVal;
    onChange(currentVal);
  });

  inputA.addEventListener('change', () => {
    const v = clamp(parseFloat(inputA.value));
    if (rangeMode) currentVal = [v, currentVal[1]];
    else { currentVal = v; slider.value = Math.min(v, max); }
    syncDom();
    onChange(currentVal);
  });

  inputB.addEventListener('change', () => {
    const v = clamp(parseFloat(inputB.value));
    currentVal = [currentVal[0], v];
    syncDom();
    onChange(currentVal);
  });

  toggleBtn.addEventListener('click', () => {
    rangeMode = !rangeMode;
    if (rangeMode) {
      const v = Array.isArray(currentVal) ? currentVal[0] : currentVal;
      currentVal = [v, v];
    } else {
      currentVal = Array.isArray(currentVal) ? currentVal[0] : currentVal;
    }
    syncDom();
    onChange(currentVal);
  });

  row.appendChild(toggleBtn);
  row.appendChild(slider);
  row.appendChild(inputA);
  row.appendChild(sep);
  row.appendChild(inputB);
  container.appendChild(lbl);
  container.appendChild(row);

  return {
    el: container,
    getValue: () => currentVal,
    setValue: (v) => {
      rangeMode = Array.isArray(v);
      currentVal = rangeMode ? [...v] : v;
      syncDom();
    },
    onChange: (fn) => { onChange = fn; },
    destroy: () => container.remove(),
  };
}

// ─── ColorInput ────────────────────────────────────────────────────────────

export function ColorInput(label, value, onChange) {
  const container = document.createElement('div');
  container.className = 'editor-widget editor-color-input';

  const lbl = makeLabel(label);
  const row = document.createElement('div');
  row.className = 'editor-row';

  const textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.value = value || '#000000';
  textInput.className = 'editor-num-input editor-color-text';

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = (value || '#000000').slice(0, 7);
  colorInput.className = 'editor-color-picker';

  let currentVal = value || '#000000';

  textInput.addEventListener('change', () => {
    currentVal = textInput.value;
    if (/^#[0-9a-fA-F]{6}$/.test(currentVal)) {
      colorInput.value = currentVal;
    }
    onChange(currentVal);
  });

  colorInput.addEventListener('input', () => {
    currentVal = colorInput.value;
    textInput.value = currentVal;
    onChange(currentVal);
  });

  row.appendChild(textInput);
  row.appendChild(colorInput);
  container.appendChild(lbl);
  container.appendChild(row);

  return {
    el: container,
    getValue: () => currentVal,
    setValue: (v) => {
      currentVal = v;
      textInput.value = v;
      if (/^#[0-9a-fA-F]{6}$/.test(v)) colorInput.value = v;
    },
    onChange: (fn) => { onChange = fn; },
    destroy: () => container.remove(),
  };
}

// ─── Select ────────────────────────────────────────────────────────────────

export function Select(label, options, value, onChange) {
  const container = document.createElement('div');
  container.className = 'editor-widget editor-select';

  const lbl = makeLabel(label);
  const select = document.createElement('select');
  select.className = 'editor-select-input';

  options.forEach(opt => {
    const o = document.createElement('option');
    o.value = typeof opt === 'object' ? opt.value : opt;
    o.textContent = typeof opt === 'object' ? opt.label : opt;
    select.appendChild(o);
  });
  select.value = value;

  let currentVal = value;
  select.addEventListener('change', () => {
    currentVal = select.value;
    onChange(currentVal);
  });

  container.appendChild(lbl);
  container.appendChild(select);

  return {
    el: container,
    getValue: () => currentVal,
    setValue: (v) => { currentVal = v; select.value = v; },
    onChange: (fn) => { onChange = fn; },
    setOptions: (opts) => {
      select.innerHTML = '';
      opts.forEach(opt => {
        const o = document.createElement('option');
        o.value = typeof opt === 'object' ? opt.value : opt;
        o.textContent = typeof opt === 'object' ? opt.label : opt;
        select.appendChild(o);
      });
    },
    destroy: () => container.remove(),
  };
}

// ─── TextInput ─────────────────────────────────────────────────────────────

export function TextInput(label, value, onChange) {
  const container = document.createElement('div');
  container.className = 'editor-widget editor-text-input';

  const lbl = makeLabel(label);
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value || '';
  input.className = 'editor-text-field';

  let currentVal = value || '';
  input.addEventListener('input', () => {
    currentVal = input.value;
    onChange(currentVal);
  });

  container.appendChild(lbl);
  container.appendChild(input);

  return {
    el: container,
    getValue: () => currentVal,
    setValue: (v) => { currentVal = v; input.value = v; },
    onChange: (fn) => { onChange = fn; },
    destroy: () => container.remove(),
  };
}

// ─── Toggle ────────────────────────────────────────────────────────────────

export function Toggle(label, value, onChange) {
  const container = document.createElement('div');
  container.className = 'editor-widget editor-toggle';

  const lbl = makeLabel(label);
  const btn = document.createElement('button');
  btn.className = 'editor-btn editor-toggle-btn';

  let currentVal = !!value;
  function update() {
    btn.textContent = currentVal ? 'ON' : 'OFF';
    btn.style.color = currentVal ? '#33ddcc' : '#7a6a4a';
    btn.style.borderColor = currentVal ? '#33ddcc' : '#5a4a30';
  }
  update();

  btn.addEventListener('click', () => {
    currentVal = !currentVal;
    update();
    onChange(currentVal);
  });

  container.appendChild(lbl);
  container.appendChild(btn);

  return {
    el: container,
    getValue: () => currentVal,
    setValue: (v) => { currentVal = !!v; update(); },
    onChange: (fn) => { onChange = fn; },
    destroy: () => container.remove(),
  };
}

// ─── Button ────────────────────────────────────────────────────────────────

export function Button(label, onClick, variant = 'primary') {
  const btn = document.createElement('button');
  btn.className = `editor-btn editor-btn-${variant}`;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return {
    el: btn,
    destroy: () => btn.remove(),
  };
}

// ─── ListEditor ────────────────────────────────────────────────────────────

export function ListEditor(label, items, renderItem, onAdd, onRemove, onReorder) {
  const container = document.createElement('div');
  container.className = 'editor-widget editor-list';

  const header = document.createElement('div');
  header.className = 'editor-list-header';
  const lbl = makeLabel(label);
  const addBtn = document.createElement('button');
  addBtn.className = 'editor-btn editor-btn-subtle';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', () => { onAdd(); refresh(); });
  header.appendChild(lbl);
  header.appendChild(addBtn);

  const listEl = document.createElement('div');
  listEl.className = 'editor-list-items';

  function refresh() {
    listEl.innerHTML = '';
    items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'editor-list-item';
      const content = renderItem(item, i);
      if (content instanceof HTMLElement) row.appendChild(content);
      const removeBtn = document.createElement('button');
      removeBtn.className = 'editor-btn editor-btn-danger editor-list-remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => { onRemove(i); refresh(); });
      row.appendChild(removeBtn);
      listEl.appendChild(row);
    });
  }
  refresh();

  container.appendChild(header);
  container.appendChild(listEl);

  return {
    el: container,
    refresh,
    destroy: () => container.remove(),
  };
}

// ─── PropertyGroup ─────────────────────────────────────────────────────────

export function PropertyGroup(label, children = []) {
  const container = document.createElement('div');
  container.className = 'editor-widget editor-prop-group';

  const header = document.createElement('div');
  header.className = 'editor-prop-group-header';
  header.textContent = label;
  let collapsed = false;

  const body = document.createElement('div');
  body.className = 'editor-prop-group-body';
  children.forEach(c => {
    if (c && c.el) body.appendChild(c.el);
    else if (c instanceof HTMLElement) body.appendChild(c);
  });

  header.addEventListener('click', () => {
    collapsed = !collapsed;
    body.style.display = collapsed ? 'none' : '';
    header.classList.toggle('collapsed', collapsed);
  });

  container.appendChild(header);
  container.appendChild(body);

  return {
    el: container,
    body,
    addChild: (child) => {
      if (child && child.el) body.appendChild(child.el);
      else if (child instanceof HTMLElement) body.appendChild(child);
    },
    destroy: () => container.remove(),
  };
}

// ─── TreeView ──────────────────────────────────────────────────────────────

export function TreeView(data, renderNode, onSelect) {
  const container = document.createElement('div');
  container.className = 'editor-tree';

  function buildNode(item, depth = 0) {
    const node = document.createElement('div');
    node.className = 'editor-tree-node';
    node.style.paddingLeft = (depth * 12) + 'px';

    const label = renderNode(item, depth);
    if (label instanceof HTMLElement) node.appendChild(label);
    else {
      const span = document.createElement('span');
      span.textContent = label;
      node.appendChild(span);
    }

    node.addEventListener('click', (e) => {
      e.stopPropagation();
      container.querySelectorAll('.editor-tree-node').forEach(n => n.classList.remove('selected'));
      node.classList.add('selected');
      onSelect(item);
    });

    if (item.children) {
      const childContainer = document.createElement('div');
      childContainer.className = 'editor-tree-children';
      item.children.forEach(child => childContainer.appendChild(buildNode(child, depth + 1)));
      node.appendChild(childContainer);
    }

    return node;
  }

  function rebuild(newData) {
    container.innerHTML = '';
    (Array.isArray(newData) ? newData : [newData]).forEach(item => {
      container.appendChild(buildNode(item));
    });
  }

  rebuild(data);

  return {
    el: container,
    rebuild,
    destroy: () => container.remove(),
  };
}

// ─── CoordEditor ──────────────────────────────────────────────────────────
// Edits an art coordinate value: number (r-relative) or object { base, w, h, r, <animVar> }

// Optional readout provider: fn(value) → a "= N px" hint shown under each CoordEditor.
// The art editor sets it (it knows the preview radius / space); generic editors leave it null.
let _coordReadout = null;
export function setCoordReadout(fn) { _coordReadout = fn; }

export function CoordEditor(label, value, availableVars, onChange) {
  const container = document.createElement('div');
  container.className = 'editor-widget coord-editor';

  const lbl = document.createElement('div');
  lbl.className = 'coord-editor-label';
  lbl.textContent = label;
  container.appendChild(lbl);

  const body = document.createElement('div');
  container.appendChild(body);

  const readoutEl = document.createElement('div');
  readoutEl.style.cssText = 'color:#5a4a30;font-size:9px;padding:1px 0 2px 4px;font-family:monospace;';
  container.appendChild(readoutEl);
  function updateReadout() { readoutEl.textContent = _coordReadout ? _coordReadout(value) : ''; }

  // Normalize: if value is a plain number, treat as { r: value }
  let isSimple = typeof value === 'number';

  function rebuild() {
    body.innerHTML = '';

    if (isSimple) {
      // Simple number mode: single slider for r-relative value
      const row = document.createElement('div');
      row.className = 'coord-component';
      const keyEl = document.createElement('span');
      keyEl.className = 'comp-key';
      keyEl.textContent = 'r';
      row.appendChild(keyEl);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = -3; slider.max = 3; slider.step = 0.05;
      slider.value = typeof value === 'number' ? value : 0;
      slider.className = 'editor-slider';

      const numInput = document.createElement('input');
      numInput.type = 'number';
      numInput.step = 0.05;
      numInput.value = typeof value === 'number' ? value : 0;
      numInput.className = 'editor-num-input';
      numInput.style.width = '60px';

      const sync = (v) => {
        value = parseFloat(v) || 0;
        onChange(value);
        updateReadout();
      };
      slider.addEventListener('input', () => { numInput.value = slider.value; sync(slider.value); });
      numInput.addEventListener('change', () => { slider.value = numInput.value; sync(numInput.value); });

      row.appendChild(slider);
      row.appendChild(numInput);

      // Button to switch to object mode
      const expandBtn = document.createElement('button');
      expandBtn.className = 'editor-btn editor-btn-subtle';
      expandBtn.style.cssText = 'padding:1px 4px;font-size:9px;';
      expandBtn.textContent = '{...}';
      expandBtn.title = 'Switch to multi-component coordinate';
      expandBtn.addEventListener('click', () => {
        value = { r: typeof value === 'number' ? value : 0 };
        isSimple = false;
        onChange(value);
        rebuild();
      });
      row.appendChild(expandBtn);
      body.appendChild(row);
    } else {
      // Object mode: one row per component
      let obj = typeof value === 'object' && value !== null ? { ...value } : {};
      // `base` is an unscaled absolute-px constant (wider range/step); r/w/h are
      // coefficients of the radius / space dims.
      const COORD_KEYS = ['base', 'r', 'w', 'h'];
      const bounds = { base: [-100, 100, 1], r: [-3, 3, 0.05], w: [-2, 2, 0.05], h: [-2, 2, 0.05] };

      for (const [key, val] of Object.entries(obj)) {
        const b = bounds[key] || [-5, 5, 0.05];
        const row = document.createElement('div');
        row.className = 'coord-component';

        const keyEl = document.createElement('span');
        keyEl.className = 'comp-key';
        keyEl.textContent = key;
        row.appendChild(keyEl);

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = b[0]; slider.max = b[1]; slider.step = b[2];
        slider.value = val;
        slider.className = 'editor-slider';

        const numInput = document.createElement('input');
        numInput.type = 'number';
        numInput.step = b[2];
        numInput.value = val;
        numInput.className = 'editor-num-input';
        numInput.style.width = '60px';

        const syncKey = key;
        const syncFn = (v) => {
          obj[syncKey] = parseFloat(v) || 0;
          value = obj;
          onChange(value);
          updateReadout();
        };
        slider.addEventListener('input', () => { numInput.value = slider.value; syncFn(slider.value); });
        numInput.addEventListener('change', () => { slider.value = numInput.value; syncFn(numInput.value); });

        row.appendChild(slider);
        row.appendChild(numInput);

        // Delete component button
        const delBtn = document.createElement('button');
        delBtn.className = 'comp-del';
        delBtn.textContent = '×';
        delBtn.addEventListener('click', () => {
          delete obj[syncKey];
          value = Object.keys(obj).length === 0 ? 0 : obj;
          isSimple = typeof value === 'number';
          onChange(value);
          rebuild();
        });
        row.appendChild(delBtn);
        body.appendChild(row);
      }

      // Add component button
      const existing = new Set(Object.keys(obj));
      const addable = [...COORD_KEYS, ...availableVars].filter(k => !existing.has(k));
      if (addable.length > 0) {
        const addRow = document.createElement('div');
        addRow.style.cssText = 'margin-top:2px;';
        const addSel = document.createElement('select');
        addSel.className = 'editor-select-input';
        addSel.style.cssText = 'width:auto;font-size:10px;padding:1px 4px;';
        const placeholder = document.createElement('option');
        placeholder.textContent = '+ Add...';
        placeholder.value = '';
        addSel.appendChild(placeholder);
        addable.forEach(k => {
          const o = document.createElement('option');
          o.value = k; o.textContent = k;
          addSel.appendChild(o);
        });
        addSel.addEventListener('change', () => {
          if (addSel.value) {
            obj[addSel.value] = 0;
            value = obj;
            onChange(value);
            rebuild();
          }
        });
        addRow.appendChild(addSel);
        body.appendChild(addRow);
      }
    }
    updateReadout();
  }

  rebuild();

  return {
    el: container,
    getValue: () => value,
    setValue: (v) => { value = v; isSimple = typeof v === 'number'; rebuild(); },
    destroy: () => container.remove(),
  };
}

// ─── TagListEditor ────────────────────────────────────────────────────────
// Edits an array of string tags (e.g., activeStates, visibleStates)

export function TagListEditor(label, tags, allOptions, onChange) {
  const container = document.createElement('div');
  container.className = 'editor-widget';

  const lbl = makeLabel(label);
  container.appendChild(lbl);

  const body = document.createElement('div');
  body.className = 'tag-list';
  container.appendChild(body);

  function rebuild() {
    body.innerHTML = '';

    for (let i = 0; i < tags.length; i++) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = tags[i];
      const removeBtn = document.createElement('span');
      removeBtn.className = 'tag-remove';
      removeBtn.textContent = '×';
      const idx = i;
      removeBtn.addEventListener('click', () => {
        tags.splice(idx, 1);
        onChange(tags);
        rebuild();
      });
      chip.appendChild(removeBtn);
      body.appendChild(chip);
    }

    // Add button
    const available = allOptions.filter(o => !tags.includes(o));
    if (available.length > 0) {
      const addBtn = document.createElement('button');
      addBtn.className = 'tag-add-btn';
      addBtn.textContent = '+';
      addBtn.addEventListener('click', () => {
        // Replace with select
        addBtn.remove();
        const sel = document.createElement('select');
        sel.className = 'editor-select-input';
        sel.style.cssText = 'width:auto;font-size:10px;padding:1px 4px;';
        const placeholder = document.createElement('option');
        placeholder.textContent = 'Select...';
        placeholder.value = '';
        sel.appendChild(placeholder);
        available.forEach(o => {
          const opt = document.createElement('option');
          opt.value = o; opt.textContent = o;
          sel.appendChild(opt);
        });
        sel.addEventListener('change', () => {
          if (sel.value) {
            tags.push(sel.value);
            onChange(tags);
          }
          rebuild();
        });
        sel.addEventListener('blur', () => rebuild());
        body.appendChild(sel);
        sel.focus();
      });
      body.appendChild(addBtn);
    }
  }

  rebuild();

  return {
    el: container,
    getValue: () => tags,
    setValue: (t) => { tags.length = 0; tags.push(...t); rebuild(); },
    rebuild,
    destroy: () => container.remove(),
  };
}
