import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleManageCollection } from '../server/saveData.js';

function mockReq(bodyObj) {
  const req = new EventEmitter();
  queueMicrotask(() => { req.emit('data', JSON.stringify(bodyObj)); req.emit('end'); });
  return req;
}
function mockRes() {
  return {
    statusCode: null, body: null,
    writeHead(s) { this.statusCode = s; },
    end(b) { this.body = b; this._resolve?.(); },
    done() { return new Promise(r => { this._resolve = r; if (this.body !== null) r(); }); },
    json() { return JSON.parse(this.body); },
  };
}
function tmpDirs(manifest = { artCollections: [{ id: 'critters', label: 'Critters', file: 'critter-art.json', collectionKey: 'critters' }] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pat-coll-'));
  fs.writeFileSync(path.join(root, 'editor-manifest.json'), JSON.stringify(manifest, null, 2));
  return { dataDir: root, backupDir: path.join(root, '.backups') };
}
const run = async (body, dirs) => {
  const res = mockRes();
  handleManageCollection(mockReq(body), res, dirs);
  await res.done();
  return res;
};

test('create adds a manifest entry + a starter file with a derived name', async () => {
  const dirs = tmpDirs();
  const res = await run({ action: 'create', id: 'enemies' }, dirs);
  assert.equal(res.statusCode, 200);
  const manifest = JSON.parse(fs.readFileSync(path.join(dirs.dataDir, 'editor-manifest.json'), 'utf8'));
  const col = manifest.artCollections.find(c => c.id === 'enemies');
  assert.ok(col);
  assert.equal(col.file, 'enemies-art.json');           // server-derived, not client-supplied
  assert.equal(col.collectionKey, 'enemies');
  const file = JSON.parse(fs.readFileSync(path.join(dirs.dataDir, 'enemies-art.json'), 'utf8'));
  assert.deepEqual(file, { enemies: {} });
});

test('create rejects a duplicate id', async () => {
  const dirs = tmpDirs();
  const res = await run({ action: 'create', id: 'critters' }, dirs);
  assert.equal(res.statusCode, 409);
});

test('rejects an unsafe id (no path injection into the allowlist)', async () => {
  const dirs = tmpDirs();
  for (const id of ['../evil', 'A', '2x', 'has space', 'with/slash']) {
    const res = await run({ action: 'create', id }, dirs);
    assert.equal(res.statusCode, 400, `id ${JSON.stringify(id)} should be rejected`);
  }
});

test('rename updates the label only', async () => {
  const dirs = tmpDirs();
  const res = await run({ action: 'rename', id: 'critters', label: 'Creatures' }, dirs);
  assert.equal(res.statusCode, 200);
  const manifest = JSON.parse(fs.readFileSync(path.join(dirs.dataDir, 'editor-manifest.json'), 'utf8'));
  assert.equal(manifest.artCollections.find(c => c.id === 'critters').label, 'Creatures');
});

test('delete removes the manifest entry (file is kept)', async () => {
  const dirs = tmpDirs();
  await run({ action: 'create', id: 'enemies' }, dirs);
  const res = await run({ action: 'delete', id: 'enemies' }, dirs);
  assert.equal(res.statusCode, 200);
  const manifest = JSON.parse(fs.readFileSync(path.join(dirs.dataDir, 'editor-manifest.json'), 'utf8'));
  assert.ok(!manifest.artCollections.some(c => c.id === 'enemies'));
  assert.ok(fs.existsSync(path.join(dirs.dataDir, 'enemies-art.json')), 'art file kept on disk');
});
