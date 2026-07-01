// Browser boot smoke test — the automated version of AGENTS.md's "load every page
// with no console errors". Guards the browser-only surface (Web Audio, canvas draw,
// RAF loop, DOM editor mounts) that the Node `--test` suite structurally cannot reach.
//
// Zero new dependencies: it drives the system Chrome/Edge over the DevTools Protocol
// using the `ws` package the engine already ships (for engine/net). No Puppeteer, no
// build step. Hosts the app in-process via the server's exported requestHandler.
//
//   npm run smoke                 # auto-detect a browser
//   BROWSER=/path/to/chrome npm run smoke
//
// Exit 1 if any route emits a console error / uncaught exception / broken module or
// data request. Exit 0 on success, or on SKIP when no browser is installed (so it is
// safe to wire into pipelines that may lack one — set BROWSER in CI to enforce).

import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { requestHandler } from '../server/main.js';

const SETTLE_MS = 1600;       // let the app boot, mount, run a few RAF frames + audio init
const LOAD_TIMEOUT_MS = 15000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Routes: game, every editor tab (each hash mounts one editor module on load), shots.
const ROUTES = [
  { path: '/', label: 'game' },
  { path: '/editor#art', label: 'editor:art' },
  { path: '/editor#vfx', label: 'editor:vfx' },
  { path: '/editor#sequences', label: 'editor:sequences' },
  { path: '/editor#soundboard', label: 'editor:soundboard(sounds)' },
  { path: '/editor#music', label: 'editor:music' },
  { path: '/shots', label: 'shots' },
];

// SMOKE_EXTRA=/some/path adds an ad-hoc route (handy for spot-checking one page, and
// for self-testing that this runner actually fails on a bad page).
if (process.env.SMOKE_EXTRA) ROUTES.push({ path: process.env.SMOKE_EXTRA, label: 'extra' });

// Same-origin requests for these break the app; a 404 here is a real (restructure) bug.
const APP_ASSET = /\.(m?js|json|css)(\?|$)/;

function findBrowser() {
  const candidates = [
    process.env.BROWSER, process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ].filter(Boolean);
  return candidates.find(existsSync) || null;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Minimal CDP client over a single WebSocket: correlates command ids to replies and
// dispatches events to a listener.
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.onEvent = () => {};
    this.ready = new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.onEvent(msg.method, msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// Flatten a console/exception/log/network event into { level, text } or null to ignore.
function classify(method, params, origin) {
  if (method === 'Runtime.exceptionThrown') {
    const d = params.exceptionDetails;
    const text = d.exception?.description || d.text || 'uncaught exception';
    return { level: 'error', text };
  }
  if (method === 'Runtime.consoleAPICalled') {
    if (params.type === 'error') return { level: 'error', text: argsText(params.args) };
    if (params.type === 'warning') return { level: 'warn', text: argsText(params.args) };
    return null;
  }
  if (method === 'Log.entryAdded') {
    const e = params.entry;
    if (e.source === 'network') return null; // handled via Network domain w/ asset filter
    if (e.level === 'error') return { level: 'error', text: e.text };
    if (e.level === 'warning') return { level: 'warn', text: e.text };
    return null;
  }
  if (method === 'Network.responseReceived') {
    const { url, status } = params.response;
    if (url.startsWith(origin) && status >= 400) {
      return { level: APP_ASSET.test(url) ? 'error' : 'warn', text: `HTTP ${status} ${url}` };
    }
    return null;
  }
  if (method === 'Network.loadingFailed') {
    const url = params.request?.url || '';
    if (url.startsWith(origin) && !params.canceled && APP_ASSET.test(url)) {
      return { level: 'error', text: `request failed: ${url} (${params.errorText})` };
    }
    return null;
  }
  return null;
}

function argsText(args = []) {
  return args.map(a => a.value ?? a.description ?? (a.type === 'undefined' ? 'undefined' : JSON.stringify(a.preview?.properties) ?? a.type)).join(' ');
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.log('⚠ SKIP: no Chrome/Edge/Chromium found. Set BROWSER=/path/to/chrome to enable.');
    process.exit(0);
  }

  // 1) Host the app in-process on an ephemeral port.
  const server = http.createServer(requestHandler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  console.log(`● server ${origin}`);
  console.log(`● browser ${browser}`);

  // 2) Launch headless browser with a throwaway profile + CDP on an auto port.
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'patsmoke-'));
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--mute-audio',
    `--user-data-dir=${userDataDir}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: 'ignore' });

  let page, cdp, failures = 0;
  try {
    // 3) Read the CDP port Chrome writes, connect to the browser endpoint.
    const portFile = path.join(userDataDir, 'DevToolsActivePort');
    let devPort;
    for (let i = 0; i < 150 && devPort === undefined; i++) {
      if (existsSync(portFile)) devPort = parseInt(readFileSync(portFile, 'utf8').split('\n')[0], 10);
      else await sleep(100);
    }
    if (!devPort) throw new Error('browser did not expose a DevTools port');

    const { webSocketDebuggerUrl } = await getJson(`http://127.0.0.1:${devPort}/json/version`);
    const browserCdp = new CDP(webSocketDebuggerUrl);
    await browserCdp.ready;
    const { targetId } = await browserCdp.send('Target.createTarget', { url: 'about:blank' });
    cdp = browserCdp;

    // 4) Attach directly to the page target (page-scoped session — no sessionId routing).
    page = new CDP(`ws://127.0.0.1:${devPort}/devtools/page/${targetId}`);
    await page.ready;
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Network.enable');

    // 5) Drive each route through the one tab; collect classified messages per route.
    let bucket = [];
    let loadResolve = null;
    page.onEvent = (method, params) => {
      if (method === 'Page.loadEventFired' && loadResolve) { loadResolve(); loadResolve = null; }
      const c = classify(method, params, origin);
      if (c) bucket.push(c);
    };

    for (const route of ROUTES) {
      bucket = [];
      // Absolute URLs (data:, http://…) pass through; bare paths get the app origin.
      const url = /^\w+:/.test(route.path) ? route.path : origin + route.path;
      const loaded = new Promise(res => { loadResolve = res; });
      try {
        await page.send('Page.navigate', { url });
        await Promise.race([loaded, sleep(LOAD_TIMEOUT_MS)]);
      } catch (err) {
        bucket.push({ level: 'error', text: `navigation failed: ${err.message}` });
      }
      await sleep(SETTLE_MS); // let RAF/audio/async mounts run and surface late errors

      const errors = bucket.filter(m => m.level === 'error');
      const warns = bucket.filter(m => m.level === 'warn');
      if (errors.length) {
        failures++;
        console.log(`✗ ${route.label}  (${route.path})`);
        for (const e of dedupe(errors)) console.log(`    ERROR: ${trim(e.text)}`);
        for (const w of dedupe(warns)) console.log(`    warn:  ${trim(w.text)}`);
      } else {
        const tail = warns.length ? `  (${warns.length} warning${warns.length > 1 ? 's' : ''})` : '';
        console.log(`✓ ${route.label}  (${route.path})${tail}`);
        for (const w of dedupe(warns)) console.log(`    warn:  ${trim(w.text)}`);
      }
    }
  } finally {
    page?.close();
    cdp?.close();
    try { proc.kill(); } catch { /* ignore */ }
    await new Promise(r => server.close(r));
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('');
  if (failures) {
    console.log(`✗ browser smoke FAILED — ${failures} route(s) with console errors.`);
    process.exit(1);
  }
  console.log(`✓ browser smoke passed — ${ROUTES.length} routes, no console errors.`);
  process.exit(0);
}

const dedupe = (list) => {
  const seen = new Set();
  return list.filter(m => (seen.has(m.text) ? false : seen.add(m.text)));
};
const trim = (t) => (t.length > 300 ? t.slice(0, 300) + '…' : t).replace(/\s+/g, ' ');

main().catch((err) => { console.error('smoke runner crashed:', err); process.exit(1); });
