// worker/scope.js
// Scope derivation for the hosted relay.
//
// The expandIPv6 / scopeForAddress functions below MIRROR server/server.js
// exactly (same normalization, same edge cases, same null-on-malformed
// contract). server/server.js is canonical; tests/worker.test.js asserts
// agreement between the two implementations over a shared battery of inputs,
// so any drift fails loudly. Rationale for duplication over importing is
// documented in worker/protocol.js (Node CJS vs Worker ESM).
//
// NEVER consult client-supplied input for scope; always derive from the
// connection address as seen by the edge (see deriveScopeFromHeaders).

// ---------------------------------------------------------------------------
// Pure IP -> scope mapping (mirrors server/server.js).
// IPv4 -> /24, IPv6 -> /64. Malformed input -> null, never throws.
// ---------------------------------------------------------------------------

export function expandIPv6(addr) {
  if (!/^[0-9a-fA-F:]+$/.test(addr)) return null;
  if (addr.includes('::')) {
    if (addr.indexOf('::') !== addr.lastIndexOf('::')) return null;
    const parts = addr.split('::');
    const head = parts[0] ? parts[0].split(':') : [];
    const tail = parts[1] ? parts[1].split(':') : [];
    for (const g of [...head, ...tail]) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    }
    const missing = 8 - (head.length + tail.length);
    if (missing <= 0) return null;
    const full = [...head, ...Array(missing).fill('0'), ...tail];
    if (full.length !== 8) return null;
    return full.map((g) => parseInt(g, 16));
  }
  const groups = addr.split(':');
  if (groups.length !== 8) return null;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
  }
  return groups.map((g) => parseInt(g, 16));
}

export function scopeForAddress(ip) {
  try {
    if (typeof ip !== 'string') return null;
    let addr = ip.trim();
    if (addr.length === 0) return null;

    // Strip "[v6]:port" or "[v6]" bracketing if present.
    if (addr.startsWith('[')) {
      const m = addr.match(/^\[([^\]]+)\](?::\d+)?$/);
      if (!m) return null;
      addr = m[1];
    }
    // Strip zone id (fe80::1%eth0).
    const pct = addr.indexOf('%');
    if (pct !== -1) addr = addr.slice(0, pct);
    if (addr.length === 0) return null;

    // IPv4-mapped IPv6 (::ffff:1.2.3.4) -> treat as the embedded IPv4.
    if (addr.includes(':') && addr.includes('.')) {
      const m = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
      if (m && addr.toLowerCase().startsWith('::ffff:')) {
        addr = m[1];
      } else {
        return null;
      }
    }

    // IPv4 -> /24.
    if (!addr.includes(':')) {
      if (!addr.includes('.')) return null;
      const parts = addr.split('.');
      if (parts.length !== 4) return null;
      const nums = [];
      for (const p of parts) {
        if (!/^\d{1,3}$/.test(p)) return null;
        const n = Number(p);
        if (!Number.isInteger(n) || n < 0 || n > 255) return null;
        nums.push(n);
      }
      return `v4:${nums[0]}.${nums[1]}.${nums[2]}.0/24`;
    }

    // IPv6 -> /64 (first 4 hextets, normalised).
    const groups = expandIPv6(addr);
    if (!groups) return null;
    const prefix = groups.slice(0, 4).map((g) => g.toString(16)).join(':');
    return `v6:${prefix}/64`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Edge scope derivation: CF-Connecting-IP, then X-Forwarded-For, then unknown.
// ---------------------------------------------------------------------------

function firstIpCandidate(value) {
  if (typeof value !== 'string') return null;
  const first = value.split(',')[0].trim();
  return first.length > 0 ? first : null;
}

function readHeader(headers, name) {
  if (!headers) return null;
  try {
    if (typeof headers.get === 'function') {
      const v = headers.get(name);
      return typeof v === 'string' ? v : null;
    }
    if (typeof headers === 'object') {
      const want = name.toLowerCase();
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === want) {
          const v = headers[k];
          if (typeof v === 'string') return v;
          if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
          return null;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

// Derive the room scope from request headers as seen by the edge.
// 1. CF-Connecting-IP (authoritative; set by the Cloudflare edge).
// 2. First entry of X-Forwarded-For (fallback when the direct header is
//    absent, e.g. local `wrangler dev`; treated as a hint and still passed
//    through scopeForAddress, so spoofing it can only ever produce some
//    other valid scope or nothing at all).
// 3. null -- unknown-scope-grants-nothing (see scopeKeyForDO and room.js:
//    a null scope receives an empty peer list and every relay refuses).
export function deriveScopeFromHeaders(headers) {
  const fromCf = firstIpCandidate(readHeader(headers, 'cf-connecting-ip'));
  if (fromCf) {
    const scope = scopeForAddress(fromCf);
    if (scope) return scope;
  }
  const fromXff = firstIpCandidate(readHeader(headers, 'x-forwarded-for'));
  if (fromXff) {
    const scope = scopeForAddress(fromXff);
    if (scope) return scope;
  }
  return null;
}

// Durable Object routing key for a scope. One DO per scope key. A null
// (unknown) scope is parked on a single quarantine key whose room logic
// grants it no peers -- see room.js -- so unknowns can neither observe nor
// disturb any real scope, nor each other.
export const UNKNOWN_SCOPE_KEY = 'unknown-scope';

export function scopeKeyForDO(scope) {
  if (typeof scope === 'string' && scope.length > 0) return scope;
  return UNKNOWN_SCOPE_KEY;
}
