// tests/server.test.js
// Covers the immediately-doable tasks from the signaling-rooms and
// static-mode-trust changes: scope derivation + partitioning, path
// confinement, and the startup banner. Uses the REAL handlers exported from
// server/server.js (never a reimplementation) with small fake sockets, plus
// one real-`ws` integration test for same-scope discovery.

'use strict';

const assert = require('./assert');
const path = require('path');
const http = require('http');
const Server = require('../server/server.js');

function fakeWs(remoteAddress) {
  return {
    readyState: 1,
    sent: [],
    _socket: { remoteAddress },
    send(data) {
      this.sent.push(JSON.parse(data));
    },
  };
}

function reset() {
  Server._resetPeersForTests();
}

function ofType(ws, type) {
  return ws.sent.filter((m) => m.type === type);
}

function httpGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('http timeout')));
  });
}

function withEphemeralServer(fn) {
  return new Promise((resolve, reject) => {
    const srv = Server.httpServer;
    const done = (err) => {
      srv.close(() => (err ? reject(err) : resolve()));
    };
    srv.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port;
      try {
        await fn(port);
        done(null);
      } catch (err) {
        done(err);
      }
    });
  });
}

function waitFor(cond, timeoutMs = 2000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      let ok = false;
      try {
        ok = cond();
      } catch (e) {
        reject(e);
        return;
      }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(poll, 25);
    })();
  });
}

const tests = {
  // ---- scopeForAddress ----

  'IPv4 addresses in the same /24 share a scope': () => {
    reset();
    assert.equal(Server.scopeForAddress('192.168.1.10'), 'v4:192.168.1.0/24');
    assert.equal(Server.scopeForAddress('192.168.1.200'), 'v4:192.168.1.0/24');
  },

  'IPv4 addresses in different /24s get different scopes': () => {
    reset();
    assert.equal(Server.scopeForAddress('192.168.1.10'), 'v4:192.168.1.0/24');
    assert.equal(Server.scopeForAddress('192.168.2.10'), 'v4:192.168.2.0/24');
    assert.notEqual(
      Server.scopeForAddress('192.168.1.10'),
      Server.scopeForAddress('192.168.2.10')
    );
  },

  'private and public ranges all derive /24 scopes': () => {
    reset();
    assert.equal(Server.scopeForAddress('10.0.5.6'), 'v4:10.0.5.0/24');
    assert.equal(Server.scopeForAddress('172.16.0.5'), 'v4:172.16.0.0/24');
    assert.equal(Server.scopeForAddress('8.8.8.8'), 'v4:8.8.8.0/24');
    assert.equal(Server.scopeForAddress('8.8.8.9'), 'v4:8.8.8.0/24');
    assert.notEqual(Server.scopeForAddress('8.8.8.8'), Server.scopeForAddress('8.8.4.4'));
  },

  'IPv6 addresses in the same /64 share a scope': () => {
    reset();
    assert.equal(Server.scopeForAddress('fe80::1'), Server.scopeForAddress('fe80::abcd'));
    assert.equal(Server.scopeForAddress('2001:db8:1:2::1'), 'v6:2001:db8:1:2/64');
  },

  'IPv6 addresses in different /64s get different scopes': () => {
    reset();
    assert.notEqual(
      Server.scopeForAddress('2001:db8:1:2::1'),
      Server.scopeForAddress('2001:db8:1:3::1')
    );
  },

  'compressed and expanded IPv6 forms agree': () => {
    reset();
    assert.equal(
      Server.scopeForAddress('2001:0db8:0001:0002:0000:0000:0000:0001'),
      Server.scopeForAddress('2001:db8:1:2::1')
    );
  },

  'IPv4-mapped IPv6 maps to the IPv4 scope': () => {
    reset();
    assert.equal(
      Server.scopeForAddress('::ffff:192.168.1.10'),
      Server.scopeForAddress('192.168.1.10')
    );
  },

  'malformed input yields an isolated scope and never throws': () => {
    reset();
    const bad = ['', '   ', 'not-an-ip', '999.1.1.1', '1.2.3', '1.2.3.4.5',
      'fe80:::1', ':::1', '::ffff::1', 12345, null, undefined, {}];
    for (const v of bad) {
      assert.equal(Server.scopeForAddress(v), null, `expected null for ${JSON.stringify(v)}`);
    }
    // A valid address with a zone id still works.
    assert.equal(Server.scopeForAddress('fe80::1%eth0'), 'v6:fe80:0:0:0/64');
  },

  'malformed peers are granted no peers': () => {
    reset();
    const wx = fakeWs('not-an-ip');
    const wy = fakeWs('999.999.999.999');
    Server.handleRegister(wx, { type: 'register', peerId: 'X', info: { name: 'X' } }, 'not-an-ip');
    Server.handleRegister(wy, { type: 'register', peerId: 'Y', info: { name: 'Y' } }, '999.999.999.999');
    assert.deepEqual(ofType(wx, 'peer_list')[0].peers, []);
    assert.deepEqual(ofType(wy, 'peer_list')[0].peers, []);
    assert.deepEqual(ofType(wx, 'peer_joined'), []);
    assert.deepEqual(ofType(wy, 'peer_joined'), []);
    Server.handleSignal(wx, { type: 'signal', target: 'Y', from: 'X', signal: { sdp: 'x' } });
    assert.deepEqual(ofType(wy, 'signal'), []);
  },

  // ---- partitioning (real registry code path) ----

  'ISOLATION: different scopes never observe each other (release-blocking)': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    const wsB = fakeWs('192.168.7.10');
    // Register A in scope 1.
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    // A's own peer_list is empty (nobody else in its scope yet).
    assert.deepEqual(ofType(wsA, 'peer_list')[0].peers, []);
    // Register B in scope 2.
    Server.handleRegister(wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, '192.168.7.10');
    // B's peer_list is empty: it must not see A across scopes.
    assert.deepEqual(ofType(wsB, 'peer_list')[0].peers, []);
    // B never receives peer_joined... more precisely A must never observe B:
    // A receives no peer_joined for B.
    assert.deepEqual(ofType(wsA, 'peer_joined'), []);
    // ...and symmetrically B observes nothing about A.
    assert.deepEqual(ofType(wsB, 'peer_joined'), []);
    // A direct signal A->B is not delivered across scopes.
    Server.handleSignal(wsA, { type: 'signal', target: 'B', from: 'A', signal: { sdp: 'hello' } });
    assert.deepEqual(ofType(wsB, 'signal'), []);
    // NOTE: with the partitioning removed (flat broadcast / unscoped
    // forwardTo), B's peer_list would contain A, A would receive peer_joined
    // for B, and the signal would be delivered -- so every assertion above
    // fails on the unpartitioned code.
  },

  'forged scope value in a registration message is ignored': () => {
    reset();
    const wsB = fakeWs('10.9.9.5');
    Server.handleRegister(wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, '10.9.9.5');
    const wsA = fakeWs('192.168.1.10');
    Server.handleRegister(wsA, {
      type: 'register', peerId: 'A', info: { name: 'A' },
      scope: 'v4:10.9.9.0/24', subnet: 'v4:10.9.9.0/24', room: 'v4:10.9.9.0/24',
    }, '192.168.1.10');
    // Server-side scope wins over anything the client sent.
    assert.equal(Server.peers.get('A').scope, Server.scopeForAddress('192.168.1.10'));
    assert.deepEqual(ofType(wsA, 'peer_list')[0].peers, []);
    assert.deepEqual(ofType(wsB, 'peer_joined'), []);
    Server.handleSignal(wsA, { type: 'signal', target: 'B', from: 'A', signal: {} });
    assert.deepEqual(ofType(wsB, 'signal'), []);
  },

  'same-scope discovery works with zero configuration': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    const wsB = fakeWs('192.168.1.77');
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    assert.deepEqual(ofType(wsA, 'peer_list')[0].peers, []);
    Server.handleRegister(wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, '192.168.1.77');
    // B learns about A via peer_list.
    const list = ofType(wsB, 'peer_list')[0].peers;
    assert.equal(list.length, 1);
    assert.equal(list[0].peerId, 'A');
    // A learns about B via peer_joined.
    const joined = ofType(wsA, 'peer_joined');
    assert.equal(joined.length, 1);
    assert.equal(joined[0].peerId, 'B');
  },

  'signal relay stays within the sender scope': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    const wsB = fakeWs('192.168.1.11');
    const wsC = fakeWs('192.168.2.10');
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    Server.handleRegister(wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, '192.168.1.11');
    Server.handleRegister(wsC, { type: 'register', peerId: 'C', info: { name: 'C' } }, '192.168.2.10');
    wsB.sent.length = 0;
    wsC.sent.length = 0;
    Server.handleSignal(wsA, { type: 'signal', target: 'B', from: 'A', signal: { sdp: 'ok' } });
    assert.equal(ofType(wsB, 'signal').length, 1);
    assert.equal(ofType(wsB, 'signal')[0].from, 'A');
    Server.handleSignal(wsA, { type: 'signal', target: 'C', from: 'A', signal: { sdp: 'no' } });
    assert.deepEqual(ofType(wsC, 'signal'), []);
  },

  'chat relay stays within the sender scope': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    const wsB = fakeWs('192.168.1.11');
    const wsC = fakeWs('192.168.9.9');
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    Server.handleRegister(wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, '192.168.1.11');
    Server.handleRegister(wsC, { type: 'register', peerId: 'C', info: { name: 'C' } }, '192.168.9.9');
    wsA.sent.length = 0; wsB.sent.length = 0; wsC.sent.length = 0;
    Server.handleChat(wsA, { type: 'chat', from: 'A', name: 'A', text: 'hi' });
    assert.equal(ofType(wsB, 'chat').length, 1);
    assert.equal(ofType(wsB, 'chat')[0].text, 'hi');
    assert.deepEqual(ofType(wsC, 'chat'), []);
    assert.deepEqual(ofType(wsA, 'chat'), []);
  },

  'peer_left is scoped to the departed peer scope': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    const wsB = fakeWs('192.168.1.11');
    const wsC = fakeWs('192.168.2.10');
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    Server.handleRegister(wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, '192.168.1.11');
    Server.handleRegister(wsC, { type: 'register', peerId: 'C', info: { name: 'C' } }, '192.168.2.10');
    wsA.sent.length = 0; wsC.sent.length = 0;
    assert.ok(Server.handleDisconnect(wsB, 'B'));
    assert.equal(ofType(wsA, 'peer_left').length, 1);
    assert.equal(ofType(wsA, 'peer_left')[0].peerId, 'B');
    assert.deepEqual(ofType(wsC, 'peer_left'), []);
  },

  'scoped forwardTo refuses cross-scope delivery': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    const wsB = fakeWs('192.168.2.10');
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    Server.handleRegister(wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, '192.168.2.10');
    wsB.sent.length = 0;
    assert.equal(Server.forwardTo('B', { type: 'x', n: 1 }, wsA), false);
    assert.deepEqual(wsB.sent, []);
  },

  'peersInScope computes the recipient set': () => {
    reset();
    const wsA = fakeWs('10.0.0.1');
    const wsB = fakeWs('10.0.0.2');
    const wsC = fakeWs('10.0.1.9');
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '10.0.0.1');
    Server.handleRegister(wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, '10.0.0.2');
    Server.handleRegister(wsC, { type: 'register', peerId: 'C', info: { name: 'C' } }, '10.0.1.9');
    const scope = Server.scopeForAddress('10.0.0.1');
    const ids = Server.peersInScope(scope, 'A').map((p) => p.peerId);
    assert.deepEqual(ids, ['B']);
    assert.deepEqual(Server.peersInScope(null, 'A'), []);
    assert.deepEqual(Server.peersInScope('v4:1.2.3.0/24', 'nobody'), []);
  },

  // ---- path confinement ----

  'nested legitimate paths resolve inside the root': () => {
    reset();
    const root = path.join('tmp-root-check');
    const got = Server.resolveWithinRoot(root, '/sub/dir/file.js');
    assert.equal(got, path.resolve(root, 'sub/dir/file.js'));
    assert.ok(Server.isPathWithinRoot(root, got));
  },

  'relative segments escaping the root are refused': () => {
    reset();
    const root = path.resolve('tmp-root-check');
    assert.equal(Server.resolveWithinRoot(root, '/../secret.txt'), null);
    assert.equal(Server.resolveWithinRoot(root, '/a/../../secret.txt'), null);
    assert.equal(Server.resolveWithinRoot(root, '../../etc/passwd'), null);
  },

  'encoded separators are refused': () => {
    reset();
    const root = path.resolve('tmp-root-check');
    assert.equal(Server.resolveWithinRoot(root, '/%2e%2e/secret.txt'), null);
    assert.equal(Server.resolveWithinRoot(root, '/%2e%2e%2fsecret.txt'), null);
    assert.equal(Server.resolveWithinRoot(root, '/..%2f..%2fetc%2fpasswd'), null);
  },

  'absolute paths never resolve outside': () => {
    reset();
    const root = path.resolve('tmp-root-check');
    const got = Server.resolveWithinRoot(root, '/etc/passwd');
    // Neutralised to inside-the-root (or refused); never the real /etc/passwd.
    assert.notEqual(got, '/etc/passwd');
    if (got !== null) assert.ok(Server.isPathWithinRoot(root, got));
  },

  'sibling with a shared name prefix fails the prefix check': () => {
    reset();
    const root = path.resolve('tmp-root-check', 'client');
    const sibling = path.join(path.resolve('tmp-root-check'), 'client-evil', 'secret.txt');
    // A naive startsWith(root) check would wrongly pass here...
    assert.ok(sibling.startsWith(root));
    // ...but the separator-aware check refuses it.
    assert.equal(Server.isPathWithinRoot(root, sibling), false);
    assert.equal(Server.resolveWithinRoot(root, '../client-evil/secret.txt'), null);
  },

  'malformed encoding and null bytes are refused': () => {
    reset();
    const root = path.resolve('tmp-root-check');
    assert.equal(Server.resolveWithinRoot(root, '/%ZZ'), null);
    assert.equal(Server.resolveWithinRoot(root, '/a\0b'), null);
  },

  'HTTP: traversal refused without path echo, legit path served': async () => {
    reset();
    await withEphemeralServer(async (port) => {
      const bad = await httpGet(port, '/..%2f..%2fetc%2fpasswd');
      assert.ok(bad.status === 403 || bad.status === 404, `expected 403/404, got ${bad.status}`);
      assert.ok(bad.body === 'Forbidden' || bad.body === 'Not Found', `unexpected body ${JSON.stringify(bad.body)}`);
      assert.notOk(bad.body.includes('etc'));
      assert.notOk(bad.body.includes('passwd'));
      const good = await httpGet(port, '/index.html');
      assert.equal(good.status, 200);
      assert.ok(good.body.length > 0);
    });
  },

  // ---- startup banner ----

  'startup banner reports the LAN URL and the active mode': () => {
    reset();
    const banner = Server.formatStartupBanner(3000, '192.168.1.5');
    assert.ok(banner.includes('http://192.168.1.5:3000'));
    assert.ok(banner.includes('http://localhost:3000'));
    assert.ok(/mode/i.test(banner));
    assert.ok(banner.includes('signaling'));
    assert.notOk(banner.includes('undefined'));
  },

  'startup banner reports a missing network instead of an unusable address': () => {
    reset();
    const banner = Server.formatStartupBanner(3000, null);
    assert.ok(/no non-loopback/i.test(banner));
    assert.notOk(banner.includes('undefined'));
    assert.notOk(/http:\/\/undefined/.test(banner));
    const also = Server.formatStartupBanner(3000, Server.getLocalIp() || null);
    assert.notOk(also.includes('undefined'));
  },

  'getLocalIp never returns undefined and no implicit global leaks': () => {
    reset();
    const ip = Server.getLocalIp();
    assert.ok(ip === null || typeof ip === 'string');
    assert.notEqual(ip, undefined);
    assert.equal(global.hostIP, undefined);
  },

  // ---- pairing relay (stateless pure relay) ----

  'pairing request delivered only to target': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    const wsB = fakeWs('192.168.1.11');
    const wsC = fakeWs('192.168.1.12');
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    Server.handleRegister(wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, '192.168.1.11');
    Server.handleRegister(wsC, { type: 'register', peerId: 'C', info: { name: 'C' } }, '192.168.1.12');
    wsA.sent.length = 0; wsB.sent.length = 0; wsC.sent.length = 0;
    Server.handlePairingRequest(wsA, {
      type: 'pairing_request', requestId: 'r1', from: 'A', fromName: 'A', fromType: 'laptop', to: 'B',
    });
    assert.equal(ofType(wsB, 'pairing_request').length, 1);
    assert.equal(ofType(wsB, 'pairing_request')[0].requestId, 'r1');
    assert.equal(ofType(wsB, 'pairing_request')[0].from, 'A');
    // Nobody else receives it, and the sender gets no error.
    assert.deepEqual(ofType(wsC, 'pairing_request'), []);
    assert.deepEqual(ofType(wsA, 'pairing_request'), []);
    assert.deepEqual(ofType(wsA, 'pairing_error'), []);
  },

  'pairing request to absent peer => pairing_error unavailable': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    wsA.sent.length = 0;
    Server.handlePairingRequest(wsA, {
      type: 'pairing_request', requestId: 'r2', from: 'A', fromName: 'A', fromType: 'laptop', to: 'GHOST',
    });
    const errs = ofType(wsA, 'pairing_error');
    assert.equal(errs.length, 1);
    assert.equal(errs[0].requestId, 'r2');
    assert.equal(errs[0].code, 'unavailable');
  },

  'cross-scope pairing request => pairing_error cross_scope + no delivery': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    const wsZ = fakeWs('192.168.2.10');
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    Server.handleRegister(wsZ, { type: 'register', peerId: 'Z', info: { name: 'Z' } }, '192.168.2.10');
    wsA.sent.length = 0; wsZ.sent.length = 0;
    Server.handlePairingRequest(wsA, {
      type: 'pairing_request', requestId: 'r3', from: 'A', fromName: 'A', fromType: 'laptop', to: 'Z',
    });
    const errs = ofType(wsA, 'pairing_error');
    assert.equal(errs.length, 1);
    assert.equal(errs[0].requestId, 'r3');
    assert.equal(errs[0].code, 'cross_scope');
    assert.deepEqual(ofType(wsZ, 'pairing_request'), []);
  },

  'pairing response relayed only to target in same scope': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    const wsB = fakeWs('192.168.1.11');
    const wsC = fakeWs('192.168.1.12');
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    Server.handleRegister(wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, '192.168.1.11');
    Server.handleRegister(wsC, { type: 'register', peerId: 'C', info: { name: 'C' } }, '192.168.1.12');
    wsA.sent.length = 0; wsB.sent.length = 0; wsC.sent.length = 0;
    Server.handlePairingResponse(wsB, { type: 'pairing_response', requestId: 'r1', to: 'A', accepted: true });
    assert.equal(ofType(wsA, 'pairing_response').length, 1);
    assert.equal(ofType(wsA, 'pairing_response')[0].accepted, true);
    assert.equal(ofType(wsA, 'pairing_response')[0].requestId, 'r1');
    assert.deepEqual(ofType(wsC, 'pairing_response'), []);
    // Cross-scope response is dropped silently.
    const wsZ = fakeWs('192.168.2.10');
    Server.handleRegister(wsZ, { type: 'register', peerId: 'Z', info: { name: 'Z' } }, '192.168.2.10');
    wsA.sent.length = 0; wsZ.sent.length = 0;
    Server.handlePairingResponse(wsZ, { type: 'pairing_response', requestId: 'r9', to: 'A', accepted: true });
    assert.deepEqual(ofType(wsA, 'pairing_response'), []);
  },

  'server holds no pairing request state after exchange': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    const wsB = fakeWs('192.168.1.11');
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    Server.handleRegister(wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, '192.168.1.11');
    Server.handlePairingRequest(wsA, {
      type: 'pairing_request', requestId: 'r1', from: 'A', fromName: 'A', fromType: 'laptop', to: 'B',
    });
    Server.handlePairingResponse(wsB, { type: 'pairing_response', requestId: 'r1', to: 'A', accepted: false });
    // Registry holds only the two peer entries — no request entries.
    assert.equal(Server.peers.size, 2);
    assert.deepEqual([...Server.peers.keys()].sort(), ['A', 'B']);
    for (const [, peer] of Server.peers.entries()) {
      assert.deepEqual(Object.keys(peer).sort(), ['info', 'scope', 'ws']);
    }
    assert.equal(wsA._pendingRequests, undefined);
    assert.equal(wsB._pendingRequests, undefined);
  },

  // ---- confidential chat ----

  'private chat delivered only to target': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    const wsB = fakeWs('192.168.1.11');
    const wsC = fakeWs('192.168.1.12');
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    Server.handleRegister(wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, '192.168.1.11');
    Server.handleRegister(wsC, { type: 'register', peerId: 'C', info: { name: 'C' } }, '192.168.1.12');
    wsA.sent.length = 0; wsB.sent.length = 0; wsC.sent.length = 0;
    Server.handleChat(wsA, { type: 'chat', from: 'A', name: 'A', text: 'secret', private: true, target: 'B' });
    assert.equal(ofType(wsB, 'chat').length, 1);
    assert.equal(ofType(wsB, 'chat')[0].text, 'secret');
    assert.deepEqual(ofType(wsC, 'chat'), []);
    assert.deepEqual(ofType(wsA, 'chat'), []);
    assert.deepEqual(ofType(wsA, 'chat_error'), []);
  },

  'private chat to absent peer => chat_error + zero deliveries': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    const wsB = fakeWs('192.168.1.11');
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    Server.handleRegister(wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, '192.168.1.11');
    wsA.sent.length = 0; wsB.sent.length = 0;
    Server.handleChat(wsA, { type: 'chat', from: 'A', name: 'A', text: 'lost', private: true, target: 'GHOST' });
    const errs = ofType(wsA, 'chat_error');
    assert.equal(errs.length, 1);
    assert.equal(errs[0].code, 'undeliverable');
    // Nothing delivered anywhere: no fallback, nothing in any inbox.
    for (const ws of [wsA, wsB]) {
      assert.deepEqual(ofType(ws, 'chat'), []);
    }
  },

  'private chat never crosses scopes': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    const wsZ = fakeWs('192.168.2.10');
    const wsB = fakeWs('192.168.1.11');
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    Server.handleRegister(wsZ, { type: 'register', peerId: 'Z', info: { name: 'Z' } }, '192.168.2.10');
    Server.handleRegister(wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, '192.168.1.11');
    wsA.sent.length = 0; wsZ.sent.length = 0; wsB.sent.length = 0;
    Server.handleChat(wsA, { type: 'chat', from: 'A', name: 'A', text: 'x-secret', private: true, target: 'Z' });
    assert.equal(ofType(wsA, 'chat_error').length, 1);
    assert.equal(ofType(wsA, 'chat_error')[0].code, 'undeliverable');
    assert.deepEqual(ofType(wsZ, 'chat'), []);
    assert.deepEqual(ofType(wsB, 'chat'), []);
  },

  'non-private chat still broadcasts in scope': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    const wsB = fakeWs('192.168.1.11');
    const wsZ = fakeWs('192.168.2.10');
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    Server.handleRegister(wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, '192.168.1.11');
    Server.handleRegister(wsZ, { type: 'register', peerId: 'Z', info: { name: 'Z' } }, '192.168.2.10');
    wsA.sent.length = 0; wsB.sent.length = 0; wsZ.sent.length = 0;
    Server.handleChat(wsA, { type: 'chat', from: 'A', name: 'A', text: 'hello all' });
    assert.equal(ofType(wsB, 'chat').length, 1);
    assert.deepEqual(ofType(wsZ, 'chat'), []);
  },

  // ---- registration validation ----

  'malformed register refused and app stays functional': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    const wsB = fakeWs('192.168.1.11');
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    wsA.sent.length = 0;
    const bad1 = fakeWs('192.168.1.99');
    Server.handleRegister(bad1, { type: 'register', info: { name: 'NoId' } }, '192.168.1.99');
    assert.equal(ofType(bad1, 'register_error').length, 1);
    assert.equal(ofType(bad1, 'register_error')[0].code, 'invalid');
    const bad2 = fakeWs('192.168.1.100');
    Server.handleRegister(bad2, { type: 'register', peerId: 'NONAME' }, '192.168.1.100');
    assert.equal(ofType(bad2, 'register_error').length, 1);
    // Refused peers were not added and triggered no presence.
    assert.notOk(Server.peers.has('NONAME'));
    assert.equal(Server.peers.size, 1);
    assert.deepEqual(ofType(wsA, 'peer_joined'), []);
    // Existing session unaffected: B can still join and chat works.
    Server.handleRegister(wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, '192.168.1.11');
    assert.equal(ofType(wsB, 'peer_list')[0].peers.length, 1);
    wsA.sent.length = 0; wsB.sent.length = 0;
    Server.handleChat(wsA, { type: 'chat', from: 'A', name: 'A', text: 'still here' });
    assert.equal(ofType(wsB, 'chat').length, 1);
  },

  'oversized register refused': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    const bigName = 'n'.repeat(257);
    Server.handleRegister(wsA, { type: 'register', peerId: 'BIG', info: { name: bigName } }, '192.168.1.10');
    assert.equal(ofType(wsA, 'register_error').length, 1);
    assert.notOk(Server.peers.has('BIG'));
    const wsB = fakeWs('192.168.1.11');
    const fatInfo = { name: 'ok', blob: 'x'.repeat(5000) };
    Server.handleRegister(wsB, { type: 'register', peerId: 'FAT', info: fatInfo }, '192.168.1.11');
    assert.equal(ofType(wsB, 'register_error').length, 1);
    assert.notOk(Server.peers.has('FAT'));
    assert.equal(Server.peers.size, 0);
    // Boundary: 256-char name and small payload are accepted.
    const wsC = fakeWs('192.168.1.12');
    const ok = Server.handleRegister(wsC, { type: 'register', peerId: 'OK', info: { name: 'n'.repeat(256) } }, '192.168.1.12');
    assert.equal(ok, true);
    assert.ok(Server.peers.has('OK'));
  },

  // ---- heartbeat / stale peers ----

  'heartbeat removes silent peer and emits peer_left in scope only': () => {
    reset();
    const wsA = fakeWs('192.168.1.10');
    const wsB = fakeWs('192.168.1.11');
    const wsZ = fakeWs('192.168.2.10');
    Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    Server.handleRegister(wsB, { type: 'register', peerId: 'B', info: { name: 'B' } }, '192.168.1.11');
    Server.handleRegister(wsZ, { type: 'register', peerId: 'Z', info: { name: 'Z' } }, '192.168.2.10');
    wsA.sent.length = 0; wsB.sent.length = 0; wsZ.sent.length = 0;
    // Tick 1: everyone gets a ping.
    Server.heartbeatTick();
    assert.equal(ofType(wsA, 'ping').length, 1);
    assert.equal(ofType(wsB, 'ping').length, 1);
    assert.equal(ofType(wsZ, 'ping').length, 1);
    // A and Z answer; B stays silent.
    Server.handlePong(wsA);
    Server.handlePong(wsZ);
    wsA.sent.length = 0; wsB.sent.length = 0; wsZ.sent.length = 0;
    // Tick 2: B misses its 2nd pong window only after one more tick;
    // drive until the reaper fires (misses >= 2).
    Server.heartbeatTick();
    Server.handlePong(wsA);
    Server.handlePong(wsZ);
    wsA.sent.length = 0; wsZ.sent.length = 0;
    const bPingsBefore = ofType(wsB, 'ping').length;
    assert.ok(bPingsBefore >= 1);
    wsB.sent.length = 0;
    Server.heartbeatTick();
    // B is gone; A (same scope) was told, Z (other scope) was not.
    assert.notOk(Server.peers.has('B'));
    assert.ok(Server.peers.has('A'));
    assert.ok(Server.peers.has('Z'));
    assert.equal(ofType(wsA, 'peer_left').length, 1);
    assert.equal(ofType(wsA, 'peer_left')[0].peerId, 'B');
    assert.deepEqual(ofType(wsZ, 'peer_left'), []);
  },

  'heartbeat uses a 30s interval and is drivable with fake timers': () => {
    reset();
    const realSetInterval = global.setInterval;
    const realClearInterval = global.clearInterval;
    let capturedFn = null;
    let capturedMs = null;
    global.setInterval = (fn, ms) => {
      capturedFn = fn;
      capturedMs = ms;
      return { unref() {} };
    };
    global.clearInterval = () => {};
    try {
      Server.startHeartbeat();
      assert.equal(capturedMs, 30000);
      assert.ok(typeof capturedFn === 'function');
      const wsA = fakeWs('192.168.1.10');
      Server.handleRegister(wsA, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
      wsA.sent.length = 0;
      capturedFn();
      assert.equal(ofType(wsA, 'ping').length, 1);
    } finally {
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
      Server.stopHeartbeat();
    }
  },

  're-register then stale close keeps the live peer': () => {
    reset();
    const wsOld = fakeWs('192.168.1.10');
    const wsNew = fakeWs('192.168.1.10');
    const wsWitness = fakeWs('192.168.1.11');
    Server.handleRegister(wsOld, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    Server.handleRegister(wsWitness, { type: 'register', peerId: 'W', info: { name: 'W' } }, '192.168.1.11');
    // Reconnect: same peerId registers on a new socket, taking ownership.
    Server.handleRegister(wsNew, { type: 'register', peerId: 'A', info: { name: 'A' } }, '192.168.1.10');
    assert.equal(Server.peers.get('A').ws, wsNew);
    wsWitness.sent.length = 0;
    // The stale socket's close must NOT delete the live entry.
    assert.equal(Server.handleDisconnect(wsOld, 'A'), false);
    assert.ok(Server.peers.has('A'));
    assert.equal(Server.peers.get('A').ws, wsNew);
    assert.deepEqual(ofType(wsWitness, 'peer_left'), []);
    // The live socket can still disconnect normally.
    assert.equal(Server.handleDisconnect(wsNew, 'A'), true);
    assert.notOk(Server.peers.has('A'));
    assert.equal(ofType(wsWitness, 'peer_left').length, 1);
  },

  // ---- real-ws integration (same scope) ----

  'real ws clients in the same scope discover each other': async () => {
    reset();
    const WebSocket = require('ws');
    await withEphemeralServer(async (port) => {
      const inboxA = [];
      const inboxB = [];
      const wsA = new WebSocket(`ws://127.0.0.1:${port}`);
      const wsB = new WebSocket(`ws://127.0.0.1:${port}`);
      await Promise.all([
        new Promise((res, rej) => { wsA.on('open', res); wsA.on('error', rej); }),
        new Promise((res, rej) => { wsB.on('open', res); wsB.on('error', rej); }),
      ]);
      wsA.on('message', (d) => inboxA.push(JSON.parse(String(d))));
      wsB.on('message', (d) => inboxB.push(JSON.parse(String(d))));
      wsA.send(JSON.stringify({ type: 'register', peerId: 'real-A', info: { name: 'real-A' } }));
      await waitFor(() => inboxA.some((m) => m.type === 'peer_list'));
      wsB.send(JSON.stringify({ type: 'register', peerId: 'real-B', info: { name: 'real-B' } }));
      await waitFor(() => inboxB.some((m) => m.type === 'peer_list'));
      await waitFor(() => inboxA.some((m) => m.type === 'peer_joined' && m.peerId === 'real-B'));
      const listB = inboxB.find((m) => m.type === 'peer_list');
      assert.ok(listB.peers.some((p) => p.peerId === 'real-A'), `B should see A, got ${JSON.stringify(listB)}`);
      // Message shapes are unchanged.
      assert.equal(inboxA.find((m) => m.type === 'peer_joined' && m.peerId === 'real-B').type, 'peer_joined');
      wsA.close();
      wsB.close();
      await new Promise((r) => setTimeout(r, 100));
    });
    reset();
  },
};

module.exports = { name: 'server', tests };
