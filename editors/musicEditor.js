// Music editor — audition + tune the layered adaptive song like a real mixing console.
// A compact top bar (song selector + Play), "vibe" scene buttons, and a channel-strip
// mixer of vertical faders (one per stem) with mute/solo. The faders ARE the live mix:
// picking a vibe loads that scene's per-stem levels onto the faders (and the audio follows);
// dragging a fader edits the selected scene. "All" edits the song's base/full mix; each vibe
// is an intensity tier of absolute per-stem gains. Saves to data/music.json.
import { SoundManager } from '/engine/audio/SoundManager.js';
import { MusicDirector } from '/engine/audio/MusicDirector.js';
import { MUSIC_SONGS } from '/engine/data/music.js';
import { SaveManager } from './editorShared.js';

let container = null;
let soundManager = null;
let music = null;
let loadPromise = null;
let saveManager = null;

let workingSongs = {};   // editable deep clone of MUSIC_SONGS
let currentSongId = null;
let playing = false;
let activeTier = null;   // selected vibe scene (null = "All", the base mix)
let soloStem = null;     // transient solo
const muted = new Set(); // transient mutes

const TWEAK_FADE = 0.18; // quick fade while dragging a fader
const SCENE_FADE = 0.9;  // musical fade when switching vibes

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

  injectStyle();
  buildUI();
}

export function unmount() {
  try { music?.stop({ fadeOut: 0.1 }); } catch {}
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

function addVibe() {
  const name = (prompt('New vibe name:') || '').trim();
  if (!name) return;
  song().intensity = song().intensity || {};
  if (!song().intensity[name]) song().intensity[name] = {};
  saveManager.markDirty();
  setScene(name);
}

// ─── UI ──────────────────────────────────────────────────────────────────────

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

function injectStyle() {
  if (document.getElementById('me-style')) return;
  const s = el('style'); s.id = 'me-style';
  s.textContent = `
  #me-root{font:13px system-ui,sans-serif;color:#d8cfa8;padding:12px;max-width:820px}
  .me-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
  .me-spacer{flex:1}
  .me-sel{background:#161109;color:#d8cfa8;border:1px solid #5a4a30;border-radius:4px;padding:5px 8px;font-size:13px}
  .me-play{background:#3a6a3a;color:#eafaea;border:1px solid #5a8a5a;border-radius:4px;padding:6px 18px;font-weight:600;cursor:pointer}
  .me-play.stop{background:#7a3030;border-color:#a85050}
  .me-int{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:12px}
  .me-int .lbl{color:#9a875a;font-size:12px;margin-right:2px}
  .me-int button{background:#2a2118;color:#c9b48a;border:1px solid #5a4a30;border-radius:14px;padding:4px 13px;cursor:pointer;font-size:12px;text-transform:capitalize}
  .me-int button.active{background:#c9a227;color:#160d04;border-color:#c9a227;font-weight:600}
  .me-int button.add{border-style:dashed;color:#9a875a;text-transform:none}
  .me-scene{color:#9a875a;font-size:12px;margin-bottom:6px}
  .me-mixer{display:flex;gap:6px;padding:12px;background:#100b05;border:1px solid #4a3c24;border-radius:6px;width:max-content}
  .me-ch{display:flex;flex-direction:column;align-items:center;gap:6px;width:52px}
  .me-ch-name{font-size:11px;color:#b59a64;text-align:center;line-height:1.1;height:24px;display:flex;align-items:center}
  .me-fader{writing-mode:vertical-lr;direction:rtl;width:24px;height:140px;accent-color:#c9a227;cursor:pointer}
  .me-ch-val{font-size:11px;color:#9a875a;font-variant-numeric:tabular-nums}
  .me-ch-btns{display:flex;gap:3px}
  .me-ms{width:20px;height:20px;border:1px solid #5a4a30;border-radius:3px;cursor:pointer;font-size:10px;font-weight:600;background:#2a2118;color:#c9b48a}
  `;
  document.head.appendChild(s);
}

function buildUI() {
  if (!container) return;
  container.innerHTML = '';
  const root = el('div'); root.id = 'me-root';

  if (!currentSongId) {
    root.appendChild(el('div', null, 'No songs in data/music.json.'));
    container.appendChild(root);
    return;
  }

  // ── Top bar: song selector | Play/Stop | spacer | Save ──
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

  const playBtn = el('button', 'me-play' + (playing ? ' stop' : ''), playing ? '■ Stop' : '▶ Play');
  playBtn.addEventListener('click', () => (playing ? stop() : play()));
  bar.appendChild(playBtn);

  bar.appendChild(el('div', 'me-spacer'));
  bar.appendChild(saveManager.getStatusIndicator());
  bar.appendChild(saveManager.getSaveButton(() => doSave()));
  root.appendChild(bar);

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

  // ── Mixer (faders show the active scene's levels) ──
  root.appendChild(el('div', 'me-scene', activeTier ? `Mixing vibe: ${activeTier}` : 'Mixing: All (base mix)'));
  const mixer = el('div', 'me-mixer');
  for (const stem of song().stems) mixer.appendChild(channelStrip(stem));
  root.appendChild(mixer);

  container.appendChild(root);
}

function channelStrip(stem) {
  const ch = el('div', 'me-ch');
  ch.appendChild(el('div', 'me-ch-name', stem.name));

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
  return ch;
}

function msBtn(label, active, color, onClick) {
  const b = el('button', 'me-ms', label);
  if (active) { b.style.background = color; b.style.color = '#160d04'; b.style.borderColor = color; }
  b.addEventListener('click', onClick);
  return b;
}
