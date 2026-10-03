# Tasks

## 1. Test harness

- [x] 1.1 Add a zero-dependency test runner script to `package.json` (`npm test`) and verify it runs and exits non-zero on failure
- [x] 1.2 Add a minimal assertion helper module and verify a deliberately failing assertion causes `npm test` to exit non-zero
- [x] 1.3 Verify the runner discovers and runs a test file placed under `tests/` and reports pass/fail counts

## 2. Framing layer

- [x] 2.1 Define the envelope header layout and the protocol version constant, and verify a round-trip encode/decode of a synthetic chunk returns identical transfer id, sequence number, and payload bytes
- [x] 2.2 Implement envelope encode and decode over a binary buffer, and verify round-trip tests pass for payload sizes at chunk size, 1 byte, and 0 bytes
- [x] 2.3 Replace the `chunk_meta` plus bare-payload send path with framed sends, and verify a single sequential transfer completes and passes digest verification
- [x] 2.4 Replace the `_pendingMeta` receive path with routing on the envelope's own transfer id, and verify no reference to `_pendingMeta` remains
- [x] 2.5 Add the concurrency test: send three files simultaneously to one peer through an in-memory channel pair and verify each assembled output equals its source byte-for-byte
- [x] 2.6 Add a test that shuffles the arrival order of framed chunks across two concurrent transfers and verify both files still assemble correctly

## 3. Verification

- [x] 3.1 Implement digest calculation using `crypto.subtle` and verify a known file's digest matches an independently computed expected value
- [x] 3.2 Detect an insecure context and report the transfer as unverifiable instead of skipping verification, and verify the test suite confirms no file is presented as verified when the digest is unavailable
- [x] 3.3 Announce the sender's digest in the transfer announcement and have the receiver refuse a transfer whose digest field is absent when it requires verification
- [x] 3.4 Verify completeness before finalising: withhold delivery and report missing sequence numbers when chunks are absent
- [x] 3.5 Verify the assembled digest against the announced digest and fail the transfer on mismatch without leaving a retrievable copy
- [x] 3.6 Abandon partial output on verification failure, and verify no complete-looking artifact survives a failed transfer
- [x] 3.7 Add tests asserting a missing chunk and a tampered chunk both fail rather than complete

## 4. Retry

- [x] 4.1 Track a next-expected sequence watermark per transfer and discard chunks below it as duplicates, verifying a deliberately duplicated chunk does not corrupt transfer state
- [x] 4.2 Record gaps ahead of the watermark as a set of missing sequence numbers
- [x] 4.3 Implement the missing-chunk request message and have the sender resend exactly those chunks from the source file slice
- [x] 4.4 Verify resend is idempotent: requesting an already-recovered chunk does not corrupt the transfer
- [x] 4.5 Enforce a bounded retry count and fail with the unrecovered sequence numbers named, verifying no partial file is delivered
- [x] 4.6 Enforce an independent total transfer wall-clock timeout so a dead peer fails visibly instead of retrying forever
- [x] 4.7 Remove `maxRetransmits` from the transfer data channel, keeping `ordered: true`, and verify sustained loss under the old limit leaves the channel open

## 5. Streaming sink

- [x] 5.1 Detect File System Access API availability and select the streaming or Blob path, verifying the capability is reported in the UI state
- [x] 5.2 Obtain a writable file handle before the first chunk in the streaming path, and verify appending chunks produces a file with the expected size
- [x] 5.3 Abandon and clean up the partial file when a streamed transfer fails, verifying no artifact remains after a failure
- [x] 5.4 Enforce a size ceiling on the in-memory fallback path and fail with a clear message above it, verifying the message names the limit
- [x] 5.5 Verify a transfer whose size exceeds free memory completes via streaming with memory staying proportional to chunk size

## 6. Compatibility

- [x] 6.1 Send a protocol version and capability handshake as the first channel message
- [x] 6.2 Reject a peer reporting an unsupported protocol version with a message naming both versions, verifying no transfer starts
- [x] 6.3 Verify a mismatched-version pair produces a visible protocol error rather than a stalled or corrupt transfer

## 7. Metrics and topology

- [x] 7.1 Rewrite the speed calculation to measure throughput per interval and verify reported speed stays close to the actual delivered byte rate over a multi-interval transfer
- [x] 7.2 Fix the live upload/download aggregate readout and verify two concurrent opposite-direction transfers sum correctly
- [x] 7.3 Guard the topology node positioning against a zero-peer-count division and verify the map renders with only the local device
- [x] 7.4 Verify nodes are placed at distinct valid positions as second, third, and fourth peers connect

## 8. Integration verification

- [x] 8.1 Run the full test suite and verify it passes with zero failures
- [ ] 8.2 Perform a manual large-file transfer of several hundred megabytes between two browsers and verify the reported digest matches the source and no corruption is reported
- [ ] 8.3 Perform a manual three-file simultaneous transfer and verify all three files arrive intact
- [ ] 8.4 Verify `npm run build` still produces a `dist/` bundle and the built app loads and transfers a file correctly