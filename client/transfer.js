// client/transfer.js
// File transfer engine using WebRTC DataChannels with chunked streaming

class TransferEngine {
  constructor(peerManager) {
    this.pm = peerManager;
    this.outgoing = new Map(); // transferId -> OutgoingTransfer
    this.incoming = new Map(); // transferId -> IncomingTransfer
    this.onProgress = null;
    this.onComplete = null;
    this.onIncoming = null;
    this.onCancelled = null;
    this.speedTestActive = false;
  }

  // Send a file to a peer
  async sendFile(file, targetPeerId, onProgress) {
    const transferId = 'tx_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    const transfer = {
      id: transferId,
      file,
      targetPeerId,
      totalChunks,
      sentChunks: 0,
      startTime: Date.now(),
      bytesSent: 0,
      paused: false,
      cancelled: false,
      speedSamples: [],
      onProgress,
    };

    this.outgoing.set(transferId, transfer);

    // Send transfer announcement
    this.pm.sendJsonToPeer(targetPeerId, {
      type: 'transfer_start',
      transferId,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      totalChunks,
    });

    // Start sending chunks
    this._streamChunks(transfer);

    return transferId;
  }

  async _streamChunks(transfer) {
    const { file, targetPeerId, id } = transfer;
    const dc = this.pm.dataChannels.get(targetPeerId);
    if (!dc) return;

    const HIGH_WATER = 1024 * 1024 * 2; // 2MB buffer threshold

    for (let chunk = transfer.sentChunks; chunk < transfer.totalChunks; chunk++) {
      if (transfer.cancelled) {
        this.pm.sendJsonToPeer(targetPeerId, { type: 'transfer_cancel', transferId: id });
        this.outgoing.delete(id);
        if (this.onCancelled) this.onCancelled(id);
        return;
      }

      // Pause handling
      while (transfer.paused && !transfer.cancelled) {
        await sleep(100);
      }

      // Backpressure: wait if buffer is full
      while (dc.bufferedAmount > HIGH_WATER) {
        await sleep(10);
        if (transfer.cancelled) break;
      }

      const start = chunk * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const slice = file.slice(start, end);
      const buffer = await slice.arrayBuffer();

      // Send metadata header as JSON, then binary chunk
      this.pm.sendJsonToPeer(targetPeerId, {
        type: 'chunk_meta',
        transferId: id,
        chunkIndex: chunk,
        chunkSize: buffer.byteLength,
      });

      try {
        dc.send(buffer);
      } catch (e) {
        console.error('Chunk send error:', e);
        break;
      }

      transfer.sentChunks = chunk + 1;
      transfer.bytesSent += buffer.byteLength;

      // Update speed
      const elapsed = (Date.now() - transfer.startTime) / 1000;
      const speed = elapsed > 0 ? transfer.bytesSent / elapsed : 0;
      const progress = transfer.bytesSent / file.size;
      const remaining = (file.size - transfer.bytesSent) / (speed || 1);

      if (transfer.onProgress) {
        transfer.onProgress({
          transferId: id,
          progress,
          bytesSent: transfer.bytesSent,
          total: file.size,
          speed,
          eta: remaining,
          chunks: chunk + 1,
          totalChunks: transfer.totalChunks,
        });
      }

      if (this.onProgress) {
        this.onProgress({
          transferId: id,
          direction: 'out',
          progress,
          speed,
          eta: remaining,
          peerId: targetPeerId,
        });
      }
    }

    if (!transfer.cancelled) {
      this.pm.sendJsonToPeer(targetPeerId, {
        type: 'transfer_complete',
        transferId: id,
        totalBytes: file.size,
      });

      const duration = (Date.now() - transfer.startTime) / 1000;
      if (this.onComplete) {
        this.onComplete({
          transferId: id,
          direction: 'out',
          fileName: file.name,
          fileSize: file.size,
          duration,
          avgSpeed: file.size / duration,
        });
      }

      this.outgoing.delete(id);
    }
  }

  pauseTransfer(transferId) {
    const t = this.outgoing.get(transferId);
    if (t) t.paused = true;
  }

  resumeTransfer(transferId) {
    const t = this.outgoing.get(transferId);
    if (t) t.paused = false;
  }

  cancelTransfer(transferId) {
    const t = this.outgoing.get(transferId);
    if (t) t.cancelled = true;
  }

  // Handle incoming data from a peer
  handleData(peerId, data) {
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      this._handleJsonMessage(peerId, msg);
    } else if (data instanceof ArrayBuffer) {
      this._handleBinaryChunk(peerId, data);
    }
  }

  _handleJsonMessage(peerId, msg) {
    switch (msg.type) {
      case 'transfer_start':
        this._initIncoming(peerId, msg);
        break;

      case 'chunk_meta':
        // Store metadata for next binary chunk
        if (!this._pendingMeta) this._pendingMeta = new Map();
        this._pendingMeta.set(peerId, msg);
        break;

      case 'transfer_complete':
        this._finalizeIncoming(msg.transferId);
        break;

      case 'transfer_cancel':
        this._cancelIncoming(msg.transferId);
        break;

      case 'ping':
        this.pm.sendJsonToPeer(peerId, { type: 'pong', t: msg.t });
        break;

      case 'pong':
        const rtt = Date.now() - msg.t;
        this.pm.recordLatency(peerId, rtt);
        if (this.onLatency) this.onLatency(peerId, rtt);
        break;

      case 'speed_test_start':
        // Respond to speed test packets
        break;

      case 'speed_test_packet':
        this.pm.sendJsonToPeer(peerId, { type: 'speed_test_ack', seq: msg.seq, bytes: msg.bytes });
        break;

      default:
        // Pass to app layer
        if (this.onControl) this.onControl(peerId, msg);
    }
  }

  _handleBinaryChunk(peerId, buffer) {
    if (!this._pendingMeta) return;
    const meta = this._pendingMeta.get(peerId);
    if (!meta) return;
    this._pendingMeta.delete(peerId);

    const { transferId, chunkIndex } = meta;
    const transfer = this.incoming.get(transferId);
    if (!transfer) return;

    transfer.chunks[chunkIndex] = buffer;
    transfer.receivedChunks++;
    transfer.bytesReceived += buffer.byteLength;

    const elapsed = (Date.now() - transfer.startTime) / 1000;
    const speed = elapsed > 0 ? transfer.bytesReceived / elapsed : 0;
    const progress = transfer.bytesReceived / transfer.fileSize;
    const remaining = (transfer.fileSize - transfer.bytesReceived) / (speed || 1);

    if (this.onProgress) {
      this.onProgress({
        transferId,
        direction: 'in',
        progress,
        speed,
        eta: remaining,
        peerId,
        fileName: transfer.fileName,
      });
    }
  }

  _initIncoming(peerId, msg) {
    const transfer = {
      id: msg.transferId,
      peerId,
      fileName: msg.fileName,
      fileSize: msg.fileSize,
      fileType: msg.fileType,
      totalChunks: msg.totalChunks,
      chunks: new Array(msg.totalChunks),
      receivedChunks: 0,
      bytesReceived: 0,
      startTime: Date.now(),
    };

    this.incoming.set(msg.transferId, transfer);

    if (this.onIncoming) {
      this.onIncoming({
        transferId: msg.transferId,
        fileName: msg.fileName,
        fileSize: msg.fileSize,
        fileType: msg.fileType,
        fromPeerId: peerId,
      });
    }
  }

  _finalizeIncoming(transferId) {
    const transfer = this.incoming.get(transferId);
    if (!transfer) return;

    // Reassemble chunks into Blob
    const blob = new Blob(transfer.chunks, { type: transfer.fileType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);

    const duration = (Date.now() - transfer.startTime) / 1000;

    if (this.onComplete) {
      this.onComplete({
        transferId,
        direction: 'in',
        fileName: transfer.fileName,
        fileSize: transfer.fileSize,
        blob,
        url,
        duration,
        avgSpeed: transfer.fileSize / duration,
        fromPeerId: transfer.peerId,
      });
    }

    this.incoming.delete(transferId);
  }

  _cancelIncoming(transferId) {
    const t = this.incoming.get(transferId);
    if (t && this.onCancelled) this.onCancelled(transferId);
    this.incoming.delete(transferId);
  }

  // Run a speed test against a peer
  async runSpeedTest(peerId, durationMs = 3000) {
    const startTime = Date.now();
    let bytesSent = 0;
    let seq = 0;
    const packetSize = 64 * 1024; // 64KB packets
    const packet = new ArrayBuffer(packetSize);

    this.pm.sendJsonToPeer(peerId, { type: 'speed_test_start', duration: durationMs });

    while (Date.now() - startTime < durationMs) {
      const meta = { type: 'speed_test_packet', seq, bytes: packetSize };
      this.pm.sendJsonToPeer(peerId, meta);
      try {
        const dc = this.pm.dataChannels.get(peerId);
        if (dc && dc.readyState === 'open' && dc.bufferedAmount < 5 * 1024 * 1024) {
          dc.send(packet);
          bytesSent += packetSize;
        }
      } catch {}
      seq++;
      await sleep(1);
    }

    const elapsed = (Date.now() - startTime) / 1000;
    return {
      bytesSent,
      duration: elapsed,
      mbps: (bytesSent * 8) / (elapsed * 1000000),
    };
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

window.TransferEngine = TransferEngine;
