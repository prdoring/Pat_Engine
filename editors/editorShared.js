// Shared editor widgets, SaveManager, and PreviewCanvas for all editor tabs.
// All widgets return { el, getValue, setValue, onChange, destroy }.

// ─── SaveManager ───────────────────────────────────────────────────────────

export class SaveManager {
  constructor(filename) {
    this._filename = filename;
    this._dirty = false;
    this._onDirtyChange = [];
    this._statusEl = null;
    this._saveBtn = null;
  }

  markDirty() {
    if (!this._dirty) {
      this._dirty = true;
      this._notify();
    }
  }

  markClean() {
    if (this._dirty) {
      this._dirty = false;
      this._notify();
    }
  }

  isDirty() { return this._dirty; }

  onDirtyChange(fn) { this._onDirtyChange.push(fn); }

  _notify() {
    this._onDirtyChange.forEach(fn => fn(this._dirty));
    if (this._statusEl) {
      this._statusEl.textContent = this._dirty ? 'Unsaved' : 'Saved';
      this._statusEl.style.color = this._dirty ? '#cc4422' : '#33aa88';
    }
    if (this._saveBtn) {
      this._saveBtn.style.opacity = this._dirty ? '1' : '0.4';
    }
  }

  async save(data) {
    const resp = await fetch('/api/save-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: this._filename, data }),
    });
    const result = await resp.json();
    if (!resp.ok || !result.ok) throw new Error(result.error || 'Save failed');
    this.markClean();
    return result;
  }

  getSaveButton(onSave) {
    const btn = document.createElement('button');
    btn.className = 'editor-btn editor-btn-primary';
    btn.textContent = 'Save';
    btn.style.opacity = this._dirty ? '1' : '0.4';
    btn.addEventListener('click', () => onSave());
    this._saveBtn = btn;
    return btn;
  }

  getStatusIndicator() {
    const el = document.createElement('span');
    el.className = 'editor-save-status';
    el.textContent = this._dirty ? 'Unsaved' : 'Saved';
    el.style.color = this._dirty ? '#cc4422' : '#33aa88';
    this._statusEl = el;
    return el;
  }
}

// ─── PreviewCanvas ─────────────────────────────────────────────────────────

export class PreviewCanvas {
  constructor(container, options = {}) {
    const {
      width = 400, height = 300,
      background = '#060d18',
      grid = false,
      pannable = true,
      zoomable = true,
      fillContainer = false,
    } = options;

    this._bg = background;
    this._showGrid = grid;
    this._pannable = pannable;
    this._zoomable = zoomable;
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
    this._dragging = false;
    this._lastMouse = null;
    this._onPanCbs = [];
    this._onZoomCbs = [];
    this._resizeObserver = null;

    this._canvas = document.createElement('canvas');
    this._canvas.className = 'editor-preview-canvas';
    this._ctx = this._canvas.getContext('2d');

    if (fillContainer) {
      this._canvas.style.cssText = 'width:100%;height:100%;display:block;';
      const resize = () => {
        const rect = container.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          this._canvas.width = rect.width;
          this._canvas.height = rect.height;
        }
      };
      resize();
      this._resizeObserver = new ResizeObserver(resize);
      this._resizeObserver.observe(container);
    } else {
      this._canvas.width = width;
      this._canvas.height = height;
    }

    if (pannable) {
      this._canvas.addEventListener('mousedown', (e) => {
        if (e.button === 1 || e.shiftKey) {
          this._dragging = true;
          this._lastMouse = { x: e.clientX, y: e.clientY };
          e.preventDefault();
        }
      });
      this._canvas.addEventListener('mousemove', (e) => {
        if (!this._dragging) return;
        const dx = e.clientX - this._lastMouse.x;
        const dy = e.clientY - this._lastMouse.y;
        this._panX += dx;
        this._panY += dy;
        this._lastMouse = { x: e.clientX, y: e.clientY };
        this._onPanCbs.forEach(fn => fn(this._panX, this._panY));
      });
      const stopDrag = () => { this._dragging = false; };
      this._canvas.addEventListener('mouseup', stopDrag);
      this._canvas.addEventListener('mouseleave', stopDrag);
    }

    if (zoomable) {
      this._canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        this._zoom = Math.max(0.1, Math.min(20, this._zoom * delta));
        this._onZoomCbs.forEach(fn => fn(this._zoom));
      }, { passive: false });
    }

    container.appendChild(this._canvas);
  }

  get canvas() { return this._canvas; }
  getCtx() { return this._ctx; }
  getZoom() { return this._zoom; }
  getPan() { return { x: this._panX, y: this._panY }; }

  setSize(w, h) {
    this._canvas.width = w;
    this._canvas.height = h;
  }

  clear() {
    const { width, height } = this._canvas;
    this._ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._ctx.fillStyle = this._bg;
    this._ctx.fillRect(0, 0, width, height);
  }

  applyTransform() {
    const { width, height } = this._canvas;
    this._ctx.setTransform(1, 0, 0, 1, 0, 0);
    this._ctx.translate(width / 2 + this._panX, height / 2 + this._panY);
    this._ctx.scale(this._zoom, this._zoom);
  }

  drawGrid(step = 10, color = 'rgba(212,160,86,0.08)') {
    if (!this._showGrid) return;
    const ctx = this._ctx;
    const { width, height } = this._canvas;
    const scaledStep = step * this._zoom;
    if (scaledStep < 4) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    const ox = (width / 2 + this._panX) % scaledStep;
    const oy = (height / 2 + this._panY) % scaledStep;
    for (let x = ox; x < width; x += scaledStep) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = oy; y < height; y += scaledStep) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    // Draw axes
    ctx.strokeStyle = 'rgba(212,160,86,0.2)';
    ctx.lineWidth = 1;
    const cx = width / 2 + this._panX;
    const cy = height / 2 + this._panY;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(width, cy); ctx.stroke();
    ctx.restore();
  }

  worldToScreen(x, y) {
    const { width, height } = this._canvas;
    return {
      x: width / 2 + this._panX + x * this._zoom,
      y: height / 2 + this._panY + y * this._zoom,
    };
  }

  screenToWorld(sx, sy) {
    const { width, height } = this._canvas;
    return {
      x: (sx - width / 2 - this._panX) / this._zoom,
      y: (sy - height / 2 - this._panY) / this._zoom,
    };
  }

  resetView() {
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
  }

  setZoom(z) { this._zoom = Math.max(0.1, Math.min(20, z)); }
  setGrid(show) { this._showGrid = show; }

  onPan(fn) { this._onPanCbs.push(fn); }
  onZoom(fn) { this._onZoomCbs.push(fn); }

  destroy() {
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this._canvas.remove();
  }
}

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
// Edits an art coordinate value: number (r-relative) or object { w, h, r, <animVar> }

export function CoordEditor(label, value, availableVars, onChange) {
  const container = document.createElement('div');
  container.className = 'editor-widget coord-editor';

  const lbl = document.createElement('div');
  lbl.className = 'coord-editor-label';
  lbl.textContent = label;
  container.appendChild(lbl);

  const body = document.createElement('div');
  container.appendChild(body);

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
      const COORD_KEYS = ['w', 'h', 'r'];
      const bounds = { w: [-2, 2, 0.05], h: [-2, 2, 0.05], r: [-3, 3, 0.05] };

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
        };
        slider.addEventListener('input', () => { numInput.value = slider.value; syncFn(slider.value); });
        numInput.addEventListener('change', () => { slider.value = numInput.value; syncFn(numInput.value); });

        row.appendChild(slider);
        row.appendChild(numInput);

        // Delete component button
        const delBtn = document.createElement('button');
        delBtn.className = 'comp-del';
        delBtn.textContent = '\u00d7';
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
      removeBtn.textContent = '\u00d7';
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

// ─── Resizer ────────────────────────────────────────────────────────────────
// Draggable divider between flex siblings, like VS Code split panes.
// direction: 'horizontal' (col-resize, adjusts width) or 'vertical' (row-resize, adjusts height/flex-basis)
// targetEl: the element whose size to adjust (the one BEFORE the resizer)
// options: { min, max, prop, invert } — min/max in px, prop = 'width'|'flexBasis'|'height',
// invert = true for panels AFTER the resizer (dragging left = grow)

export function createResizer(direction, targetEl, options = {}) {
  const isHorizontal = direction === 'horizontal';
  const {
    min = 80,
    max = 800,
    prop = isHorizontal ? 'width' : 'flexBasis',
    invert = false,
    onResize,
  } = options;

  const el = document.createElement('div');
  el.className = `editor-resizer editor-resizer-${direction}`;

  let startPos = 0;
  let startSize = 0;
  let dragging = false;

  function getSize() {
    return isHorizontal ? targetEl.getBoundingClientRect().width : targetEl.getBoundingClientRect().height;
  }

  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startPos = isHorizontal ? e.clientX : e.clientY;
    startSize = getSize();
    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    el.classList.add('active');
  });

  function onMouseMove(e) {
    if (!dragging) return;
    const raw = (isHorizontal ? e.clientX : e.clientY) - startPos;
    const delta = invert ? -raw : raw;
    const newSize = Math.max(min, Math.min(max, startSize + delta));
    targetEl.style[prop] = newSize + 'px';
    if (prop === 'flexBasis') {
      targetEl.style.flexGrow = '0';
      targetEl.style.flexShrink = '0';
    }
    if (onResize) onResize(newSize);
  }

  function onMouseUp() {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    el.classList.remove('active');
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  return {
    el,
    destroy: () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      el.remove();
    },
  };
}

// ─── PreviewCamera ──────────────────────────────────────────────────────────
// Minimal camera for editor previews. Centers the world at the canvas midpoint,
// optionally applies zoom. Used by sequencesEditor and vfxEditor.

export class EditorPreviewCamera {
  constructor(canvas) {
    this._canvas = canvas;
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
  }

  setZoom(z) { this._zoom = z; }
  getZoom() { return this._zoom; }
  setPan(x, y) { this._panX = x; this._panY = y; }
  getPan() { return { x: this._panX, y: this._panY }; }

  resetView() { this._zoom = 1; this._panX = 0; this._panY = 0; }

  worldToScreen(x, y) {
    return {
      sx: this._canvas.width / 2 + this._panX + x * this._zoom,
      sy: this._canvas.height / 2 + this._panY + y * this._zoom,
    };
  }

  worldToScreenWrapped(x, y) { return this.worldToScreen(x, y); }

  getVisibleBounds() {
    const hw = this._canvas.width / (2 * this._zoom);
    const hh = this._canvas.height / (2 * this._zoom);
    const cx = -this._panX / this._zoom;
    const cy = -this._panY / this._zoom;
    return { left: cx - hw, right: cx + hw, top: cy - hh, bottom: cy + hh };
  }

  /** Attach pan (middle/shift+drag) and zoom (wheel) handlers to a canvas element. */
  attachControls(canvasEl) {
    let dragging = false;
    let lastMouse = null;

    canvasEl.addEventListener('mousedown', (e) => {
      if (e.button === 1 || e.shiftKey) {
        dragging = true;
        lastMouse = { x: e.clientX, y: e.clientY };
        e.preventDefault();
      }
    });
    canvasEl.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      this._panX += e.clientX - lastMouse.x;
      this._panY += e.clientY - lastMouse.y;
      lastMouse = { x: e.clientX, y: e.clientY };
    });
    const stopDrag = () => { dragging = false; };
    canvasEl.addEventListener('mouseup', stopDrag);
    canvasEl.addEventListener('mouseleave', stopDrag);

    canvasEl.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      this._zoom = Math.max(0.1, Math.min(20, this._zoom * delta));
    }, { passive: false });
  }
}
