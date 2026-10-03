# Tasks

## 1. Payload encoding

- [x] 1.1 Implement SDP line-level candidate filtering that keeps a candidate wholly or not at all, and verify tests for link-local IPv6, unique-local IPv6, private non-target ranges, duplicate interfaces, and TCP candidates
- [x] 1.2 Implement deflate compression and decompression with base64url unpadded single-line encoding, and verify round-trip parity on a realistic multi-interface SDP
- [x] 1.3 Verify a trimmed and compressed payload is under 700 characters for a realistic multi-interface session description, and under 3000 characters in the worst case with many interfaces
- [x] 1.4 Verify the decoded payload is byte-identical to the encoded session description
- [x] 1.5 Verify a payload with no usable candidates produces a clear error rather than an unusable code
- [x] 1.6 Verify malformed input is rejected with a message naming what was wrong

## 2. QR encoder

- [x] 2.1 Implement the QR encoder covering byte mode up to the version the payload requires, with no runtime dependency
- [x] 2.2 Verify encoder output matches known-good reference output for at least three payload lengths, including at least one fixture from an independent source
- [x] 2.3 Implement Reed-Solomon error correction and verify its output against known test vectors
- [ ] 2.4 Verify a rendered code round-trips back to the original payload through an independent decoder
- [x] 2.5 Render the code at a fixed module size with a correct quiet zone, sized from the required version, and verify it is legible at phone-screen scale
- [x] 2.6 Verify a payload too large for a legible code falls back to the link and copy forms rather than blocking pairing

## 3. Link-based pairing

- [x] 3.1 Encode offer and answer payloads as link fragments (`#o=` and `#a=`) and verify each is handled as the correct role
- [x] 3.2 Read the fragment on load and clear it immediately so the payload is not left in the address bar or history, verified by asserting the address is scrubbed after read
- [x] 3.3 Verify the host serving the app receives no pairing payload in the request
- [x] 3.4 Verify a link that is malformed, truncated, or from an unrelated app is rejected with a clear message and does not disturb existing pairing state
- [x] 3.5 Verify an offer link opened on a device begins the pairing flow and shows who is being paired with

## 4. Multi-form presentation

- [x] 4.1 Render the scannable code, clickable link, copy control, and grouped text from one encoded payload, and verify all four decode identically
- [x] 4.2 Group the human-readable form into visually separated segments so a misread is noticeable, and verify a single-character change produces a visibly different grouping
- [x] 4.3 Implement copy-to-clipboard with a fallback where the clipboard API is unavailable, verifying the payload reaches the clipboard and the user is told it was copied
- [x] 4.4 Verify a non-camera device presents its payload as a clickable link and as copyable text

## 5. Low-effort receiving

- [x] 5.1 Focus the pairing input automatically when the pairing panel opens, verified by asserting the input is the active element
- [x] 5.2 Process the payload on paste with no separate submit action, verifying pairing completes from a single paste
- [x] 5.3 Accept both a raw payload and a full link in the input, verifying both pair identically
- [x] 5.4 Normalise whitespace and stray characters on input, verifying a payload pasted from a chat client still pairs
- [x] 5.5 Report invalid input without proceeding, verifying no partial pairing state is created

## 6. Confirmation code

- [x] 6.1 Derive a short confirmation code from a hash of the exchanged payloads and verify both devices display an identical code for the same exchange
- [x] 6.2 Display the confirmation code on both sides during pairing, before any file is exchanged
- [x] 6.3 Require a user confirmation action before treating a pairing as established, verifying an unconfirmed pairing does not enable transfer
- [x] 6.4 Allow the confirmation to be skipped and record that it was skipped
- [x] 6.5 Verify a deliberately altered payload produces a visibly different confirmation code

## 7. Integration verification

- [x] 7.1 Run the full test suite and verify zero failures
- [ ] 7.2 Manually pair two phones by scanning in both directions and verify zero manual input was required
- [ ] 7.3 Manually pair a laptop and a phone, verifying one scan plus one paste completes it
- [ ] 7.4 Manually pair two laptops via link and via copy-paste, verifying the manual action count is the same in both directions
- [x] 7.5 Verify the app still pairs with the previous payload format during the transition, and that a version mismatch produces a clear rejection
- [ ] 7.6 Verify `npm run build` copies the new asset into `dist/` and the built app pairs correctly from the built bundle
- [ ] 7.7 Document that short numeric and read-aloud codes are out of scope and why, in the threat model