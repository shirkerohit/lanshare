# LanShare Architecture

## Overview

LanShare uses a hub-and-spoke signaling model with direct peer-to-peer data transfer.

```
Device A ──── WebSocket ────▶ Server (Signaling Only)
                                      │
Device B ──── WebSocket ────▶ ────────┘

Device A ◀═══════ WebRTC DataChannel ═══════▶ Device B
                  (Direct P2P, no server)
```

## Components

### Server (`server/server.js`)
- Minimal Node.js HTTP + WebSocket server
- Tracks peer registry (id → ws connection)
- Routes SDP offers/answers and ICE candidates
- Broadcasts peer join/leave events
- **Zero file data** passes through server

### Client Modules

| File | Responsibility |
|------|---------------|
| `identity.js` | Persistent device ID, name generation, canvas avatars |
| `webrtc.js` | PeerManager: WebSocket signaling, RTCPeerConnection lifecycle |
| `transfer.js` | TransferEngine: chunked streaming, progress tracking, speed test |
| `network.js` | NetworkVisualizer: canvas node graph with animated packets |
| `ui.js` | UI class: device cards, chat, whiteboard, notifications |
| `app.js` | Orchestration: wires all modules together |

## Connection Flow

```
1. Device opens page
2. PeerManager connects via WebSocket
3. Server sends existing peer list
4. For each existing peer: initiate RTCPeerConnection + DataChannel
5. Exchange SDP offer/answer via WebSocket relay
6. Exchange ICE candidates
7. DataChannel opens → P2P link established
8. All file data flows directly peer-to-peer
```

## File Transfer Flow

```
Sender                          Receiver
  │                                │
  ├─ transfer_start (JSON) ───────▶│  (announce: name, size, chunks)
  │                                │
  ├─ chunk_meta (JSON) ───────────▶│  (chunkIndex, size)
  ├─ [binary chunk 256KB] ────────▶│
  │                                │
  ├─ chunk_meta ──────────────────▶│
  ├─ [binary chunk] ──────────────▶│
  │   ... (repeat)                 │
  │                                │
  └─ transfer_complete ───────────▶│  → assemble Blob → auto-download
```

## Chunk Size

256 KB per chunk balances:
- Memory usage (no huge buffers)
- Overhead (not too many messages)
- Backpressure compatibility with DataChannel buffering
