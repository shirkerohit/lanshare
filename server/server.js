// server/server.js
// Lightweight WebSocket signaling server for WebRTC peer coordination
// Does NOT handle any file data - pure signaling only

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { networkInterfaces } = require('os');

const PORT = process.env.PORT || 3000;

// Track connected peers, partitioned by LAN scope.
// peerId -> { ws, info, scope }
const peers = new Map(); // peerId -> { ws, info, scope }

// Serve static files from /client
const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

const clientDir = path.join(__dirname, '..', 'client');
const sharedDir = path.join(__dirname, '..', 'shared');

// ---------------------------------------------------------------------------
// Scope derivation (pure): IPv4 -> /24, IPv6 -> /64.
// Malformed input -> null (a scope that grants no peers), never throws.
// NEVER consult client-supplied input for scope; always derive from the
// connection's remote address (see getRemoteAddress).
// ---------------------------------------------------------------------------

function expandIPv6(addr) {
  if (!/^[0-9a-fA-F:]+$/.test(addr)) return null;
  if (addr.includes('::')) {
    if (addr.indexOf('::') !== addr.lastIndexOf('::')) return null;
    const parts = addr.split('::');
    const head = parts[0] ? parts[0].split(':') : [];
    const tail = parts[1] ? parts[1].split(':') : [];
    for (const g of [...head, ...tail]) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    }
    const missing = 8 - (head.length + tail.length);
    if (missing <= 0) return null;
    const full = [...head, ...Array(missing).fill('0'), ...tail];
    if (full.length !== 8) return null;
    return full.map((g) => parseInt(g, 16));
  }
  const groups = addr.split(':');
  if (groups.length !== 8) return null;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
  }
  return groups.map((g) => parseInt(g, 16));
}

function scopeForAddress(ip) {
  try {
    if (typeof ip !== 'string') return null;
    let addr = ip.trim();
    if (addr.length === 0) return null;

    // Strip "[v6]:port" or "[v6]" bracketing if present.
    if (addr.startsWith('[')) {
      const m = addr.match(/^\[([^\]]+)\](?::\d+)?$/);
      if (!m) return null;
      addr = m[1];
    }
    // Strip zone id (fe80::1%eth0).
    const pct = addr.indexOf('%');
    if (pct !== -1) addr = addr.slice(0, pct);
    if (addr.length === 0) return null;

    // IPv4-mapped IPv6 (::ffff:1.2.3.4) -> treat as the embedded IPv4.
    if (addr.includes(':') && addr.includes('.')) {
      const m = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
      if (m && addr.toLowerCase().startsWith('::ffff:')) {
        addr = m[1];
      } else {
        return null;
      }
    }

    // IPv4 -> /24.
    if (!addr.includes(':')) {
      if (!addr.includes('.')) return null;
      const parts = addr.split('.');
      if (parts.length !== 4) return null;
      const nums = [];
      for (const p of parts) {
        if (!/^\d{1,3}$/.test(p)) return null;
        const n = Number(p);
        if (!Number.isInteger(n) || n < 0 || n > 255) return null;
        nums.push(n);
      }
      return `v4:${nums[0]}.${nums[1]}.${nums[2]}.0/24`;
    }

    // IPv6 -> /64 (first 4 hextets, normalised).
    const groups = expandIPv6(addr);
    if (!groups) return null;
    const prefix = groups.slice(0, 4).map((g) => g.toString(16)).join(':');
    return `v6:${prefix}/64`;
  } catch {
    return null;
  }
}

function getRemoteAddress(ws, req) {
  if (req && req.socket && typeof req.socket.remoteAddress === 'string') {
    return req.socket.remoteAddress;
  }
  if (ws) {
    if (ws._socket && typeof ws._socket.remoteAddress === 'string') {
      return ws._socket.remoteAddress;
    }
    if (typeof ws.remoteAddress === 'string') return ws.remoteAddress;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Path confinement (pure): normalise -> resolve -> prefix check with separator.
// Returns the absolute path inside rootDir, or null when the request would
// resolve outside (caller must answer 403 with no path echo).
// ---------------------------------------------------------------------------

function isPathWithinRoot(rootDir, filePath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedFile = path.resolve(filePath);
  return resolvedFile === resolvedRoot || resolvedFile.startsWith(resolvedRoot + path.sep);
}

function resolveWithinRoot(rootDir, requestPath) {
  try {
    const resolvedRoot = path.resolve(rootDir);
    if (typeof requestPath !== 'string' || requestPath.length === 0) return null;
    let decoded;
    try {
      decoded = decodeURIComponent(requestPath);
    } catch {
      return null;
    }
    if (decoded.includes('\0')) return null;
    // Strip leading separators so an absolute request path is treated as
    // root-relative, but PRESERVE ".." segments so the prefix check below can
    // refuse escapes with 403 instead of silently remapping them inside.
    // (Deliberate deviation from scripts/serve-dist.js, which also strips
    // leading "../" segments and therefore maps escapes to 404s inside the
    // root; refusing with 403 is the explicit behaviour required here.)
    const relative = decoded.replace(/^[/\\]+/, '');
    const filePath = path.resolve(resolvedRoot, relative);
    if (filePath === resolvedRoot || filePath.startsWith(resolvedRoot + path.sep)) {
      return filePath;
    }
    return null;
  } catch {
    return null;
  }
}

function serveFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function requestPathname(rawUrl) {
  try {
    const url = new URL(rawUrl, 'http://localhost');
    return url.pathname;
  } catch {
    return String(rawUrl || '/').split('?')[0].split('#')[0] || '/';
  }
}

const httpServer = http.createServer((req, res) => {
  let pathname = requestPathname(req.url);
  if (pathname === '/') pathname = '/index.html';

  // LAN join URLs for the on-screen QR. The page cannot know its own
  // LAN-reachable address when opened as localhost, so the server — which
  // sees its interfaces — advertises it. No peer or transfer data here.
  if (pathname === '/lan.json') {
    const body = JSON.stringify({ urls: getLanUrls(PORT) });
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return;
  }

  // Serve shared utils from /shared (exact path only; no user-controlled tail).
  if (pathname === '/shared/utils.js') {
    const filePath = resolveWithinRoot(sharedDir, '/utils.js');
    if (!filePath) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    serveFile(filePath, res);
    return;
  }

  const filePath = resolveWithinRoot(clientDir, pathname);
  if (!filePath) {
    // Plain refusal: no path echo, so existence of the target is not revealed.
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  serveFile(filePath, res);
});

// ---------------------------------------------------------------------------
// Scoped registry: every presence/relay operation delivers ONLY within the
// sender's scope. Message shapes are unchanged; only the recipient set changes.
// ---------------------------------------------------------------------------

function scopeOfSocket(ws) {
  if (ws && typeof ws._scope === 'string') return ws._scope;
  if (ws && ws._scope === null) return null;
  for (const [, peer] of peers.entries()) {
    if (peer.ws === ws) return peer.scope;
  }
  return undefined;
}

// Testable recipient-set computation: who would receive a message from
// `excludeId` within `scope` (peer_list view).
function peersInScope(scope, excludeId) {
  const out = [];
  if (scope == null) return out;
  for (const [id, peer] of peers.entries()) {
    if (id !== excludeId && peer.scope === scope) {
      out.push({ peerId: id, info: peer.info });
    }
  }
  return out;
}

function safeSend(ws, msg) {
  try {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

function handleRegister(ws, msg, remoteAddressOverride) {
  const { peerId, info } = msg;
  // Validation: refuse malformed registrations without touching state.
  // Missing peerId or info.name -> { type:'register_error', code:'invalid' }.
  if (typeof peerId !== 'string' || peerId.length === 0) {
    safeSend(ws, { type: 'register_error', code: 'invalid' });
    return false;
  }
  if (!info || typeof info.name !== 'string' || info.name.length === 0) {
    safeSend(ws, { type: 'register_error', code: 'invalid' });
    return false;
  }
  if (info.name.length > 256) {
    safeSend(ws, { type: 'register_error', code: 'invalid' });
    return false;
  }
  let infoSize = 0;
  try {
    infoSize = JSON.stringify(info).length;
  } catch {
    safeSend(ws, { type: 'register_error', code: 'invalid' });
    return false;
  }
  if (infoSize > 4096) {
    safeSend(ws, { type: 'register_error', code: 'invalid' });
    return false;
  }

  // Scope is ALWAYS derived from the network address. Any client-supplied
  // scope value (msg.scope, msg.subnet, msg.room, ...) is ignored.
  const remote =
    remoteAddressOverride !== undefined ? remoteAddressOverride : getRemoteAddress(ws);
  const scope = scopeForAddress(remote);

  ws._scope = scope;
  ws._remoteAddress = remote;
  ws._missedPongs = 0;
  peers.set(peerId, { ws, info, scope });
  console.log(`[connect] ${info?.name || peerId} (${peers.size} online)`);

  // Send current peer list to new peer: same scope only.
  const peerList = peersInScope(scope, peerId);

  ws.send(JSON.stringify({
    type: 'peer_list',
    peers: peerList,
  }));

  // Announce new peer to existing peers in the same scope only.
  broadcast(ws, {
    type: 'peer_joined',
    peerId,
    info,
  });
  return true;
}

function handleSignal(ws, msg) {
  const { target, from, signal } = msg;
  if (!target) return;
  const senderScope = scopeOfSocket(ws);
  if (senderScope == null) return;
  const targetEntry = peers.get(target);
  if (!targetEntry) return;
  if (targetEntry.scope !== senderScope) return;
  forwardTo(target, { type: 'signal', from, signal }, ws);
}

function handleChat(ws, msg) {
  const senderScope = scopeOfSocket(ws);
  if (senderScope == null) return;
  // Confidential delivery: private:true + target => single recipient only.
  // NEVER broadcast a private message. On failure deliver to NOBODY and
  // inform the sender; never fall back to broadcast.
  if (msg.private === true) {
    const target = msg.target;
    if (typeof target !== 'string' || target.length === 0) {
      safeSend(ws, { type: 'chat_error', code: 'undeliverable' });
      return;
    }
    const targetEntry = peers.get(target);
    if (!targetEntry || targetEntry.ws.readyState !== 1 || targetEntry.scope !== senderScope) {
      safeSend(ws, { type: 'chat_error', code: 'undeliverable' });
      return;
    }
    safeSend(targetEntry.ws, {
      type: 'chat',
      from: msg.from,
      name: msg.name,
      text: msg.text,
      timestamp: Date.now(),
      private: true,
      target: msg.target,
    });
    return;
  }
  // Broadcast to same-scope peers except the sender (sender shows it locally).
  broadcast(ws, {
    type: 'chat',
    from: msg.from,
    name: msg.name,
    text: msg.text,
    timestamp: Date.now(),
    private: msg.private || false,
    target: msg.target || null,
  });
}

function handleWhiteboard(ws, msg) {
  const senderScope = scopeOfSocket(ws);
  if (senderScope == null) return;
  broadcast(ws, {
    type: 'whiteboard',
    from: msg.from,
    event: msg.event,
  });
}

// ---------------------------------------------------------------------------
// Pairing relay (stateless pure relay — NO server-side request state).
// pairing_expired is CLIENT-side; the server never stores requestIds.
// ---------------------------------------------------------------------------

function handlePairingRequest(ws, msg) {
  const { requestId, to } = msg;
  const senderScope = scopeOfSocket(ws);
  // Unregistered / scopeless sender: cannot prove same-scope, do not leak
  // the cross-scope distinction.
  if (senderScope == null) {
    safeSend(ws, { type: 'pairing_error', requestId, code: 'unavailable' });
    return;
  }
  if (typeof to !== 'string' || to.length === 0) {
    safeSend(ws, { type: 'pairing_error', requestId, code: 'unavailable' });
    return;
  }
  const targetEntry = peers.get(to);
  if (!targetEntry || targetEntry.ws.readyState !== 1) {
    safeSend(ws, { type: 'pairing_error', requestId, code: 'unavailable' });
    return;
  }
  if (targetEntry.scope !== senderScope) {
    safeSend(ws, { type: 'pairing_error', requestId, code: 'cross_scope' });
    return;
  }
  safeSend(targetEntry.ws, {
    type: 'pairing_request',
    requestId: msg.requestId,
    from: msg.from,
    fromName: msg.fromName,
    fromType: msg.fromType,
    to: msg.to,
  });
}

function handlePairingResponse(ws, msg) {
  const senderScope = scopeOfSocket(ws);
  if (senderScope == null) return;
  const { to } = msg;
  if (typeof to !== 'string' || to.length === 0) return;
  const targetEntry = peers.get(to);
  if (!targetEntry || targetEntry.ws.readyState !== 1) return;
  if (targetEntry.scope !== senderScope) return;
  safeSend(targetEntry.ws, {
    type: 'pairing_response',
    requestId: msg.requestId,
    to: msg.to,
    accepted: msg.accepted,
  });
}

// ---------------------------------------------------------------------------
// Heartbeat: server sends { type:'ping' } every HEARTBEAT_INTERVAL_MS.
// A peer missing HEARTBEAT_MAX_MISSED consecutive pongs is removed and its
// scope peers get peer_left. Uses global setInterval so tests can drive it
// with fake timers, or call heartbeatTick() directly.
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_MAX_MISSED = 2;
let heartbeatTimer = null;

function handlePong(ws) {
  if (ws) ws._missedPongs = 0;
}

function heartbeatTick() {
  for (const [peerId, peer] of Array.from(peers.entries())) {
    const missed = peer.ws._missedPongs || 0;
    if (missed >= HEARTBEAT_MAX_MISSED) {
      handleDisconnect(peer.ws, peerId);
    } else {
      const ok = safeSend(peer.ws, { type: 'ping' });
      if (ok) {
        peer.ws._missedPongs = missed + 1;
      } else if (peer.ws.readyState !== 1) {
        // Unsendable counts as a miss so dead sockets are still reaped.
        peer.ws._missedPongs = missed + 1;
      } else {
        peer.ws._missedPongs = missed + 1;
      }
    }
  }
}

function startHeartbeat(intervalMs = HEARTBEAT_INTERVAL_MS) {
  stopHeartbeat();
  heartbeatTimer = setInterval(heartbeatTick, intervalMs);
  // Do not keep the process alive for the heartbeat alone in tests.
  if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') {
    heartbeatTimer.unref();
  }
  return heartbeatTimer;
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function forwardTo(targetId, msg, senderWs) {
  const target = peers.get(targetId);
  if (!target || target.ws.readyState !== 1) return false;
  if (senderWs !== undefined) {
    const senderScope = scopeOfSocket(senderWs);
    if (senderScope == null || target.scope !== senderScope) return false;
  }
  target.ws.send(JSON.stringify(msg));
  return true;
}

function broadcast(senderWs, msg) {
  const senderScope = scopeOfSocket(senderWs);
  if (senderScope == null) return 0;
  const data = JSON.stringify(msg);
  let count = 0;
  for (const [, peer] of peers.entries()) {
    if (peer.ws !== senderWs && peer.scope === senderScope && peer.ws.readyState === 1) {
      peer.ws.send(data);
      count += 1;
    }
  }
  return count;
}

function handleDisconnect(ws, peerId) {
  if (!peerId || !peers.has(peerId)) return false;
  const current = peers.get(peerId);
  // Only the owning socket may remove its registration.
  if (current.ws !== ws) return false;
  const info = current.info;
  const scope = current.scope;
  peers.delete(peerId);
  if (scope != null) {
    broadcast(ws, {
      type: 'peer_left',
      peerId,
      name: info?.name,
    });
  }
  console.log(`[disconnect] ${info?.name || peerId} (${peers.size} online)`);
  return true;
}

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  let peerId = null;
  // Capture the network-derived scope at connection time; registration
  // re-derives it per peer so tests can inject it, but the connection address
  // is always available here for future use.
  ws._connectionAddress = getRemoteAddress(ws, req);
  ws._missedPongs = 0;

  ws.on('message', (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData);
    } catch (e) {
      console.error('Invalid message:', e);
      return;
    }

    switch (msg.type) {
      case 'register':
        if (handleRegister(ws, msg)) {
          peerId = msg.peerId;
        }
        break;

      case 'signal':
        handleSignal(ws, msg);
        break;

      case 'pairing_request':
        handlePairingRequest(ws, msg);
        break;

      case 'pairing_response':
        handlePairingResponse(ws, msg);
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
        break;

      case 'pong':
        handlePong(ws);
        break;

      case 'chat':
        handleChat(ws, msg);
        break;

      case 'whiteboard':
        handleWhiteboard(ws, msg);
        break;

      case 'typing':
        if (scopeOfSocket(ws) != null) {
          broadcast(ws, { type: 'typing', from: msg.from, name: msg.name, isTyping: msg.isTyping });
        }
        break;

      default:
        // Forward unknown messages to target peer if specified (same scope only).
        if (msg.target) {
          forwardTo(msg.target, msg, ws);
        }
    }
  });

  ws.on('close', () => {
    if (peerId) {
      handleDisconnect(ws, peerId);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// ---------------------------------------------------------------------------
// Startup reporting: LAN-reachable URL(s) plus the active mode. Never prints
// an unusable address and never leaks an implicit global.
// ---------------------------------------------------------------------------

function getLocalIp() {
  const interfaces = networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }

  return null;
}

// Legacy spelling kept as an alias (fixed: declared, returns null instead of
// undefined when no interface qualifies).
function gethostIp() {
  return getLocalIp();
}

// Every non-internal IPv4 URL this server is reachable on. The first entry
// feeds the startup banner; the full list feeds /lan.json so the on-screen
// QR never encodes an address that is only valid on this machine.
function getLanUrls(port) {
  const urls = [];
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const url = `http://${iface.address}:${port}`;
        if (!urls.includes(url)) urls.push(url);
      }
    }
  }
  return urls;
}

function formatStartupBanner(port, localIp) {
  const lines = [];
  lines.push('');
  lines.push('  LanShare signaling running');
  lines.push(`  Local:   http://localhost:${port}`);
  if (localIp) {
    lines.push(`  Network: http://${localIp}:${port}`);
  } else {
    lines.push('  Network: unavailable (no non-loopback IPv4 interface found)');
  }
  lines.push('  Mode:    signaling (automatic LAN discovery)');
  lines.push('');
  return lines.join('\n');
}

function printStartupBanner(port) {
  console.log(formatStartupBanner(port, getLocalIp()));
}

function _resetPeersForTests() {
  peers.clear();
  stopHeartbeat();
}

if (require.main === module) {
  const localIp = getLocalIp();
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(formatStartupBanner(PORT, localIp));
  });
  startHeartbeat();
}

module.exports = {
  PORT,
  peers,
  clientDir,
  sharedDir,
  scopeForAddress,
  expandIPv6,
  getRemoteAddress,
  scopeOfSocket,
  peersInScope,
  isPathWithinRoot,
  resolveWithinRoot,
  requestPathname,
  handleRegister,
  handleSignal,
  handleChat,
  handleWhiteboard,
  handlePairingRequest,
  handlePairingResponse,
  handlePong,
  heartbeatTick,
  startHeartbeat,
  stopHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MAX_MISSED,
  handleDisconnect,
  forwardTo,
  broadcast,
  safeSend,
  getLocalIp,
  gethostIp,
  getLanUrls,
  formatStartupBanner,
  printStartupBanner,
  httpServer,
  wss,
  _resetPeersForTests,
};
