// Cheap link-time guard for the editor module graph. Editors defer ALL DOM access
// to mount()/handlers, so a bare `await import()` runs each module's top level (its
// imports + declarations) with near-zero stubbing. ES named-import validation is a
// LINK-time check, so this catches dropped exports, broken barrels, moved-file 404s,
// wrong relative paths after a rename, and an editor.html↔location mismatch — the
// exact risks of the file-structure refactor — with no DOM and no interaction.
//
// This is the ONLY automated verification of editors/shared/* (no other test imports
// it). Extend ENTRY_PATHS / MODULE_PATHS as clusters relocate.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal global stubs. Not needed today (editors touch the DOM only inside mount()),
// but cheap insurance if a module ever gains a top-level DOM/timer/fetch reference.
globalThis.document ??= {
  addEventListener() {}, removeEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  createElement() {
    return {
      style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      appendChild(c) { return c; }, append() {}, remove() {}, setAttribute() {},
      addEventListener() {}, removeEventListener() {},
      getContext() { return null; },
      querySelector() { return null; }, querySelectorAll() { return []; },
    };
  },
  head: { appendChild() {} }, body: { appendChild() {}, style: {} },
};
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};
globalThis.fetch ??= async () => ({ ok: true, json: async () => ({}) });

// Editor entry modules loaded by editor.html via the ENTRY_OF id→path map. Each
// editor cluster lives in its own co-named folder (`/editors/<id>/<id>Editor.js`).
const ENTRY_PATHS = [
  '/editors/art/artEditor.js',
  '/editors/vfx/vfxEditor.js',
  '/editors/sequences/sequencesEditor.js',
  '/editors/soundboard/soundboardEditor.js',
  '/editors/music/musicEditor.js',
];

// Shared toolkit barrel + leaves. Every editor's shared imports resolve through
// these, so a dropped widget/modal export or broken barrel fails here.
const MODULE_PATHS = [
  '/editors/shared/index.js',
  '/editors/shared/widgets.js',
  '/editors/shared/modals.js',
  '/editors/shared/canvas.js',
  '/editors/shared/saveManager.js',
  '/editors/shared/manifest.js',
  // art cluster internals
  '/editors/art/ctx.js',
  '/editors/art/sidebar.js',
  '/editors/art/states.js',
  '/editors/art/timeline.js',
  '/editors/art/tree/tree.js',
  '/editors/art/tree/treeDialogs.js',
  '/editors/art/tree/mirror.js',
  '/editors/art/tree/treeDragDrop.js',
  '/editors/art/props/props.js',
  '/editors/art/props/shapeEditors.js',
  '/editors/art/props/keyframePanel.js',
  '/editors/art/props/setupEditor.js',
  '/editors/art/preview/preview.js',
  '/editors/art/preview/previewGeometry.js',
  '/editors/art/preview/previewInteraction.js',
  '/editors/art/model/keyframes.js',
  '/editors/art/model/coordModel.js',
  '/editors/art/model/assetOps.js',
  '/editors/art/model/history.js',
  // vfx cluster internals
  '/editors/vfx/constants.js',
  '/editors/vfx/simulator.js',
  '/editors/vfx/fieldWidgets.js',
  // sequences cluster internals
  '/editors/sequences/constants.js',
  // soundboard cluster internals
  '/editors/soundboard/constants.js',
  '/editors/soundboard/waveform.js',
  // music cluster internals
  '/editors/music/pianoRoll.js',
  '/editors/music/model/musicModel.js',
  '/editors/music/model/midiModel.js',
  '/editors/music/model/abcModel.js',
];

for (const p of ENTRY_PATHS) {
  test(`editor entry loads + exposes mount/unmount: ${p}`, async () => {
    const mod = await import(p); // link-time: validates every transitive named import
    assert.equal(typeof mod.mount, 'function', 'mount() export missing');
    assert.equal(typeof mod.unmount, 'function', 'unmount() export missing');
  });
}

for (const p of MODULE_PATHS) {
  test(`module links: ${p}`, async () => {
    assert.ok(await import(p), 'module failed to load');
  });
}

test('shared barrel re-exports the core widgets + modals', async () => {
  const s = await import('/editors/shared/index.js');
  for (const name of ['SaveManager', 'NumberSlider', 'Select', 'Button', 'PropertyGroup',
    'createResizer', 'openModal', 'modalConfirm', 'loadManifest']) {
    assert.equal(typeof s[name], 'function', `shared barrel missing ${name}`);
  }
});
