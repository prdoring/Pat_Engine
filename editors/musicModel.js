// editors/musicModel.js
// Pure, DOM-free helpers for editing an adaptive-music *song* object — the shape in
// data/music.json:
//   { stems:[{name,sound,gain}], intensity:{ <vibe>:{ <stemName>:0..1 } },
//     vibeDocs?:{ <vibe>:string }, masterLevel?, fadeSeconds? }
// A stem's `name` is the key used across every intensity tier, so renaming or removing a
// stem must rewrite those maps in lockstep. Keeping that logic here (not in the DOM
// editor) makes it unit-testable in Node and keeps musicEditor.js thin.

/** Ensure the containers the helpers assume exist. Mutates + returns `song`. */
export function normalizeSong(song) {
  song.stems = song.stems || [];
  song.intensity = song.intensity || {};
  return song;
}

/** A fresh, empty song with default tempo grid + engine headroom/crossfade. */
export function newSong() {
  return {
    bpm: 120, beatsPerBar: 4, bars: 4, grid: 0.25,
    stems: [], intensity: {}, vibeDocs: {}, masterLevel: 0.35, fadeSeconds: 1.5,
  };
}

/** A stem name not already used in the song, derived from `base` ("lead", "lead2"…). */
export function uniqueStemName(song, base = 'stem') {
  const taken = new Set((song.stems || []).map(s => s.name));
  base = base || 'stem';
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/** Append a stem. Returns the created stem (name auto-uniqued if omitted/taken). */
export function addStem(song, { name, sound = '', gain = 0.5 } = {}) {
  normalizeSong(song);
  const stem = { name: uniqueStemName(song, name || 'stem'), sound, gain };
  song.stems.push(stem);
  return stem;
}

/**
 * Clone a stem (sound, gain, notes) under a new unique name, replicating its level in every
 * intensity tier so the copy mixes identically. Returns the new stem, or null if `name` is gone.
 */
export function cloneStem(song, name) {
  normalizeSong(song);
  const src = song.stems.find(s => s.name === name);
  if (!src) return null;
  const copy = JSON.parse(JSON.stringify(src));
  copy.name = uniqueStemName(song, `${src.name} copy`);
  song.stems.push(copy);
  for (const tier of Object.values(song.intensity)) {
    if (Object.prototype.hasOwnProperty.call(tier, name)) tier[copy.name] = tier[name];
  }
  return copy;
}

/** Remove a stem by name, dropping it from every intensity tier. Returns true if removed. */
export function removeStem(song, name) {
  normalizeSong(song);
  const i = song.stems.findIndex(s => s.name === name);
  if (i < 0) return false;
  song.stems.splice(i, 1);
  for (const tier of Object.values(song.intensity)) delete tier[name];
  return true;
}

/**
 * Rename a stem, rewriting its key in every intensity tier. No-op (returns false) if the
 * old name is missing, the new name is blank/unchanged, or the new name is already taken.
 */
export function renameStem(song, oldName, newName) {
  normalizeSong(song);
  newName = (newName || '').trim();
  if (!newName || newName === oldName) return false;
  if (song.stems.some(s => s.name === newName)) return false;
  const stem = song.stems.find(s => s.name === oldName);
  if (!stem) return false;
  stem.name = newName;
  for (const tier of Object.values(song.intensity)) {
    if (Object.prototype.hasOwnProperty.call(tier, oldName)) {
      tier[newName] = tier[oldName];
      delete tier[oldName];
    }
  }
  return true;
}

/** Move the stem at `index` by `dir` (-1 up / +1 down). Returns true if it moved. */
export function reorderStem(song, index, dir) {
  normalizeSong(song);
  const j = index + dir;
  if (index < 0 || index >= song.stems.length || j < 0 || j >= song.stems.length) return false;
  const [s] = song.stems.splice(index, 1);
  song.stems.splice(j, 0, s);
  return true;
}

/** Rename a vibe/intensity tier, carrying its doc string. Returns true if renamed. */
export function renameVibe(song, oldName, newName) {
  normalizeSong(song);
  newName = (newName || '').trim();
  if (!newName || newName === oldName) return false;
  if (!song.intensity[oldName] || song.intensity[newName]) return false;
  song.intensity[newName] = song.intensity[oldName];
  delete song.intensity[oldName];
  if (song.vibeDocs && song.vibeDocs[oldName] != null) {
    song.vibeDocs[newName] = song.vibeDocs[oldName];
    delete song.vibeDocs[oldName];
  }
  return true;
}

/** Duplicate a vibe/intensity tier (its level map + doc) under `newName`. Returns true if cloned. */
export function cloneVibe(song, name, newName) {
  normalizeSong(song);
  newName = (newName || '').trim();
  if (!song.intensity[name] || !newName || song.intensity[newName]) return false;
  song.intensity[newName] = JSON.parse(JSON.stringify(song.intensity[name]));
  if (song.vibeDocs && song.vibeDocs[name] != null) {
    song.vibeDocs = song.vibeDocs || {};
    song.vibeDocs[newName] = song.vibeDocs[name];
  }
  return true;
}

/** Delete a vibe/intensity tier (and its doc). Returns true if deleted. */
export function deleteVibe(song, name) {
  normalizeSong(song);
  if (!song.intensity[name]) return false;
  delete song.intensity[name];
  if (song.vibeDocs) delete song.vibeDocs[name];
  return true;
}

/** Set (or clear, when blank) a vibe's human-readable doc string. */
export function setVibeDoc(song, name, text) {
  text = (text || '').trim();
  if (!text) { if (song.vibeDocs) delete song.vibeDocs[name]; return; }
  song.vibeDocs = song.vibeDocs || {};
  song.vibeDocs[name] = text;
}

// ─── Song-level helpers (operate on the songs map: { <songId>: song }) ──────────

/** A song id not already used, derived from `base` ("song", "song2"…). */
export function uniqueSongId(songs, base = 'song') {
  base = base || 'song';
  if (!songs[base]) return base;
  let n = 2;
  while (songs[`${base}${n}`]) n++;
  return `${base}${n}`;
}

/** Rename a song id in place, preserving key order. Returns true if renamed. */
export function renameSong(songs, oldId, newId) {
  newId = (newId || '').trim();
  if (!newId || newId === oldId || !songs[oldId] || songs[newId]) return false;
  const rebuilt = {};
  for (const k of Object.keys(songs)) rebuilt[k === oldId ? newId : k] = songs[k];
  for (const k of Object.keys(songs)) delete songs[k];
  Object.assign(songs, rebuilt);
  return true;
}

/** Deep-clone a song under `newId` (appended last). Returns true if duplicated. */
export function duplicateSong(songs, id, newId) {
  newId = (newId || '').trim();
  if (!newId || !songs[id] || songs[newId]) return false;
  songs[newId] = JSON.parse(JSON.stringify(songs[id]));
  return true;
}

/** Delete a song by id. Returns true if removed. */
export function deleteSong(songs, id) {
  if (!songs[id]) return false;
  delete songs[id];
  return true;
}
