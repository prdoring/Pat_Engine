// Browser WebSocket client with handler-map dispatch. Generalized from Sub Game's
// NetworkClient (whose dispatch was a hardcoded switch over submarine message
// types). Here you register handlers by message type: client.on('STATE', fn).
//
// OPTIONAL engine module — not used by the Critter Garden example. See net/README.md.

import { serialize, deserialize } from './protocol.js';

export class NetworkClient {
  /**
   * @param {string} [url] - ws:// URL. Defaults to same-host ws on the page port.
   */
  constructor(url) {
    this.url = url || (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    this.ws = null;
    this.connected = false;
    this.handlers = new Map();   // type -> fn[]
    this.lifecycle = {};         // { open, close, reconnect }
    this.reconnectDelay = 1000;
    this._shouldReconnect = true;
  }

  /** Register a handler for a message type. Returns this for chaining. */
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }

  /** Lifecycle hooks: onOpen/onClose/onReconnect. */
  onOpen(fn) { this.lifecycle.open = fn; return this; }
  onClose(fn) { this.lifecycle.close = fn; return this; }
  onReconnect(fn) { this.lifecycle.reconnect = fn; return this; }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      const wasDown = !this.connected;
      this.connected = true;
      this.lifecycle.open?.();
      if (wasDown && this._everConnected) this.lifecycle.reconnect?.();
      this._everConnected = true;
    };
    this.ws.onmessage = (e) => {
      let msg;
      try { msg = deserialize(e.data); } catch { return; }
      const fns = this.handlers.get(msg.type);
      if (fns) for (const fn of fns) fn(msg);
    };
    this.ws.onclose = () => {
      this.connected = false;
      this.lifecycle.close?.();
      if (this._shouldReconnect) setTimeout(() => this.connect(), this.reconnectDelay);
    };
    this.ws.onerror = () => { try { this.ws.close(); } catch {} };
    return this;
  }

  /** Send a message object (must have a `type`). */
  send(message) {
    if (this.ws && this.connected) this.ws.send(serialize(message));
  }

  close() {
    this._shouldReconnect = false;
    if (this.ws) this.ws.close();
  }
}
