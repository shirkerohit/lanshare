// worker/room.js
// Pure in-memory room logic for one LAN scope. Mirrors the scoped registry in
// server/server.js (same validation, same recipient sets, same wire shapes)
// so a client cannot tell which backend it talks to. server/server.js is
// canonical for behavior; tests/worker.test.js drives these functions with
// fake sockets the same way tests/server.test.js drives the Node handlers.
//
// Runtime notes:
// - No I/O, no timers, no platform APIs here: the Durable Object in
//   worker/worker.js owns hibernation and attachments, this module owns the
//   recipient sets. That split is what makes this file unit-testable in Node,
//   which has no Durable Object runtime.
// - Membership is in-memory only (a Map plus a violations log). Nothing is
//   written to Durable Object storage anywhere in this directory.
// - A null scope grants nothing: peersInScope answers empty, broadcast
//   delivers to nobody, forwardTo refuses. Malformed/forged addresses therefore
//   observe nobody, including each other in the quarantine room.
// - Liveness mirrors the Node heartbeat (same interval, same miss budget);
//   the Durable Object drives heartbeatTick opportunistically because a
//   resident timer would bill duration around the clock and defeat hibernation.

import { MESSAGE_TYPES as T, ERROR_CODES } from './protocol.js';

export const HEARTBEAT_INTERVAL_MS = 30000;
export const HEARTBEAT_MAX_MISSED = 2;

export function createRoomState() {
  return { peers: new Map(), violations: [] };
}

export function scopeOfSocket(state, ws) {
  if (ws && typeof ws._scope === 'string') return ws._scope;
  if (ws && ws._scope === null) return null;
  for (const [, peer] of state.peers.entries()) {
    if (peer.ws === ws) return peer.scope;
  }
  return undefined;
}

export function peerIdOfSocket(state, ws) {
  if (ws && typeof ws._peerId === 'string') return ws._peerId;
  for (const [id, peer] of state.peers.entries()) {
    if (peer.ws === ws) return id;
  }
  return null;
}

// Testable recipient-set computation: who would receive a message from
// `excludeId` within `scope` (peer_list view). Null scope -> nobody.
export function peersInScope(state, scope, excludeId) {
  const out = [];
  if (scope == null) return out;
  for (const [id, peer] of state.peers.entries()) {
    if (id !== excludeId && peer.scope === scope) {
      out.push({ peerId: id, info: peer.info });
    }
  }
  return out;
}

function recordViolation(state, ws, target, kind) {
  state.violations.push({
    at: Date.now(),
    by: peerIdOfSocket(state, ws),
    target: target || null,
    kind,
  });
}

function safeSend(ws, msg) {
  try {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

export function handleRegister(state, ws, msg, scope) {
  const peerId = msg ? msg.peerId : null;
  const info = msg ? msg.info : null;
  // Validation: refuse malformed registrations without touching state.
  if (typeof peerId !== 'string' || peerId.length === 0) {
    safeSend(ws, { type: T.REGISTER_ERROR, code: ERROR_CODES.INVALID });
    return false;
  }
  if (!info || typeof info.name !== 'string' || info.name.length === 0) {
    safeSend(ws, { type: T.REGISTER_ERROR, code: ERROR_CODES.INVALID });
    return false;
  }
  if (info.name.length > 256) {
    safeSend(ws, { type: T.REGISTER_ERROR, code: ERROR_CODES.INVALID });
    return false;
  }
  let infoSize = 0;
  try {
    infoSize = JSON.stringify(info).length;
  } catch {
    safeSend(ws, { type: T.REGISTER_ERROR, code: ERROR_CODES.INVALID });
    return false;
  }
  if (infoSize > 4096) {
    safeSend(ws, { type: T.REGISTER_ERROR, code: ERROR_CODES.INVALID });
    return false;
  }

  // Scope is ALWAYS the network-derived value passed in by the caller (the
  // Durable Object derives it from edge headers once per connection and
  // re-applies it here). Any client-supplied scope value on the message
  // (scope / subnet / room / ...) is ignored.
  ws._scope = scope;
  ws._peerId = peerId;
  ws._missedPongs = 0;
  state.peers.set(peerId, { ws, info, scope });

  // Send current peer list to new peer: same scope only.
  ws.send(JSON.stringify({
    type: T.PEER_LIST,
    peers: peersInScope(state, scope, peerId),
  }));

  // Announce new peer to existing peers in the same scope only.
  broadcast(state, ws, {
    type: T.PEER_JOINED,
    peerId,
    info,
  });
  return true;
}

export function handleSignal(state, ws, msg, senderScope) {
  const target = msg ? msg.target : null;
  if (!target) return false;
  const scope = senderScope !== undefined ? senderScope : scopeOfSocket(state, ws);
  if (scope == null) return false;
  const targetEntry = state.peers.get(target);
  if (!targetEntry) return false;
  if (targetEntry.scope !== scope) {
    // Cross-scope relay attempt: refuse, record, deliver nothing.
    // Silent refusal (no error back) matches the Node server exactly, so the
    // offender learns nothing about the other scope; the attempt stays
    // visible in the in-memory violations log surfaced via status.
    recordViolation(state, ws, target, T.SIGNAL);
    return false;
  }
  return forwardTo(state, target, { type: T.SIGNAL, from: msg.from, signal: msg.signal }, ws);
}

export function handleChat(state, ws, msg, senderScope) {
  const scope = senderScope !== undefined ? senderScope : scopeOfSocket(state, ws);
  if (scope == null) return false;
  // Confidential delivery: private plus target means a single recipient only.
  // NEVER broadcast a private message. On failure deliver to NOBODY and
  // inform the sender; never fall back to broadcast.
  if (msg.private === true) {
    const target = msg.target;
    if (typeof target !== 'string' || target.length === 0) {
      safeSend(ws, { type: T.CHAT_ERROR, code: ERROR_CODES.UNDELIVERABLE });
      return false;
    }
    const targetEntry = state.peers.get(target);
    if (!targetEntry || targetEntry.ws.readyState !== 1 || targetEntry.scope !== scope) {
      if (targetEntry && targetEntry.scope !== scope) recordViolation(state, ws, target, T.CHAT);
      safeSend(ws, { type: T.CHAT_ERROR, code: ERROR_CODES.UNDELIVERABLE });
      return false;
    }
    safeSend(targetEntry.ws, {
      type: T.CHAT,
      from: msg.from,
      name: msg.name,
      text: msg.text,
      timestamp: Date.now(),
      private: true,
      target: msg.target,
    });
    return true;
  }
  // Broadcast to same-scope peers except the sender (sender shows it locally).
  broadcast(state, ws, {
    type: T.CHAT,
    from: msg.from,
    name: msg.name,
    text: msg.text,
    timestamp: Date.now(),
    private: msg.private || false,
    target: msg.target || null,
  });
  return true;
}

export function handleWhiteboard(state, ws, msg, senderScope) {
  const scope = senderScope !== undefined ? senderScope : scopeOfSocket(state, ws);
  if (scope == null) return false;
  broadcast(state, ws, {
    type: T.WHITEBOARD,
    from: msg.from,
    event: msg.event,
  });
  return true;
}

export function handleTyping(state, ws, msg, senderScope) {
  const scope = senderScope !== undefined ? senderScope : scopeOfSocket(state, ws);
  if (scope == null) return false;
  broadcast(state, ws, { type: T.TYPING, from: msg.from, name: msg.name, isTyping: msg.isTyping });
  return true;
}

export function handlePing(ws, msg) {
  ws.send(JSON.stringify({ type: T.PONG, timestamp: msg ? msg.timestamp : null }));
  return true;
}

export function handlePong(ws) {
  if (ws) ws._missedPongs = 0;
  return true;
}

// Pairing relay (stateless pure relay -- NO request state is stored; expiry
// is client-side). Field names mirror the Node server exactly: the recipient
// is named by `to`, and failures answer the sender with pairing_error.
export function handlePairingRequest(state, ws, msg, senderScope) {
  const requestId = msg ? msg.requestId : undefined;
  const to = msg ? msg.to : undefined;
  const scope = senderScope !== undefined ? senderScope : scopeOfSocket(state, ws);
  // Unregistered / scopeless sender: cannot prove same-scope, do not leak
  // the cross-scope distinction.
  if (scope == null) {
    safeSend(ws, { type: T.PAIRING_ERROR, requestId, code: ERROR_CODES.UNAVAILABLE });
    return false;
  }
  if (typeof to !== 'string' || to.length === 0) {
    safeSend(ws, { type: T.PAIRING_ERROR, requestId, code: ERROR_CODES.UNAVAILABLE });
    return false;
  }
  const targetEntry = state.peers.get(to);
  if (!targetEntry || targetEntry.ws.readyState !== 1) {
    safeSend(ws, { type: T.PAIRING_ERROR, requestId, code: ERROR_CODES.UNAVAILABLE });
    return false;
  }
  if (targetEntry.scope !== scope) {
    recordViolation(state, ws, to, T.PAIRING_REQUEST);
    safeSend(ws, { type: T.PAIRING_ERROR, requestId, code: ERROR_CODES.CROSS_SCOPE });
    return false;
  }
  safeSend(targetEntry.ws, {
    type: T.PAIRING_REQUEST,
    requestId: msg.requestId,
    from: msg.from,
    fromName: msg.fromName,
    fromType: msg.fromType,
    to: msg.to,
  });
  return true;
}

export function handlePairingResponse(state, ws, msg, senderScope) {
  const scope = senderScope !== undefined ? senderScope : scopeOfSocket(state, ws);
  if (scope == null) return false;
  const to = msg ? msg.to : undefined;
  if (typeof to !== 'string' || to.length === 0) return false;
  const targetEntry = state.peers.get(to);
  if (!targetEntry || targetEntry.ws.readyState !== 1) return false;
  if (targetEntry.scope !== scope) {
    recordViolation(state, ws, to, T.PAIRING_RESPONSE);
    return false;
  }
  safeSend(targetEntry.ws, {
    type: T.PAIRING_RESPONSE,
    requestId: msg.requestId,
    to: msg.to,
    accepted: msg.accepted,
  });
  return true;
}

// Heartbeat: ping every peer; a peer missing HEARTBEAT_MAX_MISSED consecutive
// pongs is removed and its scope peers get peer_left. Same constants and same
// reaping order as the Node server.
export function heartbeatTick(state) {
  for (const [peerId, peer] of Array.from(state.peers.entries())) {
    const missed = peer.ws._missedPongs || 0;
    if (missed >= HEARTBEAT_MAX_MISSED) {
      handleDisconnect(state, peer.ws, peerId);
    } else {
      peer.ws._missedPongs = missed + 1;
      safeSend(peer.ws, { type: T.PING });
    }
  }
  return true;
}

export function forwardTo(state, targetId, msg, senderWs) {
  const target = state.peers.get(targetId);
  if (!target || target.ws.readyState !== 1) return false;
  if (senderWs !== undefined) {
    const senderScope = scopeOfSocket(state, senderWs);
    if (senderScope == null || target.scope !== senderScope) return false;
  }
  target.ws.send(JSON.stringify(msg));
  return true;
}

export function broadcast(state, senderWs, msg) {
  const senderScope = scopeOfSocket(state, senderWs);
  if (senderScope == null) return 0;
  const data = JSON.stringify(msg);
  let count = 0;
  for (const [, peer] of state.peers.entries()) {
    if (peer.ws !== senderWs && peer.scope === senderScope && peer.ws.readyState === 1) {
      peer.ws.send(data);
      count += 1;
    }
  }
  return count;
}

export function handleDisconnect(state, ws, peerId) {
  if (!peerId || !state.peers.has(peerId)) return false;
  const current = state.peers.get(peerId);
  // Only the owning socket may remove its registration.
  if (current.ws !== ws) return false;
  const info = current.info;
  const scope = current.scope;
  state.peers.delete(peerId);
  if (scope != null) {
    broadcast(state, ws, {
      type: T.PEER_LEFT,
      peerId,
      name: info ? info.name : undefined,
    });
  }
  return true;
}

// Dispatcher shared by the Durable Object. Returns true when the message was
// acted on, false when it was ignored or refused.
export function handleMessage(state, ws, msg, senderScope) {
  if (!msg || typeof msg !== 'object') return false;
  if (typeof msg.type !== 'string') {
    // Forward unknown messages to target peer if specified (same scope only).
    if (msg.target) return forwardTo(state, msg.target, msg, ws);
    return false;
  }
  switch (msg.type) {
    case T.REGISTER:
      return handleRegister(state, ws, msg, senderScope);
    case T.SIGNAL:
      return handleSignal(state, ws, msg, senderScope);
    case T.CHAT:
      return handleChat(state, ws, msg, senderScope);
    case T.WHITEBOARD:
      return handleWhiteboard(state, ws, msg, senderScope);
    case T.TYPING:
      return handleTyping(state, ws, msg, senderScope);
    case T.PAIRING_REQUEST:
      return handlePairingRequest(state, ws, msg, senderScope);
    case T.PAIRING_RESPONSE:
      return handlePairingResponse(state, ws, msg, senderScope);
    case T.PING:
      return handlePing(ws, msg);
    case T.PONG:
      return handlePong(ws);
    default:
      // Forward unknown messages to target peer if specified (same scope only).
      if (msg.target) return forwardTo(state, msg.target, msg, ws);
      return false;
  }
}

// Current usage snapshot for observability (served by the status route).
export function buildRoomStatus(state) {
  const scopes = new Set();
  for (const [, peer] of state.peers.entries()) {
    if (peer.scope != null) scopes.add(peer.scope);
  }
  return {
    peerCount: state.peers.size,
    scopes: [...scopes].sort(),
    violations: state.violations.length,
  };
}
