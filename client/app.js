// client/app.js
// Main orchestration — wires identity, WebRTC, transfers, and UI together

(function () {
  'use strict';

  let identity, peerManager, transferEngine, ui, netViz;
  let speedTestActive  = false;
  let xferBytesIn = 0, xferBytesOut = 0;
  let lastMetricTs = Date.now();

  function init() {
    identity = Identity.getOrCreateIdentity();

    ui = new UI();
    ui.init(identity);

    peerManager = new PeerManager(identity.id, handleMessage);
    peerManager.setLocalInfo({
      name:    identity.name,
      type:    identity.type,
      palette: identity.palette,
    });
    peerManager.connect();

    transferEngine = new TransferEngine(peerManager);

    transferEngine.onProgress = (data) => {
      if (data.direction === 'in')  xferBytesIn  += data.speed;
      else                          xferBytesOut += data.speed;

      ui.updateTransfer({
        transferId: data.transferId,
        peerId:     data.peerId,
        progress:   data.progress,
        speed:      data.speed,
        eta:        data.eta,
      });
      ui.logPacketEvent('chunk', null, `${Math.round((data.progress||0)*100)}%`);

      if (netViz) {
        const from = data.direction === 'out' ? identity.id : data.peerId;
        const to   = data.direction === 'out' ? data.peerId : identity.id;
        netViz.spawnPacket(from, to, identity.palette[0]);
      }
    };

    transferEngine.onComplete = (data) => {
      ui.showTransferComplete(data);
      if (data.fromPeerId) ui.clearTransfer(data.fromPeerId);
    };

    transferEngine.onIncoming = (data) => ui.showIncoming(data);

    transferEngine.onCancelled = () => ui.showNotification('Transfer cancelled', 'info');

    transferEngine.onLatency = (peerId, rtt) => ui.updatePeerLatency(peerId, rtt);

    transferEngine.onControl = (peerId, msg) => ui.logPacketEvent(msg.type, null, '');

    // ── UI callbacks ──
    ui.onSendFiles = (files, peerId) => files.forEach(f => sendFile(f, peerId));

    ui.onCancelTransfer = (id) => transferEngine.cancelTransfer(id);

    ui.onSendChat = (text, target, isPrivate) => {
      peerManager.sendChatMessage(text, target, isPrivate);
      // Add to own feed immediately (server won't echo back to us)
      ui.addChatMessage({
        fromPeer:  identity.id,
        name:      identity.name,
        text,
        timestamp: Date.now(),
        private:   isPrivate,
      });
    };

    ui.onTyping = (isTyping) => peerManager.sendTypingIndicator(isTyping);

    ui.onSpeedTest = async (peerId) => {
      if (speedTestActive) return;
      speedTestActive = true;
      ui.showSpeedTestRunning(peerId, true);
      ui.showNotification('⚡ Running speed test...', 'info');
      const latency = peerManager.getLatency(peerId) || null;
      const result  = await transferEngine.runSpeedTest(peerId);
      result.latency = latency;
      ui.addSpeedTestResult(peerId, result);
      speedTestActive = false;
    };

    ui.onWhiteboardDraw = (event) => peerManager.sendWhiteboardEvent(event);

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

    console.log(`[LanShare] Ready as ${identity.name} (${identity.id.substr(0, 8)})`);
  }

  function handleMessage(msg) {
    switch (msg.type) {

      case 'peer_joined':
        ui.addPeer(msg.peerId, msg.info);
        netViz?.addNode(msg.peerId, msg.info.name, msg.info.palette || Identity.getPalette(msg.peerId));
        // Existing peers initiate connections to the newcomer
        if (!peerManager.connections.has(msg.peerId)) {
          setTimeout(() => peerManager._initiatePeerConnection(msg.peerId), 100);
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
        ui.logPacketEvent('channel_open', null, msg.peerId.substr(0, 10));
        break;

      case 'channel_closed':
        ui.updatePeerState(msg.peerId, 'connecting');
        break;

      case 'connection_state':
        if (msg.state === 'connected') {
          ui.updatePeerState(msg.peerId, 'connected');
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
          fromPeer:  msg.from,
          name:      msg.name,
          text:      msg.text,
          timestamp: msg.timestamp,
          private:   msg.private,
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
    ui.showNotification(`📤 Sending ${file.name} (${fmtBytes(file.size)})`, 'info');
    ui.logPacketEvent('transfer_start', file.size, file.name);

    await transferEngine.sendFile(file, peerId, (prog) => {
      ui.updateTransfer({
        transferId: prog.transferId,
        peerId,
        progress:   prog.progress,
        speed:      prog.speed,
        eta:        prog.eta,
      });
    });
  }

  function updateMetrics() {
    const now = Date.now();
    const dt  = (now - lastMetricTs) / 1000;
    lastMetricTs = now;

    const latencies = [];
    for (const [id] of ui.peers) {
      const l = peerManager.getLatency(id);
      if (l) latencies.push(l);
    }
    const avg = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null;

    ui.updateLiveMetrics({
      uploadSpeed:   xferBytesOut / dt,
      downloadSpeed: xferBytesIn  / dt,
      peerCount:     ui.peers.size,
      avgLatency:    avg,
    });

    xferBytesIn = xferBytesOut = 0;

    // Ambient packet animation when peers are connected
    if (netViz && ui.peers.size > 0 && Math.random() < 0.25) {
      const peerIds = Array.from(ui.peers.keys());
      const rp = peerIds[Math.floor(Math.random() * peerIds.length)];
      if (Math.random() < 0.5) netViz.spawnPacket(identity.id, rp, identity.palette[0] + '66');
      else                     netViz.spawnPacket(rp, identity.id, identity.palette[1] + '66');
    }
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
