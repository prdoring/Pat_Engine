// Pat_Engine host — game-agnostic Node HTTP server.
// Serves the engine, editors, data, game, and SFX as static files, and exposes
// the editor save API. NO WebSocketServer in the single-player core (the optional
// engine/net module brings its own when a project needs multiplayer).

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PORT, HOST, EDITOR_PASSWORD, DIRS, MIME, MAX_BACKUPS, getSaveAllowlist } from './config.js';
import { handleSaveData, handleManageCollection, readBody } from './saveData.js';

// Per-process session token. The auth cookie carries THIS, never the password,
// so the secret never round-trips through the browser. Regenerated each start.
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex');

// Mark the auth cookie Secure when bound to a non-loopback interface (i.e. when
// the server is actually reachable over a network and likely behind TLS).
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const COOKIE_SECURE = !LOOPBACK_HOSTS.has(HOST);

/** Constant-time string compare that first guards against length leaks. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// First path segment → served directory.
const MOUNTS = {
  engine: DIRS.engine,
  editors: DIRS.editors,
  data: DIRS.data,
  game: DIRS.game,
  assets: path.join(DIRS.root, 'assets'),
  SFX: DIRS.sfx,
  MIDI: DIRS.midi,
};

// Routes that require editor auth when EDITOR_PASSWORD is set.
function isEditorRoute(method, pathname) {
  return (method === 'POST' && pathname === '/api/save-data')
    || (method === 'POST' && pathname === '/api/manage-collection')
    || (method === 'GET' && pathname === '/api/sfx-files')
    || (method === 'GET' && pathname === '/api/midi-files')
    || pathname === '/editor'
    || pathname.startsWith('/editors/');
}

function isAuthed(req) {
  if (!EDITOR_PASSWORD) return true; // auth disabled
  const cookies = req.headers.cookie || '';
  for (const c of cookies.split(';')) {
    const trimmed = c.trim();
    if (trimmed.startsWith('editor_auth=') && safeEqual(trimmed.slice('editor_auth='.length), SESSION_TOKEN)) {
      return true;
    }
  }
  if (safeEqual(req.headers.authorization || '', `Bearer ${EDITOR_PASSWORD}`)) return true;
  return false;
}

const LOGIN_PAGE = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Editor Login</title>
<style>body{background:#10121a;color:#cfd6e6;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
form{border:1px solid #2a3550;border-radius:8px;padding:28px;display:flex;flex-direction:column;gap:12px;width:300px}
input,button{padding:9px 12px;border-radius:6px;border:1px solid #2a3550;background:#161a26;color:#cfd6e6;font-size:14px}
button{cursor:pointer;border-color:#4a6a9a}</style></head><body>
<form method="POST" action="/editor/login"><h2>Editor Login</h2>
<input type="password" name="password" placeholder="Password" autofocus>
<button type="submit">Enter</button><div style="color:#c0584a;font-size:12px">EDITOR_LOGIN_ERROR</div></form></body></html>`;

function send(res, status, contentType, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': contentType, ...extraHeaders });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, 'application/json', JSON.stringify(obj));
}

/** Serve a file, guarding against path traversal outside baseDir. */
function serveFile(res, baseDir, relPath) {
  const filePath = path.join(baseDir, relPath);
  const resolved = path.resolve(filePath);
  if (resolved !== path.resolve(baseDir) && !resolved.startsWith(path.resolve(baseDir) + path.sep)) {
    return send(res, 403, 'text/plain', 'Forbidden');
  }
  const ext = path.extname(resolved);
  const mime = MIME[ext] || 'application/octet-stream';
  fs.readFile(resolved, (err, data) => {
    if (err) return send(res, 404, 'text/plain', 'Not found');
    // No-build dev engine: never cache source/data so edits show on reload
    // (a stale cached .js module is a confusing footgun otherwise).
    send(res, 200, mime, data, { 'Cache-Control': 'no-cache, no-store, must-revalidate' });
  });
}

// The request handler is exported so it can be exercised in tests against an
// ephemeral server, without binding the real port.
export function requestHandler(req, res) {
  try {
    // Decode the path in its own guard — malformed escapes (e.g. `/%`) throw
    // URIError, which must become a clean 400 rather than a crashed socket.
    let pathname;
    try {
      pathname = decodeURIComponent((req.url || '').split('?')[0]);
    } catch {
      return send(res, 400, 'text/plain', 'Bad request');
    }

    // Null byte in the path → reject before any routing or fs access (a null
    // byte reaching fs.readFile throws synchronously).
    if (pathname.includes('\x00')) {
      return send(res, 400, 'text/plain', 'Bad request');
    }

    // ── Editor login (only meaningful when EDITOR_PASSWORD is set) ──
    if (req.method === 'POST' && pathname === '/editor/login') {
      readBody(req, res).then(body => {
        if (body === null) return; // 413 / stream error already answered
        const pw = new URLSearchParams(body).get('password') || '';
        if (EDITOR_PASSWORD && safeEqual(pw, EDITOR_PASSWORD)) {
          const cookie = `editor_auth=${SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`
            + (COOKIE_SECURE ? '; Secure' : '');
          res.writeHead(302, { 'Set-Cookie': cookie, 'Location': '/editor' });
          res.end();
        } else {
          send(res, 200, 'text/html', LOGIN_PAGE.replace('EDITOR_LOGIN_ERROR', 'Wrong password'));
        }
      }).catch(err => {
        console.error('Login handler error:', err);
        if (!res.headersSent) send(res, 500, 'text/plain', 'Internal server error');
      });
      return;
    }

    // ── Public status (client readiness probe) ──
    if (req.method === 'GET' && pathname === '/api/status') {
      return sendJson(res, 200, { status: 'ok' });
    }

    // ── Editor auth gate ──
    if (isEditorRoute(req.method, pathname) && !isAuthed(req)) {
      if (pathname === '/editor') {
        return send(res, 200, 'text/html', LOGIN_PAGE.replace('EDITOR_LOGIN_ERROR', ''));
      }
      return sendJson(res, 401, { error: 'Not authenticated' });
    }

    // ── Editor save API ──
    if (req.method === 'POST' && pathname === '/api/save-data') {
      return handleSaveData(req, res, {
        dataDir: DIRS.data,
        backupDir: DIRS.backups,
        allowlist: getSaveAllowlist(),
        maxBackups: MAX_BACKUPS,
      });
    }

    // ── Editor collection management (create/rename/delete art collections) ──
    if (req.method === 'POST' && pathname === '/api/manage-collection') {
      return handleManageCollection(req, res, { dataDir: DIRS.data, backupDir: DIRS.backups });
    }

    // ── SFX file listing (for the soundboard file-layer picker) ──
    if (req.method === 'GET' && pathname === '/api/sfx-files') {
      return fs.readdir(DIRS.sfx, (err, files) => {
        if (err) return sendJson(res, 200, []);
        const sfx = files.filter(f => /\.(wav|ogg|mp3|flac)$/i.test(f)).map(f => '/SFX/' + f).sort();
        sendJson(res, 200, sfx);
      });
    }

    // ── MIDI file listing (for the soundboard MIDI-tune picker) ──
    if (req.method === 'GET' && pathname === '/api/midi-files') {
      return fs.readdir(DIRS.midi, (err, files) => {
        if (err) return sendJson(res, 200, []);
        const midi = files.filter(f => /\.midi?$/i.test(f)).map(f => '/MIDI/' + f).sort();
        sendJson(res, 200, midi);
      });
    }

    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed');

    // ── Page routes ──
    if (pathname === '/' || pathname === '/index.html') {
      return serveFile(res, DIRS.game, 'index.html');
    }
    if (pathname === '/editor') {
      return serveFile(res, DIRS.editors, 'editor.html');
    }
    // Shot harness viewer — renders predefined game states to images (read-only, ungated).
    if (pathname === '/shots') {
      return serveFile(res, DIRS.editors, 'shots.html');
    }

    // ── Static mounts: first path segment selects the directory ──
    const segments = pathname.split('/').filter(Boolean);
    // Never expose backup snapshots through the data (or any) mount.
    if (segments.includes('.backups')) {
      return send(res, 404, 'text/plain', 'Not found');
    }
    const mountBase = MOUNTS[segments[0]];
    if (mountBase) {
      return serveFile(res, mountBase, segments.slice(1).join('/'));
    }

    // Top-level files (favicon.ico, site.webmanifest, apple-touch-icon.png,
    // og-image.png, robots.txt, …) are served from /public. Single-segment only,
    // so this can't expose project source at the root; serveFile 404s if absent.
    if (segments.length === 1) {
      return serveFile(res, DIRS.public, segments[0]);
    }

    send(res, 404, 'text/plain', 'Not found');
  } catch (err) {
    // Final guard: a throw must never escape and crash the connection handler.
    if (res.headersSent) return;
    if (err instanceof URIError) return send(res, 400, 'text/plain', 'Bad request');
    console.error('Request handler error:', err);
    send(res, 500, 'text/plain', 'Internal server error');
  }
}

const server = http.createServer(requestHandler);

// Only bind the port when run directly (`node server/main.js`), not on import
// (tests import requestHandler and drive their own ephemeral server).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  server.listen(PORT, HOST, () => {
    console.log(`Pat_Engine running → http://localhost:${PORT}/  (editor: /editor)  [bound ${HOST}:${PORT}]`);
    if (EDITOR_PASSWORD) console.log('Editor auth: ENABLED');
  });

  // Log stray async throws instead of letting them kill the process.
  process.on('uncaughtException', err => console.error('uncaughtException:', err));
  process.on('unhandledRejection', err => console.error('unhandledRejection:', err));

  // Graceful shutdown.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log(`\n${sig} — shutting down.`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}
