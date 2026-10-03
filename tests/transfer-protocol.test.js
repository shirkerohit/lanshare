// End-to-end tests for `client/transfer.js` — the engine that binds the framed
// protocol to a PeerManager.
//
// These drive the real TransferEngine over an in-memory link that can drop,
// corrupt, duplicate, reorder and replay frames, because those are exactly the
// conditions the previous header+payload protocol failed under. In particular
// the very first test is the regression that motivated the rewrite: three files
// sent to one peer at the same time used to overwrite a single pending
// metadata slot per peer and silently corrupt each other.

'use strict';

const assert = require('./assert');
const Framing = require('../client/framing.js');
const TransferEngine = require('../client/transfer.js');
const { sha256Hex, DEFAULT_MAX_IN_MEMORY_BYTES } = require('../client/transfer-core.js');

// Small so tests exercise multi-chunk files quickly.
const CHUNK = 16;

// ── deterministic test data ────────────────────────────────────────────────

function makeBytes(length, seed = 1) {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

/** A real File so the engine exercises the same code path as the browser. */
function makeFile(bytes, name, type = 'application/octet-stream') {
  return new File([bytes], name, { type });
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** Flip a payload byte, leaving the envelope header intact. */
function corruptFrame(buffer) {
  const bytes = new Uint8Array(buffer.slice(0));
  const view = new DataView(bytes.buffer);
  const declared = view.getUint32(12);
  if (declared > 0) bytes[Framing.HEADER_SIZE] ^= 0xff;
  return bytes.buffer;
}

// ── fake transport ─────────────────────────────────────────────────────────

/**
 * One link between two fake peers.
 *
 * Hooks receive the decoded frame (or the parsed JSON message) and may return
 * 'drop', 'corrupt' or 'duplicate'. `holdAll` buffers everything so arrival
 * order can be rewritten before delivery.
 */
class FakeLink {
  constructor(options = {}) {
    this.options = options;
    this.engines = new Map(); // local peerId -> engine
    this.holdAll = false;
    this.pending = [];
    this.sentJson = [];
    this.frameCount = 0;
  }

  register(peerId, engine) {
    this.engines.set(peerId, engine);
  }

  _other(from) {
    return from === 'a' ? 'b' : 'a';
  }

  /** `from` is the sender's local id; delivery lands on the other engine. */
  transmit(from, data) {
    if (this.holdAll) {
      this.pending.push({
        from,
        data: typeof data === 'string' ? data : data.slice(0),
      });
      return;
    }
    this.deliver(from, data);
  }

  deliver(from, data) {
    const target = this.engines.get(this._other(from));

    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      msg = this.options.transformJson ? this.options.transformJson(msg) : msg;
      if (msg === null) return; // swallowed by the link
      this.sentJson.push({ from, msg });
      if (target) target.handleData(from, JSON.stringify(msg));
      return;
    }

    let frame;
    try { frame = Framing.decodeChunk(data); } catch { return; }
    this.frameCount++;

    if (this.options.drop && this.options.drop(frame)) return;

    const payload = (this.options.corrupt && this.options.corrupt(frame))
      ? corruptFrame(data)
      : data;

    if (target) target.handleData(from, payload);
    if (this.options.duplicate && this.options.duplicate(frame) && target) {
      target.handleData(from, payload);
    }
  }

  /**
   * Release held traffic: control messages in order, frames shuffled with a
   * seeded LCG. Control messages are not shuffled because the channel is
   * ordered — the interleaving requirement is about chunk frames.
   */
  async releaseShuffled(seed = 987654321) {
    this.holdAll = false;
    const control = this.pending.filter((m) => typeof m.data === 'string');
    const frames = this.pending.filter((m) => typeof m.data !== 'string');
    this.pending = [];

    for (const m of control) this.deliver(m.from, m.data);

    // An ordered channel hands the announcement over before the frames it
    // describes; let the receiver settle the announcement first.
    await tick();

    let state = seed >>> 0;
    for (let i = frames.length - 1; i > 0; i--) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const j = state % (i + 1);
      const tmp = frames[i];
      frames[i] = frames[j];
      frames[j] = tmp;
    }

    for (const m of frames) this.deliver(m.from, m.data);
  }

  /** Count control messages of a given type sent by a peer. */
  countJson(type, from) {
    return this.sentJson.filter((e) => e.msg.type === type && (!from || e.from === from)).length;
  }
}

class FakePeerManager {
  constructor(peerId, link) {
    this.peerId = peerId;
    this.link = link;
    this.dataChannels = new Map();
    this.latencies = new Map();
    this.sentJson = [];
  }

  openChannel(remoteId) {
    this.dataChannels.set(remoteId, {
      peerId: remoteId,
      readyState: 'open',
      bufferedAmount: 0,
      send: (data) => this.link.transmit(this.peerId, data),
    });
  }

  sendToPeer(remoteId, data) {
    const dc = this.dataChannels.get(remoteId);
    if (!dc || dc.readyState !== 'open') return false;
    dc.send(data);
    return true;
  }

  sendJsonToPeer(remoteId, obj) {
    this.sentJson.push({ to: remoteId, msg: obj });
    return this.sendToPeer(remoteId, JSON.stringify(obj));
  }

  recordLatency(peerId, rtt) {
    this.latencies.set(peerId, rtt);
  }

  getLatency(peerId) {
    return this.latencies.get(peerId) || null;
  }
}

// ── harness ────────────────────────────────────────────────────────────────

function makePair(options = {}) {
  const link = new FakeLink(options.link || {});
  const pmA = new FakePeerManager('a', link);
  const pmB = new FakePeerManager('b', link);
  pmA.openChannel('b');
  pmB.openChannel('a');

  const engineA = new TransferEngine(pmA, Object.assign({ chunkSize: CHUNK }, options.engineA));
  const engineB = new TransferEngine(pmB, Object.assign({ chunkSize: CHUNK }, options.engineB));

  link.register('a', engineA);
  link.register('b', engineB);

  return { link, pmA, pmB, engineA, engineB };
}

/**
 * Complete the version handshake. One side opening is enough: the hello
 * exchange is synchronous over the link and each side learns the other's
 * version from it.
 */
function handshake(engineA, link) {
  engineA.handleChannelOpen('b');
  assert.ok(link.countJson('hello') >= 1, 'handshake sent a hello');
}

function recordIncoming(engine) {
  const events = { incoming: [], complete: [], incomplete: [], failure: [], cancelled: [], progress: [], latency: [], control: [], mismatch: [], verification: [] };
  engine.onIncoming = (d) => events.incoming.push(d);
  engine.onComplete = (d) => events.complete.push(d);
  engine.onIncomplete = (d) => events.incomplete.push(d);
  engine.onFailure = (d) => events.failure.push(d);
  engine.onCancelled = (transferId, info) => events.cancelled.push(Object.assign({ transferId }, info || {}));
  engine.onProgress = (d) => events.progress.push(d);
  engine.onLatency = (p, r) => events.latency.push({ peerId: p, rtt: r });
  engine.onControl = (p, m) => events.control.push({ peerId: p, msg: m });
  engine.onProtocolMismatch = (d) => events.mismatch.push(d);
  engine.onVerificationUnavailable = (d) => events.verification.push(d);
  return events;
}

/**
 * Yield until `fn()` is true, or give up.
 *
 * Uses setTimeout rather than setImmediate: consecutive immediates can starve
 * the poll phase, and `crypto.subtle.digest` resolves from the thread pool, so
 * verification would appear to hang.
 */
async function waitFor(fn, attempts = 400) {
  for (let i = 0; i < attempts; i++) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return fn();
}

/** Wait for `fn()` to become true, bounded by real elapsed milliseconds. */
async function waitUntil(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return fn();
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Build a transfer by hand so frame arrival can be controlled exactly, without
 * the sender engine in the way.
 */
async function announceTransfer(engineB, opts) {
  const bytes = opts.bytes;
  const chunkSize = opts.chunkSize || CHUNK;
  const totalChunks = opts.totalChunks !== undefined
    ? opts.totalChunks
    : Math.ceil(bytes.byteLength / chunkSize);
  const transferId = opts.transferId;
  const digest = opts.digest === undefined ? await sha256Hex(bytes) : opts.digest;

  engineB.handleData('a', JSON.stringify({
    type: 'transfer_start',
    transferId,
    fileName: opts.fileName || 'manual.bin',
    fileSize: opts.fileSize !== undefined ? opts.fileSize : bytes.byteLength,
    fileType: 'application/octet-stream',
    totalChunks,
    chunkSize,
    digest,
    verifiable: !!digest,
    protocolVersion: Framing.PROTOCOL_VERSION,
  }));

  await waitFor(() => engineB.incoming.has(transferId));
  const entry = engineB.incoming.get(transferId);
  if (entry && entry.ready) await entry.ready;
  if (opts.expectRegistered !== false) {
    assert.ok(engineB.incoming.has(transferId), 'incoming transfer was registered');
    assert.ok(entry.receiver, 'the receiver exists once storage is resolved');
  }

  return {
    transferId,
    totalChunks,
    digest,
    frames: Array.from({ length: totalChunks }, (_, seq) => {
      const start = seq * chunkSize;
      return Framing.encodeChunk(transferId, seq, bytes.subarray(start, Math.min(start + chunkSize, bytes.byteLength)));
    }),
  };
}

const completeMessage = (t) => JSON.stringify({ type: 'transfer_complete', transferId: t.transferId, totalChunks: t.totalChunks });

async function disposeAll(engines) {
  for (const engine of engines) await engine.dispose();
}

// ── tests ──────────────────────────────────────────────────────────────────

const tests = {
  // The regression that motivated this rewrite. Under the old protocol these
  // three transfers shared one pending-metadata slot per peer and each file was
  // assembled from chunks belonging to the others.
  async 'three simultaneous files to one peer each reassemble byte-for-byte'() {
    const { link, engineA, engineB } = makePair();
    const eventsB = recordIncoming(engineB);
    handshake(engineA, link);

    const sources = [
      makeBytes(200, 11),
      makeBytes(33, 22),
      makeBytes(7, 33),
    ];
    const names = ['alpha.bin', 'beta.bin', 'gamma.bin'];

    const ids = await Promise.all(sources.map((bytes, i) =>
      engineA.sendFile(makeFile(bytes, names[i]), 'b')));

    assert.equal(ids.filter((id) => id === null).length, 0, 'no transfer was refused');
    assert.equal(new Set(ids).size, 3, 'each transfer got its own id');

    await Promise.all(ids.map((id) => engineA.waitForTransfer(id)));
    await waitFor(() => eventsB.complete.length === 3);

    assert.equal(eventsB.complete.length, 3, 'three transfers completed');
    assert.equal(eventsB.failure.length, 0, 'no transfer failed');

    for (let i = 0; i < 3; i++) {
      const done = eventsB.complete.find((c) => c.fileName === names[i]);
      assert.ok(done, `${names[i]} completed`);
      assert.equal(done.verified, true, `${names[i]} was digest-verified`);
      assert.equal(done.streaming, false, `${names[i]} used the in-memory path`);
      assert.bytesEqual(done.bytes, sources[i], `${names[i]} is byte-for-byte identical`);
    }

    await disposeAll([engineA, engineB]);
  },

  // Chunk routing must use the envelope's own transfer id, so arrival order
  // between concurrent transfers is irrelevant.
  async 'two concurrent transfers with interleaved frame arrival order still reassemble correctly'() {
    // Nacks are swallowed so only the reordered frames can satisfy the
    // transfers, and the retry bound is lifted so the test cannot race it.
    const { link, engineA, engineB } = makePair({
      engineB: { maxResendAttempts: 100000, resendBackoffMs: [1000] },
      link: { transformJson: (msg) => (msg.type === 'nack' ? null : msg) },
    });
    const eventsB = recordIncoming(engineB);
    handshake(engineA, link);

    const first = makeBytes(120, 101);
    const second = makeBytes(64, 202);

    link.holdAll = true;
    const [idA, idB] = await Promise.all([
      engineA.sendFile(makeFile(first, 'one.bin'), 'b'),
      engineA.sendFile(makeFile(second, 'two.bin'), 'b'),
    ]);
    await Promise.all([engineA.waitForTransfer(idA), engineA.waitForTransfer(idB)]);

    const held = link.pending.length;
    assert.ok(held > 8, `frames were held for reordering (held ${held})`);
    await link.releaseShuffled(24680);

    await waitFor(() => eventsB.complete.length === 2);
    assert.equal(eventsB.complete.length, 2, 'both transfers completed');
    assert.equal(eventsB.failure.length, 0, 'neither transfer failed');

    const one = eventsB.complete.find((c) => c.fileName === 'one.bin');
    const two = eventsB.complete.find((c) => c.fileName === 'two.bin');
    assert.bytesEqual(one.bytes, first, 'one.bin is intact despite interleaving');
    assert.bytesEqual(two.bytes, second, 'two.bin is intact despite interleaving');

    await disposeAll([engineA, engineB]);
  },

  async 'a dropped chunk reports INCOMPLETE with the exact missing sequence numbers and does not complete'() {
    const { engineB } = makePair({
      engineB: { maxResendAttempts: 2, resendBackoffMs: [5, 5] },
    });
    const eventsB = recordIncoming(engineB);

    const source = makeBytes(CHUNK * 5, 7);
    const t = await announceTransfer(engineB, { transferId: 900, bytes: source });

    // Sequence 2 never arrives, however many times it is requested.
    for (let seq = 0; seq < t.totalChunks; seq++) {
      if (seq === 2) continue;
      engineB.handleData('a', t.frames[seq]);
    }
    engineB.handleData('a', completeMessage(t));

    await waitFor(() => eventsB.incomplete.length > 0);
    assert.ok(eventsB.incomplete.length > 0, 'INCOMPLETE was reported');

    const first = eventsB.incomplete[0];
    assert.deepEqual(first.missingChunks, [2], 'exactly the missing sequence number is named');
    assert.equal(first.code, 'INCOMPLETE');
    assert.match(first.message, /1 of 5 chunks missing/, 'the message names the gap');
    assert.match(first.message, /\b2\b/, 'the message names sequence 2');
    assert.equal(first.maxAttempts, 2, 'the retry bound is reported');
    assert.equal(eventsB.complete.length, 0, 'no completion was reported for a partial file');

    await disposeAll([engineB]);
  },

  async 'a dropped chunk is recovered by retransmission without restarting the transfer'() {
    let dropped = 0;
    const { link, engineA, engineB } = makePair({
      link: { drop: (frame) => (frame.seq === 1 && dropped++ === 0 ? true : false) },
    });
    const eventsB = recordIncoming(engineB);
    handshake(engineA, link);

    const source = makeBytes(CHUNK * 4, 55);
    const id = await engineA.sendFile(makeFile(source, 'recovered.bin'), 'b');
    await engineA.waitForTransfer(id);

    await waitFor(() => eventsB.complete.length > 0 || eventsB.failure.length > 0);
    assert.equal(eventsB.failure.length, 0, 'the transfer recovered');
    assert.equal(eventsB.complete.length, 1, 'the transfer completed');
    assert.ok(eventsB.incomplete.length > 0, 'the gap was reported before recovery');
    assert.deepEqual(eventsB.incomplete[0].missingChunks, [1]);
    assert.equal(eventsB.complete[0].verified, true, 'the recovered file passed verification');
    assert.bytesEqual(eventsB.complete[0].bytes, source, 'the recovered file is intact');

    await disposeAll([engineA, engineB]);
  },

  async 'a corrupted chunk reports DIGEST_MISMATCH and leaves no retrievable artifact'() {
    const { link, engineA, engineB } = makePair({
      link: { corrupt: (frame) => frame.seq === 1 },
    });
    const eventsB = recordIncoming(engineB);
    handshake(engineA, link);

    const source = makeBytes(CHUNK * 4, 99);
    const id = await engineA.sendFile(makeFile(source, 'corrupt.bin'), 'b');
    await engineA.waitForTransfer(id);

    await waitFor(() => eventsB.complete.length > 0 || eventsB.failure.length > 0);

    assert.equal(eventsB.complete.length, 0, 'a corrupt file is never presented as complete');
    assert.equal(eventsB.failure.length, 1, 'exactly one failure was reported');

    const failure = eventsB.failure[0];
    assert.equal(failure.code, 'DIGEST_MISMATCH');
    assert.equal(failure.code !== 'INCOMPLETE', true, 'all chunks arrived, so this is not a gap');
    assert.ok(failure.expectedDigest && failure.actualDigest, 'both digests are reported');
    assert.notEqual(failure.expectedDigest, failure.actualDigest, 'the digests differ');
    assert.match(failure.message, /does not match the announced digest/);

    // Nothing retrievable survives: no transfer state, no blob handed over.
    assert.equal(engineB.incoming.size, 0, 'the receiver was removed from the registry');
    assert.equal(engineB.receivers.size, 0, 'no per-transfer state lingers');

    await disposeAll([engineA, engineB]);
  },

  async 'a resend request for already-recovered chunks is idempotent'() {
    const { engineB } = makePair({ engineB: { maxResendAttempts: 5, resendBackoffMs: [5] } });
    const eventsB = recordIncoming(engineB);

    const source = makeBytes(CHUNK * 4, 4242);
    const t = await announceTransfer(engineB, { transferId: 901, bytes: source });

    // Deliver everything except seq 1, then ask to complete.
    for (let seq = 0; seq < t.totalChunks; seq++) {
      if (seq === 1) continue;
      engineB.handleData('a', t.frames[seq]);
    }
    engineB.handleData('a', completeMessage(t));
    await waitFor(() => eventsB.incomplete.length > 0);
    assert.deepEqual(eventsB.incomplete[0].missingChunks, [1]);

    // Retransmission arrives and completes the transfer.
    engineB.handleData('a', t.frames[1]);
    await waitFor(() => eventsB.complete.length > 0);
    assert.equal(eventsB.complete.length, 1, 'the transfer completed once');
    assert.equal(eventsB.complete[0].verified, true, 'the repaired file verified');
    assert.bytesEqual(eventsB.complete[0].bytes, source, 'the repaired file is intact');

    // Now request chunks that were already recovered, twice each. Nothing may
    // break: no second completion, no failure, no new state.
    engineB.handleData('a', t.frames[0]);
    engineB.handleData('a', t.frames[0]);
    engineB.handleData('a', t.frames[1]);
    engineB.handleData('a', t.frames[1]);
    engineB.handleData('a', t.frames[3]);
    engineB.handleData('a', completeMessage(t));
    await tick();
    await tick();

    assert.equal(eventsB.complete.length, 1, 'still exactly one completion');
    assert.equal(eventsB.failure.length, 0, 'no failure was produced');
    assert.equal(engineB.incoming.size, 0, 'no transfer state was recreated');
    assert.equal(engineB.receivers.size, 0, 'the registry is still empty');

    await disposeAll([engineB]);
  },

  async 'a duplicate chunk below the watermark is discarded without corrupting the transfer'() {
    const { link, engineA, engineB } = makePair({
      link: { duplicate: (frame) => frame.seq === 0 || frame.seq === 2 },
    });
    const eventsB = recordIncoming(engineB);
    handshake(engineA, link);

    const source = makeBytes(CHUNK * 4, 606);
    const id = await engineA.sendFile(makeFile(source, 'dupes.bin'), 'b');
    await engineA.waitForTransfer(id);

    await waitFor(() => eventsB.complete.length > 0 || eventsB.failure.length > 0);
    assert.equal(eventsB.failure.length, 0, 'duplicates did not fail the transfer');
    assert.equal(eventsB.complete.length, 1, 'the transfer completed');
    assert.equal(eventsB.complete[0].verified, true, 'duplicates did not corrupt the content');
    assert.bytesEqual(eventsB.complete[0].bytes, source, 'the file is intact');

    await disposeAll([engineA, engineB]);
  },

  async 'bounded retry exhaustion fails naming the unrecovered sequence numbers and delivers no partial file'() {
    const { engineB } = makePair({
      engineB: { maxResendAttempts: 3, resendBackoffMs: [2, 2, 2] },
    });
    const eventsB = recordIncoming(engineB);

    const source = makeBytes(CHUNK * 6, 313);
    const t = await announceTransfer(engineB, { transferId: 902, bytes: source });

    // Sequence 3 never arrives, however many times it is requested.
    for (let seq = 0; seq < t.totalChunks; seq++) {
      if (seq === 3) continue;
      engineB.handleData('a', t.frames[seq]);
    }
    engineB.handleData('a', completeMessage(t));

    await waitFor(() => eventsB.failure.length > 0, 2000);

    assert.equal(eventsB.complete.length, 0, 'no partial file was delivered');
    assert.equal(eventsB.failure.length, 1, 'the transfer failed once');

    const failure = eventsB.failure[0];
    assert.equal(failure.code, 'RETRY_EXHAUSTED');
    assert.deepEqual(failure.missingChunks, [3], 'the unrecovered sequence number is named');
    assert.match(failure.message, /after 3 attempts/, 'the retry bound is named');
    assert.match(failure.message, /\b3\b/, 'the message names sequence 3');

    // Bounded: the retry loop stopped rather than spinning forever.
    assert.ok(eventsB.incomplete.length <= 4,
      `retry loop stopped after ${eventsB.incomplete.length} attempts, not forever`);
    assert.equal(engineB.incoming.size, 0, 'no transfer state lingers');

    // The sink was abandoned, so nothing partial is retrievable.
    const receiver = engineB.receivers.get(902);
    assert.equal(receiver, null, 'the receiver was dropped from the registry');

    await disposeAll([engineB]);
  },

  async 'a wall-clock timeout fails the transfer instead of retrying forever'() {
    const sent = [];
    const { engineB } = makePair({
      engineB: {
        transferTimeoutMs: 80,
        maxResendAttempts: 1000000, // retry bound deliberately not reached
        resendBackoffMs: [10],
      },
      link: {
        transformJson: (msg) => {
          if (msg.type !== 'nack') return msg;
          sent.push(msg);
          return null; // the sender never resends, so only the clock can end it
        },
      },
    });
    const eventsB = recordIncoming(engineB);

    const source = makeBytes(CHUNK * 5, 808);
    const t = await announceTransfer(engineB, { transferId: 903, bytes: source });

    // Only the first chunk ever arrives.
    engineB.handleData('a', t.frames[0]);
    engineB.handleData('a', completeMessage(t));

    await waitUntil(() => eventsB.failure.length > 0, 3000);

    assert.equal(eventsB.failure.length, 1, 'the transfer failed on the clock');
    assert.equal(eventsB.failure[0].code, 'TIMEOUT');
    assert.match(eventsB.failure[0].message, /timed out after 80 ms/);
    assert.deepEqual(eventsB.failure[0].missingChunks, [1, 2, 3, 4], 'the missing chunks are named');
    assert.equal(eventsB.complete.length, 0, 'nothing was delivered');

    const nacksAtFailure = sent.length;
    assert.ok(nacksAtFailure >= 1, 'the gap was retried before the clock ran out');

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(sent.length, nacksAtFailure, 'the retry loop stopped when the transfer failed');
    assert.equal(eventsB.failure.length, 1, 'the failure was reported exactly once');

    await disposeAll([engineB]);
  },

  async 'a protocol version mismatch is rejected naming both versions and starts no transfer'() {
    const { link, engineA, engineB, pmA } = makePair({
      link: {
        transformJson: (msg) => {
          // Simulate an older build: its hello advertises protocol v1.
          if (msg.type === 'hello') return Object.assign({}, msg, { protocolVersion: 1 });
          return msg;
        },
      },
    });
    const eventsB = recordIncoming(engineB);
    const eventsA = recordIncoming(engineA);
    handshake(engineA, link);

    assert.equal(engineA.getPeerProtocol('b').version, 1, 'the peer version was learned');

    const id = await engineA.sendFile(makeFile(makeBytes(64, 1), 'nope.bin'), 'b');

    assert.equal(id, null, 'no transfer was started');
    assert.equal(eventsA.mismatch.length, 1, 'a protocol mismatch was reported');
    assert.equal(eventsA.mismatch[0].localVersion, Framing.PROTOCOL_VERSION);
    assert.equal(eventsA.mismatch[0].peerVersion, 1);
    assert.match(eventsA.mismatch[0].message, /v2/, 'the local version is named');
    assert.match(eventsA.mismatch[0].message, /v1/, 'the peer version is named');

    assert.equal(eventsA.failure.length, 1, 'a failure was reported');
    assert.equal(eventsA.failure[0].code, 'PROTOCOL_MISMATCH');
    assert.equal(eventsA.failure[0].transferId, null, 'no transfer id was allocated');

    const starts = pmA.sentJson.filter((e) => e.msg.type === 'transfer_start');
    assert.equal(starts.length, 0, 'no transfer_start was ever sent');
    assert.equal(engineB.incoming.size, 0, 'no transfer was created on the peer');
    assert.equal(eventsB.complete.length, 0, 'no file was produced');

    await disposeAll([engineA, engineB]);
  },

  async 'an unknown transferId on a binary frame is ignored without throwing'() {
    const { engineB } = makePair();
    const eventsB = recordIncoming(engineB);

    const stray = Framing.encodeChunk(987654, 0, new Uint8Array([1, 2, 3, 4]));
    engineB.handleData('a', stray);
    engineB.handleData('a', stray);

    // A frame that is not a framed chunk at all is also ignored.
    assert.equal(Framing.isFramedChunk(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9])), false);
    engineB.handleData('a', new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]));
    engineB.handleData('a', new Uint8Array(3));

    assert.equal(engineB.incoming.size, 0, 'no transfer state was created');
    assert.equal(eventsB.failure.length, 0, 'a stray frame is not a transfer failure');
    assert.equal(eventsB.complete.length, 0, 'nothing completed');

    // The engine still works afterwards.
    const source = makeBytes(CHUNK * 3, 12);
    const t = await announceTransfer(engineB, { transferId: 904, bytes: source });
    for (const frame of t.frames) engineB.handleData('a', frame);
    engineB.handleData('a', completeMessage(t));
    await waitFor(() => eventsB.complete.length > 0);
    assert.bytesEqual(eventsB.complete[0].bytes, source, 'a real transfer still completes');

    await disposeAll([engineB]);
  },

  async 'an incoming transfer above the in-memory ceiling is refused with a message naming the limit'() {
    const limit = 48;
    const { engineB } = makePair({ engineB: { maxInMemoryBytes: limit } });
    const eventsB = recordIncoming(engineB);

    const source = makeBytes(limit + 16, 5);
    await announceTransfer(engineB, {
      transferId: 905,
      bytes: source,
      expectRegistered: false,
    });

    await waitFor(() => eventsB.failure.length > 0);

    assert.equal(eventsB.failure.length, 1, 'the transfer was refused');
    assert.equal(eventsB.failure[0].code, 'MEMORY_CEILING_EXCEEDED');
    assert.match(eventsB.failure[0].message, new RegExp(String(limit)), 'the limit is named in the message');
    assert.match(eventsB.failure[0].message, /secure origin/, 'the message says what to do instead');
    assert.equal(eventsB.complete.length, 0, 'no file was produced');
    assert.equal(engineB.incoming.size, 0, 'no state was kept');

    await disposeAll([engineB]);
  },

  async 'the in-memory ceiling is enforced while writing, not only at the announcement'() {
    const limit = 40;
    const { engineB } = makePair({ engineB: { maxInMemoryBytes: limit } });
    const eventsB = recordIncoming(engineB);

    // A dishonest announcement: 4 chunks of 16 bytes (64 bytes total) for a
    // declared fileSize of 8, which is under the limit.
    const source = makeBytes(CHUNK * 4, 6);
    const t = await announceTransfer(engineB, {
      transferId: 906,
      bytes: source,
      fileSize: 8,
      totalChunks: 4,
    });

    for (const frame of t.frames) engineB.handleData('a', frame);
    await waitFor(() => eventsB.failure.length > 0);

    assert.equal(eventsB.failure.length, 1, 'the ceiling stopped the transfer');
    assert.equal(eventsB.failure[0].code, 'MEMORY_CEILING_EXCEEDED');
    assert.match(eventsB.failure[0].message, new RegExp(String(limit)));
    assert.equal(eventsB.complete.length, 0, 'nothing was delivered');
    assert.equal(engineB.incoming.size, 0, 'the partial transfer was abandoned');

    await disposeAll([engineB]);
  },

  async 'a supplied writable stream is preferred over memory and the result is still verified'() {
    const parts = [];
    const stream = new WritableStream({
      write(chunk) {
        parts.push(chunk instanceof Uint8Array ? chunk.slice() : new Uint8Array(chunk));
      },
    });

    const seen = [];
    const { link, engineA, engineB } = makePair({
      engineB: {
        streamProvider: async (info) => {
          seen.push(info);
          return {
            stream,
            readBack: async () => concat(parts).buffer,
          };
        },
      },
    });
    const eventsB = recordIncoming(engineB);
    handshake(engineA, link);

    const source = makeBytes(CHUNK * 5, 66);
    const id = await engineA.sendFile(makeFile(source, 'streamed.bin'), 'b');
    await engineA.waitForTransfer(id);

    await waitFor(() => eventsB.complete.length > 0 || eventsB.failure.length > 0);

    assert.equal(seen.length, 1, 'the stream provider was consulted once');
    assert.equal(seen[0].fileName, 'streamed.bin', 'it was told what is arriving');
    assert.equal(eventsB.failure.length, 0, 'the streamed transfer did not fail');
    assert.equal(engineB.incoming.size, 0, 'the streamed transfer state was released');

    const done = eventsB.complete[0];
    assert.equal(done.streaming, true, 'the transfer reports itself as streamed');
    assert.equal(done.storage, 'stream', 'the storage mode is reported for the UI');
    assert.equal(done.verified, true, 'streamed content is still verified via read-back');
    assert.equal(done.blob, null, 'no Blob is built for content that is already on disk');
    assert.bytesEqual(done.bytes, concat(parts), 'the verified bytes are the ones written to disk');
    assert.bytesEqual(concat(parts), source, 'the bytes written to the stream are intact');

    await disposeAll([engineA, engineB]);
  },

  async 'the receiver reports whether a transfer is streaming or in memory'() {
    const { engineB } = makePair();
    const eventsB = recordIncoming(engineB);

    const source = makeBytes(CHUNK * 2, 77);
    const t = await announceTransfer(engineB, { transferId: 907, bytes: source });

    assert.equal(eventsB.incoming.length, 1, 'the arrival was announced');
    assert.equal(eventsB.incoming[0].streaming, false, 'no stream provider, so in-memory');
    assert.equal(eventsB.incoming[0].storage, 'memory');
    assert.equal(eventsB.incoming[0].maxInMemoryBytes, DEFAULT_MAX_IN_MEMORY_BYTES,
      'the ceiling in force is reported to the UI');
    assert.equal(eventsB.incoming[0].verifiable, true, 'the announced digest was accepted');

    for (const frame of t.frames) engineB.handleData('a', frame);
    engineB.handleData('a', completeMessage(t));
    await waitFor(() => eventsB.complete.length > 0);
    assert.equal(eventsB.complete[0].storage, 'memory');

    await disposeAll([engineB]);
  },

  async 'a cancelled incoming transfer is abandoned so no partial artifact survives'() {
    const { engineB } = makePair();
    const eventsB = recordIncoming(engineB);

    const source = makeBytes(CHUNK * 6, 88);
    const t = await announceTransfer(engineB, { transferId: 908, bytes: source });

    for (let seq = 0; seq < 3; seq++) engineB.handleData('a', t.frames[seq]);
    await waitFor(() => {
      const entry = engineB.incoming.get(908);
      return entry && entry.receiver.chunks.size === 3;
    });

    const sink = engineB.incoming.get(908).adapter.inner;
    assert.equal(sink.abandoned, false, 'the sink is live while receiving');

    const cancelled = engineB.cancelTransfer(908);
    assert.equal(cancelled, true, 'cancelTransfer accepted the incoming transfer');
    await waitFor(() => eventsB.cancelled.length > 0);

    assert.equal(eventsB.cancelled.length, 1, 'the cancellation was reported');
    assert.equal(eventsB.cancelled[0].direction, 'in', 'the cancellation reports the incoming direction');
    assert.equal(eventsB.cancelled[0].transferId, 908, 'the cancellation names the transfer');
    assert.equal(eventsB.complete.length, 0, 'no file was delivered');
    assert.equal(sink.abandoned, true, 'the sink was abandoned');
    assert.equal(sink.byteLength, 0, 'no partial content is retained');
    assert.equal(engineB.incoming.size, 0, 'no transfer state lingers');
    assert.equal(engineB.receivers.size, 0, 'the registry is clean');

    await disposeAll([engineB]);
  },

  async 'a peer-side cancellation abandons the incoming transfer'() {
    const { engineB } = makePair();
    const eventsB = recordIncoming(engineB);

    const source = makeBytes(CHUNK * 4, 99);
    const t = await announceTransfer(engineB, { transferId: 909, bytes: source });
    engineB.handleData('a', t.frames[0]);
    await waitFor(() => engineB.incoming.get(909).receiver.chunks.size === 1);

    engineB.handleData('a', JSON.stringify({
      type: 'transfer_cancel',
      transferId: 909,
      reason: 'cancelled',
    }));

    await waitFor(() => eventsB.cancelled.length > 0);
    assert.equal(eventsB.cancelled.length, 1, 'the cancellation was reported');
    assert.equal(eventsB.complete.length, 0, 'no file was delivered');
    assert.equal(engineB.incoming.size, 0, 'state was dropped');

    await disposeAll([engineB]);
  },

  async 'out-of-order frames are held until their predecessors arrive'() {
    const { engineB } = makePair();
    const eventsB = recordIncoming(engineB);

    const source = makeBytes(CHUNK * 4, 1212);
    const t = await announceTransfer(engineB, { transferId: 910, bytes: source });

    // Deliver strictly backwards, which a raw stream sink could not accept.
    for (let seq = t.totalChunks - 1; seq >= 0; seq--) engineB.handleData('a', t.frames[seq]);
    engineB.handleData('a', completeMessage(t));

    await waitFor(() => eventsB.complete.length > 0);
    assert.equal(eventsB.failure.length, 0, 'reversed arrival is not a failure');
    assert.equal(eventsB.complete[0].verified, true, 'the reordered file verified');
    assert.bytesEqual(eventsB.complete[0].bytes, source, 'the reordered file is intact');

    await disposeAll([engineB]);
  },

  async 'a transfer with no digest is reported unverifiable rather than silently unverified'() {
    const { engineB } = makePair();
    const eventsB = recordIncoming(engineB);

    const source = makeBytes(CHUNK * 2, 31);
    const t = await announceTransfer(engineB, { transferId: 911, bytes: source, digest: null });

    assert.equal(eventsB.incoming[0].verifiable, false, 'the arrival is flagged unverifiable');
    assert.equal(eventsB.verification.length, 1, 'the caller was told verification is impossible');

    for (const frame of t.frames) engineB.handleData('a', frame);
    engineB.handleData('a', completeMessage(t));

    await waitFor(() => eventsB.failure.length > 0);
    assert.equal(eventsB.failure.length, 1, 'an unverifiable transfer does not complete');
    assert.equal(eventsB.failure[0].code, 'UNVERIFIABLE');
    assert.equal(eventsB.complete.length, 0, 'nothing was presented as complete');

    await disposeAll([engineB]);
  },

  async 'progress reports current throughput for both directions'() {
    const { link, engineA, engineB } = makePair();
    const eventsA = recordIncoming(engineA);
    const eventsB = recordIncoming(engineB);
    handshake(engineA, link);

    const source = makeBytes(CHUNK * 20, 4);
    const id = await engineA.sendFile(makeFile(source, 'progress.bin'), 'b');
    await engineA.waitForTransfer(id);
    await waitFor(() => eventsB.complete.length > 0);

    const out = eventsA.progress.filter((p) => p.direction === 'out');
    const into = eventsB.progress.filter((p) => p.direction === 'in');

    assert.ok(out.length >= 20, 'outgoing progress was reported per chunk');
    assert.ok(into.length >= 20, 'incoming progress was reported per chunk');

    const lastOut = out[out.length - 1];
    assert.equal(lastOut.progress, 1, 'the outgoing progress reaches 100%');
    assert.ok(lastOut.speed >= 0, 'speed is a non-negative byte rate');

    const lastIn = into[into.length - 1];
    assert.equal(lastIn.progress, 1, 'the incoming progress reaches 100%');
    assert.ok(lastIn.speed >= 0, 'speed is a non-negative byte rate');

    await disposeAll([engineA, engineB]);
  },

  async 'ping and pong still drive onLatency'() {
    const { engineB } = makePair();
    const eventsB = recordIncoming(engineB);

    engineB.handleData('a', JSON.stringify({ type: 'ping', t: 1000 }));
    await tick();

    const pong = engineB.pm.sentJson.find((e) => e.msg.type === 'pong');
    assert.ok(pong, 'a pong was sent');
    assert.equal(pong.msg.t, 1000, 'the ping timestamp is echoed');

    engineB.handleData('a', JSON.stringify({ type: 'pong', t: Date.now() - 42 }));
    assert.equal(eventsB.latency.length, 1, 'latency was reported');
    assert.equal(engineB.pm.getLatency('a'), eventsB.latency[0].rtt, 'latency was recorded on the peer manager');
    assert.ok(eventsB.latency[0].rtt >= 42, 'the round trip is at least the elapsed time');

    await disposeAll([engineB]);
  },

  async 'unrecognised JSON is forwarded to onControl for the app layer'() {
    const { engineB } = makePair();
    const eventsB = recordIncoming(engineB);

    engineB.handleData('a', JSON.stringify({ type: 'chat', from: 'a', text: 'hi' }));
    engineB.handleData('a', JSON.stringify({ type: 'typing', from: 'a', isTyping: true }));
    engineB.handleData('a', 'not json at all');

    assert.equal(eventsB.control.length, 2, 'application messages reach onControl');
    assert.equal(eventsB.control[0].peerId, 'a', 'the peer id is supplied');
    assert.equal(eventsB.control[0].msg.type, 'chat');
    assert.equal(eventsB.control[1].msg.type, 'typing');

    await disposeAll([engineB]);
  },

  async 'pausing and resuming a transfer still streams every chunk'() {
    const { link, engineA, engineB } = makePair();
    const eventsB = recordIncoming(engineB);
    handshake(engineA, link);

    const source = makeBytes(CHUNK * 8, 17);
    const id = await engineA.sendFile(makeFile(source, 'paused.bin'), 'b');

    assert.equal(engineA.pauseTransfer(id), true, 'the transfer was paused');
    await tick();
    await tick();
    engineA.resumeTransfer(id);

    await engineA.waitForTransfer(id);
    await waitFor(() => eventsB.complete.length > 0);

    assert.equal(eventsB.failure.length, 0, 'the paused transfer did not fail');
    assert.bytesEqual(eventsB.complete[0].bytes, source, 'every chunk still arrived, in order');

    await disposeAll([engineA, engineB]);
  },

  async 'cancelling an outgoing transfer notifies the peer and stops streaming'() {
    const { link, engineA, engineB } = makePair();
    const eventsA = recordIncoming(engineA);
    const eventsB = recordIncoming(engineB);
    handshake(engineA, link);

    const source = makeBytes(CHUNK * 30, 21);
    const id = await engineA.sendFile(makeFile(source, 'doomed.bin'), 'b');
    engineA.cancelTransfer(id);

    await engineA.waitForTransfer(id);
    await waitFor(() => eventsA.cancelled.length > 0);

    assert.equal(eventsA.cancelled.length, 1, 'the local cancellation was reported');
    assert.equal(eventsA.cancelled[0].direction, 'out', 'the cancellation reports the outgoing direction');
    assert.equal(engineA.outgoing.size, 0, 'the transfer was removed');

    await waitFor(() => eventsB.cancelled.length > 0);
    assert.equal(eventsB.cancelled.length, 1, 'the peer was told to stop');
    assert.equal(eventsB.complete.length, 0, 'no file was delivered');

    await disposeAll([engineA, engineB]);
  },

  async 'the sender announces its digest so the receiver can verify the result'() {
    const { link, engineA, pmA } = makePair();
    handshake(engineA, link);

    const source = makeBytes(CHUNK * 3, 44);
    await engineA.sendFile(makeFile(source, 'digest.bin'), 'b');

    const start = pmA.sentJson.find((e) => e.msg.type === 'transfer_start');
    assert.ok(start, 'a transfer_start was sent');
    assert.equal(start.msg.protocolVersion, Framing.PROTOCOL_VERSION, 'the protocol version is announced');
    assert.equal(start.msg.totalChunks, 3, 'the chunk count is announced');
    assert.equal(start.msg.chunkSize, CHUNK, 'the chunk size is announced');
    assert.equal(start.msg.verifiable, true, 'the transfer is reported verifiable');
    assert.equal(start.msg.digest, await sha256Hex(source), 'the digest matches the file');
    assert.ok(start.msg.capabilities, 'capabilities are announced');

    await engineA.dispose();
  },
};

module.exports = {
  name: 'transfer-protocol',
  tests,
};
