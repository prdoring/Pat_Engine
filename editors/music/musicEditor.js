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
import { SaveManager, modalAlert, modalConfirm, modalPrompt, modalSelect, isModalOpen, openModal, modalBtn, btnRow } from '/editors/shared/index.js';
import {
  newSong, addStem, removeStem, renameStem, reorderStem,
  renameVibe, deleteVibe, setVibeDoc,
  cloneStem, cloneVibe, uniqueSongId, renameSong, duplicateSong, deleteSong,
} from './model/musicModel.js';
import { importMidiTrack, snap as snapBeat, sortNotes, PITCH_MIN, PITCH_MAX } from './model/midiModel.js';
import { importAbc, stemToAbc } from './model/abcModel.js';
import { parseMidi } from '/engine/audio/midi.js';
import { createPianoRoll } from './pianoRoll.js';

let container = null;
let soundManager = null;
let music = null;
let loadPromise = null;
let saveManager = null;     // music.json

let workingSongs = {};      // editable deep clone of MUSIC_SONGS
let currentSongId = null;
let playing = false;        // the one transport flag — mirrors MusicDirector.isPlaying()
let playheadPhase = 0;      // editor-owned playhead position 0..1 (drives play start + the visual head)
let seeking = false;        // true while scrubbing the ruler (freezes head tracking)
let playBtns = [];          // every transport play/pause button (updated together)
let activeTier = null;      // selected vibe scene (null = "All", the base mix)
let soloStem = null;        // transient solo
const muted = new Set();    // transient mutes
let selectedStem = null;    // stem whose notes the piano roll edits
let pianoRoll = null;       // persistent piano-roll instance (survives buildUI re-renders)
let undoStack = [];         // each entry is a workingSongs snapshot; top = current state
let redoStack = [];
let undoBtnEl = null, redoBtnEl = null;

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

  undoStack = [snap()]; redoStack = [];
  window.addEventListener('keydown', onMusicKey);
  container.addEventListener('dragover', onDragOver);
  container.addEventListener('dragleave', onDragLeave);
  container.addEventListener('drop', onDrop);

  injectStyle();
  buildUI();
}

// Keyboard: Space = play/pause, Ctrl+Z/Y (or Ctrl+Shift+Z) = undo/redo, ← = playhead to start.
// Only when the Music tab is visible, no modal is open, and you're not typing in a field.
function onMusicKey(e) {
  if (e.repeat && e.code !== 'Space') { /* allow held arrows? no */ }
  if (isModalOpen()) return;
  if (!container || container.offsetParent === null) return;
  if (/^(input|textarea|select)$/i.test(e.target?.tagName || '')) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey) return;
  if (e.code === 'Space' && !e.repeat) { e.preventDefault(); toggleTransport(); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); setPlayhead(0); return; }
}

export function unmount() {
  try { music?.stop({ fadeOut: 0.1 }); } catch {}
  try { pianoRoll?.destroy(); } catch {}
  window.removeEventListener('keydown', onMusicKey);
  container?.removeEventListener('dragover', onDragOver);
  container?.removeEventListener('dragleave', onDragLeave);
  container?.removeEventListener('drop', onDrop);
  if (dropHintEl) { dropHintEl.remove(); dropHintEl = null; }
  pianoRoll = null;
  playing = false;
  container = null;
}

// ─── Undo / redo (workingSongs snapshots) ──────────────────────────────────
function snap() { return JSON.parse(JSON.stringify(workingSongs)); }
function commitUndo() { undoStack.push(snap()); if (undoStack.length > 80) undoStack.shift(); redoStack = []; updateUndoBtns(); }
function updateUndoBtns() { if (undoBtnEl) undoBtnEl.disabled = undoStack.length <= 1; if (redoBtnEl) redoBtnEl.disabled = redoStack.length === 0; }
function undo() { if (undoStack.length <= 1) return; redoStack.push(undoStack.pop()); restoreState(undoStack[undoStack.length - 1]); }
function redo() { if (!redoStack.length) return; const s = redoStack.pop(); undoStack.push(s); restoreState(s); }
function restoreState(s) {
  const name = selectedStem?.name;
  workingSongs = JSON.parse(JSON.stringify(s));
  if (!workingSongs[currentSongId]) currentSongId = Object.keys(workingSongs)[0] || null;
  selectedStem = (currentSongId && name) ? (song()?.stems.find(st => st.name === name) || null) : null;
  if (activeTier && !song()?.intensity?.[activeTier]) activeTier = null;
  saveManager.markDirty();
  if (playing) resyncIfPlaying();
  buildUI();
}

// ─── Playhead ──────────────────────────────────────────────────────────────
function setPlayhead(ph, committed = true) {
  playheadPhase = Math.max(0, Math.min(0.9999, ph));
  // While playing, seek the live loops; while stopped/paused, just move the head — Play picks
  // it up. (`committed` is false mid-drag so we only seek the audio on release.)
  if (committed) { seeking = false; if (playing) music.seekTo(playheadPhase); }
  else { seeking = true; }
  pianoRoll?.redraw();
}
function stepPlayhead(dir) { setPlayhead(playheadPhase + dir / Math.max(1, song()?.bars || 1)); }

export function save() { doSave(); }
export function isDirty() { return saveManager?.isDirty() ?? false; }

async function doSave() {
  if (!saveManager.isDirty()) return;
  try { await saveManager.save({ songs: workingSongs }); }
  catch (err) { modalAlert('Save failed: ' + err.message, { title: 'Save failed' }); }
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

// ─── Transport (one authoritative player: MusicDirector) ───────────────────
// Play / pause / stop never touch the AudioContext's suspended state — the context stays
// running so note auditioning works in every state. "Pause" tears the song's loops down (so
// nothing keeps scheduling — no runaway) but keeps the playhead; Play restarts from it.

async function play() {
  if (!currentSongId || playing) return;
  soundManager.resume();           // ensure the context is running (no-op after the first time)
  await loadPromise;
  if (!music.startSong(song(), { intensity: activeTier || undefined, fadeSeconds: 0.4 })) return; // empty song / no ctx
  playing = true; seeking = false;
  if (playheadPhase > 0.0005) music.seekTo(playheadPhase); // start from the playhead, not the top
  applyMix(0.4); // honor any mute/solo
  pianoRoll?.setPlaying(true);
  updateTransportBtn();
}

/** Pause: stop the song but keep the playhead, so Play resumes from the same spot. */
function pause() {
  if (!playing) return;
  const p = music.getPhase(); if (p != null) playheadPhase = p;
  music.stop({ fadeOut: 0.12 });
  playing = false;
  pianoRoll?.setPlaying(false); pianoRoll?.redraw();
  updateTransportBtn();
}

/** Stop: stop the song and rewind the playhead to the start. */
function stop() {
  music.stop({ fadeOut: 0.15 });
  playing = false; playheadPhase = 0;
  pianoRoll?.setPlaying(false); pianoRoll?.redraw();
  updateTransportBtn();
}

function toggleTransport() {
  if (!currentSongId) return;
  if (playing) pause(); else play();
}

function updateTransportBtn() {
  for (const b of playBtns) { b.replaceChildren(svgIcon(playing ? 'pause' : 'play')); b.className = 'me-tcell me-tplay' + (playing ? ' playing' : ''); }
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
  if (playheadPhase > 0.0005) music.seekTo(playheadPhase); // keep the playhead through the restart
  applyMix(0.3);
}

/** A structural edit (stems/vibes) — mark dirty, drop transient mute/solo, rebuild. */
function structuralEdit({ resync = true } = {}) {
  saveManager.markDirty();
  muted.clear();
  soloStem = null;
  if (resync) resyncIfPlaying();
  commitUndo();
  buildUI();
}

async function addVibe() {
  const name = await modalPrompt('', { title: 'New vibe', placeholder: 'vibe name', confirmLabel: 'Add',
    validate: v => !v ? 'Enter a name' : (song().intensity && song().intensity[v]) ? 'That vibe already exists' : '' });
  if (!name) return;
  song().intensity = song().intensity || {};
  song().intensity[name] = song().intensity[name] || {};
  saveManager.markDirty();
  commitUndo();
  setScene(name);
}

async function newSongPrompt() {
  const id = await modalPrompt('', { title: 'New song', placeholder: 'song id', confirmLabel: 'Create',
    validate: v => !v ? 'Enter an id' : workingSongs[v] ? 'That id already exists' : '' });
  if (!id) return;
  workingSongs[id] = newSong();
  currentSongId = id;
  activeTier = null; soloStem = null; muted.clear(); selectedStem = null;
  if (playing) stop();
  saveManager.markDirty();
  commitUndo();
  buildUI();
}

async function dupSongPrompt() {
  if (!currentSongId) return;
  const id = await modalPrompt('', { title: 'Duplicate song', value: uniqueSongId(workingSongs, currentSongId + '-copy'), confirmLabel: 'Duplicate',
    validate: v => !v ? 'Enter an id' : workingSongs[v] ? 'That id already exists' : '' });
  if (!id) return;
  if (!duplicateSong(workingSongs, currentSongId, id)) return;
  currentSongId = id;
  activeTier = null; soloStem = null; muted.clear(); selectedStem = null;
  if (playing) stop();
  saveManager.markDirty();
  commitUndo();
  buildUI();
}

async function renameSongPrompt() {
  if (!currentSongId) return;
  const next = await modalPrompt('', { title: 'Rename song', value: currentSongId, confirmLabel: 'Rename',
    validate: v => !v ? 'Enter an id' : (v !== currentSongId && workingSongs[v]) ? 'That id already exists' : '' });
  if (!next || next === currentSongId) return;
  if (!renameSong(workingSongs, currentSongId, next)) return;
  currentSongId = next;
  saveManager.markDirty();
  commitUndo();
  buildUI();
}

async function deleteSongPrompt() {
  if (!currentSongId) return;
  if (!await modalConfirm(`Delete song "${currentSongId}"? This cannot be undone after saving.`, { title: 'Delete song', confirmLabel: 'Delete', danger: true })) return;
  if (playing) stop();
  deleteSong(workingSongs, currentSongId);
  currentSongId = Object.keys(workingSongs)[0] || null;
  activeTier = null; soloStem = null; muted.clear(); selectedStem = null;
  saveManager.markDirty();
  commitUndo();
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

// ─── Note import (paste ABC · upload .mid/.abc · pick from assets/MIDI) ─────────

/** Parsed MIDI → a beats pattern, prompting for the track when there's more than one. */
async function pickMidiTrack(parsed, label, grid) {
  if (!parsed || !parsed.tracks?.length) { modalAlert('Could not parse ' + label, { title: 'Import' }); return null; }
  let ti = 0;
  if (parsed.tracks.length > 1) {
    ti = await modalSelect('Import which track?', parsed.tracks.map((t, i) => ({ value: i, label: t.name, sub: `${t.notes.length} notes` })), { title: 'Import track' });
    if (ti == null) return null;
  }
  return importMidiTrack(parsed.tracks[ti].notes, song().bpm, grid);
}

/** Let the user pick one of the server's assets/MIDI files; returns its path or null. */
async function pickServerMidi() {
  let files = [];
  try { files = await fetch('/api/midi-files').then(r => (r.ok ? r.json() : [])); } catch {}
  if (!files.length) { modalAlert('No .mid files found in assets/MIDI/.', { title: 'Import' }); return null; }
  if (files.length === 1) return files[0];
  return modalSelect('Import from which MIDI file?', files.map(f => ({ value: f, label: f.split('/').pop() })), { title: 'Import MIDI' });
}

/** Read a dropped/picked file into a beats pattern (binary .mid or text ABC). */
async function fileToNotes(file, grid, beatsPerBar) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.mid') || lower.endsWith('.midi')) {
    const notes = await pickMidiTrack(parseMidi(await file.arrayBuffer()), file.name, grid);
    return notes ? { notes, warnings: [] } : null;
  }
  return importAbc(await file.text(), { grid, beatsPerBar });
}

const MAX_BARS = 64; // safety ceiling when auto-growing the song to fit an import

/** Grow song.bars so every note in `notes` fits inside whole bars. Returns {changed, capped, want}. */
function extendBarsToFit(notes) {
  ensureTiming(song());
  const s = song();
  let maxEnd = 0;
  for (const n of (notes || [])) maxEnd = Math.max(maxEnd, (n.beat || 0) + (n.len || 0));
  const want = Math.max(1, Math.ceil(maxEnd / s.beatsPerBar - 1e-9));
  const needed = Math.min(MAX_BARS, want);
  let changed = false;
  if (needed > s.bars) { s.bars = needed; changed = true; }
  return { changed, capped: want > MAX_BARS, want };
}

/**
 * Put imported notes onto a stem (replace or merge), grow the song length to fit them, push the
 * change live, and commit one undo step. A song has a single shared loop length (song.bars ×
 * beatsPerBar), so an import longer than the current song must extend `bars` or it would loop
 * (and play) out of step. Returns the bar-fit result so callers can surface a cap warning.
 */
function applyImportedNotes(stem, notes, mode) {
  stem.notes = mode === 'add' ? sortNotes([...(stem.notes || []), ...notes]) : notes;
  selectedStem = stem;
  const fit = extendBarsToFit(stem.notes);
  saveManager.markDirty();
  if (playing) {
    // Length change → rebuild every stem on the new loop grid; otherwise just push this stem.
    if (fit.changed) resyncIfPlaying();
    else music.updateStemNotes(stem.name, stem.notes, song());
  }
  commitUndo();
  buildUI();
  return fit;
}

/** Show parser warnings + a bar-cap notice (if any) after an import. */
function importNotice(fit, warnings = []) {
  const msgs = [...(warnings || [])];
  if (fit?.capped) msgs.push(`This tune is ${fit.want} bars long — the song was capped at ${MAX_BARS} bars, so notes past bar ${MAX_BARS} may not loop in time.`);
  if (msgs.length) modalAlert(msgs.join('\n'), { title: 'Imported (with notes)' });
}

/** The unified import modal: paste ABC, upload a file, or pick from assets/MIDI. */
async function importInto(stem) {
  ensureTiming(song());
  const grid = song().grid, beatsPerBar = song().beatsPerBar;

  const result = await openModal({
    title: `Import notes → ${stem.name}`, cancelValue: null,
    render(box, close) {
      box.appendChild(el('div', 'editor-modal-msg', 'Paste ABC notation below, upload a .mid / .abc file, or pick from assets/MIDI.'));
      const ta = el('textarea', 'editor-modal-textarea');
      ta.placeholder = 'X:1\nL:1/8\nK:C\nCDEF GABc | cBAG FEDC |';
      box.appendChild(ta);

      let pending = null; // { label, notes } from a binary MIDI source
      const chip = el('div', 'editor-modal-label'); chip.style.minHeight = '16px';
      box.appendChild(chip);
      const setPending = (p) => { pending = p; chip.textContent = p ? `MIDI loaded: ${p.label} · ${p.notes.length} notes` : ''; if (p) ta.value = ''; };
      ta.addEventListener('input', () => { if (pending) setPending(null); });

      // Source buttons
      const srcRow = el('div', 'editor-modal-row');
      const fileInput = el('input'); fileInput.type = 'file'; fileInput.accept = '.mid,.midi,.abc,.txt'; fileInput.style.display = 'none';
      fileInput.addEventListener('change', async () => {
        const f = fileInput.files?.[0]; fileInput.value = ''; if (!f) return;
        const lower = f.name.toLowerCase();
        if (lower.endsWith('.mid') || lower.endsWith('.midi')) {
          const notes = await pickMidiTrack(parseMidi(await f.arrayBuffer()), f.name, grid);
          if (notes) setPending({ label: f.name, notes });
        } else { ta.value = await f.text(); setPending(null); ta.focus(); }
      });
      srcRow.appendChild(modalBtn('Choose file…', '', () => fileInput.click()));
      srcRow.appendChild(modalBtn('From assets/MIDI…', '', async () => {
        const file = await pickServerMidi(); if (!file) return;
        await soundManager.loadMidi(file);
        const notes = await pickMidiTrack(soundManager.midiData.get(file), file.split('/').pop(), grid);
        if (notes) setPending({ label: file.split('/').pop(), notes });
      }));
      srcRow.appendChild(fileInput);
      box.appendChild(srcRow);

      // Replace vs. Add
      let mode = 'replace';
      const modeRow = el('div', 'editor-modal-row');
      modeRow.appendChild(el('span', 'editor-modal-label', 'On import:'));
      const repBtn = modalBtn('Replace', '', () => { mode = 'replace'; refreshMode(); });
      const addBtn = modalBtn('Add to existing', '', () => { mode = 'add'; refreshMode(); });
      const refreshMode = () => {
        repBtn.className = 'editor-modal-btn' + (mode === 'replace' ? ' primary' : '');
        addBtn.className = 'editor-modal-btn' + (mode === 'add' ? ' primary' : '');
      };
      refreshMode();
      modeRow.appendChild(repBtn); modeRow.appendChild(addBtn);
      box.appendChild(modeRow);

      const err = el('div', 'editor-modal-error'); box.appendChild(err);
      const doImport = () => {
        let notes = [], warnings = [];
        if (pending) notes = pending.notes;
        else {
          const txt = ta.value.trim();
          if (!txt) { err.textContent = 'Paste ABC or choose a file first.'; return; }
          ({ notes, warnings } = importAbc(txt, { grid, beatsPerBar }));
        }
        if (!notes.length) { err.textContent = 'No notes found in that input.'; return; }
        close({ notes, warnings, mode });
      };
      box.appendChild(btnRow(modalBtn('Cancel', '', () => close(null)), modalBtn('Import', 'primary', doImport)));
      setTimeout(() => ta.focus(), 0);
    },
  });

  if (!result) return;
  const fit = applyImportedNotes(stem, result.notes, result.mode);
  importNotice(fit, result.warnings);
}

// ─── Stem note ops: transpose · quantize · copy as ABC ─────────────────────────

function afterStemNoteEdit(stem) {
  saveManager.markDirty();
  if (playing) music.updateStemNotes(stem.name, stem.notes, song());
  commitUndo();
  buildUI();
}

function transposeStem(stem, semis) {
  if (!stem.notes?.length) return;
  for (const n of stem.notes) n.midi = Math.max(PITCH_MIN, Math.min(PITCH_MAX, n.midi + semis));
  afterStemNoteEdit(stem);
}

function quantizeStem(stem) {
  if (!stem.notes?.length) return;
  ensureTiming(song());
  const g = song().grid || 0.25;
  for (const n of stem.notes) { n.beat = Math.max(0, snapBeat(n.beat, g)); n.len = Math.max(g, snapBeat(n.len, g)); }
  sortNotes(stem.notes);
  afterStemNoteEdit(stem);
}

async function copyStemAbc(stem) {
  ensureTiming(song());
  if (!stem.notes?.length) { modalAlert('This stem has no notes yet.', { title: 'Copy as ABC' }); return; }
  const abc = stemToAbc(stem.notes, { beatsPerBar: song().beatsPerBar });
  let copied = false;
  try { await navigator.clipboard.writeText(abc); copied = true; } catch {}
  openModal({
    title: copied ? 'Copied as ABC' : 'ABC notation', cancelValue: null,
    render(box, close) {
      box.appendChild(el('div', 'editor-modal-msg', copied ? 'Copied to your clipboard — also shown here:' : 'Select all and copy:'));
      const ta = el('textarea', 'editor-modal-textarea'); ta.value = abc; ta.readOnly = true;
      box.appendChild(ta);
      box.appendChild(btnRow(modalBtn('Close', 'primary', () => close(null))));
      setTimeout(() => { ta.focus(); ta.select(); }, 0);
    },
  });
}

// ─── Drag-and-drop file import (onto the whole editor) ─────────────────────────
let dropHintEl = null;
const dragHasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

function showDropHint(on) {
  if (on) {
    if (!dropHintEl) { dropHintEl = el('div', 'me-drop-hint', 'Drop a .mid / .abc file to import'); document.body.appendChild(dropHintEl); }
    dropHintEl.style.display = 'flex';
  } else if (dropHintEl) dropHintEl.style.display = 'none';
}

function onDragOver(e) { if (!dragHasFiles(e) || isModalOpen()) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; showDropHint(true); }
function onDragLeave(e) { if (e.target === container) showDropHint(false); }
function onDrop(e) {
  if (!dragHasFiles(e)) return;
  e.preventDefault(); showDropHint(false);
  const f = e.dataTransfer.files?.[0];
  if (f) importFileDirect(f);
}

/** Import a dropped file straight into the selected stem (asking which stem if none is). */
async function importFileDirect(file) {
  if (!currentSongId) return;
  ensureTiming(song());
  let stem = (selectedStem && song().stems.includes(selectedStem)) ? selectedStem : null;
  if (!stem) {
    if (!song().stems.length) { modalAlert('Add a stem first, then drop a file to fill it.', { title: 'Import' }); return; }
    const name = await modalSelect('Import into which stem?', song().stems.map(s => ({ value: s.name, label: s.name })), { title: 'Import' });
    if (name == null) return;
    stem = song().stems.find(s => s.name === name);
  }
  const res = await fileToNotes(file, song().grid, song().beatsPerBar);
  if (!res) return;
  if (!res.notes.length) { modalAlert('No notes found in ' + file.name, { title: 'Import' }); return; }
  const fit = applyImportedNotes(stem, res.notes, 'replace');
  importNotice(fit, res.warnings);
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
  .me-ch{display:flex;flex-direction:column;align-items:center;gap:5px;width:88px;padding:6px;background:#161109;border:1px solid #3a2f1c;border-radius:5px;cursor:pointer}
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
  .me-pr-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px;flex-shrink:0}
  .me-play.playing{background:#7a6a30;border-color:#a8902a}
  .me-transport{display:flex;align-items:center;gap:12px;margin-top:10px;flex-shrink:0}
  .me-tgroup{display:flex;align-items:stretch;background:#161109;border:1px solid #5a4a30;border-radius:6px;overflow:hidden}
  .me-tcell{min-width:34px;height:30px;padding:0 10px;background:transparent;color:#c9b48a;border:none;border-left:1px solid #4a3c24;cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center}
  .me-tcell:first-child{border-left:none}
  .me-tcell:hover:not(:disabled){background:rgba(201,162,39,0.14);color:#e0c98a}
  .me-tcell:disabled{opacity:0.32;cursor:default}
  .me-tplay{min-width:46px;color:#eee6c4}
  .me-tplay:hover:not(:disabled){background:rgba(201,162,39,0.22)}
  .me-tplay.playing{background:#7a6a30;color:#fff4d8}
  .me-drop-hint{position:fixed;inset:0;z-index:900;display:none;align-items:center;justify-content:center;background:rgba(8,6,3,0.55);color:#e0c98a;font:600 16px system-ui,sans-serif;pointer-events:none;box-shadow:inset 0 0 0 3px #c9a227}
  `;
  document.head.appendChild(s);
}

function buildUI() {
  if (!container) return;
  container.innerHTML = '';
  playBtns = []; undoBtnEl = null; redoBtnEl = null;
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
    const dupBtn = el('button', 'me-mini', 'Clone');
    dupBtn.title = 'Duplicate this song';
    dupBtn.addEventListener('click', dupSongPrompt);
    const renBtn = el('button', 'me-mini', 'Rename');
    renBtn.title = 'Rename this song';
    renBtn.addEventListener('click', renameSongPrompt);
    const delSongBtn = el('button', 'me-mini danger', 'Delete');
    delSongBtn.title = 'Delete this song';
    delSongBtn.addEventListener('click', deleteSongPrompt);
    bar.appendChild(dupBtn); bar.appendChild(renBtn); bar.appendChild(delSongBtn);
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

  root.appendChild(el('div', 'me-hint', 'Click a stem to edit. Draw / drag to move·resize, right-click or Delete to remove, Alt-drag (or the velocity lane) for velocity, click the keys to preview. Ctrl+wheel zooms, drag the minimap to scroll, drag the ruler to move the playhead. Clone duplicates a stem; Import… pastes or uploads ABC or MIDI (or drop a .mid/.abc file anywhere); the R toggle on a strip repeats a short stem to fill the song. Space = play/pause, ← = to start, Ctrl+Z / Ctrl+Y = undo / redo.'));

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
    input.addEventListener('change', commitUndo); // one undo step per drag (on release)
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
      onChange(val); saveManager.markDirty(); commitUndo();
    });
    wrap.appendChild(input);
    return wrap;
  };

  // Tempo grid (drives the piano roll + loop length)
  row.appendChild(numField('BPM', song().bpm, 40, 300, val => { song().bpm = val; resyncIfPlaying(); pianoRoll?.setSong(song()); }));
  row.appendChild(numField('Bars', song().bars, 1, MAX_BARS, val => { song().bars = val; resyncIfPlaying(); pianoRoll?.setSong(song()); }));
  row.appendChild(numField('Beats/bar', song().beatsPerBar, 1, 12, val => { song().beatsPerBar = val; resyncIfPlaying(); pianoRoll?.setSong(song()); }));
  const gridWrap = el('div', 'me-knob');
  gridWrap.appendChild(el('label', null, 'Grid'));
  gridWrap.appendChild(selectEl(GRID_OPTS, String(song().grid), val => { song().grid = parseFloat(val); saveManager.markDirty(); pianoRoll?.setSong(song()); commitUndo(); }));
  row.appendChild(gridWrap);

  // Mix
  row.appendChild(slider('Mix level', 0, 1, 0.01, song().masterLevel ?? 0.35, x => x.toFixed(2), val => { song().masterLevel = val; }));
  row.appendChild(slider('Crossfade', 0, 5, 0.1, song().fadeSeconds ?? 1.5, x => x.toFixed(1) + 's', val => { song().fadeSeconds = val; }));
  return row;
}

function buildVibeEditRow() {
  const row = el('div', 'me-vibe-edit');

  const renameBtn = el('button', 'me-mini', 'Rename');
  renameBtn.addEventListener('click', async () => {
    const next = await modalPrompt('', { title: 'Rename vibe', value: activeTier, confirmLabel: 'Rename',
      validate: v => !v ? 'Enter a name' : (v !== activeTier && song().intensity[v]) ? 'That vibe already exists' : '' });
    if (!next || next === activeTier) return;
    if (renameVibe(song(), activeTier, next)) { activeTier = next; structuralEdit(); }
  });
  row.appendChild(renameBtn);

  const cloneBtn = el('button', 'me-mini', 'Clone');
  cloneBtn.title = 'Duplicate this vibe’s level map under a new name';
  cloneBtn.addEventListener('click', async () => {
    const name = await modalPrompt('', { title: 'Clone vibe', value: `${activeTier} copy`, confirmLabel: 'Clone',
      validate: v => !v ? 'Enter a name' : song().intensity[v] ? 'That vibe already exists' : '' });
    if (!name) return;
    if (cloneVibe(song(), activeTier, name)) { saveManager.markDirty(); commitUndo(); setScene(name); }
  });
  row.appendChild(cloneBtn);

  const delBtn = el('button', 'me-mini danger', 'Delete');
  delBtn.addEventListener('click', async () => {
    if (!await modalConfirm(`Delete vibe "${activeTier}"?`, { title: 'Delete vibe', confirmLabel: 'Delete', danger: true })) return;
    deleteVibe(song(), activeTier);
    activeTier = null;
    structuralEdit();
  });
  row.appendChild(delBtn);

  const doc = el('input', 'doc');
  doc.placeholder = 'Describe this vibe (when it plays, mood)…';
  doc.value = song().vibeDocs?.[activeTier] || '';
  doc.addEventListener('change', () => { setVibeDoc(song(), activeTier, doc.value); saveManager.markDirty(); commitUndo(); });
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
  fader.addEventListener('change', commitUndo); // one undo step per fader drag
  fader.addEventListener('click', (e) => e.stopPropagation());
  ch.appendChild(fader);
  ch.appendChild(val);

  // Mute / Solo / Repeat
  const btns = el('div', 'me-ch-btns');
  btns.appendChild(msBtn('M', muted.has(stem.name), '#b5483a', () => {
    if (muted.has(stem.name)) muted.delete(stem.name); else muted.add(stem.name);
    applyMix(); buildUI();
  }, 'Mute'));
  btns.appendChild(msBtn('S', soloStem === stem.name, '#c9a227', () => {
    soloStem = soloStem === stem.name ? null : stem.name;
    applyMix(); buildUI();
  }, 'Solo'));
  btns.appendChild(msBtn('R', !!stem.repeat, '#6a9f5a', () => {
    if (stem.repeat) delete stem.repeat; else stem.repeat = true;
    saveManager.markDirty();
    if (playing) music.updateStemNotes(stem.name, stem.notes, song());
    commitUndo(); buildUI();
  }, 'Repeat this stem to fill the whole song (off = play once, then wait)'));
  ch.appendChild(btns);

  function mgmtHit(e) { return btns.contains(e.target); }
  return ch;
}

function msBtn(label, active, color, onClick, title) {
  const b = el('button', 'me-ms', label);
  if (title) b.title = title;
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
    panel.appendChild(buildTransport());
    return panel;
  }

  const stem = selectedStem;
  stem.notes ??= [];
  const idx = song().stems.indexOf(stem);

  head.appendChild(el('span', 'me-pr-title', stem.name));

  const rename = el('button', 'me-mini', 'Rename');
  rename.title = 'Rename stem';
  rename.addEventListener('click', async () => {
    const next = await modalPrompt('', { title: 'Rename stem', value: stem.name, confirmLabel: 'Rename',
      validate: v => !v ? 'Enter a name' : (v !== stem.name && song().stems.some(s => s.name === v)) ? 'That name is taken' : '' });
    if (!next || next === stem.name) return;
    if (renameStem(song(), stem.name, next)) structuralEdit();
  });
  head.appendChild(rename);

  const clone = el('button', 'me-mini', 'Clone');
  clone.title = 'Clone this stem (notes + mix levels), then change its instrument';
  clone.addEventListener('click', () => { const c = cloneStem(song(), stem.name); if (c) { selectedStem = c; structuralEdit(); } });
  head.appendChild(clone);

  head.appendChild(el('span', 'me-pr-hint', 'instrument'));
  const soundOpts = [{ value: '', label: '(no sound)' }, ...Object.keys(SOUND_CONFIG).sort().map(id => ({ value: id, label: id }))];
  head.appendChild(selectEl(soundOpts, stem.sound || '', (v) => {
    stem.sound = v;
    saveManager.markDirty();
    // Swap just this stem's instrument in phase — no full-song restart. (Legacy .mid songs with
    // no tempo can't phase-align a single stem, so they fall back to a resync.)
    if (playing) { if (song().bpm && music.swapStemSound(stem.name, v, song(), targetGain(stem))) { /* swapped live */ } else resyncIfPlaying(); }
    commitUndo();
  }));

  const imp = el('button', 'me-mini', 'Import…');
  imp.title = 'Import notes — paste ABC, upload a .mid/.abc file, or pick from assets/MIDI';
  imp.addEventListener('click', () => importInto(stem));
  head.appendChild(imp);

  const clr = el('button', 'me-mini', 'Clear');
  clr.addEventListener('click', async () => {
    if (stem.notes.length && !await modalConfirm(`Clear all notes in "${stem.name}"?`, { title: 'Clear notes', confirmLabel: 'Clear', danger: true })) return;
    stem.notes = []; saveManager.markDirty();
    if (playing) music.updateStemNotes(stem.name, stem.notes, song());
    commitUndo();
    buildUI();
  });
  head.appendChild(clr);

  const up = el('button', 'me-mini', 'Up'); up.title = 'Move stem up'; up.disabled = idx <= 0;
  up.addEventListener('click', () => { if (reorderStem(song(), idx, -1)) structuralEdit({ resync: false }); });
  const down = el('button', 'me-mini', 'Down'); down.title = 'Move stem down'; down.disabled = idx >= song().stems.length - 1;
  down.addEventListener('click', () => { if (reorderStem(song(), idx, +1)) structuralEdit({ resync: false }); });
  const rm = el('button', 'me-mini danger', 'Remove');
  rm.addEventListener('click', async () => {
    if (!await modalConfirm(`Remove stem "${stem.name}"?`, { title: 'Remove stem', confirmLabel: 'Remove', danger: true })) return;
    removeStem(song(), stem.name); selectedStem = null; structuralEdit();
  });
  head.appendChild(up); head.appendChild(down); head.appendChild(rm);

  head.appendChild(el('span', 'me-pr-info', `${song().bars} bars · ${song().bpm} BPM · ${stem.notes.length} notes`));
  panel.appendChild(head);
  panel.appendChild(buildStemTools(stem));

  const body = el('div', 'me-pr-body');
  panel.appendChild(body);
  if (!pianoRoll) pianoRoll = createPianoRoll(body, { onEdit: onNotesEdited, onEditCommit: commitUndo, getPhase, previewNote, onSeek: setPlayhead });
  else body.appendChild(pianoRoll.el);
  pianoRoll.setPattern(stem.notes, song());
  pianoRoll.setRepeat(!!stem.repeat);
  pianoRoll.setPlaying(playing);

  panel.appendChild(buildTransport());
  return panel;
}

// The playhead the piano roll draws: the live audio position while playing, else the
// editor's own playhead (so you can move it while stopped). Tracks the audio into playheadPhase.
function getPhase() {
  if (!seeking && playing) { const p = music.getPhase(); if (p != null) playheadPhase = p; }
  return playheadPhase;
}

// Inline monochrome SVG icons (inherit the button's color via currentColor) — a game engine's
// transport deserves crisp vector glyphs, not emoji. Triangles in a 16-box; undo/redo are 24-box.
const SVGNS = 'http://www.w3.org/2000/svg';
const ICONS = {
  toStart: { vb: '0 0 16 16', d: ['M4 3.5H5.6V12.5H4Z', 'M12.5 3.5 6.2 8 12.5 12.5Z'] },
  back:    { vb: '0 0 16 16', d: ['M8.2 4 4 8 8.2 12Z', 'M12.6 4 8.4 8 12.6 12Z'] },
  forward: { vb: '0 0 16 16', d: ['M3.4 4 7.6 8 3.4 12Z', 'M7.6 4 11.8 8 7.6 12Z'] },
  play:    { vb: '0 0 16 16', d: ['M5 3.5 12.5 8 5 12.5Z'] },
  pause:   { vb: '0 0 16 16', d: ['M5 3.5H7.2V12.5H5Z', 'M8.8 3.5H11V12.5H8.8Z'] },
  stop:    { vb: '0 0 16 16', d: ['M4.5 4.5H11.5V11.5H4.5Z'] },
  undo:    { vb: '0 0 24 24', d: ['M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z'] },
  redo:    { vb: '0 0 24 24', d: ['M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z'] },
};
function svgIcon(name) {
  const ic = ICONS[name];
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', ic.vb); svg.setAttribute('width', '15'); svg.setAttribute('height', '15');
  svg.setAttribute('aria-hidden', 'true'); svg.style.display = 'block';
  for (const d of ic.d) { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); p.setAttribute('fill', 'currentColor'); svg.appendChild(p); }
  return svg;
}

/** A tool row under the piano-roll head: transpose · quantize · copy-as-ABC for the stem. */
function buildStemTools(stem) {
  const row = el('div', 'me-pr-tools');
  row.appendChild(el('span', 'me-pr-hint', 'transpose'));
  const tb = (label, semis, title) => { const b = el('button', 'me-mini', label); b.title = title; b.addEventListener('click', () => transposeStem(stem, semis)); return b; };
  row.appendChild(tb('−8va', -12, 'Down an octave'));
  row.appendChild(tb('−', -1, 'Down a semitone'));
  row.appendChild(tb('+', +1, 'Up a semitone'));
  row.appendChild(tb('+8va', +12, 'Up an octave'));
  const q = el('button', 'me-mini', 'Quantize'); q.title = 'Snap every note’s start + length to the grid';
  q.addEventListener('click', () => quantizeStem(stem)); row.appendChild(q);
  const cp = el('button', 'me-mini', 'Copy ABC'); cp.title = 'Copy this stem as ABC notation text';
  cp.addEventListener('click', () => copyStemAbc(stem)); row.appendChild(cp);
  return row;
}

function buildTransport() {
  const bar = el('div', 'me-transport');
  const cell = (iconName, title, onClick) => {
    const b = el('button', 'me-tcell'); b.title = title; b.appendChild(svgIcon(iconName));
    b.addEventListener('click', onClick); return b;
  };

  // Undo / redo cluster (separate small group on the left)
  const hist = el('div', 'me-tgroup');
  undoBtnEl = cell('undo', 'Undo (Ctrl+Z)', undo); undoBtnEl.disabled = undoStack.length <= 1;
  redoBtnEl = cell('redo', 'Redo (Ctrl+Y)', redo); redoBtnEl.disabled = redoStack.length === 0;
  hist.appendChild(undoBtnEl); hist.appendChild(redoBtnEl);
  bar.appendChild(hist);

  // Transport cluster
  const tg = el('div', 'me-tgroup');
  tg.appendChild(cell('toStart', 'Playhead to start (←)', () => setPlayhead(0)));
  tg.appendChild(cell('back', 'Back one bar', () => stepPlayhead(-1)));
  const playBtn = el('button', 'me-tcell me-tplay'); playBtn.title = 'Play / Pause (Space)';
  playBtn.addEventListener('click', toggleTransport); playBtns.push(playBtn); tg.appendChild(playBtn);
  tg.appendChild(cell('stop', 'Stop', stop));
  tg.appendChild(cell('forward', 'Forward one bar', () => stepPlayhead(1)));
  bar.appendChild(tg);

  updateTransportBtn();
  return bar;
}
