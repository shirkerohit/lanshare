# Design

## Context

See `proposal.md` — Why.

The existing transfer path in `client/transfer.js` has three coupled problems. Chunk metadata is stored in a single map keyed only by peer (`this._pendingMeta`), so concurrent transfers to one peer share one slot. Payload association therefore depends on strict alternation between a JSON header and a binary payload, which concurrent async loops do not preserve. Completion is triggered by a `transfer_complete` message with no reconciliation against what was actually received.

Other constraints worth knowing before changing this:

- No test framework and no test runner exist in the project. `package.json` has no `test` script.
- `client/transfer.js` depends on the global `CHUNK_SIZE`, exported from `webrtc.js` via `window`.
- `crypto.subtle` is unavailable on insecure origins. GitHub Pages is HTTPS, and `http://localhost` is a secure context, but a device opening the app over plain `http://192.168.x.x:3000` is not. Digest calculation must degrade predictably in that case or be computed incrementally with a non-`subtle` fallback.
- The File System Access API exists in Chromium browsers only. Safari and Firefox require the Blob fallback path.

## Goals / Non-Goals

**Goals**

- Make concurrent transfers structurally correct rather than accidentally correct.
- Make silent corruption impossible: no path may present an unverified file as complete.
- Keep memory proportional to chunk size for large transfers where the browser allows it.
- Preserve the existing public surface of `TransferEngine` callbacks as far as practical, so `app.js` and `ui.js` changes stay small.

**Non-Goals**

- Parallel chunk streams or congestion tuning. The existing `bufferedAmount` backpressure is adequate.
- Resuming a transfer across a page reload. Out of scope; requires persistence the app does not have.
- Encrypting transfers. WebRTC already provides DTLS encryption on the channel.

## Decisions

### Envelope framing over a header/payload pair

Replace `chunk_meta` + bare payload with a single binary envelope: a fixed-size header carrying protocol version, transfer id, sequence number, and payload length, followed by the payload bytes.

**Why:** self-description means routing decisions use only the bytes in hand. There is no shared slot, no ordering assumption, and nothing to race on.

**Alternative considered:** one `DataChannel` per transfer. This does give isolation and is simpler to reason about, but the number of open channels grows with concurrent transfers, several browsers cap channels per peer connection, and channels must still be framed to carry a sequence number for gap detection. Framing was chosen because it also yields the sequence number that verification and retry both need.

**Alternative considered:** keep JSON headers but key `_pendingMeta` by `transferId`. This fixes the immediate bug but leaves correctness dependent on JSON and payload arriving adjacently, and leaves no place to put a length or a sequence number for gap detection. Insufficient.

### `crypto.subtle` with a capability-reported fallback

Compute the sender's digest with `crypto.subtle.digest` when the origin is a secure context. When it is not, report the transfer as unverifiable rather than skipping verification silently.

**Why:** the requirement is that unverified content is never presented as verified. On a plain-HTTP LAN origin the honest outcome is "cannot verify", not "assume correct". Reporting it lets the UI say so, and leaves room for a later incremental-hash implementation without changing the protocol.

**Alternative considered:** ship a JS SHA-256 to cover insecure origins. It works and removes the limitation, at the cost of bundling a hash implementation. Deferred; the capability report is honest without it.

**Alternative considered:** verify per-chunk with a cheap checksum instead of the whole file. Weaker — it cannot detect a reordered or substituted file, which is exactly the class of failure the requirement targets.

### Digest announced in the transfer announcement

The sender computes the digest before streaming and includes it in the transfer announcement message, so the receiver has an expected value from the start rather than learning it at the end.

**Why:** the receiver needs the expected value to verify at all, and announcing up front means the receiver can refuse a transfer it will not be able to verify before accepting a single chunk.

**Trade-off:** the sender must hash the whole file before sending begins, which adds latency before the first chunk for large files. Accepted: the user has already selected the file, so the file is local and readable, and hashing at disk or memory speed is far shorter than the transfer itself.

### Whole-file digest only — no per-chunk checksums (decided)

Verification is hash-before-send on the sender and hash-after-receive on the receiver, compared once, like a typical file download checksum. Per-chunk digests (CRC-32 or truncated SHA-256) were considered and rejected as unnecessary complexity: the channel is DTLS-authenticated so there is no in-transit adversary to defend against, and the whole-file digest already covers loss, misrouting, and corruption for every transfer that holds its bytes in memory.

**Consequence:** a streamed transfer — bytes written to disk, never held — cannot be verified this way without re-reading the file. Streamed transfers therefore complete as delivered-but-unverified until streaming verification is designed. This is deferred, not dropped, and the envelope already carries everything a future design needs.

### Gap detection by sequence watermark, repair by explicit request

The receiver tracks the next expected sequence number. Any chunk with a sequence below the watermark is a duplicate and is discarded without touching transfer state. Any gap ahead of the watermark is recorded as a set of missing indices. On completion, or on an idle timer, missing indices are requested.

**Why:** derived from the framing, so it needs no extra bookkeeping. Duplicate suppression falls out of the same mechanism, which matters because SCTP retransmission can legitimately redeliver.

**Alternative considered:** rely on the channel's own retransmission to eventually deliver everything and verify only at the end. This is what happens today and is why a single lost chunk currently produces a short file. Channel retransmission is best-effort, not guaranteed, so end verification alone cannot repair anything — by the time you know a chunk is missing, the transfer has already been reported complete.

### Unbounded channel retransmission

Remove `maxRetransmits` and set `ordered: true` with no retransmission cap.

**Why:** the cap converts recoverable loss into a dead channel. With the cap removed, loss is handled by the channel; with framing in place, the gap-detection layer is the backstop for what the channel cannot resolve. Keeping the cap would make the backstop unreachable.

### Streaming with a Blob fallback

Where `showSaveFilePicker` is available, obtain a writable handle before the first chunk and append each chunk as it arrives. Otherwise retain the existing array-and-Blob path.

**Why:** the current path holds the full file twice — once as an array of chunk buffers, once as the assembled Blob. For a file near the browser's memory limit this is the failure mode, and a memory crash mid-transfer loses everything with no partial result.

**Note:** the picker requires a user gesture. Since confirmation-before-send is introduced by the `static-mode-trust` change, that gesture already exists in the flow; the two changes compose. If the picker is dismissed or unavailable, fall back rather than failing.

### Capability exchange at channel open

The channel's first message is a small version handshake carrying the protocol version and optional capabilities (streaming support).

**Why:** required by the spec's incompatible-peer requirement. Without it, an older peer would receive framed messages and silently discard them, presenting as a stalled transfer rather than a version error.

## Risks / Trade-offs

**Digest-before-send delays first byte on large files** → Hash while the user reviews the send confirmation, so the wait overlaps human reaction time rather than adding to it.

**Two peers must upgrade together** → The version handshake makes this a clean error. During the transition window a mismatched pair cannot transfer. Acceptable: the alternative is silent corruption, and the pairing-friction change makes re-pairing a single scan.

**Appending to a file handle is not transactional** → A transfer that fails verification leaves a partial file on disk. Track the write handle per transfer and abandon the file on failure so no complete-looking artifact survives a failed transfer.

**Unbounded retransmission could mask a genuinely dead peer** → Bound total transfer wall-clock time independently of retransmission. A transfer exceeding the limit fails with a clear timeout rather than retrying forever.

**Blobs remain uncancellable and memory-resident in the fallback path** → Report the reduced capability when it applies, and enforce a size ceiling on the fallback path so the tab fails early with a clear message instead of dying without one.

## Migration Plan

1. Add framing alongside the existing path behind a protocol version constant, with both readers accepting version 1 framing and rejecting version 0.
2. Add verification and gap detection. At this point corruption is fixed; retry is not yet available.
3. Add retransmission and remove `maxRetransmits`.
4. Add the streaming sink and the Blob fallback ceiling.
5. Add the version handshake last, once both sides of the change are deployed to the same build.

Rollback is a revert to the previous build. Because the version handshake is added last, a rollback during steps 1-4 leaves old peers able to pair and fail visibly rather than corrupting data.

## Open Questions

None. The remaining choices — fallback size ceiling value, transfer timeout duration — are tuning constants to be set during implementation and do not change the approach, the specs, or the task breakdown.