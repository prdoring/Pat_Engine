// Pure, DOM-free undo/redo history for the art editor (unit-tested in Node).
//
// Snapshot model matches the music editor's convention: the undo stack holds a
// running history of snapshots whose TOP is the current state. A commit pushes a
// fresh snapshot (deduped — identical consecutive states are skipped); undo moves
// the top to the redo stack and returns the new top to restore. The DOM wiring
// (what a snapshot contains, how it is restored in place, when commits fire) lives
// in artEditor.js — this module only owns the stack bookkeeping.

export function createHistory({ limit = 80, equals = defaultEquals } = {}) {
  let undo = [];
  let redo = [];

  return {
    /** Seed the history with the current state (clears redo). */
    init(snapshot) { undo = [snapshot]; redo = []; },

    /** Push a new current state. Returns false if it equals the current top. */
    push(snapshot) {
      if (undo.length && equals(undo[undo.length - 1], snapshot)) return false;
      undo.push(snapshot);
      if (undo.length > limit) undo.shift();
      redo = [];
      return true;
    },

    canUndo() { return undo.length > 1; },
    canRedo() { return redo.length > 0; },

    /** Step back one state. Returns the snapshot to restore, or null. */
    undo() {
      if (undo.length <= 1) return null;
      redo.push(undo.pop());
      return undo[undo.length - 1];
    },

    /** Step forward one state. Returns the snapshot to restore, or null. */
    redo() {
      if (!redo.length) return null;
      const s = redo.pop();
      undo.push(s);
      return s;
    },

    /** The current (top) snapshot, or null when empty. */
    current() { return undo.length ? undo[undo.length - 1] : null; },

    /** Counts, for buttons / tests. */
    sizes() { return { undo: undo.length, redo: redo.length }; },
  };
}

function defaultEquals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
