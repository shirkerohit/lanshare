# Design

## Context

See `proposal.md` — Why.

Measured against a realistic multi-interface host candidate set (Wi-Fi, Ethernet, Docker bridge, WSL, VPN, IPv6 link-local), with ICE gathering complete and no STUN configured:

```
  full SDP, base64 (current behaviour)              1704 chars
  after removing unusable candidates + deflating      594 chars   35%
  base64url, unpadded, single line                    594 chars
  QR byte-mode capacity needed                        version 20
```

Relevant existing constraints:

- `client/webrtc.js` already sets `iceServers: []` for manual mode (`options.manual`), so a pairing payload already carries host candidates only.
- `_encodeManualPayload` / `_decodeManualPayload` already exist in `webrtc.js` and use `btoa(unescape(encodeURIComponent(...)))`.
- `ui.js` already has a copy button pattern, a manual-status line, and a paste target.
- `CompressionStream` and `DecompressionStream` are available in current browsers. `crypto.randomUUID` is likewise.
- `scripts/build.js` copies a fixed file list into `dist/`; a new client asset must be added to it.
- No dependency is desired. `package.json` has exactly one dependency (`ws`) and the client is plain script tags with no bundler.

## Goals / Non-Goals

**Goals**

- Cut the payload from ~1704 to ~594 characters without changing what it decodes to.
- Make the payload movable by scanning, clicking, copying, or pasting, from one source.
- Make the answer leg cost one keystroke where a scan is not possible.
- Keep the zero-dependency property.

**Non-Goals**

- A QR scanner in the page. `BarcodeDetector` is Chromium-only, and a library-based scanner plus a webcam permission prompt is worse than pasting. The scanning device uses its own camera app.
- Read-aloud or numeric codes. Not achievable at any compression ratio; a typed code cannot carry the material.
- Shortening the protocol version scheme or adding encryption to the payload.

## Decisions

### Fragment, not query string

Carry the payload in `location.hash` (`#o=` offer, `#a=` answer).

**Why:** fragments are never sent in an HTTP request. The host serving the app receives a request with no pairing data, which directly supports the app's privacy claim. A query string would be logged by the host, by proxies, and by the browser history.

**Consequence:** clear the fragment with `history.replaceState` immediately after reading it, so the payload is not left in the address bar, history, or share sheet.

### Trim candidates, then deflate, then base64url

Remove unreachable candidates before encoding, deflate, then encode with base64url and no padding.

**Why:** the win is mostly from trimming, not compression. Virtual adapters, IPv6 link-local and unique-local addresses, and duplicate candidates per interface are pure overhead on a LAN. Compression alone gets ~540 bytes; trimming first gets the candidate list short enough that the compressed result is smaller still.

**Order matters.** Trimming must happen on the SDP text, before encoding, because it removes whole repeated structures that compress extremely well.

**Why base64url unpadded:** survives being a URL fragment unencoded, and avoids `+`, `/`, `=` which get mangled by some transfer paths and chat clients.

### One payload, four renderings

Render the QR, the link, the copy button, and the grouped text from the same encoded string. Nothing is generated twice and nothing can disagree.

**Why:** the earlier risk of drift between representations is real — a QR encoding one thing and the text showing another would be a silent failure that is very hard to diagnose. Deriving all four from one variable removes the possibility.

### QR encoder written for the required range only

Hand-write a QR encoder covering byte mode up to the version the compressed payload needs, with no dependency.

**Why:** a full-featured library pulls in numeric/alphanumeric/kanji modes and Reed-Solomon optimisations this app will never use. The app's payload is always binary-compressed data, so byte mode alone suffices.

**Considered and rejected:** vendoring a general-purpose library (~30KB minified) for correctness confidence. The encoder's hard part is Reed-Solomon over GF(256), which is about 60 lines and independently testable. Tests assert against known-good encoder output for a set of payloads rather than trusting the implementation.

**Considered and rejected:** rendering the QR server-side. The payload would leave the device. Unacceptable.

**Note:** the encoder must be exercised by tests against known-correct output, because a subtly wrong encoder produces an unscannable code that fails silently and looks like a camera problem.

### ICE-complete before encoding, no trickle on the pairing path

Wait for ICE gathering to complete, then encode. This is already what `_waitForIceComplete` does; the pairing path must not begin offering before it.

**Why:** trickled candidates cannot be expressed in a single link. Once gathered, the whole candidate set fits in the payload.

**Trade-off:** a slightly slower first offer in exchange for a self-contained link. Already accepted for the manual path.

### Keep `iceServers: []`

Retain no ICE server for the pairing path.

**Why:** adding STUN to improve connection success would disclose local addresses to a third party, and the resulting srflx candidates would roughly double the payload size. The app's claim is that a static deployment involves no third party. This is a deliberate trade: lower connection success in exchange for a true privacy claim, and it is documented rather than silently decided.

### Confirmation code derived from the exchange, not the SDP

Derive the short confirmation code from a hash of the exchanged payloads on both sides.

**Why:** it must be identical on both devices without extra communication, which the payload exchange already provides. Deriving from the SDP itself would work but would leak more structure if the code were displayed; deriving from a hash gives a short, non-invertible value.

**Trade-off:** it is a tamper-evidence check on the exchange, not full cryptographic authentication. It does not defend against an active attacker who can modify both payloads in flight. The threat model says so plainly rather than implying protection it does not provide.

### Paste-on-input with either form accepted

Listen for paste on the pairing input, accept a raw payload or a link, and process immediately.

**Why:** makes the answer leg a single keystroke wherever a scan is impossible. Accepting both forms matters because a link may arrive from a share sheet rather than a clipboard.

**Considered and rejected:** requiring an explicit submit button. It adds a step to the only flow where the user is already doing manual work.

## Risks / Trade-offs

**A hand-written QR encoder could be subtly wrong and fail silently** → Test against known-good encoder output for several payload lengths, and verify a rendered code decodes back to the original payload. A round-trip test through the encoder's own output is not sufficient on its own, since a symmetric bug would pass; at least one fixture must come from an independent source.

**The QR must be legible on a phone screen** → Render at a fixed module size with a quiet zone, and size the code from the required version rather than stretching a small canvas. If a payload is too large for a legible code, the link and copy forms remain available as fallback, so legibility failure degrades rather than blocks.

**Fragment payload survives in history until cleared** → Clear immediately on read, before rendering anything.

**Some chat clients mangle long links on paste** → Accept raw payloads as well as links, and normalise whitespace on input.

**Compressing before truncating candidate lines** → Trim by SDP line, never by string search within a line, so a candidate is either wholly kept or wholly removed.

**Two peers on different builds cannot pair** → Version the payload envelope and reject mismatches with a clear message. Already covered by the protocol handshake in `harden-transfer-integrity`.

## Migration Plan

1. Add the encoder/decoder with candidate trimming behind the existing payload functions, verify round-trip parity with the current implementation.
2. Add fragment read and clear on load, verify pairing completes by opening a link.
3. Add the multi-form presentation, verify all four forms decode identically.
4. Add paste-on-input and either-form acceptance.
5. Add the confirmation code display.

Step 1 is byte-compatible with existing payloads, so it can ship independently and be rolled back without affecting the others. Later steps are UI-only additions and do not change the wire format.

## Open Questions

None. Module placement for the QR encoder and the exact grouped-text layout are implementation details that do not change the specs, the approach, or the task breakdown.