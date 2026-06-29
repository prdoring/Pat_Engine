import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RoomServer } from '/engine/net/RoomServer.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal fake WebSocket: EventEmitter + the bits RoomServer touches.
class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; this.closed = false; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { if (!this.closed) { this.closed = true; this.readyState = 3; this.emit('close'); } }
  terminate() { this.close(); }
  ping() { this.pinged = (this.pinged || 0) + 1; }
  recv(obj) { this.emit('message', JSON.stringify(obj)); }
  ofType(t) { return this.sent.filter((m) => m.type === t); }
  last() { return this.sent[this.sent.length - 1]; }
}
class FakeWSS extends EventEmitter {
  constructor() { super(); this.clients = new Set(); }
  connect(ws) { this.clients.add(ws); this.emit('connection', ws); return ws; }
}

// A trivial generic room logic to exercise RoomServer mechanics in isolation.
function makeLogic() {
  return (ctx) => ({
    ctx, joins: [], left: [], reconnected: [], fired: 0,
    canJoin: () => null,
    onJoin(m) { this.joins.push(m.id); ctx.broadcast((mem) => ({ type: 'ROOM_STATE', who: mem.id })); },
    onReconnect(m) { this.reconnected.push(m.id); ctx.sendTo(m, { type: 'RESUMED' }); },
    onLeave(m) { this.left.push(m.id); },
    onMessage(m, msg) {
      if (msg.type === 'SCHED') ctx.scheduleTransition(msg.ms, () => { this.fired++; });
    },
  });
}

function newServer(lifecycle = {}) {
  const wss = new FakeWSS();
  const rs = new RoomServer(wss, {
    createRoomLogic: makeLogic(),
    rng: () => 0.42, // deterministic codes
    lifecycle: { HEARTBEAT_MS: 1e9, ...lifecycle },
  });
  return { wss, rs };
}

test('CREATE issues an identity with a 6-char code and host role', () => {
  const { wss, rs } = newServer();
  const s = wss.connect(new FakeSocket());
  s.recv({ type: 'CREATE' });
  const id = s.ofType('IDENTITY')[0];
  assert.ok(id);
  assert.equal(id.code.length, 6);
  assert.equal(id.role, 'host');
  assert.ok(s.ofType('ROOM_STATE').length >= 1, 'onJoin broadcast reached the host');
  rs.close();
});

test('JOIN attaches a player to an existing room; bad code errors', () => {
  const { wss, rs } = newServer();
  const host = wss.connect(new FakeSocket()); host.recv({ type: 'CREATE' });
  const code = host.ofType('IDENTITY')[0].code;

  const p = wss.connect(new FakeSocket()); p.recv({ type: 'JOIN', code });
  assert.equal(p.ofType('IDENTITY')[0].role, 'player');
  assert.equal(rs.roomCount(), 1);

  const bad = wss.connect(new FakeSocket()); bad.recv({ type: 'JOIN', code: 'ZZZZZZ' });
  assert.equal(bad.last().type, 'ERROR');
  assert.equal(bad.last().code, 'NO_SUCH_ROOM');
  rs.close();
});

test('REJOIN by token rebinds the same member slot; bad token is rejected', () => {
  const { wss, rs } = newServer();
  const host = wss.connect(new FakeSocket()); host.recv({ type: 'CREATE' });
  const code = host.ofType('IDENTITY')[0].code;
  const p = wss.connect(new FakeSocket()); p.recv({ type: 'JOIN', code });
  const { id, token } = p.ofType('IDENTITY')[0];

  p.close();
  const p2 = wss.connect(new FakeSocket()); p2.recv({ type: 'REJOIN', code, token });
  assert.equal(p2.ofType('IDENTITY')[0].id, id, 'same slot');
  assert.ok(p2.ofType('RESUMED').length === 1, 'onReconnect fired');

  const bogus = wss.connect(new FakeSocket()); bogus.recv({ type: 'REJOIN', code, token: 'nope' });
  assert.equal(bogus.last().code, 'NO_SUCH_SESSION');
  rs.close();
});

test('game messages route to the room logic; opaque member.data is preserved across reconnect', () => {
  const { wss, rs } = newServer();
  const host = wss.connect(new FakeSocket()); host.recv({ type: 'CREATE' });
  const code = host.ofType('IDENTITY')[0].code;
  const room = rs.rooms.get(code);
  const member = [...room.members.values()][0];
  member.data.secret = 123; // game-owned opaque bag

  host.close();
  const back = wss.connect(new FakeSocket());
  back.recv({ type: 'REJOIN', code, token: host.ofType('IDENTITY')[0].token });
  assert.equal([...room.members.values()][0].data.secret, 123, 'data survived reconnect');
  rs.close();
});

test('single-timer discipline: a second scheduleTransition replaces the first', async () => {
  const { wss, rs } = newServer();
  const host = wss.connect(new FakeSocket()); host.recv({ type: 'CREATE' });
  const code = host.ofType('IDENTITY')[0].code;
  const logic = rs.rooms.get(code).logic;
  host.recv({ type: 'SCHED', ms: 1000 }); // would fire late
  host.recv({ type: 'SCHED', ms: 20 });   // replaces it
  await delay(60);
  assert.equal(logic.fired, 1, 'only the latest scheduled transition fired');
  rs.close();
});

test('empty room is torn down after ROOM_TTL', async () => {
  const { wss, rs } = newServer({ ROOM_TTL: 30 });
  const host = wss.connect(new FakeSocket()); host.recv({ type: 'CREATE' });
  assert.equal(rs.roomCount(), 1);
  host.close(); // last connected member leaves → death timer starts
  await delay(70);
  assert.equal(rs.roomCount(), 0, 'room garbage-collected');
  rs.close();
});

test('reconnect cancels the empty-room death timer', async () => {
  const { wss, rs } = newServer({ ROOM_TTL: 60 });
  const host = wss.connect(new FakeSocket()); host.recv({ type: 'CREATE' });
  const { code, token } = host.ofType('IDENTITY')[0];
  host.close();
  await delay(20); // within TTL
  const back = wss.connect(new FakeSocket()); back.recv({ type: 'REJOIN', code, token });
  await delay(80); // past the original TTL
  assert.equal(rs.roomCount(), 1, 'room survived because someone reconnected');
  rs.close();
});
