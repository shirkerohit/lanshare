// client/ui.js — UI management, device cards, chat, whiteboard, inspector

class UI {
  constructor() {
    this.peers = new Map();
    this.transfers = new Map();
    this.activePanel = 'devices';
    this.selectedPeer = null;
    this.typingTimers = new Map();
    this.speedTestHistory = [];
    this.packetCount = 0;
    this.staticMode = false;
    this.theme = 'dark';
    this.pairingExpanded = false;
    this._pairingRaw = null;
    this._pairingRequests = new Map();
    this._pairingPending = new Map();
  }

  init(localIdentity) {
    this.local = localIdentity;
    this._renderLocal();
    this._bindTabs();
    this._bindThemeToggle();
    this._bindDragDrop();
    this._bindFileInput();
    this._bindChatInput();
    this._bindWhiteboard();
    this._bindInspectorClear();
    this._bindManualPairing();
    this._bindPairingPanel();
    this._bindJoinPanel();
    this._restoreManualState();
    this._applyPairingPanelState();
    this.switchTab(this.activePanel);
  }

  _bindThemeToggle() {
    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;

    toggle.addEventListener('click', () => this.toggleTheme());
    this._applyTheme();
  }

  toggleTheme() {
    const nextTheme = this.theme === 'light' ? 'dark' : 'light';
    this.setTheme(nextTheme);
  }

  setTheme(theme) {
    this.theme = theme === 'light' ? 'light' : 'dark';
    document.body.dataset.theme = this.theme;
    document.documentElement.dataset.theme = this.theme;
    localStorage.setItem('lanshare_theme', this.theme);

    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
      const icon = toggle.querySelector('.theme-toggle-icon');
      const label = toggle.querySelector('.theme-toggle-label');
      if (icon) icon.textContent = this.theme === 'light' ? '🌙' : '☀';
      if (label) label.textContent = this.theme === 'light' ? 'Dark' : 'Light';
      toggle.classList.toggle('active', this.theme === 'light');
      toggle.setAttribute('aria-pressed', String(this.theme === 'light'));
    }
  }

  _applyTheme() {
    const stored = localStorage.getItem('lanshare_theme');
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    const theme = stored || (prefersLight ? 'light' : 'dark');
    this.setTheme(theme);
  }

  // ── LOCAL DEVICE ─────────────────────────────
  _renderLocal() {
    const av = document.getElementById('local-avatar');
    if (av) Identity.drawAvatar(av, this.local.id, 52);

    const n = document.getElementById('local-name-display');
    if (n) n.textContent = this.local.name;

    const selfAv = document.getElementById('self-avatar');
    if (selfAv) Identity.drawAvatar(selfAv, this.local.id, 32);

    const selfN = document.getElementById('self-name');
    if (selfN) selfN.textContent = this.local.name;
  }

  setStaticMode(enabled) {
    this.staticMode = enabled;
    const panel = document.getElementById('manual-pairing');
    if (panel) panel.classList.toggle('hidden', !enabled);
    // The Pair button needs a signaling socket, which static mode has not.
    // Gate it on the body so every card — present and future — follows.
    if (document.body) document.body.classList.toggle('static-mode', !!enabled);
    // The join panel is meaningless without a server to join: show it only
    // in server mode. app.js fills it with the page URL on boot.
    document.getElementById('join-panel')?.classList.toggle('hidden', !!enabled);

    const emptyTitle = document.querySelector('#no-peers .empty-title');
    const emptySub = document.querySelector('#no-peers .empty-sub');
    if (enabled) {
      if (emptyTitle) emptyTitle.textContent = 'Pair with another device';
      if (emptySub) emptySub.textContent = 'Create a code or paste one from a device on the same Wi-Fi network';
    }

    if (enabled) {
      this._renderKnownDevices();
      this._applyPairingPanelState();
    }
  }

  setManualCode(value) {
    const el = document.getElementById('manual-code');
    if (el) el.value = value;
    this._saveManualDraft();
  }

  revealRemotePanel() {
    this.pairingExpanded = true;
    this._applyPairingPanelState();
  }

  clearRemoteCode() {
    const el = document.getElementById('manual-remote');
    if (el) el.value = '';
    this._saveManualDraft();
  }

  setPairingStatus(text, isError = false) {
    const el = document.getElementById('manual-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', isError);
  }

  _bindManualPairing() {
    const panel = document.getElementById('manual-pairing');
    if (!panel) return;

    document.getElementById('manual-create-code')?.addEventListener('click', async () => {
      await this.onCreateCode?.();
      const code = document.getElementById('manual-code')?.value?.trim();
      if (!code) return;

      try {
        await navigator.clipboard?.writeText(code).catch(() => {
          const target = document.getElementById('manual-code');
          target?.select();
          document.execCommand('copy');
        });
        this.showCopyIndicator('Code copied to clipboard. Paste it on the other device.');
        this.setPairingStatus('Code created and copied.');
      } catch {
        this.setPairingStatus('Code created, but copying failed.', true);
      }
    });

    document.getElementById('manual-connect-code')?.addEventListener('click', () => {
      const code = document.getElementById('manual-remote')?.value.trim();
      if (!code) {
        this.setPairingStatus('Paste a code first.', true);
        return;
      }
      this.onConnectCode?.(code);
    });

    document.getElementById('manual-toggle')?.addEventListener('click', () => {
      this.pairingExpanded = !this.pairingExpanded;
      this._applyPairingPanelState();
    });

    document.getElementById('manual-close-remote')?.addEventListener('click', () => {
      this.pairingExpanded = false;
      this._applyPairingPanelState();
    });

    document.getElementById('manual-code')?.addEventListener('input', () => this._saveManualDraft());
    const remoteEl = document.getElementById('manual-remote');
    if (remoteEl) {
      remoteEl.addEventListener('input', () => {
        this._saveManualDraft();
        this.hideCopyIndicator();
      });
    }

    document.getElementById('known-devices')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-known-action]');
      if (!btn) return;
      const peerId = btn.dataset.peer;
      if (!peerId) return;

      if (btn.dataset.knownAction === 'forget') {
        this.forgetKnownPeer(peerId);
      } else if (btn.dataset.knownAction === 'reconnect') {
        this.pairingExpanded = true;
        this._applyPairingPanelState();
        if (this.onReconnectPeer) this.onReconnectPeer(peerId);
      }
    });

    panel.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const target = document.getElementById(btn.dataset.copy);
        if (!target?.value) return;
        await navigator.clipboard?.writeText(target.value).catch(() => {
          target.select();
          document.execCommand('copy');
        });
        this.setPairingStatus('Copied.');
      });
    });
  }

  markPeerConnected(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) this.saveKnownPeer(peerId, peer.info);

    if (this.staticMode) {
      this.pairingExpanded = false;
      this.setPairingStatus('Connected. Pairing details are compacted; saved devices stay available.');
      this._applyPairingPanelState();
    }
  }

  saveKnownPeer(peerId, info) {
    const peers = this._getKnownPeers();
    peers[peerId] = {
      id: peerId,
      info,
      lastConnectedAt: Date.now(),
      connectedAt: Date.now(),
    };
    localStorage.setItem('lanshare_known_peers', JSON.stringify(peers));
    this._renderKnownDevices();
  }

  forgetKnownPeer(peerId) {
    const peers = this._getKnownPeers();
    const peer = peers[peerId];
    delete peers[peerId];
    localStorage.setItem('lanshare_known_peers', JSON.stringify(peers));
    this._renderKnownDevices();
    this.showNotification(`${peer?.info?.name || 'Device'} removed`, 'leave');
  }

  _getKnownPeers() {
    try {
      return JSON.parse(localStorage.getItem('lanshare_known_peers') || '{}');
    } catch {
      return {};
    }
  }

  _renderKnownDevices() {
    const root = document.getElementById('known-devices');
    if (!root) return;

    const peers = Object.values(this._getKnownPeers())
      .sort((a, b) => (b.lastConnectedAt || 0) - (a.lastConnectedAt || 0));

    root.classList.toggle('hidden', peers.length === 0);
    if (peers.length === 0) {
      root.innerHTML = '';
      return;
    }

    root.innerHTML = `
      <div class="known-title">Saved devices</div>
      ${peers.map((peer) => `
        <div class="known-row">
          <div>
            <div class="known-name">${esc(peer.info?.name || peer.id)}</div>
            <div class="known-sub">Last connected ${peer.lastConnectedAt ? new Date(peer.lastConnectedAt).toLocaleString() : 'unknown'}</div>
          </div>
          <div class="known-actions">
            <button class="manual-link-btn" data-known-action="reconnect" data-peer="${esc(peer.id)}">Reconnect</button>
            <button class="manual-link-btn danger" data-known-action="forget" data-peer="${esc(peer.id)}">Forget</button>
          </div>
        </div>
      `).join('')}
    `;
  }

  _restoreManualState() {
    const code = localStorage.getItem('lanshare_manual_code') || '';
    const remote = localStorage.getItem('lanshare_manual_remote') || '';
    const expanded = localStorage.getItem('lanshare_pairing_expanded');

    const codeEl = document.getElementById('manual-code');
    const remoteEl = document.getElementById('manual-remote');
    if (codeEl) codeEl.value = code;
    if (remoteEl) remoteEl.value = remote;
    if (expanded !== null) {
      this.pairingExpanded = expanded === 'true';
    }
  }

  _saveManualDraft() {
    const code = document.getElementById('manual-code')?.value || '';
    const remote = document.getElementById('manual-remote')?.value || '';
    localStorage.setItem('lanshare_manual_code', code);
    localStorage.setItem('lanshare_manual_remote', remote);
  }

  showCopyIndicator(text = 'Response code copied to clipboard. please paste/share it with the other device.') {
    const el = document.getElementById('manual-copy-indicator');
    if (!el) {
      this.showNotification(text, 'success');
      return;
    }
    el.textContent = text;
    el.classList.remove('hidden');
    if (this._copyIndicatorTimeout) {
      clearTimeout(this._copyIndicatorTimeout);
    }
    this._copyIndicatorTimeout = setTimeout(() => this.hideCopyIndicator(), 3200);
  }

  hideCopyIndicator() {
    const el = document.getElementById('manual-copy-indicator');
    if (!el) return;
    el.classList.add('hidden');
    if (this._copyIndicatorTimeout) {
      clearTimeout(this._copyIndicatorTimeout);
      this._copyIndicatorTimeout = null;
    }
  }

  _applyPairingPanelState() {
    const panel = document.getElementById('manual-pairing');
    const toggle = document.getElementById('manual-toggle');
    const remotePanel = panel?.querySelector('.manual-remote-panel');
    if (!panel) return;

    panel.classList.toggle('compact', true);
    if (remotePanel) remotePanel.classList.toggle('hidden', !this.pairingExpanded);
    if (toggle) toggle.textContent = this.pairingExpanded ? 'Close' : 'Paste';
    if (!this.pairingExpanded) this.hideCopyIndicator();
    localStorage.setItem('lanshare_pairing_expanded', String(this.pairingExpanded));
  }

  // ── PEERS ─────────────────────────────────────
  addPeer(peerId, info) {
    if (this.peers.has(peerId)) return;
    this.peers.set(peerId, { id: peerId, info, connectedAt: Date.now(), latency: null });
    this._renderCard(peerId);
    this.showNotification(`${info.name} joined the network`, 'join');
    this._updateEmpty();
  }

  removePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const card = document.getElementById(`peer-${peerId}`);
    if (card) {
      card.classList.add('leaving');
      setTimeout(() => card.remove(), 350);
    }
    this.showNotification(`${peer.info.name} left`, 'leave');
    this.peers.delete(peerId);
    this._updateEmpty();
  }

  updatePeerLatency(peerId, rtt) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.latency = rtt;

    const latEl = document.querySelector(`#peer-${peerId} .stat-latency`);
    if (latEl) {
      latEl.textContent = `${rtt}ms`;
      latEl.className = `stat-val stat-latency ${rtt < 15 ? 'good' : rtt < 50 ? 'ok' : 'slow'}`;
    }

    const qualEl = document.querySelector(`#peer-${peerId} .stat-quality`);
    if (qualEl) {
      const q = rtt < 10 ? 'Excellent' : rtt < 30 ? 'Good' : rtt < 80 ? 'Fair' : 'Poor';
      const cls = rtt < 10 ? 'good' : rtt < 30 ? 'ok' : 'slow';
      qualEl.textContent = q;
      qualEl.className = `stat-val stat-quality ${cls}`;
    }
  }

  updatePeerState(peerId, state) {
    const dot = document.querySelector(`#peer-${peerId} .conn-dot`);
    const lbl = document.querySelector(`#peer-${peerId} .conn-label`);
    if (!dot) return;
    dot.className = `conn-dot ${state}`;
    if (lbl) {
      lbl.textContent = state === 'connected' ? 'Connected'
        : state === 'connecting' ? 'Connecting...'
          : 'Offline';
    }
  }

  _renderCard(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const grid = document.getElementById('peers-grid');
    if (!grid) return;

    const palette = Identity.getPalette(peerId);
    const typeLabel = peer.info.type || 'device';
    const typeIcon = { desktop: '🖥', mobile: '📱', tablet: '📟' }[typeLabel] || '💻';

    const card = document.createElement('div');
    card.className = 'peer-card entering';
    card.id = `peer-${peerId}`;
    card.style.setProperty('--teal', palette[0]);
    card.style.setProperty('--teal-glow', palette[0] + '14');
    card.style.setProperty('--teal-dim', palette[0] + '2a');

    card.innerHTML = `
      <div class="card-body">
        <div class="card-top">
          <canvas class="peer-av" width="44" height="44" style="border-radius:50%"></canvas>
          <div class="card-peer-info">
            <div class="card-peer-name">${esc(peer.info.name)}</div>
            <div class="card-peer-type">${typeIcon} ${esc(typeLabel)}</div>
          </div>
          <div class="conn-status">
            <div class="conn-dot connecting"></div>
            <span class="conn-label">Connecting...</span>
          </div>
        </div>

        <div class="card-stats">
          <div class="stat-cell">
            <span class="stat-label">Latency</span>
            <span class="stat-val stat-latency">--</span>
          </div>
          <div class="stat-cell">
            <span class="stat-label">Quality</span>
            <span class="stat-val stat-quality">--</span>
          </div>
          <div class="stat-cell">
            <span class="stat-label">Online</span>
            <span class="stat-val stat-uptime">0s</span>
          </div>
        </div>

        <div class="card-drop" data-peer="${esc(peerId)}">
          <span class="drop-label">Drop files here or click to send</span>
          <div class="xfer-area hidden" data-xfer="${esc(peerId)}">
            <div class="xfer-bar-wrap"><div class="xfer-bar-fill"></div></div>
            <div class="xfer-stats">
              <span class="xfer-pct">0%</span>
              <span class="xfer-spd">--</span>
              <span class="xfer-eta">--</span>
              <button class="btn-cancel" data-cancel="${esc(peerId)}">✕</button>
            </div>
          </div>
        </div>

        <div class="card-actions">
          <button class="card-btn accent" data-action="pair" data-peer="${esc(peerId)}">🤝 Pair</button>
          <button class="card-btn accent" data-action="send" data-peer="${esc(peerId)}">📁 Send File</button>
          <button class="card-btn" data-action="msg" data-peer="${esc(peerId)}">💬 Message</button>
          <button class="card-btn" data-action="speed" data-peer="${esc(peerId)}">⚡ Speed Test</button>
        </div>
      </div>
    `;

    const av = card.querySelector('.peer-av');
    if (av) Identity.drawAvatar(av, peerId, 44);

    grid.appendChild(card);
    requestAnimationFrame(() => setTimeout(() => card.classList.remove('entering'), 30));

    this._bindCardActions(card, peerId);
    this._tickUptime(peerId);
  }

  _bindCardActions(card, peerId) {
    card.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = btn.dataset.action;
        if (action === 'pair') {
          if (this.onRequestPair) this.onRequestPair(peerId);
          else this.showNotification('Pairing is not available in this mode.', 'warn');
        } else if (action === 'send') {
          this.selectedPeer = peerId;
          document.getElementById('file-input')?.click();
        } else if (action === 'msg') {
          this._startPrivateMsg(peerId);
        } else if (action === 'speed') {
          if (this.onSpeedTest) this.onSpeedTest(peerId);
        }
      });
    });

    card.querySelector('[data-peer]')?.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]') || e.target.closest('.btn-cancel')) return;
      this.selectedPeer = peerId;
      document.getElementById('file-input')?.click();
    });

    card.querySelector('.btn-cancel')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = card.dataset.activeXfer;
      if (id && this.onCancelTransfer) this.onCancelTransfer(id);
    });
  }

  _tickUptime(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const tick = () => {
      if (!this.peers.has(peerId)) return;
      const el = document.querySelector(`#peer-${peerId} .stat-uptime`);
      if (el) {
        const s = Math.floor((Date.now() - peer.connectedAt) / 1000);
        el.textContent = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
      }
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1000);
  }

  _updateEmpty() {
    const empty = document.getElementById('no-peers');
    if (!empty) return;
    empty.classList.toggle('hidden', this.peers.size > 0);
  }

  // ── TRANSFERS ─────────────────────────────────
  updateTransfer(data) {
    const card = document.getElementById(`peer-${data.peerId}`);
    if (!card) return;

    card.dataset.activeXfer = data.transferId;

    const dropLabel = card.querySelector('.drop-label');
    const xfer = card.querySelector('.xfer-area');
    if (dropLabel) dropLabel.classList.add('hidden');
    if (xfer) xfer.classList.remove('hidden');

    const fill = card.querySelector('.xfer-bar-fill');
    const pct = card.querySelector('.xfer-pct');
    const spd = card.querySelector('.xfer-spd');
    const eta = card.querySelector('.xfer-eta');

    const p = Math.round((data.progress || 0) * 100);
    if (fill) fill.style.width = `${p}%`;
    if (pct) pct.textContent = `${p}%`;
    if (spd) spd.textContent = fmtSpeed(data.speed);
    if (eta) eta.textContent = fmtETA(data.eta);
  }

  clearTransfer(peerId) {
    const card = document.getElementById(`peer-${peerId}`);
    if (!card) return;
    const dropLabel = card.querySelector('.drop-label');
    const xfer = card.querySelector('.xfer-area');
    if (dropLabel) dropLabel.classList.remove('hidden');
    if (xfer) xfer.classList.add('hidden');
    delete card.dataset.activeXfer;
  }

  showTransferComplete(data) {
    const label = data.direction === 'in' ? '📥 Received' : '📤 Sent';
    this.showNotification(`${label} ${data.fileName} (${fmtBytes(data.fileSize)}) · ${fmtSpeed(data.avgSpeed)}`, 'success');
    if (data.direction === 'in' && data.url) {
      const a = Object.assign(document.createElement('a'), { href: data.url, download: data.fileName, style: 'display:none' });
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(data.url); }, 5000);
    }
    if (data.fromPeerId) this.clearTransfer(data.fromPeerId);
  }

  showIncoming(data) {
    const peer = this.peers.get(data.fromPeerId);
    const sender = peer?.info.name || '?';
    this.showNotification(`📥 Receiving ${data.fileName} from ${sender}`, 'info');
  }

  // ── CHAT ──────────────────────────────────────
  addChatMessage(msg) {
    const feed = document.getElementById('chat-feed');
    if (!feed) return;
    const isOwn = msg.fromPeer === this.local?.id;
    const ts = new Date(msg.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const el = document.createElement('div');
    el.className = `chat-msg${isOwn ? ' own' : ''}${msg.private ? ' private' : ''}`;
    el.innerHTML = `
      <div class="msg-meta">
        <span class="msg-name">${esc(msg.name)}</span>
        <span class="msg-time">${ts}</span>
        ${msg.private ? '<span class="msg-private-tag">🔒 private</span>' : ''}
      </div>
      <div class="msg-body">${this._md(esc(msg.text))}</div>
    `;
    feed.appendChild(el);
    feed.scrollTop = feed.scrollHeight;
  }

  showTyping(name, isTyping) {
    const el = document.getElementById('typing-indicator');
    if (!el) return;
    if (this.typingTimers.has(name)) clearTimeout(this.typingTimers.get(name));
    if (isTyping) {
      el.textContent = `${name} is typing...`;
      el.classList.remove('hidden');
      this.typingTimers.set(name, setTimeout(() => el.classList.add('hidden'), 3000));
    } else {
      el.classList.add('hidden');
    }
  }

  _startPrivateMsg(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const input = document.getElementById('chat-input');
    if (!input) return;
    input.dataset.privateTarget = peerId;
    input.placeholder = `Private to ${peer.info.name}... (Esc to cancel)`;
    input.focus();
    this.switchTab('chat');
    this.showNotification(`💬 Private message to ${peer.info.name}`, 'info');
  }

  _md(text) {
    return text
      .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }

  // ── SPEED TEST ────────────────────────────────
  showSpeedTestRunning(peerId, running) {
    const el = document.getElementById('speedtest-running');
    if (el) el.classList.toggle('hidden', !running);
  }

  addSpeedTestResult(peerId, result) {
    this.speedTestHistory.unshift({ peerId, result, timestamp: Date.now() });

    const empty = document.getElementById('speedtest-empty');
    if (empty) empty.classList.add('hidden');

    const history = document.getElementById('speedtest-history');
    if (!history) return;

    const peer = this.peers.get(peerId);
    const name = peer?.info.name || peerId;
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const mbps = result.mbps.toFixed(1);

    const card = document.createElement('div');
    card.className = 'st-result-card';
    card.innerHTML = `
      <div class="st-result-header">
        <span class="st-result-target">⚡ ${esc(name)}</span>
        <span class="st-result-time">${ts}</span>
      </div>
      <div class="st-result-metrics">
        <div class="st-metric">
          <span class="st-metric-val highlight">${mbps}</span>
          <span class="st-metric-label">Mbps</span>
        </div>
        <div class="st-metric">
          <span class="st-metric-val">${esc(result.latency || '--')}</span>
          <span class="st-metric-label">ms Latency</span>
        </div>
        <div class="st-metric">
          <span class="st-metric-val">${result.duration.toFixed(1)}</span>
          <span class="st-metric-label">Duration (s)</span>
        </div>
        <div class="st-metric">
          <span class="st-metric-val">${fmtBytes(result.bytesSent)}</span>
          <span class="st-metric-label">Transferred</span>
        </div>
      </div>
    `;
    history.insertBefore(card, history.firstChild);

    this.showSpeedTestRunning(peerId, false);
    this.switchTab('speedtest');
  }

  // ── WHITEBOARD ────────────────────────────────
  _bindWhiteboard() {
    const canvas = document.getElementById('whiteboard');
    if (!canvas) return;

    // We'll properly size it when the panel becomes visible
    this._wbCtx = canvas.getContext('2d');
    this._wbCtx.lineCap = 'round';
    this._wbCtx.lineJoin = 'round';

    let drawing = false, lx = 0, ly = 0;

    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return { x: p.clientX - r.left, y: p.clientY - r.top };
    };

    const start = (e) => {
      drawing = true;
      const p = pos(e);
      lx = p.x; ly = p.y;
      e.preventDefault();
    };

    const move = (e) => {
      if (!drawing) return;
      e.preventDefault();
      const p = pos(e);
      const color = document.getElementById('wb-color')?.value || '#00ffcc';
      const size = parseInt(document.getElementById('wb-size')?.value || 4);
      this._wbStroke(lx, ly, p.x, p.y, color, size);
      if (this.onWhiteboardDraw) this.onWhiteboardDraw({ x1: lx, y1: ly, x2: p.x, y2: p.y, color, size });
      lx = p.x; ly = p.y;
    };

    const stop = () => { drawing = false; };

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', stop);
    canvas.addEventListener('mouseleave', stop);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', stop);

    document.getElementById('wb-clear')?.addEventListener('click', () => {
      const ctx = this._wbCtx;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (this.onWhiteboardDraw) this.onWhiteboardDraw({ clear: true });
    });

    const sizeInput = document.getElementById('wb-size');
    const sizeNum = document.getElementById('wb-size-num');
    sizeInput?.addEventListener('input', () => {
      if (sizeNum) sizeNum.textContent = `${sizeInput.value}px`;
    });
  }

  _wbStroke(x1, y1, x2, y2, color, size) {
    const ctx = this._wbCtx;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.stroke();
  }

  _resizeWhiteboard() {
    const canvas = document.getElementById('whiteboard');
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w === 0 || h === 0) return;
    // Save and restore drawing across resize
    if (canvas.width !== w || canvas.height !== h) {
      const snap = canvas.toDataURL();
      canvas.width = w;
      canvas.height = h;
      if (snap && snap !== 'data:,') {
        const img = new Image();
        img.onload = () => this._wbCtx?.drawImage(img, 0, 0);
        img.src = snap;
      }
      if (this._wbCtx) {
        this._wbCtx.lineCap = 'round';
        this._wbCtx.lineJoin = 'round';
      }
    }
  }

  drawRemoteStroke(event) {
    if (!this._wbCtx) return;
    if (event.clear) {
      const canvas = document.getElementById('whiteboard');
      if (canvas) this._wbCtx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    this._wbStroke(event.x1, event.y1, event.x2, event.y2, event.color || '#ff6600', event.size || 4);
  }

  // ── INSPECTOR ─────────────────────────────────
  logPacketEvent(type, size, info) {
    this.packetCount++;
    const list = document.getElementById('packet-log');
    if (!list) return;

    // Insert header row if empty
    if (list.children.length === 0) {
      const hdr = document.createElement('div');
      hdr.className = 'pk-header';
      hdr.innerHTML = '<span>Time</span><span>Type</span><span>Size</span><span>Detail</span>';
      list.appendChild(hdr);
    }

    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const row = document.createElement('div');
    row.className = 'pk-entry';
    row.innerHTML = `
      <span class="pk-time">${ts}</span>
      <span class="pk-type">${esc(type)}</span>
      <span class="pk-size">${size ? fmtBytes(size) : '--'}</span>
      <span class="pk-info">${esc(String(info || ''))}</span>
    `;
    list.appendChild(row);
    // Cap at 200
    while (list.children.length > 201) list.removeChild(list.children[1]);
    list.scrollTop = list.scrollHeight;
  }

  _bindInspectorClear() {
    document.getElementById('inspector-clear')?.addEventListener('click', () => {
      const list = document.getElementById('packet-log');
      if (list) list.innerHTML = '';
      this.packetCount = 0;
    });
  }

  // ── NOTIFICATIONS ─────────────────────────────
  showNotification(text, type = 'info') {
    const container = document.getElementById('notifications');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `notification ${type}`;
    el.textContent = text;
    container.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 300);
    }, 4000);
  }

  // ── TABS ──────────────────────────────────────
  _bindTabs() {
    const nav = document.getElementById('tab-nav');
    if (!nav) return;
    nav.querySelectorAll('.tab-btn').forEach(btn => {
      btn.type = 'button';
    });
    nav.addEventListener('click', (event) => {
      const btn = event.target.closest('.tab-btn');
      if (!btn || !nav.contains(btn)) return;
      event.preventDefault();
      const tab = btn.dataset.tab || btn.getAttribute('data-tab');
      if (!tab) return;
      this.switchTab(tab);
    });
  }

  switchTab(name) {
    const tabName = String(name || '').trim() || 'devices';
    const panel = document.getElementById(`panel-${tabName}`);
    if (!panel) return;

    this.activePanel = tabName;
    document.querySelectorAll('.tab-btn').forEach((b) => {
      const isActive = (b.dataset.tab || b.getAttribute('data-tab')) === tabName;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });

    document.querySelectorAll('.panel').forEach((p) => {
      const isActive = p.id === `panel-${tabName}`;
      p.classList.toggle('active', isActive);
      p.style.display = isActive ? 'flex' : 'none';
    });

    // Fix canvas sizes when panels become visible
    if (tabName === 'whiteboard') {
      requestAnimationFrame(() => this._resizeWhiteboard());
    }
    if (tabName === 'network' && this._onNetworkTabOpen) {
      requestAnimationFrame(() => this._onNetworkTabOpen());
    }
  }

  // ── DRAG & DROP ───────────────────────────────
  _bindDragDrop() {
    const root = document.getElementById('app');
    if (!root) return;
    root.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.target.closest('[data-peer]')?.classList.add('over');
    });
    root.addEventListener('dragleave', (e) => {
      e.target.closest('[data-peer]')?.classList.remove('over');
    });
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      const target = e.target.closest('[data-peer]');
      if (!target) return;
      target.classList.remove('over');
      const peerId = target.dataset.peer;
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length && this.onSendFiles) this.onSendFiles(files, peerId);
    });
  }

  // ── FILE INPUT ────────────────────────────────
  _bindFileInput() {
    const inp = document.getElementById('file-input');
    if (!inp) return;
    inp.addEventListener('change', () => {
      const files = Array.from(inp.files);
      if (files.length && this.selectedPeer && this.onSendFiles) {
        this.onSendFiles(files, this.selectedPeer);
      }
      inp.value = '';
    });
  }

  // ── CHAT INPUT ────────────────────────────────
  _bindChatInput() {
    const input = document.getElementById('chat-input');
    const send = document.getElementById('chat-send');
    if (!input || !send) return;

    let typingTimer = null;
    input.addEventListener('input', () => {
      if (this.onTyping) this.onTyping(true);
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => this.onTyping?.(false), 2000);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        delete input.dataset.privateTarget;
        input.placeholder = 'Message everyone...';
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._sendChat();
      }
    });

    send.addEventListener('click', () => this._sendChat());
  }

  _sendChat() {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const target = input.dataset.privateTarget || null;
    if (this.onSendChat) this.onSendChat(text, target, !!target);
    input.value = '';
  }

  // ── LIVE METRICS ──────────────────────────────
  updateLiveMetrics(m) {
    const s = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    s('metric-up', fmtSpeed(m.uploadSpeed || 0));
    s('metric-down', fmtSpeed(m.downloadSpeed || 0));
    s('metric-peers', m.peerCount || 0);
    s('metric-latency', m.avgLatency ? `${m.avgLatency}ms` : '--');
  }

  // ── JOIN PANEL (server mode: scan to open this page) ──
  // A QR encoding this page's own URL. A phone camera opens it, the phone
  // joins the same server, and the device appears in the list. No pairing
  // payload involved — the server does the introduction.
  _bindJoinPanel() {
    document.getElementById('join-copy')?.addEventListener('click', async () => {
      const linkEl = document.getElementById('join-link');
      const url = (linkEl && linkEl.textContent) || '';
      if (!url || url === '--') return;
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url);
        else {
          const ta = document.createElement('textarea');
          ta.value = url;
          document.body?.appendChild(ta);
          ta.select?.();
          document.execCommand('copy');
          ta.remove?.();
        }
        this.showNotification('Join link copied.', 'success');
      } catch {
        this.showNotification('Copy failed — select the link manually.', 'warn');
      }
    });
  }

  showJoinPanel(url) {
    const panel = document.getElementById('join-panel');
    const canvas = document.getElementById('join-qr');
    const linkEl = document.getElementById('join-link');
    if (!panel || !url) return false;
    panel.classList.remove('hidden');
    if (linkEl) {
      if (typeof linkEl.setAttribute === 'function') linkEl.setAttribute('href', url);
      linkEl.textContent = url;
    }
    // A join URL is ~30 chars: a tiny code, always legible. Failure here
    // hides the canvas but keeps the link + copy button working.
    let drawn = false;
    try {
      const api = this._qrApi();
      if (api && canvas && typeof api.encode === 'function' && typeof api.renderToCanvas === 'function') {
        drawn = api.renderToCanvas(canvas, api.encode(url)) === true;
      }
    } catch (_) {
      drawn = false;
    }
    if (canvas) canvas.classList.toggle('hidden', !drawn);
    return true;
  }

  hideJoinPanel() {
    document.getElementById('join-panel')?.classList.add('hidden');
  }

  // ── PAIRING PANEL (one payload, four renderings) ──
  // All four forms (QR, link, copy value, grouped text) derive from a single
  // raw payload string. Callbacks wired here for app.js to supply:
  //   onPairingSubmit({kind, role, payload}) — paste/enter in the pairing input
  //   onConfirmPairing() / onSkipPairing() — confirmation-code dialog buttons
  _qrApi() {
    try {
      if (typeof window !== 'undefined' && window && window.LanQR) return window.LanQR;
    } catch (_) { /* no window — fall through */ }
    try {
      if (typeof LanQR !== 'undefined' && LanQR) return LanQR;
    } catch (_) { /* LanQR not loaded — fall through */ }
    return null;
  }

  _groupPairingCode(raw) {
    const groups = String(raw).match(/.{1,4}/g) || [];
    return groups;
  }

  // Normalise pasted/typed input to a payload. Accepts a raw base64url
  // payload or a full pairing link (fragment #o= offer / #a= answer).
  // Returns {kind:'raw'|'link', role, payload}. Throws on invalid input and
  // creates no state — the caller reports the error via reportPairingError.
  acceptEitherForm(input) {
    const compact = String(input === null || input === undefined ? '' : input).replace(/\s+/g, '');
    if (!compact) throw new Error('Paste a pairing code or link first.');
    const frag = compact.match(/#([oOaA])=([^#]*)/);
    if (frag) {
      const payload = frag[2];
      if (payload && /^[A-Za-z0-9\-_]+$/.test(payload)) {
        return {
          kind: 'link',
          role: frag[1].toLowerCase() === 'a' ? 'answer' : 'offer',
          payload,
        };
      }
      throw new Error('That link does not contain a valid pairing code.');
    }
    if (/^[A-Za-z0-9\-_]+$/.test(compact)) {
      return { kind: 'raw', role: null, payload: compact };
    }
    throw new Error('That is not a valid pairing code. Paste the code or link from the other device.');
  }

  focusPairingInput() {
    const el = document.getElementById('pairing-input');
    if (el && typeof el.focus === 'function') el.focus();
  }

  reportPairingError(msg) {
    const el = document.getElementById('pairing-error');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  clearPairingError() {
    const el = document.getElementById('pairing-error');
    if (!el) return;
    el.textContent = '';
    el.classList.add('hidden');
  }

  // Render the four forms from ONE payload string. The QR is never allowed
  // to disagree: it encodes `raw`, and when it cannot (QR_TOO_LARGE, or no
  // canvas to draw on) the panel still shows link + copy + grouped text.
  showPairingPanel(payload) {
    const raw = payload && payload.raw;
    if (typeof raw !== 'string' || !/^[A-Za-z0-9\-_]+$/.test(raw)) {
      this.reportPairingError('Could not show the pairing code.');
      return false;
    }
    this._pairingRaw = raw;
    this.clearPairingError();

    const panel = document.getElementById('pairing-panel');
    if (panel) panel.classList.remove('hidden');

    const href = (payload && payload.link) || ('#o=' + raw);
    const linkEl = document.getElementById('pairing-link');
    if (linkEl) {
      if (typeof linkEl.setAttribute === 'function') linkEl.setAttribute('href', href);
      linkEl.textContent = href;
    }

    const groupedEl = document.getElementById('pairing-grouped');
    if (groupedEl) {
      groupedEl.innerHTML = this._groupPairingCode(raw)
        .map((g) => `<span class="pair-group">${esc(g)}</span>`)
        .join('<span class="pair-sep" aria-hidden="true"></span>');
    }

    // QR last: failure here must never take down the other three forms.
    const canvas = document.getElementById('pairing-qr');
    const fallback = document.getElementById('pairing-qr-fallback');
    let code = payload && payload.qr ? payload.qr : null;
    if (!code) {
      const api = this._qrApi();
      if (api) {
        try {
          code = api.encode(raw);
        } catch (err) {
          code = null;
          if (!err || err.code !== 'QR_TOO_LARGE') {
            this.reportPairingError('Could not render the QR code — use the link or copy below.');
          }
        }
      }
    }
    let drawn = false;
    if (code) {
      const api = this._qrApi();
      if (api && typeof api.renderToCanvas === 'function') {
        try {
          drawn = api.renderToCanvas(canvas, code) === true;
        } catch (_) {
          drawn = false;
        }
      }
    }
    if (canvas) canvas.classList.toggle('hidden', !drawn);
    if (fallback) fallback.classList.toggle('hidden', drawn);

    this.focusPairingInput();
    return true;
  }

  async copyPairingCode() {
    const raw = this._pairingRaw;
    if (!raw) return false;
    let ok = false;
    try {
      const nav = (typeof navigator !== 'undefined') ? navigator : null;
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        await nav.clipboard.writeText(raw);
        ok = true;
      } else {
        const ta = document.createElement('textarea');
        ta.value = raw;
        if (document.body && typeof document.body.appendChild === 'function') {
          document.body.appendChild(ta);
          if (typeof ta.select === 'function') ta.select();
          if (typeof document.execCommand === 'function') document.execCommand('copy');
          if (typeof ta.remove === 'function') ta.remove();
          ok = true;
        }
      }
    } catch (_) {
      ok = false;
    }
    const btn = document.getElementById('pairing-copy');
    if (ok) {
      if (btn) {
        const prev = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = prev; }, 1600);
      }
      this.showNotification('Pairing code copied.', 'success');
    } else {
      this.reportPairingError('Copy failed — select the grouped code manually.');
    }
    return ok;
  }

  _submitPairingInput(value) {
    let parsed;
    try {
      parsed = this.acceptEitherForm(value);
    } catch (err) {
      this.reportPairingError(err && err.message ? err.message : 'That is not a valid pairing code.');
      return;
    }
    this.clearPairingError();
    if (this.onPairingSubmit) this.onPairingSubmit(parsed);
    else if (this.onConnectCode) this.onConnectCode(parsed.payload);
  }

  _bindPairingPanel() {
    document.getElementById('pairing-copy')?.addEventListener('click', () => this.copyPairingCode());

    const input = document.getElementById('pairing-input');
    if (input) {
      // Paste auto-submits: no separate button press needed.
      input.addEventListener('paste', (e) => {
        let text = '';
        try {
          text = (e.clipboardData && e.clipboardData.getData('text'))
            || (window.clipboardData && window.clipboardData.getData('Text'))
            || '';
        } catch (_) { text = ''; }
        if (!text && typeof input.value === 'string') text = input.value;
        // Let the pasted text land first, then submit it.
        setTimeout(() => this._submitPairingInput(text || input.value), 0);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._submitPairingInput(input.value);
        }
      });
      input.addEventListener('input', () => this.clearPairingError());
    }

    document.getElementById('confirmation-accept')?.addEventListener('click', () => {
      if (this.onConfirmPairing) this.onConfirmPairing();
    });
    document.getElementById('confirmation-skip')?.addEventListener('click', () => {
      if (this.onSkipPairing) this.onSkipPairing();
    });
  }

  // ── PAIRING REQUESTS (incoming) & PENDING (outgoing) ──
  showPairingRequest({ requestId, peerId, info, onAccept, onDecline }) {
    if (!requestId) return;
    this.clearPairingRequest(requestId);
    const host = document.getElementById('pairing-requests');
    if (!host) return;
    const name = (info && info.name) || peerId || 'Unknown device';
    const el = document.createElement('div');
    el.className = 'pairing-request';
    el.innerHTML =
      `<div class="pairing-request-text"><strong>${esc(name)}</strong> wants to pair.</div>` +
      `<div class="pairing-request-actions">` +
      `<button type="button" class="manual-btn" data-act="accept">Accept</button>` +
      `<button type="button" class="manual-link-btn" data-act="decline">Decline</button>` +
      `</div>`;
    const acceptBtn = el.querySelector('[data-act="accept"]');
    const declineBtn = el.querySelector('[data-act="decline"]');
    if (acceptBtn && typeof acceptBtn.addEventListener === 'function') {
      acceptBtn.addEventListener('click', () => { if (onAccept) onAccept(); });
    }
    if (declineBtn && typeof declineBtn.addEventListener === 'function') {
      declineBtn.addEventListener('click', () => { if (onDecline) onDecline(); });
    }
    host.appendChild(el);
    this._pairingRequests.set(requestId, { peerId, el, onAccept, onDecline });
  }

  clearPairingRequest(requestId) {
    if (!requestId) return;
    const entry = this._pairingRequests.get(requestId);
    this._pairingRequests.delete(requestId);
    if (entry && entry.el) {
      if (typeof entry.el.remove === 'function') entry.el.remove();
      else if (entry.el.parentNode && typeof entry.el.parentNode.removeChild === 'function') {
        entry.el.parentNode.removeChild(entry.el);
      }
    }
  }

  showPairingPending(requestId, peerId) {
    if (!requestId) return;
    this.clearPairingPending(requestId);
    const host = document.getElementById('pairing-pending');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'pairing-pending';
    el.innerHTML =
      `<div class="pairing-pending-spinner" aria-hidden="true"></div>` +
      `<div class="pairing-pending-text">Waiting for <strong>${esc(peerId || 'device')}</strong>…</div>`;
    host.appendChild(el);
    this._pairingPending.set(requestId, { peerId, el });
  }

  clearPairingPending(requestId) {
    if (!requestId) return;
    const entry = this._pairingPending.get(requestId);
    this._pairingPending.delete(requestId);
    if (entry && entry.el) {
      if (typeof entry.el.remove === 'function') entry.el.remove();
      else if (entry.el.parentNode && typeof entry.el.parentNode.removeChild === 'function') {
        entry.el.parentNode.removeChild(entry.el);
      }
    }
  }

  // ── PAIRING CONFIRMATION CODE ──
  // Both devices display the same short code; the dialog buttons call the
  // callbacks app.js supplies (onConfirmPairing / onSkipPairing).
  showConfirmationCode(words) {
    const overlay = document.getElementById('confirmation-overlay');
    const box = document.getElementById('confirmation-words');
    if (!overlay || !box) return false;
    if (!Array.isArray(words) || words.length !== 4 || words.some((w) => typeof w !== 'string' || !w)) {
      return false;
    }
    box.innerHTML = words.map((w) => `<span class="confirm-word">${esc(w)}</span>`).join('');
    overlay.classList.remove('hidden');
    return true;
  }

  clearConfirmationCode() {
    const overlay = document.getElementById('confirmation-overlay');
    const box = document.getElementById('confirmation-words');
    if (box) box.innerHTML = '';
    if (overlay) overlay.classList.add('hidden');
  }

  // ── TRANSFER CONFIRMATIONS (Promise-based, blocking) ──
  // Each call builds a FRESH dialog: only the buttons created by this call
  // can settle its promise, so no pre-existing gesture can satisfy it.
  _askTransferConfirm({ title, summary, confirmLabel }) {
    const root = document.getElementById('transfer-confirm-root') || document.body;
    const overlay = document.createElement('div');
    overlay.className = 'transfer-confirm-overlay';
    overlay.innerHTML =
      `<div class="transfer-confirm-dialog" role="dialog" aria-modal="true">` +
      `<div class="transfer-confirm-title">${esc(title)}</div>` +
      `<div class="transfer-confirm-summary">${summary}</div>` +
      `<div class="transfer-confirm-actions">` +
      `<button type="button" class="manual-btn" data-act="confirm">${esc(confirmLabel)}</button>` +
      `<button type="button" class="manual-link-btn" data-act="cancel">Cancel</button>` +
      `</div></div>`;
    return new Promise((resolve) => {
      const done = (value) => {
        if (typeof overlay.remove === 'function') overlay.remove();
        else if (overlay.parentNode && typeof overlay.parentNode.removeChild === 'function') {
          overlay.parentNode.removeChild(overlay);
        }
        resolve(value);
      };
      const okBtn = overlay.querySelector('[data-act="confirm"]');
      const noBtn = overlay.querySelector('[data-act="cancel"]');
      if (okBtn && typeof okBtn.addEventListener === 'function') {
        okBtn.addEventListener('click', () => done(true));
      }
      if (noBtn && typeof noBtn.addEventListener === 'function') {
        noBtn.addEventListener('click', () => done(false));
      }
      if (root && typeof root.appendChild === 'function') root.appendChild(overlay);
      else done(false);
    });
  }

  confirmSend({ fileName, fileSize, peerName }) {
    const summary =
      `<span class="transfer-confirm-file">${esc(fileName)}</span>` +
      ` <span class="transfer-confirm-size">(${esc(fmtBytes(fileSize))})</span>` +
      ` to <span class="transfer-confirm-peer">${esc(peerName)}</span>?`;
    return this._askTransferConfirm({ title: 'Send this file?', summary, confirmLabel: 'Send' });
  }

  confirmIncoming({ fileName, fileSize, fromName }) {
    const summary =
      `<span class="transfer-confirm-file">${esc(fileName)}</span>` +
      ` <span class="transfer-confirm-size">(${esc(fmtBytes(fileSize))})</span>` +
      ` from <span class="transfer-confirm-peer">${esc(fromName)}</span>?`;
    return this._askTransferConfirm({ title: 'Accept this file?', summary, confirmLabel: 'Accept' });
  }

  // ── SIGNALING BANNER / RECONNECT NOTICE ──
  showSignalingBanner() {
    const el = document.getElementById('signaling-banner');
    if (!el) return;
    el.textContent = 'Connection to the signaling server lost. Retrying…';
    el.classList.remove('hidden');
  }

  clearSignalingBanner() {
    const el = document.getElementById('signaling-banner');
    if (!el) return;
    el.textContent = '';
    el.classList.add('hidden');
  }

  showReconnectNotice(peerName) {
    const el = document.getElementById('signaling-banner');
    if (!el) return;
    el.textContent = `Connection to ${peerName} needs re-pairing. Create a new pairing code.`;
    el.classList.remove('hidden');
  }
}

// ── Helpers ──────────────────────────────────────
function fmtBytes(b) {
  if (!b || b === 0) return '0 B';
  const k = 1024, s = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(1) + ' ' + s[i];
}
function fmtSpeed(bps) { return fmtBytes(bps) + '/s'; }
function fmtETA(s) {
  if (!isFinite(s) || s < 0) return '---';
  return s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

window.UI = UI;
window.fmtBytes = fmtBytes;
window.fmtSpeed = fmtSpeed;
window.fmtETA = fmtETA;
