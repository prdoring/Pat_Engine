// Game bootstrap — the reusable runtime shell extracted from Sub Game's main.js.
// Owns: canvas sizing, the requestAnimationFrame loop, scene routing, global
// input routing to the active scene, audio-resume-on-first-interaction, and the
// volume overlay. Knows nothing about any specific game.

import { resetCanvasState } from './canvasUtils.js';
import { VolumeControl } from './VolumeControl.js';

export class Game {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.canvas
   * @param {object} [opts.sound]      - SoundManager-like (resume/isMuted/... ). Enables audio-resume + volume overlay.
   * @param {object} [opts.background] - has draw(now); drawn under the scene each frame.
   * @param {string} [opts.clearColor] - filled each frame before the background; transparent clear if omitted.
   * @param {boolean} [opts.autoResize=true] - track window size onto the canvas.
   * @param {() => {top:number,right:number,bottom:number,left:number}} [opts.safeInsets]
   *        - device safe-area margins (notch / home indicator) so overlays stay clear of them.
   */
  constructor({ canvas, sound = null, background = null, clearColor = null, autoResize = true, safeInsets = null }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sound = sound;
    this.background = background;
    this.clearColor = clearColor;
    this.current = null;
    this.volume = sound ? new VolumeControl(sound, canvas, { getInsets: safeInsets }) : null;
    this._running = false;
    this._frame = this._frame.bind(this);

    this.dpr = 1;
    if (autoResize) {
      const resize = () => {
        // Backing store at device resolution (capped) so neon vector art and text
        // stay crisp on HiDPI phones; CSS size + pointer offsetX/Y stay logical px.
        this.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
        const w = window.innerWidth, h = window.innerHeight;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        canvas.width = Math.round(w * this.dpr);
        canvas.height = Math.round(h * this.dpr);
      };
      resize();
      window.addEventListener('resize', resize);
    }

    this._wireInput();
    if (sound) this._wireAudioResume();
  }

  /** Switch scenes: exit the old, enter the new with optional data. Both are
   * guarded so a scene whose enter()/exit() throws can't break the frame loop or
   * leave the game wedged mid-switch. */
  setScene(scene, data) {
    if (this.current) {
      try { this.current.exit(); } catch (err) { console.error('Scene exit error:', err); }
    }
    this.current = scene;
    if (scene) {
      try { scene.enter(data); } catch (err) { console.error('Scene enter error:', err); }
    }
  }

  /** Begin the frame loop (optionally setting the first scene). */
  start(scene, data) {
    if (scene) this.setScene(scene, data);
    if (this._running) return;
    this._running = true;
    requestAnimationFrame(this._frame);
  }

  stop() { this._running = false; }

  _frame(now) {
    if (!this._running) return;
    const { ctx, canvas } = this;

    // The entire frame body is guarded so a throw anywhere (clear/fill,
    // background, scene, or volume overlay) can never freeze the loop — the
    // reschedule lives in `finally` and always runs while the game is running.
    try {
      // Clear in raw device space, then draw everything in logical CSS-px space
      // (scaled by dpr) so scenes work in offsetX/Y coordinates regardless of HiDPI.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (this.clearColor) { ctx.fillStyle = this.clearColor; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      if (this.background) this.background.draw(now);

      if (this.current) {
        try { this.current.update(now); }
        catch (err) { console.error('Scene update error:', err); resetCanvasState(ctx); }
        try { this.current.render(now); }
        catch (err) { console.error('Scene render error:', err); resetCanvasState(ctx); }
      }

      if (this.volume) this.volume.draw(ctx);
    } catch (err) {
      console.error('Frame error:', err);
      resetCanvasState(ctx);
    } finally {
      if (this._running) requestAnimationFrame(this._frame);
    }
  }

  // ─── Input routing ───────────────────────────────────────────────
  // Pointer Events unify mouse + touch + pen, so one set of listeners drives the
  // scene on every device. They subsume mouse events (no separate mouse listeners
  // → no synthetic double-fire on touch). offsetX/Y are logical CSS px, matching
  // the dpr-scaled draw space, so scene hit-tests need no conversion.
  _wireInput() {
    const { canvas } = this;
    canvas.style.touchAction = 'none'; // touch drags shouldn't scroll/zoom the page
    // Every input handler routes into game/scene code (button taps send network
    // messages, etc.). Guard each so a throw in a handler can't bubble out of the
    // DOM event listener and leave input in a broken state.
    const guard = (fn) => { try { fn(); } catch (err) { console.error('Input handler error:', err); } };
    window.addEventListener('keydown', e => guard(() => this.current?.onKeydown(e)));
    window.addEventListener('keyup', e => guard(() => this.current?.onKeyup(e)));
    canvas.addEventListener('pointermove', e => guard(() => {
      this.volume?.onMousemove(e.offsetX, e.offsetY);
      this.current?.onMousemove(e.offsetX, e.offsetY);
    }));
    canvas.addEventListener('pointerdown', e => guard(() => {
      // Capture so a drag (e.g. a slider) keeps getting move/up even if
      // the pointer slides off the element.
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      if (this.volume?.onMousedown(e.offsetX, e.offsetY)) return; // consumed by overlay
      this.current?.onMousedown(e.offsetX, e.offsetY);
    }));
    const up = e => guard(() => {
      try { canvas.releasePointerCapture(e.pointerId); } catch {}
      this.volume?.onMouseup();
      this.current?.onMouseup(e.offsetX, e.offsetY);
    });
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up); // interrupted touch → reset drag state
    canvas.addEventListener('wheel', e => {
      e.preventDefault(); // don't scroll the page
      guard(() => this.current?.onWheel(e.deltaY, e.offsetX, e.offsetY));
    }, { passive: false });
    // Don't pop the browser context menu over the canvas on right-click / long-press.
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }

  // ─── Audio resume (browser autoplay policy) ──────────────────────
  // Must listen for `pointerdown`, not `mousedown`: on touch devices with
  // touch-action:none + pointer capture the synthetic mousedown is unreliable, so
  // a mousedown-only resume would leave audio silent on phones.
  _wireAudioResume() {
    const resume = () => {
      this.sound.resume();
      this.canvas.removeEventListener('pointerdown', resume);
      window.removeEventListener('keydown', resume);
    };
    this.canvas.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
  }
}
