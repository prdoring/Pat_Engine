// Guards for the editor theming layer:
//  1) theme.js imports cleanly and the shared barrel re-exports its API (link-time,
//     mirrors editorSmoke.test.js — theme.js must not touch the DOM/localStorage at
//     module top level).
//  2) every `--ed-*` token defined on :root has a matching override in each
//     [data-theme="…"] block (so no token is left un-themed / falls back silently).
//  3) game/asset color VALUES were NOT tokenized (chrome-vs-data separation held).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Same minimal stubs as editorSmoke.test.js — the shared modules defer DOM access to
// their functions, so importing them only needs these to exist as objects.
globalThis.document ??= {
  addEventListener() {}, removeEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  createElement() { return { style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, appendChild(c) { return c; }, append() {}, remove() {}, setAttribute() {}, addEventListener() {}, getContext() { return null; } }; },
  head: { appendChild() {} }, body: { appendChild() {}, style: {} },
  documentElement: { getAttribute() { return null; }, setAttribute() {}, removeAttribute() {}, dataset: {} },
};
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };

test('theme.js links + the shared barrel re-exports the theme API', async () => {
  await import('/editors/shared/theme.js');           // link-time import-safety
  const s = await import('/editors/shared/index.js');
  for (const name of ['THEMES', 'current', 'applyTheme', 'onThemeChange', 'initThemePicker', 'themeColor', 'themeColorRgba']) {
    assert.ok(s[name] !== undefined, `barrel missing theme export ${name}`);
  }
  for (const name of ['current', 'applyTheme', 'onThemeChange', 'initThemePicker', 'themeColor', 'themeColorRgba']) {
    assert.equal(typeof s[name], 'function', `${name} should be a function`);
  }
  assert.ok(Array.isArray(s.THEMES) && s.THEMES.some(t => t.id === 'genesis'), 'THEMES must list genesis');
});

// --- token parity: every theme block defines the same --ed-* key set as :root ---
const css = readFileSync(new URL('../editors/editor.html', import.meta.url), 'utf8');

function tokenKeys(selector) {
  // CSS custom-property blocks contain no nested braces, so [^}]* is a safe body match.
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = css.match(re);
  assert.ok(m, `missing token block for "${selector}"`);
  return new Set((m[1].match(/--ed-[a-z0-9-]+/gi) || []).map(s => s.toLowerCase()));
}

test(':root defines a substantial --ed-* token set', () => {
  const root = tokenKeys(':root');
  assert.ok(root.size >= 40, `expected many tokens, got ${root.size}`);
});

function themeIds() {
  // Match real selectors only (id + opening brace) — not the `[data-theme="…"]` mention
  // inside the token-block comment.
  return [...new Set([...css.matchAll(/\[data-theme="([a-z0-9-]+)"\]\s*\{/g)].map(m => m[1]))];
}

test('every [data-theme] block overrides exactly the :root --ed-* token set', () => {
  const root = tokenKeys(':root');
  const ids = themeIds();
  assert.ok(ids.length >= 1, 'expected at least one [data-theme] block');
  for (const id of ids) {
    const t = tokenKeys(`[data-theme="${id}"]`);
    const missing = [...root].filter(k => !t.has(k));
    const extra = [...t].filter(k => !root.has(k));
    assert.deepEqual(missing, [], `theme "${id}" is missing tokens: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `theme "${id}" defines tokens absent from :root: ${extra.join(', ')}`);
  }
});

test('every THEMES entry (except genesis) has a matching [data-theme] block, and vice versa', async () => {
  const { THEMES } = await import('/editors/shared/index.js');
  const blockIds = new Set(themeIds());
  const listedIds = new Set(THEMES.map(t => t.id));
  for (const t of THEMES) {
    if (t.id === 'genesis') continue; // genesis = :root default, no data-theme block
    assert.ok(blockIds.has(t.id), `THEMES lists "${t.id}" but no [data-theme="${t.id}"] block exists`);
  }
  for (const id of blockIds) {
    assert.ok(listedIds.has(id), `[data-theme="${id}"] block exists but "${id}" is not in THEMES`);
  }
});

// --- regression guard: game/asset color VALUES must stay hardcoded (not tokenized) ---
test('game/asset color data was not tokenized', () => {
  const has = (path, needle) => assert.ok(
    readFileSync(new URL(path, import.meta.url), 'utf8').includes(needle),
    `${path} should still contain literal ${needle} (asset data must not be tokenized)`);
  has('../editors/vfx/constants.js', '#ccffff');       // NEW_EFFECT_DEFAULTS particle color
  has('../editors/art/props/setupEditor.js', '#ffffff'); // shape fill/stroke defaults
  has('../editors/art/model/keyframes.js', '#ffffff');   // keyframe color default
});
