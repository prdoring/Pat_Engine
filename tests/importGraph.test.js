import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── Whole-tree import-graph guard (the #1 restructure failure mode) ─────────────
//
// A file move breaks import paths. This walks EVERY .js under engine/, editors/,
// game/ and server/ and:
//   (1) STATIC — resolves every import/re-export/dynamic-import specifier to a real
//       file on disk. Covers all four layers including game/server bootstraps, with
//       zero execution (so it can't start a server or touch the DOM).
//   (2) DYNAMIC — actually imports every engine/ and editors/ module, so a dropped
//       named export or broken barrel fails at ES link time too.
//
// Auto-discovery means a newly added or relocated file is covered with no edit here.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAYERS = ['engine', 'editors', 'game', 'server'];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const ALL_JS = LAYERS.flatMap(l => walk(path.join(ROOT, l)));

// Browser-absolute mount points the app + loader understand.
const MOUNTS = ['/engine/', '/editors/', '/data/', '/game/'];

// Extract every module specifier: `from '…'`, `export … from '…'`, `import('…')`.
function specifiersOf(src) {
  const specs = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) specs.push(m[1]);
  return specs;
}

function resolveSpec(spec, fromFile) {
  if (MOUNTS.some(mt => spec.startsWith(mt))) return path.join(ROOT, spec.slice(1));
  if (spec.startsWith('./') || spec.startsWith('../')) return path.resolve(path.dirname(fromFile), spec);
  return null; // bare specifier (node builtin / npm dep) — not a file path we own
}

test(`static: every import specifier resolves to a real file (${ALL_JS.length} files)`, () => {
  const missing = [];
  for (const file of ALL_JS) {
    const src = readFileSync(file, 'utf8');
    for (const spec of specifiersOf(src)) {
      const target = resolveSpec(spec, file);
      if (target && !existsSync(target)) {
        missing.push(`${path.relative(ROOT, file)}  →  ${spec}`);
      }
    }
  }
  assert.equal(missing.length, 0, `Unresolved imports (broken paths):\n  ${missing.join('\n  ')}`);
});

// ── Dynamic link validation ────────────────────────────────────────────────────
// Minimal DOM/host stubs so editor modules (which defer real DOM to mount()) link.
globalThis.document ??= {
  addEventListener() {}, removeEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  createElement() {
    return {
      style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild(c) { return c; }, append() {}, remove() {}, setAttribute() {},
      addEventListener() {}, removeEventListener() {}, getContext() { return null; },
      querySelector() { return null; }, querySelectorAll() { return []; },
    };
  },
  head: { appendChild() {} }, body: { appendChild() {}, style: {} },
};
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};
globalThis.performance ??= { now: () => 0 };

// engine/ + editors/ are side-effect-free at import time (construction/DOM is lazy),
// so importing each validates its links. game/ + server/ have bootstrap side effects
// (canvas grab, server.listen) and are covered by the static pass only.
const toMount = (file) => '/' + path.relative(ROOT, file).split(path.sep).join('/');
const DYNAMIC = ALL_JS.filter(f => f.includes(`${path.sep}engine${path.sep}`) || f.includes(`${path.sep}editors${path.sep}`));

for (const file of DYNAMIC) {
  const mount = toMount(file);
  test(`links: ${mount}`, async () => {
    assert.ok(await import(mount), 'module failed to load');
  });
}
