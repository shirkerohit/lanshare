// worker/worker.js
// Hosted LanShare signaling relay: Cloudflare Worker fronting one Durable
// Object (ScopeRoom) per LAN scope. Same wire contract as server/server.js --
// a client cannot tell which backend it talks to -- enforced by sharing the
// recipient-set semantics in room.js and the spelling of every message via
// protocol.js (both pinned by tests/worker.test.js).
//
// HIBERNATION IS MANDATORY, not an optimization. Every accepted connection
// goes through the WebSocket Hibernation API (acceptWebSocket plus the
// webSocketMessage / webSocketClose handlers); the legacy non-hibernating
// upgrade path is never used, and the module refuses to start a room without
// the hibernation API (see assertHibernationInUse, called from the room
// constructor and again at each upgrade). Why: Durable Objects bill wall
// duration while resident in memory, and the Free tier daily allowance
// (~104,000 object-seconds, about 29 hours -- see worker/README for the full
// math) is exhausted by a single always-resident room. Hibernation lets an
// idle room sleep at zero cost, which is what keeps the hosted path at $0.
//
// NO PERSISTED STATE: room membership lives in a memory Map (rebuilt after a
// hibernation wake from per-socket attachments, which are connection state,
// not stored rows). This module never reads or writes Durable Object storage.

import { MESSAGE_TYPES } from './protocol.js';
import { deriveScopeFromHeaders, scopeKeyForDO, UNKNOWN_SCOPE_KEY } from './scope.js';
import * as Room from './room.js';

// ---------------------------------------------------------------------------
// Duration budget (Free tier). The math is documented in worker/README so the
// constraint survives; tests/worker.test.js asserts the README numbers match
// these constants.
// ---------------------------------------------------------------------------

export const DURATION_ALLOWANCE_OBJECT_SECONDS = 104000;
export const SECONDS_PER_DAY = 86400;
export const MAX_ALWAYS_ON_ROOMS = Math.floor(
  DURATION_ALLOWANCE_OBJECT_SECONDS / SECONDS_PER_DAY
);
export const HIBERNATION_ENABLED = true;

// ---------------------------------------------------------------------------
// Startup assertion: fail loudly unless the hibernation API is in use.
// The non-hibernating upgrade path keeps the object resident (and therefore
// billing) for the lifetime of every connection, which burns through the
// daily allowance above. Any future edit that drops the hibernation call must
// trip this assertion instead of silently reverting to the billing path.
// ---------------------------------------------------------------------------

export function assertHibernationInUse(ctx) {
  if (!ctx || typeof ctx.acceptWebSocket !== 'function') {
    throw new Error(
      '[lanshare-relay] FATAL: Durable Object hibernation API is unavailable ' +
        '(acceptWebSocket is missing). Refusing to run rooms on the billing ' +
        'upgrade path: one always-resident room exhausts the ~29h daily ' +
        'duration allowance. Check compatibility_date and that rooms are ' +
        'created via the ScopeRoom class in worker/worker.js.'
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Duration observability: current usage snapshot for the status route and logs.
// ---------------------------------------------------------------------------

const WORKER_STARTED_AT = Date.now();
let connectionsAccepted = 0;
const scopesSeen = new Set();

export function buildWorkerStatus({ startedAtMs, nowMs, accepted, distinctScopes }) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  return {
    ok: true,
    service: 'lanshare-signaling-relay',
    uptimeMs: now - startedAtMs,
    hibernation: { enabled: HIBERNATION_ENABLED, api: 'acceptWebSocket' },
    connectionsAccepted: accepted,
    distinctScopesSeen: distinctScopes,
    duration: {
      allowanceObjectSecondsPerDay: DURATION_ALLOWANCE_OBJECT_SECONDS,
      secondsPerDay: SECONDS_PER_DAY,
      maxAlwaysOnRooms: MAX_ALWAYS_ON_ROOMS,
      note:
        'Allowance is ~104000 object-seconds/day (~29h). ' +
        'Hibernated idle rooms bill zero; an always-resident room would burn ' +
        '86400 object-seconds/day. See worker/README for the full math.',
    },
  };
}

function currentWorkerStatus() {
  return buildWorkerStatus({
    startedAtMs: WORKER_STARTED_AT,
    nowMs: Date.now(),
    accepted: connectionsAccepted,
    distinctScopes: scopesSeen.size,
  });
}

// ---------------------------------------------------------------------------
// Durable Object: one instance per scope key. All sockets accepted here use
// hibernation; per-socket data rides attachments so a hibernation wake can
// rebuild the memory roster without touching stored rows.
// ---------------------------------------------------------------------------

export class ScopeRoom {
  constructor(ctx, env) {
    assertHibernationInUse(ctx);
    this.ctx = ctx;
    this.env = env;
    this.state = Room.createRoomState();
    // Opportunistic liveness only (see webSocketMessage): a resident timer
    // would bill duration around the clock and defeat hibernation.
    this.lastTick = Date.now();
    // Rebuild the in-memory roster from hibernated socket attachments.
    // Attachments are connection state held by the runtime, not persisted
    // rows: nothing is read from storage here.
    for (const ws of this.ctx.getWebSockets()) {
      let attachment = null;
      try {
        attachment = ws.deserializeAttachment();
      } catch {
        attachment = null;
      }
      if (attachment && typeof attachment.peerId === 'string') {
        this.state.peers.set(attachment.peerId, {
          ws,
          info: attachment.info || null,
          scope: attachment.scope ?? null,
        });
        ws._scope = attachment.scope ?? null;
        ws._peerId = attachment.peerId;
        ws._missedPongs = 0;
      } else if (attachment && attachment.connectionScope !== undefined) {
        ws._scope = attachment.connectionScope ?? null;
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const upgrade = request.headers.get('Upgrade');

    // Per-room usage snapshot (routable with the same scope headers).
    if (url.pathname === '/status' && upgrade !== 'websocket') {
      const room = Room.buildRoomStatus(this.state);
      return Response.json({ ok: true, room, quarantineKey: UNKNOWN_SCOPE_KEY });
    }

    if (upgrade !== 'websocket') {
      return new Response('Expected a WebSocket upgrade.', { status: 426 });
    }

    assertHibernationInUse(this.ctx);
    const scope = deriveScopeFromHeaders(request.headers);

    // THE ONLY accept path in this codebase: hibernating. The returned
    // client end completes the 101 handshake; the server end sleeps with
    // the object instead of pinning it in memory.
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    try {
      server.serializeAttachment({
        peerId: null,
        scope: null,
        connectionScope: scope,
        info: null,
      });
    } catch {
      // Attachments are best-effort here; the live object keeps its own Map.
    }
    server._scope = scope;
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    let msg;
    try {
      msg = JSON.parse(typeof message === 'string' ? message : String(message));
    } catch {
      return;
    }
    // Heartbeat without a resident timer: reap stale peers when the room is
    // active (at most once per heartbeat interval) and rely on close events
    // while hibernating. A setInterval here would pin the object in memory
    // and bill duration for every idle second.
    const now = Date.now();
    if (now - this.lastTick >= Room.HEARTBEAT_INTERVAL_MS) {
      this.lastTick = now;
      Room.heartbeatTick(this.state);
    }
    let attachment = null;
    try {
      attachment = ws.deserializeAttachment();
    } catch {
      attachment = null;
    }
    if (msg && msg.type === MESSAGE_TYPES.REGISTER) {
      const scope = attachment
        ? attachment.connectionScope ?? null
        : ws._scope ?? null;
      Room.handleRegister(this.state, ws, msg, scope);
      try {
        ws.serializeAttachment({
          peerId: msg.peerId || null,
          scope,
          connectionScope: scope,
          info: msg.info || null,
        });
      } catch {
        // Live object keeps its own Map; attachment refresh is best-effort.
      }
      return;
    }
    const scope = attachment
      ? attachment.scope ?? attachment.connectionScope ?? null
      : Room.scopeOfSocket(this.state, ws);
    Room.handleMessage(this.state, ws, msg, scope);
  }

  webSocketClose(ws, code, reason, wasClean) {
    let attachment = null;
    try {
      attachment = ws.deserializeAttachment();
    } catch {
      attachment = null;
    }
    const peerId = attachment
      ? attachment.peerId || null
      : ws._peerId || null;
    if (peerId) Room.handleDisconnect(this.state, ws, peerId);
  }

  webSocketError(ws, error) {
    console.error('[lanshare-relay] socket error:', error && error.message ? error.message : error);
  }
}

// ---------------------------------------------------------------------------
// Worker entry: status route + scope routing to one Durable Object per scope.
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/status') {
      return Response.json(currentWorkerStatus());
    }

    if (url.pathname === '/' && request.headers.get('Upgrade') !== 'websocket') {
      return new Response(
        'LanShare signaling relay. Connect with a WebSocket; usage at /status.',
        { headers: { 'Content-Type': 'text/plain' } }
      );
    }

    const scope = deriveScopeFromHeaders(request.headers);
    const key = scopeKeyForDO(scope);
    connectionsAccepted += 1;
    if (scope) scopesSeen.add(scope);
    else scopesSeen.add(UNKNOWN_SCOPE_KEY);
    // Duration-relevant metric in the log: routing volume per scope makes
    // allowance consumption visible well before exhaustion.
    console.log(
      `[lanshare-relay] route scope=${scope || UNKNOWN_SCOPE_KEY} ` +
        `accepted=${connectionsAccepted} distinctScopes=${scopesSeen.size}`
    );
    const id = env.SCOPE_ROOM.idFromName(key);
    return env.SCOPE_ROOM.get(id).fetch(request);
  },
};
