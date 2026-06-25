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
   */
  constructor({ canvas, sound = null, background = null, clearColor = null, autoResize = true }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sound = sound;
    this.background = background;
    this.clearColor = clearColor;
    this.current = null;
    this.volume = sound ? new VolumeControl(sound, canvas) : null;
    this._running = false;
    this._frame = this._frame.bind(this);

    if (autoResize) {
      const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
      resize();
      window.addEventListener('resize', resize);
    }

    this._wireInput();
    if (sound) this._wireAudioResume();
  }

  /** Switch scenes: exit the old, enter the new with optional data. */
  setScene(scene, data) {
    if (this.current) this.current.exit();
    this.current = scene;
    if (scene) scene.enter(data);
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
      if (this.clearColor) { ctx.fillStyle = this.clearColor; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      else ctx.clearRect(0, 0, canvas.width, canvas.height);

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
  _wireInput() {
    const { canvas } = this;
    window.addEventListener('keydown', e => this.current?.onKeydown(e));
    window.addEventListener('keyup', e => this.current?.onKeyup(e));
    canvas.addEventListener('mousemove', e => {
      this.volume?.onMousemove(e.offsetX, e.offsetY);
      this.current?.onMousemove(e.offsetX, e.offsetY);
    });
    canvas.addEventListener('mousedown', e => {
      if (this.volume?.onMousedown(e.offsetX, e.offsetY)) return; // consumed by overlay
      this.current?.onMousedown(e.offsetX, e.offsetY);
    });
    canvas.addEventListener('mouseup', e => {
      this.volume?.onMouseup();
      this.current?.onMouseup(e.offsetX, e.offsetY);
    });
    canvas.addEventListener('wheel', e => {
      e.preventDefault(); // don't scroll the page
      this.current?.onWheel(e.deltaY, e.offsetX, e.offsetY);
    }, { passive: false });
    // Don't pop the browser context menu over the canvas on right-click.
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }

  // ─── Audio resume (browser autoplay policy) ──────────────────────
  _wireAudioResume() {
    const resume = () => {
      this.sound.resume();
      this.canvas.removeEventListener('mousedown', resume);
      window.removeEventListener('keydown', resume);
    };
    this.canvas.addEventListener('mousedown', resume);
    window.addEventListener('keydown', resume);
  }
}
