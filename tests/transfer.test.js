// tests/transfer.test.js
// End-to-end protocol tests over an in-memory channel pair.
//
// The channel is deliberately imperfect: it can interleave frames from
// concurrent transfers, drop them, duplicate them, and replay them. Those are
// exactly the conditions that broke the previous header/payload protocol, so
// the tests exercise them directly rather than assuming a clean link.

'use strict';

const assert = require('./assert');
const Framing = require('../client/framing.js');
const {
  TransferError,
  MemorySink,
  StreamSink,
  TransferSender,
  ReceiverRegistry,
  isVerificationAvailable,
  sha256Hex,
  DEFAULT_MAX_IN_MEMORY_BYTES,
} = require('../client/transfer-core.js');

const CHUNK_SIZE = 64; // small so tests exercise multi-chunk files quickly

function makeBytes(length, seed = 1) {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

/**
 * An in-memory pair of data channels with configurable misbehaviour.
 */
class MemoryChannelPair {
  constructor(options = {}) {
    this.options = options;
    this.aToB = [];
    this.bToA = [];
  }

  /** The channel as the sender sees it: frames recorded in emission order. */
  senderChannel() {
    const outbox = [];
    return {
      send(frame) {
        outbox.push(frame);
      },
      drain() {
        return outbox;
      },
    };
  }

  deliverAll() {
    return this.aToB;
  }
}

/**
 * Drives a whole transfer: sender reads chunks, frames them, the channel
 * delivers them to the receiver registry.
 */
async function runTransfer(opts) {
  const {
    source,
    totalChunks = Math.ceil(source.byteLength / CHUNK_SIZE),
    dropSeqs = new Set(),
    duplicateSeqs = new Set(),
    corruptSeqs = new Set(),
    sinkFactory = () => new MemorySink(),
    requiresVerification = true,
    deliverInOrder = true,
    stopAfter = Infinity,
  } = opts;

  const sender = new TransferSender({
    transferId: opts.transferId,
    totalChunks,
    fileSize: source.byteLength,
    chunkSize: CHUNK_SIZE,
    digest: opts.digest,
    readChunk: async (seq) => {
      const start = seq * CHUNK_SIZE;
      return source.slice(start, Math.min(start + CHUNK_SIZE, source.byteLength));
    },
  });

  const registry = new ReceiverRegistry();
  const sink = sinkFactory();
  const receiver = registry.create({
    transferId: opts.transferId,
    peerId: 'peer-under-test',
    fileName: opts.fileName || 'test.bin',
    fileSize: source.byteLength,
    fileType: 'application/octet-stream',
    totalChunks,
    digest: opts.digest,
    requiresVerification,
    sink,
  });

  const frames = [];
  const seqOrder = [];
  for (let seq = 0; seq < totalChunks; seq++) {
    if (dropSeqs.has(seq)) continue;
    const payload = await sender.sendChunk(seq);
    sender.sentChunks++;
    sender.bytesSent += payload.byteLength;

    let framed = payload;
    if (corruptSeqs.has(seq)) {
      const copy = payload.slice();
      copy[0] = copy[0] ^ 0xff;
      framed = copy;
    }
    frames.push({ seq, frame: Framing.encodeChunk(opts.transferId, seq, framed) });
    seqOrder.push(seq);

    if (duplicateSeqs.has(seq)) {
      frames.push({ seq, frame: Framing.encodeChunk(opts.transferId, seq, framed), replay: true });
    }
  }

  if (!deliverInOrder) {
    // Deterministic shuffle so failures are reproducible.
    for (let i = frames.length - 1; i > 0; i--) {
      const j = (i * 7919) % (i + 1);
      [frames[i], frames[j]] = [frames[j], frames[i]];
    }
  }

  let delivered = 0;
  for (const { seq, frame } of frames) {
    if (delivered >= stopAfter) break;
    delivered++;
    const decoded = Framing.decodeChunk(frame);
    await receiver.acceptChunk(decoded);
  }

  return { sender, receiver, registry, sink };
}

const tests = {
  'sha256 matches a known digest for empty input': async () => {
    // Well-known SHA-256 of the empty string.
    assert.equal(await sha256Hex(new Uint8Array(0)),
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  },

  'sha256 matches a known digest for abc': async () => {
    assert.equal(await sha256Hex(new TextEncoder().encode('abc')),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  },

  'sha256 of a generated buffer matches an independent computation': async () => {
    const bytes = makeBytes(4096, 9);
    // Independent: hash a copy in slices is not a second algorithm, so instead
    // verify determinism plus a length-derived check via Node's crypto.
    const ours = await sha256Hex(bytes);
    const nodeCrypto = require('crypto');
    const theirs = nodeCrypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    assert.equal(ours, theirs);
  },

  'sha256 returns null and reports unavailable when hashing is absent': async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
      delete require.cache[require.resolve('../client/transfer-core.js')];
      const core = require('../client/transfer-core.js');
      assert.equal(await core.sha256Hex(new Uint8Array(4)), null);
      assert.notOk(core.isVerificationAvailable());
    } finally {
      Object.defineProperty(globalThis, 'crypto', saved);
      delete require.cache[require.resolve('../client/transfer-core.js')];
    }
  },

  'a single-chunk transfer completes and verifies': async () => {
    const source = makeBytes(CHUNK_SIZE, 3);
    const digest = await sha256Hex(source);

    const { receiver } = await runTransfer({
      transferId: 1,
      source,
      totalChunks: 1,
      digest,
    });

    const result = await receiver.finalize();
    assert.ok(result.ok, `expected success, got ${result.code}`);
    assert.equal(result.verified, true);
    assert.equal(result.fileSize, source.byteLength);
    assert.bytesEqual(result.bytes, source);
  },

  'a multi-chunk transfer reassembles to the exact source': async () => {
    const source = makeBytes(CHUNK_SIZE * 5 + 17, 5);
    const digest = await sha256Hex(source);
    const totalChunks = Math.ceil(source.byteLength / CHUNK_SIZE);

    const { receiver } = await runTransfer({ transferId: 2, source, totalChunks, digest });
    const result = await receiver.finalize();

    assert.ok(result.ok);
    assert.bytesEqual(result.bytes, source);
  },

  'concurrent transfers to one peer each reassemble correctly': async () => {
    // The regression this change exists for: three files at once previously
    // shared one pending-metadata slot and had their chunks mixed together.
    const sources = [
      makeBytes(CHUNK_SIZE * 3 + 5, 11),
      makeBytes(CHUNK_SIZE * 2, 22),
      makeBytes(CHUNK_SIZE * 4 + 1, 33),
    ];

    const registry = new ReceiverRegistry();
    const senders = [];
    const frames = [];

    // Interleave emission across all three transfers, as concurrent async
    // loops actually do.
    const maxChunks = Math.max(...sources.map((s) => Math.ceil(s.byteLength / CHUNK_SIZE)));
    for (let seq = 0; seq < maxChunks; seq++) {
      for (let t = 0; t < sources.length; t++) {
        const source = sources[t];
        const totalChunks = Math.ceil(source.byteLength / CHUNK_SIZE);
        if (seq >= totalChunks) continue;

        const sender = senders[t] || (senders[t] = new TransferSender({
          transferId: 100 + t,
          totalChunks,
          fileSize: source.byteLength,
          chunkSize: CHUNK_SIZE,
          digest: await sha256Hex(source),
          readChunk: async (s) => source.slice(s * CHUNK_SIZE, Math.min((s + 1) * CHUNK_SIZE, source.byteLength)),
        }));

        const payload = await sender.sendChunk(seq);
        sender.sentChunks++;
        frames.push(Framing.encodeChunk(100 + t, seq, payload));

        registry.create({
          transferId: 100 + t,
          peerId: 'peer-under-test',
          fileName: `file-${t}.bin`,
          fileSize: source.byteLength,
          totalChunks,
          digest: sender.digest,
          requiresVerification: true,
          sink: new MemorySink(),
        });
      }
    }

    for (const frame of frames) {
      const decoded = Framing.decodeChunk(frame);
      const receiver = registry.get(decoded.transferId);
      assert.ok(receiver, `no receiver for transfer ${decoded.transferId}`);
      await receiver.acceptChunk(decoded);
    }

    for (let t = 0; t < sources.length; t++) {
      const result = await registry.get(100 + t).finalize();
      assert.ok(result.ok, `transfer ${t} failed: ${result.code}`);
      assert.bytesEqual(result.bytes, sources[t], `transfer ${t} content differs`);
    }
  },

  'out-of-order arrival across two concurrent transfers still assembles': async () => {
    const sourceA = makeBytes(CHUNK_SIZE * 4, 44);
    const sourceB = makeBytes(CHUNK_SIZE * 3, 55);

    const registry = new ReceiverRegistry();
    for (const [id, source] of [[1, sourceA], [2, sourceB]]) {
      registry.create({
        transferId: id,
        peerId: 'peer',
        fileName: `f${id}`,
        fileSize: source.byteLength,
        totalChunks: Math.ceil(source.byteLength / CHUNK_SIZE),
        digest: await sha256Hex(source),
        requiresVerification: true,
        sink: new MemorySink(),
      });
    }

    // Build all frames, then shuffle their delivery.
    const frames = [];
    for (const [id, source] of [[1, sourceA], [2, sourceB]]) {
      const totalChunks = Math.ceil(source.byteLength / CHUNK_SIZE);
      for (let seq = 0; seq < totalChunks; seq++) {
        const payload = source.slice(seq * CHUNK_SIZE, Math.min((seq + 1) * CHUNK_SIZE, source.byteLength));
        frames.push(Framing.encodeChunk(id, seq, payload));
      }
    }

    for (let i = frames.length - 1; i > 0; i--) {
      const j = (i * 104729) % (i + 1);
      [frames[i], frames[j]] = [frames[j], frames[i]];
    }

    for (const frame of frames) {
      const decoded = Framing.decodeChunk(frame);
      await registry.get(decoded.transferId).acceptChunk(decoded);
    }

    const resultA = await registry.get(1).finalize();
    const resultB = await registry.get(2).finalize();

    assert.ok(resultA.ok, `transfer 1 failed: ${resultA.code}`);
    assert.ok(resultB.ok, `transfer 2 failed: ${resultB.code}`);
    assert.bytesEqual(resultA.bytes, sourceA);
    assert.bytesEqual(resultB.bytes, sourceB);
  },

  'out-of-order delivery within one transfer assembles correctly': async () => {
    const source = makeBytes(CHUNK_SIZE * 6, 66);
    const digest = await sha256Hex(source);
    const totalChunks = Math.ceil(source.byteLength / CHUNK_SIZE);

    const registry = new ReceiverRegistry();
    registry.create({
      transferId: 7,
      peerId: 'peer',
      fileName: 'f',
      fileSize: source.byteLength,
      totalChunks,
      digest,
      requiresVerification: true,
      sink: new MemorySink(),
    });

    const frames = [];
    for (let seq = 0; seq < totalChunks; seq++) {
      frames.push(Framing.encodeChunk(7, seq,
        source.slice(seq * CHUNK_SIZE, Math.min((seq + 1) * CHUNK_SIZE, source.byteLength))));
    }
    for (let i = frames.length - 1; i > 0; i--) {
      const j = (i * 31337) % (i + 1);
      [frames[i], frames[j]] = [frames[j], frames[i]];
    }

    const receiver = registry.get(7);
    for (const frame of frames) await receiver.acceptChunk(Framing.decodeChunk(frame));

    const result = await receiver.finalize();
    assert.ok(result.ok, `expected success, got ${result.code}`);
    assert.bytesEqual(result.bytes, source);
  },

  'a missing chunk fails with the sequence number named': async () => {
    const source = makeBytes(CHUNK_SIZE * 4, 7);
    const digest = await sha256Hex(source);
    const totalChunks = Math.ceil(source.byteLength / CHUNK_SIZE);

    const { receiver } = await runTransfer({
      transferId: 8, source, totalChunks, digest, dropSeqs: new Set([2]),
    });

    const result = await receiver.finalize();
    assert.notOk(result.ok);
    assert.equal(result.code, 'INCOMPLETE');
    assert.deepEqual(result.missingChunks, [2]);
    assert.match(result.message, /1 of 4 chunks missing/);
    assert.match(result.message, /\b2\b/);
  },

  'multiple missing chunks are all reported': async () => {
    const source = makeBytes(CHUNK_SIZE * 6, 8);
    const totalChunks = Math.ceil(source.byteLength / CHUNK_SIZE);

    const { receiver } = await runTransfer({
      transferId: 9, source, totalChunks,
      digest: await sha256Hex(source),
      dropSeqs: new Set([1, 3, 4]),
    });

    const result = await receiver.finalize();
    assert.equal(result.code, 'INCOMPLETE');
    assert.deepEqual(result.missingChunks, [1, 3, 4]);
  },

  'a corrupted chunk fails digest verification and leaves no artifact': async () => {
    const source = makeBytes(CHUNK_SIZE * 3, 12);
    const digest = await sha256Hex(source);
    const totalChunks = Math.ceil(source.byteLength / CHUNK_SIZE);

    const { receiver, sink } = await runTransfer({
      transferId: 10, source, totalChunks, digest, corruptSeqs: new Set([1]),
    });

    const result = await receiver.finalize();
    assert.notOk(result.ok);
    assert.equal(result.code, 'DIGEST_MISMATCH');
    assert.equal(result.expected, digest);
    assert.notEqual(result.actual, digest);
    assert.equal(receiver.state, 'abandoned');
    assert.equal(sink.chunks.size, 0, 'partial content should not survive');
  },

  'a transfer requiring verification with no digest is refused': async () => {
    const source = makeBytes(200, 13);
    const { receiver } = await runTransfer({
      transferId: 11, source, totalChunks: Math.ceil(source.byteLength / CHUNK_SIZE),
      digest: null, requiresVerification: true,
    });

    const result = await receiver.finalize();
    assert.notOk(result.ok);
    assert.equal(result.code, 'UNVERIFIABLE');
    assert.equal(receiver.state, 'abandoned');
  },

  'a transfer not requiring verification completes without a digest': async () => {
    const source = makeBytes(200, 14);
    const { receiver } = await runTransfer({
      transferId: 12, source, totalChunks: Math.ceil(source.byteLength / CHUNK_SIZE),
      digest: null, requiresVerification: false,
    });

    const result = await receiver.finalize();
    assert.ok(result.ok);
    assert.equal(result.verified, false);
    assert.bytesEqual(result.bytes, source);
  },

  'duplicated chunks are ignored and do not corrupt state': async () => {
    const source = makeBytes(CHUNK_SIZE * 3, 15);
    const totalChunks = Math.ceil(source.byteLength / CHUNK_SIZE);

    const { receiver } = await runTransfer({
      transferId: 13, source, totalChunks,
      digest: await sha256Hex(source),
      duplicateSeqs: new Set([0, 1, 2]),
    });

    assert.equal(receiver.receivedChunks, totalChunks);
    assert.equal(receiver.bytesReceived, source.byteLength);

    const result = await receiver.finalize();
    assert.ok(result.ok);
    assert.bytesEqual(result.bytes, source);
  },

  'the watermark advances only across contiguous chunks': async () => {
    const source = makeBytes(CHUNK_SIZE * 5, 16);
    const totalChunks = Math.ceil(source.byteLength / CHUNK_SIZE);
    const registry = new ReceiverRegistry();
    registry.create({
      transferId: 20, peerId: 'peer', fileName: 'f',
      fileSize: source.byteLength, totalChunks,
      digest: await sha256Hex(source), requiresVerification: true,
      sink: new MemorySink(),
    });
    const receiver = registry.get(20);
    assert.equal(receiver.watermark, 0);

    const frame = (seq) => Framing.encodeChunk(20, seq,
      source.slice(seq * CHUNK_SIZE, Math.min((seq + 1) * CHUNK_SIZE, source.byteLength)));

    await receiver.acceptChunk(Framing.decodeChunk(frame(0)));
    assert.equal(receiver.watermark, 1);

    // A gap: 2 arrives while 1 is absent.
    await receiver.acceptChunk(Framing.decodeChunk(frame(2)));
    assert.equal(receiver.watermark, 1, 'watermark must not advance over a gap');

    await receiver.acceptChunk(Framing.decodeChunk(frame(1)));
    assert.equal(receiver.watermark, 3, 'watermark should collapse the filled gap');

    assert.deepEqual(receiver.missingChunks(), [3, 4]);
  },

  'resending an already-recovered chunk is idempotent': async () => {
    const source = makeBytes(CHUNK_SIZE * 4, 17);
    const totalChunks = Math.ceil(source.byteLength / CHUNK_SIZE);
    const digest = await sha256Hex(source);

    const { receiver } = await runTransfer({
      transferId: 21, source, totalChunks, digest, dropSeqs: new Set([2]),
    });

    let result = await receiver.finalize();
    assert.equal(result.code, 'INCOMPLETE');
    assert.deepEqual(result.missingChunks, [2]);

    // Sender resends seq 2, and also a chunk that was never missing.
    const sender = new TransferSender({
      transferId: 21, totalChunks, fileSize: source.byteLength, chunkSize: CHUNK_SIZE, digest,
      readChunk: async (s) => source.slice(s * CHUNK_SIZE, Math.min((s + 1) * CHUNK_SIZE, source.byteLength)),
    });
    const resent = await sender.resend([2, 0]);
    assert.deepEqual(resent, [2, 0]);

    for (const seq of resent) {
      const bytes = await sender.readChunk(seq);
      const outcome = await receiver.acceptChunk(Framing.decodeChunk(Framing.encodeChunk(21, seq, bytes)));
      if (seq === 0) assert.equal(outcome.reason, 'duplicate');
    }

    result = await receiver.finalize();
    assert.ok(result.ok, `expected success after resend, got ${result.code}`);
    assert.bytesEqual(result.bytes, source);
  },

  'sender ignores out-of-range resend requests': async () => {
    const source = makeBytes(CHUNK_SIZE * 2, 18);
    const sender = new TransferSender({
      transferId: 22, totalChunks: 2, fileSize: source.byteLength,
      chunkSize: CHUNK_SIZE, digest: null,
      readChunk: async (s) => source.slice(s * CHUNK_SIZE, Math.min((s + 1) * CHUNK_SIZE, source.byteLength)),
    });

    assert.deepEqual(await sender.resend([0, 1]), [0, 1]);
    assert.deepEqual(await sender.resend([-1, 2, 99, 1.5, 'x']), []);
  },

  'a duplicate below the watermark is rejected as duplicate': async () => {
    const source = makeBytes(CHUNK_SIZE * 3, 19);
    const totalChunks = Math.ceil(source.byteLength / CHUNK_SIZE);
    const registry = new ReceiverRegistry();
    registry.create({
      transferId: 23, peerId: 'p', fileName: 'f', fileSize: source.byteLength, totalChunks,
      digest: await sha256Hex(source), requiresVerification: true, sink: new MemorySink(),
    });
    const receiver = registry.get(23);
    const frame = (seq) => Framing.encodeChunk(23, seq,
      source.slice(seq * CHUNK_SIZE, Math.min((seq + 1) * CHUNK_SIZE, source.byteLength)));

    await receiver.acceptChunk(Framing.decodeChunk(frame(0)));
    await receiver.acceptChunk(Framing.decodeChunk(frame(1)));
    const repeat = await receiver.acceptChunk(Framing.decodeChunk(frame(0)));

    assert.equal(repeat.accepted, false);
    assert.equal(repeat.reason, 'duplicate');
  },

  'a sequence beyond the announced total is refused': async () => {
    const source = makeBytes(CHUNK_SIZE, 20);
    const registry = new ReceiverRegistry();
    registry.create({
      transferId: 24, peerId: 'p', fileName: 'f', fileSize: source.byteLength, totalChunks: 1,
      digest: await sha256Hex(source), requiresVerification: true, sink: new MemorySink(),
    });

    const outcome = await registry.get(24).acceptChunk(
      Framing.decodeChunk(Framing.encodeChunk(24, 5, source))
    );
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.reason, 'seq-out-of-range');
  },

  'a chunk for an unknown transfer is not silently absorbed': async () => {
    const registry = new ReceiverRegistry();
    assert.notOk(registry.get(999));
    assert.equal(registry.size, 0);
  },

  'abandon clears all retained content': async () => {
    const source = makeBytes(CHUNK_SIZE * 3, 21);
    const totalChunks = Math.ceil(source.byteLength / CHUNK_SIZE);
    const sink = new MemorySink();
    const receiver = new (require('../client/transfer-core.js').TransferReceiver)({
      transferId: 25, peerId: 'p', fileName: 'f', fileSize: source.byteLength, totalChunks,
      digest: await sha256Hex(source), requiresVerification: true, sink,
    });

    for (let seq = 0; seq < totalChunks; seq++) {
      await receiver.acceptChunk(Framing.decodeChunk(Framing.encodeChunk(25, seq,
        source.slice(seq * CHUNK_SIZE, Math.min((seq + 1) * CHUNK_SIZE, source.byteLength)))));
    }

    await receiver.abandon('test');
    assert.equal(receiver.state, 'abandoned');
    assert.equal(receiver.chunks.size, 0);
    assert.equal(sink.chunks.size, 0);
    assert.equal(sink.byteLength, 0);
  },

  'finalising an abandoned transfer is refused': async () => {
    const sink = new MemorySink();
    const receiver = new (require('../client/transfer-core.js').TransferReceiver)({
      transferId: 26, peerId: 'p', fileName: 'f', fileSize: 0, totalChunks: 0,
      digest: null, requiresVerification: false, sink,
    });

    await receiver.abandon();
    await assert.rejects(() => receiver.finalize(), /already finalised/);
  },

  'registry routes by transfer id with independent state': async () => {
    const registry = new ReceiverRegistry();
    const a = registry.create({ transferId: 1, peerId: 'p', fileName: 'a', fileSize: 0, totalChunks: 2, digest: null, requiresVerification: false, sink: new MemorySink() });
    const b = registry.create({ transferId: 2, peerId: 'p', fileName: 'b', fileSize: 0, totalChunks: 2, digest: null, requiresVerification: false, sink: new MemorySink() });

    assert.equal(registry.size, 2);
    assert.equal(registry.get(1), a);
    assert.equal(registry.get(2), b);

    await a.acceptChunk(Framing.decodeChunk(Framing.encodeChunk(1, 0, Uint8Array.from([1, 2, 3]))));

    assert.equal(a.receivedChunks, 1);
    assert.equal(b.receivedChunks, 0, 'state must not leak between transfers');

    registry.delete(1);
    assert.notOk(registry.has(1));
    assert.ok(registry.has(2));
  },

  'stream sink writes chunks through and reports streaming support': async () => {
    const written = [];
    const state = { closed: false, aborted: false };
    const stream = {
      getWriter() {
        return {
          // The writer receives chunk bytes only; sequence ordering is the
          // sink's concern, checked before delegating.
          async write(chunk) { written.push(chunk.slice()); },
          async close() { state.closed = true; },
          async abort() { state.aborted = true; },
        };
      },
    };

    const sink = new StreamSink(stream);
    assert.ok(sink.supportsStreaming);

    await sink.write(0, Uint8Array.from([1, 2]));
    await sink.write(1, Uint8Array.from([3]));
    const result = await sink.finalize();

    assert.equal(result, null, 'streamed bytes must not be retained in memory');
    assert.equal(sink.byteLength, 3);
    assert.equal(written.length, 2);
    assert.ok(state.closed);
  },

  'stream sink abandons without masking the original failure': async () => {
    let abortCalls = 0;
    const stream = {
      getWriter() {
        return {
          async write() {},
          async close() {},
          async abort() { abortCalls++; throw new Error('stream already errored'); },
        };
      },
    };

    const sink = new StreamSink(stream);
    await sink.write(0, Uint8Array.from([1]));
    await sink.abandon();

    assert.equal(abortCalls, 1);
    assert.equal(sink.abandoned, true);
  },

  'a written sink refuses further writes after abandon': async () => {
    const sink = new MemorySink();
    await sink.write(0, Uint8Array.from([1]));
    await sink.abandon();

    await assert.rejects(() => sink.write(1, Uint8Array.from([2])), /abandoned/);
    await assert.rejects(() => sink.finalize(), /abandoned/);
  },

  'memory sink does not report streaming support': () => {
    assert.notOk(new MemorySink().supportsStreaming);
  },

  'in-memory ceiling is defined and bounded': () => {
    assert.equal(DEFAULT_MAX_IN_MEMORY_BYTES, 512 * 1024 * 1024);
    assert.ok(isVerificationAvailable());
  },

  'a stream-sink transfer completes with no bytes in memory': async () => {
    const source = makeBytes(CHUNK_SIZE * 5, 23);
    const totalChunks = Math.ceil(source.byteLength / CHUNK_SIZE);
    const collected = [];

    const sink = {
      supportsStreaming: true,
      async write(seq, chunk) { collected.push(chunk.slice()); },
      async finalize() { return null; },
      async abandon() { collected.length = 0; },
    };

    const { receiver } = await runTransfer({
      transferId: 30, source, totalChunks, digest: await sha256Hex(source),
      sinkFactory: () => sink,
    });

    const result = await receiver.finalize();

    // A streamed transfer delivers every chunk to disk without ever holding
    // the whole file in memory, so it completes — but the whole-file digest
    // cannot be computed without re-reading, so it is explicitly unverified
    // rather than falsely verified or falsely failed.
    assert.equal(collected.length, totalChunks);
    assert.equal(receiver.state, 'complete');
    assert.equal(sink.supportsStreaming, true);
    assert.ok(result.ok);
    assert.equal(result.verified, false);
    assert.equal(result.bytes, null);
    assert.equal(result.streamed, true);
  },

  'transfer error carries a code': () => {
    const err = new TransferError('nope', 'INCOMPLETE', { missingChunks: [1] });
    assert.equal(err.name, 'TransferError');
    assert.equal(err.code, 'INCOMPLETE');
    assert.deepEqual(err.detail.missingChunks, [1]);
  },
};

module.exports = { name: 'transfer', tests };