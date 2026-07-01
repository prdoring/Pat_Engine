// Soundboard Editor — full CRUD sound editor with synth sliders, file editing,
// randomization ranges, repeat preview, and save to sfx.json.

import { SOUND_CONFIG } from '/engine/data/sounds.js';
import { SoundManager } from '/engine/audio/SoundManager.js';
import {
  SaveManager,
  NumberSlider, RandomizableSlider, ColorInput, Select, TextInput, Toggle, Button,
  PropertyGroup, createResizer,
  modalAlert, modalConfirm, modalPrompt,
} from '/editors/shared/index.js';
import { FILTER_TYPES } from './constants.js';
import { oscillatorSample, rv } from './waveform.js';

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
let availableMidiFiles = []; // populated from /api/midi-files

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

  // Load available MIDI files for the MIDI-tune picker
  fetch('/api/midi-files')
    .then(r => r.ok ? r.json() : [])
    .then(files => { availableMidiFiles = files; })
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
  const duration = isLoop ? 1.0 : (rv(synth.duration) ?? 0.5);
  const attack = isLoop ? 0 : (rv(synth.attack) ?? 0.01);
  const decay = isLoop ? 0 : (rv(synth.decay) ?? (duration - attack));

  // Determine how many cycles to show — enough to see the shape clearly
  const baseFreq = Math.min(...oscLayers.map(l => rv(l.freq) || 440));
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
      const lfoFreq = rv(synth.lfo.freq) || 4;
      const lfoDepth = rv(synth.lfo.depth) || 0.3;
      lfoMod = 1.0 + lfoDepth * Math.sin(2 * Math.PI * lfoFreq * t);
    }

    // Sum oscillator layers
    let sample = 0;
    for (const layer of oscLayers) {
      const freq = rv(layer.freq) || 440;
      const freqEnd = rv(layer.freqEnd);
      let f = freq;
      if (freqEnd && !isLoop) {
        // Exponential frequency sweep
        f = freq * Math.pow(freqEnd / freq, tNorm);
      }
      const phase = (f * t) % 1;
      const gain = rv(layer.gain) ?? 1.0;
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
  const freqLabel = oscLayers.map(l => `${l.type || 'sine'} ${rv(l.freq) || 440}Hz`).join(' + ');
  ctx.fillText(freqLabel, 6, 12);
  if (!isLoop) {
    ctx.fillText(`${duration.toFixed(2)}s  atk:${attack.toFixed(3)}  dec:${decay.toFixed(2)}`, 6, h - 4);
  } else {
    ctx.fillText('loop', 6, h - 4);
  }
  if (synth.lfo) {
    ctx.fillText(`LFO ${rv(synth.lfo.freq) || 4}Hz depth:${rv(synth.lfo.depth) || 0.3}`, w - 180, 12);
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
    // A MIDI-tune sound must have its .mid parsed before it can render — load
    // (cached after first time) then play the tune through the synth voice.
    const midiPath = config.synth.midi && (config.synth.midi.file || config.synth.midi);
    if (midiPath) {
      soundManager.loadMidi(midiPath).then(() => soundManager.playRawSynth(config.synth, config.volume));
    } else {
      soundManager.playRawSynth(config.synth, config.volume);
    }
  } else {
    soundManager.playUI(selectedId);
  }
}

function playLoopSound() {
  if (!selectedId) return;
  soundManager.resume();
  const config = workingData[selectedId];
  if (config.synth) {
    const midiPath = config.synth.midi && (config.synth.midi.file || config.synth.midi);
    if (midiPath) {
      soundManager.loadMidi(midiPath).then(() => {
        activeLoopHandle = soundManager.startRawSynthLoop(config.synth, config.volume);
      });
    } else {
      activeLoopHandle = soundManager.startRawSynthLoop(config.synth, config.volume);
    }
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

  // MIDI Tune (instrument-level): attach a .mid so this sound plays a melody through
  // its synth voice. The layers/envelope/filter below are the instrument's timbre.
  if (typeof synth.midi === 'string') synth.midi = { file: synth.midi }; // normalize string form
  const midiGroup = PropertyGroup('MIDI Tune');
  propsEl.appendChild(midiGroup.el);

  const midiToggle = Toggle('Play MIDI Tune', !!synth.midi, (val) => {
    if (val) synth.midi = { file: availableMidiFiles[0] || '', transpose: 0 };
    else delete synth.midi;
    onParamChange();
    buildPropertyPanel();
  });
  midiGroup.addChild(midiToggle);

  if (synth.midi) {
    const midiOptions = availableMidiFiles.length > 0
      ? availableMidiFiles.map(f => ({ value: f, label: f.split('/').pop() }))
      : [{ value: synth.midi.file || '', label: synth.midi.file ? synth.midi.file.split('/').pop() : '(drop a .mid in assets/MIDI/)' }];
    const midiSelect = Select('File', midiOptions, synth.midi.file || '', (val) => {
      synth.midi.file = val;
      onParamChange();
    });
    midiGroup.addChild(midiSelect);

    const transposeInput = NumberSlider('Transpose (semitones)', -24, 24, 1, synth.midi.transpose ?? 0, (val) => {
      if (val === 0) delete synth.midi.transpose;
      else synth.midi.transpose = val;
      onParamChange();
    });
    midiGroup.addChild(transposeInput);

    const tempoInput = NumberSlider('Tempo (×)', 0.25, 4, 0.05, synth.midi.tempo ?? 1, (val) => {
      if (val === 1) delete synth.midi.tempo;
      else synth.midi.tempo = val;
      onParamChange();
    });
    midiGroup.addChild(tempoInput);

    // Track selector for multi-instrument songs — populated once the .mid is parsed.
    const midiInfo = synth.midi.file ? soundManager.midiData.get(synth.midi.file) : null;
    if (synth.midi.file && !midiInfo) {
      soundManager.loadMidi(synth.midi.file).then(() => buildPropertyPanel()); // load, then re-render with tracks
    } else if (midiInfo?.tracks && midiInfo.tracks.length > 1) {
      const trackOpts = [{ value: '', label: '(whole song)' },
        ...midiInfo.tracks.map(t => ({ value: t.name, label: `${t.name} (${t.notes.length})` }))];
      const trackSelect = Select('Track', trackOpts, synth.midi.track != null ? String(synth.midi.track) : '', (val) => {
        if (val === '') delete synth.midi.track;
        else synth.midi.track = val;
        onParamChange();
      });
      midiGroup.addChild(trackSelect);
    }
  }

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
      const durInput = RandomizableSlider('Duration (s)', 0.01, 10, 0.01, synth.duration ?? 0.5, (val) => {
        synth.duration = val;
        onParamChange();
      });
      envelope.addChild(durInput);

      const atkInput = RandomizableSlider('Attack (s)', 0.001, 5, 0.001, synth.attack ?? 0.01, (val) => {
        synth.attack = val;
        onParamChange();
      });
      envelope.addChild(atkInput);

      const decInput = RandomizableSlider('Decay (s)', 0.01, 10, 0.01, synth.decay ?? 0.49, (val) => {
        synth.decay = val;
        onParamChange();
      });
      envelope.addChild(decInput);
    }
  }

  // Reverb (always visible)
  const reverbGroup = PropertyGroup('Reverb');
  propsEl.appendChild(reverbGroup.el);
  const reverbInput = RandomizableSlider('Reverb', 0, 1, 0.01, synth.reverb ?? 0, (val) => {
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
    const lfoFreq = RandomizableSlider('LFO Freq (Hz)', 0.1, 50, 0.1, synth.lfo.freq ?? 4, (val) => {
      synth.lfo.freq = val;
      onParamChange();
    });
    lfoGroup.addChild(lfoFreq);

    const lfoDepth = RandomizableSlider('LFO Depth', 0, 1, 0.01, synth.lfo.depth ?? 0.3, (val) => {
      synth.lfo.depth = val;
      onParamChange();
    });
    lfoGroup.addChild(lfoDepth);
  }

  // Vibrato (pitch LFO — depth in cents)
  const vibratoGroup = PropertyGroup('Vibrato');
  propsEl.appendChild(vibratoGroup.el);

  const vibratoToggle = Toggle('Enable Vibrato', !!synth.vibrato, (val) => {
    if (val) synth.vibrato = { freq: 5, depth: 15 };
    else delete synth.vibrato;
    onParamChange();
    buildPropertyPanel();
  });
  vibratoGroup.addChild(vibratoToggle);

  if (synth.vibrato) {
    const vibFreq = RandomizableSlider('Vibrato Freq (Hz)', 0.1, 12, 0.1, synth.vibrato.freq ?? 5, (val) => {
      synth.vibrato.freq = val;
      onParamChange();
    });
    vibratoGroup.addChild(vibFreq);

    const vibDepth = RandomizableSlider('Vibrato Depth (cents)', 0, 100, 1, synth.vibrato.depth ?? 15, (val) => {
      synth.vibrato.depth = val;
      onParamChange();
    });
    vibratoGroup.addChild(vibDepth);
  }

  // Tone filter (whole-voice colour)
  const filterGroup = PropertyGroup('Filter');
  propsEl.appendChild(filterGroup.el);

  const filterToggle = Toggle('Enable Filter', !!synth.filter, (val) => {
    if (val) synth.filter = { type: 'lowpass', freq: 2000, q: 1 };
    else delete synth.filter;
    onParamChange();
    buildPropertyPanel();
  });
  filterGroup.addChild(filterToggle);

  if (synth.filter) {
    const filterType = Select('Filter Type', FILTER_TYPES, synth.filter.type || 'lowpass', (val) => {
      synth.filter.type = val;
      onParamChange();
    });
    filterGroup.addChild(filterType);

    const filterFreq = RandomizableSlider('Cutoff (Hz)', 20, 12000, 10, synth.filter.freq ?? 2000, (val) => {
      synth.filter.freq = val;
      onParamChange();
    });
    filterGroup.addChild(filterFreq);

    const filterQ = RandomizableSlider('Q', 0.1, 12, 0.1, synth.filter.q ?? 1, (val) => {
      synth.filter.q = val;
      onParamChange();
    });
    filterGroup.addChild(filterQ);
  }

  // Distortion / drive (waveshaper) — grit for electric-guitar-style leads
  const driveGroup = PropertyGroup('Distortion');
  propsEl.appendChild(driveGroup.el);
  const driveInput = RandomizableSlider('Drive', 0, 1, 0.01, synth.distortion ?? 0, (val) => {
    if (val === 0) delete synth.distortion;
    else synth.distortion = val;
    onParamChange();
  });
  driveGroup.addChild(driveInput);

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
    { value: 'noise', label: 'Noise' },
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
      if (val === layer.type) return;
      layer.type = val;
      // Clear all type-specific props, then set defaults for the chosen type.
      delete layer.freq; delete layer.freqEnd; delete layer.detune;
      delete layer.file; delete layer.playbackRate; delete layer.filter;
      if (val === 'file') {
        layer.file = availableSfxFiles[0] || '/SFX/';
        layer.playbackRate = 1;
      } else if (val === 'noise') {
        // noise has no osc/file props; keeps shared gain
      } else {
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

      const rateInput = RandomizableSlider('Playback Rate', 0.1, 4, 0.05, layer.playbackRate ?? 1, (val) => {
        layer.playbackRate = val;
        onParamChange();
      });
      layerGroup.addChild(rateInput);
    } else if (layer.type === 'noise') {
      // ── Noise layer fields ── optional colour filter to "tune" the noise
      const noiseFilterToggle = Toggle('Colour Filter', !!layer.filter, (val) => {
        if (val) layer.filter = { type: 'bandpass', freq: 1000, q: 1 };
        else delete layer.filter;
        onParamChange();
        buildPropertyPanel();
      });
      layerGroup.addChild(noiseFilterToggle);

      if (layer.filter) {
        const nfType = Select('Filter Type', FILTER_TYPES, layer.filter.type || 'bandpass', (val) => {
          layer.filter.type = val;
          onParamChange();
        });
        layerGroup.addChild(nfType);

        const nfFreq = RandomizableSlider('Filter Freq (Hz)', 20, 12000, 10, layer.filter.freq ?? 1000, (val) => {
          layer.filter.freq = val;
          onParamChange();
        });
        layerGroup.addChild(nfFreq);

        const nfQ = RandomizableSlider('Filter Q', 0.1, 12, 0.1, layer.filter.q ?? 1, (val) => {
          layer.filter.q = val;
          onParamChange();
        });
        layerGroup.addChild(nfQ);
      }
    } else {
      // ── Oscillator layer fields ──
      const freqInput = RandomizableSlider('Frequency (Hz)', 20, 8000, 1, layer.freq ?? 440, (val) => {
        layer.freq = val;
        onParamChange();
      });
      layerGroup.addChild(freqInput);

      // Pitch sweep — addable. On → glide from Frequency to Freq End over the note.
      const sweepToggle = Toggle('Pitch sweep', layer.freqEnd !== undefined, (val) => {
        if (val) layer.freqEnd = rv(layer.freq) ?? 440;
        else delete layer.freqEnd;
        onParamChange();
        buildPropertyPanel();
      });
      layerGroup.addChild(sweepToggle);

      if (layer.freqEnd !== undefined) {
        const freqEndInput = RandomizableSlider('Freq End (Hz)', 20, 8000, 1, layer.freqEnd, (val) => {
          layer.freqEnd = val;
          onParamChange();
        });
        layerGroup.addChild(freqEndInput);
      }

      const detuneInput = RandomizableSlider('Detune (cents)', -100, 100, 1, layer.detune ?? 0, (val) => {
        layer.detune = val;
        onParamChange();
      });
      layerGroup.addChild(detuneInput);
    }

    // Gain — shared by all layer types
    const gainInput = RandomizableSlider('Gain', 0, 1, 0.01, layer.gain ?? 1, (val) => {
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

  const addNoiseBtn = Button('+ Noise', () => {
    synth.layers.push({ type: 'noise', gain: 0.5 });
    onParamChange();
    buildPropertyPanel();
  }, 'subtle');
  btnRow.appendChild(addNoiseBtn.el);

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

async function createNewSound() {
  const id = await modalPrompt('', { title: 'New sound', placeholder: 'soundId (camelCase)', confirmLabel: 'Create',
    validate: v => !v ? 'Enter an id' : workingData[v] ? 'That id already exists' : '' });
  if (!id) return;
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

async function deleteSound() {
  if (!selectedId) return;
  if (!await modalConfirm(`Delete sound "${selectedId}"?`, { title: 'Delete sound', confirmLabel: 'Delete', danger: true })) return;
  delete workingData[selectedId];
  saveManager.markDirty();
  selectedId = null;
  renderSidebar();
  buildPreviewControls();
  buildPropertyPanel();
}

async function duplicateSound() {
  if (!selectedId) return;
  const id = await modalPrompt('', { title: 'Duplicate sound', value: selectedId + 'Copy', confirmLabel: 'Duplicate',
    validate: v => !v ? 'Enter an id' : workingData[v] ? 'That id already exists' : '' });
  if (!id) return;
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
    modalAlert('Save failed: ' + err.message, { title: 'Save failed' });
  }
}
