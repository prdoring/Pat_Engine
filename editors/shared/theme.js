// Editor-chrome theming. Themes are authored as CSS custom-property (`--ed-*`)
// blocks in editor.html: `:root` holds the default "genesis" values, and each
// `[data-theme="<id>"]` block overrides them. This module only toggles the
// attribute on <html>, persists the choice, and exposes a tiny helper so
// canvas-drawn chrome (which CSS var() cannot reach) can read the same tokens.
//
// IMPORTANT: This module is import-scanned by tests/editorSmoke.test.js under a
// DOM stub with NO localStorage / getComputedStyle. So it must do ZERO top-level
// DOM or storage access — everything lives inside functions, storage in try/catch.

const STORAGE_KEY = 'patEngine.editorTheme';

/** Available editor themes. `genesis` is the default (no data-theme attribute). */
export const THEMES = [
  { id: 'genesis', label: 'Genesis (Dark)' },
  { id: 'slate', label: 'Slate (Dark)' },
  { id: 'contrast', label: 'High Contrast' },
  { id: 'light', label: 'Daylight' },
  { id: 'paper', label: 'Paper (Light)' },
];

const _listeners = new Set();
const _cache = new Map();

function _stored() {
  try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
}

/** The active theme id (attribute wins; else persisted; else 'genesis'). */
export function current() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr) return attr;
  return _stored() || 'genesis';
}

/** Switch themes: repoint the attribute, persist, drop the color cache, notify. */
export function applyTheme(id) {
  const root = document.documentElement;
  if (id === 'genesis') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', id);
  try { localStorage.setItem(STORAGE_KEY, id); } catch (e) { /* private mode / no storage */ }
  _cache.clear();
  for (const fn of _listeners) { try { fn(id); } catch (e) { console.error('theme listener failed', e); } }
}

/** Subscribe to theme switches (e.g. to re-render a canvas). Returns an unsubscribe fn. */
export function onThemeChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Resolve a CSS custom property to its computed value, for canvas 2D drawing.
 * Cached; the cache is cleared on every applyTheme(), so stale values never leak.
 */
export function themeColor(name) {
  if (_cache.has(name)) return _cache.get(name);
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  _cache.set(name, v);
  return v;
}

/** Build an rgba() string from an `--ed-*-rgb` triplet token and an alpha. */
export function themeColorRgba(name, alpha) {
  return `rgba(${themeColor(name)}, ${alpha})`;
}

/**
 * Create the theme <select> and append it to the header (far right — the
 * .editor-title's margin-right:auto pushes it there). Native <select> keeps this
 * dependency-free (no widgets import → no barrel cycle). Idempotent.
 */
export function initThemePicker(headerEl) {
  if (!headerEl || headerEl.querySelector('.editor-theme-picker')) return null;
  const sel = document.createElement('select');
  sel.className = 'editor-theme-picker';
  sel.title = 'Editor theme';
  for (const t of THEMES) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.label;
    sel.appendChild(opt);
  }
  sel.value = current();
  sel.addEventListener('change', () => applyTheme(sel.value));
  headerEl.appendChild(sel);
  return sel;
}
