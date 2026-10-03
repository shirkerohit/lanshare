# Proposal

## Why

Two defects break the product's central claim that nothing unintended crosses the network or reaches another user, and both are exploitable by an ordinary user rather than requiring deliberate attack.

First, `ui.js:410` interpolates `peer.info.type` into `innerHTML` without escaping. That value arrives over the network from any connecting peer. Every other peer-supplied field — name, chat text, saved-device labels — is passed through `esc()`; this one is not. A peer registering with a crafted `type` value executes script in every browser that lists it. On a relay reachable from the public internet that means anyone can run code on any other user's device.

Second, `server.js:153` broadcasts chat messages to the entire room while passing `private: true` through untouched. Private messages are delivered to everyone in the room and merely labelled as private in the UI. A message a user believes went to one person goes to all of them.

Separately, `server.js:37` builds a file path by joining an unnormalised request path onto the client directory, which allows traversal outside the served directory. `scripts/serve-dist.js` already does this correctly with `path.resolve` and a prefix check, so the correct implementation exists in the repo and the server simply does not use it.

## What Changes

- Escape `peer.info.type` before interpolating it, and audit every remaining `innerHTML` interpolation for peer-supplied values. Render untrusted peer fields as text nodes rather than markup.
- Treat peer metadata as untrusted input everywhere, including name fields that are already escaped today, so the escaping is not one forgotten call away from regressing.
- Require explicit confirmation before any file leaves the device, and before each pairing request is accepted. No remembered trust: confirmation is per request and per send.
- Fix private chat so a private message is delivered only to its intended recipient. Refuse to broadcast private messages and drop them with a visible error if no recipient is resolvable.
- Fix path traversal in the static file server by normalising and resolving the request path, then verifying it remains inside the intended root, matching the approach already used in `scripts/serve-dist.js`.
- Bound peer-supplied payload sizes and reject malformed metadata rather than accepting it into state.
- Restore the missing startup banner and the LAN address log in `server/server.js`, so `npm start` tells the operator which URL to share.
- Document the threat model: what each party can observe in each mode, which metadata crosses the signaling server, and why file contents never do. Record that private chat and LAN-scoped discovery are the enforced boundaries.

## Capabilities

### New Capabilities

- `trust-and-privacy`: The security and privacy boundary of the application — escaping untrusted peer input, explicit confirmation gates, confidential message delivery, hardened file serving, and a documented threat model.

### Modified Capabilities

None. `openspec/specs/` is empty, so no existing capability requirements are being changed.

## Impact

- `client/ui.js` — peer card rendering, per-send confirmation, incoming confirmation, audit of `innerHTML` use.
- `client/app.js` — send path gains a confirmation gate before the first chunk is transmitted.
- `server/server.js` — private chat routing, path resolution, input validation, restored startup logging.
- `scripts/serve-dist.js` — referenced as the reference implementation for the traversal fix; no change expected.
- `docs/` — new threat model document covering both hosting modes and the enforced boundaries.
- No new runtime dependencies.
- Confirmation before every send means a drag-and-drop becomes drop, confirm, send. That is one additional tap per transfer. It is a deliberate trade: a prompt before files leave the device is the clearest expression of what the product promises.
- Sanitisation of peer metadata changes what a crafted registration can display, which will surface as a malformed device name where arbitrary text previously rendered. That is the intended outcome.