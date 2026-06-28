# ⚡ LanShare

**Instant browser-based file transfer. No apps, no accounts, no cloud file storage.**

LanShare is an open-source AirDrop alternative that runs in the browser. It supports both a static HTML mode for GitHub Pages-style hosting and a LAN server mode for automatic device discovery. In both modes, file bytes transfer directly peer-to-peer using WebRTC DataChannels.

---

## Features

- **Zero install** — just open a URL on any device
- **Peer-to-peer** — files never touch the server
- **Static hosting** — deploy `dist/` to GitHub Pages or any static host
- **Auto-discovery option** — run the local signaling server and devices appear automatically
- **Manual pairing option** — use connection codes when no server is available
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

LanShare has two supported run modes:

| Mode | Best for | How peers connect | Command |
|------|----------|-------------------|---------|
| Static HTML | GitHub Pages, static hosting, opening `dist/index.html` | Manual connection codes | `npm run build` |
| LAN Server | Local Wi-Fi sharing with auto-discovery | WebSocket signaling server | `npm start` |

In both modes, the setup channel only exchanges WebRTC connection metadata. File data moves directly between browsers.

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

1. Browsers exchange SDP (Session Description Protocol) offers/answers
2. In LAN server mode, the Node server relays that metadata over WebSocket
3. In static HTML mode, users exchange that metadata as connection codes
3. Once peers exchange connection parameters, WebRTC negotiates a direct path
4. ICE (Interactive Connectivity Establishment) finds the best route — usually direct LAN
5. A DataChannel is opened over DTLS-encrypted SCTP
6. Files stream as 256 KB binary chunks directly between browsers
7. **The server, when used, sees zero file data**

---

## Quick Start

Install dependencies once:

```bash
git clone https://github.com/yourname/lanshare
cd lanshare
npm install
```

### Static HTML Mode

Use this for GitHub Pages, static hosting, or a standalone `dist/index.html` file.

```bash
npm run build
```

Then open:

```text
dist/index.html
```

Or preview it locally at a URL:

```bash
npm run preview
```

Then open:

```text
http://localhost:3000
```

Deploy the generated `dist/` folder to GitHub Pages or any static host. Static mode uses manual pairing codes because a static site has no signaling server for automatic discovery.

Pairing flow:

1. On the first device, click **Create Code** and copy the code.
2. On the second device, paste that code into **Have A Code?** and click **Connect**.
3. The second device will show a new code. Copy it back to the first device.
4. On the first device, paste that new code into **Have A Code?** and click **Connect**.

After pairing, file bytes transfer directly between browsers over WebRTC DataChannels. The codes are only connection setup data.

### LAN Server Mode

Use this when you want automatic discovery on a local Wi-Fi network.

```bash
npm start
```

Then open **http://localhost:3000** on multiple devices on the same Wi-Fi network.

You can also force manual/static mode while using any local static file server:

```bash
python3 -m http.server 3000 -d client
```

Then open **http://localhost:3000?static**.

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
├── scripts/
│   ├── build.js        # Generates the static dist/ app
│   └── serve-dist.js   # Serves dist/ locally for preview
├── shared/
│   └── utils.js        # Shared utilities
├── docs/
│   └── architecture.md # Technical architecture
├── dist/               # Generated static app after npm run build
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
