// Pat_Engine server configuration — game-agnostic.
// All paths are derived from the project root (one level above /server).

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

export const PORT = process.env.PORT || 6970;

// Bind to loopback by default so a dev server isn't exposed on the LAN/WAN.
// Override with HOST=0.0.0.0 (or a specific interface) to serve other machines.
export const HOST = process.env.HOST || '127.0.0.1';

// Editor auth is OPT-IN. Set EDITOR_PASSWORD in the environment to require a
// password for editor routes + the save API. Unset (default) = open, which is
// the right choice for local single-machine development.
export const EDITOR_PASSWORD = process.env.EDITOR_PASSWORD || null;

export const DIRS = {
  root: ROOT,
  engine: path.join(ROOT, 'engine'),
  editors: path.join(ROOT, 'editors'),
  data: path.join(ROOT, 'data'),
  game: path.join(ROOT, 'game'),
  sfx: path.join(ROOT, 'assets', 'SFX'),
  midi: path.join(ROOT, 'assets', 'MIDI'),
  // Web root for top-level static files browsers/crawlers fetch by convention
  // (favicon.ico, site.webmanifest, apple-touch-icon.png, og-image.png, …).
  public: path.join(ROOT, 'public'),
  backups: path.join(ROOT, 'data', '.backups'),
};

// MIME map — note .ogg/.mp3/.flac are included (Sub Game's map only had .wav).
// .json MUST be served as application/json for browser `import ... with { type: 'json' }`.
export const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
};

// Core editable data files always allowed for save.
// NOTE: editor-manifest.json is intentionally NOT here — no editor writes it,
// and the manifest is the trust root for the rest of the allowlist.
const CORE_SAVE_FILES = [
  'vfx.json',
  'sfx.json',
  'fx-sequences.json',
  'music.json',
];

/**
 * Build the save allowlist: core creative files + every art-collection file
 * named in editor-manifest.json. Read fresh so adding a collection to the
 * manifest doesn't require touching the server.
 * @returns {Set<string>}
 */
export function getSaveAllowlist() {
  const files = new Set(CORE_SAVE_FILES);
  try {
    const manifestPath = path.join(DIRS.data, 'editor-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const col of manifest.artCollections || []) {
      if (col.file) files.add(col.file);
    }
  } catch {
    // No manifest yet (fresh scaffold) — core files still saveable.
  }
  return files;
}

export const MAX_BACKUPS = 10;
