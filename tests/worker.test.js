// tests/worker.test.js
// Covers OpenSpec tasks 6.1-6.6 (hosted signaling relay in worker/).
//
// Strategy: Node has no Durable Object / hibernation runtime, so this file
// tests the pure logic directly (scope derivation, in-scope routing,
// status math, config parsing) by importing the Worker's ESM modules, and
// covers the runtime-only guarantees with SOURCE-LEVEL assertions against
// worker/worker.js (explicitly documented as such where used):
//   - hibernation accept path is the only path (no bare accept call),
//   - no persisted state (no storage writes).
// The protocol-drift test reads server/server.js source and compares message
// type strings, so the two backends cannot silently diverge.

'use strict';

const assert = require('./assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const Server = require('../server/server.js');

const WORKER_DIR = path.join(__dirname, '..', 'worker');

let cached = null;
async function workerModules() {
  if (!cached) {
    const url = (f) => pathToFileURL(path.join(WORKER_DIR, f)).href;
    const [scope, room, protocol, worker] = await Promise.all([
      import(url('scope.js')),
      import(url('room.js')),
      import(url('protocol.js')),
      import(url('worker.js')),
    ]);
    cached = { scope, room, protocol, worker };
  }
  return cached;
}

function readSource(file) {
  return fs.readFileSync(path.join(WORKER_DIR, file), 'utf8');
}

function fakeWs() {
  return {
    readyState: 1,
    sent: [],
    _attachment: null,
    send(data) {
      this.sent.push(JSON.parse(data));
    },
    serializeAttachment(a) {
      this._attachment = a;
    },
    deserializeAttachment() {
      return this._attachment;
    },
  };
}

function ofType(ws, type) {
  return ws.sent.filter((m) => m.type === type);
}

const SCOPE_BATTERY = [
  '192.168.1.10',
  '192.168.1.200',
  '192.168.2.10',
  '10.0.5.6',
  '172.16.0.5',
  '8.8.8.8',
  '8.8.4.4',
  '1.1.1.1',
  'fe80::1',
  'fe80::abcd',
  '2001:db8:1:2::1',
  '2001:db8:1:3::1',
  '2001:0db8:0001:0002:0000:0000:0000:0001',
  '2001:DB8:1:2::A',
  'FE80::1',
  '::1',
  '::ffff:192.168.1.10',
  '::ffff:10.0.0.5',
  'fe80::1%eth0',
  '[::1]',
  '[2001:db8::1]:8080',
  // Malformed: every one must yield the grants-nothing scope (null).
  '',
  '   ',
  'not-an-ip',
  '999.1.1.1',
  '256.1.1.1',
  '1.2.3.256',
  '1.2.3',
  '1.2.3.4.5',
  '1.2.3.4:5678',
  'fe80:::1',
  ':::1',
  '::ffff::1',
  '1::2::3',
  'gggg::1',
  '12345',
  '[unclosed',
  '[]',
];

const NON_STRINGS = [12345, null, undefined, {}, [], true];

const tests = {
  // ---- 6.2 scope derivation mirrors the Node server ----

  'scope derivation agrees with server.js on every input': async () => {
    const { scope } = await workerModules();
    for (const input of SCOPE_BATTERY) {
      assert.equal(
        scope.scopeForAddress(input),
        Server.scopeForAddress(input),
        `scope mismatch for ${JSON.stringify(input)}`
      );
    }
    for (const input of NON_STRINGS) {
      assert.equal(scope.scopeForAddress(input), null, `expected null for ${String(input)}`);
      assert.equal(scope.scopeForAddress(input), Server.scopeForAddress(input));
    }
  },

  'scope derivation spot-checks IPv4 /24, IPv6 /64, mapped and malformed': async () => {
    const { scope } = await workerModules();
    assert.equal(scope.scopeForAddress('192.168.1.10'), 'v4:192.168.1.0/24');
    assert.equal(scope.scopeForAddress('192.168.1.200'), 'v4:192.168.1.0/24');
    assert.notEqual(scope.scopeForAddress('192.168.1.10'), scope.scopeForAddress('192.168.2.10'));
    assert.equal(scope.scopeForAddress('2001:db8:1:2::1'), 'v6:2001:db8:1:2/64');
    assert.equal(scope.scopeForAddress('fe80::1'), scope.scopeForAddress('fe80::abcd'));
    assert.notEqual(
      scope.scopeForAddress('2001:db8:1:2::1'),
      scope.scopeForAddress('2001:db8:1:3::1')
    );
    assert.equal(
      scope.scopeForAddress('::ffff:192.168.1.10'),
      scope.scopeForAddress('192.168.1.10')
    );
    assert.equal(scope.scopeForAddress('not-an-ip'), null);
    assert.equal(scope.scopeForAddress('999.999.999.999'), null);
  },

  'scope comes from CF-Connecting-IP, then X-Forwarded-For, then nothing': async () => {
    const { scope } = await workerModules();
    // Authoritative header wins over everything.
    assert.equal(
      scope.deriveScopeFromHeaders({ 'CF-Connecting-IP': '192.168.5.44' }),
      'v4:192.168.5.0/24'
    );
    assert.equal(
      scope.deriveScopeFromHeaders({
        'CF-Connecting-IP': '10.0.0.1',
        'X-Forwarded-For': '192.168.9.9',
      }),
      'v4:10.0.0.0/24'
    );
    // Works through the Headers interface too (what the Worker passes).
    assert.equal(
      scope.deriveScopeFromHeaders(new Headers({ 'CF-Connecting-IP': '172.16.3.9' })),
      'v4:172.16.3.0/24'
    );
    // Fallback: first X-Forwarded-For entry only.
    assert.equal(
      scope.deriveScopeFromHeaders({ 'X-Forwarded-For': '192.168.7.33, 10.9.9.9' }),
      'v4:192.168.7.0/24'
    );
    assert.equal(
      scope.deriveScopeFromHeaders(new Headers({ 'x-forwarded-for': '  10.1.2.3  ' })),
      'v4:10.1.2.0/24'
    );
    // Malformed entries fall through the chain to unknown.
    assert.equal(scope.deriveScopeFromHeaders({ 'X-Forwarded-For': 'bogus' }), null);
    assert.equal(scope.deriveScopeFromHeaders({}), null);
    assert.equal(scope.deriveScopeFromHeaders(null), null);
    assert.equal(scope.deriveScopeFromHeaders(undefined), null);
    // A malformed CF header still allows the XFF fallback, then unknown.
    assert.equal(
      scope.deriveScopeFromHeaders({ 'CF-Connecting-IP': 'bogus', 'X-Forwarded-For': 'bogus' }),
      null
    );
  },

  'unknown scope parks on the quarantine key, never a real room': async () => {
    const { scope } = await workerModules();
    assert.equal(scope.scopeKeyForDO(null), 'unknown-scope');
    assert.equal(scope.scopeKeyForDO(undefined), 'unknown-scope');
    assert.equal(scope.scopeKeyForDO(''), 'unknown-scope');
    const real = scope.scopeForAddress('192.168.1.10');
    assert.notEqual(scope.scopeKeyForDO(null), scope.scopeKeyForDO(real));
    assert.equal(scope.scopeKeyForDO(real), real);
  },

  // ---- 6.2/6.5 routing stays in scope (fake sockets, real room logic) ----

  'same-scope peers discover each other with identical wire shapes': async () => {
    const { room } = await workerModules();
    const state = room.createRoomState();
    const s = 'v4:192.168.1.0/24';
    const wsA = fakeWs();
    const wsB = fakeWs();
    room.handleRegister(state, wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, s);
    assert.deepEqual(ofType(wsA, 'peer_list')[0].peers, []);
    room.handleRegister(state, wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, s);
    const list = ofType(wsB, 'peer_list')[0].peers;
    assert.equal(list.length, 1);
    assert.equal(list[0].peerId, 'A');
    const joined = ofType(wsA, 'peer_joined');
    assert.equal(joined.length, 1);
    assert.equal(joined[0].peerId, 'B');
    // Shapes are unchanged from the Node server.
    assert.deepEqual(Object.keys(ofType(wsB, 'peer_list')[0]).sort(), ['peers', 'type']);
    assert.deepEqual(Object.keys(joined[0]).sort(), ['info', 'peerId', 'type']);
  },

  'ISOLATION: different scopes never observe each other (release-blocking)': async () => {
    const { room } = await workerModules();
    const state = room.createRoomState();
    const wsA = fakeWs();
    const wsB = fakeWs();
    room.handleRegister(state, wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, 'v4:192.168.1.0/24');
    assert.deepEqual(ofType(wsA, 'peer_list')[0].peers, []);
    room.handleRegister(state, wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, 'v4:192.168.7.0/24');
    assert.deepEqual(ofType(wsB, 'peer_list')[0].peers, []);
    assert.deepEqual(ofType(wsA, 'peer_joined'), []);
    assert.deepEqual(ofType(wsB, 'peer_joined'), []);
    room.handleSignal(state, wsA, { type: 'signal', target: 'B', from: 'A', signal: { sdp: 'x' } });
    assert.deepEqual(ofType(wsB, 'signal'), []);
  },

  'signal, chat, whiteboard and typing stay within the sender scope': async () => {
    const { room } = await workerModules();
    const state = room.createRoomState();
    const s1 = 'v4:192.168.1.0/24';
    const s2 = 'v4:192.168.2.0/24';
    const wsA = fakeWs();
    const wsB = fakeWs();
    const wsC = fakeWs();
    room.handleRegister(state, wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, s1);
    room.handleRegister(state, wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, s1);
    room.handleRegister(state, wsC, { type: 'register', peerId: 'C', info: { name: 'C' } }, s2);
    wsA.sent.length = 0; wsB.sent.length = 0; wsC.sent.length = 0;

    room.handleSignal(state, wsA, { type: 'signal', target: 'B', from: 'A', signal: { sdp: 'ok' } });
    assert.equal(ofType(wsB, 'signal').length, 1);
    assert.equal(ofType(wsB, 'signal')[0].from, 'A');
    assert.deepEqual(ofType(wsC, 'signal'), []);

    room.handleChat(state, wsA, { type: 'chat', from: 'A', name: 'A', text: 'hi' });
    assert.equal(ofType(wsB, 'chat').length, 1);
    assert.equal(ofType(wsB, 'chat')[0].text, 'hi');
    assert.deepEqual(ofType(wsC, 'chat'), []);
    assert.deepEqual(ofType(wsA, 'chat'), []);

    room.handleWhiteboard(state, wsA, { type: 'whiteboard', from: 'A', event: { t: 'line' } });
    assert.equal(ofType(wsB, 'whiteboard').length, 1);
    assert.deepEqual(ofType(wsC, 'whiteboard'), []);

    room.handleTyping(state, wsA, { type: 'typing', from: 'A', name: 'A', isTyping: true });
    assert.equal(ofType(wsB, 'typing').length, 1);
    assert.deepEqual(ofType(wsC, 'typing'), []);
  },

  'pairing request and response reach only the in-scope target': async () => {
    const { room } = await workerModules();
    const state = room.createRoomState();
    const s1 = 'v4:192.168.1.0/24';
    const s2 = 'v4:192.168.2.0/24';
    const wsA = fakeWs();
    const wsB = fakeWs();
    const wsC = fakeWs();
    room.handleRegister(state, wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, s1);
    room.handleRegister(state, wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, s1);
    room.handleRegister(state, wsC, { type: 'register', peerId: 'C', info: { name: 'C' } }, s2);
    wsA.sent.length = 0; wsB.sent.length = 0; wsC.sent.length = 0;

    room.handlePairingRequest(
      state, wsA,
      { type: 'pairing_request', requestId: 'r1', to: 'B', from: 'A', fromName: 'A', fromType: 'desktop' }
    );
    const reqs = ofType(wsB, 'pairing_request');
    assert.equal(reqs.length, 1);
    assert.deepEqual(reqs[0], {
      type: 'pairing_request',
      requestId: 'r1',
      from: 'A',
      fromName: 'A',
      fromType: 'desktop',
      to: 'B',
    });
    assert.deepEqual(ofType(wsC, 'pairing_request'), []);

    room.handlePairingResponse(
      state, wsB,
      { type: 'pairing_response', requestId: 'r1', to: 'A', accepted: true }
    );
    const resps = ofType(wsA, 'pairing_response');
    assert.equal(resps.length, 1);
    assert.deepEqual(resps[0], {
      type: 'pairing_response',
      requestId: 'r1',
      to: 'A',
      accepted: true,
    });

    // Request to an absent device fails and tells the requester.
    wsA.sent.length = 0;
    assert.equal(
      room.handlePairingRequest(
        state, wsA,
        { type: 'pairing_request', requestId: 'r2', to: 'ghost', from: 'A' }
      ),
      false
    );
    const errs = ofType(wsA, 'pairing_error');
    assert.equal(errs.length, 1);
    assert.equal(errs[0].code, 'unavailable');
    assert.equal(errs[0].requestId, 'r2');

    // Cross-scope request: refused, requester told, attempt recorded.
    wsA.sent.length = 0;
    assert.equal(
      room.handlePairingRequest(
        state, wsA,
        { type: 'pairing_request', requestId: 'r3', to: 'C', from: 'A' }
      ),
      false
    );
    assert.deepEqual(ofType(wsC, 'pairing_request'), []);
    const cross = ofType(wsA, 'pairing_error');
    assert.equal(cross.length, 1);
    assert.equal(cross[0].code, 'cross_scope');
    assert.equal(state.violations.length, 1);

    // Cross-scope response: silent refusal, nothing delivered.
    wsA.sent.length = 0;
    assert.equal(
      room.handlePairingResponse(
        state, wsC,
        { type: 'pairing_response', requestId: 'r1', to: 'A', accepted: true }
      ),
      false
    );
    assert.deepEqual(ofType(wsA, 'pairing_response'), []);
  },

  'malformed registrations are refused with register_error and no state': async () => {
    const { room } = await workerModules();
    const state = room.createRoomState();
    const bad = [
      { type: 'register', info: { name: 'NoId' } },
      { type: 'register', peerId: '', info: { name: 'EmptyId' } },
      { type: 'register', peerId: 'A' },
      { type: 'register', peerId: 'A', info: { name: '' } },
      { type: 'register', peerId: 'A', info: { name: 'x'.repeat(257) } },
      { type: 'register', peerId: 'A', info: { name: 'ok', pad: 'x'.repeat(5000) } },
    ];
    for (const msg of bad) {
      const ws = fakeWs();
      assert.equal(room.handleRegister(state, ws, msg, 'v4:1.2.3.0/24'), false);
      const errs = ofType(ws, 'register_error');
      assert.equal(errs.length, 1);
      assert.equal(errs[0].code, 'invalid');
    }
    assert.equal(state.peers.size, 0);
    // A valid registration still works afterwards.
    const ws = fakeWs();
    assert.equal(
      room.handleRegister(state, ws, { type: 'register', peerId: 'A', info: { name: 'A' } }, 'v4:1.2.3.0/24'),
      true
    );
    assert.equal(ofType(ws, 'peer_list').length, 1);
  },

  'private chat reaches one recipient; failures never broadcast': async () => {
    const { room } = await workerModules();
    const state = room.createRoomState();
    const wsA = fakeWs();
    const wsB = fakeWs();
    const wsC = fakeWs();
    room.handleRegister(state, wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, 'v4:1.1.1.0/24');
    room.handleRegister(state, wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, 'v4:1.1.1.0/24');
    room.handleRegister(state, wsC, { type: 'register', peerId: 'C', info: { name: 'C' } }, 'v4:2.2.2.0/24');
    wsA.sent.length = 0; wsB.sent.length = 0; wsC.sent.length = 0;

    room.handleChat(state, wsA, { type: 'chat', from: 'A', name: 'A', text: 'secret', private: true, target: 'B' });
    assert.equal(ofType(wsB, 'chat').length, 1);
    assert.equal(ofType(wsB, 'chat')[0].private, true);
    assert.deepEqual(ofType(wsC, 'chat'), []);

    // Private to an absent device: sender told, nobody else sees anything.
    wsA.sent.length = 0; wsB.sent.length = 0;
    room.handleChat(state, wsA, { type: 'chat', from: 'A', text: 'lost', private: true, target: 'ghost' });
    assert.deepEqual(ofType(wsB, 'chat'), []);
    const errs = ofType(wsA, 'chat_error');
    assert.equal(errs.length, 1);
    assert.equal(errs[0].code, 'undeliverable');

    // Private across scopes: refused, sender told, target gets nothing.
    wsA.sent.length = 0; wsC.sent.length = 0;
    room.handleChat(state, wsA, { type: 'chat', from: 'A', text: 'leak?', private: true, target: 'C' });
    assert.deepEqual(ofType(wsC, 'chat'), []);
    assert.equal(ofType(wsA, 'chat_error').length, 1);
  },

  'heartbeat pings, counts misses, and reaps stale peers like the Node server': async () => {
    const { room } = await workerModules();
    assert.equal(room.HEARTBEAT_INTERVAL_MS, Server.HEARTBEAT_INTERVAL_MS);
    assert.equal(room.HEARTBEAT_MAX_MISSED, Server.HEARTBEAT_MAX_MISSED);
    const state = room.createRoomState();
    const wsA = fakeWs();
    const wsB = fakeWs();
    room.handleRegister(state, wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, 'v4:1.1.1.0/24');
    room.handleRegister(state, wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, 'v4:1.1.1.0/24');
    wsA.sent.length = 0; wsB.sent.length = 0;

    room.heartbeatTick(state);
    assert.equal(ofType(wsA, 'ping').length, 1);
    assert.equal(ofType(wsB, 'ping').length, 1);
    // A answers its ping; B stays silent.
    room.handleMessage(state, wsA, { type: 'pong' });
    room.heartbeatTick(state);
    assert.equal(ofType(wsA, 'ping').length, 2);
    // B exhausts its miss budget and is reaped with a scoped peer_left.
    wsA.sent.length = 0;
    room.heartbeatTick(state);
    assert.ok(!state.peers.has('B'), 'stale peer must be reaped');
    assert.ok(state.peers.has('A'), 'live peer must survive');
    const left = ofType(wsA, 'peer_left');
    assert.equal(left.length, 1);
    assert.equal(left[0].peerId, 'B');
  },

  'cross-scope relay is refused and recorded, delivering nothing': async () => {
    const { room } = await workerModules();
    const state = room.createRoomState();
    const wsA = fakeWs();
    const wsB = fakeWs();
    room.handleRegister(state, wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, 'v4:192.168.1.0/24');
    room.handleRegister(state, wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, 'v4:192.168.2.0/24');
    wsB.sent.length = 0;
    assert.equal(room.forwardTo(state, 'B', { type: 'x', n: 1 }, wsA), false);
    assert.deepEqual(wsB.sent, []);
    assert.equal(
      room.handleSignal(state, wsA, { type: 'signal', target: 'B', from: 'A', signal: {} }),
      false
    );
    assert.deepEqual(ofType(wsB, 'signal'), []);
    assert.equal(state.violations.length, 1);
    assert.equal(state.violations[0].by, 'A');
    assert.equal(state.violations[0].target, 'B');
  },

  'malformed (null-scope) peers are granted no peers, even each other': async () => {
    const { room } = await workerModules();
    const state = room.createRoomState();
    const wx = fakeWs();
    const wy = fakeWs();
    room.handleRegister(state, wx, { type: 'register', peerId: 'X', info: { name: 'X' } }, null);
    room.handleRegister(state, wy, { type: 'register', peerId: 'Y', info: { name: 'Y' } }, null);
    assert.deepEqual(ofType(wx, 'peer_list')[0].peers, []);
    assert.deepEqual(ofType(wy, 'peer_list')[0].peers, []);
    assert.deepEqual(ofType(wx, 'peer_joined'), []);
    assert.deepEqual(ofType(wy, 'peer_joined'), []);
    room.handleSignal(state, wx, { type: 'signal', target: 'Y', from: 'X', signal: {} });
    assert.deepEqual(ofType(wy, 'signal'), []);
  },

  'forged scope value in a registration message is ignored': async () => {
    const { room } = await workerModules();
    const state = room.createRoomState();
    const wsB = fakeWs();
    room.handleRegister(state, wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, 'v4:10.9.9.0/24');
    const wsA = fakeWs();
    room.handleRegister(state, wsA, {
      type: 'register', peerId: 'A', info: { name: 'A' },
      scope: 'v4:10.9.9.0/24', subnet: 'v4:10.9.9.0/24', room: 'v4:10.9.9.0/24',
    }, 'v4:192.168.1.0/24');
    assert.equal(state.peers.get('A').scope, 'v4:192.168.1.0/24');
    assert.deepEqual(ofType(wsA, 'peer_list')[0].peers, []);
    assert.deepEqual(ofType(wsB, 'peer_joined'), []);
    room.handleSignal(state, wsA, { type: 'signal', target: 'B', from: 'A', signal: {} });
    assert.deepEqual(ofType(wsB, 'signal'), []);
  },

  'peer_left is scoped and only the owning socket disconnects': async () => {
    const { room } = await workerModules();
    const state = room.createRoomState();
    const wsA = fakeWs();
    const wsB = fakeWs();
    const wsC = fakeWs();
    room.handleRegister(state, wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, 'v4:192.168.1.0/24');
    room.handleRegister(state, wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, 'v4:192.168.1.0/24');
    room.handleRegister(state, wsC, { type: 'register', peerId: 'C', info: { name: 'C' } }, 'v4:192.168.2.0/24');
    wsA.sent.length = 0; wsC.sent.length = 0;
    assert.ok(room.handleDisconnect(state, wsB, 'B'));
    assert.equal(ofType(wsA, 'peer_left').length, 1);
    assert.equal(ofType(wsA, 'peer_left')[0].peerId, 'B');
    assert.deepEqual(ofType(wsC, 'peer_left'), []);
    // A stale/superseded socket cannot delete the live registration.
    const wsB2 = fakeWs();
    room.handleRegister(state, wsB2, { type: 'register', peerId: 'B', info: { name: 'B' } }, 'v4:192.168.1.0/24');
    assert.equal(room.handleDisconnect(state, wsB, 'B'), false);
    assert.ok(state.peers.has('B'));
  },

  // ---- shared protocol: drift-proof against server.js ----

  'message type strings equal server.js (read from source, robust to drift)': async () => {
    const { protocol, room } = await workerModules();
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
    const serverTypes = new Set();
    for (const m of serverSrc.matchAll(/\btype\s*:\s*['"]([^'"]+)['"]/g)) {
      serverTypes.add(m[1]);
    }
    assert.ok(serverTypes.size > 0, 'expected to extract message types from server.js');
    const workerValues = new Set(Object.values(protocol.MESSAGE_TYPES));
    for (const t of serverTypes) {
      assert.ok(
        workerValues.has(t),
        `server.js sends ${JSON.stringify(t)} but worker/protocol.js has no identical string`
      );
    }
    // Core presence shapes must exist on both sides with identical spelling.
    for (const t of ['peer_list', 'peer_joined', 'peer_left', 'signal', 'chat']) {
      assert.ok(serverTypes.has(t), `server.js should send ${t}`);
      assert.ok(workerValues.has(t), `worker should send ${t}`);
    }
    // The Worker may only add the client-originated register shape on top of
    // what the server sends; anything else is silent drift.
    const allowedExtras = new Set(['register']);
    for (const t of workerValues) {
      assert.ok(
        serverTypes.has(t) || allowedExtras.has(t),
        `worker message type ${JSON.stringify(t)} is in neither server.js nor the allowed upcoming contract`
      );
    }
    // room.js and worker.js must use the constants, not inline copies that
    // could diverge character by character.
    // NOTE (source-level assertion): Node cannot run the Worker, so spelling
    // discipline is enforced textually here and documented as such.
    for (const f of ['room.js', 'worker.js']) {
      const src = readSource(f);
      const inline = [...src.matchAll(/\btype\s*:\s*['"]/g)];
      assert.deepEqual(inline, [], `${f} must use protocol.js constants, found inline message type strings`);
    }
    assert.ok(Object.isFrozen(protocol.MESSAGE_TYPES), 'MESSAGE_TYPES must be frozen');
  },

  // ---- 6.3 hibernation is mandatory ----

  'hibernation accept path is the only path (source-level: no DO runtime in Node)': () => {
    // NOTE (source-level assertion, documented as such): Node has no Durable
    // Object runtime, so the hibernation guarantee is enforced by inspecting
    // worker/worker.js textually. The behavioral half -- the startup
    // assertion throwing without the API -- is executed for real below.
    const src = readSource('worker.js');
    assert.ok(src.includes('acceptWebSocket'), 'worker.js must use acceptWebSocket');
    assert.ok(src.includes('webSocketMessage'), 'worker.js must implement webSocketMessage');
    assert.ok(src.includes('webSocketClose'), 'worker.js must implement webSocketClose');
    assert.ok(src.includes('assertHibernationInUse'), 'worker.js must gate on the startup assertion');
    const bareAccept = src.match(/\.accept\s*\(/g) || [];
    assert.deepEqual(bareAccept, [], 'worker.js must not use the non-hibernating accept path');
  },

  'startup assertion fails loudly without the hibernation API': async () => {
    const { worker } = await workerModules();
    assert.equal(worker.assertHibernationInUse({ acceptWebSocket() {} }), true);
    for (const bad of [null, undefined, {}, { acceptWebSocket: 42 }, { acceptWebSocket: null }]) {
      assert.throws(() => worker.assertHibernationInUse(bad), 'assertion must throw without the API');
    }
    // The room itself refuses to construct without the API ...
    assert.throws(() => new worker.ScopeRoom({}, {}), 'ScopeRoom must throw without hibernation');
    // ... and rebuilds its in-memory roster from attachments when present.
    const wsA = fakeWs();
    wsA.serializeAttachment({ peerId: 'A', scope: 'v4:1.2.3.0/24', info: { name: 'A' } });
    const goodCtx = {
      acceptWebSocket() {},
      getWebSockets: () => [wsA],
    };
    const roomDO = new worker.ScopeRoom(goodCtx, {});
    assert.equal(roomDO.state.peers.size, 1);
    assert.equal(roomDO.state.peers.get('A').scope, 'v4:1.2.3.0/24');
  },

  // ---- 6.4 duration observability ----

  'duration math documented matches the constants used': async () => {
    const { worker } = await workerModules();
    assert.equal(worker.DURATION_ALLOWANCE_OBJECT_SECONDS, 104000);
    assert.equal(worker.SECONDS_PER_DAY, 86400);
    assert.equal(
      worker.MAX_ALWAYS_ON_ROOMS,
      Math.floor(worker.DURATION_ALLOWANCE_OBJECT_SECONDS / worker.SECONDS_PER_DAY)
    );
    assert.equal(worker.MAX_ALWAYS_ON_ROOMS, 1);
    assert.equal(worker.HIBERNATION_ENABLED, true);
    const readme = fs.readFileSync(path.join(WORKER_DIR, 'README.md'), 'utf8');
    assert.ok(readme.includes('104,000'), 'README must state the 104,000 object-second allowance');
    assert.ok(readme.includes('86,400'), 'README must state the 86,400 always-on cost');
    assert.ok(/29 hour/.test(readme), 'README must state the ~29-hour math');
  },

  'current usage is observable via status snapshots': async () => {
    const { room, worker } = await workerModules();
    const state = room.createRoomState();
    const wsA = fakeWs();
    const wsB = fakeWs();
    room.handleRegister(state, wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, 'v4:1.1.1.0/24');
    room.handleRegister(state, wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, 'v4:2.2.2.0/24');
    room.handleSignal(state, wsA, { type: 'signal', target: 'B', from: 'A', signal: {} });
    const roomStatus = room.buildRoomStatus(state);
    assert.equal(roomStatus.peerCount, 2);
    assert.deepEqual(roomStatus.scopes, ['v4:1.1.1.0/24', 'v4:2.2.2.0/24']);
    assert.equal(roomStatus.violations, 1);
    const st = worker.buildWorkerStatus({
      startedAtMs: 1000,
      nowMs: 6000,
      accepted: 7,
      distinctScopes: 3,
    });
    assert.equal(st.ok, true);
    assert.equal(st.uptimeMs, 5000);
    assert.equal(st.connectionsAccepted, 7);
    assert.equal(st.distinctScopesSeen, 3);
    assert.equal(st.hibernation.enabled, true);
    assert.equal(st.duration.allowanceObjectSecondsPerDay, 104000);
    assert.equal(st.duration.maxAlwaysOnRooms, 1);
  },

  // ---- no persisted state ----

  'no persisted state: memory only, no storage writes (source-level)': () => {
    // NOTE (source-level assertion, documented as such): absence of storage
    // calls is enforced textually because no DO runtime exists in Node.
    for (const f of ['protocol.js', 'scope.js', 'room.js', 'worker.js']) {
      const src = readSource(f);
      assert.deepEqual(src.match(/\.storage\b/g) || [], [], `${f} must not touch DO storage`);
      assert.deepEqual(
        src.match(/\bstorage\s*\.\s*(put|get|delete|list|transaction)\b/g) || [],
        [],
        `${f} must not write stored rows`
      );
    }
    assert.ok(/new Map\(\)/.test(readSource('room.js')), 'room.js must hold membership in a memory Map');
    const readme = fs.readFileSync(path.join(WORKER_DIR, 'README.md'), 'utf8');
    assert.ok(/no persisted state/i.test(readme), 'README must state that no state is persisted');
    assert.ok(/in-memory/i.test(readme), 'README must state membership is in-memory');
  },

  // ---- 6.1 independent deployable ----

  'worker is an independent deployable: configs parse, entry resolves': async () => {
    const { worker } = await workerModules();
    const wrangler = JSON.parse(fs.readFileSync(path.join(WORKER_DIR, 'wrangler.json'), 'utf8'));
    assert.equal(wrangler.main, 'worker.js');
    assert.ok(
      fs.existsSync(path.join(WORKER_DIR, wrangler.main)),
      'wrangler main must exist in worker/'
    );
    assert.ok(!Number.isNaN(Date.parse(wrangler.compatibility_date)), 'compatibility_date must parse');
    const bindings = wrangler.durable_objects && wrangler.durable_objects.bindings;
    assert.ok(
      (bindings || []).some((b) => b.name === 'SCOPE_ROOM' && b.class_name === 'ScopeRoom'),
      'wrangler must bind SCOPE_ROOM to ScopeRoom'
    );
    const migs = wrangler.migrations || [];
    assert.ok(
      migs.some((m) => (m.new_sqlite_classes || []).includes('ScopeRoom')),
      'migrations must register the SQLite-backed ScopeRoom class'
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(WORKER_DIR, 'package.json'), 'utf8'));
    assert.equal(pkg.type, 'module');
    assert.ok(
      String(pkg.scripts && pkg.scripts.deploy).includes('wrangler'),
      'worker must deploy via wrangler, not the Pages bundle'
    );
    assert.equal(typeof worker.ScopeRoom, 'function');
    assert.equal(typeof worker.default.fetch, 'function');
    const readme = fs.readFileSync(path.join(WORKER_DIR, 'README.md'), 'utf8');
    assert.ok(readme.includes('wrangler deploy'), 'README must document deploy steps');
    assert.ok(readme.includes('/status'), 'README must document the status route');
  },
};

module.exports = { name: 'worker', tests };
