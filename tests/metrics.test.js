// tests/metrics.test.js
// Tests for the header bandwidth readout owned by client/app.js
// (tasks 7.1 / 7.2: progress reflects real throughput, aggregate bandwidth
// reflects the sum of active transfers).
//
// client/app.js is a browser IIFE, so it cannot be require()d. Like
// tests/webrtc.test.js, each test evaluates the real source in a vm sandbox
// with the smallest set of fakes the metrics path touches, drives
// transferEngine.onProgress callbacks shaped exactly like client/transfer.js
// emits them ({ transferId, direction, progress, speed, eta, peerId } plus
// bytesSent / bytesReceived cumulatives), fires the captured 1s metrics
// timer under a controllable clock, and asserts on what ui.updateLiveMetrics
// observably receives. Nothing here inspects the source text.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('./assert');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'client', 'app.js'), 'utf8');

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

function createSandbox() {
  let fakeNow = 1000000;
  const metricsCalls = [];
  let uiInstance = null;
  let pmInstance = null;
  let engineInstance = null;
  let intervalFn = null;

  class FakeUI {
    constructor() {
      this.peers = new Map();
      uiInstance = this;
    }
    init() {}
    setStaticMode() {}
    updateTransfer() {}
    logPacketEvent() {}
    showTransferComplete() {}
    clearTransfer() {}
    showIncoming() {}
    showNotification() {}
    updatePeerLatency() {}
    addChatMessage() {}
    showSpeedTestRunning() {}
    addSpeedTestResult() {}
    switchTab() {}
    addPeer() {}
    removePeer() {}
    updatePeerState() {}
    markPeerConnected() {}
    drawRemoteStroke() {}
    showTyping() {}
    setPairingStatus() {}
    setManualCode() {}
    revealRemotePanel() {}
    clearRemoteCode() {}
    showCopyIndicator() {}
    updateLiveMetrics(m) { metricsCalls.push({ ...m }); }
  }

  class FakePeerManager {
    constructor(id, handler) {
      this.id = id;
      this.handler = handler;
      this.connections = new Map();
      this.manualMode = false;
      this.latencies = new Map();
      pmInstance = this;
    }
    setLocalInfo() {}
    connect() {}
    getLatency(id) { return this.latencies.has(id) ? this.latencies.get(id) : null; }
    sendChatMessage() {}
    sendTypingIndicator() {}
    createManualOffer() { return Promise.resolve('code'); }
    processManualCode() { return Promise.resolve({}); }
    _initiatePeerConnection() {}
  }

  class FakeTransferEngine {
    constructor(pm) {
      this.pm = pm;
      this.onProgress = null;
      this.onComplete = null;
      this.onIncoming = null;
      this.onCancelled = null;
      this.onLatency = null;
      this.onControl = null;
      this.onFailure = null;
      this.onIncomplete = null;
      engineInstance = this;
    }
    sendFile() { return Promise.resolve('t'); }
    cancelTransfer() { return false; }
    runSpeedTest() { return Promise.resolve({}); }
    handleData() {}
  }

  const sandbox = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    Identity: {
      getOrCreateIdentity: () => ({
        id: 'local-12345678',
        name: 'Tester',
        type: 'desktop',
        palette: ['#111111', '#222222'],
      }),
      getPalette: () => ['#111111', '#222222'],
    },
    UI: FakeUI,
    PeerManager: FakePeerManager,
    TransferEngine: FakeTransferEngine,
    NetworkVisualizer: class {
      constructor() {}
      start() {}
      addNode() {}
      removeNode() {}
      spawnPacket() {}
      _resize() {}
    },
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById() { return null; }, // no viz canvas: keeps netViz out of the way
    },
    location: { protocol: 'http:', search: '' },
    URLSearchParams,
    navigator: {},
    setInterval(fn) { intervalFn = fn; return 1; },
    clearInterval() {},
    setTimeout(fn) { return 0; },
    clearTimeout() {},
    Date: { now: () => fakeNow },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'client/app.js' });

  if (!engineInstance) throw new Error('sandbox did not construct a TransferEngine');
  if (!intervalFn) throw new Error('sandbox did not register the metrics interval');

  return {
    get ui() { return uiInstance; },
    get pm() { return pmInstance; },
    get engine() { return engineInstance; },
    metricsCalls,
    lastMetrics() { return metricsCalls[metricsCalls.length - 1]; },
    progress(data) { engineInstance.onProgress(data); },
    complete(data) { engineInstance.onComplete(data); },
    cancel(id, info) { engineInstance.onCancelled(id, info); },
    fail(info) { if (engineInstance.onFailure) engineInstance.onFailure(info); },
    /** Advance the fake clock by whole seconds and fire the 1s timer. */
    tick(seconds = 1) {
      fakeNow += seconds * 1000;
      intervalFn();
      return metricsCalls[metricsCalls.length - 1];
    },
  };
}

// Payloads shaped like client/transfer.js emits. `speed` is deliberately set
// to a bogus constant: the header readout must be derived from the cumulative
// byte counters, never from summing `speed`.
function outPayload(transferId, bytesSent, total = 10000000, peerId = 'peer-a') {
  return {
    transferId, direction: 'out', progress: total > 0 ? bytesSent / total : 1,
    speed: 7777777, eta: null, peerId, bytesSent, total,
  };
}

function inPayload(transferId, bytesReceived, total = 10000000, peerId = 'peer-a') {
  return {
    transferId, direction: 'in', progress: total > 0 ? bytesReceived / total : 1,
    speed: 7777777, eta: null, peerId, bytesReceived, total,
  };
}

function closeTo(actual, expected, rel = 0.05) {
  const tol = Math.max(1, Math.abs(expected) * rel);
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${actual} to be within ${(rel * 100).toFixed(1)}% of ${expected}`
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests = {
  'steady-rate transfer reports true interval rate, not a growing sum': () => {
    const env = createSandbox();

    // 400 KB delivered in the first second at a constant rate.
    for (const cum of [100000, 200000, 300000, 400000]) {
      env.progress(outPayload(1, cum));
    }
    let m = env.tick(1);
    closeTo(m.uploadSpeed, 400000);
    assert.equal(m.downloadSpeed, 0);

    // Same rate in the second second. Summing cumulative averages would grow
    // interval over interval; true deltas stay flat.
    for (const cum of [500000, 600000, 700000, 800000]) {
      env.progress(outPayload(1, cum));
    }
    m = env.tick(1);
    closeTo(m.uploadSpeed, 400000);
    closeTo(m.uploadSpeed, 400000, 0.1);
    assert.ok(
      m.uploadSpeed < 400000 * 1.2,
      `second interval must not grow, got ${m.uploadSpeed}`
    );
  },

  'two concurrent opposite-direction transfers sum per direction': () => {
    const env = createSandbox();

    // Same numeric id in both directions: baselines must not be shared.
    env.progress(outPayload(7, 100000));
    env.progress(inPayload(7, 150000));
    env.progress(outPayload(7, 200000));
    env.progress(inPayload(7, 300000));

    const m = env.tick(1);
    closeTo(m.uploadSpeed, 200000);
    closeTo(m.downloadSpeed, 300000);
  },

  'completed and cancelled transfers stop contributing; id reuse starts fresh': () => {
    const env = createSandbox();

    env.progress(outPayload(42, 250000));
    env.progress(outPayload(42, 500000));
    let m = env.tick(1);
    closeTo(m.uploadSpeed, 500000);

    env.complete({ transferId: 42, direction: 'out', fromPeerId: 'peer-a' });
    m = env.tick(1);
    assert.equal(m.uploadSpeed, 0, 'completed transfer must go quiet');
    assert.equal(m.downloadSpeed, 0);

    // Reuse of the same id with a LARGER first cumulative proves the old
    // baseline was deleted: leaked state would report only the 700000 delta.
    env.progress(outPayload(42, 1200000));
    m = env.tick(1);
    closeTo(m.uploadSpeed, 1200000);

    // Cancel path: an in-flight download goes quiet after cancellation.
    env.progress(inPayload(43, 300000));
    m = env.tick(1);
    closeTo(m.downloadSpeed, 300000);
    env.cancel(43, { direction: 'in', peerId: 'peer-a' });
    m = env.tick(1);
    assert.equal(m.downloadSpeed, 0, 'cancelled transfer must go quiet');
    assert.equal(m.uploadSpeed, 0);
  },

  'failed transfers release their baseline for id reuse': () => {
    const env = createSandbox();

    env.progress(inPayload(77, 400000));
    let m = env.tick(1);
    closeTo(m.downloadSpeed, 400000);

    env.fail({ transferId: 77, direction: 'in' });
    env.progress(inPayload(77, 900000));
    m = env.tick(1);
    closeTo(m.downloadSpeed, 900000);
  },

  'a cumulative counter that goes backwards is treated as fresh, never negative': () => {
    const env = createSandbox();

    env.progress(outPayload(9, 250000));
    env.progress(outPayload(9, 500000));
    // Restart reusing the same id: counter drops to 100000.
    env.progress(outPayload(9, 100000));
    const m = env.tick(1);
    assert.ok(m.uploadSpeed >= 0, `throughput must never be negative, got ${m.uploadSpeed}`);
    closeTo(m.uploadSpeed, 600000); // 500000 + fresh 100000
    assert.equal(m.downloadSpeed, 0);

    // The new epoch continues from its own baseline.
    env.progress(outPayload(9, 200000));
    const m2 = env.tick(1);
    closeTo(m2.uploadSpeed, 100000);
  },

  'idle intervals report ~0, not stale values': () => {
    const env = createSandbox();

    env.progress(outPayload(5, 100000));
    let m = env.tick(1);
    closeTo(m.uploadSpeed, 100000);

    m = env.tick(1);
    assert.equal(m.uploadSpeed, 0, 'idle interval must not repeat the last rate');
    assert.equal(m.downloadSpeed, 0);

    m = env.tick(1);
    assert.equal(m.uploadSpeed, 0);
    assert.equal(m.downloadSpeed, 0);
  },

  'peerCount and avgLatency pass through unchanged': () => {
    const env = createSandbox();
    env.ui.peers.set('peer-a', {});
    env.ui.peers.set('peer-b', {});
    env.pm.latencies.set('peer-a', 20);
    env.pm.latencies.set('peer-b', 40);

    const m = env.tick(1);
    assert.equal(m.peerCount, 2);
    assert.equal(m.avgLatency, 30);
    assert.equal(m.uploadSpeed, 0);
    assert.equal(m.downloadSpeed, 0);
  },
};

module.exports = { name: 'metrics', tests };
