// worker/protocol.js
// Signaling message contract shared with server/server.js.
//
// CANONICAL SOURCE: server/server.js is the canonical definition of every
// message shape below (see its handleRegister / handleSignal / handleChat /
// handleWhiteboard / handlePairingRequest / handlePairingResponse /
// heartbeatTick / broadcast / handleDisconnect). Node runs CommonJS with
// side effects (an http server plus the `ws` dependency) while Workers run
// ESM with no npm dependencies, so one runtime cannot import the other's
// module without dragging incompatible machinery along. This table therefore
// DUPLICATES the type strings instead of importing them. The duplication is
// pinned: tests/worker.test.js reads server/server.js source and asserts
// every message type string there is spelled identically here. If you add a
// message type, add it in BOTH places with identical spelling.

export const MESSAGE_TYPES = Object.freeze({
  REGISTER: 'register',
  REGISTER_ERROR: 'register_error',
  PEER_LIST: 'peer_list',
  PEER_JOINED: 'peer_joined',
  PEER_LEFT: 'peer_left',
  SIGNAL: 'signal',
  CHAT: 'chat',
  CHAT_ERROR: 'chat_error',
  WHITEBOARD: 'whiteboard',
  TYPING: 'typing',
  PING: 'ping',
  PONG: 'pong',
  PAIRING_REQUEST: 'pairing_request',
  PAIRING_RESPONSE: 'pairing_response',
  PAIRING_ERROR: 'pairing_error',
});

// Machine-readable error codes sent inside the *_error messages. Kept in a
// second table so both tables stay small, frozen, and drift-pinned like
// MESSAGE_TYPES. Spellings mirror server/server.js exactly.
export const ERROR_CODES = Object.freeze({
  INVALID: 'invalid',
  UNAVAILABLE: 'unavailable',
  CROSS_SCOPE: 'cross_scope',
  UNDELIVERABLE: 'undeliverable',
});
