// Music editor — assemble + audition the layered adaptive song like a mixing console.
// A top bar (song selector + New + Play), a song-settings row (mix headroom + crossfade),
// "vibe" scene buttons (with rename/delete + a description field), and a channel-strip
// mixer: one strip per stem with its sound/track assignment, a vertical level fader, and
// mute/solo + reorder/remove. The faders ARE the live mix — picking a vibe loads that
// scene's per-stem levels onto the faders (and the audio follows); "All" edits the song's
// base/full mix. Saves to data/music.json (and, only if you reassign a stem's MIDI track,
// to data/sfx.json — that track lives on the underlying sound).
import { SoundManager } from '/engine/audio/SoundManager.js';
import { MusicDirector } from '/engine/audio/MusicDirector.js';
import { MUSIC_SONGS } from '/engine/data/music.js';
// SOUND_CONFIG is the live registry the SoundManager reads at play time. We clone it into
// `workingSounds` for saving, but also write track edits straight into it so reassignments
// preview immediately on the next (re)sync.
import { SOUND_CONFIG } from '/engine/data/sounds.js';
import { SaveManager } from './editorShared.js';
import {
  newSong, addStem, removeStem, renameStem, reorderStem,
  renameVibe, deleteVibe, setVibeDoc,
} from './musicModel.js';

let container = null;
let soundManager = null;
let music = null;
let loadPromise = null;
let saveManager = null;     // music.json
let sfxSaveManager = null;  // sfx.json — only touched when a stem's MIDI track is reassigned

let workingSongs = {};      // editable deep clone of MUSIC_SONGS
let workingSounds = {};     // editable deep clone of SOUND_CONFIG (for track write-through)
let currentSongId = null;
let playing = false;
let activeTier = null;      // selected vibe scene (null = "All", the base mix)
let soloStem = null;        // transient solo
const muted = new Set();    // transient mutes

const TWEAK_FADE = 0.18; // quick fade while dragging a fader
const SCENE_FADE = 0.9;  // musical fade when switching vibes

// ─── Mount / Unmount ───────────────────────────────────────────────────────

export function mount(el) {
  container = el;
  workingSongs = JSON.parse(JSON.stringify(MUSIC_SONGS));
  workingSounds = JSON.parse(JSON.stringify(SOUND_CONFIG));
  currentSongId = Object.keys(workingSongs)[0] || null;

  soundManager = new SoundManager();
  loadPromise = soundManager.init();
  music = new MusicDirector(soundManager);

  saveManager = new SaveManager('music.json');
  sfxSaveManager = new SaveManager('sfx.json');
  const sync = () => window.editorSetUnsaved?.('music', anyDirty());
  saveManager.onDirtyChange(sync);
  sfxSaveManager.onDirtyChange(sync);

  injectStyle();
  buildUI();
}

export function unmount() {
  try { music?.stop({ fadeOut: 0.1 }); } catch {}
  playing = false;
  container = null;
}

export function save() { doSave(); }
export function isDirty() { return anyDirty(); }

function anyDirty() { return !!(saveManager?.isDirty() || sfxSaveManager?.isDirty()); }

async function doSave() {
  try {
    if (saveManager.isDirty()) await saveManager.save({ songs: workingSongs });
    if (sfxSaveManager.isDirty()) {
      // The music editor only mutates `synth.midi.track` on sounds; write the full working
      // sound set back (categories derived like the soundboard does).
      const categories = [...new Set(Object.values(workingSounds).map(s => s.category).filter(Boolean))].sort();
      await sfxSaveManager.save({ categories, sounds: workingSounds });
    }
  } catch (err) { alert('Save failed: ' + err.message); }
}

// ─── Scenes + live mix ───────────────────────────────────────────────────────

function song() { return workingSongs[currentSongId]; }

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
  playing = true;
  applyMix(0.5); // honor any mute/solo
  buildUI();
}

function stop() {
  music.stop({ fadeOut: 0.4 });
  playing = false;
  buildUI();
}

function setScene(tier) {
  activeTier = tier;
  applyMix(SCENE_FADE); // faders + audio move to this vibe
  buildUI();
}

/**
 * Rebuild the stem loops on a fresh shared downbeat so reassigned sounds/tracks and
 * added/removed stems are heard immediately. All stems restart together, so they stay
 * sample-accurately in sync — unlike hot-swapping one loop mid-song. No-op when stopped.
 */
function resyncIfPlaying() {
  if (!playing) return;
  music.startSong(song(), { intensity: activeTier || undefined, fadeSeconds: 0.3 });
  applyMix(0.3); // honor any mute/solo
}

/** A structural edit (stems/vibes) — mark dirty, drop transient mute/solo, rebuild. */
function structuralEdit({ resync = true } = {}) {
  saveManager.markDirty();
  muted.clear();
  soloStem = null;
  if (resync) resyncIfPlaying();
  buildUI();
}

/** Reassign a stem's MIDI track — lives on the sound, so write the working copy AND the
 *  live registry the SoundManager plays from, then re-sync to hear it. */
function setStemTrack(stem, val) {
  for (const target of [workingSounds[stem.sound], SOUND_CONFIG[stem.sound]]) {
    if (!target?.synth) continue;
    if (typeof target.synth.midi === 'string') target.synth.midi = { file: target.synth.midi };
    if (!target.synth.midi) continue;
    if (val === '') delete target.synth.midi.track; else target.synth.midi.track = val;
  }
  sfxSaveManager.markDirty();
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
  activeTier = null; soloStem = null; muted.clear();
  if (playing) stop();
  saveManager.markDirty();
  buildUI();
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
  #me-root{font:13px system-ui,sans-serif;color:#d8cfa8;padding:12px;max-width:1000px}
  .me-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
  .me-spacer{flex:1}
  .me-sel{background:#161109;color:#d8cfa8;border:1px solid #5a4a30;border-radius:4px;padding:5px 8px;font-size:12px}
  .me-play{background:#3a6a3a;color:#eafaea;border:1px solid #5a8a5a;border-radius:4px;padding:6px 18px;font-weight:600;cursor:pointer}
  .me-play.stop{background:#7a3030;border-color:#a85050}
  .me-new{background:#2a2118;color:#c9b48a;border:1px dashed #5a4a30;border-radius:4px;padding:6px 12px;cursor:pointer;font-size:12px}
  .me-settings{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-bottom:12px;padding:8px 12px;background:#100b05;border:1px solid #4a3c24;border-radius:6px}
  .me-knob{display:flex;align-items:center;gap:8px}
  .me-knob label{color:#9a875a;font-size:12px}
  .me-knob input[type=range]{width:120px;accent-color:#c9a227}
  .me-knob .v{font-size:11px;color:#9a875a;font-variant-numeric:tabular-nums;width:30px}
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
  .me-ch{display:flex;flex-direction:column;align-items:center;gap:5px;width:110px;padding:6px;background:#161109;border:1px solid #3a2f1c;border-radius:5px}
  .me-ch-name{font-size:12px;color:#e0c98a;font-weight:600;cursor:pointer;text-align:center;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .me-ch-name:hover{text-decoration:underline}
  .me-ch .me-sel{width:100%;font-size:11px;padding:3px 4px}
  .me-fader{writing-mode:vertical-lr;direction:rtl;width:24px;height:130px;accent-color:#c9a227;cursor:pointer;margin-top:4px}
  .me-ch-val{font-size:11px;color:#9a875a;font-variant-numeric:tabular-nums}
  .me-ch-btns{display:flex;gap:3px}
  .me-ms{width:22px;height:22px;border:1px solid #5a4a30;border-radius:3px;cursor:pointer;font-size:10px;font-weight:600;background:#2a2118;color:#c9b48a}
  .me-move{width:22px;height:22px;border:1px solid #5a4a30;border-radius:3px;cursor:pointer;font-size:11px;background:#2a2118;color:#c9b48a}
  .me-move:disabled{opacity:0.3;cursor:default}
  .me-addstem{align-self:stretch;min-width:90px;background:#1a140c;color:#9a875a;border:1px dashed #5a4a30;border-radius:5px;cursor:pointer;font-size:12px}
  .me-hint{color:#7a6a4a;font-size:11px;margin-top:8px}
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
    currentSongId = sel.value; activeTier = null; soloStem = null; muted.clear();
    buildUI();
  });
  bar.appendChild(sel);

  const newBtn = el('button', 'me-new', '+ song');
  newBtn.addEventListener('click', newSongPrompt);
  bar.appendChild(newBtn);

  if (currentSongId) {
    const playBtn = el('button', 'me-play' + (playing ? ' stop' : ''), playing ? '■ Stop' : '▶ Play');
    playBtn.addEventListener('click', () => (playing ? stop() : play()));
    bar.appendChild(playBtn);
  }

  bar.appendChild(el('div', 'me-spacer'));
  bar.appendChild(saveManager.getStatusIndicator());
  bar.appendChild(saveManager.getSaveButton(() => doSave()));
  root.appendChild(bar);

  if (!currentSongId) {
    root.appendChild(el('div', null, 'No songs yet — click "+ song" to create one.'));
    container.appendChild(root);
    return;
  }

  // ── Song settings: mix headroom + crossfade ──
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

  // ── Active-vibe editor (rename / delete / description) ──
  if (activeTier) root.appendChild(buildVibeEditRow());

  // ── Mixer (faders show the active scene's levels) ──
  root.appendChild(el('div', 'me-scene', activeTier ? `Mixing vibe: ${activeTier}` : 'Mixing: All (base mix)'));
  const mixer = el('div', 'me-mixer');
  song().stems.forEach((stem, i) => mixer.appendChild(channelStrip(stem, i)));
  const addStemBtn = el('button', 'me-addstem', '+ add\nstem');
  addStemBtn.addEventListener('click', () => {
    addStem(song(), { sound: '' });
    structuralEdit({ resync: false }); // new stem has no sound yet → nothing to play
  });
  mixer.appendChild(addStemBtn);
  root.appendChild(mixer);

  root.appendChild(el('div', 'me-hint', 'Faders, instrument, and track changes apply live while playing. Mix level / crossfade apply on the next Play.'));

  container.appendChild(root);
}

function buildSettingsRow() {
  const row = el('div', 'me-settings');

  const knob = (label, min, max, step, value, fmt, onInput) => {
    const wrap = el('div', 'me-knob');
    wrap.appendChild(el('label', null, label));
    const input = el('input'); input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
    const v = el('span', 'v', fmt(value));
    input.addEventListener('input', () => {
      const val = parseFloat(input.value);
      v.textContent = fmt(val);
      onInput(val);
      saveManager.markDirty();
    });
    wrap.appendChild(input); wrap.appendChild(v);
    return wrap;
  };

  row.appendChild(knob('Mix level', 0, 1, 0.01, song().masterLevel ?? 0.35,
    x => x.toFixed(2), val => { song().masterLevel = val; }));
  row.appendChild(knob('Crossfade (s)', 0, 5, 0.1, song().fadeSeconds ?? 1.5,
    x => x.toFixed(1) + 's', val => { song().fadeSeconds = val; }));
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
  doc.addEventListener('change', () => {
    setVibeDoc(song(), activeTier, doc.value);
    saveManager.markDirty();
  });
  row.appendChild(doc);
  return row;
}

function channelStrip(stem, i) {
  const ch = el('div', 'me-ch');

  // Name (click to rename)
  const name = el('div', 'me-ch-name', stem.name);
  name.title = 'Click to rename';
  name.addEventListener('click', () => {
    const next = (prompt('Rename stem:', stem.name) || '').trim();
    if (!next) return;
    if (renameStem(song(), stem.name, next)) structuralEdit();
    else alert('Could not rename (name blank or already exists).');
  });
  ch.appendChild(name);

  // Sound assignment (which sfx sound = timbre + track drives this stem)
  const soundOpts = [{ value: '', label: '(no sound)' },
    ...Object.keys(workingSounds).sort().map(id => ({ value: id, label: id }))];
  ch.appendChild(selectEl(soundOpts, stem.sound || '', (val) => {
    stem.sound = val;
    saveManager.markDirty();
    resyncIfPlaying(); // swap the instrument live
    buildUI(); // refresh the track dropdown for the new sound
  }));

  // Track assignment — lives on the sound's synth.midi; editing it writes through to sfx.json.
  const snd = stem.sound ? workingSounds[stem.sound] : null;
  const midi = snd?.synth?.midi;
  const midiFile = midi && (typeof midi === 'string' ? midi : midi.file);
  if (midiFile) {
    const info = soundManager.midiData.get(midiFile);
    if (!info) {
      // Not parsed yet — load, then re-render with the real track list.
      soundManager.loadMidi(midiFile).then(() => buildUI()).catch(() => {});
      const loading = el('div', 'me-ch-val', 'tracks…');
      ch.appendChild(loading);
    } else if (info.tracks && info.tracks.length > 1) {
      const cur = typeof midi === 'object' && midi.track != null ? String(midi.track) : '';
      const trackOpts = [{ value: '', label: '(whole song)' },
        ...info.tracks.map(t => ({ value: t.name, label: `${t.name} (${t.notes.length})` }))];
      ch.appendChild(selectEl(trackOpts, cur, (val) => {
        setStemTrack(stem, val);
        resyncIfPlaying(); // play the new track live
        buildUI();
      }));
    }
  }

  // Level fader (edits the active scene)
  const lvl = sceneLevel(stem);
  const fader = el('input', 'me-fader');
  fader.type = 'range'; fader.min = '0'; fader.max = '1'; fader.step = '0.01'; fader.value = String(lvl);
  const val = el('div', 'me-ch-val', lvl.toFixed(2));
  fader.addEventListener('input', () => {
    const v = parseFloat(fader.value);
    setSceneLevel(stem, v);
    val.textContent = v.toFixed(2);
    saveManager.markDirty();
    applyMix(); // live, no rebuild → smooth dragging
  });
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

  // Reorder / remove
  const mgmt = el('div', 'me-ch-btns');
  const up = el('button', 'me-move', '↑'); up.disabled = i === 0;
  up.addEventListener('click', () => { if (reorderStem(song(), i, -1)) structuralEdit({ resync: false }); });
  const down = el('button', 'me-move', '↓'); down.disabled = i === song().stems.length - 1;
  down.addEventListener('click', () => { if (reorderStem(song(), i, +1)) structuralEdit({ resync: false }); });
  const rm = el('button', 'me-move', '✕'); rm.title = 'Remove stem';
  rm.addEventListener('click', () => {
    if (!confirm(`Remove stem "${stem.name}"?`)) return;
    removeStem(song(), stem.name);
    structuralEdit();
  });
  mgmt.appendChild(up); mgmt.appendChild(down); mgmt.appendChild(rm);
  ch.appendChild(mgmt);

  return ch;
}

function msBtn(label, active, color, onClick) {
  const b = el('button', 'me-ms', label);
  if (active) { b.style.background = color; b.style.color = '#160d04'; b.style.borderColor = color; }
  b.addEventListener('click', onClick);
  return b;
}
