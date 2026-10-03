// tests/webrtc.test.js
// Tests for client/webrtc.js.
//
// client/webrtc.js is a browser class that reaches for WebSocket,
// RTCPeerConnection and `window` at definition time, so it cannot simply be
// require()d. Instead each test builds a sandbox context with the smallest set
// of fakes the file touches, evaluates the real source inside it, and asserts on
// what the resulting PeerManager observably does: which channels were created
// and with which options, how many timers are live, and what it emits.
//
// Nothing here inspects the source text; every assertion is on behaviour.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('./assert');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'client', 'webrtc.js'), 'utf8');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeDataChannel {
  constructor(label, options) {
    this.label = label;
    this.options = options;
    this.readyState = 'connecting';
    this.binaryType = 'blob';
    this.bufferedAmount = 0;
    this.sent = [];
  }

  send(data) {
    if (this.readyState !== 'open') throw new Error('send on non-open channel');
    this.sent.push(data);
  }

  close() {
    this.readyState = 'closed';
    if (this.onclose) this.onclose({ type: 'close' });
  }

  /** Test-side drive of the channel lifecycle. */
  open() {
    this.readyState = 'open';
    if (this.onopen) this.onopen({ type: 'open' });
  }

  deliver(data) {
    if (this.onmessage) this.onmessage({ data });
  }
}

const createdPeerConnections = [];

class FakeRTCPeerConnection {
  constructor(config) {
    this.config = config;
    this.connectionState = 'new';
    this.iceGatheringState = 'complete'; // skip the ICE wait in every test
    this.channels = [];
    this.localDescription = null;
    this.remoteDescription = null;
    this.closed = false;
    this.candidates = [];
    createdPeerConnections.push(this);
  }

  createDataChannel(label, options) {
    const dc = new FakeDataChannel(label, options);
    this.channels.push(dc);
    return dc;
  }

  createOffer() {
    return Promise.resolve({ type: 'offer', sdp: 'fake-offer' });
  }

  createAnswer() {
    return Promise.resolve({ type: 'answer', sdp: 'fake-answer' });
  }

  setLocalDescription(desc) {
    this.localDescription = desc;
    return Promise.resolve();
  }

  setRemoteDescription(desc) {
    this.remoteDescription = desc;
    return Promise.resolve();
  }

  addIceCandidate() {
    return Promise.resolve();
  }

  addEventListener() { }
  removeEventListener() { }

  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }

  // Test-side drive of the connection state machine.
  setConnectionState(state) {
    this.connectionState = state;
    if (this.onconnectionstatechange) this.onconnectionstatechange();
  }
}

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  // Test-side drives.
  open() {
    this.readyState = 1;
    if (this.onopen) this.onopen();
  }

  drop() {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose();
  }

  receive(obj) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) });
  }
}

FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSED = 3;
FakeWebSocket.instances = [];

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

/**
 * Evaluate client/webrtc.js in a controlled scope and return a PeerManager
 * factory plus the fakes so tests can drive and observe it.
 */
function createSandbox() {
  createdPeerConnections.length = 0;
  FakeWebSocket.instances.length = 0;

  let nextTimerId = 1;
  const intervals = new Map();
  const timeouts = new Map();

  const sandbox = {
    console: { log() { }, warn() { }, error() { }, debug() { } },
    location: { protocol: 'http:', host: 'lanshare.test:3000' },
    WebSocket: FakeWebSocket,
    RTCPeerConnection: FakeRTCPeerConnection,
    RTCSessionDescription: class { constructor(init) { Object.assign(this, init); } },
    RTCIceCandidate: class { constructor(init) { Object.assign(this, init); } },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),

    // Controllable timers: nothing fires unless a test asks it to.
    setInterval(fn, delay) {
      const id = nextTimerId++;
      intervals.set(id, { fn, delay });
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(fn, delay) {
      const id = nextTimerId++;
      timeouts.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) { timeouts.delete(id); },
  };

  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'client/webrtc.js' });

  const env = {
    PeerManager: sandbox.PeerManager,
    localProtocolVersion: sandbox.PeerManager.LOCAL_PROTOCOL_VERSION,
    /** The vm context globals, e.g. to install a fake `Framing`. */
    context: sandbox,
    intervals,
    timeouts,
    peerConnections: createdPeerConnections,
    websockets: FakeWebSocket.instances,

    /** Fire every live interval callback once. */
    tickIntervals() {
      for (const entry of Array.from(intervals.values())) entry.fn();
    },
    /** Fire every pending timeout callback once, clearing it first. */
    runTimeouts() {
      const pending = Array.from(timeouts.values());
      timeouts.clear();
      for (const entry of pending) entry.fn();
      return pending.length;
    },
    /** Intervals still alive. */
    liveIntervals() { return intervals.size; },
    liveTimeouts() { return timeouts.size; },
  };

  env.create = function (peerId = 'local-peer') {
    const messages = [];
    const pm = new env.PeerManager(peerId, (msg) => messages.push(msg));
    pm.messages = messages;
    return pm;
  };

  /** Server mode with an open signaling socket. */
  env.createServerMode = function (peerId = 'local-peer') {
    const pm = env.create(peerId);
    pm.connect({});
    pm.ws.open();
    return pm;
  };

  /** Manual mode: no signaling socket exists at all. */
  env.createManualMode = function (peerId = 'local-peer') {
    const pm = env.create(peerId);
    pm.connect({ manual: true });
    return pm;
  };

  return env;
}

/** Let queued promise callbacks run. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function emitted(pm, type) {
  return pm.messages.filter((m) => m.type === type);
}

// ---------------------------------------------------------------------------
// Task 4.7: no retransmission cap on the transfer channel
// ---------------------------------------------------------------------------

const tests = {
  'transfer channel is ordered with no retransmission cap (server mode)': async () => {
    const env = createSandbox();
    const pm = env.createServerMode();

    pm._initiatePeerConnection('peer-a');
    await flush();

    assert.equal(createdPeerConnections.length, 1);
    const channels = createdPeerConnections[0].channels;
    assert.equal(channels.length, 1);
    assert.equal(channels[0].label, 'transfer');

    const opts = channels[0].options;
    assert.equal(opts.ordered, true, 'transfer channel must stay ordered');
    assert.notOk(
      Object.prototype.hasOwnProperty.call(opts, 'maxRetransmits'),
      `transfer channel must not cap retransmits, got ${JSON.stringify(opts)}`
    );
    assert.notOk(
      Object.prototype.hasOwnProperty.call(opts, 'maxPacketLifeTime'),
      'transfer channel must not expire messages, got ' + JSON.stringify(opts)
    );
  },

  'transfer channel is ordered with no retransmission cap (manual offer)': async () => {
    const env = createSandbox();
    const pm = env.createManualMode();

    const code = await pm.createManualOffer();
    assert.ok(typeof code === 'string' && code.length > 0, 'offer code should be produced');

    assert.equal(createdPeerConnections.length, 1);
    const opts = createdPeerConnections[0].channels[0].options;
    assert.equal(opts.ordered, true);
    assert.deepEqual(opts, { ordered: true });
  },

  'applying a manual answer keeps the uncapped channel under the real peer id': async () => {
    const env = createSandbox();
    const pm = env.createManualMode();

    const offerCode = await pm.createManualOffer();
    const other = env.createManualMode('peer-b');
    const answerCode = await other.acceptManualOffer(offerCode);

    const [pair] = Array.from(pm.manualPairs.values());
    assert.ok(pair.provisionalPeerId, 'the offer should be held under a provisional id');

    // The offerer applies the answer, which renames the provisional peer id to
    // the real one. The channel is moved, so its options must survive intact.
    await pm.processManualCode(answerCode);

    const pc = createdPeerConnections[0];
    assert.deepEqual(pc.channels[0].options, { ordered: true });
    assert.equal(pm.dataChannels.has(pair.provisionalPeerId), false, 'provisional id should be gone');
    assert.equal(pm.dataChannels.has('peer-b'), true);
    assert.equal(pm.connections.has('peer-b'), true);
    assert.equal(pm.manualPairs.size, 0, 'the pairing should be consumed');

    // Renaming must not carry a protocol verdict over to the real peer id.
    assert.equal(pm.isProtocolCompatible('peer-b').ok, false);
  },

  // -----------------------------------------------------------------------
  // Tasks 6.1-6.3: protocol version handshake state
  // -----------------------------------------------------------------------

  'unknown peer is not compatible and reports remote null': () => {
    const env = createSandbox();
    const pm = env.create();

    const result = pm.isProtocolCompatible('never-seen');
    assert.equal(result.ok, false);
    assert.equal(result.remote, null, 'no handshake means no remote version');
    assert.equal(result.local, env.localProtocolVersion);
    assert.equal(result.peerId, 'never-seen');
    assert.ok(result.reason, 'a refusal reason should be present');
  },

  'matching version is compatible and records capabilities': () => {
    const env = createSandbox();
    const pm = env.create();

    pm.recordProtocol('peer-a', env.localProtocolVersion, { streaming: true });

    const result = pm.assertProtocolCompatible('peer-a');
    assert.equal(result.ok, true);
    assert.equal(result.local, env.localProtocolVersion);
    assert.equal(result.remote, env.localProtocolVersion);
    assert.deepEqual(pm.getCapabilities('peer-a'), { streaming: true });
    assert.equal(pm.getProtocol('peer-a').version, env.localProtocolVersion);
  },

  'mismatched version refuses and the reason names both versions': () => {
    const env = createSandbox();
    const pm = env.create();

    const local = env.localProtocolVersion;
    const remote = local + 1;
    pm.recordProtocol('peer-old', remote);

    const result = pm.isProtocolCompatible('peer-old');
    assert.equal(result.ok, false);
    assert.equal(result.local, local);
    assert.equal(result.remote, remote);
    assert.ok(
      result.reason.includes(String(local)),
      `reason should name the local version ${local}: ${result.reason}`
    );
    assert.ok(
      result.reason.includes(String(remote)),
      `reason should name the peer version ${remote}: ${result.reason}`
    );
    assert.ok(result.reason.includes('peer-old'), 'reason should name the peer');

    // assertProtocolCompatible must agree with isProtocolCompatible.
    assert.deepEqual(pm.assertProtocolCompatible('peer-old'), result);
  },

  'a non-numeric reported version is refused, not accepted': () => {
    const env = createSandbox();
    const pm = env.create();

    pm.recordProtocol('peer-weird', 'two');
    const result = pm.isProtocolCompatible('peer-weird');
    assert.equal(result.ok, false);
    assert.equal(result.remote, null);
  },

  'local version follows Framing.PROTOCOL_VERSION when framing.js is loaded': () => {
    const env = createSandbox();
    const pm = env.create();

    assert.equal(pm.localProtocolVersion(), env.localProtocolVersion);

    // framing.js exposes the authoritative constant; webrtc.js must read it
    // rather than let the two drift apart.
    env.context.Framing = { PROTOCOL_VERSION: env.localProtocolVersion + 5 };
    const updated = env.PeerManager.LOCAL_PROTOCOL_VERSION;
    assert.equal(pm.localProtocolVersion(), updated + 5);

    pm.recordProtocol('peer-a', updated + 5);
    assert.equal(pm.isProtocolCompatible('peer-a').ok, true);
    pm.recordProtocol('peer-a', updated);
    assert.equal(pm.isProtocolCompatible('peer-a').ok, false);
  },

  'clearProtocol forces renegotiation': () => {
    const env = createSandbox();
    const pm = env.create();

    pm.recordProtocol('peer-a', env.localProtocolVersion);
    assert.equal(pm.isProtocolCompatible('peer-a').ok, true);

    pm.clearProtocol('peer-a');
    assert.equal(pm.isProtocolCompatible('peer-a').ok, false);
    assert.equal(pm.getProtocol('peer-a'), null);
    assert.equal(pm.getCapabilities('peer-a'), null);
  },

  'opening a channel discards a previously recorded protocol': async () => {
    const env = createSandbox();
    const pm = env.createServerMode();

    pm._initiatePeerConnection('peer-a');
    await flush();
    const dc = createdPeerConnections[0].channels[0];

    pm.recordProtocol('peer-a', env.localProtocolVersion);
    dc.open();
    assert.equal(
      pm.isProtocolCompatible('peer-a').ok,
      false,
      'a fresh channel has not handshook yet'
    );
    assert.equal(emitted(pm, 'channel_open').length, 1);

    // Reopening an already-negotiated channel requires a new handshake too.
    pm.recordProtocol('peer-a', env.localProtocolVersion);
    pm._setupDataChannel(dc, 'peer-a');
    dc.open();
    assert.equal(pm.isProtocolCompatible('peer-a').ok, false);
  },

  'closing the channel clears the negotiated protocol': async () => {
    const env = createSandbox();
    const pm = env.createServerMode();

    pm._initiatePeerConnection('peer-a');
    await flush();
    const dc = createdPeerConnections[0].channels[0];
    dc.open();

    pm.recordProtocol('peer-a', env.localProtocolVersion);
    assert.equal(pm.isProtocolCompatible('peer-a').ok, true);

    dc.close();
    const afterClose = pm.isProtocolCompatible('peer-a');
    assert.equal(afterClose.ok, false, 'a closed channel must renegotiate');
    assert.equal(afterClose.remote, null);
    assert.equal(emitted(pm, 'channel_closed').length, 1);
  },

  'cleanup of a peer clears its negotiated protocol': async () => {
    const env = createSandbox();
    const pm = env.createServerMode();

    pm._initiatePeerConnection('peer-a');
    await flush();
    pm.recordProtocol('peer-a', env.localProtocolVersion);

    pm._cleanupPeer('peer-a');

    assert.equal(pm.isProtocolCompatible('peer-a').ok, false);
    assert.equal(pm.connections.has('peer-a'), false);
    assert.equal(createdPeerConnections[0].closed, true, 'connection should be closed');
  },

  'raw strings pass through the data channel untouched': async () => {
    const env = createSandbox();
    const pm = env.createServerMode();

    pm._initiatePeerConnection('peer-a');
    await flush();
    const dc = createdPeerConnections[0].channels[0];
    dc.open();

    const handshake = JSON.stringify({ type: 'protocol_handshake', version: 2, capabilities: { streaming: true } });
    dc.deliver(handshake);

    const data = emitted(pm, 'data');
    assert.equal(data.length, 1);
    assert.equal(data[0].peerId, 'peer-a');
    assert.equal(data[0].data, handshake, 'the JSON string must arrive unmodified');
    assert.deepEqual(JSON.parse(data[0].data).capabilities, { streaming: true });

    const buffer = new ArrayBuffer(16);
    dc.deliver(buffer);
    assert.equal(emitted(pm, 'data')[1].data, buffer, 'binary must pass through too');
  },

  // -----------------------------------------------------------------------
  // Bug A: server ping interval leak
  // -----------------------------------------------------------------------

  'exactly one server ping interval is live across reconnects': () => {
    const env = createSandbox();
    const pm = env.create();

    assert.equal(env.liveIntervals(), 0);

    pm.connect({});
    pm.ws.open();
    assert.equal(env.liveIntervals(), 1, 'opening the socket starts one ping');
    assert.ok(pm.serverPingInterval, 'the interval handle should be stored');

    // Five dropped connections. Each one used to leave its interval behind,
    // still firing because this.wsReady was true again by the next reconnect.
    for (let i = 0; i < 5; i++) {
      pm.ws.drop();
      assert.equal(env.liveIntervals(), 0, `socket close must stop the ping (round ${i})`);
      assert.equal(pm.serverPingInterval, null);

      const pending = env.runTimeouts(); // the scheduled reconnect
      assert.equal(pending, 1, 'a reconnect should be scheduled');
      pm.ws.open();
      assert.equal(env.liveIntervals(), 1, `exactly one ping after round ${i}`);
    }

    // And the single surviving interval is the ping, not a peer ping.
    const delays = Array.from(env.intervals.values()).map((i) => i.delay);
    assert.deepEqual(delays, [3000]);

    // It actually pings, over the live socket.
    pm.ws.sent.length = 0;
    env.tickIntervals();
    assert.equal(pm.ws.sent.length, 1);
    assert.equal(JSON.parse(pm.ws.sent[0]).type, 'ping');
  },

  'a second _startServerPing does not double up intervals': () => {
    const env = createSandbox();
    const pm = env.createServerMode();

    pm._startServerPing();
    pm._startServerPing();
    assert.equal(env.liveIntervals(), 1);
    assert.equal(pm.serverPingInterval !== null, true);

    pm._stopServerPing();
    assert.equal(env.liveIntervals(), 0);
  },

  'peer pings are cleared when the peer is cleaned up': async () => {
    const env = createSandbox();
    const pm = env.createServerMode();

    pm._initiatePeerConnection('peer-a');
    await flush();
    createdPeerConnections[0].setConnectionState('connected');

    assert.equal(env.liveIntervals(), 2, 'server ping plus peer ping');
    pm._cleanupPeer('peer-a');
    assert.equal(env.liveIntervals(), 1, 'only the server ping survives');
    pm._stopServerPing();
    assert.equal(env.liveIntervals(), 0);
  },

  // -----------------------------------------------------------------------
  // Bug B: retry loop against a dead or absent signaling channel
  // -----------------------------------------------------------------------

  'manual mode connection failure does not retry and asks for re-pairing': async () => {
    const env = createSandbox();
    const pm = env.createManualMode();

    pm._initiatePeerConnection('manual-peer-a');
    await flush();
    assert.equal(createdPeerConnections.length, 1);

    createdPeerConnections[0].setConnectionState('failed');

    const notices = emitted(pm, 'reconnect_required');
    assert.equal(notices.length, 1, 're-pairing should be surfaced once');
    assert.equal(notices[0].peerId, 'manual-peer-a');
    assert.ok(notices[0].reason, 'the notice should say why');

    assert.equal(env.liveTimeouts(), 0, 'no retry may be scheduled in manual mode');

    // Repeated failures must not accumulate abandoned peer connections either.
    createdPeerConnections.forEach((pc) => pc.setConnectionState('failed'));
    assert.equal(env.liveTimeouts(), 0);
    assert.equal(createdPeerConnections.length, 1, 'no further connections may be built');

    // The failed connection is closed and dropped, so it cannot linger.
    assert.equal(createdPeerConnections[0].closed, true);
    assert.equal(pm.connections.has('manual-peer-a'), false);
    assert.equal(pm.dataChannels.has('manual-peer-a'), false);
  },

  'manual mode disconnected state also stops instead of retrying': async () => {
    const env = createSandbox();
    const pm = env.createManualMode();

    pm._initiatePeerConnection('manual-peer-a');
    await flush();
    createdPeerConnections[0].setConnectionState('disconnected');

    assert.equal(emitted(pm, 'reconnect_required').length, 1);
    assert.equal(env.liveTimeouts(), 0);
    assert.equal(createdPeerConnections.length, 1);
  },

  'server mode retries on failure, up to the bound': async () => {
    const env = createSandbox();
    const pm = env.createServerMode();
    pm.maxReconnects = 2;

    pm._initiatePeerConnection('peer-a');
    await flush();
    assert.equal(createdPeerConnections.length, 1);

    // Attempt 1: a retry is scheduled, then it runs and builds a new connection.
    createdPeerConnections[0].setConnectionState('failed');
    assert.equal(env.liveTimeouts(), 1, 'server mode should retry while the socket is up');
    env.runTimeouts();
    await flush();
    assert.equal(createdPeerConnections.length, 2);
    assert.equal(pm.connections.has('peer-a'), true);
    assert.equal(emitted(pm, 'reconnect_required').length, 0);

    // Attempt 2: the last allowed retry.
    createdPeerConnections[1].setConnectionState('failed');
    assert.equal(env.liveTimeouts(), 1);
    env.runTimeouts();
    await flush();
    assert.equal(createdPeerConnections.length, 3);

    // Attempt 3: past maxReconnects, so stop and report.
    createdPeerConnections[2].setConnectionState('failed');
    assert.equal(env.liveTimeouts(), 0, 'retries must be bounded');
    const notices = emitted(pm, 'reconnect_required');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].attempts, 3);
    assert.equal(pm.connections.has('peer-a'), false);

    // Further failures must not resurrect the retry loop.
    createdPeerConnections[2].setConnectionState('failed');
    env.runTimeouts();
    await flush();
    assert.equal(createdPeerConnections.length, 3);
  },

  'server mode does not retry while the signaling socket is down': async () => {
    const env = createSandbox();
    const pm = env.create();

    pm.connect({});
    pm.ws.open();
    pm._initiatePeerConnection('peer-a');
    await flush();

    // The socket drops: a fresh offer has nowhere to go.
    pm.wsReady = false;
    createdPeerConnections[0].setConnectionState('failed');

    assert.equal(env.liveTimeouts(), 0, 'no retry without a signaling socket');
    assert.equal(emitted(pm, 'reconnect_required').length, 1);
    assert.equal(createdPeerConnections.length, 1);
  },

  'a pending retry is cancelled when the peer is cleaned up': async () => {
    const env = createSandbox();
    const pm = env.createServerMode();

    pm._initiatePeerConnection('peer-a');
    await flush();
    createdPeerConnections[0].setConnectionState('failed');
    assert.equal(env.liveTimeouts(), 1);

    pm._cleanupPeer('peer-a');
    assert.equal(env.liveTimeouts(), 0);
    env.runTimeouts();
    await flush();
    assert.equal(createdPeerConnections.length, 1, 'a cancelled retry must not run');
  },

  // -----------------------------------------------------------------------
  // Signaling-rooms: pairing consent (single initiator, tie-break, expiry)
  // -----------------------------------------------------------------------

  'requestPairing emits a correctly-shaped message with unique ids': () => {
    const env = createSandbox();
    const pm = env.createServerMode();
    pm.setLocalInfo({ name: 'Alice', type: 'laptop' });

    const id1 = pm.requestPairing('peer-a');
    const id2 = pm.requestPairing('peer-b');

    assert.ok(id1, 'a request id should be returned');
    assert.ok(id2, 'a request id should be returned');
    assert.notEqual(id1, id2, 'request ids must be unique');

    const sent = pm.ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'pairing_request');
    assert.equal(sent.length, 2);
    assert.equal(sent[0].requestId, id1);
    assert.equal(sent[0].from, 'local-peer');
    assert.equal(sent[0].fromName, 'Alice');
    assert.equal(sent[0].fromType, 'laptop');
    assert.equal(sent[0].to, 'peer-a');
    assert.equal(sent[1].requestId, id2);
    assert.equal(sent[1].to, 'peer-b');
  },

  'incoming pairing_request surfaces via onMessage without initiating': async () => {
    const env = createSandbox();
    const pm = env.createServerMode();
    const sentBefore = pm.ws.sent.length;

    pm.ws.receive({
      type: 'pairing_request',
      requestId: 'req-remote-1',
      from: 'peer-a',
      fromName: 'Bob',
      fromType: 'phone',
    });
    await flush();

    const reqs = emitted(pm, 'pairing_request');
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].requestId, 'req-remote-1');
    assert.equal(reqs[0].peerId, 'peer-a');
    assert.deepEqual(reqs[0].info, { name: 'Bob', type: 'phone' });

    assert.equal(createdPeerConnections.length, 0, 'no connection may start before accept');
    assert.equal(pm.ws.sent.length, sentBefore, 'nothing is sent until the user responds');
  },

  'peer_list and peer_joined never auto-connect; peer_left keeps the channel': async () => {
    const env = createSandbox();
    const pm = env.createServerMode();

    pm.ws.receive({ type: 'peer_list', peers: [{ peerId: 'peer-a', info: { name: 'A' } }] });
    await flush();
    assert.equal(emitted(pm, 'peer_joined').length, 1);
    assert.equal(createdPeerConnections.length, 0, 'discovery alone must not initiate');

    // Pair, accept, and connect; then the peer "leaves" signaling.
    const id = pm.requestPairing('peer-a');
    pm.ws.receive({ type: 'pairing_response', requestId: id, from: 'peer-a', accepted: true });
    await flush();
    assert.equal(createdPeerConnections.length, 1);

    pm.ws.receive({ type: 'peer_left', peerId: 'peer-a' });
    assert.equal(emitted(pm, 'peer_left').length, 1);
    assert.equal(createdPeerConnections[0].closed, false, 'signaling loss must not close the channel');
    assert.equal(pm.connections.has('peer-a'), true);
  },

  'respond accept as initiator starts exactly one connection': async () => {
    const env = createSandbox();
    const pm = env.createServerMode();

    const id = pm.requestPairing('peer-a');
    const handled = pm.respondPairing(id, true, 'peer-a');
    assert.equal(handled, true);
    await flush();

    assert.equal(createdPeerConnections.length, 1);

    const responses = pm.ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'pairing_response');
    assert.equal(responses.length, 1);
    assert.equal(responses[0].requestId, id);
    assert.equal(responses[0].accepted, true);

    // Accepting again reuses the channel instead of building a second one.
    pm.respondPairing(id, true, 'peer-a');
    pm.ws.receive({ type: 'pairing_response', requestId: id, from: 'peer-a', accepted: true });
    await flush();
    assert.equal(createdPeerConnections.length, 1, 'accept-twice must reuse the channel');
  },

  'responder accept waits for the offer instead of initiating': async () => {
    const env = createSandbox();
    const pm = env.createServerMode();

    pm.ws.receive({
      type: 'pairing_request',
      requestId: 'req-remote-1',
      from: 'peer-a',
      fromName: 'Bob',
      fromType: 'phone',
    });
    const sentBefore = pm.ws.sent.length;

    const handled = pm.respondPairing('req-remote-1', true, 'peer-a');
    assert.equal(handled, true);
    await flush();

    assert.equal(createdPeerConnections.length, 0, 'the responder must wait for the offer');
    const responses = pm.ws.sent.slice(sentBefore).map((s) => JSON.parse(s));
    assert.equal(responses.length, 1);
    assert.equal(responses[0].type, 'pairing_response');
    assert.equal(responses[0].accepted, true);
    assert.ok(!responses.some((m) => m.type === 'signal'), 'no offer may be sent by the responder');
  },

  'declined pairing sends the outcome and never connects': async () => {
    const env = createSandbox();
    const pm = env.createServerMode();

    pm.ws.receive({
      type: 'pairing_request',
      requestId: 'req-remote-1',
      from: 'peer-a',
      fromName: 'Bob',
      fromType: 'phone',
    });
    assert.equal(pm.respondPairing('req-remote-1', false, 'peer-a'), true);
    await flush();

    assert.equal(createdPeerConnections.length, 0);
    const responses = pm.ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'pairing_response');
    assert.equal(responses.length, 1);
    assert.equal(responses[0].accepted, false);
  },

  'simultaneous mutual requests resolve to exactly one initiator (lower id)': async () => {
    const env = createSandbox();
    const lower = env.create('peer-a');
    lower.connect({});
    lower.ws.open();
    const higher = env.create('peer-b');
    higher.connect({});
    higher.ws.open();

    // Both sides request each other.
    lower.requestPairing('peer-b');
    higher.requestPairing('peer-a');

    // Both sides receive the other's request.
    lower.ws.receive({
      type: 'pairing_request', requestId: 'req-from-higher', from: 'peer-b', fromName: 'B', fromType: 'phone',
    });
    higher.ws.receive({
      type: 'pairing_request', requestId: 'req-from-lower', from: 'peer-a', fromName: 'A', fromType: 'laptop',
    });

    const pcsBefore = createdPeerConnections.length;
    assert.equal(lower.respondPairing('req-from-higher', true, 'peer-b'), true);
    assert.equal(higher.respondPairing('req-from-lower', true, 'peer-a'), true);
    await flush();

    assert.equal(
      createdPeerConnections.length - pcsBefore, 1,
      'exactly one side may initiate after mutual accept'
    );
    assert.equal(lower.connections.has('peer-b'), true, 'the lower id initiates');
    assert.equal(higher.connections.has('peer-a'), false, 'the higher id waits');
  },

  'requesting an already-connected peer reuses the channel': async () => {
    const env = createSandbox();
    const pm = env.createServerMode();

    const id = pm.requestPairing('peer-a');
    pm.ws.receive({ type: 'pairing_response', requestId: id, from: 'peer-a', accepted: true });
    await flush();
    assert.equal(createdPeerConnections.length, 1);

    const sentBefore = pm.ws.sent.length;
    const again = pm.requestPairing('peer-a');
    assert.equal(again, null, 'no new request is needed when already connected');
    assert.equal(pm.ws.sent.length, sentBefore, 'nothing is sent for an existing channel');
    assert.equal(createdPeerConnections.length, 1);
  },

  'unanswered pairing expires after 60s and a late accept is ignored': async () => {
    const env = createSandbox();
    const pm = env.createServerMode();

    const id = pm.requestPairing('peer-a');
    assert.equal(env.liveTimeouts(), 1, 'an expiry timer should be pending');

    env.runTimeouts();

    const expired = emitted(pm, 'pairing_expired');
    assert.equal(expired.length, 1);
    assert.equal(expired[0].requestId, id);
    assert.equal(expired[0].peerId, 'peer-a');

    // The expiry sends nothing further.
    assert.ok(!pm.ws.sent.map((s) => JSON.parse(s)).some((m) => m.type === 'pairing_expired'),
      'expiry is local; nothing is sent');

    // A late accept of the stale request is ignored entirely.
    const sentBefore = pm.ws.sent.length;
    assert.equal(pm.respondPairing(id, true, 'peer-a'), false);
    pm.ws.receive({ type: 'pairing_response', requestId: id, from: 'peer-a', accepted: true });
    await flush();
    assert.equal(pm.ws.sent.length, sentBefore, 'a late accept sends nothing');
    assert.equal(createdPeerConnections.length, 0, 'a late accept creates nothing');
  },

  // -----------------------------------------------------------------------
  // Signaling-rooms: endpoint resolution and signaling loss
  // -----------------------------------------------------------------------

  'endpoint resolves explicit, default, and manual modes': () => {
    let env = createSandbox();
    assert.equal(env.create().getEndpoint(), null, 'no endpoint before connect');

    env = createSandbox();
    let pm = env.create();
    pm.connect({ serverUrl: 'wss://relay.example.com' });
    assert.equal(pm.getEndpoint(), 'wss://relay.example.com');
    assert.equal(env.websockets.length, 1);
    assert.equal(env.websockets[0].url, 'wss://relay.example.com');

    env = createSandbox();
    pm = env.create();
    pm.connect({});
    assert.equal(pm.getEndpoint(), 'ws://lanshare.test:3000');
    assert.equal(env.websockets[0].url, 'ws://lanshare.test:3000');

    env = createSandbox();
    pm = env.create();
    pm.connect({ manual: true });
    assert.equal(pm.getEndpoint(), null);
    assert.equal(env.websockets.length, 0, 'manual mode makes no signaling attempts');

    // Build-time / query static flags also force manual mode.
    env = createSandbox();
    env.context.LANSHARE_STATIC = true;
    pm = env.create();
    pm.connect({});
    assert.equal(pm.manualMode, true);
    assert.equal(pm.getEndpoint(), null);
    assert.equal(env.websockets.length, 0);
  },

  'ws close leaves RTCPeerConnections open and re-register emits signaling_up': async () => {
    const env = createSandbox();
    const pm = env.createServerMode();

    pm._initiatePeerConnection('peer-a');
    await flush();
    assert.equal(createdPeerConnections.length, 1);

    pm.ws.drop();

    assert.equal(emitted(pm, 'signaling_down').length, 1);
    assert.equal(createdPeerConnections[0].closed, false, 'the data channel must survive');
    assert.equal(pm.connections.has('peer-a'), true);
    assert.equal(env.liveTimeouts(), 1, 'signaling reconnect keeps the existing backoff');

    env.runTimeouts();
    assert.equal(env.websockets.length, 2, 'signaling reconnects');
    assert.equal(emitted(pm, 'signaling_up').length, 0, 'not up until re-registered');

    env.websockets[1].open();
    assert.equal(emitted(pm, 'signaling_up').length, 1);
    assert.equal(pm.connections.has('peer-a'), true, 're-register must not disturb the link');
    assert.equal(createdPeerConnections.length, 1, 're-register creates no new peer connection');
  },

  'bounded retry exhaustion reports retries_exhausted': async () => {
    const env = createSandbox();
    const pm = env.createServerMode();
    pm.maxReconnects = 1;

    pm._initiatePeerConnection('peer-a');
    await flush();
    createdPeerConnections[0].setConnectionState('failed');
    assert.equal(env.liveTimeouts(), 1);
    env.runTimeouts();
    await flush();
    createdPeerConnections[1].setConnectionState('failed');

    const notices = emitted(pm, 'reconnect_required');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].reason, 'retries_exhausted');
  },
};

module.exports = { name: 'webrtc', tests };