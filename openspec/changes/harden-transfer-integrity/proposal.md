# Proposal

## Why

Transfers can silently corrupt data and report success while doing it. `transfer.js:190` keeps a single pending chunk-header slot per peer, so two concurrent transfers to the same device overwrite each other's metadata and their chunks land in the wrong files. `_finalizeIncoming` never checks whether every chunk arrived, so a dropped chunk becomes a shorter file that is still presented to the user as a completed transfer.

This undermines the app's only real promise. A privacy tool that hands you a corrupt file and says "done" is worse than one that is visibly unfinished, and it makes every other improvement — zero-friction pairing, faster connections — cosmetic.

## What Changes

- **BREAKING** Replace the implicit ordering-by-arrival chunk protocol with a self-describing framed envelope. Every message carries its own transfer id, sequence number, and length, so interleaving is impossible by construction rather than by luck.
- Verify SHA-256 of the assembled file against the digest announced by the sender. A transfer is only offered to the user after it passes.
- Fail transfers explicitly when chunks are missing, and name which sequence numbers are absent instead of finalising a partial file.
- Add chunk-level retransmission. A receiver that detects gaps requests exactly those sequence numbers; the sender resends them idempotently from the file slice.
- **BREAKING** Remove the `maxRetransmits: 30` limit on the transfer data channel. It causes the channel to die mid-file after 30 lost messages, converting a recoverable loss into a total failure.
- Stream incoming chunks to disk via the File System Access API where supported, instead of holding the whole file in memory twice. Keep the Blob path as a fallback.
- Remove `maxRetransmits`-adjacent dead state and stop the header-per-chunk message pattern that doubles signaling volume on the peer channel.
- Fix the network topology map dividing by zero when only the local device is present, which currently renders the first-run map broken.
- Correct the live upload/download speed readout, which currently sums cumulative averages instead of measuring per-interval throughput.

## Capabilities

### New Capabilities

- `transfer-integrity`: Verifiable, multiplexed, resumable file transfer — framing, hashing, gap detection and recovery, and bounded memory use during large transfers.

### Modified Capabilities

None. `openspec/specs/` is currently empty, so there are no existing capability requirements being changed. The existing behaviour is unversioned and is captured here as new capability requirements.

## Impact

- `client/transfer.js` — protocol rewritten; the framing layer is the bulk of the change.
- `client/webrtc.js` — data channel options; `CHUNK_SIZE` constant moves with the framing code.
- `client/ui.js` — progress and failure surfaces must show missing-chunk and hash-mismatch states.
- `client/network.js` — division-by-zero guard in `_repositionNodes`.
- `client/app.js` — speed metric computation; transfer callback shapes change.
- No new runtime dependencies. Hashing uses the native `crypto.subtle` API; framing is hand-written.
- Data channel wire format changes, so sender and receiver must be upgraded together. Peers on an older build will fail to parse framed messages and must be rejected with a clear protocol-mismatch error rather than corrupting data.