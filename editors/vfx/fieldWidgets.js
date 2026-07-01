// Reusable field widgets for the VFX editor's layer/property panel: the small
// button + widget-append helpers, the animatable (static/animated/oscillating)
// number widget, the color / gradient / shadow editors, and the per-state override
// block. Split out of vfxEditor.js. These are parameterized (they take the target
// object + a `setLayer` callback) and never read the editor's module state — the
// only coordinator they need is a full props rebuild, injected via setRebuild() so
// this module doesn't import back into the entry (same idiom as setCoordReadout).

import { NumberSlider, ColorInput, PropertyGroup, Select, Toggle } from '/editors/shared/index.js';

let _rebuild = () => {};
/** Wire the props-panel rebuild (== the entry's buildPropsPanel) into the widgets. */
export function setRebuild(fn) { _rebuild = fn; }

export function mkBtn(text, onClick, className) {
  const btn = document.createElement('button');
  btn.className = className || 'editor-btn editor-btn-subtle';
  btn.textContent = text;
  btn.style.fontSize = '11px';
  btn.addEventListener('click', onClick);
  return btn;
}

export function addWidgetTo(parent, widget) {
  parent.appendChild(widget.el);
}

export function buildAnimatableWidget(parent, label, layer, field, min, max, step, setLayer) {
  const val = layer[field];
  const group = PropertyGroup(label);
  parent.appendChild(group.el);

  // Determine current mode
  let mode = 'static';
  if (val && typeof val === 'object') {
    if ('from' in val) mode = 'animated';
    else if ('base' in val) mode = 'oscillating';
  }

  const modeSelect = Select('Mode', [
    { value: 'static', label: 'Static' },
    { value: 'animated', label: 'Animated' },
    { value: 'oscillating', label: 'Oscillating' },
  ], mode, newMode => {
    if (newMode === 'static') {
      const current = typeof val === 'number' ? val : (val?.from ?? val?.base ?? 0.5);
      layer[field] = current;
    } else if (newMode === 'animated') {
      const current = typeof val === 'number' ? val : (val?.from ?? val?.base ?? 0);
      layer[field] = { from: current, to: 0 };
    } else if (newMode === 'oscillating') {
      const current = typeof val === 'number' ? val : (val?.base ?? val?.from ?? 0.5);
      layer[field] = { base: current, amplitude: 0.2, freq: 0.001 };
    }
    setLayer(field, layer[field]);
    _rebuild();
  });
  group.body.appendChild(modeSelect.el);

  if (mode === 'static') {
    const v = typeof val === 'number' ? val : 0;
    addWidgetTo(group.body, NumberSlider('Value', min, max, step, v, nv => setLayer(field, nv)));
  } else if (mode === 'animated') {
    addWidgetTo(group.body, NumberSlider('From', min, max, step, val.from ?? 0, nv => { val.from = nv; setLayer(field, { ...val }); }));
    addWidgetTo(group.body, NumberSlider('To', min, max, step, val.to ?? 0, nv => { val.to = nv; setLayer(field, { ...val }); }));

    // Modulate toggle
    const hasMod = !!val.modulate;
    const modToggle = Toggle('Modulate', hasMod, v => {
      if (v) val.modulate = { freq: 10, amp: 0.1 };
      else delete val.modulate;
      setLayer(field, { ...val });
      _rebuild();
    });
    group.body.appendChild(modToggle.el);

    if (hasMod) {
      addWidgetTo(group.body, NumberSlider('Mod Freq', 0.1, 100, 0.1, val.modulate.freq || 10, nv => { val.modulate.freq = nv; setLayer(field, { ...val }); }));
      addWidgetTo(group.body, NumberSlider('Mod Amp', 0, 1, 0.01, val.modulate.amp || 0, nv => { val.modulate.amp = nv; setLayer(field, { ...val }); }));
    }
  } else if (mode === 'oscillating') {
    addWidgetTo(group.body, NumberSlider('Base', min, max, step, val.base ?? 0, nv => { val.base = nv; setLayer(field, { ...val }); }));
    addWidgetTo(group.body, NumberSlider('Amplitude', 0, max, step, val.amplitude ?? 0, nv => { val.amplitude = nv; setLayer(field, { ...val }); }));
    addWidgetTo(group.body, NumberSlider('Freq', 0.0001, 0.1, 0.0001, val.freq ?? 0.001, nv => { val.freq = nv; setLayer(field, { ...val }); }));
  }
}

// ─── Color widget ────────────────────────────────────────────────────────
// Handles string or {local, remote} entity color

export function buildColorWidget(parent, label, layer, field, setLayer) {
  const val = layer[field];
  const group = PropertyGroup(label);
  parent.appendChild(group.el);

  const isEntity = val && typeof val === 'object' && ('local' in val || 'remote' in val);

  const modeSelect = Select('Mode', [
    { value: 'static', label: 'Static' },
    { value: 'entity', label: 'Local/Remote' },
  ], isEntity ? 'entity' : 'static', newMode => {
    if (newMode === 'static') {
      layer[field] = typeof val === 'string' ? val : (val?.local || '#ffffff');
    } else {
      layer[field] = { local: typeof val === 'string' ? val : '#33aaaa', remote: '#2288aa' };
    }
    setLayer(field, layer[field]);
    _rebuild();
  });
  group.body.appendChild(modeSelect.el);

  if (isEntity) {
    addWidgetTo(group.body, ColorInput('Local', val.local || '#ffffff', nv => { val.local = nv; setLayer(field, { ...val }); }));
    addWidgetTo(group.body, ColorInput('Remote', val.remote || '#ffffff', nv => { val.remote = nv; setLayer(field, { ...val }); }));
  } else {
    addWidgetTo(group.body, ColorInput('Color', typeof val === 'string' ? val : '#ffffff', nv => setLayer(field, nv)));
  }
}

// ─── Gradient editor ──────────────────────────────────────────────────────

export function buildGradientEditor(parent, layer, setLayer) {
  const group = PropertyGroup('Gradient Stops');
  parent.appendChild(group.el);

  const stops = layer.gradient || [];

  stops.forEach((s, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:4px;align-items:center;margin:2px 0;';
    const offIn = document.createElement('input');
    offIn.type = 'number'; offIn.step = '0.1'; offIn.min = '0'; offIn.max = '1'; offIn.value = s.offset;
    offIn.className = 'editor-num-input'; offIn.style.width = '45px';
    const colIn = document.createElement('input');
    colIn.type = 'text'; colIn.value = s.color;
    colIn.className = 'editor-num-input'; colIn.style.width = '120px';
    const rmBtn = document.createElement('button');
    rmBtn.className = 'editor-btn editor-btn-danger'; rmBtn.textContent = '×'; rmBtn.style.fontSize = '10px';

    offIn.addEventListener('change', () => { stops[i].offset = parseFloat(offIn.value) || 0; setLayer('gradient', [...stops]); });
    colIn.addEventListener('change', () => { stops[i].color = colIn.value; setLayer('gradient', [...stops]); });
    rmBtn.addEventListener('click', () => { stops.splice(i, 1); setLayer('gradient', stops.length ? [...stops] : undefined); _rebuild(); });

    row.append(offIn, colIn, rmBtn);
    group.body.appendChild(row);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'editor-btn editor-btn-subtle'; addBtn.textContent = '+ Add Stop'; addBtn.style.fontSize = '10px';
  addBtn.addEventListener('click', () => {
    if (!layer.gradient) layer.gradient = [];
    layer.gradient.push({ offset: 1, color: 'rgba(0,0,0,0)' });
    setLayer('gradient', [...layer.gradient]);
    _rebuild();
  });
  group.body.appendChild(addBtn);
}

// ─── Shadow editor ────────────────────────────────────────────────────────

export function buildShadowEditor(parent, layer, setLayer) {
  const group = PropertyGroup('Shadow');
  parent.appendChild(group.el);

  const shadow = layer.shadow || { color: 'transparent', blur: 0 };

  // Shadow color — support "$color" reference
  const colorVal = shadow.color || 'transparent';
  const isRef = colorVal === '$color';

  const refToggle = Toggle('Use Layer Color', isRef, v => {
    shadow.color = v ? '$color' : '#ffffff';
    setLayer('shadow', { ...shadow });
    _rebuild();
  });
  group.body.appendChild(refToggle.el);

  if (!isRef) {
    addWidgetTo(group.body, ColorInput('Color', colorVal, nv => { shadow.color = nv; setLayer('shadow', { ...shadow }); }));
  }

  // Shadow blur — can be animatable
  const blurVal = shadow.blur;
  if (typeof blurVal === 'object' && 'base' in blurVal) {
    addWidgetTo(group.body, NumberSlider('Blur Base', 0, 60, 1, blurVal.base || 0, nv => { shadow.blur = { ...blurVal, base: nv }; setLayer('shadow', { ...shadow }); }));
    addWidgetTo(group.body, NumberSlider('Blur Amplitude', 0, 30, 1, blurVal.amplitude || 0, nv => { shadow.blur = { ...blurVal, amplitude: nv }; setLayer('shadow', { ...shadow }); }));
    addWidgetTo(group.body, NumberSlider('Blur Freq', 0.0001, 0.1, 0.0001, blurVal.freq || 0.001, nv => { shadow.blur = { ...blurVal, freq: nv }; setLayer('shadow', { ...shadow }); }));
  } else {
    addWidgetTo(group.body, NumberSlider('Blur', 0, 60, 1, typeof blurVal === 'number' ? blurVal : 0, nv => { shadow.blur = nv; setLayer('shadow', { ...shadow }); }));
  }
}

// ─── State overrides (persistent effects) ─────────────────────────────────

export function buildStateOverrides(parent, layer, states, setLayer) {
  const group = PropertyGroup('State Overrides');
  parent.appendChild(group.el);

  if (!layer.stateOverrides) layer.stateOverrides = {};

  for (const state of states) {
    const overrides = layer.stateOverrides[state] || {};
    const stateGroup = PropertyGroup(state);
    group.body.appendChild(stateGroup.el);

    const hasOverride = !!layer.stateOverrides[state];
    const enableToggle = Toggle('Override', hasOverride, v => {
      if (v) layer.stateOverrides[state] = {};
      else delete layer.stateOverrides[state];
      setLayer('stateOverrides', { ...layer.stateOverrides });
      _rebuild();
    });
    stateGroup.body.appendChild(enableToggle.el);

    if (hasOverride) {
      // Show overridable properties based on primitive type
      const info = document.createElement('div');
      info.style.cssText = 'color:var(--ed-muted);font-size:10px;margin:4px 0;';
      info.textContent = 'Override fields: color, alpha, shadow, lineWidth';
      stateGroup.body.appendChild(info);

      // Color override
      if (overrides.color !== undefined) {
        addWidgetTo(stateGroup.body, ColorInput('Color', overrides.color, v => { overrides.color = v; setLayer('stateOverrides', { ...layer.stateOverrides }); }));
      } else {
        stateGroup.body.appendChild(mkBtn('+ Color', () => { overrides.color = '#cc3333'; layer.stateOverrides[state] = overrides; setLayer('stateOverrides', { ...layer.stateOverrides }); _rebuild(); }));
      }

      // Alpha override
      if (overrides.alpha !== undefined) {
        buildAnimatableWidget(stateGroup.body, 'Alpha', overrides, 'alpha', 0, 1, 0.01, (f, v) => { overrides[f] = v; setLayer('stateOverrides', { ...layer.stateOverrides }); });
      } else {
        stateGroup.body.appendChild(mkBtn('+ Alpha', () => { overrides.alpha = 0.5; layer.stateOverrides[state] = overrides; setLayer('stateOverrides', { ...layer.stateOverrides }); _rebuild(); }));
      }

      // Shadow override
      if (overrides.shadow !== undefined) {
        const sGroup = PropertyGroup('Shadow Override');
        stateGroup.body.appendChild(sGroup.el);
        addWidgetTo(sGroup.body, ColorInput('Color', overrides.shadow.color || '#cc3333', v => { overrides.shadow.color = v; setLayer('stateOverrides', { ...layer.stateOverrides }); }));
        addWidgetTo(sGroup.body, NumberSlider('Blur', 0, 60, 1, typeof overrides.shadow.blur === 'number' ? overrides.shadow.blur : 10, v => { overrides.shadow.blur = v; setLayer('stateOverrides', { ...layer.stateOverrides }); }));
      } else {
        stateGroup.body.appendChild(mkBtn('+ Shadow', () => { overrides.shadow = { color: '#cc3333', blur: 10 }; layer.stateOverrides[state] = overrides; setLayer('stateOverrides', { ...layer.stateOverrides }); _rebuild(); }));
      }
    }
  }
}
