// Themed, Promise-based replacements for window.alert / confirm / prompt, plus a
// data-populated selector. Self-contained (inject their own CSS, no widget deps).
// While any modal is open, isModalOpen() is true so editors can suppress global
// shortcuts (Space, Delete).

let _modalOpen = 0;
export function isModalOpen() { return _modalOpen > 0; }

function mk(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
/** A themed modal button. Exported so editors can compose custom dialogs via openModal(). */
export function modalBtn(label, variant, onClick) { const b = mk('button', 'editor-modal-btn' + (variant ? ' ' + variant : ''), label); b.addEventListener('click', onClick); return b; }
/** A right-aligned row of modal buttons. */
export function btnRow(...kids) { const r = mk('div', 'editor-modal-btns'); kids.forEach(k => r.appendChild(k)); return r; }

function injectModalStyle() {
  if (document.getElementById('editor-modal-style')) return;
  const s = mk('style'); s.id = 'editor-modal-style';
  s.textContent = `
  .editor-modal-overlay{position:fixed;inset:0;background:var(--ed-modal-overlay);display:flex;align-items:center;justify-content:center;z-index:1000}
  .editor-modal{background:var(--ed-modal-bg);border:1px solid var(--ed-modal-border);border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,0.55);min-width:300px;max-width:min(540px,92vw);max-height:84vh;overflow:auto;padding:16px;font:13px system-ui,sans-serif;color:var(--ed-modal-text)}
  .editor-modal-title{font-size:14px;font-weight:600;color:var(--ed-modal-title);margin-bottom:10px}
  .editor-modal-msg{color:var(--ed-modal-msg);font-size:13px;margin-bottom:12px;white-space:pre-wrap;line-height:1.45}
  .editor-modal-input{width:100%;box-sizing:border-box;background:var(--ed-modal-field-bg);color:var(--ed-modal-field-fg);border:1px solid var(--ed-modal-border);border-radius:4px;padding:8px 10px;font:13px 'Courier New',monospace;margin-bottom:4px}
  .editor-modal-input:focus{border-color:var(--ed-modal-focus);outline:none}
  .editor-modal-textarea{width:100%;box-sizing:border-box;background:var(--ed-modal-field-bg);color:var(--ed-modal-field-fg);border:1px solid var(--ed-modal-border);border-radius:4px;padding:8px 10px;font:12px 'Courier New',monospace;line-height:1.4;resize:vertical;min-height:120px}
  .editor-modal-textarea:focus{border-color:var(--ed-modal-focus);outline:none}
  .editor-modal-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0}
  .editor-modal-label{color:var(--ed-modal-label);font-size:12px}
  .editor-modal-error{color:var(--ed-error);font-size:11px;min-height:14px;margin-bottom:6px}
  .editor-modal-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
  .editor-modal-btn{padding:6px 16px;border-radius:4px;font:13px system-ui,sans-serif;cursor:pointer;border:1px solid var(--ed-modal-border);background:var(--ed-modal-btn-bg);color:var(--ed-modal-msg)}
  .editor-modal-btn.primary{background:var(--ed-modal-primary-bg);border-color:var(--ed-modal-primary-border);color:var(--ed-modal-primary-fg);font-weight:600}
  .editor-modal-btn.danger{background:var(--ed-modal-danger-bg);border-color:var(--ed-modal-danger-border);color:var(--ed-modal-danger-fg);font-weight:600}
  .editor-modal-btn:focus{outline:2px solid var(--ed-modal-focus);outline-offset:1px}
  .editor-modal-list{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;max-height:54vh;overflow:auto}
  .editor-modal-item{text-align:left;background:var(--ed-modal-field-bg);border:1px solid var(--ed-modal-border2);border-radius:4px;padding:8px 10px;color:var(--ed-modal-text);cursor:pointer;font:13px system-ui,sans-serif;display:flex;justify-content:space-between;align-items:center;gap:10px}
  .editor-modal-item:hover,.editor-modal-item:focus{border-color:var(--ed-modal-focus);background:var(--ed-modal-item-hover-bg);outline:none}
  .editor-modal-item-sub{color:var(--ed-modal-label);font-size:11px;font-family:'Courier New',monospace}
  `;
  document.head.appendChild(s);
}

/**
 * Open a modal. `render(box, close)` fills the dialog and may return `{ onEnter }`.
 * Escape / backdrop click resolve with `cancelValue`. Exported so editors can build
 * bespoke themed dialogs (combined with modalBtn / btnRow) beyond the prompt/select helpers.
 */
export function openModal({ title = '', render, cancelValue }) {
  injectModalStyle();
  _modalOpen++;
  return new Promise((resolve) => {
    const overlay = mk('div', 'editor-modal-overlay');
    const box = mk('div', 'editor-modal');
    overlay.appendChild(box);
    let settled = false;
    const close = (val) => {
      if (settled) return; settled = true;
      _modalOpen = Math.max(0, _modalOpen - 1);
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(val);
    };
    if (title) box.appendChild(mk('div', 'editor-modal-title', title));
    const api = render(box, close) || {};
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(cancelValue); });
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(cancelValue); }
      else if (e.key === 'Enter' && api.onEnter) { e.preventDefault(); e.stopPropagation(); api.onEnter(); }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
  });
}

/** Notify the user. Resolves when dismissed. */
export function modalAlert(message, { title = '', okLabel = 'OK' } = {}) {
  return openModal({
    title, cancelValue: undefined,
    render(box, close) {
      box.appendChild(mk('div', 'editor-modal-msg', message));
      const ok = modalBtn(okLabel, 'primary', () => close());
      box.appendChild(btnRow(ok));
      setTimeout(() => ok.focus(), 0);
      return { onEnter: () => close() };
    },
  });
}

/** Ask the user to confirm. Resolves to true/false. */
export function modalConfirm(message, { title = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return openModal({
    title, cancelValue: false,
    render(box, close) {
      box.appendChild(mk('div', 'editor-modal-msg', message));
      const ok = modalBtn(confirmLabel, danger ? 'danger' : 'primary', () => close(true));
      box.appendChild(btnRow(modalBtn(cancelLabel, '', () => close(false)), ok));
      setTimeout(() => ok.focus(), 0);
      return { onEnter: () => close(true) };
    },
  }).then(v => v === true);
}

/**
 * Prompt for text. Resolves to the trimmed string, or null if cancelled.
 * `validate(value)` may return an error string to block submission.
 */
export function modalPrompt(message, { title = '', value = '', placeholder = '', confirmLabel = 'OK', validate = null } = {}) {
  return openModal({
    title, cancelValue: null,
    render(box, close) {
      if (message) box.appendChild(mk('div', 'editor-modal-msg', message));
      const input = mk('input', 'editor-modal-input'); input.type = 'text'; input.value = value; input.placeholder = placeholder;
      const err = mk('div', 'editor-modal-error');
      box.appendChild(input); box.appendChild(err);
      const submit = () => {
        const v = input.value.trim();
        if (validate) { const m = validate(v); if (m) { err.textContent = m; return; } }
        close(v);
      };
      box.appendChild(btnRow(modalBtn('Cancel', '', () => close(null)), modalBtn(confirmLabel, 'primary', submit)));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      setTimeout(() => { input.focus(); input.select(); }, 0);
      return { onEnter: submit };
    },
  });
}

/**
 * Pick one option from a (data-populated) list. `options` = [{ value, label, sub? }].
 * Resolves to the chosen value, or null if cancelled.
 */
export function modalSelect(message, options, { title = '' } = {}) {
  return openModal({
    title, cancelValue: null,
    render(box, close) {
      if (message) box.appendChild(mk('div', 'editor-modal-msg', message));
      const list = mk('div', 'editor-modal-list');
      for (const opt of options) {
        const item = mk('button', 'editor-modal-item');
        item.appendChild(mk('span', null, opt.label));
        if (opt.sub != null) item.appendChild(mk('span', 'editor-modal-item-sub', String(opt.sub)));
        item.addEventListener('click', () => close(opt.value));
        list.appendChild(item);
      }
      box.appendChild(list);
      box.appendChild(btnRow(modalBtn('Cancel', '', () => close(null))));
      setTimeout(() => list.querySelector('.editor-modal-item')?.focus(), 0);
    },
  });
}
