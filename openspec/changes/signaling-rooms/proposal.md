# Proposal

## Why

LanShare's stated promise is that people on their own network can share files with no connection to anyone else. That promise is currently false. `server.js:130-145` broadcasts the full peer list and every join event to every connected client with no isolation of any kind — no `req.socket.remoteAddress` read, no room concept anywhere in the file. Two strangers in different countries who both open the app appear in each other's device lists, and WebRTC then attempts a real connection between them via public STUN servers. That is the opposite of the intended behaviour and it happens silently.

Because discovery currently cannot work without every peer seeing every other peer, users have no choice but to pair manually by pasting long connection codes. Making rooms correct removes the need for codes entirely, which is why isolation is a prerequisite for the product rather than a security nicety.

## What Changes

- Partition connected peers into rooms keyed by network subnet, derived from the connection's source address. Peers in different subnets are never introduced to one another and never learn each other exists.
- Introduce an explicit pairing request and accept handshake. One device selects another from its device list and sends a request; the recipient approves or declines. Connection setup only proceeds after approval.
- **BREAKING** Replace the current symmetric auto-offer with an initiator/responder model. Today both sides fire an offer simultaneously (`webrtc.js:236` and `app.js:179`), producing glare where neither connection establishes reliably. An explicit request gives exactly one initiator.
- Make the signaling endpoint configurable rather than hardcoded to `location.host`, so the same client build works against a self-hosted Node server, a hosted relay, or no server at all.
- Add a hosted signaling relay in a separate `worker/` directory, one Durable Object per subnet room, using the hibernation WebSocket API. Deployed independently of the Pages bundle.
- Add a test that asserts peers in different subnets never observe each other. This is the project's most important test.
- Keep `npm start` self-hosting fully supported. No deployment path is removed.

## Capabilities

### New Capabilities

- `lan-isolation`: Subnet-scoped rooms that prevent peers on different networks from discovering or connecting to each other, and the trust boundary that results.
- `pairing-consent`: Explicit request and accept handshake with a single initiator, so connection establishment is mutual, intentional, and free of offer collision.

### Modified Capabilities

None. `openspec/specs/` is empty, so no existing capability requirements are being changed.

## Impact

- `server/server.js` — room partitioning, request/accept message types, heartbeat, and the path-traversal fix.
- `client/webrtc.js` — initiator/responder roles, endpoint configuration, reconnect and cleanup correctness.
- `client/app.js` — device list and pairing state machine.
- `client/ui.js` — request banner and accept/decline controls on device cards.
- `worker/` — new directory. Cloudflare Worker with a Durable Object per room. Separate deploy, own `wrangler` config. Not part of the Pages build.
- `package.json` — optional scripts for worker deploy and isolation tests.
- Cloudflare Workers Free tier covers the expected load at $0 (verified against published pricing): 100,000 requests/day, no charge for duration or bandwidth, WebSocket messages not billed. The Worker must use the hibernation API — without it, an open socket accrues duration charges continuously and exhausts the daily allowance.
- Security note: isolation is enforced by application code, not by the network. A relay will happily forward between any two peers whose requests it accepts. The isolation logic and its test are therefore security-critical, not optional.