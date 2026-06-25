import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Validates that the editor manifest stays consistent with the data files it
// points at — the kind of drift (renamed file/key, dangling preview entity)
// that otherwise only shows up as a broken editor tab.

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const manifest = readJson('editor-manifest.json');

test('every art collection file exists and its collectionKey resolves', () => {
  for (const col of manifest.artCollections) {
    const filePath = path.join(DATA, col.file);
    assert.ok(fs.existsSync(filePath), `missing collection file: ${col.file}`);
    const data = readJson(col.file);
    const assets = (col.collectionKey && data[col.collectionKey]) || data;
    assert.equal(typeof assets, 'object', `${col.id}: collectionKey '${col.collectionKey}' did not resolve to a map`);
    assert.ok(Object.keys(assets).length > 0, `${col.id}: no assets`);
  }
});

test('every preview entity references a real collection + asset', () => {
  const byId = Object.fromEntries(manifest.artCollections.map(c => [c.id, c]));
  for (const e of manifest.previewEntities) {
    const col = byId[e.artCollection];
    assert.ok(col, `previewEntity ${e.id}: unknown artCollection ${e.artCollection}`);
    const data = readJson(col.file);
    const assets = (col.collectionKey && data[col.collectionKey]) || data;
    assert.ok(assets[e.artId], `previewEntity ${e.id}: asset ${e.artId} not in ${e.artCollection}`);
    assert.equal(typeof e.radius, 'number', `previewEntity ${e.id}: radius must be a number`);
  }
});

test('vfx categories are well-formed', () => {
  for (const c of manifest.vfxCategories) {
    assert.ok(c.id, 'category needs an id');
    assert.ok(Array.isArray(c.match), `category ${c.id} needs a match array`);
  }
});
