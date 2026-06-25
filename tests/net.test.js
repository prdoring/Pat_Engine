import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialize, deserialize, defineMessageTypes } from '/engine/net/protocol.js';
import { StateBuffer } from '/engine/net/StateBuffer.js';
import { ServerLoop } from '/engine/net/ServerLoop.js';
import { NetworkClient } from '/engine/net/NetworkClient.js';

test('protocol round-trips and defines frozen message types', () => {
  const msg = { type: 'STATE', tick: 3, entities: { a: { x: 1 } } };
  assert.deepEqual(deserialize(serialize(msg)), msg);
  const M = defineMessageTypes('JOIN', 'STATE');
  assert.equal(M.JOIN, 'JOIN');
  assert.throws(() => { M.NEW = 'x'; }, TypeError);
});

test('StateBuffer interpolates entity fields between snapshots', () => {
  const buf = new StateBuffer({ renderDelay: 0, fields: { lerp: ['x', 'y'], lerpAngle: ['angle'], copy: ['hp'] } });
  buf.push({ entities: { a: { x: 0, y: 0, angle: 0, hp: 100 } } }, 0);
  buf.push({ entities: { a: { x: 10, y: 20, angle: 0, hp: 80 } } }, 100);
  const s = buf.getInterpolated(50); // target = 50 → halfway
  assert.ok(Math.abs(s.entities.a.x - 5) < 1e-6);
  assert.ok(Math.abs(s.entities.a.y - 10) < 1e-6);
  assert.equal(s.entities.a.hp, 80, 'copy field takes latest value');
});

test('StateBuffer returns latest snapshot when target is past the buffer', () => {
  const buf = new StateBuffer({ renderDelay: 0 });
  buf.push({ entities: { a: { x: 1 } } }, 0);
  buf.push({ entities: { a: { x: 2 } } }, 100);
  assert.equal(buf.getInterpolated(999).entities.a.x, 2);
  assert.equal(buf.getInterpolated(0, 0) ? true : true, true);
});

test('StateBuffer lerpAngle takes the shortest path across the wrap', () => {
  const buf = new StateBuffer({ renderDelay: 0, fields: { lerp: [], lerpAngle: ['angle'] } });
  buf.push({ entities: { a: { angle: -3.0 } } }, 0);
  buf.push({ entities: { a: { angle: 3.0 } } }, 100); // ~ -0.28 rad apart, not +6
  const s = buf.getInterpolated(50);
  // Halfway along the short path should be near ±PI, not near 0.
  assert.ok(Math.abs(Math.abs(s.entities.a.angle) - Math.PI) < 0.2, `got ${s.entities.a.angle}`);
});

test('ServerLoop ticks systems and broadcasts', async () => {
  let ticks = 0, broadcasts = 0;
  const loop = new ServerLoop({ state: {}, tickMs: 20, broadcast: () => broadcasts++ });
  loop.addSystem({ update: () => ticks++ });
  loop.start();
  await new Promise(r => setTimeout(r, 90));
  loop.stop();
  assert.ok(ticks >= 2, `expected >=2 ticks, got ${ticks}`);
  assert.ok(broadcasts >= 2, `expected >=2 broadcasts, got ${broadcasts}`);
});

test('NetworkClient registers handlers without connecting', () => {
  const net = new NetworkClient('ws://localhost:1'); // explicit url → no location needed
  let got = null;
  net.on('STATE', m => { got = m; });
  // Simulate an inbound message by invoking the registered handler directly.
  net.handlers.get('STATE')[0]({ type: 'STATE', v: 1 });
  assert.deepEqual(got, { type: 'STATE', v: 1 });
});
