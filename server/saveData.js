// Editor save pipeline — game-agnostic.
// POST { file, data } → validates against an allowlist, backs up the existing
// file (keeping the last N), then writes the new JSON. Extracted from Sub Game's
// server/main.js handleSaveData so any project can reuse it as a module.

import fs from 'node:fs';
import path from 'node:path';

// Hard cap on accepted request bodies. Editor saves are small JSON documents;
// anything larger is almost certainly abuse or a bug, so reject early.
export const MAX_BODY = 5 * 1024 * 1024; // 5 MB

/**
 * Accumulate a request body with a hard size cap and stream error handling.
 * On overflow responds 413 and destroys the socket; on a stream error responds
 * 400. Resolves with the body string on success, or `null` when a response has
 * already been sent (caller must then return without writing further).
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {number} [maxBytes=MAX_BODY]
 * @returns {Promise<string|null>}
 */
export function readBody(req, res, maxBytes = MAX_BODY) {
  return new Promise((resolve) => {
    let body = '';
    let size = 0;
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        respond(res, 413, { error: 'Request body too large' });
        req.destroy();
        return finish(null);
      }
      body += chunk;
    });
    req.on('end', () => finish(body));
    req.on('error', () => {
      if (!res.headersSent) respond(res, 400, { error: 'Request stream error' });
      finish(null);
    });
  });
}

/**
 * Handle a POST /api/save-data request.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {object} opts
 * @param {string} opts.dataDir    - directory JSON files are written to
 * @param {string} opts.backupDir  - directory backups are written to
 * @param {Set<string>} opts.allowlist - permitted bare filenames
 * @param {number} [opts.maxBackups=10]
 */
export function handleSaveData(req, res, { dataDir, backupDir, allowlist, maxBackups = 10 }) {
  readBody(req, res).then(body => {
    if (body === null) return; // 413 / stream error already answered
    let parsed;
    try { parsed = JSON.parse(body); } catch {
      return respond(res, 400, { error: 'Invalid JSON body' });
    }
    const { file, data } = parsed;
    if (!file || data === undefined) {
      return respond(res, 400, { error: 'Missing file or data' });
    }
    if (!allowlist.has(file)) {
      return respond(res, 400, { error: `File not in allowlist: ${file}` });
    }
    // Path-traversal guard — bare filename only.
    if (file.includes('/') || file.includes('\\') || file.includes('..')) {
      return respond(res, 400, { error: 'Invalid filename' });
    }
    let jsonStr;
    try { jsonStr = JSON.stringify(data, null, 2); } catch {
      return respond(res, 400, { error: 'Data is not valid JSON' });
    }

    const targetPath = path.join(dataDir, file);
    fs.mkdir(backupDir, { recursive: true }, () => {
      fs.readFile(targetPath, 'utf8', (readErr, existing) => {
        const writeNew = () => {
          fs.writeFile(targetPath, jsonStr + '\n', 'utf8', (writeErr) => {
            if (writeErr) return respond(res, 500, { error: 'Write failed: ' + writeErr.message });
            respond(res, 200, { ok: true });
          });
        };
        if (!readErr && existing) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const backupPath = path.join(backupDir, `${file}.${ts}.json`);
          fs.writeFile(backupPath, existing, 'utf8', () => {
            pruneBackups(backupDir, file, maxBackups, writeNew);
          });
        } else {
          writeNew();
        }
      });
    });
  });
}

/**
 * Handle a POST /api/manage-collection request — create / rename / delete an art
 * collection. This is the *only* path that writes `editor-manifest.json`, and it
 * does so safely: collection ids are validated, and the art filename is DERIVED
 * server-side (`<id>-art.json`), never taken from the client — so the save
 * allowlist (which is derived from the manifest) can never gain an arbitrary path.
 * Same editor-auth gate as save-data.
 * @param {object} opts { dataDir, backupDir }
 */
export function handleManageCollection(req, res, { dataDir, backupDir }) {
  readBody(req, res).then(body => {
    if (body === null) return;
    let parsed;
    try { parsed = JSON.parse(body); } catch { return respond(res, 400, { error: 'Invalid JSON body' }); }
    const { action, id, label } = parsed;
    if (!action || !id) return respond(res, 400, { error: 'Missing action or id' });
    if (!/^[a-z][a-z0-9_]*$/.test(id)) {
      return respond(res, 400, { error: 'Collection id must be lowercase letters / digits / underscore, starting with a letter' });
    }

    const manifestPath = path.join(dataDir, 'editor-manifest.json');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {
      return respond(res, 500, { error: 'Cannot read editor-manifest.json' });
    }
    manifest.artCollections = manifest.artCollections || [];
    const existing = manifest.artCollections.find(c => c.id === id);

    const backupAndWrite = (file, str) => {
      fs.mkdirSync(backupDir, { recursive: true });
      const target = path.join(dataDir, file);
      if (fs.existsSync(target)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(path.join(backupDir, `${file}.${ts}.json`), fs.readFileSync(target, 'utf8'));
      }
      fs.writeFileSync(target, str + '\n', 'utf8');
    };

    try {
      if (action === 'create') {
        if (existing) return respond(res, 409, { error: `Collection "${id}" already exists` });
        const file = `${id}-art.json`;                       // derived, safe
        manifest.artCollections.push({ id, label: label || (id[0].toUpperCase() + id.slice(1)), file, collectionKey: id });
        backupAndWrite(file, JSON.stringify({ [id]: {} }, null, 2));
        backupAndWrite('editor-manifest.json', JSON.stringify(manifest, null, 2));
      } else if (action === 'rename') {
        if (!existing) return respond(res, 404, { error: `Collection "${id}" not found` });
        existing.label = (label || existing.label).slice(0, 64);
        backupAndWrite('editor-manifest.json', JSON.stringify(manifest, null, 2));
      } else if (action === 'delete') {
        if (!existing) return respond(res, 404, { error: `Collection "${id}" not found` });
        // Remove from the manifest only; the art file stays on disk (recoverable).
        manifest.artCollections = manifest.artCollections.filter(c => c.id !== id);
        backupAndWrite('editor-manifest.json', JSON.stringify(manifest, null, 2));
      } else {
        return respond(res, 400, { error: 'Unknown action' });
      }
    } catch (e) {
      return respond(res, 500, { error: 'Write failed: ' + e.message });
    }
    respond(res, 200, { ok: true, manifest });
  });
}

/** Keep only the most recent `maxBackups` backups for `file`. */
function pruneBackups(backupDir, file, maxBackups, done) {
  fs.readdir(backupDir, (_, files) => {
    if (files) {
      // ISO timestamps sort lexicographically → oldest first.
      const matching = files.filter(f => f.startsWith(file + '.')).sort();
      if (matching.length > maxBackups) {
        const toDelete = matching.slice(0, matching.length - maxBackups);
        toDelete.forEach(f => fs.unlink(path.join(backupDir, f), () => {}));
      }
    }
    done();
  });
}

function respond(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}
