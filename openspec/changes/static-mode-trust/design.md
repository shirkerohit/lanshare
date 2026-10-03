# Design

## Context

See `proposal.md` — Why.

Four concrete defects, all verified against the current source:

```
  ui.js:394-410       typeLabel = peer.info.type        ->  ${typeLabel}   unescaped
  server.js:153-163   handleChat -> broadcast(ws, ...)  ->  private passed through, no filter
  server.js:37        path.join(__dirname,'..','client', req.url)
  server.js:204-207   startup banner commented out
```

For the first: `esc()` exists at `ui.js:964` and is applied to peer name (`ui.js:409`), chat body (`ui.js:579`), and known-device labels (`ui.js:263`). `type` is the only peer field that reaches `innerHTML` unescaped. The value arrives from `detectDeviceType()` on the honest client but is arbitrary in the wire message, and a relay reachable from the public internet means an arbitrary sender.

For the second: `handleChat` builds a message object carrying `private` and `target` and then calls `broadcast`, which sends to every peer except the sender. The `target` field is never consulted. The client then renders the message with a private tag, so the UI actively asserts a confidentiality that the transport does not provide.

For the third: `scripts/serve-dist.js:24-33` already implements the correct pattern — normalise, strip leading separators, strip `..` segments, `path.resolve`, then verify the result starts with the root plus a separator. The server simply does not use it.

Constraints and consequences worth naming before choosing:

- Confirmation before send interacts with the streaming sink in `harden-transfer-integrity`, which needs a user gesture to obtain a file write handle. The two changes compose: the confirmation is the gesture.
- Confirmation before send means drag-and-drop becomes drop, confirm, send. One extra tap per transfer, accepted deliberately.
- Per-pairing request confirmation is implemented in `signaling-rooms`. This change adds the file-level confirmation gate, which is separate and additive.
- No test infrastructure exists yet; `harden-transfer-integrity` task group 1 adds it.
- Peer identity is a hash-derived generated name with no rename capability, by decision. That reduces one labelling concern but means a user cannot always tell two similar devices apart, so confirmations must name the device explicitly.

## Goals / Non-Goals

**Goals**

- No peer-supplied value can execute as code or escape its rendering context.
- No file content transmits without an explicit, per-transfer user confirmation.
- Confidential messages reach exactly one recipient.
- Path confinement identical across both bundled servers.
- The boundary and its limits documented, including what is *not* guaranteed.

**Non-Goals**

- Authenticating peers. There are no accounts and none are being added.
- Encrypting the signaling channel beyond the transport's own TLS.
- Content Security Policy rollout or other defence-in-depth hardening not tied to a concrete defect.
- Obfuscation or bundling. Not related to the defects found.

## Decisions

### Escape at the render boundary, then audit for the pattern

Apply `esc()` to `typeLabel` and audit every `innerHTML` interpolation for peer-supplied values, converting those to text nodes where practical.

**Why:** the bug exists because the escaping is applied call-by-call rather than enforced by a boundary. Two mitigations: escape at the point of interpolation so a new field cannot be forgotten, and audit existing sites so no other instance is already present.

**Alternative considered:** a single sanitiser at the message-ingestion layer that escapes all peer fields on receipt. This is attractive — one choke point, nothing downstream can be unsafe — but it corrupts data that must round-trip, such as a name the user may re-display, and it double-escapes anything already escaped. Rejected in favour of escaping at render, plus a lint-style test that fails on an unescaped peer field in device-list and message code.

**Alternative considered:** set `textContent` on the specific nodes. Preferred where a node holds only one value, since it removes the class of bug entirely rather than fixing an instance.

### Confirmation is per transfer, never remembered

Require a confirmation dialog before the first chunk of every transfer, naming the file and the destination device. No remembered approval, per explicit decision.

**Why:** this is a privacy product whose central claim is that files do not leave without intent. A prompt before each send is the clearest expression of that. It also makes the destination unambiguous at the moment of consent, which matters when device names are generated and similar.

**Trade-off, accepted:** one extra tap per transfer, and drag-and-drop is no longer a single gesture. Recorded as a deliberate cost of the trust model, not an oversight.

**Interaction with streaming:** the confirmation provides the user gesture the streaming sink needs, so the two changes compose rather than competing. Design this change so the confirmation fires before any file handle is requested.

### Fix confidential delivery in the server, not the client

Route a confidential message only to its recipient; refuse to broadcast.

**Why:** the defect is in the transport. Filtering in the client would leave the content on every recipient's wire, which is exactly the exposure being fixed. The server must not emit a confidential message to a non-recipient, including as a fallback when the recipient is unreachable.

**Alternative considered:** point-to-point delivery over the existing data channel instead of the server. Better privacy still, since the server never sees even the plaintext. Considered seriously because the two devices are already directly connected by the time chat is usable.

**Why not now:** private chat is currently usable before a direct channel exists, so switching delivery would break it for the pre-connection case. The server-side fix is the minimal correct change that removes the leak now. Moving confidential chat onto the direct channel once `signaling-rooms` guarantees a channel after pairing is a natural follow-up and is noted in the threat model as the stronger option.

### Validate at the ingestion boundary

Reject registrations missing a name or identifier, and reject oversized values, rather than accepting and truncating.

**Why:** `addPeer` reads `info.name` at `ui.js:338` and `app.js:176` without guarding, so a registration lacking `info` throws and takes the app down. Validating at ingestion means malformed input never reaches state that assumes it is well-formed.

**Trade-off:** a legitimately odd but harmless client is refused. Acceptable — the honest client always sends a name, and the alternative is a client that can be crashed by a malformed peer.

**Note:** refusal must not affect existing sessions. Validation happens per registration, not as a global sweep.

### Reuse the traversal pattern already in the repo

Apply the resolution-and-prefix-check pattern from `scripts/serve-dist.js` to `server/server.js`, and add a shared test covering both servers.

**Why:** the correct implementation is already written and reviewed in this repository. Duplicating it keeps both servers consistent and makes the shared test meaningful — one rule, two implementations, one test.

**Alternative considered:** route server traffic through the existing static serving code so there is one implementation. Cleaner, but a larger refactor of a file that is otherwise untouched by this change. Deferred; the shared test prevents divergence in the meantime.

### Document the boundary including its limits

Write a threat model stating what each party observes per hosting mode, that file contents cross neither, that isolation is application-enforced, the isolation granularity and its limits, and why no short numeric pairing code exists.

**Why:** the isolation boundary is enforced by application logic. If that logic has a defect, cross-network peers become visible. A reader of the codebase must be able to find that fact stated plainly, together with the granularity approximation and the carrier-NAT caveat. Documentation is part of the security posture here, not an afterthought.

## Risks / Trade-offs

**Extra confirmation tap on every transfer** → Accepted deliberately. Make the dialog show file name, size, and destination so confirming is a fast informed action rather than a reflexive dismissal. The pairing-request confirmation from `signaling-rooms` covers connections, so this one covers data.

**A stricter registration check could refuse a legitimate client** → Validate only the fields the client actually requires, and refuse with a reason rather than silently dropping.

**Confidential chat still reaches the signaling server** → Strictly better than the current broadcast. Record in the threat model that direct-channel delivery is the stronger option and should follow once a channel is guaranteed.

**Node's HTTP server is permissive about the raw request path** → The check must normalise before resolving, and must compare against the resolved root with a separator so a sibling directory with a shared name prefix cannot pass. Cover with tests rather than relying on inspection.

**Audit may find further unescaped peer fields** → Treat findings as in scope for this change rather than deferring; each is the same bug class with the same fix.

**Rendering generated device names, which users cannot rename** → Confirmations must name the device explicitly and unambiguously so a user can still identify the destination despite similar generated names.

## Migration Plan

1. Fix the `type` escaping and complete the `innerHTML` audit, with tests that fail if a peer field reaches `innerHTML` unescaped.
2. Add registration and payload validation at the ingestion boundary.
3. Fix confidential chat routing in the server, with tests for single-recipient delivery and refusal to broadcast.
4. Fix path traversal in `server/server.js` and add a shared test covering both servers.
5. Add the confirmation gates for sending and receiving.
6. Restore the startup banner and address reporting.
7. Write the threat model.

Each step is independently revertible and none changes a wire format, so there is no migration path for existing users beyond a normal redeploy.

## Open Questions

None. Moving confidential chat onto the direct channel is a deliberate follow-up rather than an open question — it depends on `signaling-rooms` landing first, and the current server-side fix is correct and complete on its own.