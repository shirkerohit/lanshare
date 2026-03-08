// server/server.js
// Lightweight WebSocket signaling server for WebRTC peer coordination
// Does NOT handle any file data - pure signaling only

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { networkInterfaces } = require('os');

const PORT = process.env.PORT || 3000;

// Track connected peers
const peers = new Map(); // peerId -> { ws, info }

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

const httpServer = http.createServer((req, res) => {
  let urlPath = req.url === '/' ? '/index.html' : req.url;

  // Serve shared utils from /shared
  if (urlPath === '/shared/utils.js') {
    const filePath = path.join(__dirname, '..', 'shared', 'utils.js');
    serveFile(filePath, res);
    return;
  }

  const filePath = path.join(__dirname, '..', 'client', urlPath);
  serveFile(filePath, res);
});

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

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  let peerId = null;

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
        handleRegister(ws, msg);
        peerId = msg.peerId;
        break;

      case 'signal':
        handleSignal(ws, msg);
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', timestamp: msg.timestamp }));
        break;

      case 'chat':
        handleChat(ws, msg);
        break;

      case 'whiteboard':
        handleWhiteboard(ws, msg);
        break;

      case 'typing':
        broadcast(ws, { type: 'typing', from: msg.from, name: msg.name, isTyping: msg.isTyping });
        break;

      default:
        // Forward unknown messages to target peer if specified
        if (msg.target) {
          forwardTo(msg.target, msg);
        }
    }
  });

  ws.on('close', () => {
    if (peerId && peers.has(peerId)) {
      const info = peers.get(peerId);
      peers.delete(peerId);
      broadcast(ws, {
        type: 'peer_left',
        peerId,
        name: info.info?.name,
      });
      console.log(`[disconnect] ${info.info?.name || peerId} (${peers.size} online)`);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

function handleRegister(ws, msg) {
  const { peerId, info } = msg;

  peers.set(peerId, { ws, info });
  console.log(`[connect] ${info?.name || peerId} (${peers.size} online)`);

  // Send current peer list to new peer
  const peerList = [];
  for (const [id, peer] of peers.entries()) {
    if (id !== peerId) {
      peerList.push({ peerId: id, info: peer.info });
    }
  }

  ws.send(JSON.stringify({
    type: 'peer_list',
    peers: peerList,
  }));

  // Announce new peer to all existing peers
  broadcast(ws, {
    type: 'peer_joined',
    peerId,
    info,
  });
}

function handleSignal(ws, msg) {
  const { target, from, signal } = msg;
  forwardTo(target, { type: 'signal', from, signal });
}

function handleChat(ws, msg) {
  // Broadcast to everyone except the sender (sender shows it locally)
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
  broadcast(ws, {
    type: 'whiteboard',
    from: msg.from,
    event: msg.event,
  });
}

function forwardTo(targetId, msg) {
  const target = peers.get(targetId);
  if (target && target.ws.readyState === 1) {
    target.ws.send(JSON.stringify(msg));
  }
}

function broadcast(senderWs, msg) {
  const data = JSON.stringify(msg);
  for (const [, peer] of peers.entries()) {
    if (peer.ws !== senderWs && peer.ws.readyState === 1) {
      peer.ws.send(data);
    }
  }
}

function gethostIp() {
  const interfaces = networkInterfaces();

  for (const name in interfaces) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
}

hostIP = gethostIp()

// httpServer.listen(PORT, () => {
//   console.log(`\n  ⚡ LanShare running at http://${hostIP}:${PORT}`);
//   console.log(`  Open this URL on multiple devices on the same network\n`);
// });

httpServer.listen(PORT, '0.0.0.0');
