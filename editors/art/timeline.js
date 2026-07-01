// editors/art/timeline.js
// Part-centric keyframe timeline (dope sheet) for the art editor. One row per
// PART (shape) instead of one row per variable: a diamond marks any time the part
// has >=1 keyed property (a "pose"). Drag a part diamond to retime the whole pose,
// right-click to delete it, double-click a row to key the pose at that time, and
// expand a part (▸) to reveal its per-property channel sub-rows for fine control.
// Editing a part in the props panel with Auto-key ON drops keys here automatically.
//
// Forked from the MIDI piano roll: same ruler + draggable playhead, drag-mode mouse
// model, Ctrl/Cmd+wheel zoom (Shift+wheel pan), and dark themed look. Edits go
// through the pure ops in model/keyframes.js; the host owns persistence (ctx.markDirty)
// and the preview clock (ctx.playhead → previewTransition.animTime).

import { ctx, getShapeAtPath } from './ctx.js';
import { Button, Toggle } from '/editors/shared/index.js';
import {
  clipMeta, ensureClip, setClipMeta, getTrack, setKeyframe, deleteKeyframe,
  makeLoopable, clipKeys, listPartRows, movePose, deletePose, keyPose, getPropValue,
} from './model/keyframes.js';
import { sampleTrack } from '/engine/render/interp.js';

const GUTTER = 150;  // left label column (wider — holds part names + caret)
const RULER = 20;    // time ruler height
const ROW_H = 22;    // row height (part or channel)
const HIT = 6;       // px grab radius for diamonds / playhead
const INDENT = 10;   // px per tree depth in the gutter

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
  let zoom = 1, scrollX = 0, scrollY = 0, drag = null, rows = [];
  const expanded = new Set();   // path-keys of parts whose channels are shown
  let lastArt = null;

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
  const visRowsH = () => Math.max(0, H() - RULER);
  const maxScrollY = () => Math.max(0, rows.length * ROW_H - visRowsH());
  const clampY = () => { scrollY = Math.max(0, Math.min(scrollY, maxScrollY())); };
  const samePath = (a, b) => !!(a && b && a.join(',') === b.join(','));

  // ── Row model ───────────────────────────────────────────────────────────────
  // A flat list of display rows: a 'part' row per animated shape (+ the selected
  // shape even if unkeyed), each optionally followed by its 'channel' sub-rows.
  function buildRows() {
    const a = art(); if (!a) return [];
    const ck = clipKey();
    const parts = listPartRows(a, ck);
    // Always give the selected part a row so you can key it from the timeline.
    const sel = ctx.selectedShapePath;
    if (sel && !parts.some((p) => samePath(p.path, sel))) {
      const shape = getShapeAtPath(a.shapes, sel);
      if (shape) parts.push({
        path: [...sel], shape, name: shape.name || shape.type || '?',
        depth: sel.length - 1, times: [], propCount: 0, selectedEmpty: true,
      });
    }
    const display = [];
    for (const part of parts) {
      display.push({ kind: 'part', ...part });
      if (expanded.has(part.path.join(','))) {
        const tracks = part.shape.anim && part.shape.anim[ck];
        if (tracks) for (const prop of Object.keys(tracks)) {
          display.push({ kind: 'channel', path: part.path, shape: part.shape, prop, keys: tracks[prop], depth: part.depth + 1 });
        }
      }
    }
    return display;
  }

  // ── Transport bar ──────────────────────────────────────────────────────────
  let timeReadout = null;
  function buildBar() {
    bar.innerHTML = '';
    if (!art()) return;
    const a = art();
    const ck = clipKey();
    const clip = clipMeta(a, ck);

    const playBtn = Button(ctx.animPlaying ? '❚❚' : '►', () => {
      if (ctx.animPlaying) ctx.stopAnimation(); else ctx.startAnimation();
      buildBar();
    }, 'subtle');
    playBtn.el.title = 'Play / Pause (Space)';
    bar.appendChild(playBtn.el);
    const stopBtn = Button('■', () => { ctx.playhead = 0; redraw(); }, 'subtle');
    stopBtn.el.title = 'Stop — rewind playhead to 0 (←)';
    bar.appendChild(stopBtn.el);

    // Auto-key toggle (mirrors the props panel) — when ON, tweaking a part in the
    // props panel keys it here at the playhead.
    bar.appendChild(Toggle('Auto-key', ctx.autoKey, (v) => { ctx.autoKey = v; ctx.rebuildProps?.(); }).el);

    // Key target: ambient "*" (composites under every state) vs the selected state.
    const curState = (ctx.currentEditState && ctx.currentEditState !== 'BASE') ? ctx.currentEditState : null;
    const seg = document.createElement('div'); seg.className = 'kf-keyseg';
    const segLbl = document.createElement('span'); segLbl.className = 'kf-seglabel'; segLbl.textContent = 'Key:';
    seg.appendChild(segLbl);
    const segBtn = (label, val, title) => {
      const b = document.createElement('button');
      b.className = 'kf-segbtn' + (ck === val ? ' active' : '');
      b.textContent = label; b.title = title;
      b.addEventListener('click', () => {
        if (ctx.keyTargetClip === val) return;
        ctx.keyTargetClip = val; ctx.playhead = 0; scrollX = 0;
        refresh(); ctx.rebuildProps?.();
      });
      return b;
    };
    seg.appendChild(segBtn('✶ Always', '*', 'Key the ambient clip — composites under every state'));
    if (curState) seg.appendChild(segBtn(clip2(curState, 10), curState, `Key the "${curState}" state clip`));
    bar.appendChild(seg);

    if (!clip) {
      const add = Button('+ Animate this', () => { ensureClip(a, ck); ctx.markDirty(); refresh(); }, 'primary');
      add.el.title = 'Create a keyframe clip for this target';
      bar.appendChild(add.el);
      addHint();
      return;
    }

    bar.appendChild(Toggle('Loop', clip.loop !== false, (v) => { setClipMeta(a, ck, { loop: v }); ctx.markDirty(); }).el);

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

    // Make-loopable applies to a selected single channel key (has a prop).
    if (ctx.selectedKeyframe && ctx.selectedKeyframe.prop) {
      const mk = Button('Make loopable', () => {
        const sk = ctx.selectedKeyframe;
        const shape = getShapeAtPath(a.shapes, sk.path);
        if (shape) { makeLoopable(shape, ck, sk.prop, clip.duration); ctx.markDirty(); refresh(); }
      }, 'subtle');
      mk.el.title = 'Copy the first key to t=end so the loop is seamless';
      bar.appendChild(mk.el);
    }

    addHint();
  }
  function addHint() {
    const t = document.createElement('span');
    t.className = 'kf-time';
    t.textContent = `${Math.round(ctx.playhead || 0)}ms`;
    bar.appendChild(t);
    timeReadout = t;
    const hint = document.createElement('span');
    hint.className = 'kf-hint';
    hint.textContent = 'ruler=scrub · ◆=move pose · dbl-click=key pose · ▸=channels · ⌃wheel=zoom · wheel=rows';
    hint.title = 'Drag the ruler to scrub · drag a part ◆ to retime the whole pose · double-click a part row to key it · right-click a ◆ to delete the pose · click ▸ to show per-property channels · Ctrl/Cmd+wheel = zoom · Shift+wheel = pan · plain wheel = scroll rows';
    bar.appendChild(hint);
  }

  // ── Canvas sizing ────────────────────────────────────────────────────────
  function resize() {
    const r = canvasWrap.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return;
    const w = Math.floor(r.width), h = Math.floor(r.height), d = dpr();
    canvas.width = Math.floor(w * d); canvas.height = Math.floor(h * d);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    clampX(); clampY(); redraw();
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

    // rows (clipped below the pinned ruler; scrolled by scrollY)
    cx.save();
    cx.beginPath(); cx.rect(0, RULER, w, h - RULER); cx.clip();
    rows.forEach((row, i) => {
      const y = RULER + i * ROW_H - scrollY;
      if (y + ROW_H < RULER || y > h) return; // off-screen
      const selShape = samePath(ctx.selectedShapePath, row.path);
      const isPart = row.kind === 'part';
      const indentX = 6 + row.depth * INDENT;

      // row background
      cx.fillStyle = selShape ? '#1c2636' : (isPart ? (i % 2 ? '#0d131c' : '#0b1018') : '#090d14');
      cx.fillRect(0, y, w, ROW_H);

      // gutter label
      cx.font = '10px monospace'; cx.textBaseline = 'middle'; cx.textAlign = 'left';
      if (isPart) {
        // expand caret
        if (row.propCount > 0) {
          cx.fillStyle = '#5f7088';
          cx.fillText(expanded.has(row.path.join(',')) ? '▾' : '▸', indentX, y + ROW_H / 2);
        }
        const dim = row.selectedEmpty;
        cx.fillStyle = dim ? '#4a5a70' : (selShape ? '#d4a056' : '#9fb0c4');
        cx.fillText(trunc(row.name, Math.max(6, 16 - row.depth * 2)), indentX + 12, y + ROW_H / 2);
        if (dim) { cx.fillStyle = '#33506a'; cx.fillText('(no keys)', GUTTER - 56, y + ROW_H / 2); }
      } else {
        cx.fillStyle = '#7a8aa0';
        cx.fillText('· ' + trunc(row.prop, Math.max(6, 16 - row.depth)), indentX + 4, y + ROW_H / 2);
      }

      // baseline
      cx.strokeStyle = '#1a2230'; cx.beginPath(); cx.moveTo(GUTTER, y + ROW_H - 0.5); cx.lineTo(w, y + ROW_H - 0.5); cx.stroke();

      // diamonds
      const cy = y + ROW_H / 2;
      if (isPart) {
        for (const t of row.times) {
          const x = xAt(t); if (x < GUTTER - HIT || x > w + HIT) continue;
          const sel = ctx.selectedKeyframe && ctx.selectedKeyframe.pose
            && samePath(ctx.selectedKeyframe.path, row.path) && Math.abs((ctx.selectedKeyframe.t ?? -1) - t) <= 1;
          diamond(cx, x, cy, sel ? 6 : 5, sel ? '#ffe08a' : '#d4a056', sel ? '#fff' : '#7a5a28');
        }
      } else {
        for (const key of row.keys) {
          const x = xAt(key.t); if (x < GUTTER - HIT || x > w + HIT) continue;
          const sel = ctx.selectedKeyframe && ctx.selectedKeyframe.prop === row.prop
            && samePath(ctx.selectedKeyframe.path, row.path) && Math.abs((ctx.selectedKeyframe.t ?? -1) - key.t) <= 1;
          diamond(cx, x, cy, sel ? 5 : 3.5, sel ? '#ffe08a' : '#b88a44', sel ? '#fff' : '#5a4420');
        }
      }
    });
    cx.restore();

    // playhead
    const px = xAt(ctx.playhead || 0);
    if (px >= GUTTER - 1 && px <= w) {
      cx.strokeStyle = '#e07b3a'; cx.lineWidth = 1.5;
      cx.beginPath(); cx.moveTo(px, 0); cx.lineTo(px, h); cx.stroke();
    }

    // scroll thumb
    const maxY = maxScrollY();
    if (maxY > 0) {
      const trackH = h - RULER;
      const thumbH = Math.max(18, trackH * (visRowsH() / (rows.length * ROW_H)));
      const thumbY = RULER + (trackH - thumbH) * (scrollY / maxY);
      cx.fillStyle = '#2c3a4e'; cx.fillRect(w - 4, RULER, 3, trackH);
      cx.fillStyle = '#5a7090'; cx.fillRect(w - 4, thumbY, 3, thumbH);
    }
  }

  function diamond(g, x, y, s, fill, stroke) {
    g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s, y); g.lineTo(x, y + s); g.lineTo(x - s, y); g.closePath();
    g.fillStyle = fill; g.fill(); g.strokeStyle = stroke; g.lineWidth = 1; g.stroke();
  }

  // ── Hit-testing + interaction ──────────────────────────────────────────────
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function rowAt(y) { if (y < RULER) return -1; const i = Math.floor((y - RULER + scrollY) / ROW_H); return i >= 0 && i < rows.length ? i : -1; }

  // Returns the diamond/pose under (x,y): { kind:'pose', row, t } | { kind:'key', row, key } | null
  function hitAt(x, y) {
    const i = rowAt(y); if (i < 0) return null;
    const row = rows[i];
    if (row.kind === 'part') {
      for (const t of row.times) if (Math.abs(xAt(t) - x) <= HIT) return { kind: 'pose', row, t };
    } else {
      for (const key of row.keys) if (Math.abs(xAt(key.t) - x) <= HIT) return { kind: 'key', row, key };
    }
    return null;
  }
  function caretHit(x, row) {
    if (row.kind !== 'part' || row.propCount === 0) return false;
    const indentX = 6 + row.depth * INDENT;
    return x >= indentX - 2 && x <= indentX + 11;
  }
  function selectShape(path) {
    ctx.selectedShapePath = [...path];
    ctx.rebuildTree?.(); ctx.rebuildProps?.();
  }
  function setPlayhead(t) {
    ctx.playhead = Math.max(0, Math.min(duration(), t));
    if (timeReadout) timeReadout.textContent = `${Math.round(ctx.playhead)}ms`;
    redraw();   // update the timeline canvas marker; the preview repaints via the render loop
  }
  // Refresh the props panel to reflect time-aware sampled values — only on commit
  // both live while scrubbing AND on commit — never mid-edit (would steal focus) or
  // during playback. Scroll is preserved so the panel doesn't jump each frame.
  function refreshPropsForScrub() {
    if (ctx.animPlaying) return;
    if (ctx.propsEl && ctx.propsEl.contains(document.activeElement)) return;
    const st = ctx.propsEl ? ctx.propsEl.scrollTop : 0;
    ctx.rebuildProps?.();
    if (ctx.propsEl) ctx.propsEl.scrollTop = st;
  }
  const arm = () => { window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp); };

  function onDown(e) {
    if (e.button === 2) return; // right-click handled in contextmenu
    if (!art() || !clipMeta(art(), clipKey())) return;
    const { x, y } = pos(e);

    // gutter: caret toggles channels, else select the part's shape
    if (x < GUTTER && y >= RULER) {
      const i = rowAt(y); if (i < 0) return;
      const row = rows[i];
      if (caretHit(x, row)) {
        const k = row.path.join(',');
        if (expanded.has(k)) expanded.delete(k); else expanded.add(k);
        refresh();
      } else {
        selectShape(row.path);
      }
      return;
    }
    if (y < RULER) { drag = { mode: 'seek' }; setPlayhead(timeAt(x)); arm(); return; }

    const hit = hitAt(x, y);
    if (hit && hit.kind === 'pose') {
      selectShape(hit.row.path);
      ctx.selectedKeyframe = { path: [...hit.row.path], t: hit.t, pose: true };
      setPlayhead(hit.t);
      drag = { mode: 'pose', shape: hit.row.shape, t: hit.t };
      buildBar(); arm(); return;
    }
    if (hit && hit.kind === 'key') {
      ctx.selectedKeyframe = { path: [...hit.row.path], prop: hit.row.prop, t: hit.key.t, key: hit.key };
      selectShape(hit.row.path);
      setPlayhead(hit.key.t);
      drag = { mode: 'key', row: hit.row, key: hit.key };
      buildBar(); arm(); return;
    }
    // empty grid → select the row's shape + scrub
    const i = rowAt(y); if (i >= 0) selectShape(rows[i].path);
    drag = { mode: 'seek' }; setPlayhead(timeAt(x)); arm();
  }

  function onMove(e) {
    if (!drag) return;
    const { x } = pos(e);
    if (drag.mode === 'seek') { setPlayhead(timeAt(x)); refreshPropsForScrub(); return; }
    if (drag.mode === 'pose') {
      let t = Math.round(Math.max(0, Math.min(duration(), timeAt(x))));
      t = snapTimeForShape(t, drag.shape, drag.t);
      if (t !== drag.t) {
        movePose(drag.shape, clipKey(), drag.t, t);
        drag.t = t; drag.moved = true;
        if (ctx.selectedKeyframe) ctx.selectedKeyframe.t = t;
        rows = buildRows();
      }
      setPlayhead(t);
      return;
    }
    if (drag.mode === 'key') {
      let t = Math.max(0, Math.min(duration(), timeAt(x)));
      t = snapTimeForKeys(t, drag.row.keys, drag.key);
      drag.key.t = t; drag.moved = true;
      if (ctx.selectedKeyframe) ctx.selectedKeyframe.t = t;
      setPlayhead(t);
    }
  }

  function onUp() {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (drag?.mode === 'key' && drag.moved) {
      drag.row.keys.sort((a, b) => a.t - b.t);
      ctx.markDirty(); refresh();
    } else if (drag?.mode === 'pose' && drag.moved) {
      ctx.markDirty(); refresh();
    } else if (drag?.mode === 'seek') {
      refreshPropsForScrub();
    }
    drag = null;
  }

  function onContext(e) {
    e.preventDefault();
    const { x, y } = pos(e);
    const hit = hitAt(x, y);
    if (!hit) return;
    const ck = clipKey();
    if (hit.kind === 'pose') {
      deletePose(hit.row.shape, ck, hit.t);
    } else {
      const k = hit.row.keys.indexOf(hit.key);
      if (k >= 0) deleteKeyframe(hit.row.shape, ck, hit.row.prop, k);
    }
    if (ctx.selectedKeyframe && samePath(ctx.selectedKeyframe.path, hit.row.path)) ctx.selectedKeyframe = null;
    ctx.markDirty(); refresh();
  }

  function onDblClick(e) {
    const { x, y } = pos(e);
    const i = rowAt(y); if (i < 0 || x < GUTTER) return;
    const row = rows[i];
    const ck = clipKey();
    const t = Math.round(Math.max(0, Math.min(duration(), timeAt(x))));
    if (row.kind === 'part') {
      // Key the pose: tracked channels get a non-disturbing key (sampled value);
      // an unkeyed part bootstraps from its current base values.
      ensureClip(art(), ck);
      keyPose(row.shape, ck, t, (prop) => {
        const tr = getTrack(row.shape, ck, prop);
        const v = tr ? sampleTrack(tr, t) : getPropValue(row.shape, prop);
        return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
      });
    } else {
      const v = sampleTrack(getTrack(row.shape, ck, row.prop), t);
      setKeyframe(row.shape, ck, row.prop, t, v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);
    }
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
    } else if (maxScrollY() > 0) {
      e.preventDefault(); scrollY += e.deltaY; clampY(); redraw();
    }
  }

  // Snap a dragged time to clip ends + a shape's other pose times.
  function snapTimeForShape(t, shape, excludeT) {
    const targets = [0, duration()];
    const tracks = shape.anim && shape.anim[clipKey()];
    if (tracks) for (const prop of Object.keys(tracks)) {
      for (const k of tracks[prop]) if (Math.abs(k.t - excludeT) > 1) targets.push(k.t);
    }
    return snapToTargets(t, targets);
  }
  function snapTimeForKeys(t, keys, exclude) {
    const targets = [0, duration()];
    for (const k of keys) if (k !== exclude) targets.push(k.t);
    return snapToTargets(t, targets);
  }
  function snapToTargets(t, targets) {
    let best = t, bestPx = 8;
    for (const tg of targets) { const d = Math.abs(xAt(tg) - xAt(t)); if (d < bestPx) { bestPx = d; best = tg; } }
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
    if (art() !== lastArt) { expanded.clear(); lastArt = art(); }
    if (!ctx.keyTargetClip || !clipKeyValid(ctx.keyTargetClip)) ctx.keyTargetClip = defaultClip();
    rows = clipMeta(art(), clipKey()) ? buildRows() : [];
    clampY();
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
  /** Lightweight re-list + redraw (no resize/bar rebuild) — used after a props-panel
   *  edit so an auto-keyed diamond appears live without the cost of a full refresh. */
  function redrawRows() {
    if (!art() || !clipMeta(art(), clipKey())) return;
    rows = buildRows(); clampY(); redraw();
  }
  /** Advance the playhead while playing (called from the preview tick). */
  function advance(dtMs) {
    const clip = clipMeta(art(), clipKey()); if (!clip) return;
    let p = (ctx.playhead || 0) + dtMs;
    if (clip.loop !== false) { p %= clip.duration; if (p < 0) p += clip.duration; }
    else p = Math.min(p, clip.duration);
    ctx.playhead = p;
    if (timeReadout) timeReadout.textContent = `${Math.round(p)}ms`;
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
  return { el, refresh, redraw, redrawRows, advance, destroy };
}

// ── helpers ──
const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));
const clip2 = (s, n = 12) => trunc(String(s), n);
function niceStep(dur, px) {
  const target = Math.max(40, px / 8);
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
  .kf-transport{display:flex;align-items:center;gap:5px;padding:3px 6px;flex-wrap:wrap;flex-shrink:0;border-bottom:1px solid #1a2230}
  .kf-canvas-wrap{position:relative;flex:1 1 auto;min-height:0;overflow:hidden}
  .kf-canvas{display:block;cursor:crosshair}
  .kf-dur{color:#7a8aa0;font-size:11px;display:inline-flex;align-items:center;gap:3px}
  .kf-dur input{width:52px;background:#11161f;border:1px solid #2a3a4a;color:#cdd6e4;font-size:11px;padding:1px 4px;border-radius:3px}
  .kf-unit{color:#5f7088;font-size:10px}
  .kf-time{color:#7a8aa0;font-size:11px;font-family:monospace}
  .kf-keyseg{display:inline-flex;align-items:center;gap:3px}
  .kf-seglabel{color:#7a8aa0;font-size:11px}
  .kf-segbtn{background:#11161f;border:1px solid #2a3a4a;color:#9fb0c4;font-size:11px;padding:1px 7px;border-radius:3px;cursor:pointer}
  .kf-segbtn:hover{border-color:#3a4a5e}
  .kf-segbtn.active{background:#1c2636;border-color:#d4a056;color:#d4a056}
  .kf-armed{color:#e0543a;font-size:10px;font-weight:bold;font-family:monospace}
  .kf-hint{color:#4a5a70;font-size:9px;margin-left:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  `;
  document.head.appendChild(s);
}
