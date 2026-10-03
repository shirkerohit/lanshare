# Tasks

## 1. Peer input rendering

- [x] 1.1 Escape the peer-supplied device type before interpolation in the peer card, and verify a crafted type value renders literally with nothing executing
- [x] 1.2 Audit every `innerHTML` interpolation across the client for peer-supplied values, and convert each to `textContent` or escape it, verifying each converted site with a hostile-value test
- [x] 1.3 Add a test that fails when a peer-supplied field reaches `innerHTML` unescaped in device-list or message code, verifying the test fails against the known pre-fix pattern
- [x] 1.4 Verify a hostile device name renders literally and executes nothing in every peer surface: card, notification, saved-device list, and message attribution
- [x] 1.5 Verify chat content containing markup or formatting-like sequences displays as typed, executes nothing, and still renders intended formatting

## 2. Input validation

- [x] 2.1 Reject registrations missing a required name or identifier, and verify the application remains fully functional afterwards
- [x] 2.2 Reject oversized peer metadata rather than truncating it, and verify no partial value is displayed or stored
- [x] 2.3 Discard malformed messages without affecting existing connections or in-flight transfers, verified by an active-transfer test
- [x] 2.4 Verify a registration lacking a device type still connects using a safe default
- [x] 2.5 Verify a peer registering with a missing info object does not throw and does not remove existing devices from the list

## 3. Confidential messaging

- [x] 3.1 Route a message marked confidential only to its named recipient, and verify no other device receives it
- [x] 3.2 Verify a confidential message does not appear in any other device's message history
- [x] 3.3 Refuse to broadcast a confidential message and refuse to deliver it to any substitute recipient when the intended one is unreachable, verifying the sender is informed it was not delivered
- [x] 3.4 Verify a non-confidential message still reaches all devices in the network and is visibly distinguishable from a confidential one
- [x] 3.5 Verify the private marker renders only when the message was actually delivered to one recipient

## 4. Path confinement

- [x] 4.1 Apply normalise-resolve-prefix-check to the signaling server's file serving, matching the pattern in `scripts/serve-dist.js`
- [x] 4.2 Add a traversal test suite covering relative segments, encoded separators, absolute paths, and paths that share a name prefix with the root, verifying each is refused
- [x] 4.3 Verify the refusal does not reveal whether the target path exists
- [x] 4.4 Verify legitimate nested paths still serve normally
- [x] 4.5 Run the same traversal suite against the static preview server and verify identical behaviour, so both servers enforce one rule

## 5. Transfer confirmation

- [x] 5.1 Show a confirmation naming the file and destination device before any file content is transmitted, and verify nothing is sent until it is confirmed
- [x] 5.2 Verify declining the confirmation sends nothing and leaves no transfer state
- [x] 5.3 Verify each transfer is confirmed separately, including repeat transfers to the same device and multi-file sends, with no approval carrying over
- [x] 5.4 Verify the confirmation cannot be satisfied by a gesture that occurred before it appeared
- [x] 5.5 Confirm the confirmation fires before any file write handle is requested, so it satisfies the streaming sink's user-gesture requirement
- [x] 5.6 Route drag-and-drop sends through the same confirmation, verifying a drop alone transmits nothing

## 6. Incoming confirmation

- [x] 6.1 Surface an incoming transfer for confirmation showing the sending device and file details, and verify the file is delivered only after confirmation
- [x] 6.2 Verify declining an incoming transfer saves nothing, leaves no partial artifact, and informs the sender
- [x] 6.3 Verify the incoming confirmation identifies the sending device unambiguously despite generated device names

## 7. Server operation

- [x] 7.1 Restore the startup banner and address reporting in the signaling server, verifying the printed address is openable
- [x] 7.2 Verify the server reports clearly when no non-loopback network address exists instead of printing an unusable one
- [x] 7.3 Verify the startup output states which hosting mode is active

## 8. Threat model documentation

- [x] 8.1 Write the threat model covering what a self-hosted deployment observes, what a hosted relay observes, and that file contents cross neither
- [x] 8.2 Document that network isolation is enforced by application logic and not by the network, and state the isolation granularity and its limitations including carrier NAT
- [x] 8.3 Document why no short numeric pairing code is offered, and that pairing payloads are compressed but not encrypted and reveal local addresses
- [x] 8.4 Document that confidential chat currently reaches the signaling server, and note direct-channel delivery as the stronger follow-up
- [x] 8.5 Verify the document is linked from the README so a reader finds it before deploying publicly

## 9. Integration verification

- [x] 9.1 Run the full test suite and verify zero failures
- [ ] 9.2 Manually verify a maliciously-registered peer causes no script execution and no functional disruption on another device
- [ ] 9.3 Manually verify a confidential message is visible only on the recipient device
- [ ] 9.4 Manually verify a file cannot be sent without a confirmation, including via drag-and-drop
- [ ] 9.5 Verify `npm run build` produces a working `dist/` and the built app retains the confirmation gates and safe rendering