# LanShare signaling relay (hosted)

A hosted signaling relay for LanShare: a Cloudflare Worker fronting **one
Durable Object (`ScopeRoom`) per LAN scope**. It speaks the same wire contract
as `server/server.js`, so a client cannot tell which backend it talks to. It
deploys independently of the Pages bundle — nothing here imports or builds the
client, and deploying it never touches the site.

Files:

- `worker.js` — Worker entry (scope routing, `/status`) + `ScopeRoom`.
- `scope.js` — scope derivation (mirrors `server/server.js`).
- `room.js` — pure in-memory room logic (mirrors the Node scoped registry).
- `protocol.js` — duplicated message-type tables (see below).
- `wrangler.json` / `package.json` — deploy config, independent of the repo
  root `package.json` and the Pages build.

## Deploy

Prerequisites: a Cloudflare account and Node 16+.

```sh
cd worker
npm install -g wrangler   # or: npx wrangler <command>
wrangler login
wrangler deploy           # reads wrangler.json, no build step, no Pages bundle
```

Local preview (no account needed):

```sh
cd worker
wrangler dev              # serves http://127.0.0.1:8787, /status included
npm test                  # from worker/: runs the relay test slice in Node
```

Dashboard clicks (verify the deploy, all read-only):

1. Cloudflare dashboard → **Workers & Pages** → open
   `lanshare-signaling-relay`.
2. **Settings → Bindings**: confirm a Durable Object binding `SCOPE_ROOM`
   → class `ScopeRoom` (declared in `wrangler.json`, created by deploy).
3. **Observability → Metrics**: watch requests and **duration**; with
   hibernation, idle rooms bill zero (see the math below).
4. Visit `https://<your-worker>.workers.dev/status` — it reports uptime,
   connections routed, and the duration budget.
5. Optional: **Domains & Routes** → add a custom route, then point the
   client at it via the configured signaling endpoint.

Rollback: `wrangler deploy` of any previous version, or delete the Worker.
There is no persisted state anywhere, so there is nothing to migrate back.

## Scope routing

The edge derives a scope per connection and routes to the Durable Object
named by that scope (`SCOPE_ROOM.idFromName(scope)`), so all peers in one
scope share one authoritative roster:

1. `CF-Connecting-IP` (authoritative; set by the Cloudflare edge).
2. Fallback: first entry of `X-Forwarded-For` (e.g. local `wrangler dev`).
   Still passed through strict scope parsing, so spoofing it can only yield
   some other valid scope or nothing.
3. Fallback: unknown. A null scope is parked on the `unknown-scope`
   quarantine key whose room logic **grants nothing**: empty peer list, no
   broadcasts, every relay refused — including from other unknown peers.

Scopes are IPv4 `/24` and IPv6 `/64`, derived only from the connection
address, never from client-supplied fields (`scope` / `subnet` / `room` on a
message are ignored). A plain Worker with an in-memory map would be wrong
here — isolates would split one scope across instances that never see each
other — which is why one Durable Object per scope is the routing primitive.

## Hibernation is mandatory (the ~29-hour math)

Durable Objects bill wall-clock duration while resident in memory. The Free
tier daily allowance works out to roughly **104,000 object-seconds**:

- 104,000 ÷ 3,600 ≈ **28.9 hours — about 29 hours** of object time per day.
- One always-resident room burns **86,400** object-seconds/day, leaving only
  ~17,600 (~4.9h) for everything else.
- **Two** always-resident rooms burn 172,800 object-seconds/day — over the
  allowance, so the tier starts failing operations for the rest of the day.

Every accepted connection therefore uses the WebSocket Hibernation API
(`acceptWebSocket` + `webSocketMessage` / `webSocketClose`), which lets an
idle room sleep at **zero** cost. Concretely:

- `worker.js` contains exactly one accept path, the hibernating one. The
  legacy non-hibernating upgrade call appears nowhere in this directory.
- `assertHibernationInUse` runs in the `ScopeRoom` constructor and again at
  each upgrade: without the hibernation API the room throws at startup
  instead of silently running on the billing path.
- `tests/worker.test.js` asserts at the source level that `acceptWebSocket`
  is present and no bare accept call exists (Node has no DO runtime, so the
  check is textual and documented as such in the test).
- The allowance constants live next to the code that must respect them
  (`DURATION_ALLOWANCE_OBJECT_SECONDS = 104000`,
  `SECONDS_PER_DAY = 86400`), and the test asserts this README's numbers
  match those constants, so the constraint survives edits.

## Duration observability

- `GET /status` on the Worker: uptime, connections routed, distinct scopes
  seen, hibernation flag, and the allowance constants above.
- `GET /status` routed to a room (same scope headers): live peer count,
  scopes present, and recorded cross-scope refusals.
- Every routed upgrade logs scope + totals, so consumption is visible in
  `wrangler tail` / dashboard logs well before exhaustion.

(Worker-level counters are per-isolate approximations; the allowance math is
exact and the hibernation guarantee is what keeps usage near zero when idle.)

## No persisted state

Room membership is **in-memory only**: a `Map` plus an in-memory violations
log. Nothing is written to Durable Object storage — no roster, no pairing
history, no trust state. After a hibernation wake the roster is rebuilt from
per-socket attachments (connection state held by the runtime, not stored
rows). A stored roster would outlive the session and become a record of who
was on a network; everything is re-established on connect instead.

## Shared protocol (no silent divergence)

`server/server.js` is canonical. `protocol.js` duplicates its two small
constant tables (`MESSAGE_TYPES`, `ERROR_CODES`) because Node (CommonJS) and
Workers (ESM) cannot import each other's modules without dragging
incompatible machinery along. The duplication is pinned:
`tests/worker.test.js` reads `server/server.js` source and asserts every
message type there is spelled identically here, and that `room.js` /
`worker.js` use the constants instead of inline strings. Add a message type
in both places or the suite fails.

Pairing/error shapes (`pairing_request` / `pairing_response` naming the
recipient via `to`, plus `pairing_error` with `unavailable` / `cross_scope`,
`chat_error` with `undeliverable`, and `register_error` with `invalid`)
mirror the Node server exactly, including private-chat never falling back to
broadcast and cross-scope pairing attempts answering the requester without
leaking the target's existence.

## Limitations (threat model pointers)

- Isolation is **application-enforced**, not network-enforced: the relay
  forwards between any two peers its scope check accepts, so the scope check
  and its test are security-critical.
- A `/24` is coarse: two networks sharing one `/24` appear together
  (conservative direction — it never splits genuinely far-apart networks).
- Behind carrier-grade NAT, unrelated users can share one public address and
  therefore one scope. Documented limitation, not oversight.
- File contents never traverse signaling in any mode: the relay sees only
  connection metadata.
