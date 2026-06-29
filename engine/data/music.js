// Generic song/stem loader. Schema is engine; content is the project's music.json.
// Mirrors engine/data/sounds.js — the engine treats the song data as opaque.
import rawMusicData from '/data/music.json' with { type: 'json' };

// Deep clone for mutability (JSON imports are frozen).
const musicData = JSON.parse(JSON.stringify(rawMusicData));

/**
 * Song registry — keyed by song id. Each song is
 * `{ stems:[{name,sound,gain}], intensity:{ <tier>: { <stemName>: 0..1 } }, fadeSeconds }`.
 * A stem's `sound` is a `loop:true` + `synth.midi` sound in sfx.json (its instrument timbre +
 * which track of the shared .mid it plays).
 */
export const MUSIC_SONGS = musicData.songs || {};
