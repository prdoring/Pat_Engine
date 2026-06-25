/**
 * Generic entity loop manager — tracks positional audio loops for entities
 * that appear and disappear each frame (remote players, torpedoes, rockets).
 *
 * Pattern: each frame, call updateEntity() for every live entity, then
 * call cleanupStale() to stop loops for entities that disappeared.
 */
export class EntityLoopManager {
  constructor(soundManager) {
    this.sound = soundManager;
    /** @type {Map<string, number>} entityId → loopHandle */
    this.loops = new Map();
    /** @type {Set<string>} entities seen this frame */
    this._activeIds = new Set();
  }

  /** Mark start of a new frame. Call before updateEntity(). */
  beginFrame() {
    this._activeIds.clear();
  }

  /**
   * Start or update a loop for an entity.
   * @param {string} id - entity identifier
   * @param {string} soundId - SoundId enum value
   * @param {number} x - world X
   * @param {number} y - world Y
   * @param {object} [opts] - { volume, range, playbackRate, fadeIn }
   */
  updateEntity(id, soundId, x, y, opts) {
    this._activeIds.add(id);

    if (this.loops.has(id)) {
      this.sound.updateLoop(this.loops.get(id), x, y, opts);
    } else {
      const handle = this.sound.startLoop(soundId, x, y, opts);
      if (handle) this.loops.set(id, handle);
    }
  }

  /**
   * Stop loop for an entity that should no longer be playing.
   * @param {string} id - entity identifier
   * @param {object} [opts] - { fadeOut }
   */
  stopEntity(id, opts) {
    const handle = this.loops.get(id);
    if (handle) {
      this.sound.stopLoop(handle, opts);
      this.loops.delete(id);
    }
  }

  /**
   * Stop loops for all entities not seen this frame.
   * Call after all updateEntity() calls.
   * @param {object} [opts] - { fadeOut }
   */
  cleanupStale(opts) {
    for (const [id, handle] of this.loops) {
      if (!this._activeIds.has(id)) {
        this.sound.stopLoop(handle, opts);
        this.loops.delete(id);
      }
    }
  }

  /** Stop all loops and clear tracking. */
  stopAll() {
    for (const [, handle] of this.loops) {
      if (handle) this.sound.stopLoop(handle);
    }
    this.loops.clear();
    this._activeIds.clear();
  }

  /** Check if an entity has an active loop. */
  has(id) {
    return this.loops.has(id);
  }

  /** Number of active loops. */
  get size() {
    return this.loops.size;
  }
}
