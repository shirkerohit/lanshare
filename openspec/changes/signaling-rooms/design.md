# Design

## Context

See `proposal.md` — Why.

Current state of the signaling path:

- `server/server.js` holds a single flat `peers` Map keyed by peer id. `handleRegister` sends the whole map to a newcomer and broadcasts every join to every peer. There is no scope, room, or subnet concept.
- `handleRegister` overwrites the map entry for a peer id without checking whether a live connection already owns it. The superseded socket's `close` handler then deletes the entry by id regardless of which socket owns it.
- No heartbeat exists. `ws.readyState` is checked before sending, but a half-open socket stays in the map indefinitely.
- `webrtc.js:245` treats `peer_left` as a reason to `_cleanupPeer`, which closes the RTCPeerConnection. Signaling and data have different failure domains; the code treats them as one.
- `webrtc.js:33` derives the socket URL from `location.host`, so the endpoint cannot be configured.
- `_handleConnectionFailure` retries unconditionally, including in manual mode where no signaling exists to answer a new offer.
- Both sides initiate: `webrtc.js:236` initiates for every entry in `peer_list`, and `app.js:179` initiates on `peer_joined`.

Constraints worth knowing:

- `ws` is the only runtime dependency, and the project deliberately has no framework and no build tool for the client.
- Cloudflare Workers Free tier: 100,000 requests/day, no charge for duration or bandwidth, WebSocket messages not billed as requests, WebSocket connection counted as one request. Verified against published pricing.
- Durable Objects on the Free tier are SQLite-backed only.
- The self-hosted Node server must keep working without any change to how it is run.

## Goals / Non-Goals

**Goals**

- Make network-scoped isolation correct and testable, in both the Node server and the Worker.
- Give connection setup a single, explicit initiator.
- Stop signaling faults from destroying working data channels.
- Make the signaling endpoint a configuration input rather than a hardcoded constant.
- Keep the whole hosted path at zero cost.

**Non-Goals**

- TURN relay support. Devices behind symmetric NAT will not connect; the app is a LAN tool and this is out of scope for this change.
- Authenticating peers beyond the subnet boundary. There are no accounts by design.
- Room selection by user-chosen name. Scope is derived from the network, not chosen, so there is nothing to share and nothing to mistype.

## Decisions

### Scope derived from the client address, not chosen by the user

Derive the room key from the connection's source IP, truncated to a /24 (or /64 for IPv6), and never accept a scope from the client.

**Why:** this makes isolation impossible to bypass by protocol. A user-chosen room name is a shared secret that must be communicated, mistyped, or leaked — and it would reintroduce exactly the friction this change removes. Deriving it from the network means isolation needs no user action and no secret.

**Alternative considered:** IPv6 privacy addresses change per network and would fragment a household into many scopes. Handled by grouping on the /64 prefix, which is stable per site.

**Trade-off:** two devices on different networks that share one /24 appear together. For a LAN tool this is an acceptable approximation of "same local network", and it is conservative in the safe direction — it never merges networks that are genuinely far apart. A NAT'd network and a different physical network could share a /24 in theory; that is a documented limitation rather than an oversight.

**Trade-off:** the client address as seen by the server. Behind a NAT this is the household's public address, which is still a correct grouping. Behind a carrier NAT it is shared by many unrelated users, which would group strangers. This is called out explicitly in the threat model.

### One Durable Object per scope, with hibernation

Map scope key to a Durable Object instance so all peers in a scope share one authoritative connection list.

**Why:** a plain Worker holding an in-memory room map is incorrect. Workers run many isolates, so two peers in the same scope can land on different instances and never observe each other. A Durable Object is a single instance per key, which makes it the correct primitive for this.

**Why hibernation is mandatory:** Durable Objects accrue duration charges for as long as they are active in memory. Published figures show the Free tier's daily duration allowance works out to roughly 104,000 object-seconds — about 29 hours. A single always-open room exhausts that, and the tier then fails operations for the rest of the day. The WebSocket Hibernation API lets an idle object sleep and be billed nothing, which is what makes the free tier viable. This is the single most important implementation constraint in this design.

**Alternative considered:** a plain Worker with no Durable Object at all, accepting that scope members may land on different isolates. Rejected: it produces a bug that looks like random non-discovery and is very hard to diagnose.

### Node server and Worker implement one shared protocol

Define the signaling message contract once, in a module both runtimes import. `server/` and `worker/` differ only in transport and peer-registration mechanics.

**Why:** two independent implementations of an isolation guarantee will drift, and the failure mode is silent. The Node server is what self-hosters run; the Worker is what most users hit. Both must enforce the same boundary.

### Explicit request/accept with a single initiator

Replace mutual auto-offer with: request → accept → initiator sends offer → responder answers.

**Why:** an explicit request makes the initiator unambiguous, which resolves the glare problem structurally rather than through negotiation logic. It also matches the stated product flow — select a device, request, both confirm.

**Glare handling:** if a request arrives from a peer that already requested us, resolve deterministically by comparing peer ids and letting the lower id initiate. Cheap, no negotiation state machine.

### Signaling loss must not close a data channel

`peer_left` removes a device from the list; it does NOT tear down an established `RTCPeerConnection`. Teardown happens only when the local user explicitly disconnects, or after a bounded reconnect period with no signaling recovery.

**Why:** the data channel is the product. Signaling is only a setup channel. Currently a momentary WebSocket blip destroys a working link and interrupts transfers.

**Trade-off:** a genuinely departed peer leaves a channel open until teardown triggers. Bounded by the reconnect window and by `connectionState` transitions on the connection itself, which still detect real failure.

### Endpoint from configuration with a safe default

Resolve the endpoint in order: explicit configuration, then same-origin default, then none. `?static` and the existing build-time static flag continue to force manual mode.

**Why:** one build must serve all three deployments. Defaulting to same-origin preserves the current self-host experience with no configuration at all.

### Room membership is in-memory only

No peer roster, pairing history, or trust state is persisted on either server.

**Why:** a stored roster would outlive the user's session and become a record of who was on their network. It is also unnecessary — everything is re-established on connect.

## Risks / Trade-offs

**The isolation boundary is application-enforced, not network-enforced** → The relay will forward between any two peers whose requests it accepts. This is why the isolation test is the first task and is treated as release-blocking. The threat model documents that a code defect in the scope check would expose cross-network peers.

**Carrier NAT may group unrelated users** → Documented as a limitation. Consider a later refinement that also weighs the `User-Agent` or a client-supplied network hint, treating any client-supplied input as a hint only and never as authoritative.

**Removing the signaling teardown path could leak a channel to an absent peer** → Bound it: teardown on explicit disconnect, on `connectionState` reaching failed or closed, or after the reconnect window elapses with no signaling recovery.

**A /24 is a coarse definition of "local network"** → Accept and document. A user-chosen scope would be more precise and would reintroduce the friction being removed.

**Hibernation misconfiguration is expensive** → Add an explicit assertion or startup check in the Worker that the hibernation API is in use, and record duration usage visibly so the daily allowance is observable before it is exhausted.

**Server mode and manual mode now share the pairing-consent flow** → Manual mode has no server to carry a request, so the request is encoded into the link or code. Keep the user-visible states identical across modes so the mental model is one thing.

## Migration Plan

1. Add the scope derivation and partitioning to the Node server only, with the isolation test. This alone stops cross-network visibility on the self-hosted path.
2. Add the request/accept handshake to the Node server and the client.
3. Make the endpoint configurable; default behaviour unchanged.
4. Fix the signaling-loss teardown behaviour and stale-peer race.
5. Add the Worker with the same shared protocol module, deploy it, and add the endpoint configuration pointing at it.

At every step the app remains usable: steps 1-2 remove the copy-paste requirement for self-hosters before any hosted infrastructure exists. Rollback is a revert; no persisted state exists in any step, so there is nothing to migrate back.

## Open Questions

- The exact reconnect window duration before an unconfirmed channel is torn down is a tuning constant, to be set during implementation against observed behaviour.
- Whether to also group by client-supplied network hint, to narrow the carrier-NAT case, is deferrable. It does not change the specs, the isolation test, or the task breakdown, and client-supplied input is never authoritative in either variant.