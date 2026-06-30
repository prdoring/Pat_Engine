// editors/artEditorTimeline.js
// Keyframe timeline for the art editor — a canvas dope-sheet forked from the MIDI
// piano roll (editors/pianoRoll.js): same ruler + draggable playhead, drag-mode
// mouse model, Ctrl/Cmd+wheel zoom (Shift+wheel pan), and dark themed look, but
// with one row per animated (shape · property) instead of a pitch grid. Edits go
// through the pure ops in artKeyframes.js; the host owns persistence (ctx.markDirty)
// and the preview clock (ctx.playhead → previewTransition.animTime, set by the
// preview each frame). Transport feel mirrors the music editor.

import { ctx, getShapeAtPath } from './artEditorCtx.js';
import { Button, Select, Toggle } from './editorShared.js';
import { renderPreview } from './artEditorPreview.js';
import {
  clipMeta, ensureClip, setClipMeta, listTracks, getTrack, setKeyframe,
  deleteKeyframe, makeLoopable, clipKeys,
} from './artKeyframes.js';
import { sampleTrack } from '/engine/render/interp.js';

const GUTTER = 132;  // left label column
const RULER = 20;    // time ruler height
const ROW_H = 22;    // property-track row height
const HIT = 6;       // px grab radius for diamonds / playhead

export function createArtTimeline(container) {
  injectStyle();
  const el = document.createElement('div');
  el.className = 'kf-wrap';

  const bar = document.createElement('div');
  bar.className = 'kf-transport';
  el.appendChild(bar);

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'kf-canvas-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'kf-canvas';
  canvasWrap.appendChild(canvas);
  el.appendChild(canvasWrap);
  container.appendChild(el);

  const cx = canvas.getContext('2d');
  let zoom = 1, scrollX = 0, drag = null, rows = [];

  const dpr = () => window.devicePixelRatio || 1;
  const W = () => parseFloat(canvas.style.width) || 600;
  const H = () => parseFloat(canvas.style.height) || 120;
  const art = () => ctx.currentArt;
  const clipKey = () => ctx.keyTargetClip || '*';
  const duration = () => (clipMeta(art(), clipKey())?.duration) || 2000;
  const pxPerMs = () => ((W() - GUTTER) / duration()) * zoom;
  const xAt = (t) => GUTTER + t * pxPerMs() - scrollX;
  const timeAt = (x) => (x - GUTTER + scrollX) / pxPerMs();
  const clampX = () => { scrollX = Math.max(0, Math.min(scrollX, Math.max(0, duration() * pxPerMs() - (W() - GUTTER)))); };

  // ── Transport bar ──────────────────────────────────────────────────────────
  function buildBar() {
    bar.innerHTML = '';
    if (!art()) return;

    const a = art();
    const ck = clipKey();
    const clip = clipMeta(a, ck);

    // play / pause / stop
    const playBtn = Button(ctx.animPlaying ? '❚❚' : '►', () => {
      if (ctx.animPlaying) ctx.stopAnimation(); else ctx.startAnimation();
      buildBar();
    }, 'subtle');
    playBtn.el.title = 'Play / Pause (Space)';
    bar.appendChild(playBtn.el);
    const stopBtn = Button('■', () => { ctx.playhead = 0; renderPreview(); redraw(); }, 'subtle');
    stopBtn.el.title = 'Stop — rewind playhead to 0 (←)';
    bar.appendChild(stopBtn.el);

    // clip selector (key target): "*" + every state
    const states = (ctx.discoveredStates || []).filter((s) => s !== 'BASE');
    const opts = [{ value: '*', label: 'Always (every state)' }, ...states.map((s) => ({ value: s, label: s }))];
    bar.appendChild(Select('Animate', opts, ck, (v) => {
      ctx.keyTargetClip = v;
      if (v !== '*') { ctx.previewState = v; ctx.currentEditState = v; ctx.rebuildStateBar?.(); }
      ctx.playhead = 0; scrollX = 0;
      refresh(); ctx.rebuildProps?.(); renderPreview();
    }).el);

    if (!clip) {
      // Clip not enabled yet for this key target.
      const add = Button('+ Animate this', () => {
        ensureClip(a, ck);
        ctx.markDirty(); refresh();
      }, 'primary');
      add.el.title = 'Create a keyframe clip for this target';
      bar.appendChild(add.el);
      addHint();
      return;
    }

    // loop / once
    bar.appendChild(Toggle('Loop', clip.loop !== false, (v) => { setClipMeta(a, ck, { loop: v }); ctx.markDirty(); }).el);

    // duration
    const durWrap = document.createElement('label');
    durWrap.className = 'kf-dur';
    durWrap.textContent = 'len ';
    const dur = document.createElement('input');
    dur.type = 'number'; dur.min = '1'; dur.step = '50'; dur.value = String(clip.duration);
    dur.addEventListener('change', () => {
      const ms = Math.max(1, parseInt(dur.value, 10) || clip.duration);
      setClipMeta(a, ck, { duration: ms }); ctx.markDirty(); clampX(); refresh();
    });
    durWrap.appendChild(dur);
    const durMs = document.createElement('span'); durMs.className = 'kf-unit'; durMs.textContent = 'ms';
    durWrap.appendChild(durMs);
    bar.appendChild(durWrap);

    // make-loopable for the selected key's track
    if (ctx.selectedKeyframe) {
      const mk = Button('Make loopable', () => {
        const sk = ctx.selectedKeyframe;
        const shape = getShapeAtPath(a.shapes, sk.path);
        if (shape) { makeLoopable(shape, ck, sk.prop, clip.duration); ctx.markDirty(); refresh(); }
      }, 'subtle');
      mk.el.title = 'Copy the first key to t=end so the loop is seamless';
      bar.appendChild(mk.el);
    }

    const time = document.createElement('span');
    time.className = 'kf-time';
    time.textContent = `${Math.round(ctx.playhead || 0)} / ${clip.duration}ms`;
    bar.appendChild(time);
    timeReadout = time;

    addHint();
  }
  let timeReadout = null;
  function addHint() {
    const hint = document.createElement('span');
    hint.className = 'kf-hint';
    hint.textContent = 'drag ruler = scrub · drag ◆ = retime · dbl-click row = add key · right-click ◆ = delete · Ctrl+wheel zoom';
    bar.appendChild(hint);
  }

  // ── Canvas sizing ────────────────────────────────────────────────────────
  function resize() {
    const r = canvasWrap.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return;
    const w = Math.floor(r.width), h = Math.floor(r.height), d = dpr();
    canvas.width = Math.floor(w * d); canvas.height = Math.floor(h * d);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    clampX(); redraw();
  }

  // ── Draw ─────────────────────────────────────────────────────────────────
  function redraw() {
    if (!canvas.width) return;
    const w = W(), h = H();
    cx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    cx.clearRect(0, 0, w, h);
    cx.fillStyle = '#0b1018'; cx.fillRect(0, 0, w, h);

    const a = art();
    if (!a) return;
    const ck = clipKey();
    const clip = clipMeta(a, ck);
    if (!clip) {
      cx.fillStyle = '#5a6a80'; cx.font = '11px monospace'; cx.textBaseline = 'middle';
      cx.fillText('No clip — click "+ Animate this" above.', GUTTER + 8, RULER + 16);
      return;
    }
    const dur = clip.duration;

    // ruler
    cx.fillStyle = '#11161f'; cx.fillRect(GUTTER, 0, w - GUTTER, RULER);
    cx.font = '9px monospace'; cx.textBaseline = 'middle'; cx.textAlign = 'left';
    const stepMs = niceStep(dur, (w - GUTTER));
    for (let t = 0; t <= dur + 1e-6; t += stepMs) {
      const x = xAt(t); if (x < GUTTER - 1 || x > w) continue;
      cx.strokeStyle = '#283242'; cx.lineWidth = 1;
      cx.beginPath(); cx.moveTo(Math.floor(x) + 0.5, 0); cx.lineTo(Math.floor(x) + 0.5, h); cx.stroke();
      cx.fillStyle = '#7a8aa0'; cx.fillText((t / 1000).toFixed(2) + 's', x + 3, RULER / 2);
    }

    // rows
    rows.forEach((row, i) => {
      const y = RULER + i * ROW_H;
      const selShape = ctx.selectedShapePath && ctx.selectedShapePath.join(',') === row.path.join(',');
      // gutter label
      cx.fillStyle = selShape ? '#1c2636' : (i % 2 ? '#0d131c' : '#0b1018');
      cx.fillRect(0, y, w, ROW_H);
      cx.font = '10px monospace'; cx.textBaseline = 'middle'; cx.textAlign = 'left';
      cx.fillStyle = selShape ? '#d4a056' : '#9fb0c4';
      cx.fillText(`${trunc(row.name, 10)} · ${trunc(row.prop, 9)}`, 6, y + ROW_H / 2);
      // baseline
      cx.strokeStyle = '#1a2230'; cx.beginPath(); cx.moveTo(GUTTER, y + ROW_H - 0.5); cx.lineTo(w, y + ROW_H - 0.5); cx.stroke();
      // diamonds
      for (let k = 0; k < row.keys.length; k++) {
        const key = row.keys[k];
        const x = xAt(key.t); if (x < GUTTER - HIT || x > w + HIT) continue;
        const sel = ctx.selectedKeyframe && ctx.selectedKeyframe.path.join(',') === row.path.join(',')
          && ctx.selectedKeyframe.prop === row.prop && Math.abs((ctx.selectedKeyframe.t ?? -1) - key.t) <= 1;
        diamond(cx, x, y + ROW_H / 2, sel ? 6 : 4, sel ? '#ffe08a' : '#d4a056', sel ? '#fff' : '#7a5a28');
      }
    });

    // playhead
    const px = xAt(ctx.playhead || 0);
    if (px >= GUTTER - 1 && px <= w) {
      cx.strokeStyle = '#e07b3a'; cx.lineWidth = 1.5;
      cx.beginPath(); cx.moveTo(px, 0); cx.lineTo(px, h); cx.stroke();
    }
  }

  function diamond(g, x, y, s, fill, stroke) {
    g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s, y); g.lineTo(x, y + s); g.lineTo(x - s, y); g.closePath();
    g.fillStyle = fill; g.fill(); g.strokeStyle = stroke; g.lineWidth = 1; g.stroke();
  }

  // ── Hit-testing + interaction ──────────────────────────────────────────────
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function rowAt(y) { if (y < RULER) return -1; const i = Math.floor((y - RULER) / ROW_H); return i >= 0 && i < rows.length ? i : -1; }
  function keyAt(x, y) {
    const i = rowAt(y); if (i < 0) return null;
    const row = rows[i];
    for (let k = 0; k < row.keys.length; k++) {
      if (Math.abs(xAt(row.keys[k].t) - x) <= HIT) return { row, i, k };
    }
    return null;
  }
  function selectShape(path) {
    ctx.selectedShapePath = [...path];
    ctx.rebuildTree?.(); ctx.rebuildProps?.();
  }
  function setPlayhead(t, commit) {
    ctx.playhead = Math.max(0, Math.min(duration(), t));
    if (timeReadout) timeReadout.textContent = `${Math.round(ctx.playhead)} / ${duration()}ms`;
    renderPreview(); redraw();
  }
  const arm = () => { window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp); };

  function onDown(e) {
    if (e.button === 2) return; // right-click handled in contextmenu
    if (!art() || !clipMeta(art(), clipKey())) return;
    const { x, y } = pos(e);
    if (x < GUTTER && y >= RULER) { const i = rowAt(y); if (i >= 0) selectShape(rows[i].path); return; }
    if (y < RULER) { drag = { mode: 'seek' }; setPlayhead(timeAt(x)); arm(); return; }
    const hit = keyAt(x, y);
    if (hit) {
      const key = hit.row.keys[hit.k];
      ctx.selectedKeyframe = { path: hit.row.path, prop: hit.row.prop, t: key.t, key };
      selectShape(hit.row.path);
      setPlayhead(key.t);
      drag = { mode: 'key', row: hit.row, key };
      buildBar(); arm(); return;
    }
    // empty grid → select the row's shape + scrub
    const i = rowAt(y); if (i >= 0) selectShape(rows[i].path);
    drag = { mode: 'seek' }; setPlayhead(timeAt(x)); arm();
  }

  function onMove(e) {
    if (!drag) return;
    const { x } = pos(e);
    if (drag.mode === 'seek') { setPlayhead(timeAt(x)); return; }
    if (drag.mode === 'key') {
      let t = Math.max(0, Math.min(duration(), timeAt(x)));
      t = snapTime(t, drag.row, drag.key);
      drag.key.t = t; drag.moved = true;
      ctx.selectedKeyframe.t = t;
      setPlayhead(t);
    }
  }

  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (drag?.mode === 'key' && drag.moved) {
      drag.row.keys.sort((a, b) => a.t - b.t);
      ctx.markDirty(); refresh();
    }
    drag = null;
  }

  function onContext(e) {
    e.preventDefault();
    const { x, y } = pos(e);
    const hit = keyAt(x, y);
    if (hit) {
      const shape = getShapeAtPath(art().shapes, hit.row.path);
      deleteKeyframe(shape, clipKey(), hit.row.prop, hit.k);
      if (ctx.selectedKeyframe && ctx.selectedKeyframe.path.join(',') === hit.row.path.join(',')) ctx.selectedKeyframe = null;
      ctx.markDirty(); refresh();
    }
  }

  function onDblClick(e) {
    const { x, y } = pos(e);
    const i = rowAt(y); if (i < 0 || x < GUTTER) return;
    const row = rows[i];
    const shape = getShapeAtPath(art().shapes, row.path);
    if (!shape) return;
    const t = Math.max(0, Math.min(duration(), timeAt(x)));
    // Insert a key that doesn't disturb the curve: value sampled at that time.
    const v = sampleTrack(getTrack(shape, clipKey(), row.prop), t);
    setKeyframe(shape, clipKey(), row.prop, Math.round(t), cloneVal(v));
    ctx.markDirty(); refresh();
  }

  function onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const { x } = pos(e); const under = timeAt(x);
      zoom = Math.max(1, Math.min(40, zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      scrollX = under * pxPerMs() - (x - GUTTER); clampX(); redraw();
    } else if (e.shiftKey) {
      e.preventDefault(); scrollX += e.deltaY; clampX(); redraw();
    }
  }

  function snapTime(t, row, key) {
    const px = (ms) => xAt(ms);
    const targets = [0, duration()];
    for (const k of row.keys) if (k !== key) targets.push(k.t);
    let best = t, bestPx = 8;
    for (const tg of targets) { const d = Math.abs(px(tg) - px(t)); if (d < bestPx) { bestPx = d; best = tg; } }
    return best;
  }

  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('contextmenu', onContext);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  const ro = new ResizeObserver(() => resize());
  ro.observe(canvasWrap);

  // ── Public API ─────────────────────────────────────────────────────────────
  function refresh() {
    if (!art()) { rows = []; bar.innerHTML = ''; canvas.height && (cx.setTransform(dpr(), 0, 0, dpr(), 0, 0), cx.clearRect(0, 0, W(), H())); return; }
    if (!ctx.keyTargetClip || !clipKeyValid(ctx.keyTargetClip)) ctx.keyTargetClip = defaultClip();
    rows = clipMeta(art(), clipKey()) ? listTracks(art(), clipKey()) : [];
    buildBar(); resize(); redraw();
  }
  function clipKeyValid(k) {
    if (k === '*') return true;
    return (ctx.discoveredStates || []).includes(k);
  }
  function defaultClip() {
    const a = art(); if (!a) return '*';
    const keys = clipKeys(a);
    if (keys.includes('*')) return '*';
    if (keys.length) return keys[0];
    const states = (ctx.discoveredStates || []).filter((s) => s !== 'BASE');
    return states.length ? states[0] : '*';
  }
  /** Advance the playhead while playing (called from the preview tick). */
  function advance(dtMs) {
    const clip = clipMeta(art(), clipKey()); if (!clip) return;
    let p = (ctx.playhead || 0) + dtMs;
    if (clip.loop !== false) { p %= clip.duration; if (p < 0) p += clip.duration; }
    else p = Math.min(p, clip.duration);
    ctx.playhead = p;
    if (timeReadout) timeReadout.textContent = `${Math.round(p)} / ${clip.duration}ms`;
    redraw();
  }
  function destroy() {
    ro.disconnect();
    canvas.removeEventListener('mousedown', onDown);
    canvas.removeEventListener('contextmenu', onContext);
    canvas.removeEventListener('dblclick', onDblClick);
    canvas.removeEventListener('wheel', onWheel);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    el.remove();
  }

  requestAnimationFrame(resize);
  return { el, refresh, redraw, advance, destroy };
}

// ── helpers ──
const cloneVal = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const clip2 = (s, n = 12) => trunc(String(s), n);
function niceStep(dur, px) {
  const target = Math.max(40, px / 8);           // ~one label per 40-80px
  const msPerPx = dur / Math.max(1, px);
  const raw = target * msPerPx;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

function injectStyle() {
  if (document.getElementById('kf-style')) return;
  const s = document.createElement('style'); s.id = 'kf-style';
  s.textContent = `
  .kf-wrap{display:flex;flex-direction:column;height:100%;min-height:0;background:#0b1018;border-top:1px solid #2a3a4a}
  .kf-transport{display:flex;align-items:center;gap:6px;padding:4px 8px;flex-wrap:wrap;flex-shrink:0;border-bottom:1px solid #1a2230}
  .kf-canvas-wrap{position:relative;flex:1 1 auto;min-height:0;overflow:hidden}
  .kf-canvas{display:block;cursor:crosshair}
  .kf-dur{color:#7a8aa0;font-size:11px;display:inline-flex;align-items:center;gap:3px}
  .kf-dur input{width:60px;background:#11161f;border:1px solid #2a3a4a;color:#cdd6e4;font-size:11px;padding:2px 4px;border-radius:3px}
  .kf-unit{color:#5f7088;font-size:10px}
  .kf-time{color:#7a8aa0;font-size:11px;font-family:monospace}
  .kf-armed{color:#e0543a;font-size:10px;font-weight:bold;font-family:monospace}
  .kf-hint{color:#4a5a70;font-size:9px;margin-left:auto;white-space:nowrap}
  `;
  document.head.appendChild(s);
}
