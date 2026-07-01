import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure asset-collection helpers used by the art editor's sidebar CRUD. These run
// headless (no DOM) like the rest of the suite; the loader remaps /editors/.

const {
  getAssetsMap, isValidAssetId, validateAssetId, newAssetTemplate,
  addAsset, duplicateAsset, deleteAsset, renameAsset,
} = await import('/editors/art/model/assetOps.js');

// A nested-collection fixture (the engine's standard art-file shape), fresh per
// test since helpers mutate in place.
const make = () => ({
  critters: {
    blob: { name: 'Blob', states: ['idle'], shapes: [{ type: 'circle', radius: 0.8 }] },
    sprout: { name: 'Sprout', shapes: [{ type: 'circle', radius: 0.5 }] },
  },
});

test('getAssetsMap resolves the nested collection key', () => {
  const f = make();
  assert.equal(getAssetsMap(f, 'critters'), f.critters);
});

test('getAssetsMap falls back to the file itself with no key', () => {
  const flat = { blob: {}, sprout: {} };
  assert.equal(getAssetsMap(flat, undefined), flat);
});

test('isValidAssetId enforces identifier rules', () => {
  assert.ok(isValidAssetId('sprout'));
  assert.ok(isValidAssetId('big_Bug2'));
  assert.ok(!isValidAssetId('2bug'));
  assert.ok(!isValidAssetId('has space'));
  assert.ok(!isValidAssetId(''));
});

test('validateAssetId blocks blanks, bad chars, and duplicates', () => {
  const f = make();
  assert.match(validateAssetId(f, 'critters', ''), /Enter an id/);
  assert.match(validateAssetId(f, 'critters', '2x'), /start with a letter/);
  assert.match(validateAssetId(f, 'critters', 'blob'), /already exists/);
  assert.equal(validateAssetId(f, 'critters', 'newGuy'), null);
});

test('validateAssetId ignores the id being renamed', () => {
  const f = make();
  assert.equal(validateAssetId(f, 'critters', 'blob', { ignore: 'blob' }), null);
  assert.match(validateAssetId(f, 'critters', 'sprout', { ignore: 'blob' }), /already exists/);
});

test('newAssetTemplate is renderable (name + one shape)', () => {
  const t = newAssetTemplate('frog');
  assert.equal(t.name, 'frog');
  assert.equal(t.shapes.length, 1);
  assert.equal(t.shapes[0].type, 'circle');
});

test('addAsset inserts under the id', () => {
  const f = make();
  addAsset(f, 'critters', 'frog');
  assert.ok(f.critters.frog);
  assert.equal(f.critters.frog.name, 'frog');
});

test('duplicateAsset deep-clones and renames the copy', () => {
  const f = make();
  duplicateAsset(f, 'critters', 'blob', 'blob2');
  assert.equal(f.critters.blob2.name, 'blob2');
  assert.notEqual(f.critters.blob2, f.critters.blob);
  assert.notEqual(f.critters.blob2.shapes[0], f.critters.blob.shapes[0]); // deep clone
  f.critters.blob2.shapes[0].radius = 9;
  assert.equal(f.critters.blob.shapes[0].radius, 0.8); // original untouched
});

test('deleteAsset removes the id', () => {
  const f = make();
  deleteAsset(f, 'critters', 'blob');
  assert.ok(!('blob' in f.critters));
  assert.ok('sprout' in f.critters);
});

test('renameAsset preserves key insertion order', () => {
  const f = make();
  renameAsset(f, 'critters', 'blob', 'goo');
  assert.deepEqual(Object.keys(f.critters), ['goo', 'sprout']);
  assert.ok(f.critters.goo);
});

test('renameAsset keeps the same asset object (identity)', () => {
  const f = make();
  const before = f.critters.blob;
  renameAsset(f, 'critters', 'blob', 'goo');
  assert.equal(f.critters.goo, before);
});

test('renameAsset only tracks name when it mirrored the id', () => {
  const f = make();
  // blob.name is the custom 'Blob' — left untouched.
  renameAsset(f, 'critters', 'blob', 'goo');
  assert.equal(f.critters.goo.name, 'Blob');
  // an asset whose name mirrors its id follows the rename.
  f.critters.mirror = { name: 'mirror', shapes: [] };
  renameAsset(f, 'critters', 'mirror', 'reflection');
  assert.equal(f.critters.reflection.name, 'reflection');
});
