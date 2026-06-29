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
    // Exponential backoff with jitter so a downed server isn't hammered ~1×/sec
    // forever (that churn pegs the CPU and floods the console). Reset on connect.
    this._reconnectBase = 1000;
    this._reconnectMax = 20000;
    this.reconnectDelay = this._reconnectBase;
    this._reconnectTimer = null;
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
    try { this.ws = new WebSocket(this.url); }
    catch (err) { console.error('WebSocket construct failed:', err); this._scheduleReconnect(); return this; }
    this.ws.onopen = () => {
      const wasDown = !this.connected;
      this.connected = true;
      this.reconnectDelay = this._reconnectBase; // recovered → reset backoff
      try { this.lifecycle.open?.(); } catch (err) { console.error('onOpen handler error:', err); }
      if (wasDown && this._everConnected) { try { this.lifecycle.reconnect?.(); } catch (err) { console.error('onReconnect handler error:', err); } }
      this._everConnected = true;
    };
    this.ws.onmessage = (e) => {
      let msg;
      try { msg = deserialize(e.data); } catch { return; }
      const fns = this.handlers.get(msg.type);
      // Guard each handler so one throwing (e.g. a scene enter() failing during a
      // phase switch) can't tear down the socket or skip the remaining handlers.
      if (fns) for (const fn of fns) { try { fn(msg); } catch (err) { console.error('Net handler error for', msg.type, err); } }
    };
    this.ws.onclose = () => {
      this.connected = false;
      try { this.lifecycle.close?.(); } catch (err) { console.error('onClose handler error:', err); }
      this._scheduleReconnect();
    };
    this.ws.onerror = () => { try { this.ws.close(); } catch {} };
    return this;
  }

  _scheduleReconnect() {
    if (!this._shouldReconnect || this._reconnectTimer) return;
    const jitter = 0.75 + Math.random() * 0.5;             // ±25% so many clients don't sync up
    const delay = Math.min(this._reconnectMax, this.reconnectDelay) * jitter;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectDelay = Math.min(this._reconnectMax, this.reconnectDelay * 2);
  }

  /** Send a message object (must have a `type`). No-op (not an error) when down —
   * the client reconciles on the next snapshot after reconnect. */
  send(message) {
    if (this.ws && this.connected) {
      try { this.ws.send(serialize(message)); } catch (err) { console.error('Net send failed:', err); }
    }
  }

  close() {
    this._shouldReconnect = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch {} }
  }
}
