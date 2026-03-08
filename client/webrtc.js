// client/webrtc.js
// WebRTC peer connection management and WebSocket signaling

const CHUNK_SIZE = 256 * 1024; // 256KB

class PeerManager {
  constructor(peerId, onMessage) {
    this.peerId = peerId;
    this.onMessage = onMessage;
    this.connections = new Map(); // peerId -> RTCPeerConnection
    this.dataChannels = new Map(); // peerId -> RTCDataChannel
    this.ws = null;
    this.wsReady = false;
    this.pendingSignals = new Map();
    this.reconnectAttempts = new Map();
    this.maxReconnects = 5;
    this.latencies = new Map();
    this.pingIntervals = new Map();
  }

  connect(serverUrl) {
    this.serverUrl = serverUrl;
    this._connectWS();
  }

  _connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.wsReady = true;
      this.reconnectAttempts.set('ws', 0);

      // Register with the signaling server
      this._send({
        type: 'register',
        peerId: this.peerId,
        info: this.localInfo,
      });

      // Start measuring server latency
      this._startServerPing();
    };

    this.ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._handleServerMessage(msg);
    };

    this.ws.onclose = () => {
      this.wsReady = false;
      this._scheduleWSReconnect();
    };

    this.ws.onerror = () => {
      this.wsReady = false;
    };
  }

  _scheduleWSReconnect() {
    const attempts = (this.reconnectAttempts.get('ws') || 0) + 1;
    this.reconnectAttempts.set('ws', attempts);
    if (attempts > 10) return;
    const delay = Math.min(1000 * Math.pow(1.5, attempts), 15000);
    setTimeout(() => this._connectWS(), delay);
    this.onMessage({ type: 'ws_reconnecting', attempt: attempts, delay });
  }

  _startServerPing() {
    const interval = setInterval(() => {
      if (!this.wsReady) { clearInterval(interval); return; }
      this._send({ type: 'ping', timestamp: Date.now() });
    }, 3000);
  }

  setLocalInfo(info) {
    this.localInfo = info;
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  _handleServerMessage(msg) {
    switch (msg.type) {
      case 'peer_list':
        for (const peer of msg.peers) {
          this.onMessage({ type: 'peer_joined', peerId: peer.peerId, info: peer.info });
          this._initiatePeerConnection(peer.peerId);
        }
        break;

      case 'peer_joined':
        this.onMessage(msg);
        // Wait a moment, then let the new peer initiate
        break;

      case 'peer_left':
        this._cleanupPeer(msg.peerId);
        this.onMessage(msg);
        break;

      case 'signal':
        this._handleSignal(msg.from, msg.signal);
        break;

      case 'pong':
        const rtt = Date.now() - msg.timestamp;
        this.onMessage({ type: 'server_latency', rtt });
        break;

      case 'chat':
        this.onMessage(msg);
        break;

      case 'whiteboard':
        this.onMessage(msg);
        break;

      case 'typing':
        this.onMessage(msg);
        break;

      default:
        this.onMessage(msg);
    }
  }

  _initiatePeerConnection(remotePeerId) {
    if (this.connections.has(remotePeerId)) return;

    const pc = this._createPeerConnection(remotePeerId);

    // Create data channel (initiator side)
    const dc = pc.createDataChannel('transfer', {
      ordered: true,
      maxRetransmits: 30,
    });
    this._setupDataChannel(dc, remotePeerId);

    // Create offer
    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      this._send({
        type: 'signal',
        from: this.peerId,
        target: remotePeerId,
        signal: { sdp: offer },
      });
    }).catch(console.error);
  }

  _createPeerConnection(remotePeerId) {
    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    };

    const pc = new RTCPeerConnection(config);
    this.connections.set(remotePeerId, pc);

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this._send({
          type: 'signal',
          from: this.peerId,
          target: remotePeerId,
          signal: { candidate: e.candidate },
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.onMessage({ type: 'connection_state', peerId: remotePeerId, state });

      if (state === 'connected') {
        this._startPeerPing(remotePeerId);
      } else if (state === 'failed' || state === 'disconnected') {
        this._handleConnectionFailure(remotePeerId);
      }
    };

    pc.ondatachannel = (e) => {
      this._setupDataChannel(e.channel, remotePeerId);
    };

    return pc;
  }

  async _handleSignal(remotePeerId, signal) {
    let pc = this.connections.get(remotePeerId);

    if (!pc) {
      pc = this._createPeerConnection(remotePeerId);
    }

    if (signal.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

      // Process any queued candidates
      const queued = this.pendingSignals.get(remotePeerId) || [];
      for (const c of queued) {
        await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
      }
      this.pendingSignals.delete(remotePeerId);

      if (signal.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._send({
          type: 'signal',
          from: this.peerId,
          target: remotePeerId,
          signal: { sdp: answer },
        });
      }
    } else if (signal.candidate) {
      if (pc.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {});
      } else {
        // Queue until remote description is set
        if (!this.pendingSignals.has(remotePeerId)) {
          this.pendingSignals.set(remotePeerId, []);
        }
        this.pendingSignals.get(remotePeerId).push(signal.candidate);
      }
    }
  }

  _setupDataChannel(dc, remotePeerId) {
    dc.binaryType = 'arraybuffer';
    this.dataChannels.set(remotePeerId, dc);

    dc.onopen = () => {
      this.onMessage({ type: 'channel_open', peerId: remotePeerId });
    };

    dc.onclose = () => {
      this.onMessage({ type: 'channel_closed', peerId: remotePeerId });
    };

    dc.onerror = (e) => {
      console.error(`DataChannel error with ${remotePeerId}:`, e);
    };

    dc.onmessage = (e) => {
      this.onMessage({ type: 'data', peerId: remotePeerId, data: e.data });
    };
  }

  _startPeerPing(remotePeerId) {
    // Clear any existing ping
    if (this.pingIntervals.has(remotePeerId)) {
      clearInterval(this.pingIntervals.get(remotePeerId));
    }

    const interval = setInterval(() => {
      const dc = this.dataChannels.get(remotePeerId);
      if (!dc || dc.readyState !== 'open') {
        clearInterval(interval);
        return;
      }
      const ping = { type: 'ping', t: Date.now() };
      try {
        dc.send(JSON.stringify(ping));
      } catch {}
    }, 2000);

    this.pingIntervals.set(remotePeerId, interval);
  }

  _handleConnectionFailure(remotePeerId) {
    const attempts = (this.reconnectAttempts.get(remotePeerId) || 0) + 1;
    this.reconnectAttempts.set(remotePeerId, attempts);

    if (attempts <= this.maxReconnects) {
      const delay = Math.min(1000 * attempts, 8000);
      setTimeout(() => {
        this._cleanupPeer(remotePeerId, false);
        this._initiatePeerConnection(remotePeerId);
      }, delay);
    }
  }

  _cleanupPeer(remotePeerId, notify = true) {
    const pc = this.connections.get(remotePeerId);
    if (pc) { try { pc.close(); } catch {} }
    this.connections.delete(remotePeerId);
    this.dataChannels.delete(remotePeerId);

    if (this.pingIntervals.has(remotePeerId)) {
      clearInterval(this.pingIntervals.get(remotePeerId));
      this.pingIntervals.delete(remotePeerId);
    }
  }

  sendToPeer(remotePeerId, data) {
    const dc = this.dataChannels.get(remotePeerId);
    if (dc && dc.readyState === 'open') {
      dc.send(data);
      return true;
    }
    return false;
  }

  sendJsonToPeer(remotePeerId, obj) {
    return this.sendToPeer(remotePeerId, JSON.stringify(obj));
  }

  sendChatMessage(text, targetId = null, isPrivate = false) {
    this._send({
      type: 'chat',
      from: this.peerId,
      name: this.localInfo?.name,
      text,
      private: isPrivate,
      target: targetId,
    });
  }

  sendWhiteboardEvent(event) {
    this._send({
      type: 'whiteboard',
      from: this.peerId,
      event,
    });
  }

  sendTypingIndicator(isTyping) {
    this._send({
      type: 'typing',
      from: this.peerId,
      name: this.localInfo?.name,
      isTyping,
    });
  }

  getConnectionState(peerId) {
    const pc = this.connections.get(peerId);
    return pc ? pc.connectionState : 'disconnected';
  }

  getLatency(peerId) {
    return this.latencies.get(peerId) || null;
  }

  recordLatency(peerId, rtt) {
    this.latencies.set(peerId, rtt);
  }
}

window.PeerManager = PeerManager;
window.CHUNK_SIZE = CHUNK_SIZE;
