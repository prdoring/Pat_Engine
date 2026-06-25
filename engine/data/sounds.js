// Generic sound-config loader. Schema is engine; content is the project's sfx.json.
// (Sub Game's version hardcoded a submarine SoundId enum — that's game content, so
// here SoundId/SoundCategory are derived from the data instead.)
import rawSfxData from '/data/sfx.json' with { type: 'json' };

// Deep clone for mutability (JSON imports are frozen).
const sfxData = JSON.parse(JSON.stringify(rawSfxData));

/** Full sound configuration registry — keyed by sound id. */
export const SOUND_CONFIG = sfxData.sounds || {};

/**
 * Sound categories used for grouped volume control. Derived from the data so a
 * project's categories "just work" (SoundManager builds a gain node per category).
 * Prefers an explicit `categories` array in sfx.json, else unique config categories.
 */
export const SoundCategory = (() => {
  const cats = Array.isArray(sfxData.categories) && sfxData.categories.length
    ? sfxData.categories
    : [...new Set(Object.values(SOUND_CONFIG).map(s => s.category).filter(Boolean))];
  const out = {};
  for (const c of cats) out[c] = c;
  return out;
})();

/**
 * Convenience id map so callers can write `SoundId.spawnChirp` instead of the
 * raw string. Built from the config keys (id → id).
 */
export const SoundId = Object.fromEntries(Object.keys(SOUND_CONFIG).map(k => [k, k]));
