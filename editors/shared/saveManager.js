// SaveManager — dirty-state tracking + save button/status wiring + POST /api/save-data.
// Self-contained (browser fetch + DOM only). Used by every editor tab.

export class SaveManager {
  constructor(filename) {
    this._filename = filename;
    this._dirty = false;
    this._onDirtyChange = [];
    this._statusEl = null;
    this._saveBtn = null;
  }

  markDirty() {
    if (!this._dirty) {
      this._dirty = true;
      this._notify();
    }
  }

  markClean() {
    if (this._dirty) {
      this._dirty = false;
      this._notify();
    }
  }

  isDirty() { return this._dirty; }

  onDirtyChange(fn) { this._onDirtyChange.push(fn); }

  _notify() {
    this._onDirtyChange.forEach(fn => fn(this._dirty));
    if (this._statusEl) {
      this._statusEl.textContent = this._dirty ? 'Unsaved' : 'Saved';
      this._statusEl.style.color = this._dirty ? 'var(--ed-danger)' : 'var(--ed-success)';
    }
    if (this._saveBtn) {
      this._saveBtn.style.opacity = this._dirty ? '1' : '0.4';
    }
  }

  async save(data) {
    const resp = await fetch('/api/save-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: this._filename, data }),
    });
    const result = await resp.json();
    if (!resp.ok || !result.ok) throw new Error(result.error || 'Save failed');
    this.markClean();
    return result;
  }

  getSaveButton(onSave) {
    const btn = document.createElement('button');
    btn.className = 'editor-btn editor-btn-primary';
    btn.textContent = 'Save';
    btn.style.opacity = this._dirty ? '1' : '0.4';
    btn.addEventListener('click', () => onSave());
    this._saveBtn = btn;
    return btn;
  }

  getStatusIndicator() {
    const el = document.createElement('span');
    el.className = 'editor-save-status';
    el.textContent = this._dirty ? 'Unsaved' : 'Saved';
    el.style.color = this._dirty ? 'var(--ed-danger)' : 'var(--ed-success)';
    this._statusEl = el;
    return el;
  }
}
