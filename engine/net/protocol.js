// Wire protocol — shared by client and server. JSON, no compression (matching
// Sub Game). Define your project's message types with defineMessageTypes().

export function serialize(message) {
  return JSON.stringify(message);
}

export function deserialize(data) {
  return JSON.parse(typeof data === 'string' ? data : data.toString());
}

/**
 * Build a frozen { NAME: 'NAME' } enum of message type constants.
 * @example const M = defineMessageTypes('JOIN', 'INPUT', 'STATE', 'WELCOME');
 */
export function defineMessageTypes(...names) {
  const out = {};
  for (const n of names) out[n] = n;
  return Object.freeze(out);
}
