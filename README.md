# ⚡ LanShare

**Instant browser-based LAN file transfer. No apps, no accounts, no cloud.**

LanShare is an open-source AirDrop alternative that runs entirely in the browser. Devices on the same Wi-Fi network discover each other automatically, and files transfer directly peer-to-peer at full network speed using WebRTC DataChannels.

---

## Features

- **Zero install** — just open a URL on any device
- **Peer-to-peer** — files never touch the server
- **Auto-discovery** — devices appear instantly when they open the page
- **Drag & drop** — drop files onto a device card to send
- **Live progress** — speed, ETA, and progress bars in real time
- **LAN Chat** — group and private messaging with markdown support
- **Shared Whiteboard** — draw collaboratively across devices
- **Network Visualization** — live canvas topology with animated packets
- **Device Radar** — sweeping radar showing nearby devices
- **Speed Test** — measure peer-to-peer throughput
- **Packet Inspector** — developer tool showing live WebRTC events
- **Smart reconnect** — auto-reconnects dropped connections

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   LanShare Architecture                  │
│                                                         │
│  ┌──────────┐   WebSocket   ┌──────────────────────┐   │
│  │ Device A │◄─ signaling ─►│  Node.js Server      │   │
│  └─────┬────┘               │  (signaling only,    │   │
│        │                    │   no file data)       │   │
│  ┌─────▼────┐   WebSocket   └──────────────────────┘   │
│  │ Device B │◄─ signaling ─►         ▲                  │
│  └─────┬────┘                        │                  │
│        │                    ┌────────┘                  │
│  ┌─────▼────┐                                          │
│  │ Device C │                                          │
│  └──────────┘                                          │
│                                                         │
│  Device A ◄══════ WebRTC P2P (direct) ══════► Device B │
│         Files transfer at full LAN speed               │
└─────────────────────────────────────────────────────────┘
```

### How WebRTC Works

1. Each browser connects to the signaling server via WebSocket
2. The server relays SDP (Session Description Protocol) offers/answers between peers
3. Once peers exchange connection parameters, WebRTC negotiates a direct path
4. ICE (Interactive Connectivity Establishment) finds the best route — usually direct LAN
5. A DataChannel is opened over DTLS-encrypted SCTP
6. Files stream as 256 KB binary chunks directly between browsers
7. **The server sees zero file data**

---

## Installation

```bash
# Clone the repo
git clone https://github.com/yourname/lanshare
cd lanshare

# Install dependencies (just the ws package)
npm install

# Start
npm start
```

Then open **http://localhost:3000** on multiple devices on the same Wi-Fi network.

---

## Hosting on Your Local Network

By default the server binds to all interfaces. Find your local IP:

```bash
# macOS / Linux
ifconfig | grep "inet " | grep -v 127.0.0.1

# Windows
ipconfig | findstr "IPv4"
```

Then share `http://192.168.x.x:3000` with other devices on your network.

---

## Project Structure

```
lanshare/
├── client/
│   ├── index.html      # Single-page app shell
│   ├── styles.css      # Dark futuristic theme
│   ├── app.js          # Main orchestration
│   ├── webrtc.js       # PeerManager: signaling + connections
│   ├── transfer.js     # TransferEngine: chunked file streaming
│   ├── network.js      # Canvas network visualization
│   ├── ui.js           # UI state, cards, chat, whiteboard
│   └── identity.js     # Device identity + canvas avatars
├── server/
│   └── server.js       # Minimal WebSocket signaling server
├── shared/
│   └── utils.js        # Shared utilities
├── docs/
│   └── architecture.md # Technical architecture
├── package.json
└── README.md
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | HTTP server port |

---

## Bonus Features

1. **Device Radar** — Sweeping radar animation showing peer positions with blips
2. **Network Packet Visualization** — Animated packets flowing between nodes in real time
3. **Packet Inspector** — Developer panel showing every WebRTC event with timing and sizes

---

## License

MIT — do whatever you want with it.
