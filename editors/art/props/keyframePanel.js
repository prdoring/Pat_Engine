// Keyframe controls for the art editor's shape property panel: the Auto-key
// toggle, the one-click "Key part" snapshot at the playhead, per-channel
// key/loop/clear, and the guided looping-motion generator. Split out of props.js.
// Keyframe writes target the raw shape; reads use the anim proxy's effective
// (sampled-or-base) values.

import { ctx } from '../ctx.js';
import { PropertyGroup, Toggle, Button, Select, NumberSlider } from '/editors/shared/index.js';
import {
  keyframeableProps, getPropValue, getTrack, setKeyframe, deleteTrack, ensureClip, makeLoopable, clipMeta, keyPose,
} from '../model/keyframes.js';

const _kfCloneVal = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

/** Bump a value's dominant term by `amount` (for the guided looping generator). */
function _kfBump(v, amount) {
  if (typeof v === 'number') return v + amount;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const term = ('base' in v) ? 'base' : 'r';
    return { ...v, [term]: (v[term] || 0) + amount };
  }
  return v;
}

/**
 * Keyframe controls for the selected shape. The headline flow is AUTO-KEY: with
 * Auto-key ON, scrubbing the timeline and tweaking this part writes keyframes (done
 * transparently by the anim proxy in buildShapeProps). This panel surfaces the
 * toggle, a single "Key part" snapshot button, and — under a collapsed "Advanced
 * channels" disclosure — per-property keying / clear and the guided looping-motion
 * generator. `shape` is the anim proxy (effective sampled-or-base values); keyframe
 * writes target `rawShape`.
 */
export function buildKeyframePanel(parent, rawShape, shape, onDirty) {
  if (!rawShape) return;
  const props = keyframeableProps(rawShape);
  if (!props.length) return;
  const art = ctx.currentArt;
  const clipKey = ctx.keyTargetClip || '*';
  const clipLabel = clipKey === '*' ? 'Always (every state)' : clipKey;
  const t = Math.round(ctx.playhead || 0);
  const partName = rawShape.name || rawShape.type || 'part';

  const group = PropertyGroup(`Keyframes → ${clipLabel}`);

  // Headline: Auto-key toggle + a one-click "Key part" snapshot at the playhead.
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 4px;';
  head.appendChild(Toggle('Auto-key', ctx.autoKey, (v) => {
    ctx.autoKey = v; ctx.rebuildProps?.(); ctx.rebuildTimeline?.();
  }).el);
  const keyBtn = Button(`◆ Key ${partName.slice(0, 12)} @ ${t}ms`, () => {
    ensureClip(art, clipKey);
    keyPose(rawShape, clipKey, ctx.playhead || 0, (prop) => _kfCloneVal(getPropValue(shape, prop)));
    onDirty(); ctx.rebuildTimeline?.(); ctx.rebuildProps?.();
  }, 'primary');
  keyBtn.el.title = 'Snapshot this part’s animated channels (or every channel, first time) as a keyframe at the playhead';
  head.appendChild(keyBtn.el);
  group.body.appendChild(head);

  const hint = document.createElement('div');
  hint.style.cssText = 'color:#5a4a30;font-size:9px;padding:1px 4px;';
  hint.textContent = ctx.autoKey
    ? 'Auto-key ON · scrub the timeline, then tweak this part — each change keys at the playhead.'
    : 'Auto-key OFF · edits change the base value. Use “Key part” or the channels below to key.';
  group.body.appendChild(hint);

  // Advanced channels: per-property key / loop / clear + the guided generator.
  const adv = PropertyGroup('Advanced channels');
  for (const p of props) {
    const track = getTrack(rawShape, clipKey, p.prop);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:1px 4px;font-size:11px;';
    const lbl = document.createElement('span');
    lbl.style.cssText = `flex:1;color:${track ? '#d4a056' : '#8a7a5a'};`;
    lbl.textContent = p.label + (track ? `  ◆${track.length}` : '');
    row.appendChild(lbl);
    if (track) {
      const loopBtn = Button('loop', () => {
        const clip = clipMeta(art, clipKey);
        makeLoopable(rawShape, clipKey, p.prop, clip ? clip.duration : 2000);
        onDirty(); ctx.rebuildTimeline?.(); ctx.rebuildProps?.();
      }, 'subtle');
      loopBtn.el.title = 'Copy the first key to t=end (seamless loop)';
      loopBtn.el.style.cssText += 'font-size:9px;padding:1px 5px;';
      row.appendChild(loopBtn.el);
      const clrBtn = Button('✕', () => {
        deleteTrack(rawShape, clipKey, p.prop);
        onDirty(); ctx.rebuildTimeline?.(); ctx.rebuildProps?.();
      }, 'subtle');
      clrBtn.el.title = 'Delete this channel’s track';
      clrBtn.el.className += ' editor-btn-danger';
      clrBtn.el.style.cssText += 'font-size:9px;padding:1px 5px;';
      row.appendChild(clrBtn.el);
    }
    const keyBtn2 = Button('◆ key', () => {
      ensureClip(art, clipKey);
      const v = getPropValue(shape, p.prop); // effective (sampled-or-base) value
      setKeyframe(rawShape, clipKey, p.prop, Math.round(ctx.playhead || 0), _kfCloneVal(v ?? 0));
      onDirty(); ctx.rebuildTimeline?.(); ctx.rebuildProps?.();
    }, 'subtle');
    keyBtn2.el.title = `Set a keyframe for ${p.label} at the playhead`;
    keyBtn2.el.style.cssText += 'font-size:9px;padding:1px 6px;color:#d4a056;';
    row.appendChild(keyBtn2.el);
    adv.body.appendChild(row);
  }

  // Guided generator: a one-click looping motion (min → max → min, easeInOutSine).
  const gen = document.createElement('div');
  gen.style.cssText = 'border-top:1px solid #2a2a3a;margin-top:4px;padding-top:4px;';
  let genIdx = 0, amount = 0.1, periodSec = 2;
  gen.appendChild(Select('Add motion', props.map((p, i) => ({ value: String(i), label: p.label })), '0', v => { genIdx = +v; }).el);
  gen.appendChild(NumberSlider('Amount (±)', 0.01, 2, 0.01, amount, v => { amount = v; }).el);
  gen.appendChild(NumberSlider('Period (s)', 0.2, 12, 0.1, periodSec, v => { periodSec = v; }).el);
  gen.appendChild(Button('Add looping motion', () => {
    const target = props[genIdx];
    const durMs = Math.round(periodSec * 1000);
    const existing = clipMeta(art, clipKey);
    ensureClip(art, clipKey, { duration: existing ? existing.duration : durMs });
    const dur = clipMeta(art, clipKey).duration;
    const base = getPropValue(shape, target.prop) ?? (target.kind === 'coord' ? { base: 0 } : 0);
    const peak = _kfBump(_kfCloneVal(base), amount);
    setKeyframe(rawShape, clipKey, target.prop, 0, _kfCloneVal(base), 'easeInOutSine');
    setKeyframe(rawShape, clipKey, target.prop, Math.round(dur / 2), peak, 'easeInOutSine');
    setKeyframe(rawShape, clipKey, target.prop, dur, _kfCloneVal(base), 'easeInOutSine');
    onDirty(); ctx.rebuildTimeline?.(); ctx.rebuildProps?.();
  }, 'primary').el);
  adv.body.appendChild(gen);

  // Start the Advanced disclosure collapsed (it's the de-emphasized path).
  adv.el.querySelector('.editor-prop-group-header')?.click();
  group.body.appendChild(adv.el);

  parent.appendChild(group.el);
}
