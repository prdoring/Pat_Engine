# engine/net: optional multiplayer module

A generalized, **optional** client-server scaffold extracted and decoupled from Sub Game's
authoritative-multiplayer netcode. It is **not used by the Critter Garden example**, so treat it as a
head-start template, not a tested component: wire it into a real project and test it there.

## Pieces

| File | Runs on | Purpose |
|---|---|---|
| `protocol.js` | both | `serialize`/`deserialize` (JSON) + `defineMessageTypes(...)` |
| `NetworkClient.js` | browser | WebSocket client with `on(type, handler)` dispatch + reconnect (exponential backoff + jitter) |
| `ServerLoop.js` | Node | fixed-timestep loop over a systems registry + a broadcast hook |
| `StateBuffer.js` | browser | interpolation buffer driven by a per-entity field config |
| `RoomServer.js` | Node | room/lobby host: short-code rooms, reconnect tokens, host role, TTL teardown, heartbeat; game logic injected (**covered by `tests/roomServer.test.js`**) |

`ServerLoop` + `StateBuffer` suit **authoritative real-time** games (one world, fixed tick,
interpolated snapshots). `RoomServer` suits **room-based / party** games (many independent rooms
joined by a short code, turn/phase logic in your own room object). Pick one per project.

## Wiring sketch

**Shared** (`game/protocol.js`):
```js
import { defineMessageTypes } from '/engine/net/protocol.js';
export const M = defineMessageTypes('JOIN', 'INPUT', 'STATE', 'WELCOME');
```

**Server** (Node; add `ws` and a `WebSocketServer` to `server/main.js`):
```js
import { ServerLoop } from '../engine/net/ServerLoop.js';
import { serialize, deserialize } from '../engine/net/protocol.js';

const loop = new ServerLoop({ state: world, tickMs: 50, broadcast: (s, tick) => {
  const msg = serialize({ type: 'STATE', tick, entities: s.entities });
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
}});
loop.addSystem({ update(state, dt, tick) { /* move entities, resolve collisions, ... */ } });
loop.start();
```

**Client** (browser):
```js
import { NetworkClient } from '/engine/net/NetworkClient.js';
import { StateBuffer } from '/engine/net/StateBuffer.js';

const buffer = new StateBuffer({ renderDelay: 100, fields: { lerp: ['x','y'], lerpAngle: ['angle'], copy: ['hp'] } });
const net = new NetworkClient()
  .on('WELCOME', m => { /* store my id */ })
  .on('STATE', m => buffer.push(m))
  .connect();

// each frame:
const state = buffer.getInterpolated(performance.now());
// ...render state.entities...
net.send({ type: 'INPUT', seq, input });
```

## Room/lobby host (`RoomServer`)

For party/room games, skip `ServerLoop` and let `RoomServer` own the connection lifecycle.
You supply a `createRoomLogic(ctx)` factory called once per room; it returns the per-room
hooks. `RoomServer` never reads `member.data`; that opaque bag is yours.

**Server** (Node; add `ws` and a `WebSocketServer` to `server/main.js`):
```js
import { WebSocketServer } from 'ws';
import { RoomServer } from '../engine/net/RoomServer.js';

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
new RoomServer(wss, {
  // optional overrides: { ROOM_TTL, MAX_ROOM_AGE, CODE_LEN, HEARTBEAT_MS, CODE_ALPHABET }
  createRoomLogic: (ctx) => ({
    canJoin(member)        { return ctx.connectedMembers().length < 8; },
    onJoin(member)         { member.data.score = 0; ctx.broadcast(roster(ctx)); },
    onReconnect(member)    { ctx.sendTo(member, snapshotFor(ctx, member)); },
    onLeave(member)        { ctx.broadcast(roster(ctx)); },
    onMessage(member, msg) { /* your game intents → mutate member.data, ctx.broadcast(...) */ },
    onEnd()                { /* room torn down (empty/aged out) */ },
  }),
});
```
`ctx` gives the room `broadcast`/`sendTo`, `members`/`connectedMembers`/`host`/`memberById`,
`scheduleTransition(ms, cb)`/`clearTransition()` (one timer per room), `rng`, `now()`, `code`,
and `end()`. The browser side is just `NetworkClient` sending `CREATE`/`JOIN`/`REJOIN` and your
own message types.

## Notes
- The single-player core (`engine/core/Game.js`) has **zero** dependency on this module.
- `ws` is only needed when you actually use a server WebSocket; the SP host (`server/main.js`) does not.
- `StateBuffer` interpolates `state[entitiesKey]` (default `entities`) and copies top-level fields from
  the latest snapshot. Adjust `fields` to your entity shape.
