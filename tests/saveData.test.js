import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleSaveData } from '../server/saveData.js';

// Minimal mock request: an EventEmitter we can push a body through.
function mockReq(bodyObj) {
  const req = new EventEmitter();
  queueMicrotask(() => {
    req.emit('data', JSON.stringify(bodyObj));
    req.emit('end');
  });
  return req;
}

// Minimal mock response capturing status + body.
function mockRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = body; this._resolve?.(); },
    done() { return new Promise(r => { this._resolve = r; if (this.body !== null) r(); }); },
  };
}

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pat-save-'));
  return { dataDir: root, backupDir: path.join(root, '.backups') };
}

test('writes an allowed file', async () => {
  const { dataDir, backupDir } = tmpDirs();
  const res = mockRes();
  handleSaveData(mockReq({ file: 'vfx.json', data: { effects: { a: 1 } } }), res, {
    dataDir, backupDir, allowlist: new Set(['vfx.json']),
  });
  await res.done();
  assert.equal(res.statusCode, 200);
  const written = JSON.parse(fs.readFileSync(path.join(dataDir, 'vfx.json'), 'utf8'));
  assert.deepEqual(written, { effects: { a: 1 } });
});

test('rejects a file not in the allowlist', async () => {
  const { dataDir, backupDir } = tmpDirs();
  const res = mockRes();
  handleSaveData(mockReq({ file: 'secrets.json', data: {} }), res, {
    dataDir, backupDir, allowlist: new Set(['vfx.json']),
  });
  await res.done();
  assert.equal(res.statusCode, 400);
});

test('rejects path traversal in filename', async () => {
  const { dataDir, backupDir } = tmpDirs();
  const res = mockRes();
  // Even allowlisted, the traversal guard must catch separators.
  handleSaveData(mockReq({ file: '../evil.json', data: {} }), res, {
    dataDir, backupDir, allowlist: new Set(['../evil.json']),
  });
  await res.done();
  assert.equal(res.statusCode, 400);
});

test('backs up an existing file and keeps at most maxBackups', async () => {
  const { dataDir, backupDir } = tmpDirs();
  const allowlist = new Set(['vfx.json']);
  // Seed an initial file.
  fs.writeFileSync(path.join(dataDir, 'vfx.json'), JSON.stringify({ v: 0 }));
  for (let i = 1; i <= 13; i++) {
    const res = mockRes();
    handleSaveData(mockReq({ file: 'vfx.json', data: { v: i } }), res, {
      dataDir, backupDir, allowlist, maxBackups: 10,
    });
    await res.done();
    // Distinct timestamps require a tick; the ISO ms granularity is enough with awaits.
    await new Promise(r => setTimeout(r, 5));
  }
  const backups = fs.readdirSync(backupDir).filter(f => f.startsWith('vfx.json.'));
  assert.ok(backups.length <= 10, `expected <=10 backups, got ${backups.length}`);
  const current = JSON.parse(fs.readFileSync(path.join(dataDir, 'vfx.json'), 'utf8'));
  assert.equal(current.v, 13);
});
