# engine/net — optional multiplayer module

A generalized, **optional** client-server scaffold extracted and decoupled from Sub Game's
authoritative-multiplayer netcode. It is **not used by the Critter Garden example**, so treat it as a
head-start template, not a tested component — wire it into a real project and test it there.

## Pieces

| File | Runs on | Purpose |
|---|---|---|
| `protocol.js` | both | `serialize`/`deserialize` (JSON) + `defineMessageTypes(...)` |
| `NetworkClient.js` | browser | WebSocket client with `on(type, handler)` dispatch + auto-reconnect |
| `ServerLoop.js` | Node | fixed-timestep loop over a systems registry + a broadcast hook |
| `StateBuffer.js` | browser | interpolation buffer driven by a per-entity field config |

## Wiring sketch

**Shared** (`game/protocol.js`):
```js
import { defineMessageTypes } from '/engine/net/protocol.js';
export const M = defineMessageTypes('JOIN', 'INPUT', 'STATE', 'WELCOME');
```

**Server** (Node — add `ws` and a `WebSocketServer` to `server/main.js`):
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

## Notes
- The single-player core (`engine/core/Game.js`) has **zero** dependency on this module.
- `ws` is only needed when you actually use a server WebSocket; the SP host (`server/main.js`) does not.
- `StateBuffer` interpolates `state[entitiesKey]` (default `entities`) and copies top-level fields from
  the latest snapshot. Adjust `fields` to your entity shape.
