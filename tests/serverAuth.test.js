import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ── Editor auth gate ──
// EDITOR_PASSWORD is read at module load (server/config.js), so it must be set
// before the handler is imported. Node runs each test file in its own process,
// so this can't leak into other suites.
process.env.EDITOR_PASSWORD = 'test-secret';
const { requestHandler } = await import('../server/main.js');

let server, port;

before(async () => {
  server = http.createServer(requestHandler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
});

function request(path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// Every write/listing API must 401 without credentials when auth is enabled.
// /api/manage-collection is here as a regression guard: it writes the manifest
// and creates/deletes collection files, so it must sit behind the same gate as
// /api/save-data (it was once missing from isEditorRoute).
for (const [method, path] of [
  ['POST', '/api/save-data'],
  ['POST', '/api/manage-collection'],
  ['GET', '/api/sfx-files'],
  ['GET', '/api/midi-files'],
]) {
  test(`${method} ${path} without auth returns 401`, async () => {
    const res = await request(path, { method, body: method === 'POST' ? '{}' : null });
    assert.equal(res.status, 401);
  });
}

test('a Bearer-authorized request passes the gate (fails validation, not auth)', async () => {
  const res = await request('/api/manage-collection', {
    method: 'POST',
    headers: { authorization: 'Bearer test-secret', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.notEqual(res.status, 401);
  assert.ok(res.status >= 400 && res.status < 500, `expected a validation 4xx, got ${res.status}`);
});

test('the game and static mounts stay open with auth enabled', async () => {
  const res = await request('/');
  assert.equal(res.status, 200);
});
