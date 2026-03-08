// client/ui.js — UI management, device cards, chat, whiteboard, inspector

class UI {
  constructor() {
    this.peers    = new Map();
    this.transfers = new Map();
    this.activePanel = 'devices';
    this.selectedPeer = null;
    this.typingTimers = new Map();
    this.speedTestHistory = [];
    this.packetCount = 0;
  }

  init(localIdentity) {
    this.local = localIdentity;
    this._renderLocal();
    this._bindTabs();
    this._bindDragDrop();
    this._bindFileInput();
    this._bindChatInput();
    this._bindWhiteboard();
    this._bindInspectorClear();
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
            <div class="card-peer-type">${typeIcon} ${typeLabel}</div>
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

        <div class="card-drop" data-peer="${peerId}">
          <span class="drop-label">Drop files here or click to send</span>
          <div class="xfer-area hidden" data-xfer="${peerId}">
            <div class="xfer-bar-wrap"><div class="xfer-bar-fill"></div></div>
            <div class="xfer-stats">
              <span class="xfer-pct">0%</span>
              <span class="xfer-spd">--</span>
              <span class="xfer-eta">--</span>
              <button class="btn-cancel" data-cancel="${peerId}">✕</button>
            </div>
          </div>
        </div>

        <div class="card-actions">
          <button class="card-btn accent" data-action="send" data-peer="${peerId}">📁 Send File</button>
          <button class="card-btn" data-action="msg" data-peer="${peerId}">💬 Message</button>
          <button class="card-btn" data-action="speed" data-peer="${peerId}">⚡ Speed Test</button>
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
        if (action === 'send') {
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
        el.textContent = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s/60)}m` : `${Math.floor(s/3600)}h`;
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
    const pct  = card.querySelector('.xfer-pct');
    const spd  = card.querySelector('.xfer-spd');
    const eta  = card.querySelector('.xfer-eta');

    const p = Math.round((data.progress || 0) * 100);
    if (fill) fill.style.width = `${p}%`;
    if (pct)  pct.textContent  = `${p}%`;
    if (spd)  spd.textContent  = fmtSpeed(data.speed);
    if (eta)  eta.textContent  = fmtETA(data.eta);
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
    const ts = new Date(msg.timestamp || Date.now()).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
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
    const ts = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
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
          <span class="st-metric-val">${result.latency || '--'}</span>
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
      const size  = parseInt(document.getElementById('wb-size')?.value || 4);
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
    const sizeNum   = document.getElementById('wb-size-num');
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

    const ts = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
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
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });
  }

  switchTab(name) {
    this.activePanel = name;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${name}`));

    // Fix canvas sizes when panels become visible
    if (name === 'whiteboard') {
      requestAnimationFrame(() => this._resizeWhiteboard());
    }
    if (name === 'network' && this._onNetworkTabOpen) {
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
      const files  = Array.from(e.dataTransfer?.files || []);
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
    const send  = document.getElementById('chat-send');
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
    s('metric-up',      fmtSpeed(m.uploadSpeed || 0));
    s('metric-down',    fmtSpeed(m.downloadSpeed || 0));
    s('metric-peers',   m.peerCount || 0);
    s('metric-latency', m.avgLatency ? `${m.avgLatency}ms` : '--');
  }
}

// ── Helpers ──────────────────────────────────────
function fmtBytes(b) {
  if (!b || b === 0) return '0 B';
  const k = 1024, s = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(1) + ' ' + s[i];
}
function fmtSpeed(bps) { return fmtBytes(bps) + '/s'; }
function fmtETA(s) {
  if (!isFinite(s) || s < 0) return '---';
  return s < 60 ? `${Math.round(s)}s` : `${Math.floor(s/60)}m ${Math.round(s%60)}s`;
}
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

window.UI = UI;
window.fmtBytes = fmtBytes;
window.fmtSpeed = fmtSpeed;
window.fmtETA   = fmtETA;
