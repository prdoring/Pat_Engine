// Generic, game-agnostic WebSocket room host. Manages rooms keyed by short codes,
// per-connection identities + reconnect tokens, a host role, room lifecycle
// (empty-room TTL teardown + a single game timer per room + an absolute age cap),
// and a liveness heartbeat. It knows NOTHING about any specific game: each room
// delegates to an injected "room logic" object, and `member.data` is an opaque bag
// the game owns (RoomServer never reads it). This opacity is the layering firewall
// — nothing here would change for a different party game.
//
// Wire a project in via { createRoomLogic }: a factory called once per room with a
// context (broadcast / sendTo / scheduleTransition / …) that returns the per-room
// logic { canJoin?, onJoin, onReconnect, onLeave, onMessage, onEnd? }.

import { randomUUID } from 'node:crypto';
import { serialize, deserialize } from './protocol.js';

// Defaults; a game overrides any of these via the `lifecycle` option. CODE_ALPHABET
// is the ambiguity-free set (no 0/O/1/I/L) for spoken / typed room codes — a game can
// supply its own (e.g. letters-only) alongside a CODE_LEN.
const DEFAULTS = {
  ROOM_TTL: 300000, MAX_ROOM_AGE: 7200000, CODE_LEN: 6, HEARTBEAT_MS: 15000,
  CODE_ALPHABET: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
};
const OPEN = 1; // WebSocket.OPEN

export class RoomServer {
  /**
   * @param {import('ws').WebSocketServer} wss
   * @param {object} opts
   * @param {(ctx:object)=>object} opts.createRoomLogic - per-room logic factory
   * @param {()=>number} [opts.rng=Math.random]
   * @param {object} [opts.lifecycle] - overrides for ROOM_TTL / MAX_ROOM_AGE / CODE_LEN / HEARTBEAT_MS
   */
  constructor(wss, { createRoomLogic, rng = Math.random, lifecycle = {} } = {}) {
    this.wss = wss;
    this.createRoomLogic = createRoomLogic;
    this.rng = rng;
    this.cfg = { ...DEFAULTS, ...lifecycle };
    this.rooms = new Map(); // code -> room
    wss.on('connection', (ws) => this._onConnection(ws));
    this._heartbeat = setInterval(() => this._pingAll(), this.cfg.HEARTBEAT_MS);
    if (this._heartbeat.unref) this._heartbeat.unref();
  }

  /** Stop the heartbeat and tear down every room (tests / shutdown). */
  close() {
    clearInterval(this._heartbeat);
    for (const room of [...this.rooms.values()]) this._endRoom(room);
  }

  roomCount() { return this.rooms.size; }

  // ── connection lifecycle ────────────────────────────────────────
  _onConnection(ws) {
    ws.isAlive = true;
    ws.member = null; // attached on CREATE / JOIN / SPECTATE / REJOIN
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => this._onMessage(ws, raw));
    ws.on('close', () => this._onClose(ws));
    ws.on('error', () => { try { ws.close(); } catch {} });
  }

  _pingAll() {
    const clients = this.wss.clients || [];
    for (const ws of clients) {
      if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
      ws.isAlive = false;
      try { ws.ping?.(); } catch {}
    }
  }

  _onMessage(ws, raw) {
    let msg;
    try { msg = deserialize(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    try {
      switch (msg.type) {
        case 'CREATE':   return this._handleCreate(ws, msg);
        case 'JOIN':     return this._handleJoin(ws, msg, 'player');
        case 'SPECTATE': return this._handleJoin(ws, msg, 'spectator');
        case 'REJOIN':   return this._handleRejoin(ws, msg);
        default: {
          const m = ws.member;
          if (!m) return; // not in a room yet — ignore stray game messages
          return m.room.logic.onMessage?.(m, msg);
        }
      }
    } catch (err) {
      console.error('RoomServer message error:', err);
    }
  }

  _onClose(ws) {
    const member = ws.member;
    if (!member) return;
    const room = member.room;
    if (!room || !this.rooms.has(room.code)) return;
    member.connected = false;
    member.ws = null;
    ws.member = null;
    try { room.logic.onLeave?.(member); } catch (e) { console.error('onLeave error:', e); }
    // Start the empty-room death timer once nobody is connected.
    const anyConnected = [...room.members.values()].some((m) => m.connected);
    if (!anyConnected && !room.deathTimer) {
      room.deathTimer = setTimeout(() => this._endRoom(room), this.cfg.ROOM_TTL);
      if (room.deathTimer.unref) room.deathTimer.unref();
    }
  }

  // ── join / create / reconnect ───────────────────────────────────
  _handleCreate(ws, msg) {
    if (ws.member) return;
    const room = this._createRoom();
    const member = this._addMember(room, ws, 'host');
    room.hostId = member.id;
    this._sendIdentity(ws, member, room);
    try { room.logic.onJoin?.(member, msg); } catch (e) { console.error('onJoin error:', e); }
  }

  _handleJoin(ws, msg, role) {
    if (ws.member) return;
    const room = this.rooms.get(this._normCode(msg.code));
    if (!room) return this._send(ws, { type: 'ERROR', code: 'NO_SUCH_ROOM', message: 'No room with that code.' });
    const reject = room.logic.canJoin?.(msg, role);
    if (reject) return this._send(ws, { type: 'ERROR', code: reject, message: reject });
    const member = this._addMember(room, ws, role);
    this._sendIdentity(ws, member, room);
    try { room.logic.onJoin?.(member, msg); } catch (e) { console.error('onJoin error:', e); }
  }

  _handleRejoin(ws, msg) {
    if (ws.member) return;
    const room = this.rooms.get(this._normCode(msg.code));
    if (!room) return this._send(ws, { type: 'ERROR', code: 'NO_SUCH_SESSION', message: 'Session expired.' });
    let member = null;
    for (const m of room.members.values()) if (m.token === msg.token) { member = m; break; }
    if (!member) return this._send(ws, { type: 'ERROR', code: 'NO_SUCH_SESSION', message: 'Session expired.' });
    member.ws = ws;
    member.connected = true;
    ws.member = member;
    ws.isAlive = true;
    if (room.deathTimer) { clearTimeout(room.deathTimer); room.deathTimer = null; }
    this._sendIdentity(ws, member, room);
    try { room.logic.onReconnect?.(member, msg); } catch (e) { console.error('onReconnect error:', e); }
  }

  // ── room + member bookkeeping ───────────────────────────────────
  _createRoom() {
    const code = this._generateCode();
    const room = {
      code,
      createdAt: Date.now(),
      members: new Map(), // id -> member
      hostId: null,
      timer: null,        // the single game-phase timer
      deathTimer: null,   // empty-room TTL
      ageTimer: null,
      logic: null,
    };
    room.logic = this.createRoomLogic(this._ctx(room));
    this.rooms.set(code, room);
    room.ageTimer = setTimeout(() => this._endRoom(room), this.cfg.MAX_ROOM_AGE);
    if (room.ageTimer.unref) room.ageTimer.unref();
    return room;
  }

  _addMember(room, ws, role) {
    const member = {
      id: randomUUID(),
      token: randomUUID(),
      role,
      connected: true,
      data: {}, // opaque game bag
      ws,
      room,
    };
    room.members.set(member.id, member);
    ws.member = member;
    if (room.deathTimer) { clearTimeout(room.deathTimer); room.deathTimer = null; }
    return member;
  }

  /** Context handed to the injected room logic. */
  _ctx(room) {
    return {
      code: room.code,
      rng: this.rng,
      now: () => Date.now(),
      members: () => [...room.members.values()],
      connectedMembers: () => [...room.members.values()].filter((m) => m.connected),
      host: () => room.members.get(room.hostId) || null,
      memberById: (id) => room.members.get(id) || null,
      broadcast: (msgOrFn) => this._broadcast(room, msgOrFn),
      sendTo: (member, msg) => this._send(member && member.ws, msg),
      scheduleTransition: (ms, cb) => this._schedule(room, ms, cb),
      clearTransition: () => this._clearTimer(room),
      end: () => this._endRoom(room),
    };
  }

  _endRoom(room) {
    if (!this.rooms.has(room.code)) return;
    this._clearTimer(room);
    if (room.deathTimer) { clearTimeout(room.deathTimer); room.deathTimer = null; }
    if (room.ageTimer) { clearTimeout(room.ageTimer); room.ageTimer = null; }
    this.rooms.delete(room.code);
    for (const m of room.members.values()) { try { m.ws?.close(); } catch {} }
    try { room.logic.onEnd?.(); } catch (e) { console.error('onEnd error:', e); }
  }

  // ── timer discipline: exactly one phase timer per room ──────────
  _schedule(room, ms, cb) {
    this._clearTimer(room);
    room.timer = setTimeout(() => {
      room.timer = null;
      try { cb(); } catch (e) { console.error('transition error:', e); }
    }, ms);
    if (room.timer.unref) room.timer.unref();
  }

  _clearTimer(room) {
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  }

  // ── send helpers ────────────────────────────────────────────────
  _broadcast(room, msgOrFn) {
    for (const m of room.members.values()) {
      if (!m.connected || !m.ws) continue;
      const payload = typeof msgOrFn === 'function' ? msgOrFn(m) : msgOrFn;
      if (payload) this._send(m.ws, payload);
    }
  }

  _sendIdentity(ws, member, room) {
    this._send(ws, { type: 'IDENTITY', id: member.id, token: member.token, code: room.code, role: member.role });
  }

  _send(ws, msg) {
    if (ws && ws.readyState === OPEN) { try { ws.send(serialize(msg)); } catch {} }
  }

  // ── codes ───────────────────────────────────────────────────────
  _normCode(code) { return String(code || '').toUpperCase().trim(); }

  _generateCode() {
    const alphabet = this.cfg.CODE_ALPHABET;
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < this.cfg.CODE_LEN; i++) {
        code += alphabet[Math.floor(this.rng() * alphabet.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    // Astronomically unlikely; widen rather than loop forever.
    return alphabet[0].repeat(this.cfg.CODE_LEN) + Math.floor(this.rng() * 1e6);
  }
}
