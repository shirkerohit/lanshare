# Tasks

## 1. Shared signaling protocol

- [x] 1.1 Extract the signaling message contract into a shared module importable by both `server/server.js` and `worker/`, and verify both import it without duplicating message definitions
- [x] 1.2 Define scope derivation from a client address (IPv4 /24 and IPv6 /64) as a pure function, and verify tests for private ranges, public addresses, IPv6, and malformed input
- [x] 1.3 Verify the scope function never consults client-supplied input, and add a test asserting a forged scope value in a registration message is ignored

## 2. Network isolation (release-blocking)

- [x] 2.1 Partition the Node server's peer registry by derived scope so cross-scope peers are never listed, and verify a two-scope test shows zero cross-visibility
- [x] 2.2 Add the isolation test asserting devices in different scopes never receive each other's presence, signal, or join events, and verify it fails if scope partitioning is removed
- [x] 2.3 Refuse to relay signals across scopes and record the refusal, verifying a cross-scope relay attempt delivers nothing
- [x] 2.4 Verify peers in the same scope still discover each other with no code or link exchange
- [x] 2.5 Verify many distinct scopes on one server do not alter any user's device count or list

## 3. Pairing request and accept

- [x] 3.1 Add pairing request and response message types naming both devices, delivering only to the intended recipient
- [x] 3.2 Add request expiry after a bounded lifetime with no state left on either device, verifying an unanswered request disappears from both
- [x] 3.3 Surface a pending request state on the requesting device and an accept/decline choice on the recipient device, verifying both states render and clear
- [x] 3.4 Remove mutual auto-offer so only the accepted side initiates the handshake, verifying discovery alone starts no connection
- [x] 3.5 Add deterministic tie-breaking by peer id so reciprocal simultaneous requests resolve to a single initiator, verified by a test asserting exactly one side initiated
- [x] 3.6 Verify a duplicate request to an already-connected device preserves the existing connection and creates no second channel

## 4. Connection lifecycle correctness

- [x] 4.1 Stop tearing down an established data channel when a peer's signaling connection drops, verifying a signaling blip leaves a working channel and in-flight transfer intact
- [x] 4.2 Bound the unconfirmed-channel lifetime and tear down on explicit disconnect, on connection failure, or on reconnect-window expiry
- [x] 4.3 Fix the register/close race so a superseded socket's close cannot delete a live peer's registry entry, verified by a test that re-registers before processing the stale close
- [x] 4.4 Add a heartbeat so a lapsed peer is removed from lists within a bounded time, verifying an abruptly dropped peer does not persist as a ghost
- [x] 4.5 Bound connection retries and report that re-pairing is required instead of looping, verifying no abandoned connection attempts accumulate

## 5. Configurable endpoint

- [x] 5.1 Resolve the signaling endpoint from configuration with a same-origin default, verifying unconfigured runs behave exactly as today
- [x] 5.2 Support an explicit "no signaling server" setting that presents manual pairing and makes no signaling connection attempts
- [x] 5.3 Add configured-remote-relay support and verify discovery and pairing work identically against it
- [x] 5.4 Keep the existing `?static` query flag and build-time static flag working, verifying both still force manual mode

## 6. Hosted relay

- [x] 6.1 Add `worker/` as a separate deployable directory with its own config, verified by building it independently of the Pages bundle
- [x] 6.2 Implement scope routing to one Durable Object per scope using the shared protocol module
- [x] 6.3 Use the hibernation WebSocket API for all accepted connections and add a startup assertion confirming hibernation is in use, verifying the assertion fails if the non-hibernating accept path is used
- [x] 6.4 Make duration usage observable so daily allowance consumption is visible before exhaustion, and verify it reports current consumption
- [x] 6.5 Run the isolation test suite against the Worker and verify it passes identically to the Node server
- [ ] 6.6 Verify a full pairing and file transfer works end to end through the Worker with no signaling endpoint misconfiguration

## 7. Integration verification

- [x] 7.1 Run the full test suite including isolation tests and verify zero failures
- [ ] 7.2 Manually verify two devices on one network pair by selecting, requesting, and accepting with no code exchange, then transfer a file
- [ ] 7.3 Manually verify devices on different networks never appear to each other while sharing one hosted relay
- [ ] 7.4 Verify `npm run build` still produces a working `dist/` and the built app pairs and transfers correctly
- [x] 7.5 Document the isolation boundary and its limitations in the threat model, including carrier NAT grouping and /24 granularity, and verify the document states that isolation is application-enforced