// Music editor — assemble + audition the layered adaptive song like a mixing console, with a
// piano-roll MIDI editor below the mixer. A top bar (song selector + New + Play), a settings row
// (tempo grid + mix headroom + crossfade), "vibe" scene buttons (rename/delete + description), a
// channel-strip mixer (click a strip to select its stem; faders ARE the live mix), and a piano
// roll for the selected stem — draw/move/resize/delete notes live while the song plays. Notes are
// editable JSON (beats) stored per stem; instrument timbre lives in the Sounds sub-tab. Saves to
// data/music.json only.
import { SoundManager } from '/engine/audio/SoundManager.js';
import { MusicDirector } from '/engine/audio/MusicDirector.js';
import { MUSIC_SONGS } from '/engine/data/music.js';
import { SOUND_CONFIG } from '/engine/data/sounds.js';
import { SaveManager } from './editorShared.js';
import {
  newSong, addStem, removeStem, renameStem, reorderStem,
  renameVibe, deleteVibe, setVibeDoc,
} from './musicModel.js';
import { importMidiTrack } from './midiModel.js';
import { createPianoRoll } from './pianoRoll.js';

let container = null;
let soundManager = null;
let music = null;
let loadPromise = null;
let saveManager = null;     // music.json

let workingSongs = {};      // editable deep clone of MUSIC_SONGS
let currentSongId = null;
let playing = false;        // song loops exist
let paused = false;         // audio context suspended (true pause — resumes in place)
let playBtnEl = null;       // transport button (updated in place on pause/resume)
let activeTier = null;      // selected vibe scene (null = "All", the base mix)
let soloStem = null;        // transient solo
const muted = new Set();    // transient mutes
let selectedStem = null;    // stem whose notes the piano roll edits
let pianoRoll = null;       // persistent piano-roll instance (survives buildUI re-renders)

const TWEAK_FADE = 0.18; // quick fade while dragging a fader
const SCENE_FADE = 0.9;  // musical fade when switching vibes
const GRID_OPTS = [{ value: '1', label: '1/4' }, { value: '0.5', label: '1/8' }, { value: '0.25', label: '1/16' }, { value: '0.125', label: '1/32' }];

// ─── Mount / Unmount ───────────────────────────────────────────────────────

export function mount(el) {
  container = el;
  workingSongs = JSON.parse(JSON.stringify(MUSIC_SONGS));
  currentSongId = Object.keys(workingSongs)[0] || null;

  soundManager = new SoundManager();
  loadPromise = soundManager.init();
  music = new MusicDirector(soundManager);

  saveManager = new SaveManager('music.json');
  saveManager.onDirtyChange(dirty => window.editorSetUnsaved?.('music', dirty));

  window.addEventListener('keydown', onSpaceKey);

  injectStyle();
  buildUI();
}

// Space toggles play/pause — but only when the Music tab is visible and you're not typing.
function onSpaceKey(e) {
  if (e.code !== 'Space' || e.repeat) return;
  if (!container || container.offsetParent === null) return;
  if (/^(input|textarea|select)$/i.test(e.target?.tagName || '')) return;
  e.preventDefault();
  toggleTransport();
}

export function unmount() {
  try { music?.stop({ fadeOut: 0.1 }); } catch {}
  try { pianoRoll?.destroy(); } catch {}
  window.removeEventListener('keydown', onSpaceKey);
  pianoRoll = null;
  playing = false;
  container = null;
}

export function save() { doSave(); }
export function isDirty() { return saveManager?.isDirty() ?? false; }

async function doSave() {
  if (!saveManager.isDirty()) return;
  try { await saveManager.save({ songs: workingSongs }); }
  catch (err) { alert('Save failed: ' + err.message); }
}

// ─── Scenes + live mix ───────────────────────────────────────────────────────

function song() { return workingSongs[currentSongId]; }

/** Default-fill the tempo grid so legacy songs (no tempo) still drive the piano roll. */
function ensureTiming(s) {
  s.bpm ??= 120; s.beatsPerBar ??= 4; s.bars ??= 4; s.grid ??= 0.25;
}

/** The authored level for a stem in the active scene (0..1). */
function sceneLevel(stem) {
  if (!activeTier) return stem.gain ?? 0;                 // "All" = base/full mix
  return song().intensity?.[activeTier]?.[stem.name] ?? 0; // a vibe = absolute tier gain
}

/** Write a fader edit back into the active scene. */
function setSceneLevel(stem, v) {
  if (!activeTier) { stem.gain = v; return; }
  const map = (song().intensity[activeTier] = song().intensity[activeTier] || {});
  if (v <= 0) delete map[stem.name]; else map[stem.name] = v;
}

/** What a stem should actually play right now (scene level, minus mute/solo). */
function targetGain(stem) {
  if (muted.has(stem.name)) return 0;
  if (soloStem && soloStem !== stem.name) return 0;
  return sceneLevel(stem);
}

function applyMix(secs = TWEAK_FADE) {
  if (!playing) return;
  for (const stem of song().stems) music.fadeStem(stem.name, targetGain(stem), secs);
}

async function play() {
  if (!currentSongId) return;
  soundManager.resume();
  await loadPromise;
  music.startSong(song(), { intensity: activeTier || undefined, fadeSeconds: 0.5 });
  playing = true; paused = false;
  applyMix(0.5); // honor any mute/solo
  pianoRoll?.setPlaying(true);
  buildUI();
}

function stop() {
  music.stop({ fadeOut: 0.4 });
  playing = false; paused = false;
  pianoRoll?.setPlaying(false);
  buildUI();
}

/** Transport toggle (button + Space): play from top → pause (suspend, resumes in place) → resume. */
function toggleTransport() {
  if (!currentSongId) return;
  if (!playing) { play(); return; }
  const ctx = soundManager?.ctx;
  if (!ctx) return;
  if (paused) { ctx.resume?.(); paused = false; }
  else { ctx.suspend?.(); paused = true; }
  updateTransportBtn();
}

function updateTransportBtn() {
  if (!playBtnEl) return;
  playBtnEl.textContent = !playing ? '▶ Play' : paused ? '▶ Resume' : '❚❚ Pause';
  playBtnEl.className = 'me-play' + (playing && !paused ? ' playing' : '');
}

function setScene(tier) {
  activeTier = tier;
  applyMix(SCENE_FADE); // faders + audio move to this vibe
  buildUI();
}

/** Rebuild the stem loops on a fresh shared downbeat (reassigned sounds / added stems heard now). */
function resyncIfPlaying() {
  if (!playing) return;
  music.startSong(song(), { intensity: activeTier || undefined, fadeSeconds: 0.3 });
  applyMix(0.3);
}

/** A structural edit (stems/vibes) — mark dirty, drop transient mute/solo, rebuild. */
function structuralEdit({ resync = true } = {}) {
  saveManager.markDirty();
  muted.clear();
  soloStem = null;
  if (resync) resyncIfPlaying();
  buildUI();
}

function addVibe() {
  const name = (prompt('New vibe name:') || '').trim();
  if (!name) return;
  song().intensity = song().intensity || {};
  if (!song().intensity[name]) song().intensity[name] = {};
  saveManager.markDirty();
  setScene(name);
}

function newSongPrompt() {
  let id = (prompt('New song id:') || '').trim();
  if (!id) return;
  if (workingSongs[id]) { alert(`Song "${id}" already exists`); return; }
  workingSongs[id] = newSong();
  currentSongId = id;
  activeTier = null; soloStem = null; muted.clear(); selectedStem = null;
  if (playing) stop();
  saveManager.markDirty();
  buildUI();
}

// ─── Stem selection + note editing ─────────────────────────────────────────

function selectStem(stem) {
  selectedStem = stem;
  buildUI();
}

/** Audition a pitch through the selected stem's instrument (piano-key click in the roll). */
function previewNote(midi) {
  const snd = selectedStem && SOUND_CONFIG[selectedStem.sound];
  if (snd?.synth) soundManager.playSynthNote(snd.synth, midi, { category: snd.category });
}

/** The piano roll edited the selected stem's notes (in place) — persist + push live audio. */
function onNotesEdited() {
  if (!selectedStem) return;
  saveManager.markDirty();
  if (playing) music.updateStemNotes(selectedStem.name, selectedStem.notes, song());
}

/** Push every stem's notes to the playing engine (after a tempo/length change). */
function pushAllStems() {
  if (!playing) return;
  for (const stem of song().stems) if (stem.notes) music.updateStemNotes(stem.name, stem.notes, song());
}

async function importMidiInto(stem) {
  let files = [];
  try { files = await fetch('/api/midi-files').then(r => (r.ok ? r.json() : [])); } catch {}
  if (!files.length) { alert('No .mid files found in assets/MIDI/.'); return; }
  const file = files.length === 1 ? files[0] : promptPick('Import which MIDI file?', files);
  if (!file) return;
  await soundManager.loadMidi(file);
  const data = soundManager.midiData.get(file);
  if (!data || !data.tracks?.length) { alert('Could not parse ' + file); return; }
  const labels = data.tracks.map((t, i) => `${t.name} (${t.notes.length} notes)`);
  const ti = data.tracks.length === 1 ? 0 : promptPickIndex('Import which track?', labels);
  if (ti == null) return;
  ensureTiming(song());
  stem.notes = importMidiTrack(data.tracks[ti].notes, song().bpm, song().grid);
  saveManager.markDirty();
  if (playing) music.updateStemNotes(stem.name, stem.notes, song());
  buildUI();
}

function promptPick(msg, opts) {
  const r = prompt(`${msg}\n` + opts.map((o, i) => `${i}: ${o}`).join('\n'), '0');
  if (r == null) return null;
  const i = parseInt(r, 10);
  return opts[i] ?? null;
}
function promptPickIndex(msg, opts) {
  const r = prompt(`${msg}\n` + opts.map((o, i) => `${i}: ${o}`).join('\n'), '0');
  if (r == null) return null;
  const i = parseInt(r, 10);
  return i >= 0 && i < opts.length ? i : null;
}

// ─── UI ──────────────────────────────────────────────────────────────────────

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

function selectEl(options, value, onChange) {
  const s = el('select', 'me-sel');
  for (const opt of options) {
    const o = el('option', null, opt.label); o.value = opt.value;
    if (opt.value === value) o.selected = true;
    s.appendChild(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function injectStyle() {
  if (document.getElementById('me-style')) return;
  const s = el('style'); s.id = 'me-style';
  s.textContent = `
  #me-root{font:13px system-ui,sans-serif;color:#d8cfa8;padding:12px;box-sizing:border-box;flex:1;min-width:0;display:flex;flex-direction:column}
  .me-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
  .me-spacer{flex:1}
  .me-sel{background:#161109;color:#d8cfa8;border:1px solid #5a4a30;border-radius:4px;padding:5px 8px;font-size:12px}
  .me-play{background:#3a6a3a;color:#eafaea;border:1px solid #5a8a5a;border-radius:4px;padding:6px 18px;font-weight:600;cursor:pointer}
  .me-play.stop{background:#7a3030;border-color:#a85050}
  .me-new{background:#2a2118;color:#c9b48a;border:1px dashed #5a4a30;border-radius:4px;padding:6px 12px;cursor:pointer;font-size:12px}
  .me-settings{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:12px;padding:8px 12px;background:#100b05;border:1px solid #4a3c24;border-radius:6px}
  .me-knob{display:flex;align-items:center;gap:8px}
  .me-knob label{color:#9a875a;font-size:12px}
  .me-knob input[type=range]{width:110px;accent-color:#c9a227}
  .me-knob .v{font-size:11px;color:#9a875a;font-variant-numeric:tabular-nums;width:30px}
  .me-num{width:52px;background:#161109;color:#d8cfa8;border:1px solid #5a4a30;border-radius:4px;padding:4px 6px;font-size:12px}
  .me-int{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px}
  .me-int .lbl{color:#9a875a;font-size:12px;margin-right:2px}
  .me-int button{background:#2a2118;color:#c9b48a;border:1px solid #5a4a30;border-radius:14px;padding:4px 13px;cursor:pointer;font-size:12px;text-transform:capitalize}
  .me-int button.active{background:#c9a227;color:#160d04;border-color:#c9a227;font-weight:600}
  .me-int button.add{border-style:dashed;color:#9a875a;text-transform:none}
  .me-vibe-edit{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .me-vibe-edit input.doc{flex:1;min-width:200px;background:#161109;color:#d8cfa8;border:1px solid #5a4a30;border-radius:4px;padding:4px 8px;font-size:12px}
  .me-mini{background:#2a2118;color:#c9b48a;border:1px solid #5a4a30;border-radius:4px;padding:3px 9px;cursor:pointer;font-size:11px}
  .me-mini.danger{color:#e0a0a0;border-color:#7a4040}
  .me-scene{color:#9a875a;font-size:12px;margin-bottom:6px}
  .me-mixer{display:flex;gap:8px;padding:12px;background:#100b05;border:1px solid #4a3c24;border-radius:6px;width:max-content;max-width:100%;overflow-x:auto;align-items:flex-start}
  .me-ch{display:flex;flex-direction:column;align-items:center;gap:5px;width:80px;padding:6px;background:#161109;border:1px solid #3a2f1c;border-radius:5px;cursor:pointer}
  .me-ch.selected{border-color:#c9a227;box-shadow:0 0 0 1px #c9a227}
  .me-ch-name{font-size:12px;color:#e0c98a;font-weight:600;text-align:center;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .me-fader{writing-mode:vertical-lr;direction:rtl;width:24px;height:130px;accent-color:#c9a227;cursor:pointer;margin-top:4px}
  .me-ch-val{font-size:11px;color:#9a875a;font-variant-numeric:tabular-nums}
  .me-ch-btns{display:flex;gap:3px}
  .me-ms{width:22px;height:22px;border:1px solid #5a4a30;border-radius:3px;cursor:pointer;font-size:10px;font-weight:600;background:#2a2118;color:#c9b48a}
  .me-addstem{align-self:stretch;min-width:70px;background:#1a140c;color:#9a875a;border:1px dashed #5a4a30;border-radius:5px;cursor:pointer;font-size:12px}
  .me-hint{color:#7a6a4a;font-size:11px;margin-top:8px}
  .me-pr{margin-top:12px;padding:10px 12px;background:#100b05;border:1px solid #4a3c24;border-radius:6px;flex:1;min-height:240px;display:flex;flex-direction:column}
  .me-pr-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;flex-shrink:0}
  .me-pr-title{font-weight:600;color:#e0c98a;font-size:13px}
  .me-pr-hint{color:#7a6a4a;font-size:12px;padding:6px 0}
  .me-pr-info{color:#9a875a;font-size:11px;margin-left:auto}
  .me-pr-body{flex:1;min-height:200px}
  .me-play.playing{background:#7a6a30;border-color:#a8902a}
  `;
  document.head.appendChild(s);
}

function buildUI() {
  if (!container) return;
  container.innerHTML = '';
  const root = el('div'); root.id = 'me-root';

  // ── Top bar: song selector | New | Play/Stop | spacer | Save ──
  const bar = el('div', 'me-bar');
  const sel = el('select', 'me-sel');
  for (const id of Object.keys(workingSongs)) {
    const o = el('option', null, id); o.value = id; if (id === currentSongId) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => {
    if (playing) stop();
    currentSongId = sel.value; activeTier = null; soloStem = null; muted.clear(); selectedStem = null;
    buildUI();
  });
  bar.appendChild(sel);

  const newBtn = el('button', 'me-new', '+ song');
  newBtn.addEventListener('click', newSongPrompt);
  bar.appendChild(newBtn);

  if (currentSongId) {
    playBtnEl = el('button', 'me-play');
    playBtnEl.addEventListener('click', toggleTransport);
    updateTransportBtn();
    bar.appendChild(playBtnEl);
    if (playing) {
      const stopBtn = el('button', 'me-new', '■ stop');
      stopBtn.addEventListener('click', stop);
      bar.appendChild(stopBtn);
    }
  } else { playBtnEl = null; }

  bar.appendChild(el('div', 'me-spacer'));
  bar.appendChild(saveManager.getStatusIndicator());
  bar.appendChild(saveManager.getSaveButton(() => doSave()));
  root.appendChild(bar);

  if (!currentSongId) {
    root.appendChild(el('div', null, 'No songs yet — click "+ song" to create one.'));
    container.appendChild(root);
    return;
  }
  ensureTiming(song());

  // ── Settings: tempo grid + mix headroom + crossfade ──
  root.appendChild(buildSettingsRow());

  // ── Vibe scenes ──
  const intRow = el('div', 'me-int');
  intRow.appendChild(el('span', 'lbl', 'Vibe'));
  const sceneBtn = (label, tier) => {
    const b = el('button', activeTier === tier ? 'active' : null, label);
    b.title = tier ? (song().vibeDocs?.[tier] || tier) : 'All stems at their base/full mix';
    b.addEventListener('click', () => setScene(tier));
    return b;
  };
  intRow.appendChild(sceneBtn('All', null));
  for (const tier of Object.keys(song().intensity || {})) intRow.appendChild(sceneBtn(tier, tier));
  const add = el('button', 'add', '+ vibe');
  add.addEventListener('click', addVibe);
  intRow.appendChild(add);
  root.appendChild(intRow);

  if (activeTier) root.appendChild(buildVibeEditRow());

  // ── Mixer (click a strip to select; faders show the active scene's levels) ──
  root.appendChild(el('div', 'me-scene', activeTier ? `Mixing vibe: ${activeTier}` : 'Mixing: All (base mix)'));
  const mixer = el('div', 'me-mixer');
  song().stems.forEach((stem) => mixer.appendChild(channelStrip(stem)));
  const addStemBtn = el('button', 'me-addstem', '+ add\nstem');
  addStemBtn.addEventListener('click', () => {
    const s = addStem(song(), { sound: '' });
    s.notes = [];
    selectedStem = s;
    structuralEdit(); // resync so the (empty) stem gets a loop → live note edits are heard
  });
  mixer.appendChild(addStemBtn);
  root.appendChild(mixer);

  // ── Piano roll for the selected stem ──
  root.appendChild(buildPianoRollPanel());

  root.appendChild(el('div', 'me-hint', 'Click a stem to edit. Draw / drag to move·resize, right-click or Delete to remove, Alt-drag (or the velocity lane) for velocity, click the keys to preview. Ctrl+wheel zooms, drag the minimap to scroll, drag the ruler to move the playhead. Space = play/pause. Edits play live.'));

  container.appendChild(root);
}

function buildSettingsRow() {
  const row = el('div', 'me-settings');

  const slider = (label, min, max, step, value, fmt, onInput) => {
    const wrap = el('div', 'me-knob');
    wrap.appendChild(el('label', null, label));
    const input = el('input'); input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
    const v = el('span', 'v', fmt(value));
    input.addEventListener('input', () => { const val = parseFloat(input.value); v.textContent = fmt(val); onInput(val); saveManager.markDirty(); });
    wrap.appendChild(input); wrap.appendChild(v);
    return wrap;
  };
  const numField = (label, value, min, max, onChange) => {
    const wrap = el('div', 'me-knob');
    wrap.appendChild(el('label', null, label));
    const input = el('input', 'me-num'); input.type = 'number';
    input.min = String(min); input.max = String(max); input.value = String(value);
    input.addEventListener('change', () => {
      let val = parseFloat(input.value); if (isNaN(val)) val = min;
      val = Math.max(min, Math.min(max, val)); input.value = String(val);
      onChange(val); saveManager.markDirty();
    });
    wrap.appendChild(input);
    return wrap;
  };

  // Tempo grid (drives the piano roll + loop length)
  row.appendChild(numField('BPM', song().bpm, 40, 300, val => { song().bpm = val; pushAllStems(); pianoRoll?.setSong(song()); }));
  row.appendChild(numField('Bars', song().bars, 1, 32, val => { song().bars = val; pushAllStems(); pianoRoll?.setSong(song()); }));
  row.appendChild(numField('Beats/bar', song().beatsPerBar, 1, 12, val => { song().beatsPerBar = val; pushAllStems(); pianoRoll?.setSong(song()); }));
  const gridWrap = el('div', 'me-knob');
  gridWrap.appendChild(el('label', null, 'Grid'));
  gridWrap.appendChild(selectEl(GRID_OPTS, String(song().grid), val => { song().grid = parseFloat(val); saveManager.markDirty(); pianoRoll?.setSong(song()); }));
  row.appendChild(gridWrap);

  // Mix
  row.appendChild(slider('Mix level', 0, 1, 0.01, song().masterLevel ?? 0.35, x => x.toFixed(2), val => { song().masterLevel = val; }));
  row.appendChild(slider('Crossfade', 0, 5, 0.1, song().fadeSeconds ?? 1.5, x => x.toFixed(1) + 's', val => { song().fadeSeconds = val; }));
  return row;
}

function buildVibeEditRow() {
  const row = el('div', 'me-vibe-edit');

  const renameBtn = el('button', 'me-mini', '✎ rename');
  renameBtn.addEventListener('click', () => {
    const next = (prompt('Rename vibe:', activeTier) || '').trim();
    if (!next) return;
    if (renameVibe(song(), activeTier, next)) { activeTier = next; structuralEdit(); }
    else alert('Could not rename (name blank or already exists).');
  });
  row.appendChild(renameBtn);

  const delBtn = el('button', 'me-mini danger', '🗑 delete');
  delBtn.addEventListener('click', () => {
    if (!confirm(`Delete vibe "${activeTier}"?`)) return;
    deleteVibe(song(), activeTier);
    activeTier = null;
    structuralEdit();
  });
  row.appendChild(delBtn);

  const doc = el('input', 'doc');
  doc.placeholder = 'Describe this vibe (when it plays, mood)…';
  doc.value = song().vibeDocs?.[activeTier] || '';
  doc.addEventListener('change', () => { setVibeDoc(song(), activeTier, doc.value); saveManager.markDirty(); });
  row.appendChild(doc);
  return row;
}

function channelStrip(stem) {
  const ch = el('div', 'me-ch' + (stem === selectedStem ? ' selected' : ''));
  ch.title = 'Click to edit this stem’s notes';

  const name = el('div', 'me-ch-name', stem.name);
  ch.appendChild(name);
  ch.addEventListener('click', (e) => { if (e.target === fader || mgmtHit(e)) return; selectStem(stem); });

  // Level fader (edits the active scene) — does not change selection
  const lvl = sceneLevel(stem);
  const fader = el('input', 'me-fader');
  fader.type = 'range'; fader.min = '0'; fader.max = '1'; fader.step = '0.01'; fader.value = String(lvl);
  const val = el('div', 'me-ch-val', lvl.toFixed(2));
  fader.addEventListener('input', (e) => {
    e.stopPropagation();
    const v = parseFloat(fader.value);
    setSceneLevel(stem, v); val.textContent = v.toFixed(2);
    saveManager.markDirty(); applyMix();
  });
  fader.addEventListener('click', (e) => e.stopPropagation());
  ch.appendChild(fader);
  ch.appendChild(val);

  // Mute / Solo
  const btns = el('div', 'me-ch-btns');
  btns.appendChild(msBtn('M', muted.has(stem.name), '#b5483a', () => {
    if (muted.has(stem.name)) muted.delete(stem.name); else muted.add(stem.name);
    applyMix(); buildUI();
  }));
  btns.appendChild(msBtn('S', soloStem === stem.name, '#c9a227', () => {
    soloStem = soloStem === stem.name ? null : stem.name;
    applyMix(); buildUI();
  }));
  ch.appendChild(btns);

  function mgmtHit(e) { return btns.contains(e.target); }
  return ch;
}

function msBtn(label, active, color, onClick) {
  const b = el('button', 'me-ms', label);
  if (active) { b.style.background = color; b.style.color = '#160d04'; b.style.borderColor = color; }
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function buildPianoRollPanel() {
  const panel = el('div', 'me-pr');
  const head = el('div', 'me-pr-head');

  // Selection may have been removed by a structural edit.
  if (selectedStem && !song().stems.includes(selectedStem)) selectedStem = null;

  if (!selectedStem) {
    head.appendChild(el('span', 'me-pr-hint', 'Select a stem above to edit its notes.'));
    panel.appendChild(head);
    return panel;
  }

  const stem = selectedStem;
  stem.notes ??= [];
  const idx = song().stems.indexOf(stem);

  head.appendChild(el('span', 'me-pr-title', stem.name));

  const rename = el('button', 'me-mini', '✎');
  rename.title = 'Rename stem';
  rename.addEventListener('click', () => {
    const next = (prompt('Rename stem:', stem.name) || '').trim();
    if (!next) return;
    if (renameStem(song(), stem.name, next)) structuralEdit();
    else alert('Could not rename (name blank or already exists).');
  });
  head.appendChild(rename);

  head.appendChild(el('span', 'me-pr-hint', 'instrument'));
  const soundOpts = [{ value: '', label: '(no sound)' }, ...Object.keys(SOUND_CONFIG).sort().map(id => ({ value: id, label: id }))];
  head.appendChild(selectEl(soundOpts, stem.sound || '', (v) => {
    stem.sound = v;
    saveManager.markDirty();
    // Swap just this stem's instrument in phase — no full-song restart. (Legacy .mid songs with
    // no tempo can't phase-align a single stem, so they fall back to a resync.)
    if (playing) { if (song().bpm && music.swapStemSound(stem.name, v, song(), targetGain(stem))) { /* swapped live */ } else resyncIfPlaying(); }
  }));

  const imp = el('button', 'me-mini', 'Import .mid…');
  imp.addEventListener('click', () => importMidiInto(stem));
  head.appendChild(imp);

  const clr = el('button', 'me-mini', 'Clear');
  clr.addEventListener('click', () => {
    if (!stem.notes.length || confirm(`Clear all notes in "${stem.name}"?`)) {
      stem.notes = []; saveManager.markDirty();
      if (playing) music.updateStemNotes(stem.name, stem.notes, song());
      buildUI();
    }
  });
  head.appendChild(clr);

  const up = el('button', 'me-mini', '↑'); up.disabled = idx <= 0;
  up.addEventListener('click', () => { if (reorderStem(song(), idx, -1)) structuralEdit({ resync: false }); });
  const down = el('button', 'me-mini', '↓'); down.disabled = idx >= song().stems.length - 1;
  down.addEventListener('click', () => { if (reorderStem(song(), idx, +1)) structuralEdit({ resync: false }); });
  const rm = el('button', 'me-mini danger', '✕ remove');
  rm.addEventListener('click', () => {
    if (!confirm(`Remove stem "${stem.name}"?`)) return;
    removeStem(song(), stem.name); selectedStem = null; structuralEdit();
  });
  head.appendChild(up); head.appendChild(down); head.appendChild(rm);

  head.appendChild(el('span', 'me-pr-info', `${song().bars} bars · ${song().bpm} BPM · ${stem.notes.length} notes`));
  panel.appendChild(head);

  const body = el('div', 'me-pr-body');
  panel.appendChild(body);
  if (!pianoRoll) pianoRoll = createPianoRoll(body, { onEdit: onNotesEdited, getPhase: () => music?.getPhase() ?? null, previewNote, onSeek: (ph) => { if (playing) music.seekTo(ph); } });
  else body.appendChild(pianoRoll.el);
  pianoRoll.setPattern(stem.notes, song());
  pianoRoll.setPlaying(playing);

  return panel;
}
