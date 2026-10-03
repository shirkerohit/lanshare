// client/transfer.js
// Transfer engine: the WebRTC-facing half of the file transfer protocol.
//
// The protocol itself lives in two dependency-free modules:
//
//   client/framing.js       self-describing binary envelope (transfer id, seq, length)
//   client/transfer-core.js sender, receiver, sinks, verification, gap detection
//
// This file wires those to a `PeerManager` and the browser event loop: it
// announces transfers, streams framed chunks with `bufferedAmount`
// backpressure, routes incoming frames by the transfer id in the frame itself,
// drives bounded retransmission, enforces a wall-clock timeout, and refuses to
// present anything that has not been verified.
//
// ── Why there is no shared pending-metadata slot ────────────────────────
//
// The previous implementation kept ONE pending chunk-header slot per peer.
// Two files sent to the same device at once overwrote each other's slot, so
// payloads were attributed to the wrong file and both transfers were silently
// corrupt while reporting success. Routing here uses only the bytes in hand —
// `Framing.decodeChunk()` returns the transfer id the chunk was sent under —
// so interleaving is impossible by construction rather than by luck. There is
// no ordering assumption and no per-peer slot to race on.
//
// ── what the app layer must do ──────────────────────────────────────────
//
// 1. `new TransferEngine(peerManager, { streamProvider })`.
// 2. On every `channel_open` for a peer call `engine.handleChannelOpen(peerId)`.
//    This sends the `hello` handshake and resets state for the fresh channel.
//    Without it the first send waits up to `HELLO_WAIT_MS` for a reply.
// 3. Route channel traffic: `engine.handleData(peerId, e.data)`.
// 4. Supply `streamProvider` to receive files straight to disk. It is called
//    once per incoming transfer with
//    `{ transferId, fileName, fileSize, fileType, totalChunks, peerId }` and
//    may return `null` to fall back to memory, a `WritableStream`, or
//    `{ stream, handle?, readBack? }`. Returning `readBack` (or `handle`)
//    keeps digest verification enabled for streamed files.
// 5. Treat `onFailure` / `onIncomplete` / `onProtocolMismatch` as distinct
//    user-visible states. Nothing is ever reported complete without passing
//    both the completeness check and the digest check.

(function (root, factory) {
  if (typeof module === 'object' && module.exports && typeof require === 'function') {
    // Node (tests): pull the core modules in directly.
    module.exports = factory(
      require('./framing.js'),
      require('./transfer-core.js'),
      root
    );
  } else {
    // Browser: framing.js is UMD and self-registers as window.Framing;
    // transfer-core.js is a CommonJS module, lifted onto window.TransferCore by
    // a shim in index.html.
    root.TransferEngine = factory(root.Framing, root.TransferCore, root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Framing, Core, root) {
  'use strict';

  if (!Framing) throw new Error('LanShare: framing.js must load before transfer.js');
  if (!Core) throw new Error('LanShare: transfer-core.js must load before transfer.js');

  // ── tuning constants ──────────────────────────────────────────────────────
  // Exposed on TransferEngine and overridable per instance via constructor
  // options, so tests can shorten them and a future change can retune them
  // without touching the protocol.

  // Matches webrtc.js CHUNK_SIZE (256KB). Used only when webrtc.js's global is
  // unavailable, i.e. outside the browser.
  const DEFAULT_CHUNK_SIZE = 256 * 1024;

  // Bounded retransmission: at most this many nacks (missing-chunk requests)
  // per transfer. On exhaustion the transfer fails and names the sequence
  // numbers it could not recover. Never unbounded.
  const MAX_RESEND_ATTEMPTS = 5;

  // Backoff before re-checking for recovered chunks. Indexed by attempt number.
  const RESEND_BACKOFF_MS = [150, 300, 600, 1200, 2400];

  // Independent wall-clock ceiling per transfer, so a dead peer fails visibly
  // instead of retrying forever. Not the same thing as the retry bound.
  const TRANSFER_TIMEOUT_MS = 5 * 60 * 1000;

  // How long to wait for a peer's `hello` before declaring the peer
  // incompatible. A peer that never handshakes is an older build.
  const HELLO_WAIT_MS = 3000;

  // bufferedAmount backpressure: stop writing while the channel buffer is
  // above this, resume when it drains.
  const HIGH_WATER_MARK = 2 * 1024 * 1024;
  const BACKPRESSURE_POLL_MS = 5;
  const PAUSE_POLL_MS = 50;

  // Progress/speed are sampled over this window rather than averaged from zero,
  // so the readout reflects current throughput instead of a cumulative average.
  const PROGRESS_INTERVAL_MS = 250;

  // ── JSON control message names ────────────────────────────────────────────
  // The app layer must not treat these as opaque application messages: they are
  // consumed by the protocol. Everything else is forwarded to `onControl`.

  const CONTROL = {
    HELLO: 'hello',
    HELLO_ACK: 'hello_ack',
    TRANSFER_START: 'transfer_start',
    TRANSFER_COMPLETE: 'transfer_complete',
    TRANSFER_CANCEL: 'transfer_cancel',
    TRANSFER_FAILED: 'transfer_failed',
    NACK: 'nack',
    PING: 'ping',
    PONG: 'pong',
    SPEED_TEST_START: 'speed_test_start',
    SPEED_TEST_PACKET: 'speed_test_packet',
    SPEED_TEST_ACK: 'speed_test_ack',
  };

  // Accepted aliases for the missing-chunk request, so a peer using either
  // spelling interoperates. `nack` is canonical.
  const NACK_ALIASES = ['nack', 'resend', 'resend_request', 'chunk_nack'];

  // ── small helpers ─────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function readAll(file) {
    if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
    throw new Core.TransferError('file cannot be read: no arrayBuffer()', 'UNREADABLE');
  }

  async function readSlice(file, seq, chunkSize) {
    const start = seq * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const blob = file.slice(start, end);
    if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
    return new Uint8Array(await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('read failed'));
      reader.readAsArrayBuffer(blob);
    }));
  }

  function describeSeqs(seqs) {
    return Core.describeChunks(seqs);
  }

  /**
   * Ordering adapter placed between `TransferReceiver` and the storage sink.
   *
   * `StreamSink` genuinely cannot accept an out-of-order write — the bytes are
   * appended to a file, so chunk N+1 before chunk N would silently misplace
   * data. `TransferReceiver` accepts chunks in whatever order they arrive, so
   * this adapter holds a chunk back until its predecessors have been written.
   *
   * Buffered chunks are still counted by the receiver, so a chunk stuck in the
   * buffer counts as missing and is requested by sequence number like any other
   * gap. For `MemorySink` the adapter is harmless and keeps one code path.
   */
  class SequencedSink {
    constructor(inner, readBack) {
      this.inner = inner;
      this.readBack = readBack || null;
      this.nextSeq = 0;
      this.pending = new Map();
      this.abandoned = false;
    }

    get supportsStreaming() {
      return !!this.inner.supportsStreaming;
    }

    get byteLength() {
      return this.inner.byteLength;
    }

    async write(seq, chunk) {
      if (this.abandoned) throw new Core.TransferError('sink abandoned', 'ABANDONED');
      if (seq < this.nextSeq) return; // duplicate: already written in order
      if (this.pending.has(seq)) return; // duplicate: already held back

      this.pending.set(seq, chunk);

      while (this.pending.has(this.nextSeq)) {
        const next = this.pending.get(this.nextSeq);
        this.pending.delete(this.nextSeq);
        await this.inner.write(this.nextSeq, next);
        this.nextSeq++;
      }
    }

    async finalize() {
      const result = await this.inner.finalize();
      if (!this.readBack) return result;
      // Streamed content lives on disk, so verification needs it read back.
      return await this.readBack();
    }

    async abandon() {
      this.abandoned = true;
      this.pending.clear();
      await this.inner.abandon();
    }
  }

  // ── engine ────────────────────────────────────────────────────────────────

  class TransferEngine {
    /**
     * @param {object} peerManager needs dataChannels (Map), sendJsonToPeer,
     *   sendToPeer, recordLatency, getLatency.
     * @param {object} [options]
     * @param {number}  [options.chunkSize]            default window.CHUNK_SIZE
     * @param {number}  [options.maxInMemoryBytes]     default 512MB ceiling
     * @param {number}  [options.maxResendAttempts]    default 5
     * @param {number[]} [options.resendBackoffMs]
     * @param {number}  [options.transferTimeoutMs]    default 5 minutes
     * @param {number}  [options.helloWaitMs]          default 3000
     * @param {boolean} [options.requireVerification]  default true
     * @param {function} [options.streamProvider]      async ({transferId, fileName,
     *   fileSize, fileType, peerId}) => { stream, handle?, readBack? } | WritableStream | null
     * @param {object}  [options.clock] { now(), setTimeout(), clearTimeout() }
     */
    constructor(peerManager, options = {}) {
      const win = (typeof window !== 'undefined' && window) || root || {};
      const clock = options.clock || {};

      this.pm = peerManager;
      this.chunkSize = options.chunkSize || win.CHUNK_SIZE || DEFAULT_CHUNK_SIZE;
      this.maxInMemoryBytes = options.maxInMemoryBytes || Core.DEFAULT_MAX_IN_MEMORY_BYTES;
      this.maxResendAttempts = options.maxResendAttempts || MAX_RESEND_ATTEMPTS;
      this.resendBackoffMs = options.resendBackoffMs || RESEND_BACKOFF_MS;
      this.transferTimeoutMs = options.transferTimeoutMs || TRANSFER_TIMEOUT_MS;
      this.helloWaitMs = options.helloWaitMs || HELLO_WAIT_MS;
      this.requireVerification = options.requireVerification !== false;
      this.streamProvider = options.streamProvider || null;
      this.protocolVersion = Framing.PROTOCOL_VERSION;

      // Injectable clock, so tests can drive the wall-clock timeout
      // deterministically instead of sleeping.
      this._now = clock.now || (() => Date.now());
      this._setTimeout = clock.setTimeout || ((fn, ms) => setTimeout(fn, ms));
      this._clearTimeout = clock.clearTimeout || ((t) => clearTimeout(t));

      // transferId -> outgoing transfer
      this.outgoing = new Map();
      // transferId -> incoming entry (see _initIncoming)
      this.incoming = new Map();
      // transferId -> settled outgoing promise, so waitForTransfer still works
      // for a transfer that has already been removed from `outgoing`.
      this._outgoingPromises = new Map();
      // Routing table keyed by the transfer id carried in each frame.
      this.receivers = new Core.ReceiverRegistry();

      // peerId -> handshake state
      this.peers = new Map();

      this._idSeq = 0;
      this.speedTestActive = false;

      // ── callback surface ──────────────────────────────────────────────────
      // Preserved names (see client/app.js): onProgress, onComplete,
      // onIncoming, onCancelled, onLatency, onControl.
      this.onProgress = null;
      this.onComplete = null;
      this.onIncoming = null;
      this.onCancelled = null;
      this.onLatency = null;
      this.onControl = null;

      // Added for verification and retry states the old surface could not express.
      this.onIncomplete = null;              // (info) chunks missing, requesting them
      this.onFailure = null;                // (info) transfer failed, see info.code
      this.onProtocolMismatch = null;       // (info) peer speaks another protocol
      this.onVerificationUnavailable = null; // (info) cannot verify what arrived
    }

    // ── protocol handshake ──────────────────────────────────────────────────

    /** Call when a data channel opens so the fresh channel re-handshakes. */
    handleChannelOpen(peerId) {
      this.peers.delete(peerId);
      this._sendHello(peerId);
      return true;
    }

    notifyChannelOpen(peerId) {
      return this.handleChannelOpen(peerId);
    }

    getPeerProtocol(peerId) {
      const st = this.peers.get(peerId);
      if (!st || !st.helloSeen) return null;
      return { version: st.version, capabilities: st.capabilities };
    }

    _capabilities() {
      const win = (typeof window !== 'undefined' && window) || root || {};
      return {
        streamingSupported: typeof win.showSaveFilePicker === 'function',
        verificationAvailable: Core.isVerificationAvailable(),
        maxInMemoryBytes: this.maxInMemoryBytes,
        maxResendAttempts: this.maxResendAttempts,
      };
    }

    _peerState(peerId) {
      let st = this.peers.get(peerId);
      if (!st) {
        st = {
          version: null,
          capabilities: {},
          helloSeen: false,
          helloSent: false,
          ackSent: false,
          pending: null,
          resolve: null,
        };
        this.peers.set(peerId, st);
      }
      return st;
    }

    _sendHello(peerId) {
      const st = this._peerState(peerId);
      if (st.helloSent) return false;
      st.helloSent = true;
      const sent = this.pm.sendJsonToPeer(peerId, {
        type: CONTROL.HELLO,
        protocolVersion: Framing.PROTOCOL_VERSION,
        capabilities: this._capabilities(),
      });
      return sent !== false;
    }

    /** Resolve once the peer has handshaked, or null after helloWaitMs. */
    _waitForHandshake(peerId) {
      this._sendHello(peerId);
      const st = this._peerState(peerId);
      if (st.helloSeen) return Promise.resolve(st.version);
      if (st.pending) return st.pending;

      st.pending = new Promise((resolve) => {
        const timer = this._setTimeout(() => {
          st.pending = null;
          st.resolve = null;
          resolve(null);
        }, this.helloWaitMs);

        st.resolve = (version) => {
          this._clearTimeout(timer);
          st.pending = null;
          st.resolve = null;
          resolve(version);
        };
      });
      return st.pending;
    }

    _resolveHandshake(peerId) {
      const st = this.peers.get(peerId);
      if (st && st.resolve) st.resolve(st.version);
    }

    _onHello(peerId, msg) {
      const st = this._peerState(peerId);
      st.version = Number.isInteger(msg.protocolVersion) ? msg.protocolVersion : null;
      st.capabilities = msg.capabilities || {};
      st.helloSeen = true;

      // The channel's first JSON message must be `hello` in both directions.
      // If we have not spoken yet, our `hello` doubles as the reply; otherwise
      // acknowledge so the other side's handshake resolves too.
      if (!st.helloSent) {
        this._sendHello(peerId);
      } else if (!st.ackSent) {
        st.ackSent = true;
        this.pm.sendJsonToPeer(peerId, {
          type: CONTROL.HELLO_ACK,
          protocolVersion: Framing.PROTOCOL_VERSION,
          capabilities: this._capabilities(),
        });
      }

      this._resolveHandshake(peerId);
    }

    _onHelloAck(peerId, msg) {
      const st = this._peerState(peerId);
      if (!st.helloSeen) {
        st.version = Number.isInteger(msg.protocolVersion) ? msg.protocolVersion : null;
        st.capabilities = msg.capabilities || {};
        st.helloSeen = true;
      }
      this._resolveHandshake(peerId);
    }

    _rejectProtocol(peerId, peerVersion) {
      const mine = Framing.PROTOCOL_VERSION;
      const theirs = peerVersion === null || peerVersion === undefined
        ? 'unknown (no hello received)'
        : String(peerVersion);

      const message =
        `Cannot transfer to ${peerId}: this device speaks LanShare transfer ` +
        `protocol v${mine}, but that device speaks v${theirs}. Update LanShare ` +
        `on the other device to a matching build.`;

      const info = {
        peerId,
        localVersion: mine,
        peerVersion: peerVersion === undefined ? null : peerVersion,
        code: 'PROTOCOL_MISMATCH',
        message,
      };

      if (this.onProtocolMismatch) this.onProtocolMismatch(info);
      if (this.onFailure) {
        this.onFailure({
          transferId: null,
          direction: 'out',
          code: 'PROTOCOL_MISMATCH',
          message,
          peerId,
          retryable: false,
          localVersion: mine,
          peerVersion: info.peerVersion,
        });
      }
      return message;
    }

    // ── sending ─────────────────────────────────────────────────────────────

    /**
     * Send a file to a peer.
     *
     * @param {File|Blob} file
     * @param {string} peerId
     * @param {function} [onProgress] per-transfer progress, in addition to the
     *   engine-level `onProgress`.
     * @returns {Promise<string|null>} transferId, or null when the peer is
     *   incompatible and nothing was started.
     */
    async sendFile(file, peerId, onProgress) {
      // An incompatible peer must be refused before any hashing or streaming,
      // so that a mismatched pair cannot produce a partial file on either side.
      const peerVersion = await this._waitForHandshake(peerId);
      if (peerVersion !== Framing.PROTOCOL_VERSION) {
        this._rejectProtocol(peerId, peerVersion);
        return null;
      }

      const chunkSize = this.chunkSize;
      const totalChunks = Math.ceil(file.size / chunkSize);

      // Digest the whole file before streaming. On an insecure origin
      // `sha256Hex` returns null; the transfer is then explicitly unverifiable
      // rather than quietly unverified.
      let digest = null;
      try {
        digest = await Core.sha256Hex(await readAll(file));
      } catch (err) {
        digest = null;
      }
      const verifiable = !!digest;

      const transferId = this._nextTransferId();
      const transfer = {
        id: transferId,
        transferId,
        file,
        peerId,
        chunkSize,
        totalChunks,
        digest,
        verifiable,
        sentChunks: 0,
        nextSeq: 0,
        bytesSent: 0,
        speed: 0,
        lastSampleAt: this._now(),
        lastSampleBytes: 0,
        startTime: this._now(),
        paused: false,
        cancelled: false,
        settled: false,
        onProgress: typeof onProgress === 'function' ? onProgress : null,
        timeoutTimer: null,
        finished: null,
      };

      transfer.sender = new Core.TransferSender({
        transferId,
        totalChunks,
        fileSize: file.size,
        chunkSize,
        digest,
        readChunk: (seq) => readSlice(file, seq, chunkSize),
      });

      this.outgoing.set(transferId, transfer);

      transfer.timeoutTimer = this._setTimeout(() => {
        if (transfer.completed) {
          // Finished streaming and the peer never came back with a problem.
          // Stop holding the source for retransmission.
          this._cleanupOutgoing(transfer);
          return;
        }
        if (transfer.settled) return;
        this._failOutgoing(
          transfer,
          'TIMEOUT',
          `Sending ${file.name} timed out after ${this.transferTimeoutMs} ms ` +
          `(${transfer.sentChunks} of ${transfer.totalChunks} chunks sent).`
        );
      }, this.transferTimeoutMs);

      this._sendHello(peerId);
      this.pm.sendJsonToPeer(peerId, {
        type: CONTROL.TRANSFER_START,
        transferId,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || '',
        totalChunks,
        chunkSize,
        digest,
        verifiable,
        protocolVersion: Framing.PROTOCOL_VERSION,
        capabilities: this._capabilities(),
      });

      if (!verifiable && this.onVerificationUnavailable) {
        this.onVerificationUnavailable({
          transferId,
          peerId,
          fileName: file.name,
          direction: 'out',
          reason: 'digest-unavailable',
          message:
            `Sending ${file.name} without a digest: this is not a secure ` +
            `origin, so the receiving device cannot verify it.`,
        });
      }

      transfer.finished = this._streamChunks(transfer).finally(() => {
        this._outgoingPromises.delete(transferId);
      });
      this._outgoingPromises.set(transferId, transfer.finished);
      return transferId;
    }

    async _streamChunks(transfer) {
      const { peerId, transferId } = transfer;
      const dc = this.pm.dataChannels.get(peerId);

      if (!dc) {
        this._failOutgoing(transfer, 'NO_CHANNEL',
          `No data channel is open to ${peerId}.`);
        return;
      }

      for (let seq = transfer.nextSeq; seq < transfer.totalChunks; seq++) {
        if (transfer.settled || transfer.cancelled) {
          this._cancelOutgoing(transfer);
          return;
        }

        while (transfer.paused && !transfer.settled && !transfer.cancelled) {
          await sleep(PAUSE_POLL_MS);
        }
        if (transfer.settled || transfer.cancelled) {
          this._cancelOutgoing(transfer);
          return;
        }

        // Backpressure: the channel buffer is high, so wait for it to drain
        // rather than growing an unbounded queue in memory.
        while (dc && dc.readyState !== 'closed' && dc.bufferedAmount > HIGH_WATER_MARK) {
          await sleep(BACKPRESSURE_POLL_MS);
          if (transfer.settled || transfer.cancelled) {
            this._cancelOutgoing(transfer);
            return;
          }
        }

        let payload;
        try {
          payload = await transfer.sender.sendChunk(seq);
        } catch (err) {
          if (transfer.settled || transfer.cancelled) {
            this._cancelOutgoing(transfer);
            return;
          }
          this._failOutgoing(transfer, err.code || 'READ_FAILED',
            `Could not read ${transfer.file.name}: ${err.message || err}`);
          return;
        }

        if (transfer.settled || transfer.cancelled) {
          this._cancelOutgoing(transfer);
          return;
        }

        try {
          this.pm.sendToPeer(peerId, Framing.encodeChunk(transferId, seq, payload));
        } catch (err) {
          this._failOutgoing(transfer, 'SEND_FAILED',
            `Could not write to the data channel for ${transfer.file.name}: ${err.message || err}`);
          return;
        }

        transfer.sentChunks = seq + 1;
        transfer.nextSeq = seq + 1;
        transfer.bytesSent += payload.byteLength;
        this._emitOutgoingProgress(transfer);
      }

      if (transfer.settled || transfer.cancelled) {
        this._cancelOutgoing(transfer);
        return;
      }

      this.pm.sendJsonToPeer(peerId, {
        type: CONTROL.TRANSFER_COMPLETE,
        transferId,
        totalChunks: transfer.totalChunks,
        totalBytes: transfer.file.size,
        digest: transfer.digest,
      });

      this._finishOutgoing(transfer);
    }

    _emitOutgoingProgress(transfer) {
      const now = this._now();
      const dt = now - transfer.lastSampleAt;
      // Sample per interval rather than averaging from zero, so the readout is
      // current throughput. The final chunk always produces a sample, so a
      // transfer shorter than the interval still reports a rate.
      const last = transfer.sentChunks >= transfer.totalChunks;
      if (dt >= PROGRESS_INTERVAL_MS || last) {
        transfer.speed = dt > 0 ? (transfer.bytesSent - transfer.lastSampleBytes) / (dt / 1000) : 0;
        transfer.lastSampleAt = now;
        transfer.lastSampleBytes = transfer.bytesSent;
      }

      const size = transfer.file.size;
      const progress = size > 0 ? Math.min(1, transfer.bytesSent / size) : 1;
      const eta = transfer.speed > 0 ? (size - transfer.bytesSent) / transfer.speed : null;

      if (transfer.onProgress) {
        transfer.onProgress({
          transferId: transfer.transferId,
          direction: 'out',
          progress,
          bytesSent: transfer.bytesSent,
          total: size,
          speed: transfer.speed,
          eta,
          chunks: transfer.sentChunks,
          totalChunks: transfer.totalChunks,
          peerId: transfer.peerId,
          fileName: transfer.file.name,
        });
      }

      if (this.onProgress) {
        this.onProgress({
          transferId: transfer.transferId,
          direction: 'out',
          progress,
          speed: transfer.speed,
          eta,
          peerId: transfer.peerId,
          bytesSent: transfer.bytesSent,
          total: size,
          chunks: transfer.sentChunks,
          totalChunks: transfer.totalChunks,
          fileName: transfer.file.name,
        });
      }
    }

    _nextTransferId() {
      this._idSeq = (this._idSeq + 1) >>> 0;
      if (this._idSeq === 0) this._idSeq = 1;
      return this._idSeq;
    }

    _cleanupOutgoing(transfer) {
      if (transfer.timeoutTimer) {
        this._clearTimeout(transfer.timeoutTimer);
        transfer.timeoutTimer = null;
      }
      this._outgoingPromises.delete(transfer.transferId);
      this.outgoing.delete(transfer.transferId);
    }

    /**
     * All chunks are on the wire and `transfer_complete` has been sent.
     *
     * The transfer is NOT dropped from `outgoing` yet: the receiver may still
     * find a gap and ask for exactly those chunks, and answering requires the
     * source. It is released when the peer reports the transfer failed or
     * cancelled, or when the wall-clock ceiling expires.
     */
    _finishOutgoing(transfer) {
      if (transfer.settled) return;
      transfer.settled = true;
      transfer.completed = true;

      const duration = (this._now() - transfer.startTime) / 1000;

      if (this.onComplete) {
        this.onComplete({
          transferId: transfer.transferId,
          direction: 'out',
          fileName: transfer.file.name,
          fileSize: transfer.file.size,
          fileType: transfer.file.type || '',
          peerId: transfer.peerId,
          targetPeerId: transfer.peerId,
          totalChunks: transfer.totalChunks,
          chunksSent: transfer.sentChunks,
          bytesSent: transfer.bytesSent,
          resendCount: transfer.sender.resendCount,
          verified: transfer.verifiable,
          digest: transfer.digest,
          duration,
          avgSpeed: duration > 0 ? transfer.file.size / duration : 0,
        });
      }
    }

    _failOutgoing(transfer, code, message, extra) {
      if (transfer.settled) return;
      transfer.settled = true;
      transfer.sender.cancelled = true;
      this._cleanupOutgoing(transfer);

      const notify = !extra || extra.notify !== false;
      if (notify) {
        this.pm.sendJsonToPeer(transfer.peerId, {
          type: CONTROL.TRANSFER_FAILED,
          transferId: transfer.transferId,
          code,
          message,
        });
      }

      if (this.onFailure) {
        this.onFailure({
          transferId: transfer.transferId,
          direction: 'out',
          code,
          message,
          peerId: transfer.peerId,
          fileName: transfer.file.name,
          fileSize: transfer.file.size,
          chunksSent: transfer.sentChunks,
          totalChunks: transfer.totalChunks,
          retryable: false,
        });
      }
    }

    _cancelOutgoing(transfer) {
      if (transfer.settled) return;
      // Settle before notifying: the streaming loop also notices the
      // cancellation and calls back in here, and the user must hear about it
      // exactly once.
      transfer.settled = true;
      transfer.cancelled = true;
      transfer.sender.cancelled = true;
      this._cleanupOutgoing(transfer);

      this.pm.sendJsonToPeer(transfer.peerId, {
        type: CONTROL.TRANSFER_CANCEL,
        transferId: transfer.transferId,
        reason: 'cancelled',
      });

      if (this.onCancelled) {
        this.onCancelled(transfer.transferId, {
          direction: 'out',
          peerId: transfer.peerId,
          fileName: transfer.file.name,
        });
      }
    }

    pauseTransfer(transferId) {
      const t = this.outgoing.get(transferId);
      if (t) t.paused = true;
      return !!t;
    }

    resumeTransfer(transferId) {
      const t = this.outgoing.get(transferId);
      if (t) t.paused = false;
      return !!t;
    }

    /** Resolve when an outgoing transfer has settled. Never rejects. */
    waitForTransfer(transferId) {
      const t = this.outgoing.get(transferId);
      if (t && t.finished) return t.finished;
      return this._outgoingPromises.get(transferId) || Promise.resolve();
    }

    /** Cancel an outgoing or incoming transfer. */
    cancelTransfer(transferId) {
      const out = this.outgoing.get(transferId);
      // A transfer that already finished streaming cannot be cancelled; it is
      // only retained so a retransmission request can be answered.
      if (out && !out.completed) {
        out.cancelled = true;
        out.sender.cancelled = true;
        this._cancelOutgoing(out);
        return true;
      }

      const inc = this.incoming.get(transferId);
      if (inc) {
        this._abandonIncoming(inc, 'cancelled', { notifyPeer: true });
        if (this.onCancelled) {
          this.onCancelled(transferId, {
            direction: 'in',
            peerId: inc.peerId,
            fileName: inc.fileName,
            reason: 'cancelled',
          });
        }
        return true;
      }
      return false;
    }

    // ── receiving ───────────────────────────────────────────────────────────

    /** Entry point for every message arriving on a peer's data channel. */
    handleData(peerId, data) {
      if (typeof data === 'string') {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
        this._handleJson(peerId, msg);
        return;
      }

      if (data === null || data === undefined) return;

      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        // binaryType left as 'blob'. Never let a decode failure escape.
        data.arrayBuffer()
          .then((buf) => this._handleFrame(peerId, buf))
          .catch(() => {});
        return;
      }

      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        this._handleFrame(peerId, data);
      }
    }

    _handleJson(peerId, msg) {
      switch (msg.type) {
        case CONTROL.HELLO:
          this._onHello(peerId, msg);
          return;

        case CONTROL.HELLO_ACK:
          this._onHelloAck(peerId, msg);
          return;

        case CONTROL.TRANSFER_START:
          this._initIncoming(peerId, msg);
          return;

        case CONTROL.TRANSFER_COMPLETE:
          this._finalizeIncoming(peerId, msg.transferId);
          return;

        case CONTROL.TRANSFER_CANCEL:
          this._cancelIncoming(peerId, msg);
          return;

        case CONTROL.TRANSFER_FAILED:
          this._remoteFailed(peerId, msg);
          return;

        case CONTROL.PING:
          this.pm.sendJsonToPeer(peerId, { type: CONTROL.PONG, t: msg.t });
          return;

        case CONTROL.PONG: {
          const rtt = Number.isFinite(msg.rtt)
            ? msg.rtt
            : (Number.isFinite(msg.t) ? this._now() - msg.t : 0);
          this.pm.recordLatency(peerId, rtt);
          if (this.onLatency) this.onLatency(peerId, rtt);
          return;
        }

        case CONTROL.SPEED_TEST_START:
          return;

        case CONTROL.SPEED_TEST_PACKET:
          this.pm.sendJsonToPeer(peerId, {
            type: CONTROL.SPEED_TEST_ACK,
            seq: msg.seq,
            bytes: msg.bytes,
          });
          return;

        case CONTROL.SPEED_TEST_ACK:
          return;

        default:
          if (NACK_ALIASES.includes(msg.type)) {
            this._handleNack(peerId, msg);
            return;
          }
          // Everything else is application traffic.
          if (this.onControl) this.onControl(peerId, msg);
      }
    }

    /**
     * Binary frame. Routing uses the transfer id inside the envelope and
     * nothing else — no shared slot, no arrival-order assumption.
     */
    _handleFrame(peerId, buffer) {
      if (!Framing.isFramedChunk(buffer)) return; // not ours; ignore safely

      let frame;
      try {
        frame = Framing.decodeChunk(buffer);
      } catch {
        // A malformed or foreign-version envelope must not throw out of the
        // channel handler.
        return;
      }

      const entry = this.incoming.get(frame.transferId);
      if (!entry || entry.settled) return;               // unknown transferId
      if (entry.peerId !== peerId) return;                // never cross peers

      // Serialise per transfer so concurrent async sinks cannot interleave
      // writes for the same receiver, and so that a control message arriving in
      // the same burst as the frames cannot finalise before they are applied.
      entry.queue = entry.queue.then(
        () => this._applyChunk(entry, frame),
        () => this._applyChunk(entry, frame)
      );
    }

    async _applyChunk(entry, frame) {
      if (entry.settled) return;

      // Storage may still be being chosen (a file picker is a user gesture).
      // The per-transfer queue serialises these waits, so nothing is lost.
      try { if (entry.ready) await entry.ready; } catch { return; }
      if (entry.settled || !entry.receiver) return;

      let result;
      try {
        result = await entry.receiver.acceptChunk(frame);
      } catch (err) {
        this._onChunkError(entry, err);
        return;
      }

      if (!result.accepted) {
        if (result.reason === 'duplicate') entry.duplicates++;
        return;
      }

      entry.lastActivity = this._now();

      if (!entry.streaming && entry.receiver.bytesReceived > this.maxInMemoryBytes) {
        await this._failIncoming(entry, 'MEMORY_CEILING_EXCEEDED',
          `Cannot receive ${entry.fileName}: content exceeded the in-memory ` +
          `limit of ${this.maxInMemoryBytes} bytes. Re-run LanShare from a ` +
          `secure origin to stream this file to disk instead.`,
          { notify: false });
        return;
      }

      this._emitIncomingProgress(entry);

      // The sender said "complete" earlier and we found a gap. Once the gap is
      // filled, finalise immediately rather than waiting for the retry tick.
      if (entry.completionRequested && entry.receiver.isComplete) {
        this._clearRetry(entry);
        this._finalizeIncoming(entry.peerId, entry.transferId);
      }
    }

    _onChunkError(entry, err) {
      if (entry.settled) return;
      this._failIncoming(entry, err && err.code ? err.code : 'CHUNK_FAILED',
        `Could not store a chunk of ${entry.fileName}: ${(err && err.message) || err}`,
        { notify: false });
    }

    _emitIncomingProgress(entry) {
      const r = entry.receiver;
      const now = this._now();
      const dt = now - entry.lastSampleAt;
      const last = r.chunks.size >= r.totalChunks;
      if (dt >= PROGRESS_INTERVAL_MS || last) {
        entry.speed = dt > 0 ? (r.bytesReceived - entry.lastSampleBytes) / (dt / 1000) : 0;
        entry.lastSampleAt = now;
        entry.lastSampleBytes = r.bytesReceived;
      }

      const progress = r.totalChunks > 0 ? r.chunks.size / r.totalChunks : 1;
      const remainingBytes = Math.max(0, entry.fileSize - r.bytesReceived);
      const eta = entry.speed > 0 ? remainingBytes / entry.speed : null;

      if (this.onProgress) {
        this.onProgress({
          transferId: entry.transferId,
          direction: 'in',
          progress,
          speed: entry.speed,
          eta,
          peerId: entry.peerId,
          fromPeerId: entry.peerId,
          fileName: entry.fileName,
          bytesReceived: r.bytesReceived,
          total: entry.fileSize,
          chunks: r.chunks.size,
          totalChunks: r.totalChunks,
          streaming: entry.streaming,
        });
      }
    }

    /**
     * Resolve the storage target for an incoming transfer.
     * Returns null when direct-to-disk writing is unavailable or the user
     * dismissed the picker, which falls back to in-memory assembly.
     */
    async _resolveStreamTarget(info) {
      if (typeof this.streamProvider !== 'function') return null;

      let provided;
      try {
        provided = await this.streamProvider(info);
      } catch {
        return null; // picker dismissed or denied — fall back, never fail
      }
      if (!provided) return null;

      if (typeof provided.getWriter === 'function') return { stream: provided };

      const stream = provided.stream || provided.writable || null;
      if (!stream || typeof stream.getWriter !== 'function') return null;

      let readBack = typeof provided.readBack === 'function' ? provided.readBack : null;
      const handle = provided.handle || null;
      if (!readBack && handle && typeof handle.getFile === 'function') {
        readBack = async () => (await handle.getFile()).arrayBuffer();
      }

      return { stream, handle, readBack };
    }

    /**
     * Announce a transfer.
     *
     * The entry is registered synchronously and the storage decision (which may
     * await a file picker) is exposed as `entry.ready`. Frames arriving in the
     * same task queue behind it instead of being discarded. This is keyed by
     * transfer id, so it does not reintroduce a shared per-peer slot.
     */
    _initIncoming(peerId, msg) {
      const transferId = msg.transferId;
      if (!Number.isInteger(transferId) || transferId < 0) return;
      if (this.incoming.has(transferId)) return; // already known
      if (!Number.isInteger(msg.totalChunks) || msg.totalChunks < 0) return;

      const fileSize = Number(msg.fileSize) || 0;

      const entry = {
        transferId,
        peerId,
        fileName: msg.fileName || 'download',
        fileType: msg.fileType || '',
        fileSize,
        totalChunks: msg.totalChunks,
        receiver: null,
        adapter: null,
        streaming: false,
        readBack: false,
        digest: msg.digest || null,
        verifiable: false,
        attempts: 0,
        duplicates: 0,
        speed: 0,
        lastSampleAt: this._now(),
        lastSampleBytes: 0,
        lastActivity: this._now(),
        startTime: this._now(),
        queue: Promise.resolve(),
        ready: null,
        finalizing: false,
        settled: false,
        completionRequested: false,
        retryTimer: null,
        timeoutTimer: null,
      };

      this.incoming.set(transferId, entry);
      entry.ready = this._prepareIncoming(entry, msg);

      entry.timeoutTimer = this._setTimeout(() => {
        this._timeoutIncoming(entry);
      }, this.transferTimeoutMs);
    }

    async _prepareIncoming(entry, msg) {
      let target = null;
      try {
        target = await this._resolveStreamTarget({
          transferId: entry.transferId,
          fileName: entry.fileName,
          fileSize: entry.fileSize,
          fileType: entry.fileType,
          totalChunks: entry.totalChunks,
          peerId: entry.peerId,
        });
      } catch {
        target = null;
      }

      if (entry.settled) return;

      const streaming = !!(target && target.stream);

      // Without a way to read streamed bytes back, transfer-core cannot hash
      // them (a stream yields no bytes on finalize). Rather than let it compare
      // a digest against empty content, verification is reported unavailable
      // and the file is delivered unverified rather than falsely verified.
      const canDigestCheck = !streaming || !!target.readBack;

      if (!streaming && entry.fileSize > this.maxInMemoryBytes) {
        entry.settled = true;
        this._cleanupIncoming(entry);
        this._refuseIncoming(entry, 'MEMORY_CEILING_EXCEEDED',
          `Cannot receive ${entry.fileName}: ${entry.fileSize} bytes exceeds ` +
          `the in-memory limit of ${this.maxInMemoryBytes} bytes. Open LanShare ` +
          `from a secure origin on https:// or http://localhost to stream ` +
          `large files straight to disk.`);
        return;
      }

      const sink = streaming
        ? new Core.StreamSink(target.stream)
        : new Core.MemorySink();

      entry.adapter = new SequencedSink(sink, streaming ? target.readBack : null);
      entry.streaming = streaming;
      entry.readBack = !!(streaming && target.readBack);
      entry.verifiable = canDigestCheck && !!entry.digest;
      entry.receiver = this.receivers.create({
        transferId: entry.transferId,
        peerId: entry.peerId,
        fileName: entry.fileName,
        fileSize: entry.fileSize,
        fileType: entry.fileType,
        totalChunks: entry.totalChunks,
        digest: canDigestCheck ? entry.digest : null,
        requiresVerification: this.requireVerification && canDigestCheck,
        startTime: entry.startTime,
        sink: entry.adapter,
      });

      if (this.onIncoming) {
        this.onIncoming({
          transferId: entry.transferId,
          fileName: entry.fileName,
          fileSize: entry.fileSize,
          fileType: entry.fileType,
          fromPeerId: entry.peerId,
          peerId: entry.peerId,
          totalChunks: entry.totalChunks,
          digest: entry.digest,
          verifiable: entry.verifiable,
          streaming,
          storage: streaming ? 'stream' : 'memory',
          maxInMemoryBytes: this.maxInMemoryBytes,
        });
      }

      if (!entry.verifiable && this.onVerificationUnavailable) {
        this.onVerificationUnavailable({
          transferId: entry.transferId,
          peerId: entry.peerId,
          fileName: entry.fileName,
          direction: 'in',
          reason: streaming && !entry.readBack ? 'no-read-back' : 'digest-unavailable',
          message: streaming && !entry.readBack
            ? `${entry.fileName} is being written straight to disk, so it cannot ` +
              `be hashed back before delivery. Pass a readBack function from the ` +
              `streamProvider to keep verification enabled.`
            : `${entry.fileName} arrived without a digest, so it cannot be verified.`,
        });
      }
    }

    _refuseIncoming(entry, code, message) {
      this.pm.sendJsonToPeer(entry.peerId, {
        type: CONTROL.TRANSFER_FAILED,
        transferId: entry.transferId,
        code,
        message,
      });

      if (this.onFailure) {
        this.onFailure({
          transferId: entry.transferId,
          direction: 'in',
          code,
          message,
          peerId: entry.peerId,
          fileName: entry.fileName,
          fileSize: entry.fileSize,
          totalChunks: entry.totalChunks,
          retryable: false,
        });
      }
    }

    /**
     * Finalise an incoming transfer.
     *
     * Enqueued behind the transfer's chunk writes rather than run inline: a
     * `transfer_complete` routinely arrives in the same burst as the last
     * frames, and finalising before those writes land would report every chunk
     * as missing.
     */
    _finalizeIncoming(peerId, transferId) {
      const entry = this.incoming.get(transferId);
      if (!entry || entry.settled) return;
      if (entry.peerId !== peerId) return;

      entry.queue = entry.queue.then(
        () => this._doFinalize(entry),
        () => this._doFinalize(entry)
      );
    }

    async _doFinalize(entry) {
      if (entry.settled || entry.finalizing) return;
      entry.finalizing = true;

      try {
        try { if (entry.ready) await entry.ready; } catch { return; }
        if (entry.settled || !entry.receiver) return;

        entry.lastActivity = this._now();
        this._clearRetry(entry);

        // Completeness before digest: a short file is incomplete whatever its
        // bytes hash to.
        const missing = entry.receiver.missingChunks();
        if (missing.length > 0) {
          this._requestResend(entry, missing);
          return;
        }

        let result;
        try {
          result = await entry.receiver.finalize();
        } catch (err) {
          await this._failIncoming(entry,
            (err && err.code) || 'FINALISE_FAILED',
            `Could not finalise ${entry.fileName}: ${(err && err.message) || err}`,
            { notify: false });
          return;
        }

        if (result.ok) {
          this._completeIncoming(entry, result);
          return;
        }

        if (result.code === 'INCOMPLETE') {
          this._requestResend(entry, result.missingChunks || []);
          return;
        }

        // DIGEST_MISMATCH / UNVERIFIABLE: transfer-core has already abandoned
        // the sink, so no complete-looking artifact survives.
        await this._failIncoming(entry, result.code, result.message, {
          expected: result.expected,
          actual: result.actual,
        });
      } finally {
        entry.finalizing = false;
      }
    }

    _requestResend(entry, missing) {
      const seqs = Array.isArray(missing) ? missing.slice() : [];
      const message =
        `Transfer incomplete: ${seqs.length} of ${entry.totalChunks} chunks ` +
        `missing (${describeSeqs(seqs)}).`;

      entry.completionRequested = true;

      if (this.onIncomplete) {
        this.onIncomplete({
          transferId: entry.transferId,
          peerId: entry.peerId,
          fromPeerId: entry.peerId,
          fileName: entry.fileName,
          code: 'INCOMPLETE',
          message,
          missingChunks: seqs,
          attempt: entry.attempts,
          maxAttempts: this.maxResendAttempts,
        });
      }

      if (entry.attempts >= this.maxResendAttempts) {
        this._failIncoming(entry, 'RETRY_EXHAUSTED',
          `Transfer failed: ${seqs.length} of ${entry.totalChunks} chunks ` +
          `could not be recovered after ${this.maxResendAttempts} attempts ` +
          `(missing ${describeSeqs(seqs)}). No partial file was kept.`,
          { missingChunks: seqs });
        return;
      }

      entry.attempts += 1;

      this.pm.sendJsonToPeer(entry.peerId, {
        type: CONTROL.NACK,
        transferId: entry.transferId,
        missing: seqs,
        attempt: entry.attempts,
        maxAttempts: this.maxResendAttempts,
      });

      const backoff = this.resendBackoffMs;
      const delay = backoff[Math.min(entry.attempts - 1, backoff.length - 1)];
      entry.retryTimer = this._setTimeout(() => {
        entry.retryTimer = null;
        this._finalizeIncoming(entry.peerId, entry.transferId);
      }, delay);
    }

    _clearRetry(entry) {
      if (entry.retryTimer) {
        this._clearTimeout(entry.retryTimer);
        entry.retryTimer = null;
      }
    }

    _completeIncoming(entry, result) {
      if (entry.settled) return;
      entry.settled = true;
      this._cleanupIncoming(entry);

      const bytes = result.bytes || null;
      let blob = null;
      let url = null;

      // Streamed content is already on disk, so no Blob is built for it: doing
      // so would hold the whole file in memory a second time for no benefit.
      if (bytes && !entry.streaming && typeof Blob !== 'undefined') {
        blob = new Blob([bytes], { type: entry.fileType || 'application/octet-stream' });
        if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          url = URL.createObjectURL(blob);
        }
      }

      if (this.onComplete) {
        this.onComplete({
          transferId: entry.transferId,
          direction: 'in',
          fileName: entry.fileName,
          fileSize: entry.fileSize,
          fileType: entry.fileType,
          bytes,
          blob,
          url,
          streaming: entry.streaming,
          storage: entry.streaming ? 'stream' : 'memory',
          verified: !!result.verified,
          verificationAvailable: entry.verifiable,
          digest: entry.digest || null,
          duration: result.duration,
          avgSpeed: result.avgSpeed,
          totalChunks: entry.totalChunks,
          resendCount: entry.attempts,
          fromPeerId: entry.peerId,
          peerId: entry.peerId,
        });
      }
    }

    async _failIncoming(entry, code, message, extra) {
      if (entry.settled) return;
      entry.settled = true;
      this._cleanupIncoming(entry);

      // Abandon the sink so no partial artifact survives a failed transfer.
      if (entry.receiver) {
        try { await entry.receiver.abandon(code); } catch { /* already gone */ }
      }

      const opts = extra || {};
      if (opts.notify !== false) {
        this.pm.sendJsonToPeer(entry.peerId, {
          type: CONTROL.TRANSFER_FAILED,
          transferId: entry.transferId,
          code,
          message,
        });
      }

      if (this.onFailure) {
        this.onFailure({
          transferId: entry.transferId,
          direction: 'in',
          code,
          message,
          peerId: entry.peerId,
          fromPeerId: entry.peerId,
          fileName: entry.fileName,
          fileSize: entry.fileSize,
          totalChunks: entry.totalChunks,
          missingChunks: opts.missingChunks || null,
          expectedDigest: opts.expected || null,
          actualDigest: opts.actual || null,
          retryable: false,
        });
      }
    }

    async _abandonIncoming(entry, reason, opts) {
      if (entry.settled) return;
      entry.settled = true;
      this._cleanupIncoming(entry);
      if (entry.receiver) {
        try { await entry.receiver.abandon(reason); } catch { /* already gone */ }
      }
      const notify = !opts || opts.notifyPeer !== false;
      if (notify) {
        this.pm.sendJsonToPeer(entry.peerId, {
          type: CONTROL.TRANSFER_CANCEL,
          transferId: entry.transferId,
          reason,
        });
      }
    }

    _cleanupIncoming(entry) {
      this._clearRetry(entry);
      if (entry.timeoutTimer) {
        this._clearTimeout(entry.timeoutTimer);
        entry.timeoutTimer = null;
      }
      this.incoming.delete(entry.transferId);
      this.receivers.delete(entry.transferId);
    }

    async _timeoutIncoming(entry) {
      entry.timeoutTimer = null;
      if (entry.settled) return;
      try { if (entry.ready) await entry.ready; } catch { /* nothing to report */ }
      if (entry.settled) return;
      const missing = entry.receiver ? entry.receiver.missingChunks() : [];
      await this._failIncoming(entry, 'TIMEOUT',
        `Transfer timed out after ${this.transferTimeoutMs} ms: ` +
        `${missing.length} of ${entry.totalChunks} chunks still missing` +
        (missing.length ? ` (${describeSeqs(missing)})` : '') + '.',
        { missingChunks: missing });
      this.pm.sendJsonToPeer(entry.peerId, {
        type: CONTROL.TRANSFER_CANCEL,
        transferId: entry.transferId,
        reason: 'timeout',
      });
    }

    async _cancelIncoming(peerId, msg) {
      const entry = this.incoming.get(msg.transferId);
      if (!entry || entry.settled || entry.peerId !== peerId) return;

      const reason = msg.reason || 'cancelled';
      await this._abandonIncoming(entry, reason, { notifyPeer: false });

      if (this.onCancelled) {
        this.onCancelled(entry.transferId, {
          direction: 'in',
          peerId,
          fileName: entry.fileName,
          reason,
        });
      }
    }

    async _remoteFailed(peerId, msg) {
      const code = msg.code || 'REMOTE_FAILED';
      const message = msg.message || 'The other device failed this transfer.';

      const out = this.outgoing.get(msg.transferId);
      if (out && out.peerId === peerId) {
        if (out.completed) {
          // We already reported success; the peer now says it could not use it.
          // Release the source and stay quiet — the peer's own UI reports this.
          this._cleanupOutgoing(out);
        } else {
          this._failOutgoing(out, code, message, { notify: false });
        }
      }

      const entry = this.incoming.get(msg.transferId);
      if (entry && !entry.settled && entry.peerId === peerId) {
        await this._failIncoming(entry, code, message, { notify: false });
      }
    }

    // ── retransmission (sender side) ────────────────────────────────────────

    _handleNack(peerId, msg) {
      const transfer = this.outgoing.get(msg.transferId);
      if (!transfer || transfer.cancelled) return;
      if (transfer.peerId !== peerId) return;

      const requested = Array.isArray(msg.missing) ? msg.missing : [];
      const seqs = requested.filter(
        (n) => Number.isInteger(n) && n >= 0 && n < transfer.totalChunks
      );
      if (seqs.length === 0) return;

      const run = async () => {
        if (transfer.cancelled) return;

        // Delegating to TransferSender keeps resend bookkeeping and the
        // "already recovered chunk is harmless" contract in one place.
        await transfer.sender.resend(seqs);

        for (const seq of seqs) {
          if (transfer.cancelled) return;
          const payload = await transfer.sender.sendChunk(seq);
          this.pm.sendToPeer(peerId, Framing.encodeChunk(transfer.transferId, seq, payload));
        }

        if (!transfer.cancelled) {
          this.pm.sendJsonToPeer(peerId, {
            type: CONTROL.TRANSFER_COMPLETE,
            transferId: transfer.transferId,
            totalChunks: transfer.totalChunks,
            totalBytes: transfer.file.size,
            digest: transfer.digest,
          });
        }
      };

      transfer.pendingResends = (transfer.pendingResends || Promise.resolve())
        .then(run)
        .catch((err) => {
          this._failOutgoing(transfer, (err && err.code) || 'RESEND_FAILED',
            `Could not resend chunks of ${transfer.file.name}: ` +
            `${(err && err.message) || err}`);
        });
    }

    // ── speed test ──────────────────────────────────────────────────────────

    async runSpeedTest(peerId, durationMs = 3000) {
      this._sendHello(peerId);

      const startTime = this._now();
      let bytesSent = 0;
      let seq = 0;
      const packetSize = 64 * 1024;
      const packet = new ArrayBuffer(packetSize);

      this.pm.sendJsonToPeer(peerId, {
        type: CONTROL.SPEED_TEST_START,
        duration: durationMs,
      });

      while (this._now() - startTime < durationMs) {
        this.pm.sendJsonToPeer(peerId, {
          type: CONTROL.SPEED_TEST_PACKET,
          seq,
          bytes: packetSize,
        });
        try {
          const dc = this.pm.dataChannels.get(peerId);
          if (dc && dc.readyState === 'open' && dc.bufferedAmount < 5 * 1024 * 1024) {
            dc.send(packet);
            bytesSent += packetSize;
          }
        } catch { /* channel not ready; count only what went out */ }
        seq++;
        await sleep(1);
      }

      const elapsed = (this._now() - startTime) / 1000 || 0.000001;
      return {
        bytesSent,
        duration: elapsed,
        mbps: (bytesSent * 8) / (elapsed * 1000000),
      };
    }

    /** Abandon every transfer and clear every timer. */
    async dispose() {
      this._outgoingPromises.clear();
      for (const transfer of [...this.outgoing.values()]) {
        transfer.cancelled = true;
        transfer.settled = true;
        transfer.sender.cancelled = true;
        this._cleanupOutgoing(transfer);
      }
      for (const entry of [...this.incoming.values()]) {
        entry.settled = true;
        this._cleanupIncoming(entry);
        if (entry.receiver) {
          try { await entry.receiver.abandon('disposed'); } catch { /* gone */ }
        }
      }
      for (const st of this.peers.values()) {
        if (st.resolve) st.resolve(null);
        st.pending = null;
        st.resolve = null;
      }
    }
  }

  TransferEngine.PROTOCOL_VERSION = Framing.PROTOCOL_VERSION;
  TransferEngine.CONTROL = CONTROL;
  TransferEngine.NACK_ALIASES = NACK_ALIASES;
  TransferEngine.MAX_RESEND_ATTEMPTS = MAX_RESEND_ATTEMPTS;
  TransferEngine.RESEND_BACKOFF_MS = RESEND_BACKOFF_MS;
  TransferEngine.TRANSFER_TIMEOUT_MS = TRANSFER_TIMEOUT_MS;
  TransferEngine.HELLO_WAIT_MS = HELLO_WAIT_MS;
  TransferEngine.DEFAULT_CHUNK_SIZE = DEFAULT_CHUNK_SIZE;
  TransferEngine.MAX_IN_MEMORY_BYTES = Core.DEFAULT_MAX_IN_MEMORY_BYTES;
  TransferEngine.SequencedSink = SequencedSink;

  return TransferEngine;
});
