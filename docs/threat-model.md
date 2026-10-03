# LanShare Threat Model

This document states what each party can observe in each hosting mode,
which boundaries are enforced by application logic rather than by the network,
and what is explicitly not guaranteed. It is a description of limits, not a
promise of safety. A reader deciding whether to deploy publicly should read
the limits first.

Status: isolation scoping, path confinement, and startup reporting are
implemented in `server/server.js`. The confidential-chat single-recipient
routing and the hosted relay worker are design intent, not yet implemented —
the affected sections say so explicitly.

## 1. Hosting modes and who observes what

There are three deployments to reason about: a self-hosted signaling server,
a hosted relay, and static hosting with manual pairing.

### Self-hosted signaling server (`npm start`)

The operator of the server can observe everything that crosses it:

- Source addresses of connections, peer identifiers, and advertised device
  information (name, device type) from registrations.
- Connection-setup metadata relayed between peers: SDP offers/answers and
  ICE candidates.
- Presence: joins, leaves, and the per-scope peer list served to newcomers.
- Chat message text, whiteboard events, and typing indicators relayed
  through the server.
- File contents cross the server never. File bytes move over WebRTC
  DataChannels directly between browsers; the server only ever sees signaling.

### Hosted relay (planned)

The hosted relay enforces the same protocol as the self-hosted server, so it
observes the same categories of data: source addresses, peer identifiers,
device information, connection-setup metadata, presence, chat text,
whiteboard events, and typing indicators. File contents cross it never, for
the same reason as above.

The difference is who operates it. A self-hosted server exposes that data to
the network owner. A hosted relay exposes the same data, from many unrelated
networks at once, to whoever operates the relay. Room membership is kept in
memory only and no roster, pairing history, or trust state is persisted on
either server.

The relay worker exists at `worker/` and a protocol-drift test pins its message
shapes to the Node server's, so the field parity claimed above is enforced by
test, not by intent.

### Static hosting with manual pairing

There is no signaling server. The static host serves application assets and
sees HTTP requests for those assets. A pairing payload carried in a URL
fragment is never sent to the host serving the application.

Whoever receives a pairing code — the pairing partner, and any chat client,
clipboard service, or share sheet used to move it — receives the payload
itself. A pairing payload contains the device's local addresses and DTLS
fingerprint. It is compressed, not encrypted.

## 2. What crosses the server

Connection setup, presence, chat, whiteboard, and typing indicator messages
are relayed through the signaling server when one is in use. File transfer
announcements, chunk metadata, and binary chunks travel over the direct
DataChannel between browsers and are never sent to the server.

Concretely: registering a peer, exchanging SDP and ICE, and sending a chat
or whiteboard message each produce a message the server reads and forwards.
Sending a file produces DataChannel traffic the server never sees.

## 3. Isolation is application-enforced, not network-enforced

Peers are grouped into scopes derived from the connection's source address as
seen by the server: IPv4 addresses are truncated to a /24, IPv6 addresses to
a /64. The scope is never accepted from client-supplied input. Presence,
signaling relay, chat, whiteboard, and typing messages are delivered only
within the sender's scope.

This boundary is enforced by application logic. The relay forwards between
any two peers whose requests it accepts, so a defect in the scope check would
expose peers across networks. The isolation check and its test are
release-blocking for exactly this reason.

Limits:

- A /24 (or /64) is a coarse definition of "local network". Two devices on
  different networks that share one /24 appear together. This is accepted as
  an approximation and fails in the grouping direction, never by merging
  networks that are genuinely far apart.
- Behind ordinary NAT, the household's public address still groups correctly.
  Behind carrier-grade NAT, many unrelated users share one public address and
  would be grouped as strangers. This is a documented limitation. A later
  refinement may weigh a client-supplied network hint to narrow this case;
  any such input would be treated as a hint only, never as authoritative.
- IPv6 privacy addresses change per network and would fragment one site into
  many scopes; grouping on the /64 prefix keeps one site together.

Cross-reference: the granularity, carrier-NAT caveat, and hibernation
constraint are defined in the signaling-rooms design, which this section
restates without change.

## 4. No short numeric pairing code

No short numeric or read-aloud pairing code is offered. A code short enough
to say or type is far too small to carry the session material a pairing
requires, and no amount of compression changes that. Any future short-code
design depends on a rendezvous service, which is a different architecture.

Pairing payloads are trimmed (unusable candidates removed), raw-deflated,
and base64url-encoded on a single line — compressed, not encrypted. Decoding
reverses the pipeline and returns session text that still carries the kept
host candidates' local addresses and the DTLS fingerprint. This exposure is
acceptable only because the payload goes to a deliberately selected partner,
not because the encoding hides anything.

## 5. Confidential chat reaches the signaling server

Enforced behavior: a message marked confidential is delivered only to its
named recipient and to no other device. It is not broadcast, does not appear
in any other device's history, is not delivered to a substitute recipient
when the intended one is unreachable (the sender is informed instead), and
non-confidential messages remain group-visible and visibly distinct.

Even so, a confidential message still reaches the signaling
server as plaintext relayed to one recipient. The stronger follow-up is
delivering confidential messages over the existing direct data channel, which
the server never sees. That option is deferred, not rejected: confidential
chat is usable before a direct channel exists today, so switching delivery
would break the pre-connection case. The server-side single-recipient fix
removes the leak now; direct-channel delivery should follow once pairing
guarantees a channel.

## 6. Static mode has no ICE server

The manual (static) pairing path configures no ICE server. Adding a STUN
server to improve connection success would disclose local addresses to a
third party, and the resulting server-reflexive candidates would roughly
double the payload size. The static deployment's claim of involving no third
party depends on this omission. The trade is deliberate: lower connection
success in exchange for a true privacy claim.

For contrast, the server-backed path configures public STUN servers, so a
server-mode deployment does involve a third party for address discovery.

## 7. Hosted-path cost posture

The hosted relay is designed to stay within the Cloudflare Workers Free
tier: 100,000 requests per day, no charge for duration or bandwidth, with
WebSocket messages not billed as requests and each WebSocket connection
counted as one request. The Worker must use the hibernation WebSocket API:
without it, an open socket accrues duration charges continuously and a single
always-open room exhausts the daily duration allowance (roughly 104,000
object-seconds, about 29 hours). When the allowance is exhausted, the tier
fails operations for the rest of the day — the failure mode is refusal, not
billing.

Verified against Cloudflare's published pricing pages (Workers pricing and
Durable Objects pricing, both updated within the last month): 100,000
requests/day on the Free plan, no charge for duration or bandwidth, WebSocket
messages not billed as requests. Re-check before deploying publicly, as tiers
change.

## 8. What is not guaranteed

- No authentication of peers. There are no accounts by design.
- No encryption of the signaling channel beyond what the transport provides,
  and no encryption of pairing payloads at all.
- No network-level separation between scopes. The scope check is the
  boundary, and its failure mode is cross-network visibility.
- No remembered trust. Pairing consent and per-transfer file confirmations
  are required each time; device names are generated and cannot be renamed,
  so confirmations must name the device explicitly.
- The short confirmation code derived from the pairing exchange is a
  tamper-evidence check, not full cryptographic authentication, and does not
  defend against an active attacker who can modify both payloads in flight.

## Source notes

Every factual claim above traces to one of the following. Inline citations
are omitted deliberately to keep the document readable; this section is the
audit trail.

- Per-mode observability, file contents cross neither: `server/server.js:3`,
  `server/server.js:243-272` (register, scoped peer list),
  `server/server.js:274-283` (signal relay), `server/server.js:285-298`
  (chat relay), `server/server.js:300-308` (whiteboard relay),
  `server/server.js:310-333` (scoped forward/broadcast),
  `server/server.js:424-461` (startup reporting); `README.md:46`,
  `README.md:75-77`; `docs/architecture.md:18-23`;
  `openspec/changes/static-mode-trust/specs/trust-and-privacy/spec.md:168-184`;
  `openspec/changes/static-mode-trust/design.md:98-101`.
- In-memory-only membership, no persistence:
  `openspec/changes/signaling-rooms/design.md:92-96`.
- Application-enforced isolation, granularity, carrier NAT, /64 privacy
  handling: `server/server.js:31-36`, `server/server.js:62-112`
  (`scopeForAddress`), `server/server.js:114-125` (`getRemoteAddress`),
  `server/server.js:221-241` (scoped recipient sets);
  `openspec/changes/signaling-rooms/design.md:42-52`;
  `openspec/changes/signaling-rooms/design.md:100-106`;
  `openspec/changes/signaling-rooms/proposal.md:5,38-39`;
  `openspec/changes/static-mode-trust/design.md:71-77,99-101`.
- No numeric code, entropy reason: `openspec/changes/pairing-friction/specs/pairing-ux/spec.md:155-157`;
  `openspec/changes/pairing-friction/design.md:34-38`.
- Payload compressed-not-encrypted, reveals addresses and fingerprint:
  `client/pairing-codec.js:4-8`, `client/pairing-codec.js:22-26`;
  `openspec/changes/pairing-friction/proposal.md:7,13,37,41`;
  `openspec/changes/pairing-friction/design.md:50-58`.
- Fragment never sent to host: `openspec/changes/pairing-friction/design.md:42-48`;
  `openspec/changes/pairing-friction/proposal.md:9,14`;
  `openspec/changes/pairing-friction/specs/pairing-ux/spec.md:32-57`.
- Confidential chat single-recipient routing: `server/server.js` (`handleChat` routes confidential messages via single-recipient send, never broadcast);
  `openspec/changes/static-mode-trust/proposal.md:9`;
  `openspec/changes/static-mode-trust/design.md:9-18,69-77,109`.
- Confidential single-recipient requirement:
  `openspec/changes/static-mode-trust/specs/trust-and-privacy/spec.md:81-108`;
  `openspec/changes/static-mode-trust/tasks.md:20-26`.
- Static mode keeps no ICE server, third-party disclosure reason:
  `client/webrtc.js:358-364`;
  `openspec/changes/pairing-friction/proposal.md:40`;
  `openspec/changes/pairing-friction/design.md:7,16-18,86-90`.
- Server-backed path uses public STUN: `client/webrtc.js:360-363`.
- Free-tier posture, hibernation, failure-is-refusal:
  `openspec/changes/signaling-rooms/design.md:20-22,54-60,108`;
  `openspec/changes/signaling-rooms/proposal.md:38`.
- Confirmation code tamper-evidence limit:
  `openspec/changes/pairing-friction/design.md:92-98`.
- Path confinement and startup legibility (context for the boundary):
  `server/server.js:127-165`, `server/server.js:190-214`,
  `server/server.js:424-461`;
  `openspec/changes/static-mode-trust/specs/trust-and-privacy/spec.md:110-129,153-167`.
