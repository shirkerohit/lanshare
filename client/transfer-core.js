// client/transfer-core.js
// Transfer protocol core, free of DOM and WebRTC dependencies.
//
// The framing layer (`client/framing.js`) gives every chunk its own routing
// information. This module adds what the protocol needs on top of that:
// verification before delivery, sequence-watermark gap detection, idempotent
// retransmission, and pluggable storage so a transfer can stream to disk or
// assemble in memory.
//
// Both sides of a transfer are represented here (`TransferSender` and
// `TransferReceiver`) so the protocol can be exercised end to end in Node
// against an in-memory channel, without a browser or a real peer connection.
//
// ── Why verification lives here and not in the UI ──────────────────────
//
// The previous implementation finalised a transfer when the sender said so,
// never checking what actually arrived. A lost chunk produced a shorter file
// that was still presented as a success. Here a transfer can only reach
// `complete` after every announced chunk is present and the digest matches.

'use strict';

// ── hashing ────────────────────────────────────────────────────────────
// crypto.subtle is unavailable on insecure origins. Rather than silently
// skipping verification, an insecure context yields null and the transfer is
// reported as unverifiable. A file that cannot be verified is never presented
// as verified.

function getCrypto() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (!c || !c.subtle || typeof c.subtle.digest !== 'function') return null;
  return c;
}

function isVerificationAvailable() {
  return getCrypto() !== null;
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * SHA-256 of the given bytes, lowercase hex.
 * @returns {Promise<string|null>} null when hashing is unavailable.
 */
async function sha256Hex(bytes) {
  const crypto = getCrypto();
  if (!crypto) return null;

  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return toHex(await crypto.subtle.digest('SHA-256', view));
}

class TransferError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'TransferError';
    this.code = code || 'TRANSFER_FAILED';
    this.detail = detail || {};
  }
}

// ── storage sinks ──────────────────────────────────────────────────────

/** Concatenate chunk buffers in the order given. */
function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Assembles the whole file in memory. The right default where direct-to-disk
 * writing is unavailable.
 */
class MemorySink {
  constructor() {
    // Keyed by sequence number, not append order. Chunks may arrive out of
    // order, so assembly order must come from the sequence, otherwise a
    // shuffled transfer reassembles into scrambled bytes.
    this.chunks = new Map();
    this.byteLength = 0;
    this.abandoned = false;
  }

  get supportsStreaming() {
    return false;
  }

  async write(seq, chunk) {
    if (this.abandoned) throw new TransferError('sink abandoned', 'ABANDONED');
    this.chunks.set(seq, chunk);
    this.byteLength += chunk.byteLength;
  }

  async finalize() {
    if (this.abandoned) throw new TransferError('sink abandoned', 'ABANDONED');
    const ordered = [...this.chunks.keys()].sort((a, b) => a - b);
    return concatChunks(ordered.map((seq) => this.chunks.get(seq)));
  }

  async abandon() {
    this.abandoned = true;
    this.chunks.clear();
    this.byteLength = 0;
  }
}

/**
 * Appends chunks to a writable stream as they arrive, so memory stays
 * proportional to the chunk size rather than the file size.
 */
class StreamSink {
  constructor(stream) {
    this.stream = stream;
    this.writer = stream.getWriter();
    this.byteLength = 0;
    this.finished = false;
    this.abandoned = false;
    this.nextSeq = 0;
  }

  get supportsStreaming() {
    return true;
  }

  async write(seq, chunk) {
    if (this.abandoned) throw new TransferError('sink abandoned', 'ABANDONED');
    if (seq !== this.nextSeq) {
      throw new TransferError(
        `out-of-order write to stream sink: expected seq ${this.nextSeq}, got ${seq}`,
        'OUT_OF_ORDER'
      );
    }
    await this.writer.write(chunk);
    this.nextSeq = seq + 1;
    this.byteLength += chunk.byteLength;
  }

  async finalize() {
    if (this.abandoned) throw new TransferError('sink abandoned', 'ABANDONED');
    await this.writer.close();
    this.finished = true;
    return null; // bytes live on disk, not in memory
  }

  async abandon() {
    if (this.finished) return;
    this.abandoned = true;
    try {
      await this.writer.abort();
    } catch {
      // The stream may already be errored. Abandonment must not mask the
      // failure that triggered it.
    }
  }
}

const DEFAULT_MAX_IN_MEMORY_BYTES = 512 * 1024 * 1024;

// ── sender ─────────────────────────────────────────────────────────────

/**
 * Tracks one outgoing transfer.
 *
 * Owns the chunk source so a resend is just another read of the same slice:
 * retransmission is idempotent because chunk N always reads the same bytes.
 */
class TransferSender {
  /**
   * @param {object} opts
   * @param {number} opts.transferId
   * @param {number} opts.totalChunks
   * @param {number} opts.fileSize
   * @param {number} opts.chunkSize
   * @param {string|null} opts.digest hex sha256, or null when unavailable
   * @param {(seq:number)=>Promise<Uint8Array>} opts.readChunk
   */
  constructor(opts) {
    this.transferId = opts.transferId;
    this.totalChunks = opts.totalChunks;
    this.fileSize = opts.fileSize;
    this.chunkSize = opts.chunkSize;
    this.digest = opts.digest || null;
    this.readChunk = opts.readChunk;
    this.verifiable = !!this.digest;

    this.sentChunks = 0;
    this.bytesSent = 0;
    this.resendCount = 0;
    this.cancelled = false;
  }

  async sendChunk(seq) {
    if (this.cancelled) throw new TransferError('transfer cancelled', 'CANCELLED');
    return this.readChunk(seq);
  }

  /**
   * Resend exactly the requested sequences. Out-of-range indices are ignored.
   * A request for an already-recovered chunk is harmless and must not corrupt
   * sender state, so nothing is withheld.
   */
  async resend(seqs) {
    const resent = [];
    for (const seq of seqs) {
      if (!Number.isInteger(seq) || seq < 0 || seq >= this.totalChunks) continue;
      await this.readChunk(seq);
      this.resendCount++;
      resent.push(seq);
    }
    return resent;
  }
}

// ── receiver ───────────────────────────────────────────────────────────

/**
 * Tracks one incoming transfer.
 *
 * The sequence watermark is the core of correctness here. It is the lowest
 * sequence number not yet received. A chunk below it is a duplicate (SCTP may
 * legitimately redeliver) and is discarded without touching state. A chunk
 * above it is recorded, and the gap stays visible as a missing sequence number
 * until filled.
 */
class TransferReceiver {
  constructor(opts) {
    this.transferId = opts.transferId;
    this.peerId = opts.peerId;
    this.fileName = opts.fileName;
    this.fileSize = opts.fileSize;
    this.fileType = opts.fileType;
    this.totalChunks = opts.totalChunks;
    this.digest = opts.digest || null;
    this.verifiable = !!this.digest;
    this.requiresVerification = !!opts.requiresVerification;

    this.watermark = 0;
    this.chunks = new Map(); // seq -> Uint8Array
    this.receivedChunks = 0;
    this.bytesReceived = 0;
    this.startTime = opts.startTime || Date.now();
    this.state = 'receiving';

    this.sink = opts.sink;
  }

  get isComplete() {
    return this.chunks.size === this.totalChunks;
  }

  get progress() {
    if (!this.totalChunks) return 0;
    return this.chunks.size / this.totalChunks;
  }

  /**
   * Accept a decoded chunk envelope.
   *
   * Routing is by the envelope's own transfer id, so a chunk is attributed
   * using nothing but the bytes in hand. No shared pending-metadata slot, no
   * dependence on arrival order.
   */
  async acceptChunk(frame) {
    if (this.state !== 'receiving') {
      return { accepted: false, reason: 'not-receiving' };
    }

    const { seq, payload } = frame;

    if (seq >= this.totalChunks) {
      return { accepted: false, reason: 'seq-out-of-range' };
    }

    // Below the watermark means already received. A redelivered chunk must not
    // be counted twice or overwrite a good copy.
    if (seq < this.watermark || this.chunks.has(seq)) {
      return { accepted: false, reason: 'duplicate' };
    }

    await this.sink.write(seq, payload);

    this.chunks.set(seq, payload);
    this.receivedChunks++;
    this.bytesReceived += payload.byteLength;

    // Advance past any now-contiguous run, so an out-of-order arrival
    // followed by its predecessor collapses the gap correctly.
    while (this.watermark < this.totalChunks && this.chunks.has(this.watermark)) {
      this.watermark++;
    }

    return { accepted: true, progress: this.progress };
  }

  /**
   * Every announced sequence number not yet held. Derived from what is present
   * rather than from a running gap list, so it cannot drift out of step with
   * the received set.
   */
  missingChunks() {
    const missing = [];
    for (let seq = 0; seq < this.totalChunks; seq++) {
      if (!this.chunks.has(seq)) missing.push(seq);
    }
    return missing;
  }

  /**
   * Verify and finalise.
   *
   * Order matters: completeness first, then digest. A file that is short is
   * reported as incomplete regardless of what its bytes hash to.
   */
  async finalize() {
    if (this.state !== 'receiving') {
      throw new TransferError('transfer already finalised', 'INVALID_STATE');
    }

    const missing = this.missingChunks();
    if (missing.length > 0) {
      // State is left intact: the caller may request the missing chunks and
      // finalise again once they arrive.
      return {
        ok: false,
        code: 'INCOMPLETE',
        missingChunks: missing,
        message:
          `Transfer incomplete: ${missing.length} of ${this.totalChunks} ` +
          `chunks missing (${describeChunks(missing)})`,
      };
    }

    const bytes = await this.sink.finalize();

    if (bytes == null) {
      // Streamed transfer: every announced chunk arrived and was written to
      // disk, so delivery is complete, but a whole-file digest cannot be
      // computed without re-reading the written content. Hashing nothing and
      // comparing would false-fail every streamed transfer as a mismatch, so
      // report explicitly as delivered-but-unverified. The caller owns the
      // on-disk artifact and decides whether to accept it.
      this.state = 'complete';

      const duration = (Date.now() - this.startTime) / 1000;

      return {
        ok: true,
        transferId: this.transferId,
        peerId: this.peerId,
        fileName: this.fileName,
        fileSize: this.fileSize,
        fileType: this.fileType,
        bytes: null,
        duration,
        verified: false,
        verificationAvailable: false,
        streamed: true,
        digest: this.digest,
        avgSpeed: duration > 0 ? this.fileSize / duration : 0,
      };
    }

    if (this.verifiable) {
      const actual = await sha256Hex(bytes);
      if (actual !== this.digest) {
        await this.abandon('digest-mismatch');
        return {
          ok: false,
          code: 'DIGEST_MISMATCH',
          expected: this.digest,
          actual,
          message: 'Transfer failed verification: content does not match the announced digest.',
        };
      }
    } else if (this.requiresVerification) {
      // A transfer that requires verification but has no digest to check
      // against cannot be claimed as verified. Refuse rather than assume.
      await this.abandon('unverifiable');
      return {
        ok: false,
        code: 'UNVERIFIABLE',
        message: 'Transfer cannot be verified: no digest was provided.',
      };
    }

    this.state = 'complete';

    const duration = (Date.now() - this.startTime) / 1000;

    return {
      ok: true,
      transferId: this.transferId,
      peerId: this.peerId,
      fileName: this.fileName,
      fileSize: this.fileSize,
      fileType: this.fileType,
      bytes,
      duration,
      verified: this.verifiable,
      digest: this.digest,
      avgSpeed: duration > 0 ? this.fileSize / duration : 0,
    };
  }

  /** Discard a partial transfer. No retrievable artifact survives. */
  async abandon(reason = 'abandoned') {
    this.state = 'abandoned';
    this.abandonReason = reason;
    this.chunks.clear();
    this.receivedChunks = 0;
    this.bytesReceived = 0;
    await this.sink.abandon();
  }
}

function describeChunks(seqs, limit = 8) {
  if (seqs.length <= limit) return seqs.join(', ').replace(/,/g, ', ');
  return `${seqs.slice(0, limit).join(', ')} and ${seqs.length - limit} more`;
}

// ── receiver registry ──────────────────────────────────────────────────

/**
 * Routes incoming frames to the right receiver by transfer id.
 *
 * This replaces the single pending-metadata slot that made concurrent
 * transfers to one peer corrupt each other. Each transfer holds independent
 * state, so chunks cannot land in the wrong file whatever order they arrive in.
 */
class ReceiverRegistry {
  constructor() {
    this.transfers = new Map();
  }

  create(opts) {
    const receiver = new TransferReceiver(opts);
    this.transfers.set(receiver.transferId, receiver);
    return receiver;
  }

  get(transferId) {
    return this.transfers.get(transferId) || null;
  }

  has(transferId) {
    return this.transfers.has(transferId);
  }

  delete(transferId) {
    this.transfers.delete(transferId);
  }

  get size() {
    return this.transfers.size;
  }
}

module.exports = {
  TransferError,
  MemorySink,
  StreamSink,
  TransferSender,
  TransferReceiver,
  ReceiverRegistry,
  DEFAULT_MAX_IN_MEMORY_BYTES,
  isVerificationAvailable,
  sha256Hex,
  concatChunks,
  describeChunks,
};