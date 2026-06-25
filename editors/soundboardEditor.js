// Soundboard Editor — full CRUD sound editor with synth sliders, file editing,
// randomization ranges, repeat preview, and save to sfx.json.

import { SOUND_CONFIG } from '/engine/data/sounds.js';
import { SoundManager } from '/engine/audio/SoundManager.js';
import {
  SaveManager,
  NumberSlider, ColorInput, Select, TextInput, Toggle, Button,
  PropertyGroup, createResizer,
} from './editorShared.js';

// ─── State ─────────────────────────────────────────────────────────────────

let container = null;
let soundManager = null;
let saveManager = null;
let workingData = null;  // deep copy of sfx.json sounds
let categories = [];
let selectedId = null;
let repeatTimer = null;
let repeatEnabled = false;
let repeatInterval = 500;
let autoPlayEnabled = false;
let activeLoopHandle = null;
let availableSfxFiles = []; // populated from /api/sfx-files

// DOM refs
let sidebarListEl = null;
let searchInput = null;
let propsEl = null;
let previewControlsEl = null;
let waveformCanvas = null;
let waveformCtx = null;
let waveformAnimId = null;
let synthCanvas = null;
let synthCtx = null;

// ─── Mount / Unmount ───────────────────────────────────────────────────────

export function mount(el) {
  container = el;
  workingData = JSON.parse(JSON.stringify(SOUND_CONFIG));
  categories = [...new Set(Object.values(workingData).map(s => s.category))].sort();

  soundManager = new SoundManager();
  soundManager.init();

  // Load available SFX files for file layer picker
  fetch('/api/sfx-files')
    .then(r => r.ok ? r.json() : [])
    .then(files => { availableSfxFiles = files; })
    .catch(() => {});

  saveManager = new SaveManager('sfx.json');
  saveManager.onDirtyChange(dirty => {
    window.editorSetUnsaved?.('soundboard', dirty);
  });

  buildUI();
}

export function unmount() {
  stopAllPlayback();
  stopWaveformLoop();
  container = null;
}

export function save() { doSave(); }
export function isDirty() { return saveManager?.isDirty() ?? false; }

// ─── UI Construction ───────────────────────────────────────────────────────

function buildUI() {
  container.innerHTML = '';

  // Sidebar
  const sidebar = document.createElement('div');
  sidebar.className = 'editor-sidebar';

  // Search
  const searchWrap = document.createElement('div');
  searchWrap.className = 'editor-sidebar-search';
  searchInput = document.createElement('input');
  searchInput.placeholder = 'Search sounds...';
  searchInput.addEventListener('input', renderSidebar);
  searchWrap.appendChild(searchInput);
  sidebar.appendChild(searchWrap);

  // Actions
  const actions = document.createElement('div');
  actions.className = 'editor-sidebar-actions';
  const newBtn = Button('+ New Sound', () => createNewSound(), 'primary');
  actions.appendChild(newBtn.el);
  sidebar.appendChild(actions);

  // List
  sidebarListEl = document.createElement('div');
  sidebarListEl.className = 'editor-sidebar-list';
  sidebar.appendChild(sidebarListEl);

  // Footer (delete)
  const footer = document.createElement('div');
  footer.className = 'editor-sidebar-footer';
  const delBtn = Button('Delete Sound', () => deleteSound(), 'danger');
  footer.appendChild(delBtn.el);
  const dupBtn = Button('Duplicate', () => duplicateSound(), 'subtle');
  dupBtn.el.style.marginLeft = '4px';
  footer.appendChild(dupBtn.el);
  sidebar.appendChild(footer);

  // Main area
  const main = document.createElement('div');
  main.className = 'editor-main';

  // Save header
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
  header.appendChild(saveManager.getStatusIndicator());
  header.appendChild(saveManager.getSaveButton(() => doSave()));
  main.appendChild(header);

  // Preview area (resizable)
  const previewArea = document.createElement('div');
  previewArea.style.cssText = 'flex:0 0 240px;display:flex;flex-direction:column;overflow:hidden;min-height:80px;';

  // Preview controls
  previewControlsEl = document.createElement('div');
  previewControlsEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px;border:1px solid #5a4a30;border-radius:4px;flex-shrink:0;';
  previewArea.appendChild(previewControlsEl);

  // Computed synth waveform preview
  synthCanvas = document.createElement('canvas');
  synthCanvas.width = 800;
  synthCanvas.height = 120;
  synthCanvas.style.cssText = 'width:100%;flex:1;min-height:40px;margin-top:8px;border:1px solid #5a4a30;border-radius:4px;background:#060d18;';
  synthCtx = synthCanvas.getContext('2d');
  previewArea.appendChild(synthCanvas);

  // Live audio waveform
  waveformCanvas = document.createElement('canvas');
  waveformCanvas.width = 600;
  waveformCanvas.height = 60;
  waveformCanvas.style.cssText = 'width:100%;height:50px;flex-shrink:0;margin-top:8px;border:1px solid #5a4a30;border-radius:4px;background:#060d18;';
  waveformCtx = waveformCanvas.getContext('2d');
  previewArea.appendChild(waveformCanvas);
  startWaveformLoop();

  main.appendChild(previewArea);
  main.appendChild(createResizer('vertical', previewArea, { min: 80, max: 600, prop: 'flexBasis', onResize: () => renderSynthWaveform() }).el);

  // Property panel
  propsEl = document.createElement('div');
  propsEl.className = 'editor-props';
  main.appendChild(propsEl);

  container.appendChild(sidebar);
  container.appendChild(createResizer('horizontal', sidebar, { min: 120, max: 400 }).el);
  container.appendChild(main);

  renderSidebar();
  buildPreviewControls();
}

// ─── Sidebar ───────────────────────────────────────────────────────────────

function renderSidebar() {
  sidebarListEl.innerHTML = '';
  const filter = (searchInput?.value || '').toLowerCase();
  const grouped = {};
  for (const [id, config] of Object.entries(workingData)) {
    if (filter && !id.toLowerCase().includes(filter)) continue;
    const cat = config.category || 'unknown';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(id);
  }

  for (const cat of categories) {
    const items = grouped[cat];
    if (!items || items.length === 0) continue;

    const catEl = document.createElement('div');
    catEl.className = 'editor-sidebar-category';

    const catHeader = document.createElement('div');
    catHeader.className = 'editor-sidebar-category-header';
    catHeader.innerHTML = `<span>\u25B8 ${cat}</span> <span class="count">(${items.length})</span>`;
    let expanded = true;

    const itemsContainer = document.createElement('div');

    catHeader.addEventListener('click', () => {
      expanded = !expanded;
      itemsContainer.style.display = expanded ? '' : 'none';
      catHeader.querySelector('span').textContent = `${expanded ? '\u25BE' : '\u25B8'} ${cat}`;
    });

    items.sort().forEach(id => {
      const item = document.createElement('div');
      item.className = 'editor-sidebar-item' + (id === selectedId ? ' selected' : '');
      item.textContent = id;
      item.addEventListener('click', () => selectSound(id));
      itemsContainer.appendChild(item);
    });

    catEl.appendChild(catHeader);
    catEl.appendChild(itemsContainer);
    sidebarListEl.appendChild(catEl);
  }
}

function selectSound(id) {
  stopAllPlayback();
  selectedId = id;
  renderSidebar();
  buildPreviewControls();
  buildPropertyPanel();
  renderSynthWaveform();
}

// ─── Preview Controls ──────────────────────────────────────────────────────

function buildPreviewControls() {
  previewControlsEl.innerHTML = '';
  if (!selectedId) {
    previewControlsEl.innerHTML = '<span style="color:#7a6a4a">Select a sound to preview</span>';
    return;
  }

  const config = workingData[selectedId];
  const isLoop = config.loop;

  // Play / Stop Loop button
  const playBtn = document.createElement('button');
  playBtn.className = 'editor-btn editor-btn-primary';
  playBtn.textContent = isLoop ? 'Play Loop' : 'Play \u25B6';
  playBtn.addEventListener('click', () => {
    if (isLoop && activeLoopHandle != null) {
      stopAllPlayback();
      playBtn.textContent = 'Play Loop';
    } else if (isLoop) {
      playLoopSound();
      playBtn.textContent = 'Stop Loop';
    } else {
      playOnce();
    }
  });
  previewControlsEl.appendChild(playBtn);

  // Stop button
  const stopBtn = Button('Stop', () => {
    stopAllPlayback();
    playBtn.textContent = isLoop ? 'Play Loop' : 'Play \u25B6';
  }, 'subtle');
  previewControlsEl.appendChild(stopBtn.el);

  // Repeat controls (not for loops)
  if (!isLoop) {
    const repeatToggle = document.createElement('button');
    repeatToggle.className = 'editor-btn ' + (repeatEnabled ? 'editor-btn-primary' : 'editor-btn-subtle');
    repeatToggle.textContent = repeatEnabled ? `Repeat \u21BB ${repeatInterval}ms` : 'Repeat \u21BB';
    repeatToggle.addEventListener('click', () => {
      repeatEnabled = !repeatEnabled;
      repeatToggle.className = 'editor-btn ' + (repeatEnabled ? 'editor-btn-primary' : 'editor-btn-subtle');
      repeatToggle.textContent = repeatEnabled ? `Repeat \u21BB ${repeatInterval}ms` : 'Repeat \u21BB';
      if (repeatEnabled) startRepeat();
      else stopRepeat();
    });
    previewControlsEl.appendChild(repeatToggle);

    const intervalSlider = document.createElement('input');
    intervalSlider.type = 'range';
    intervalSlider.min = 100;
    intervalSlider.max = 3000;
    intervalSlider.step = 50;
    intervalSlider.value = repeatInterval;
    intervalSlider.className = 'editor-slider';
    intervalSlider.style.width = '120px';
    intervalSlider.addEventListener('input', () => {
      repeatInterval = parseInt(intervalSlider.value);
      repeatToggle.textContent = repeatEnabled ? `Repeat \u21BB ${repeatInterval}ms` : 'Repeat \u21BB';
      if (repeatEnabled) { stopRepeat(); startRepeat(); }
    });
    previewControlsEl.appendChild(intervalSlider);
  }

  // Auto-play toggle
  const autoBtn = document.createElement('button');
  autoBtn.className = 'editor-btn ' + (autoPlayEnabled ? 'editor-btn-primary' : 'editor-btn-subtle');
  autoBtn.textContent = 'Auto-play';
  autoBtn.addEventListener('click', () => {
    autoPlayEnabled = !autoPlayEnabled;
    autoBtn.className = 'editor-btn ' + (autoPlayEnabled ? 'editor-btn-primary' : 'editor-btn-subtle');
  });
  previewControlsEl.appendChild(autoBtn);
}

// ─── Computed Synth Waveform ─────────────────────────────────────────────────

function oscillatorSample(type, phase) {
  // phase is 0..1 within one cycle
  switch (type) {
    case 'sine':     return Math.sin(phase * 2 * Math.PI);
    case 'square':   return phase < 0.5 ? 1 : -1;
    case 'sawtooth': return 2 * (phase - Math.floor(phase + 0.5));
    case 'triangle': return 4 * Math.abs(phase - 0.5) - 1;
    default:         return Math.sin(phase * 2 * Math.PI);
  }
}

function renderSynthWaveform() {
  if (!synthCanvas || !synthCtx) return;

  // Match canvas resolution to display size
  const rect = synthCanvas.getBoundingClientRect();
  if (rect.width > 0 && synthCanvas.width !== Math.floor(rect.width)) {
    synthCanvas.width = Math.floor(rect.width);
    synthCanvas.height = Math.floor(rect.height);
  }

  const w = synthCanvas.width;
  const h = synthCanvas.height;
  const ctx = synthCtx;
  ctx.clearRect(0, 0, w, h);

  if (!selectedId || !workingData[selectedId]) {
    ctx.fillStyle = '#7a6a4a';
    ctx.font = '12px monospace';
    ctx.fillText('Select a sound to see waveform', 12, h / 2 + 4);
    return;
  }

  const config = workingData[selectedId];
  const synth = config.synth;
  if (!synth) return;

  const layers = synth.layers || [{ type: synth.type || 'sine', freq: synth.freq || 440, gain: 1.0 }];
  const oscLayers = layers.filter(l => l.type !== 'file');
  if (oscLayers.length === 0) {
    ctx.fillStyle = '#7a6a4a';
    ctx.font = '12px monospace';
    ctx.fillText('File-only sound — no waveform to preview', 12, h / 2 + 4);
    return;
  }

  const isLoop = config.loop;
  const duration = isLoop ? 1.0 : (synth.duration ?? 0.5);
  const attack = isLoop ? 0 : (synth.attack ?? 0.01);
  const decay = isLoop ? 0 : (synth.decay ?? (duration - attack));

  // Determine how many cycles to show — enough to see the shape clearly
  const baseFreq = Math.min(...oscLayers.map(l => l.freq || 440));
  const totalCycles = isLoop ? Math.max(6, Math.min(16, baseFreq * 0.05)) : baseFreq * duration;
  const displayDuration = isLoop ? totalCycles / baseFreq : duration;

  // Compute samples
  const samples = new Float32Array(w);
  let maxAmp = 0;

  for (let px = 0; px < w; px++) {
    const t = (px / w) * displayDuration;
    const tNorm = t / displayDuration; // 0..1 across display

    // Envelope multiplier
    let env = 1.0;
    if (!isLoop) {
      if (t < attack) {
        env = attack > 0 ? t / attack : 1;
      } else {
        const decayT = t - attack;
        if (decay > 0) {
          env = Math.max(0.001, Math.pow(0.001, decayT / decay));
        }
      }
    }

    // LFO modulation
    let lfoMod = 1.0;
    if (synth.lfo) {
      const lfoFreq = synth.lfo.freq || 4;
      const lfoDepth = synth.lfo.depth || 0.3;
      lfoMod = 1.0 + lfoDepth * Math.sin(2 * Math.PI * lfoFreq * t);
    }

    // Sum oscillator layers
    let sample = 0;
    for (const layer of oscLayers) {
      const freq = layer.freq || 440;
      const freqEnd = layer.freqEnd;
      let f = freq;
      if (freqEnd && !isLoop) {
        // Exponential frequency sweep
        f = freq * Math.pow(freqEnd / freq, tNorm);
      }
      const phase = (f * t) % 1;
      const gain = layer.gain ?? 1.0;
      sample += oscillatorSample(layer.type || 'sine', phase) * gain;
    }

    samples[px] = sample * env * lfoMod;
    maxAmp = Math.max(maxAmp, Math.abs(samples[px]));
  }

  // Normalize
  const scale = maxAmp > 0 ? 1 / maxAmp : 1;
  const margin = 6;
  const drawH = h - margin * 2;

  // Draw center line
  ctx.strokeStyle = '#2a2a1a';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  // Draw envelope shape (background)
  if (!isLoop && (attack > 0 || decay > 0)) {
    ctx.fillStyle = 'rgba(51, 221, 204, 0.06)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    for (let px = 0; px < w; px++) {
      const t = (px / w) * displayDuration;
      let env = 1.0;
      if (t < attack) {
        env = attack > 0 ? t / attack : 1;
      } else {
        const decayT = t - attack;
        if (decay > 0) env = Math.max(0.001, Math.pow(0.001, decayT / decay));
      }
      ctx.lineTo(px, h / 2 - env * drawH / 2);
    }
    for (let px = w - 1; px >= 0; px--) {
      const t = (px / w) * displayDuration;
      let env = 1.0;
      if (t < attack) {
        env = attack > 0 ? t / attack : 1;
      } else {
        const decayT = t - attack;
        if (decay > 0) env = Math.max(0.001, Math.pow(0.001, decayT / decay));
      }
      ctx.lineTo(px, h / 2 + env * drawH / 2);
    }
    ctx.closePath();
    ctx.fill();
  }

  // Draw waveform
  ctx.strokeStyle = '#33ddcc';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let px = 0; px < w; px++) {
    const y = h / 2 - samples[px] * scale * drawH / 2;
    if (px === 0) ctx.moveTo(px, y);
    else ctx.lineTo(px, y);
  }
  ctx.stroke();

  // Labels
  ctx.fillStyle = '#5a4a30';
  ctx.font = '10px monospace';
  const freqLabel = oscLayers.map(l => `${l.type || 'sine'} ${l.freq || 440}Hz`).join(' + ');
  ctx.fillText(freqLabel, 6, 12);
  if (!isLoop) {
    ctx.fillText(`${duration.toFixed(2)}s  atk:${attack.toFixed(3)}  dec:${decay.toFixed(2)}`, 6, h - 4);
  } else {
    ctx.fillText('loop', 6, h - 4);
  }
  if (synth.lfo) {
    ctx.fillText(`LFO ${synth.lfo.freq || 4}Hz depth:${synth.lfo.depth || 0.3}`, w - 180, 12);
  }
}

// ─── Waveform Visualizer ────────────────────────────────────────────────────

function startWaveformLoop() {
  stopWaveformLoop();
  function draw() {
    waveformAnimId = requestAnimationFrame(draw);
    if (!waveformCanvas || !waveformCtx) return;

    // Match canvas resolution to display size
    const rect = waveformCanvas.getBoundingClientRect();
    if (rect.width > 0 && waveformCanvas.width !== Math.floor(rect.width)) {
      waveformCanvas.width = Math.floor(rect.width);
      waveformCanvas.height = Math.floor(rect.height);
    }

    const w = waveformCanvas.width;
    const h = waveformCanvas.height;
    waveformCtx.clearRect(0, 0, w, h);

    const analyser = soundManager?.analyser;
    if (!analyser) return;

    const bufLen = analyser.frequencyBinCount;
    const data = new Uint8Array(bufLen);
    analyser.getByteTimeDomainData(data);

    // Check if there's any signal (not just flat 128)
    let hasSignal = false;
    for (let i = 0; i < bufLen; i++) {
      if (data[i] < 126 || data[i] > 130) { hasSignal = true; break; }
    }

    // Draw center line
    waveformCtx.strokeStyle = '#2a2a1a';
    waveformCtx.lineWidth = 1;
    waveformCtx.beginPath();
    waveformCtx.moveTo(0, h / 2);
    waveformCtx.lineTo(w, h / 2);
    waveformCtx.stroke();

    if (!hasSignal) return;

    // Draw waveform
    waveformCtx.strokeStyle = '#33ddcc';
    waveformCtx.lineWidth = 1.5;
    waveformCtx.beginPath();

    const sliceWidth = w / bufLen;
    let x = 0;
    for (let i = 0; i < bufLen; i++) {
      const v = data[i] / 128.0;
      const y = (v * h) / 2;
      if (i === 0) waveformCtx.moveTo(x, y);
      else waveformCtx.lineTo(x, y);
      x += sliceWidth;
    }
    waveformCtx.stroke();
  }
  draw();
}

function stopWaveformLoop() {
  if (waveformAnimId) {
    cancelAnimationFrame(waveformAnimId);
    waveformAnimId = null;
  }
}

// ─── Playback ──────────────────────────────────────────────────────────────

function playOnce() {
  if (!selectedId) return;
  soundManager.resume();
  const config = workingData[selectedId];
  if (config.synth) {
    soundManager.playRawSynth(config.synth, config.volume);
  } else {
    soundManager.playUI(selectedId);
  }
}

function playLoopSound() {
  if (!selectedId) return;
  soundManager.resume();
  const config = workingData[selectedId];
  if (config.synth) {
    activeLoopHandle = soundManager.startRawSynthLoop(config.synth, config.volume);
  } else {
    activeLoopHandle = soundManager.startUILoop(selectedId);
  }
}

function startRepeat() {
  stopRepeat();
  playOnce();
  repeatTimer = setInterval(() => playOnce(), repeatInterval);
}

function stopRepeat() {
  if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
}

function stopAllPlayback() {
  stopRepeat();
  if (activeLoopHandle != null) {
    soundManager.stopLoop(activeLoopHandle, { fadeOut: 0.1 });
    activeLoopHandle = null;
  }
}

function autoPlayIfEnabled() {
  if (!autoPlayEnabled || !selectedId) return;
  const config = workingData[selectedId];
  if (config.loop) {
    // Restart loop with new params
    if (activeLoopHandle != null) {
      soundManager.stopLoop(activeLoopHandle, { fadeOut: 0.05 });
    }
    playLoopSound();
  } else {
    playOnce();
  }
}

// ─── Property Panel ────────────────────────────────────────────────────────

let debounceTimer = null;
function onParamChange() {
  saveManager.markDirty();
  renderSynthWaveform();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (activeLoopHandle != null) {
      // Loop is playing — seamlessly restart with updated params
      restartLoopSeamlessly();
    } else {
      autoPlayIfEnabled();
    }
  }, 80);
}

function restartLoopSeamlessly() {
  if (!selectedId || activeLoopHandle == null) return;
  const oldHandle = activeLoopHandle;
  playLoopSound();
  soundManager.stopLoop(oldHandle, { fadeOut: 0.05 });
}

function buildPropertyPanel() {
  propsEl.innerHTML = '';
  if (!selectedId) {
    propsEl.innerHTML = '<div style="color:#7a6a4a;padding:20px">Select a sound from the sidebar</div>';
    return;
  }

  const config = workingData[selectedId];
  const title = document.createElement('div');
  title.style.cssText = 'font-size:16px;font-weight:bold;color:#d4a056;margin-bottom:12px;text-transform:uppercase;letter-spacing:1px;';
  title.textContent = selectedId;
  propsEl.appendChild(title);

  // ── General section ───────────────────────────────────────────
  const general = PropertyGroup('General');
  propsEl.appendChild(general.el);

  // Auto-migrate legacy top-level file sounds to unified synth format
  if (config.file && !config.synth) {
    const layer = { type: 'file', file: config.file };
    if (config.playbackRate) { layer.playbackRate = config.playbackRate; delete config.playbackRate; }
    config.synth = { layers: [layer] };
    delete config.file;
    onParamChange();
  }

  // Ensure synth block exists
  if (!config.synth) {
    config.synth = { layers: [{ type: 'sine', freq: 440, gain: 1.0 }] };
    onParamChange();
  }

  // Category
  const catSelect = Select('Category', categories, config.category, (val) => {
    config.category = val;
    onParamChange();
  });
  general.addChild(catSelect);

  // Volume
  const volSlider = NumberSlider('Volume', 0, 1, 0.01, config.volume, (val) => {
    config.volume = val;
    onParamChange();
  });
  general.addChild(volSlider);

  // Range
  const rangeSlider = NumberSlider('Range (0=UI)', 0, 5000, 10, config.range, (val) => {
    config.range = val;
    onParamChange();
  });
  general.addChild(rangeSlider);

  // Loop
  const loopToggle = Toggle('Loop', config.loop, (val) => {
    config.loop = val;
    if (val && config.synth) {
      delete config.synth.duration;
      delete config.synth.attack;
      delete config.synth.decay;
    }
    onParamChange();
    buildPropertyPanel();
    buildPreviewControls();
  });
  general.addChild(loopToggle);

  // ── Synth section ─────────────────────────────────────────────
  buildSynthPanel(config);
}

function buildSynthPanel(config) {
  const synth = config.synth;
  const isLayered = !!synth.layers;
  const hasOscLayers = isLayered
    ? synth.layers.some(l => l.type !== 'file')
    : true; // simple synth = oscillator
  const hasEnvelopeParams = synth.duration !== undefined ||
                            synth.attack !== undefined ||
                            synth.decay !== undefined;

  // Envelope (hidden for loops)
  if (!config.loop) {
    const envelope = PropertyGroup('Envelope');
    propsEl.appendChild(envelope.el);

    // File-only sounds don't need an envelope by default — show toggle
    if (!hasOscLayers) {
      const envToggle = Toggle('Enable Envelope', hasEnvelopeParams, (val) => {
        if (val) {
          synth.duration = 0.5;
          synth.attack = 0.01;
          synth.decay = 0.49;
        } else {
          delete synth.duration;
          delete synth.attack;
          delete synth.decay;
        }
        onParamChange();
        buildPropertyPanel();
      });
      envelope.addChild(envToggle);
    }

    if (hasOscLayers || hasEnvelopeParams) {
      const durInput = NumberSlider('Duration (s)', 0.01, 10, 0.01, synth.duration ?? 0.5, (val) => {
        synth.duration = val;
        onParamChange();
      });
      envelope.addChild(durInput);

      const atkInput = NumberSlider('Attack (s)', 0.001, 5, 0.001, synth.attack ?? 0.01, (val) => {
        synth.attack = val;
        onParamChange();
      });
      envelope.addChild(atkInput);

      const decInput = NumberSlider('Decay (s)', 0.01, 10, 0.01, synth.decay ?? 0.49, (val) => {
        synth.decay = val;
        onParamChange();
      });
      envelope.addChild(decInput);
    }
  }

  // Reverb (always visible)
  const reverbGroup = PropertyGroup('Reverb');
  propsEl.appendChild(reverbGroup.el);
  const reverbInput = NumberSlider('Reverb', 0, 1, 0.01, synth.reverb ?? 0, (val) => {
    if (val === 0) delete synth.reverb;
    else synth.reverb = val;
    onParamChange();
  });
  reverbGroup.addChild(reverbInput);

  // LFO
  const hasLfo = !!synth.lfo;
  const lfoGroup = PropertyGroup('LFO');
  propsEl.appendChild(lfoGroup.el);

  const lfoToggle = Toggle('Enable LFO', hasLfo, (val) => {
    if (val) synth.lfo = { freq: 4, depth: 0.3 };
    else delete synth.lfo;
    onParamChange();
    buildPropertyPanel();
  });
  lfoGroup.addChild(lfoToggle);

  if (synth.lfo) {
    const lfoFreq = NumberSlider('LFO Freq (Hz)', 0.1, 50, 0.1, synth.lfo.freq ?? 4, (val) => {
      synth.lfo.freq = val;
      onParamChange();
    });
    lfoGroup.addChild(lfoFreq);

    const lfoDepth = NumberSlider('LFO Depth', 0, 1, 0.01, synth.lfo.depth ?? 0.3, (val) => {
      synth.lfo.depth = val;
      onParamChange();
    });
    lfoGroup.addChild(lfoDepth);
  }

  // Auto-convert simple synths to layered format
  if (!isLayered) {
    synth.layers = [{
      type: synth.type || 'sine',
      freq: synth.freq || 440,
      gain: 1.0,
    }];
    if (synth.freqEnd) synth.layers[0].freqEnd = synth.freqEnd;
    if (synth.detune) synth.layers[0].detune = synth.detune;
    delete synth.type;
    delete synth.freq;
    delete synth.freqEnd;
    delete synth.detune;
  }

  // Layers
  buildLayersPanel(synth);
}

// buildSimpleSynthPanel removed — all sounds auto-convert to layered format

function buildLayersPanel(synth) {
  const group = PropertyGroup(`Layers (${synth.layers.length})`);
  propsEl.appendChild(group.el);

  const LAYER_TYPES = [
    { value: 'sine', label: 'Sine' },
    { value: 'square', label: 'Square' },
    { value: 'sawtooth', label: 'Sawtooth' },
    { value: 'triangle', label: 'Triangle' },
    { value: 'file', label: 'File' },
  ];

  synth.layers.forEach((layer, i) => {
    const isFile = layer.type === 'file';
    const label = isFile
      ? `Layer ${i + 1}: ${(layer.file || '?').split('/').pop()}`
      : `Layer ${i + 1}: ${layer.type || 'sine'}`;
    const layerGroup = PropertyGroup(label);
    group.addChild(layerGroup);

    const typeSelect = Select('Type', LAYER_TYPES, layer.type || 'sine', (val) => {
      const wasFile = layer.type === 'file';
      layer.type = val;
      if (val === 'file' && !wasFile) {
        // Switching to file — clear oscillator props, set file defaults
        delete layer.freq; delete layer.freqEnd; delete layer.detune;
        layer.file = availableSfxFiles[0] || '/SFX/';
        layer.playbackRate = 1;
      } else if (val !== 'file' && wasFile) {
        // Switching to oscillator — clear file props, set osc defaults
        delete layer.file; delete layer.playbackRate;
        layer.freq = 440;
      }
      onParamChange();
      buildPropertyPanel();
    });
    layerGroup.addChild(typeSelect);

    if (isFile) {
      // ── File layer fields ──
      const fileOptions = availableSfxFiles.length > 0
        ? availableSfxFiles.map(f => ({ value: f, label: f.split('/').pop() }))
        : [{ value: layer.file || '/SFX/', label: layer.file?.split('/').pop() || '?' }];
      const fileSelect = Select('File', fileOptions, layer.file || '', (val) => {
        layer.file = val;
        onParamChange();
      });
      layerGroup.addChild(fileSelect);

      const rateInput = NumberSlider('Playback Rate', 0.1, 4, 0.05, layer.playbackRate || 1, (val) => {
        layer.playbackRate = val;
        onParamChange();
      });
      layerGroup.addChild(rateInput);
    } else {
      // ── Oscillator layer fields ──
      const freqInput = NumberSlider('Frequency (Hz)', 20, 8000, 1, layer.freq || 440, (val) => {
        layer.freq = val;
        onParamChange();
      });
      layerGroup.addChild(freqInput);

      if (layer.freqEnd !== undefined) {
        const freqEndInput = NumberSlider('Freq End (Hz)', 0, 8000, 1, layer.freqEnd, (val) => {
          if (val === 0) delete layer.freqEnd;
          else layer.freqEnd = val;
          onParamChange();
        });
        layerGroup.addChild(freqEndInput);
      }

      const detuneInput = NumberSlider('Detune (cents)', -100, 100, 1, layer.detune || 0, (val) => {
        if (val === 0) delete layer.detune;
        else layer.detune = val;
        onParamChange();
      });
      layerGroup.addChild(detuneInput);
    }

    // Gain — shared by both layer types
    const gainInput = NumberSlider('Gain', 0, 1, 0.01, layer.gain ?? 1, (val) => {
      layer.gain = val;
      onParamChange();
    });
    layerGroup.addChild(gainInput);

    // Remove layer button
    if (synth.layers.length > 1) {
      const removeBtn = Button(`Remove Layer ${i + 1}`, () => {
        synth.layers.splice(i, 1);
        onParamChange();
        buildPropertyPanel();
      }, 'danger');
      layerGroup.addChild(removeBtn);
    }
  });

  // Add layer buttons
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:6px;';

  const addOscBtn = Button('+ Oscillator', () => {
    synth.layers.push({ type: 'sine', freq: 440, gain: 0.5 });
    onParamChange();
    buildPropertyPanel();
  }, 'subtle');
  btnRow.appendChild(addOscBtn.el);

  const addFileBtn = Button('+ File', () => {
    synth.layers.push({ type: 'file', file: availableSfxFiles[0] || '/SFX/', gain: 1.0 });
    onParamChange();
    buildPropertyPanel();
  }, 'subtle');
  btnRow.appendChild(addFileBtn.el);

  group.addChild({ el: btnRow });
}

// buildFilePanel removed — file is now a layer type, not a top-level sound type

// ─── CRUD ──────────────────────────────────────────────────────────────────

function createNewSound() {
  let id = prompt('Sound ID (camelCase):');
  if (!id) return;
  id = id.trim();
  if (workingData[id]) { alert(`Sound "${id}" already exists`); return; }
  workingData[id] = {
    synth: { layers: [{ type: 'sine', freq: 440, gain: 1.0 }], duration: 0.5, attack: 0.01, decay: 0.49 },
    volume: 0.3,
    range: 0,
    category: categories[0] || 'ui',
    loop: false,
  };
  saveManager.markDirty();
  selectedId = id;
  renderSidebar();
  buildPreviewControls();
  buildPropertyPanel();
}

function deleteSound() {
  if (!selectedId) return;
  if (!confirm(`Delete sound "${selectedId}"?`)) return;
  delete workingData[selectedId];
  saveManager.markDirty();
  selectedId = null;
  renderSidebar();
  buildPreviewControls();
  buildPropertyPanel();
}

function duplicateSound() {
  if (!selectedId) return;
  let id = prompt('New sound ID:', selectedId + 'Copy');
  if (!id) return;
  id = id.trim();
  if (workingData[id]) { alert(`Sound "${id}" already exists`); return; }
  workingData[id] = JSON.parse(JSON.stringify(workingData[selectedId]));
  saveManager.markDirty();
  selectedId = id;
  renderSidebar();
  buildPreviewControls();
  buildPropertyPanel();
}

// ─── Save ──────────────────────────────────────────────────────────────────

async function doSave() {
  if (!saveManager.isDirty()) return;
  try {
    // Rebuild full sfx.json structure
    const fullData = { categories, sounds: workingData };
    await saveManager.save(fullData);
  } catch (err) {
    alert('Save failed: ' + err.message);
  }
}
