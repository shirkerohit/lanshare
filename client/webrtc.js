// client/webrtc.js
// WebRTC peer connection management and WebSocket signaling
//
// ---------------------------------------------------------------------------
// Transfer-channel protocol contract (see openspec change
// `harden-transfer-integrity`, requirements "Incompatible peers are rejected
// rather than corrupting data"). transfer.js owns the handshake messages
// themselves; this file owns the state they are recorded in and the queries
// other code makes against it. Exact names, so callers can rely on them:
//
//   localProtocolVersion()                -> number, this build's version
//   localCapabilities                     -> object, mutable; what this build
//                                           supports (transfer.js fills it in,
//                                           e.g. `.streaming = true`)
//   recordProtocol(peerId, version, caps) -> store a received handshake result
//   getProtocol(peerId)                   -> { version, capabilities, at } | null
//   getCapabilities(peerId)               -> object | null
//   clearProtocol(peerId)                 -> forget a peer's handshake
//   isProtocolCompatible(peerId)          -> { ok, local, remote, peerId, reason? }
//   assertProtocolCompatible(peerId)      -> the same result object
//
// Neither query throws. On failure `remote` is the peer's reported version
// (null when no handshake has been received) and `reason` names BOTH versions,
// so a caller can show it verbatim.
//
// A peer's record is dropped when its channel opens or closes, so a
// reconnected peer must renegotiate rather than inherit a stale version.
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 256 * 1024; // 256KB

class PeerManager {
  // Mirrors Framing.PROTOCOL_VERSION from client/framing.js. framing.js is a
  // separate <script>, so read the global when present and fall back to this
  // copy otherwise. Kept as a static rather than a module-level `const` because
  // every classic <script> shares one global lexical scope, and a duplicate
  // top-level `const` would break page load.
  static LOCAL_PROTOCOL_VERSION = 2;

  // Options for the channel that carries file bytes.
  //
  // `maxRetransmits` is deliberately absent. A cap converts recoverable loss
  // into a dead channel: after N lost messages SCTP gives up and closes, losing
  // the whole in-flight transfer rather than one chunk. With no cap the channel
  // retries for as long as the peer is reachable, and the protocol layer above
  // (framing.js sequence numbers plus the transfer gap-detection backstop) is
  // what repairs anything the channel cannot resolve. Keeping the cap would
  // make that backstop unreachable, because the channel would die before a gap
  // could ever be observed and repaired.
  static transferChannelOptions() {
    return { ordered: true };
  }

  constructor(peerId, onMessage) {
    this.peerId = peerId;
    this.onMessage = onMessage;
    this.connections = new Map(); // peerId -> RTCPeerConnection
    this.dataChannels = new Map(); // peerId -> RTCDataChannel
    this.ws = null;
    this.wsReady = false;
    this.serverPingInterval = null; // single live setInterval handle
    this.pendingSignals = new Map();
    this.reconnectAttempts = new Map();
    this.retryTimers = new Map(); // peerId -> pending retry timeout
    this.maxReconnects = 5;
    this.latencies = new Map();
    this.pingIntervals = new Map();
    this.protocols = new Map(); // peerId -> { version, capabilities, at }
    this.localCapabilities = {}; // filled in by transfer.js
    this.manualMode = false;
    this.manualPairs = new Map();
    // Pairing-consent state (signaling-rooms): explicit request/accept with a
    // single initiator. Outbound is keyed by peer (one pending request per
    // peer); inbound is keyed by request id. Each entry holds its 60s expiry
    // timer so no request persists indefinitely.
    this.outboundPairings = new Map(); // peerId -> { requestId, timer }
    this.inboundPairings = new Map(); // requestId -> { peerId, info, timer }
    this.pairingExpiryMs = 60000;
    this._requestCounter = 0;
    // Signaling endpoint resolution (signaling-rooms): explicit config, then
    // same-origin default, then none (manual). Null until connect() runs.
    this.serverUrl = null;
    this._endpoint = null;
    // True once a live socket has dropped; the next successful register
    // clears it and emits signaling_up.
    this._signalingWasDown = false;
  }

  // The resolved signaling endpoint, or null in manual mode / before connect.
  getEndpoint() {
    return this._endpoint || null;
  }

  connect(options = {}) {
    // app.js owns the static flags (LANSHARE_STATIC, ?static, file:); honour
    // them here as well so URL resolution alone forces manual pairing and
    // makes no signaling connection attempts.
    let staticForced = false;
    try {
      if (typeof window !== 'undefined' && window.LANSHARE_STATIC === true) staticForced = true;
    } catch { }
    try {
      if (typeof location !== 'undefined' && location) {
        if (location.protocol === 'file:') staticForced = true;
        else if (typeof location.search === 'string' && location.search.length > 0) {
          const params = new URLSearchParams(location.search);
          if (params.has('static')) staticForced = true;
        }
      }
    } catch { }
    this.manualMode = !!options.manual || staticForced;
    if (this.manualMode) {
      this.wsReady = false;
      this.serverUrl = null;
      this._endpoint = null;
      return;
    }
    if (options.serverUrl) {
      this._endpoint = options.serverUrl;
    } else {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      this._endpoint = `${proto}//${location.host}`;
    }
    this.serverUrl = this._endpoint;
    this._connectWS();
  }

  _connectWS() {
    const url = this._endpoint || (() => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${location.host}`;
    })();
    if (!this._endpoint) {
      this._endpoint = url;
      this.serverUrl = url;
    }

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

      // A re-register after a drop heals signaling only; data channels are
      // untouched (see onclose below).
      if (this._signalingWasDown) {
        this._signalingWasDown = false;
        this.onMessage({ type: 'signaling_up' });
      }

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
      this._stopServerPing();
      // Signaling loss never touches RTCPeerConnections: the data channel is
      // the product and signaling is only the setup channel. Only the
      // signaling socket reconnects (existing backoff below).
      this._signalingWasDown = true;
      this.onMessage({ type: 'signaling_down' });
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

  // Exactly one server ping interval may be live at a time. Reconnects call
  // this again, so the previous handle must be cleared: an orphaned interval
  // would keep firing forever, because its `wsReady` check is satisfied again
  // by the time the next reconnect brings the socket back.
  _startServerPing() {
    this._stopServerPing();

    this.serverPingInterval = setInterval(() => {
      if (!this.wsReady) return;
      this._send({ type: 'ping', timestamp: Date.now() });
    }, 3000);
  }

  _stopServerPing() {
    if (this.serverPingInterval !== null && this.serverPingInterval !== undefined) {
      clearInterval(this.serverPingInterval);
      this.serverPingInterval = null;
    }
  }

  setLocalInfo(info) {
    this.localInfo = info;
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  _encodeManualPayload(payload) {
    const json = JSON.stringify(payload);
    return btoa(unescape(encodeURIComponent(json)));
  }

  _decodeManualPayload(text) {
    const json = decodeURIComponent(escape(atob(String(text).trim())));
    return JSON.parse(json);
  }

  _waitForIceComplete(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();

    return new Promise((resolve) => {
      const done = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', done);
          resolve();
        }
      };

      pc.addEventListener('icegatheringstatechange', done);
      setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', done);
        resolve();
      }, 5000);
    });
  }

  async createManualOffer(targetPeerId = null) {
    const connectionId = 'pair_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const provisionalPeerId = `manual_${connectionId}`;
    const pc = this._createPeerConnection(provisionalPeerId, { manual: true });

    const dc = pc.createDataChannel('transfer', PeerManager.transferChannelOptions());
    this._setupDataChannel(dc, provisionalPeerId);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this._waitForIceComplete(pc);

    this.manualPairs.set(connectionId, {
      provisionalPeerId,
      targetPeerId,
      offerCode: this._encodeManualPayload({
        app: 'lanshare',
        version: 1,
        role: 'offer',
        connectionId,
        from: {
          peerId: this.peerId,
          info: this.localInfo,
        },
        signal: {
          sdp: pc.localDescription,
        },
      }),
    });

    return this.manualPairs.get(connectionId).offerCode;
  }

  async acceptManualOffer(encodedOffer) {
    const offer = this._decodeManualPayload(encodedOffer);
    if (offer.app !== 'lanshare' || offer.role !== 'offer' || !offer.from?.peerId || !offer.signal?.sdp) {
      throw new Error('This does not look like a LanShare invite.');
    }

    const remotePeerId = offer.from.peerId;
    this.onMessage({ type: 'peer_joined', peerId: remotePeerId, info: offer.from.info });

    const pc = this._createPeerConnection(remotePeerId, { manual: true });
    await pc.setRemoteDescription(new RTCSessionDescription(offer.signal.sdp));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this._waitForIceComplete(pc);

    return this._encodeManualPayload({
      app: 'lanshare',
      version: 1,
      role: 'answer',
      connectionId: offer.connectionId,
      from: {
        peerId: this.peerId,
        info: this.localInfo,
      },
      to: remotePeerId,
      signal: {
        sdp: pc.localDescription,
      },
    });
  }

  async applyManualAnswer(encodedAnswer) {
    const answer = this._decodeManualPayload(encodedAnswer);
    if (answer.app !== 'lanshare' || answer.role !== 'answer' || !answer.from?.peerId || !answer.signal?.sdp) {
      throw new Error('This does not look like a LanShare answer.');
    }

    const pair = this.manualPairs.get(answer.connectionId);
    if (!pair) {
      throw new Error('No matching local invite was found for this answer.');
    }

    await this._handleSignal(pair.provisionalPeerId, answer.signal);
    this._renamePeer(pair.provisionalPeerId, answer.from.peerId);
    this.onMessage({ type: 'peer_joined', peerId: answer.from.peerId, info: answer.from.info });
    this.manualPairs.delete(answer.connectionId);
  }

  async processManualCode(encodedCode) {
    const payload = this._decodeManualPayload(encodedCode);

    if (payload.app !== 'lanshare' || !payload.role) {
      throw new Error('This does not look like a LanShare code.');
    }

    if (payload.role === 'offer') {
      const responseCode = await this.acceptManualOffer(encodedCode);
      return { role: 'offer', responseCode };
    }

    if (payload.role === 'answer') {
      await this.applyManualAnswer(encodedCode);
      return { role: 'answer' };
    }

    throw new Error('This LanShare code is not supported.');
  }

  _handleServerMessage(msg) {
    switch (msg.type) {
      case 'peer_list':
        for (const peer of msg.peers) {
          this.onMessage({ type: 'peer_joined', peerId: peer.peerId, info: peer.info });
          // No auto-offer: a connection begins only after request + accept.
        }
        break;

      case 'peer_joined':
        this.onMessage(msg);
        // Wait a moment, then let the new peer initiate
        break;

      case 'peer_left':
        // Presence only. An established RTCPeerConnection outlives signaling
        // loss; teardown happens via explicit cleanup or connectionState
        // transitions, never here.
        this.onMessage(msg);
        break;

      case 'pairing_request':
        this._handlePairingRequest(msg);
        break;

      case 'pairing_response':
        this._handlePairingResponse(msg);
        break;

      case 'pairing_expired':
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

  // ---------------------------------------------------------------------
  // Pairing consent (signaling-rooms): explicit request/accept with a single
  // initiator. The requester initiates after acceptance; the responder waits
  // for the offer. On mutual (glare) requests the LOWER peer id initiates.
  // ---------------------------------------------------------------------

  _newRequestId() {
    try {
      if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch { }
    this._requestCounter += 1;
    return 'req_' + Date.now().toString(36) + '_' +
      Math.random().toString(36).slice(2, 10) + '_' + this._requestCounter;
  }

  /**
   * Request pairing with a peer. Sends a pairing_request over signaling and
   * starts a 60s local expiry timer. Returns the request id, or null when no
   * request is needed (already connected: reuse the existing channel).
   */
  requestPairing(peerId) {
    if (!peerId) return null;
    // Already connected: reuse the existing channel, create nothing, send nothing.
    if (this.connections.has(peerId) || this.dataChannels.has(peerId)) return null;
    // One pending outbound request per peer; reuse it rather than duplicating.
    const existing = this.outboundPairings.get(peerId);
    if (existing) return existing.requestId;

    const requestId = this._newRequestId();
    const timer = setTimeout(() => {
      this.outboundPairings.delete(peerId);
      this.onMessage({ type: 'pairing_expired', requestId, peerId });
    }, this.pairingExpiryMs);
    this.outboundPairings.set(peerId, { requestId, timer });

    this._send({
      type: 'pairing_request',
      requestId,
      from: this.peerId,
      fromName: this.localInfo?.name,
      fromType: this.localInfo?.type,
      info: this.localInfo,
      to: peerId,
      target: peerId,
    });
    return requestId;
  }

  /**
   * Respond to a pairing request. Sends pairing_response (accepted or
   * declined). On accept-as-initiator starts exactly one connection; as a
   * pure responder waits for the initiator's offer. Unknown or expired
   * request ids are ignored: nothing is sent and nothing is created.
   * Returns true when the response was handled, false when ignored.
   */
  respondPairing(requestId, accept, peerId) {
    if (!requestId) return false;

    const inbound = this.inboundPairings.get(requestId);
    const outboundById = this._outboundByRequestId(requestId);

    if (!inbound && !outboundById) return false;

    const remotePeerId = (inbound && inbound.peerId) || (outboundById && outboundById.peerId) || peerId;
    if (!remotePeerId) return false;
    if (peerId && peerId !== remotePeerId) return false;

    if (!accept) {
      this._clearInbound(requestId);
      // Declining our own outbound request just withdraws it.
      if (outboundById) this._clearOutbound(remotePeerId);
      this._send({
        type: 'pairing_response',
        requestId,
        from: this.peerId,
        to: remotePeerId,
        target: remotePeerId,
        accepted: false,
        accept: false,
      });
      return true;
    }

    // Accept path. Already connected: acknowledge but create nothing.
    if (this.connections.has(remotePeerId) || this.dataChannels.has(remotePeerId)) {
      this._clearInbound(requestId);
      this._send({
        type: 'pairing_response',
        requestId,
        from: this.peerId,
        to: remotePeerId,
        target: remotePeerId,
        accepted: true,
        accept: true,
      });
      return true;
    }

    this._send({
      type: 'pairing_response',
      requestId,
      from: this.peerId,
      to: remotePeerId,
      target: remotePeerId,
      accepted: true,
      accept: true,
    });
    // Capture glare BEFORE clearing: mutual requests mean we hold both an
    // outbound request to this peer and their inbound request to us.
    const hadOutbound = this.outboundPairings.has(remotePeerId) || !!outboundById;
    const glare = hadOutbound && !!inbound;
    this._clearInbound(requestId);

    // Initiate only when we are the initiator side: our own outbound request
    // accepted (or mutual glare won by tie-break). A pure responder waits
    // for the initiator's offer on the standard _handleSignal path.
    if (hadOutbound) {
      if (!glare || this._localInitiates(remotePeerId)) {
        this._initiatePeerConnection(remotePeerId);
      }
    }
    return true;
  }

  _outboundByRequestId(requestId) {
    for (const [peerId, record] of this.outboundPairings) {
      if (record.requestId === requestId) return { peerId, ...record };
    }
    return null;
  }

  _hasInboundFrom(peerId) {
    for (const record of this.inboundPairings.values()) {
      if (record.peerId === peerId) return true;
    }
    return false;
  }

  // Tie-break: the LOWER peer id initiates, the higher waits.
  _localInitiates(remotePeerId) {
    return String(this.peerId) < String(remotePeerId);
  }

  _clearOutbound(peerId) {
    const record = this.outboundPairings.get(peerId);
    if (record) {
      clearTimeout(record.timer);
      this.outboundPairings.delete(peerId);
    }
  }

  _clearInbound(requestId) {
    const record = this.inboundPairings.get(requestId);
    if (record) {
      clearTimeout(record.timer);
      this.inboundPairings.delete(requestId);
    }
  }

  _handlePairingRequest(msg) {
    const requestId = msg.requestId;
    const remotePeerId = msg.from;
    if (!requestId || !remotePeerId) return;
    // Duplicate delivery of a known request: do not double-emit.
    if (this.inboundPairings.has(requestId)) return;
    const info = msg.info || { name: msg.fromName, type: msg.fromType };

    const timer = setTimeout(() => {
      this.inboundPairings.delete(requestId);
      this.onMessage({ type: 'pairing_expired', requestId, peerId: remotePeerId });
    }, this.pairingExpiryMs);
    this.inboundPairings.set(requestId, { peerId: remotePeerId, info, timer });

    // Never auto-accept and never initiate here; the user accepts via
    // respondPairing and the tie-break decides the initiator then.
    this.onMessage({ type: 'pairing_request', requestId, peerId: remotePeerId, info });
  }

  _handlePairingResponse(msg) {
    const requestId = msg.requestId;
    const remotePeerId = msg.from || msg.peerId;
    if (!requestId || !remotePeerId) return;
    const accepted = msg.accepted !== undefined ? msg.accepted : msg.accept;

    const outbound = this.outboundPairings.get(remotePeerId);
    if (!outbound || outbound.requestId !== requestId) return;
    this._clearOutbound(remotePeerId);

    this.onMessage({ type: 'pairing_response', requestId, peerId: remotePeerId, accepted: !!accepted });

    if (!accepted) return;
    // Already connected (accept-twice / duplicate): reuse, create nothing.
    if (this.connections.has(remotePeerId) || this.dataChannels.has(remotePeerId)) return;
    // Glare: both sides requested; only the lower id initiates.
    if (this._hasInboundFrom(remotePeerId) && !this._localInitiates(remotePeerId)) return;
    this._initiatePeerConnection(remotePeerId);
  }

  _initiatePeerConnection(remotePeerId) {
    if (this.connections.has(remotePeerId)) return;

    const pc = this._createPeerConnection(remotePeerId);

    // Create data channel (initiator side)
    const dc = pc.createDataChannel('transfer', PeerManager.transferChannelOptions());
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

  _createPeerConnection(remotePeerId, options = {}) {
    const config = {
      iceServers: options.manual ? [] : [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    };

    const pc = new RTCPeerConnection(config);
    this.connections.set(remotePeerId, pc);

    pc.onicecandidate = (e) => {
      if (options.manual) return;
      if (e.candidate) {
        this._send({
          type: 'signal',
          from: this.peerId,
          target: remotePeerId,
          signal: { candidate: e.candidate },
        });
      }
    };

    this._bindConnectionState(pc, remotePeerId);

    pc.ondatachannel = (e) => {
      this._setupDataChannel(e.channel, remotePeerId);
    };

    return pc;
  }

  _bindConnectionState(pc, remotePeerId) {
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.onMessage({ type: 'connection_state', peerId: remotePeerId, state });

      if (state === 'connected') {
        this._startPeerPing(remotePeerId);
      } else if (state === 'failed' || state === 'disconnected') {
        this._handleConnectionFailure(remotePeerId);
      }
    };
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
        await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => { });
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
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => { });
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

    // A fresh channel means nothing is known about the peer's protocol until
    // it handshakes again. Drop any record left over from a previous channel
    // with the same peer id so a mismatch can never be masked by a stale
    // "compatible" verdict.
    this.protocols.delete(remotePeerId);

    dc.onopen = () => {
      this.protocols.delete(remotePeerId);
      this.onMessage({ type: 'channel_open', peerId: remotePeerId });
    };

    dc.onclose = () => {
      // Renegotiation is required on the next channel, so forget the version
      // we had agreed rather than trusting it for a connection that is gone.
      this.protocols.delete(remotePeerId);
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
      } catch { }
    }, 2000);

    this.pingIntervals.set(remotePeerId, interval);
  }

  _handleConnectionFailure(remotePeerId) {
    const attempts = (this.reconnectAttempts.get(remotePeerId) || 0) + 1;
    this.reconnectAttempts.set(remotePeerId, attempts);

    // Retry is only possible when something can answer a fresh offer.
    //
    // In manual mode there is no signaling server at all, so a new offer has
    // nowhere to go: every attempt would build an RTCPeerConnection, negotiate
    // against nobody and abandon it, repeating every few seconds forever. Same
    // for a server-mode peer while the socket itself is down. In both cases
    // stop and report that re-pairing is needed instead of retrying.
    const canRetry = !this.manualMode && this.wsReady;

    if (!canRetry) {
      this._cancelPendingRetry(remotePeerId);
      this._cleanupPeer(remotePeerId, false);
      this.onMessage({
        type: 'reconnect_required',
        peerId: remotePeerId,
        reason: this.manualMode ? 'manual_mode' : 'signaling_unavailable',
        attempts,
      });
      return;
    }

    if (attempts > this.maxReconnects) {
      this._cancelPendingRetry(remotePeerId);
      this._cleanupPeer(remotePeerId, false);
      this.onMessage({
        type: 'reconnect_required',
        peerId: remotePeerId,
        reason: 'retries_exhausted',
        attempts,
      });
      return;
    }

    const delay = Math.min(1000 * attempts, 8000);
    this._cancelPendingRetry(remotePeerId);
    const timer = setTimeout(() => {
      this.retryTimers.delete(remotePeerId);
      this._cleanupPeer(remotePeerId, false);
      this._initiatePeerConnection(remotePeerId);
    }, delay);
    this.retryTimers.set(remotePeerId, timer);
  }

  _cancelPendingRetry(remotePeerId) {
    if (this.retryTimers.has(remotePeerId)) {
      clearTimeout(this.retryTimers.get(remotePeerId));
      this.retryTimers.delete(remotePeerId);
    }
  }

  _cleanupPeer(remotePeerId, notify = true) {
    this._cancelPendingRetry(remotePeerId);
    this._clearOutbound(remotePeerId);
    for (const [requestId, record] of Array.from(this.inboundPairings)) {
      if (record.peerId === remotePeerId) this._clearInbound(requestId);
    }

    const pc = this.connections.get(remotePeerId);
    if (pc) { try { pc.close(); } catch { } }
    this.connections.delete(remotePeerId);
    this.dataChannels.delete(remotePeerId);
    this.pendingSignals.delete(remotePeerId);

    // No channel, no agreed protocol.
    this.protocols.delete(remotePeerId);

    if (this.pingIntervals.has(remotePeerId)) {
      clearInterval(this.pingIntervals.get(remotePeerId));
      this.pingIntervals.delete(remotePeerId);
    }
  }

  _renamePeer(oldPeerId, newPeerId) {
    if (oldPeerId === newPeerId) return;

    const pc = this.connections.get(oldPeerId);
    if (pc) {
      this.connections.delete(oldPeerId);
      this.connections.set(newPeerId, pc);
      this._bindConnectionState(pc, newPeerId);
    }

    const dc = this.dataChannels.get(oldPeerId);
    if (dc) {
      this.dataChannels.delete(oldPeerId);
      this._setupDataChannel(dc, newPeerId);
    }

    // The provisional id never handshook under its final name, so anything
    // recorded for it must not be trusted for the real peer.
    this.protocols.delete(newPeerId);

    const pending = this.pendingSignals.get(oldPeerId);
    if (pending) {
      this.pendingSignals.delete(oldPeerId);
      this.pendingSignals.set(newPeerId, pending);
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
    if (this.manualMode) {
      const msg = {
        type: 'chat',
        from: this.peerId,
        name: this.localInfo?.name,
        text,
        private: isPrivate,
        target: targetId,
        timestamp: Date.now(),
      };
      if (targetId) {
        this.sendJsonToPeer(targetId, msg);
      } else {
        for (const [peerId] of this.dataChannels) this.sendJsonToPeer(peerId, msg);
      }
      return;
    }

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
    if (this.manualMode) {
      for (const [peerId] of this.dataChannels) {
        this.sendJsonToPeer(peerId, {
          type: 'whiteboard',
          from: this.peerId,
          event,
        });
      }
      return;
    }

    this._send({
      type: 'whiteboard',
      from: this.peerId,
      event,
    });
  }

  sendTypingIndicator(isTyping) {
    if (this.manualMode) {
      for (const [peerId] of this.dataChannels) {
        this.sendJsonToPeer(peerId, {
          type: 'typing',
          from: this.peerId,
          name: this.localInfo?.name,
          isTyping,
        });
      }
      return;
    }

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

  // ---------------------------------------------------------------------
  // Protocol version handshake state
  //
  // transfer.js sends and receives the handshake message; these methods are
  // the store it records into and the queries it refuses transfers on.
  // ---------------------------------------------------------------------

  /** Protocol version this build speaks. */
  localProtocolVersion() {
    const framed = typeof window !== 'undefined' && window.Framing
      ? window.Framing.PROTOCOL_VERSION
      : undefined;
    return Number.isInteger(framed) ? framed : PeerManager.LOCAL_PROTOCOL_VERSION;
  }

  /**
   * Record a peer's handshake result.
   * @param {string} peerId
   * @param {number} version protocol version the peer reported
   * @param {object} [capabilities] optional capability flags the peer reported
   */
  recordProtocol(peerId, version, capabilities = {}) {
    const record = {
      version: Number.isFinite(version) ? Number(version) : null,
      capabilities: capabilities && typeof capabilities === 'object' ? { ...capabilities } : {},
      at: Date.now(),
    };
    this.protocols.set(peerId, record);
    return record;
  }

  /** The peer's negotiated protocol, or null when not yet negotiated. */
  getProtocol(peerId) {
    return this.protocols.get(peerId) || null;
  }

  /** The peer's reported capabilities, or null when not yet negotiated. */
  getCapabilities(peerId) {
    const record = this.protocols.get(peerId);
    return record ? record.capabilities : null;
  }

  /** Forget a peer's handshake, forcing renegotiation. */
  clearProtocol(peerId) {
    this.protocols.delete(peerId);
  }

  /**
   * Whether this peer can be transferred to.
   *
   * Never throws. Always returns
   * `{ ok, local, remote, peerId, reason? }`, where `remote` is null until the
   * peer has completed a handshake and `reason` names both versions on a
   * mismatch.
   */
  isProtocolCompatible(peerId) {
    const local = this.localProtocolVersion();
    const record = this.protocols.get(peerId);

    if (!record) {
      return {
        ok: false,
        peerId,
        local,
        remote: null,
        reason: `Protocol not negotiated yet: this device speaks version ${local}, ` +
          `and ${peerId} has not reported a version.`,
      };
    }

    const remote = record.version;
    if (!Number.isInteger(remote)) {
      return {
        ok: false,
        peerId,
        local,
        remote: null,
        reason: `Unrecognised protocol version ${remote === null ? 'none' : remote} from ${peerId}; ` +
          `this device speaks version ${local}.`,
      };
    }

    if (remote !== local) {
      return {
        ok: false,
        peerId,
        local,
        remote,
        reason: `Protocol mismatch: this device speaks version ${local}, ` +
          `but ${peerId} speaks version ${remote}. Update LanShare on both devices.`,
      };
    }

    return { ok: true, peerId, local, remote };
  }

  /**
   * Same result as isProtocolCompatible(), named for refusal paths where the
   * caller wants to make the check unavoidable. Does not throw; inspect `ok`
   * and surface `reason`.
   */
  assertProtocolCompatible(peerId) {
    return this.isProtocolCompatible(peerId);
  }
}

window.PeerManager = PeerManager;
window.CHUNK_SIZE = CHUNK_SIZE;
