# Proposal

## Why

Pairing by hand is the single feature stopping people from using LanShare, and the friction is structural. A pairing payload today is roughly 1700 characters of base64-encoded SDP. Reading, selecting, copying and pasting that string on two devices is tedious enough that people give up before transferring anything, even though the product itself works once connected.

The payload does not need to be that long. Roughly two thirds of a typical LAN session description is dead weight — unreachable interfaces, IPv6 link-local and unique-local addresses, duplicate candidates from virtual adapters — and all of it compresses extremely well. Measured against a realistic multi-interface host candidate set, trimming and deflating reduces the payload from about 1704 characters to about 594, which fits a scannable QR code. That is the difference between a QR code too dense to read and one a phone camera handles at a glance.

A second, larger win is available: the payload can travel in a URL fragment rather than in a text box. Fragments are never transmitted to the host, so the static host never observes them, and the same payload becomes a real link that can be scanned, clicked, copied, or shared. One payload, several ways to move it, instead of one long string that must be transcribed.

## What Changes

- **BREAKING** Compress pairing payloads: strip unusable ICE candidates before encoding, deflate, and use unpadded base64url on a single line. Reduces payload from about 1704 to about 594 characters.
- Carry pairing payloads in a URL fragment (`#o=` for an offer, `#a=` for an answer). The fragment is never sent to the static host.
- Present a generated pairing payload four ways from one source: a scannable QR code, a clickable link, a copy button, and a grouped human-readable code.
- Auto-focus the paste target and submit on paste so a transferred code takes one keystroke rather than a select-copy-switch-paste sequence.
- Accept either a raw code or a full link in the paste target, since a link may arrive from a share sheet rather than a clipboard copy.
- Add one-tap pairing confirmation: both devices display the same short word code derived from the pairing payload, so a mismatch is visible before trust is established.
- Reduce the pairing payload to a scannable QR code without introducing a dependency on a native QR decoder. The scanning device uses its own camera application; no in-page scanner is required.

## Capabilities

### New Capabilities

- `pairing-ux`: Low-friction device pairing through compressed payloads, URL-fragment handoff, multi-modal presentation, and one-tap confirmation.

### Modified Capabilities

None. `openspec/specs/` is empty, so no existing capability requirements are being changed.

## Impact

- `client/webrtc.js` — payload encode/decode, candidate trimming, ICE-complete gating before encoding.
- `client/ui.js` — pairing panel becomes the multi-modal surface; paste target behaviour.
- `client/app.js` — pairing flow coordination and fragment parsing on load.
- `client/index.html` — pairing panel markup.
- No new runtime dependencies. Compression uses the native `CompressionStream`/`DecompressionStream` API. QR generation is a self-contained encoder limited to the byte mode and the version range the compressed payload requires; no in-page scanning library.
- `scripts/build.js` — copies any new pairing asset into `dist/`.
- ICE-complete gathering before encoding replaces trickle-ICE for the pairing path only. Server-backed mode is unaffected and keeps trickling.
- Static mode keeps `iceServers: []`. Adding STUN to recover from failed candidates would expose local addresses to a third party and break the app's privacy claim, so the pairing path deliberately has no ICE server and accepts lower connection success in exchange.
- A pairing payload contains the device's local addresses and DTLS fingerprint. It is base64, not encryption. This is acceptable only because the pairing partner is someone on the same network who was deliberately selected; the threat model is documented rather than assumed away.