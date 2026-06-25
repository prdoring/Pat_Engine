import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { requestHandler } from '../server/main.js';
import { readBody } from '../server/saveData.js';
import { EventEmitter } from 'node:events';

// ── Integration: drive the real request handler on an ephemeral port ──
// listen(0) picks a free port; the handler is the exact one main.js binds.
let server, port;

before(async () => {
  server = http.createServer(requestHandler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
});

// Low-level client so the raw path (`/%`, `..`, `%00`) reaches the server
// un-normalized — fetch/URL would rewrite or reject these before sending.
function request(rawPath, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /% returns 400 (malformed escape, socket survives)', async () => {
  const res = await request('/%');
  assert.equal(res.status, 400);
});

test('path with .. traversal returns 403', async () => {
  const res = await request('/game/../config.js');
  assert.equal(res.status, 403);
});

test('path with a null byte returns 400', async () => {
  const res = await request('/game/index%00.html');
  assert.equal(res.status, 400);
});

test('GET /api/status returns 200 {status:"ok"}', async () => {
  const res = await request('/api/status');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { status: 'ok' });
});

test('a normal static file returns 200', async () => {
  const res = await request('/game/index.html');
  assert.equal(res.status, 200);
  assert.ok(res.body.length > 0, 'expected a non-empty body');
});

test('an unknown route returns 404', async () => {
  const res = await request('/nope/does-not-exist');
  assert.equal(res.status, 404);
});

test('.backups segment is not served through the data mount (404)', async () => {
  const res = await request('/data/.backups/anything.json');
  assert.equal(res.status, 404);
});

// ── Unit: readBody enforces the size cap and reports overflow as 413 ──
function mockReq() {
  const req = new EventEmitter();
  req.destroy = () => { req.destroyed = true; };
  return req;
}

function mockRes() {
  return {
    statusCode: null,
    headersSent: false,
    body: null,
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    end(body) { this.body = body; },
  };
}

test('readBody resolves with the accumulated body under the cap', async () => {
  const req = mockReq();
  const res = mockRes();
  const p = readBody(req, res, 1024);
  req.emit('data', 'hello ');
  req.emit('data', 'world');
  req.emit('end');
  assert.equal(await p, 'hello world');
  assert.equal(res.statusCode, null, 'no error response on the happy path');
});

test('readBody responds 413 and destroys the socket when the cap is exceeded', async () => {
  const req = mockReq();
  const res = mockRes();
  const p = readBody(req, res, 4); // tiny cap
  req.emit('data', 'aaaaaaaa'); // 8 bytes > 4
  assert.equal(await p, null, 'resolves null to signal a response was already sent');
  assert.equal(res.statusCode, 413);
  assert.equal(req.destroyed, true);
});

test('readBody responds 400 on a stream error', async () => {
  const req = mockReq();
  const res = mockRes();
  const p = readBody(req, res);
  req.emit('error', new Error('boom'));
  assert.equal(await p, null);
  assert.equal(res.statusCode, 400);
});
