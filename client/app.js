// client/app.js
// Main orchestration — wires identity, WebRTC, transfers, and UI together

(function () {
  'use strict';

  let identity, peerManager, transferEngine, ui, netViz;
  let speedTestActive = false;
  let xferBytesIn = 0, xferBytesOut = 0;
  // Last cumulative byte count reported per transfer, keyed by
  // direction + transfer id. TransferEngine emits per-callback cumulative
  // totals (bytesSent / bytesReceived); summing those, or summing its
  // cumulative-average `speed`, grows with transfer length. Summing
  // per-interval byte DELTAS and dividing by elapsed wall time yields the
  // true rate. Key includes direction so an upload and a download that share
  // a numeric id cannot corrupt each other's baseline.
  let xferLastBytes = new Map();
  let lastMetricTs = Date.now();
  let staticMode = false;
  // Flow wiring instance (pairing consent / fragment / trust). Created in
  // init(); handleMessage/sendFile resolve it at call time so tests can drive
  // the same flow object through the test seam below.
  let appFlow = null;

  // Direction-qualified map key for one onProgress payload.
  function xferKey(data) {
    const dir = data && data.direction === 'in' ? 'in' : 'out';
    const id = data && data.transferId !== undefined && data.transferId !== null
      ? String(data.transferId)
      : String(data && data.peerId !== undefined && data.peerId !== null ? data.peerId : '?');
    return dir + ':' + id;
  }

  // Cumulative bytes moved for one onProgress payload, or null when the
  // payload carries no usable total. Prefers the engine's explicit counters
  // and falls back to progress * total only when those are absent.
  function xferCumulative(data) {
    if (!data) return null;
    if (Number.isFinite(data.bytesSent)) return data.bytesSent;
    if (Number.isFinite(data.bytesReceived)) return data.bytesReceived;
    if (Number.isFinite(data.bytes)) return data.bytes;
    if (Number.isFinite(data.total) && Number.isFinite(data.progress)) {
      return Math.round(data.total * data.progress);
    }
    if (Number.isFinite(data.fileSize) && Number.isFinite(data.progress)) {
      return Math.round(data.fileSize * data.progress);
    }
    return null;
  }

  // Add one onProgress payload's DELTA to the current interval accumulator.
  // A cumulative that runs backwards (restarted transfer reusing an id) is
  // treated as a fresh baseline, never as negative throughput.
  function recordTransferBytes(data) {
    const cum = xferCumulative(data);
    if (cum === null || cum === undefined || cum < 0) return;
    const key = xferKey(data);
    const last = xferLastBytes.get(key);
    let delta;
    if (last === undefined) delta = cum;
    else if (cum < last) delta = cum;
    else delta = cum - last;
    xferLastBytes.set(key, cum);
    if (data.direction === 'in') xferBytesIn += delta;
    else xferBytesOut += delta;
  }

  // Drop per-transfer baselines once the transfer is over so the map stays
  // proportional to live transfers. Without a direction, drop both sides.
  function forgetTransfer(transferId, direction) {
    if (transferId === undefined || transferId === null) return;
    if (direction === 'in' || direction === 'out') {
      xferLastBytes.delete(direction + ':' + String(transferId));
    } else {
      xferLastBytes.delete('in:' + String(transferId));
      xferLastBytes.delete('out:' + String(transferId));
    }
  }

  function init() {
    identity = Identity.getOrCreateIdentity();

    ui = new UI();
    ui.init(identity);

    peerManager = new PeerManager(identity.id, handleMessage);
    peerManager.setLocalInfo({
      name: identity.name,
      type: identity.type,
      palette: identity.palette,
    });
    staticMode = window.LANSHARE_STATIC === true
      || location.protocol === 'file:'
      || new URLSearchParams(location.search).has('static');
    // The signaling endpoint is configurable: a PeerManager that exposes
    // getEndpoint() names the endpoint to use (self-hosted, hosted relay, or
    // null for the default). Absence means "default behaviour".
    if (typeof peerManager.getEndpoint === 'function') {
      const endpoint = peerManager.getEndpoint();
      if (endpoint) peerManager.connect({ manual: staticMode, serverUrl: endpoint });
      else peerManager.connect({ manual: staticMode });
    } else {
      peerManager.connect({ manual: staticMode });
    }
    ui.setStaticMode(staticMode);

    // Server mode: show the join panel so phones can scan their way in.
    // Static mode hides it (no server to join) and pairs by code instead.
    // The URL must be LAN-reachable: location.origin is "localhost" when the
    // page was opened locally, which is useless on a phone, so prefer the
    // server-advertised address and fall back only if it is unreachable.
    if (!staticMode) {
      resolveJoinUrl().then((joinUrl) => {
        if (joinUrl) ui.showJoinPanel(joinUrl);
      }).catch(() => { /* join panel is progressive enhancement */ });
    }

    async function resolveJoinUrl() {
      const fallback = location.origin + location.pathname;
      try {
        const res = await fetch('/lan.json', { cache: 'no-store' });
        if (!res.ok) return fallback;
        const data = await res.json();
        const urls = data && Array.isArray(data.urls) ? data.urls : [];
        // Prefer a URL on the same host the page was opened from when it is
        // already LAN-reachable; otherwise take the server's first address.
        const here = (location.hostname || '').toLowerCase();
        const isLoopback = here === 'localhost' || here === '127.0.0.1' || here === '::1' || here === '';
        if (!isLoopback) return fallback;
        if (urls.length > 0) return urls[0] + location.pathname;
        return fallback;
      } catch {
        return fallback;
      }
    }

    transferEngine = new TransferEngine(peerManager);

    // Shared flow object: identical logic runs in the browser and in
    // tests/app-flow.test.js (vm sandbox with fake PeerManager/UI/Transfer).
    appFlow = createAppFlow({
      peerManager,
      ui,
      transfer: transferEngine,
      codec: (typeof window !== 'undefined' && window.PairingCodec) ? window.PairingCodec : null,
      location: (typeof location !== 'undefined') ? location : null,
      history: (typeof history !== 'undefined') ? history : null,
      localId: identity.id,
    });

    // Outgoing pairing requests (server mode consent flow). The UI layer may
    // not offer a button for this yet; the hook is what matters.
    ui.onRequestPair = (peerId) => appFlow.requestPair(peerId);
    ui.onConfirmPairing = (peerId) => appFlow.confirmPairing(peerId || 'manual');
    ui.onSkipPairing = (peerId) => appFlow.skipPairing(peerId || 'manual');

    transferEngine.onProgress = (data) => {
      recordTransferBytes(data);

      ui.updateTransfer({
        transferId: data.transferId,
        peerId: data.peerId,
        progress: data.progress,
        speed: data.speed,
        eta: data.eta,
      });
      ui.logPacketEvent('chunk', null, `${Math.round((data.progress || 0) * 100)}%`);

      if (netViz) {
        const from = data.direction === 'out' ? identity.id : data.peerId;
        const to = data.direction === 'out' ? data.peerId : identity.id;
        netViz.spawnPacket(from, to, identity.palette[0]);
      }
    };

    transferEngine.onComplete = (data) => {
      if (data && data.transferId !== undefined) forgetTransfer(data.transferId, data.direction);
      ui.showTransferComplete(data);
      if (data.fromPeerId) ui.clearTransfer(data.fromPeerId);
    };

    transferEngine.onIncoming = (data) => {
      // Trust gate (static-mode-trust): every incoming file waits for an
      // explicit confirmIncoming. A decline notifies the sender and discards.
      if (appFlow) appFlow.handleIncomingWithConfirm(data);
      else ui.showIncoming(data);
    };

    transferEngine.onCancelled = (transferId, info) => {
      forgetTransfer(transferId, info && info.direction);
      ui.showNotification('Transfer cancelled', 'info');
    };

    // Terminal failure ends the transfer without onComplete; drop its
    // baseline so a later transfer reusing the id starts fresh. No UI change.
    transferEngine.onFailure = (info) => {
      if (info && info.transferId !== undefined) forgetTransfer(info.transferId, info.direction);
    };

    transferEngine.onLatency = (peerId, rtt) => ui.updatePeerLatency(peerId, rtt);

    transferEngine.onControl = (peerId, msg) => {
      ui.logPacketEvent(msg.type, null, '');
      handleMessage({ ...msg, peerId, from: msg.from || peerId });
    };

    // ── UI callbacks ──
    ui.onSendFiles = (files, peerId) => files.forEach(f => sendFile(f, peerId));

    ui.onCancelTransfer = (id) => transferEngine.cancelTransfer(id);

    ui.onSendChat = (text, target, isPrivate) => {
      peerManager.sendChatMessage(text, target, isPrivate);
      // Add to own feed immediately (server won't echo back to us)
      ui.addChatMessage({
        fromPeer: identity.id,
        name: identity.name,
        text,
        timestamp: Date.now(),
        private: isPrivate,
      });
    };

    ui.onTyping = (isTyping) => peerManager.sendTypingIndicator(isTyping);

    ui.onSpeedTest = async (peerId) => {
      if (speedTestActive) return;
      speedTestActive = true;
      ui.showSpeedTestRunning(peerId, true);
      ui.showNotification('⚡ Running speed test...', 'info');
      const latency = peerManager.getLatency(peerId) || null;
      const result = await transferEngine.runSpeedTest(peerId);
      result.latency = latency;
      ui.addSpeedTestResult(peerId, result);
      speedTestActive = false;
    };

    ui.onWhiteboardDraw = (event) => peerManager.sendWhiteboardEvent(event);

    ui.onCreateCode = async (targetPeerId = null) => {
      ui.setPairingStatus('Creating code...');
      try {
        const offer = await peerManager.createManualOffer(targetPeerId);
        ui.setManualCode(offer);
        // New four-form panel: compress the offer and show QR + link + copy
        // + grouped text. The old textarea stays as fallback (transition).
        // A panel failure is reported visibly — a silent catch here is how
        // the QR stayed invisible for weeks.
        try {
          const shown = await showCompressedPanel(offer, 'offer', targetPeerId);
          if (!shown) ui.setPairingStatus('Code ready below. QR unavailable in this browser — copy the code instead.', false);
        } catch (err) {
          ui.setPairingStatus('Code ready below. QR failed: ' + (err?.message || err), true);
        }
        if (!targetPeerId) {
          ui.revealRemotePanel();
        }
        ui.setPairingStatus(targetPeerId
          ? 'Reconnect code ready. Share this with the saved device.'
          : 'Code ready. Copy it to the other device. Paste the returned response when ready.');
      } catch (err) {
        ui.setPairingStatus(err.message || 'Could not create code.', true);
      }
    };

    // Compress an old-format manual code (base64 JSON) into the new compact
    // form and show the four-form panel. Returns true when the panel showed.
    async function showCompressedPanel(oldCode, role, targetPeerId) {
      const codec = (typeof window !== 'undefined' && window.PairingCodec) ? window.PairingCodec : null;
      if (!codec || typeof codec.encodeText !== 'function' || typeof codec.trimCandidates !== 'function') return false;
      if (typeof ui.showPairingPanel !== 'function') return false;
      // Decode old wrapper, trim the SDP inside, rebuild, compress.
      const json = decodeURIComponent(escape(atob(String(oldCode).trim())));
      const envelope = JSON.parse(json);
      if (envelope && envelope.signal && envelope.signal.sdp && typeof envelope.signal.sdp.sdp === 'string') {
        envelope.signal.sdp.sdp = codec.trimCandidates(envelope.signal.sdp.sdp);
      }
      const raw = await codec.encodeText(JSON.stringify(envelope));
      const base = (typeof location !== 'undefined')
        ? (location.origin + location.pathname)
        : '';
      const link = base + (role === 'answer' ? '#a=' : '#o=') + raw;
      ui.showPairingPanel({ raw, link });
      return true;
    }

    // New panel input: paste auto-submits here. Accepts the new compressed
    // form or a full link; falls back to the old raw format (transition).
    ui.onPairingSubmit = async (parsed) => {
      const payload = parsed && parsed.payload ? String(parsed.payload) : '';
      if (!payload) {
        ui.setPairingStatus('Paste a code first.', true);
        return;
      }
      const codec = (typeof window !== 'undefined' && window.PairingCodec) ? window.PairingCodec : null;
      if (codec && typeof codec.decodePayload === 'function' && /^[A-Za-z0-9\-_]+$/.test(payload)) {
        try {
          const json = await codec.decodePayload(payload);
          const envelope = JSON.parse(json);
          if (envelope && envelope.app === 'lanshare') {
            // New format: re-wrap as old base64 and use the existing path.
            const oldCode = btoa(unescape(encodeURIComponent(json)));
            await ui.onConnectCode(oldCode);
            return;
          }
        } catch (_) { /* fall through to old-format path */ }
      }
      await ui.onConnectCode(payload);
    };

    ui.onReconnectPeer = async (peerId) => {
      ui.setPairingStatus('Preparing reconnect code...');
      try {
        await ui.onCreateCode(peerId);
      } catch (err) {
        ui.setPairingStatus(err.message || 'Could not prepare reconnect code.', true);
      }
    };

    ui.onConnectCode = async (rawCode) => {
      ui.setPairingStatus('Reading code...');
      try {
        // Pairing-friction: the manual input accepts a raw payload OR a full
        // pairing link (fragment stripped) and tolerates pasted whitespace.
        const norm = normalizePairingInput(rawCode);
        const code = norm.payload;
        const result = await peerManager.processManualCode(code);
        ui.clearRemoteCode();
        if (result.responseCode) {
          ui.setManualCode(result.responseCode);
          try {
            const shown = await showCompressedPanel(result.responseCode, 'answer', null);
            if (!shown) ui.setPairingStatus('Response below. QR unavailable — copy it instead.', false);
          } catch (err) {
            ui.setPairingStatus('Response below. QR failed: ' + (err?.message || err), true);
          }
          ui.showCopyIndicator('Response code copied to clipboard. please paste/share it with the other device.');
          try {
            await navigator.clipboard?.writeText(result.responseCode).catch(() => {
              const target = document.getElementById('manual-code');
              target?.select();
              document.execCommand('copy');
            });
          } catch {
            // Ignore clipboard issues and still keep the code available in the field.
          }
          ui.setPairingStatus('Response code copied to clipboard. please paste/share it with the other device.');
        } else {
          ui.setPairingStatus('Paired. Waiting for the direct channel to open...');
        }
        // Pairing-friction: after offer+answer are exchanged, both sides show
        // the same confirmation code. Only wired when the UI implements the
        // confirmation surface; otherwise pairing stays ungated as before.
        try {
          if (appFlow && typeof ui.showConfirmationCode === 'function') {
            const localCode = (document.getElementById('manual-code') || {}).value || code;
            const normLocal = normalizePairingInput(localCode).payload;
            const normRemote = normalizePairingInput(result.responseCode || code).payload;
            await appFlow.beginConfirmation('manual', normLocal, normRemote);
          }
        } catch (_) { /* confirmation UI is best-effort here */ }
      } catch (err) {
        ui.setPairingStatus(err.message || 'Could not connect with that code.', true);
      }
    };

    // ── Network Visualizer ──
    const vizCanvas = document.getElementById('network-viz');
    if (vizCanvas) {
      netViz = new NetworkVisualizer(vizCanvas);
      netViz.start(identity.id, identity.name, identity.palette);
    }

    // Hook into tab switch to resize viz canvas
    ui._onNetworkTabOpen = () => {
      if (netViz) netViz._resize();
    };

    // Metrics timer
    setInterval(updateMetrics, 1000);

    // Static-mode fragment restore (pairing-friction): a link opened with
    // #o= / #a= restores the pairing state. The hash is scrubbed first,
    // inside restoreFragment, before any decode is attempted.
    try {
      const frag = appFlow.restoreFragment();
      if (frag && typeof frag.catch === 'function') frag.catch(() => {});
    } catch (_) { /* errors surface through the pairing status */ }

    console.log(`[LanShare] Ready as ${identity.name} (${identity.id.substr(0, 8)})`);
  }

  function handleMessage(msg) {
    switch (msg.type) {

      case 'peer_joined':
        ui.addPeer(msg.peerId, msg.info);
        netViz?.addNode(msg.peerId, msg.info.name, msg.info.palette || Identity.getPalette(msg.peerId));
        // Manual pairing handles its own offer/answer flow; avoid starting a second connection attempt.
        // With consent-based pairing (PeerManager.requestPairing), discovery
        // alone never opens a channel: the initiator connects only after an
        // acceptance (see the flow section). Keep the legacy auto-connect
        // only while the consent API is unavailable.
        if (!peerManager.manualMode && !peerManager.connections.has(msg.peerId)) {
          if (typeof peerManager.requestPairing === 'function') {
            ui.logPacketEvent('peer_discovered', null, msg.info?.name);
          } else {
            setTimeout(() => peerManager._initiatePeerConnection(msg.peerId), 100);
          }
        }
        ui.logPacketEvent('peer_joined', null, msg.info?.name);
        break;

      case 'peer_left':
        ui.removePeer(msg.peerId);
        netViz?.removeNode(msg.peerId);
        ui.logPacketEvent('peer_left', null, msg.name);
        break;

      case 'channel_open':
        // DataChannel opened — this is the definitive connected signal
        ui.updatePeerState(msg.peerId, 'connected');
        ui.markPeerConnected(msg.peerId);
        ui.logPacketEvent('channel_open', null, msg.peerId.substr(0, 10));
        if (appFlow) appFlow.onChannelOpen(msg.peerId);
        break;

      case 'channel_closed':
        ui.updatePeerState(msg.peerId, 'connecting');
        break;

      case 'connection_state':
        if (msg.state === 'connected') {
          ui.updatePeerState(msg.peerId, 'connected');
          ui.markPeerConnected(msg.peerId);
        } else if (msg.state === 'connecting' || msg.state === 'new') {
          ui.updatePeerState(msg.peerId, 'connecting');
        } else if (msg.state === 'failed') {
          ui.updatePeerState(msg.peerId, 'disconnected');
        }
        break;

      case 'data':
        handlePeerData(msg.peerId, msg.data);
        break;

      case 'chat':
        ui.addChatMessage({
          fromPeer: msg.from,
          name: msg.name,
          text: msg.text,
          timestamp: msg.timestamp,
          private: msg.private,
        });
        if (msg.private) {
          ui.showNotification(`🔒 Private message from ${msg.name}`, 'info');
          ui.switchTab('chat');
        }
        break;

      case 'whiteboard':
        ui.drawRemoteStroke(msg.event);
        break;

      case 'typing':
        ui.showTyping(msg.name, msg.isTyping);
        break;

      // ── Pairing consent / signaling health (flow section owns the logic;
      //     this switch only routes). Covers request/accept/decline/expiry,
      //     signaling_down/up, reconnect_required, and transfer_declined.
      case 'pairing_request':
      case 'pairing_accepted':
      case 'pairing_accept':
      case 'pairing_response':
      case 'pairing_declined':
      case 'pairing_decline':
      case 'pairing_expired':
      case 'signaling_down':
      case 'signaling_up':
      case 'reconnect_required':
      case 'transfer_declined':
        if (appFlow) appFlow.handleMessage(msg);
        break;

      case 'ws_reconnecting':
        ui.showNotification(`Reconnecting... (attempt ${msg.attempt})`, 'warn');
        break;
    }
  }

  function handlePeerData(peerId, data) {
    transferEngine.handleData(peerId, data);
    const sz = typeof data === 'string' ? data.length : (data?.byteLength || 0);
    if (sz > 1000) ui.logPacketEvent('binary_chunk', sz, '');
  }

  async function sendFile(file, peerId) {
    // Trust gates (static-mode-trust): an unconfirmed pairing never enables
    // transfer, and every send waits for an explicit confirmSend. A decline
    // sends nothing and creates no state.
    if (appFlow) {
      const allowed = await appFlow.confirmSendFor(file, peerId);
      if (!allowed) return;
    } else if (typeof ui.confirmSend === 'function') {
      const ok = await ui.confirmSend({ fileName: file.name, fileSize: file.size, peerName: peerId });
      if (!ok) return;
    }
    ui.showNotification(`📤 Sending ${file.name} (${fmtBytes(file.size)})`, 'info');
    ui.logPacketEvent('transfer_start', file.size, file.name);

    await transferEngine.sendFile(file, peerId, (prog) => {
      ui.updateTransfer({
        transferId: prog.transferId,
        peerId,
        progress: prog.progress,
        speed: prog.speed,
        eta: prog.eta,
      });
    });
  }

  // ── Pairing / consent / trust flow wiring ────────────────────────────────
  // OpenSpec changes: signaling-rooms (pairing-consent, lan-isolation),
  // pairing-friction (pairing-ux), static-mode-trust (trust-and-privacy).
  //
  // All orchestration here is coded against the shared contracts only:
  //   PeerManager: requestPairing(peerId)->requestId,
  //     respondPairing(requestId, accept, peerId), getEndpoint()->string|null
  //   UI: showPairingRequest, clearPairingRequest, showPairingPending,
  //     clearPairingPending, confirmSend, confirmIncoming,
  //     showConfirmationCode, clearConfirmationCode
  // createAppFlow(deps) holds the logic so the browser and
  // tests/app-flow.test.js (vm sandbox with fakes) drive the same paths.

  // Fixed 256-word list for confirmation codes. Each digest byte selects one
  // word, so the mapping is stable across devices and across runs.
  const CONFIRM_WORDS = [
    'acorn', 'admiral', 'alarm', 'album', 'alert', 'amber', 'anchor', 'angel',
    'ankle', 'answer', 'antler', 'apple', 'april', 'arrow', 'atlas', 'autumn',
    'bacon', 'badge', 'bamboo', 'banana', 'banner', 'barrel', 'basin', 'basket',
    'beacon', 'berry', 'birch', 'blanket', 'blossom', 'breeze', 'brick', 'bridge',
    'bright', 'bronze', 'bubble', 'bucket', 'cabin', 'cactus', 'canvas', 'canyon',
    'cargo', 'castle', 'cedar', 'cellar', 'chain', 'chalk', 'chance', 'charge',
    'cheese', 'cherry', 'chest', 'chicken', 'chief', 'child', 'chimney', 'choice',
    'chorus', 'chrome', 'cider', 'cinema', 'circle', 'citrus', 'cliff', 'clock',
    'closet', 'cloud', 'clover', 'coach', 'coast', 'cobra', 'cocoa', 'comet',
    'compass', 'copper', 'coral', 'cork', 'cotton', 'couch', 'cougar', 'crane',
    'crate', 'creek', 'cricket', 'crystal', 'cupboard', 'curtain', 'dahlia',
    'daisy', 'dancer', 'delta', 'denim', 'desert', 'dolphin', 'donkey', 'dragon',
    'drift', 'drum', 'dune', 'eagle', 'ebony', 'echo', 'eclipse', 'elm',
    'ember', 'engine', 'falcon', 'fern', 'fiber', 'field', 'finch', 'firefly',
    'flannel', 'fleet', 'flint', 'flora', 'forest', 'forge', 'fossil', 'fountain',
    'foxglove', 'frame', 'frost', 'garage', 'garden', 'garnet', 'gecko', 'ginger',
    'glacier', 'glove', 'granite', 'grape', 'harbor', 'harp', 'hazel', 'helmet',
    'heron', 'hickory', 'honey', 'horizon', 'husky', 'igloo', 'indigo', 'inlet',
    'island', 'ivory', 'jacket', 'jaguar', 'jasper', 'jungle', 'juniper', 'kelp',
    'kettle', 'kite', 'koala', 'ladder', 'lagoon', 'lantern', 'larch', 'laurel',
    'linen', 'lizard', 'lunar', 'magnet', 'magpie', 'mango', 'maple', 'marble',
    'meadow', 'melon', 'mesa', 'meteor', 'miller', 'mint', 'mirror', 'monarch',
    'moss', 'mountain', 'mulberry', 'napkin', 'needle', 'nickel', 'nugget', 'oasis',
    'ocean', 'onyx', 'opal', 'orchard', 'otter', 'oven', 'oxygen', 'paddle',
    'panda', 'parrot', 'pasture', 'pebble', 'pelican', 'pencil', 'pepper', 'petal',
    'picket', 'pigeon', 'pilot', 'pioneer', 'plaza', 'polar', 'poplar', 'prairie',
    'prism', 'puddle', 'quartz', 'quiver', 'radar', 'raft', 'raven', 'ridge',
    'river', 'rocket', 'saddle', 'saffron', 'salmon', 'satchel', 'savanna', 'scooter',
    'sender', 'shale', 'shelter', 'silver', 'slate', 'solar', 'spruce', 'stable',
    'summit', 'tapestry', 'teapot', 'thicket', 'thunder', 'timber', 'topaz',
    'trail', 'tulip', 'tundra', 'tunnel', 'turbine', 'turtle', 'umber', 'valley',
    'velvet', 'village', 'violin', 'vista', 'walnut', 'willow', 'window', 'yarn',
    'yellow', 'zebra',
  ].map((w) => String(w).trim());

  // --- SHA-256 ------------------------------------------------------------
  // Primary path is crypto.subtle directly. The embedded fallback covers
  // contexts without WebCrypto (some file:// viewers) and keeps the mapping
  // byte-identical: first 8 hex chars -> 4 words.
  function sha256Fallback(bytes) {
    const K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const bitLen = bytes.length * 8;
    const withPad = bytes.length + 1 + 8;
    const blocks = Math.ceil(withPad / 64);
    const msg = new Uint8Array(blocks * 64);
    msg.set(bytes, 0);
    msg[bytes.length] = 0x80;
    const dv = new DataView(msg.buffer);
    dv.setUint32(msg.length - 4, bitLen >>> 0, false);
    dv.setUint32(msg.length - 8, Math.floor(bitLen / 4294967296), false);
    const w = new Int32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let b = 0; b < blocks; b++) {
      for (let i = 0; i < 16; i++) w[i] = dv.getInt32(b * 64 + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let a = h0, c = h1, d = h2, e = h3, f = h4, g = h5, h = h6, k = h7;
      // (a..h map to the standard working variables; named to avoid clashing.)
      let t1, t2;
      // Reuse canonical names via locals:
      let A = a, B = c, C = d, D = e, E = f, F = g, G = h, H = k;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
        const ch = (E & F) ^ (~E & G);
        t1 = (H + S1 + ch + K[i] + w[i]) | 0;
        const S0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
        const maj = (A & B) ^ (A & C) ^ (B & C);
        t2 = (S0 + maj) | 0;
        H = G; G = F; F = E; E = (D + t1) | 0; D = C; C = B; B = A; A = (t1 + t2) | 0;
      }
      h0 = (h0 + A) | 0; h1 = (h1 + B) | 0; h2 = (h2 + C) | 0; h3 = (h3 + D) | 0;
      h4 = (h4 + E) | 0; h5 = (h5 + F) | 0; h6 = (h6 + G) | 0; h7 = (h7 + H) | 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7]
      .map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  function sha256Hex(input, subtle) {
    const data = typeof input === 'string'
      ? new TextEncoder().encode(input)
      : (input instanceof Uint8Array ? input : new Uint8Array(input || []));
    const impl = subtle
      || (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle)
      || null;
    if (impl && typeof impl.digest === 'function') {
      return impl.digest('SHA-256', data).then((buf) =>
        Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, '0')).join(''));
    }
    return Promise.resolve(sha256Fallback(data));
  }

  // Derive 4 confirmation words from the two exchanged payloads. Payloads are
  // sorted first so both sides — which hold offer/answer in opposite order —
  // derive the identical code for the same exchange.
  function deriveConfirmationWords(payloadA, payloadB, subtle) {
    const ordered = [String(payloadA), String(payloadB)].sort();
    return sha256Hex(ordered[0] + '|' + ordered[1], subtle).then((hex) => {
      const words = [];
      for (let i = 0; i < 4; i++) {
        words.push(CONFIRM_WORDS[parseInt(hex.slice(i * 2, i * 2 + 2), 16)]);
      }
      return words;
    });
  }

  // Accept a raw payload OR a full pairing link; whitespace-tolerant.
  // Returns { kind: 'offer' | 'answer' | null, payload }.
  function normalizePairingInput(raw) {
    const compact = String(raw === undefined || raw === null ? '' : raw).replace(/\s+/g, '');
    const markers = [
      ['#o=', 'offer'], ['#a=', 'answer'],
      ['?o=', 'offer'], ['?a=', 'answer'],
    ];
    let at = -1;
    let kind = null;
    for (const [m, k] of markers) {
      const i = compact.indexOf(m);
      if (i !== -1 && (at === -1 || i < at)) { at = i; kind = k; }
    }
    if (at !== -1) {
      let payload = compact.slice(at + 3);
      const amp = payload.indexOf('&');
      if (amp !== -1) payload = payload.slice(0, amp);
      return { kind, payload };
    }
    return { kind: null, payload: compact };
  }

  function createAppFlow(deps) {
    deps = deps || {};
    const pm = deps.peerManager || null;
    const flowUi = deps.ui || null;
    const engine = deps.transfer || deps.transferEngine || null;
    const codec = deps.codec || deps.pairingCodec || null;
    const flowLoc = deps.location || null;
    const flowHist = deps.history || null;
    const localPeerId = deps.localId || deps.localPeerId || 'local';

    const state = {
      outgoing: new Map(),  // requestId -> { peerId, at }
      expired: new Set(),   // requestIds that received pairing_expired
      initiated: new Set(), // requestIds / peers the initiator already connected
      accepted: new Set(),  // peerIds with an accepted pairing
      confirm: new Map(),   // peerId -> { words, confirmed, skipped }
      signalingDown: false,
    };

    function peerDisplayName(peerId) {
      try {
        const p = flowUi && flowUi.peers && typeof flowUi.peers.get === 'function'
          ? flowUi.peers.get(peerId) : null;
        if (p && p.info && p.info.name) return p.info.name;
      } catch (_) { /* display name is best-effort */ }
      return peerId;
    }

    function notify(text, type) {
      try {
        if (flowUi && typeof flowUi.showNotification === 'function') {
          flowUi.showNotification(text, type || 'info');
        }
      } catch (_) { /* notifications are best-effort */ }
    }

    function uiError(text) {
      try {
        if (flowUi && typeof flowUi.setPairingStatus === 'function') flowUi.setPairingStatus(text, true);
        else notify(text, 'error');
      } catch (_) { /* error surface is best-effort */ }
    }

    // Exactly-once initiator connect for an accepted pairing. The WebRTC
    // handshake itself lives in webrtc.js; this only triggers it once.
    function connectInitiator(peerId, key) {
      const k = key === undefined || key === null ? peerId : key;
      if (state.initiated.has(k)) return false;
      state.initiated.add(k);
      if (!pm) return false;
      if (typeof pm._initiatePeerConnection === 'function') { pm._initiatePeerConnection(peerId); return true; }
      if (typeof pm.initiateConnection === 'function') { pm.initiateConnection(peerId); return true; }
      if (typeof pm.connectToPeer === 'function') { pm.connectToPeer(peerId); return true; }
      return false;
    }

    // ── 1. Server-mode request/accept ──────────────────────────────────

    // Outgoing request: show pending, wait for an explicit decision. No
    // handshake starts here — only after an acceptance.
    function requestPair(peerId) {
      if (!pm || typeof pm.requestPairing !== 'function') {
        notify('Pairing requests are not available on this build.', 'error');
        return null;
      }
      const requestId = pm.requestPairing(peerId);
      state.outgoing.set(requestId, { peerId, at: Date.now() });
      if (flowUi && typeof flowUi.showPairingPending === 'function') {
        flowUi.showPairingPending(requestId, peerId);
      } else {
        notify(`Pairing request sent to ${peerDisplayName(peerId)}…`, 'info');
      }
      return requestId;
    }

    function clearOutgoing(requestId) {
      state.outgoing.delete(requestId);
      try {
        if (flowUi && typeof flowUi.clearPairingPending === 'function') {
          flowUi.clearPairingPending(requestId);
        }
      } catch (_) { /* cleanup is best-effort */ }
    }

    // Requester side: the peer accepted.
    function onPairingAccepted(msg) {
      const requestId = msg.requestId;
      const peerId = msg.peerId || (requestId !== undefined && state.outgoing.get(requestId)?.peerId);
      if (requestId !== undefined && state.expired.has(requestId)) return 'ignored-expired';
      if (requestId !== undefined) clearOutgoing(requestId);
      if (!peerId) return 'accepted-no-peer';
      state.accepted.add(peerId);
      notify(`Paired with ${peerDisplayName(peerId)}`, 'success');
      connectInitiator(peerId, requestId !== undefined ? requestId : peerId);
      return 'accepted';
    }

    // Requester side: the peer declined.
    function onPairingDeclined(msg) {
      const requestId = msg.requestId;
      const peerId = msg.peerId || (requestId !== undefined && state.outgoing.get(requestId)?.peerId);
      if (requestId !== undefined && state.expired.has(requestId)) return 'ignored-expired';
      if (requestId !== undefined) clearOutgoing(requestId);
      notify(`Pairing declined by ${peerDisplayName(peerId || 'device')}`, 'info');
      return 'declined';
    }

    // Incoming request: offer accept/decline, accept only responds (the offer
    // arrives afterwards); decline responds negatively. Nothing connects here.
    function onPairingRequest(msg) {
      const requestId = msg.requestId;
      const peerId = msg.peerId;
      const info = msg.info || {};
      if (requestId !== undefined && state.expired.has(requestId)) return 'ignored-expired';
      if (!flowUi || typeof flowUi.showPairingRequest !== 'function') return 'no-ui';
      flowUi.showPairingRequest({
        requestId,
        peerId,
        info,
        onAccept: () => {
          if (requestId !== undefined && state.expired.has(requestId)) return;
          if (pm && typeof pm.respondPairing === 'function') {
            pm.respondPairing(requestId, true, peerId);
          }
          if (peerId) state.accepted.add(peerId);
        },
        onDecline: () => {
          if (requestId !== undefined && state.expired.has(requestId)) return;
          if (pm && typeof pm.respondPairing === 'function') {
            pm.respondPairing(requestId, false, peerId);
          }
        },
      });
      return 'requested';
    }

    function onPairingExpired(msg) {
      const requestId = msg.requestId;
      if (requestId !== undefined) {
        state.expired.add(requestId);
        state.outgoing.delete(requestId);
        try {
          if (flowUi && typeof flowUi.clearPairingPending === 'function') {
            flowUi.clearPairingPending(requestId);
          }
          if (flowUi && typeof flowUi.clearPairingRequest === 'function') {
            flowUi.clearPairingRequest(requestId);
          }
        } catch (_) { /* cleanup is best-effort */ }
      }
      notify('Pairing request timed out.', 'warn');
      return 'expired';
    }

    // ── 2. Signaling health ────────────────────────────────────────────
    // signaling_down never touches transfer state: established data channels
    // and in-flight transfers continue; only the banner shows.

    function onSignalingDown() {
      state.signalingDown = true;
      try {
        if (flowUi && typeof flowUi.showSignalingBanner === 'function') {
          flowUi.showSignalingBanner('reconnecting, transfers continue');
        }
      } catch (_) { /* banner is best-effort */ }
      notify('Signaling lost — reconnecting, transfers continue', 'warn');
      return 'signaling_down';
    }

    function onSignalingUp() {
      state.signalingDown = false;
      try {
        if (flowUi && typeof flowUi.clearSignalingBanner === 'function') {
          flowUi.clearSignalingBanner();
        }
      } catch (_) { /* banner is best-effort */ }
      notify('Signaling reconnected', 'success');
      return 'signaling_up';
    }

    function onReconnectRequired(msg) {
      const peerId = msg.peerId;
      const reason = msg.reason || 'connection failed';
      const name = msg.name || msg.peerName || peerDisplayName(peerId);
      notify(`Device ${name} needs re-pairing (${reason}). Re-pair to reconnect.`, 'warn');
      return 'reconnect_required';
    }

    function onTransferDeclined(msg) {
      const transferId = msg.transferId;
      const peerId = msg.peerId || msg.from;
      notify(`Transfer ${transferId !== undefined ? transferId : ''} declined by ${peerDisplayName(peerId || 'device')}`.trim(), 'info');
      try {
        if (flowUi && typeof flowUi.clearTransfer === 'function' && peerId) flowUi.clearTransfer(peerId);
      } catch (_) { /* cleanup is best-effort */ }
      return 'transfer_declined';
    }

    function handleMessage(msg) {
      if (!msg || typeof msg.type !== 'string') return false;
      switch (msg.type) {
        case 'pairing_request': return onPairingRequest(msg);
        case 'pairing_accepted':
        case 'pairing_accept': return onPairingAccepted(msg);
        case 'pairing_declined':
        case 'pairing_decline': return onPairingDeclined(msg);
        case 'pairing_response':
          if (msg.accept === true || msg.accepted === true || msg.decision === 'accept') {
            return onPairingAccepted(msg);
          }
          return onPairingDeclined(msg);
        case 'pairing_expired': return onPairingExpired(msg);
        case 'signaling_down': return onSignalingDown();
        case 'signaling_up': return onSignalingUp();
        case 'reconnect_required': return onReconnectRequired(msg);
        case 'transfer_declined': return onTransferDeclined(msg);
        default: return false;
      }
    }

    // DataChannel opened after an accepted pairing: both sides derive and
    // show the same confirmation code. Only when the UI implements the
    // confirmation surface.
    function onChannelOpen(peerId) {
      if (!state.accepted.has(peerId)) return Promise.resolve(null);
      if (state.confirm.has(peerId)) return Promise.resolve(state.confirm.get(peerId).words);
      if (!flowUi || typeof flowUi.showConfirmationCode !== 'function') return Promise.resolve(null);
      return beginConfirmation(peerId, localPeerId, peerId).catch(() => null);
    }

    // ── 3. Static-mode fragment restore ────────────────────────────────
    // location.hash #o= (offer) / #a= (answer). The hash is scrubbed via
    // history.replaceState FIRST, then the payload is decoded and routed
    // through the existing manual pairing path. Malformed input errors
    // cleanly and disturbs no state.

    function scrubFragment(locObj, histObj) {
      try {
        const h = histObj || (typeof history !== 'undefined' ? history : null);
        const l = locObj || flowLoc || (typeof location !== 'undefined' ? location : null);
        if (h && typeof h.replaceState === 'function') {
          const base = (l ? (l.pathname || '/') : '/') + (l && l.search ? l.search : '');
          h.replaceState(null, '', base);
          return true;
        }
      } catch (_) { /* scrub is best-effort */ }
      return false;
    }

    async function restoreFragment(locOverride, histOverride) {
      const l = locOverride || flowLoc || (typeof location !== 'undefined' ? location : null);
      const hash = l && typeof l.hash === 'string' ? l.hash : '';
      if (!hash.startsWith('#o=') && !hash.startsWith('#a=')) return { handled: false };
      const kind = hash.startsWith('#o=') ? 'offer' : 'answer';
      const raw = hash.slice(3);
      // Scrub FIRST so the payload can neither be re-opened accidentally
      // nor shared onward — even when decoding fails below.
      scrubFragment(l, histOverride || flowHist);
      if (!codec || typeof codec.decodePayload !== 'function') {
        uiError('That pairing link cannot be opened here.');
        return { handled: true, ok: false, kind, error: 'no-codec' };
      }
      let decoded;
      try {
        decoded = await codec.decodePayload(normalizePairingInput(raw).payload);
      } catch (err) {
        uiError('That pairing link is not valid. Ask for a fresh one.');
        return { handled: true, ok: false, kind, error: err && err.message ? err.message : String(err) };
      }
      // Drive the existing manual pairing path with the decoded payload:
      // an offer yields a response code (shown like a pasted offer);
      // an answer is applied to the pending invite.
      try {
        let result = null;
        if (pm && typeof pm.processManualCode === 'function') {
          result = await pm.processManualCode(decoded);
        } else if (kind === 'offer' && pm && typeof pm.acceptManualOffer === 'function') {
          result = { role: 'offer', responseCode: await pm.acceptManualOffer(decoded) };
        } else if (kind === 'answer' && pm && typeof pm.applyManualAnswer === 'function') {
          await pm.applyManualAnswer(decoded);
          result = { role: 'answer' };
        } else {
          uiError('Manual pairing is not available on this build.');
          return { handled: true, ok: false, kind, error: 'no-manual-path' };
        }
        if (result && result.responseCode && flowUi && typeof flowUi.setManualCode === 'function') {
          flowUi.setManualCode(result.responseCode);
        }
        if (flowUi && typeof flowUi.setPairingStatus === 'function') {
          flowUi.setPairingStatus(kind === 'offer'
            ? 'Invite restored from link. Share the response with the other device.'
            : 'Answer restored from link. Waiting for the direct channel to open...');
        }
        if (flowUi && typeof flowUi.showConfirmationCode === 'function') {
          await beginConfirmation('manual', decoded, (result && result.responseCode) || decoded);
        }
        return { handled: true, ok: true, kind, result };
      } catch (err) {
        uiError(err && err.message ? err.message : 'Could not pair with that link.');
        return { handled: true, ok: false, kind, error: err && err.message ? err.message : String(err) };
      }
    }

    // ── 4. Confirmation code ───────────────────────────────────────────
    // Shown after offer+answer are exchanged (both modes). Pairing completes
    // only after the user confirms on at least one side, or explicitly skips
    // (recorded). An unconfirmed pairing never enables transfer.

    async function beginConfirmation(peerId, payloadA, payloadB) {
      const words = await deriveConfirmationWords(payloadA, payloadB);
      state.confirm.set(peerId, { words, confirmed: false, skipped: false, at: Date.now() });
      if (flowUi && typeof flowUi.showConfirmationCode === 'function') {
        flowUi.showConfirmationCode(words);
      } else {
        notify(`Pairing code: ${words.join(' ')}`, 'info');
      }
      return words;
    }

    function confirmPairing(peerId) {
      const entry = state.confirm.get(peerId);
      if (entry) entry.confirmed = true;
      else state.confirm.set(peerId, { words: [], confirmed: true, skipped: false, at: Date.now() });
      try {
        if (flowUi && typeof flowUi.clearConfirmationCode === 'function') flowUi.clearConfirmationCode();
      } catch (_) { /* cleanup is best-effort */ }
      notify(`Paired with ${peerDisplayName(peerId)} — pairing confirmed`, 'success');
      return true;
    }

    function skipPairing(peerId) {
      const entry = state.confirm.get(peerId);
      if (entry) { entry.skipped = true; }
      else state.confirm.set(peerId, { words: [], confirmed: false, skipped: true, at: Date.now() });
      try {
        if (flowUi && typeof flowUi.clearConfirmationCode === 'function') flowUi.clearConfirmationCode();
      } catch (_) { /* cleanup is best-effort */ }
      notify('Pairing confirmation skipped', 'warn');
      return true;
    }

    function isTransferEnabled(peerId) {
      const entry = state.confirm.get(peerId);
      if (entry) return !!(entry.confirmed || entry.skipped);
      // A pending manual handshake gates transfer until it is confirmed or
      // skipped, whichever device the file would go to.
      const manual = state.confirm.get('manual');
      if (manual && !(manual.confirmed || manual.skipped)) return false;
      return true;
    }

    // ── 5. Transfer trust gates ────────────────────────────────────────
    // confirmSendFor: pairing gate + per-file confirmSend. False means "send
    // nothing, create no state". sendFileWithConfirm adds the actual send.

    async function confirmSendFor(file, peerId, peerNameOverride) {
      if (!isTransferEnabled(peerId)) {
        notify('Confirm the pairing code before sending files.', 'warn');
        return false;
      }
      let ok = true;
      if (flowUi && typeof flowUi.confirmSend === 'function') {
        try {
          ok = await flowUi.confirmSend({
            fileName: file && file.name,
            fileSize: file && file.size,
            peerName: peerNameOverride || peerDisplayName(peerId),
          });
        } catch (_) {
          ok = true; // a broken confirm surface must not block sending
        }
      }
      return !!ok;
    }

    async function sendFileWithConfirm(file, peerId, opts) {
      opts = opts || {};
      const allowed = await confirmSendFor(file, peerId, opts.peerName);
      if (!allowed) return null;
      if (!engine || typeof engine.sendFile !== 'function') return null;
      return engine.sendFile(file, peerId, opts.onProgress);
    }

    // Incoming files wait for confirmIncoming. A decline notifies the sender
    // via { type: 'transfer_declined', transferId } and discards (the file is
    // never surfaced). Confirm-surface errors fail open to legacy behaviour.
    async function handleIncomingWithConfirm(info) {
      const data = info || {};
      const peerId = data.peerId || data.fromPeerId || data.from;
      const transferId = data.transferId;
      let ok = true;
      if (flowUi && typeof flowUi.confirmIncoming === 'function') {
        try {
          ok = await flowUi.confirmIncoming({
            fileName: data.fileName,
            fileSize: data.fileSize,
            fromName: data.fromName || peerDisplayName(peerId),
          });
        } catch (_) {
          ok = true;
        }
      }
      if (!ok) {
        sendTransferDeclined(peerId, transferId);
        return false;
      }
      try {
        if (flowUi && typeof flowUi.showIncoming === 'function') flowUi.showIncoming(data);
      } catch (_) { /* surfacing is best-effort */ }
      return true;
    }

    function sendTransferDeclined(peerId, transferId) {
      const msg = { type: 'transfer_declined', transferId };
      try {
        if (pm && typeof pm.sendJsonToPeer === 'function') return pm.sendJsonToPeer(peerId, msg);
        if (pm && typeof pm.sendToPeer === 'function') {
          return pm.sendToPeer(peerId, JSON.stringify(msg));
        }
        if (engine && typeof engine.sendControl === 'function') return engine.sendControl(peerId, msg);
      } catch (_) { /* decline notice is best-effort */ }
      return false;
    }

    return {
      state,
      requestPair,
      handleMessage,
      restoreFragment,
      scrubFragment,
      beginConfirmation,
      confirmPairing,
      skipPairing,
      isTransferEnabled,
      confirmSendFor,
      sendFileWithConfirm,
      handleIncomingWithConfirm,
      sendTransferDeclined,
      onChannelOpen,
      noteAcceptedPairing(peerId) {
        if (peerId) state.accepted.add(peerId);
      },
    };
  }

  function updateMetrics() {
    const now = Date.now();
    const dt = (now - lastMetricTs) / 1000;
    lastMetricTs = now;
    // Guard against same-tick calls: never divide by zero or a negative dt.
    const elapsed = dt > 0 && Number.isFinite(dt) ? dt : 1;

    const latencies = [];
    for (const [id] of ui.peers) {
      const l = peerManager.getLatency(id);
      if (l) latencies.push(l);
    }
    const avg = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null;

    ui.updateLiveMetrics({
      uploadSpeed: xferBytesOut / elapsed,
      downloadSpeed: xferBytesIn / elapsed,
      peerCount: ui.peers.size,
      avgLatency: avg,
    });

    xferBytesIn = xferBytesOut = 0;

    // Ambient packet animation when peers are connected
    if (netViz && ui.peers.size > 0 && Math.random() < 0.25) {
      const peerIds = Array.from(ui.peers.keys());
      const rp = peerIds[Math.floor(Math.random() * peerIds.length)];
      if (Math.random() < 0.5) netViz.spawnPacket(identity.id, rp, identity.palette[0] + '66');
      else netViz.spawnPacket(rp, identity.id, identity.palette[1] + '66');
    }
  }

  // Boot (guarded so the flow module can load in a DOM-less test sandbox;
  // the browser path is unchanged).
  if (typeof document === 'undefined') {
    // No DOM: tests drive AppFlow via the test seam below.
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Test seam: the same flow wiring runs in the browser (global AppFlow) and
  // in tests/app-flow.test.js (vm sandbox globals). The metrics section above
  // is intentionally not exported.
  try {
    const flowRoot = typeof globalThis !== 'undefined' ? globalThis : window;
    flowRoot.AppFlow = {
      createAppFlow,
      normalizePairingInput,
      deriveConfirmationWords,
      sha256Hex,
      CONFIRM_WORDS,
    };
  } catch (_) { /* seam is best-effort on exotic shims */ }
})();
