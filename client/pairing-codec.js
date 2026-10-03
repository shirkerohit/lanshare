// client/pairing-codec.js
// Compact pairing payload codec: SDP text in, single-line string out, and back.
//
// Pipeline (order matters): TRIM the SDP text by whole candidate lines, then
// DEFLATE the trimmed text (raw deflate, no wrapper), then ENCODE the bytes as
// unpadded base64url on a single line. Decoding reverses the three steps and
// returns the trimmed SDP byte-identical to what `trimCandidates` produces,
// so `decodePayload(await encodePayload(sdp)) === trimCandidates(sdp)`.
//
// Trimming removes whole `a=candidate:` lines only; no other line is ever
// touched, added, or reordered, and no substring edit is performed within a
// line. Kept lines (including their original line endings) survive verbatim.
// Dropped lines:
//
//   - TCP candidates (UDP host candidates suffice on a LAN)
//   - IPv6 link-local (fe80::/10) and unique-local (fc00::/7) candidates
//   - IPv4 candidates on ranges that cannot reach a LAN peer: link-local
//     169.254.0.0/16, TEST-NET-1/2/3 (192.0.2.0/24, 198.51.100.0/24,
//     203.0.113.0/24), and CGNAT 100.64.0.0/10
//   - duplicate candidates for an already-seen IP (first wins)
//
// All RFC1918 IPv4 host candidates (10/8, 172.16/12, 192.168/16) are kept,
// because from SDP text alone there is no way to know which local interface
// will actually route to the peer. Structural lines (`a=end-of-candidates`,
// ufrag, pwd, fingerprint, setup, mid, sctp-port, everything else) are never
// dropped.
//
// Compression uses raw deflate with the implementation selected at runtime:
// under Node, `require('zlib')` (deflateRawSync/inflateRawSync); in browsers,
// the native `CompressionStream('deflate-raw')` /
// `DecompressionStream('deflate-raw')`. Both directions produce and accept
// the same raw-deflate byte stream, so a payload encoded on one decodes on
// the other. Preferring zlib under Node is deliberate, not just convenient:
// Node's DecompressionStream re-emits an inflate failure as an uncaught
// exception on stream teardown even when the read side already delivered (and
// the caller already handled) the failure, which would crash the process on
// exactly the malformed-input paths this module must report cleanly.
//
// Usable from a browser via `window.PairingCodec` and from Node via require()
// so the wire format can be tested without a browser.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PairingCodec = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Base error for every failure raised by this module. Subclasses give the
  // failure a stable `name` so callers (and tests) can distinguish "nothing
  // usable to encode" from "input was malformed" without parsing messages.
  function PairingCodecError(message) {
    const err = new Error(message);
    err.name = 'PairingCodecError';
    return err;
  }

  // The SDP had no candidate lines left after trimming (or had none to begin
  // with): there is nothing that could connect, so no code is produced.
  function NoUsableCandidatesError(message) {
    const err = new Error(message);
    err.name = 'NoUsableCandidatesError';
    return err;
  }

  // The pairing code given to `decodePayload` was empty, used characters
  // outside base64url, was truncated/corrupted, or did not decompress to an
  // SDP session description. The message always names what was wrong.
  function MalformedPayloadError(message) {
    const err = new Error(message);
    err.name = 'MalformedPayloadError';
    return err;
  }

  const CANDIDATE_PREFIX = 'a=candidate:';

  // Lazily load Node's zlib only when the native Web Streams compression API
  // is unavailable. Guarded so browsers (where `require` does not exist)
  // never touch it.
  function nodeZlib() {
    try {
      if (typeof require === 'function') return require('zlib');
    } catch (_) {
      // Fall through to null: caller reports "no implementation available".
    }
    return null;
  }

  function hasNativeDeflate() {
    return typeof CompressionStream !== 'undefined';
  }

  function hasNativeInflate() {
    return typeof DecompressionStream !== 'undefined';
  }

  function textToBytes(text) {
    return new TextEncoder().encode(text);
  }

  function bytesToText(bytes) {
    try {
      // fatal: reject non-UTF-8 bytes instead of silently substituting U+FFFD.
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
      throw MalformedPayloadError(
        'pairing code decompressed to bytes that are not valid UTF-8 text; ' +
          'the code is corrupted or is not a LanShare pairing code'
      );
    }
  }

  // --- base64url (unpadded) -------------------------------------------------

  const B64URL_ALPHABET =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  const B64URL_REVERSE = (() => {
    const table = new Array(128).fill(-1);
    for (let i = 0; i < B64URL_ALPHABET.length; i++) {
      table[B64URL_ALPHABET.charCodeAt(i)] = i;
    }
    return table;
  })();

  // Length of the unpadded base64url encoding of `byteLength` raw bytes.
  function base64UrlLength(byteLength) {
    const full = Math.floor(byteLength / 3);
    const rest = byteLength % 3;
    return full * 4 + (rest === 0 ? 0 : rest === 1 ? 2 : 3);
  }

  function base64UrlEncode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += B64URL_ALPHABET[b0 >> 2];
      out += B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
      if (i + 1 < bytes.length) out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
      if (i + 2 < bytes.length) out += B64URL_ALPHABET[b2 & 0x3f];
    }
    return out;
  }

  function base64UrlDecode(text) {
    // A length of 4k+1 can never be valid base64url: the input was cut short.
    if (text.length % 4 === 1) {
      throw MalformedPayloadError(
        `pairing code has invalid base64url length ${text.length} ` +
          '(a length of 4k+1 is impossible); the code is truncated'
      );
    }
    const out = [];
    let buffer = 0;
    let bits = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const value = code < 128 ? B64URL_REVERSE[code] : -1;
      // The caller pre-validates the charset, so this is a backstop only.
      if (value < 0) {
        throw MalformedPayloadError(
          `pairing code contains invalid base64url character '${text[i]}' ` +
            'at position ' + i + '; expected only [A-Za-z0-9-_]'
        );
      }
      buffer = (buffer << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buffer >> bits) & 0xff);
      }
    }
    return Uint8Array.from(out);
  }

  // --- raw deflate ----------------------------------------------------------

  async function pumpToEnd(readable) {
    const chunks = [];
    const reader = readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    let total = 0;
    for (const chunk of chunks) total += chunk.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  async function deflateRaw(bytes) {
    // Node first: see the header note about DecompressionStream teardown.
    // (The same preference keeps encode exact with `estimateEncodedSize`,
    // which must run synchronously and therefore always uses zlib.)
    const zlib = nodeZlib();
    if (zlib) return Uint8Array.from(zlib.deflateRawSync(Buffer.from(bytes)));
    if (hasNativeDeflate()) {
      const stream = new CompressionStream('deflate-raw');
      const writer = stream.writable.getWriter();
      try {
        await writer.write(bytes);
      } finally {
        await writer.close();
      }
      return pumpToEnd(stream.readable);
    }
    throw PairingCodecError(
      'no deflate implementation available: this environment has neither ' +
        "Node's zlib nor CompressionStream"
    );
  }

  async function inflateRaw(bytes) {
    // Node first: a native inflate failure would surface as an uncaught
    // exception on stream teardown and crash the process, defeating the
    // clean MalformedPayloadError contract of `decodePayload`.
    const zlib = nodeZlib();
    if (zlib) {
      try {
        return Uint8Array.from(zlib.inflateRawSync(Buffer.from(bytes)));
      } catch (err) {
        // Normalise zlib's terse errors; `decodePayload` adds context.
        throw PairingCodecError(
          `inflate failed (${err && err.message ? err.message : String(err)})`
        );
      }
    }
    if (hasNativeInflate()) {
      const stream = new DecompressionStream('deflate-raw');
      const writer = stream.writable.getWriter();
      let read;
      try {
        await writer.write(bytes);
        read = pumpToEnd(stream.readable);
      } finally {
        await writer.close();
      }
      return read;
    }
    throw PairingCodecError(
      'no inflate implementation available: this environment has neither ' +
        "Node's zlib nor DecompressionStream"
    );
  }

  // --- candidate classification ---------------------------------------------

  function parseIPv4(ip) {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (!match) return null;
    const octets = [match[1], match[2], match[3], match[4]].map(Number);
    if (octets.some((o) => o > 255)) return null;
    return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  }

  function inSubnetV4(ip, base, prefix) {
    const addr = parseIPv4(ip);
    if (addr === null) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((addr & mask) >>> 0) === ((base & mask) >>> 0);
  }

  function firstHextet(ip) {
    const zone = ip.indexOf('%');
    const bare = (zone === -1 ? ip : ip.slice(0, zone)).toLowerCase();
    const head = bare.split(':')[0];
    if (!/^[0-9a-f]{1,4}$/.test(head)) return null;
    return parseInt(head, 16);
  }

  function isIPv6LinkLocal(ip) {
    // fe80::/10: first hextet 0xfe80-0xfebb.
    const first = firstHextet(ip);
    return first !== null && (first & 0xffc0) === 0xfe80;
  }

  function isIPv6UniqueLocal(ip) {
    // fc00::/7: first hextet 0xfc00-0xfdff.
    const first = firstHextet(ip);
    return first !== null && (first & 0xfe00) === 0xfc00;
  }

  function unroutableIPv4Reason(ip) {
    if (inSubnetV4(ip, 0xa9fe0000, 16)) return 'link-local 169.254.0.0/16';
    if (inSubnetV4(ip, 0xc0000200, 24)) return 'TEST-NET-1 192.0.2.0/24';
    if (inSubnetV4(ip, 0xc6336400, 24)) return 'TEST-NET-2 198.51.100.0/24';
    if (inSubnetV4(ip, 0xcb007100, 24)) return 'TEST-NET-3 203.0.113.0/24';
    if (inSubnetV4(ip, 0x64400000, 10)) return 'CGNAT 100.64.0.0/10';
    return null;
  }

  // Normalise an IP/host for duplicate detection: lowercase, strip any
  // trailing IPv6 zone id ("%eth0") and surrounding brackets. Never applied
  // to the emitted line, only to the dedup set.
  function normalizeHost(ip) {
    let host = String(ip).toLowerCase();
    const zone = host.indexOf('%');
    if (zone !== -1) host = host.slice(0, zone);
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    return host;
  }

  // Returns a human-readable drop reason, or null when the candidate line
  // must be kept. `seenHosts` collects normalised IPs of kept candidates so
  // a repeated IP keeps only its first occurrence.
  function dropReasonForCandidate(line, seenHosts) {
    const fields = line.slice(CANDIDATE_PREFIX.length).split(/\s+/);
    // Not shaped like a candidate we understand (too few fields): keep it.
    // Trimming must never destroy connectivity it cannot classify.
    if (fields.length < 8) return null;
    const protocol = (fields[2] || '').toLowerCase();
    const ip = fields[4] || '';
    if (protocol === 'tcp') return 'TCP transport (UDP host candidates suffice on a LAN)';
    if (ip.includes(':')) {
      if (isIPv6LinkLocal(ip)) return 'IPv6 link-local (fe80::/10)';
      if (isIPv6UniqueLocal(ip)) return 'IPv6 unique-local (fc00::/7)';
    } else {
      const reason = unroutableIPv4Reason(ip);
      if (reason) return `unroutable IPv4 (${reason})`;
    }
    const host = normalizeHost(ip);
    if (seenHosts.has(host)) return `duplicate of already-kept IP ${ip}`;
    seenHosts.add(host);
    return null;
  }

  /**
   * Remove unreachable candidate lines from SDP text, whole lines only.
   * Every kept line (and the line-ending style) survives verbatim; only
   * dropped `a=candidate:` lines disappear.
   * @param {string} sdp session description
   * @returns {string} trimmed session description
   * @throws {PairingCodecError} when the input is not SDP text
   * @throws {NoUsableCandidatesError} when no candidate line survives
   */
  function trimCandidates(sdp) {
    if (typeof sdp !== 'string') {
      throw PairingCodecError(
        `expected SDP text as a string, got ${sdp === null ? 'null' : typeof sdp}`
      );
    }
    if (sdp.trim() === '') {
      throw PairingCodecError('expected SDP text, got an empty string');
    }
    const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
    // A trailing '' element means the input ended with a line break; it is
    // structural, so keeping it preserves the trailing break byte-exactly.
    const lines = sdp.split(eol);
    const seenHosts = new Set();
    let keptCandidates = 0;
    const kept = [];
    for (const line of lines) {
      // Classify on the line content; the emitted line is never modified.
      const probe = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (!probe.startsWith(CANDIDATE_PREFIX)) {
        kept.push(line);
        continue;
      }
      if (dropReasonForCandidate(probe, seenHosts) === null) {
        kept.push(line);
        keptCandidates++;
      }
    }
    if (keptCandidates === 0) {
      throw NoUsableCandidatesError(
        'SDP has no usable host candidates after trimming: every candidate ' +
          'was unreachable (TCP, IPv6 link-local/unique-local, unroutable IPv4) ' +
          'or a duplicate IP, so no pairing code was produced'
      );
    }
    return kept.join(eol);
  }

  /**
   * Trim, deflate, and base64url-encode SDP text into a compact single-line
   * pairing payload with no padding and no whitespace.
   * @param {string} sdp session description
   * @returns {Promise<string>} payload over [A-Za-z0-9-_]
   */
  async function encodePayload(sdp) {
    const trimmed = trimCandidates(sdp);
    let compressed;
    try {
      compressed = await deflateRaw(textToBytes(trimmed));
    } catch (err) {
      if (err && (err.name === 'PairingCodecError' || err.name === 'NoUsableCandidatesError')) throw err;
      throw PairingCodecError(`could not compress pairing payload: ${err && err.message ? err.message : String(err)}`);
    }
    return base64UrlEncode(compressed);
  }

  /**
   * Compress arbitrary text the same way `encodePayload` does, but WITHOUT
   * SDP candidate trimming. Used for manual pairing payloads, which are JSON
   * envelopes containing an SDP string rather than raw SDP text — trimming
   * operates on the SDP inside before this is called. Pairs with
   * `decodePayload`, which inflates without caring whether trimming happened.
   * @param {string} text
   * @returns {Promise<string>} base64url, unpadded, single line
   */
  async function encodeText(text) {
    if (typeof text !== 'string' || text === '') {
      throw PairingCodecError('cannot encode an empty pairing payload');
    }
    let compressed;
    try {
      compressed = await deflateRaw(textToBytes(text));
    } catch (err) {
      throw PairingCodecError(`could not compress pairing payload: ${err && err.message ? err.message : String(err)}`);
    }
    return base64UrlEncode(compressed);
  }

  /**
   * Reverse `encodePayload`: tolerate whitespace pasted from chat clients,
   * then base64url-decode, inflate, and return the trimmed SDP text.
   * @param {string} code pairing payload (whitespace tolerated)
   * @returns {Promise<string>} trimmed session description, byte-identical
   *   to what `trimCandidates` produced at encode time
   * @throws {MalformedPayloadError} naming what was wrong with the input
   */
  async function decodePayload(code) {
    if (typeof code !== 'string') {
      throw MalformedPayloadError(
        `pairing code must be a string, got ${code === null ? 'null' : typeof code}`
      );
    }
    // Chat clients wrap long lines: all whitespace is insignificant.
    const compact = code.replace(/\s+/g, '');
    if (compact === '') {
      throw MalformedPayloadError(
        'pairing code is empty; expected a base64url-encoded pairing payload'
      );
    }
    const badChar = /[^A-Za-z0-9\-_]/.exec(compact);
    if (badChar) {
      throw MalformedPayloadError(
        `pairing code contains invalid character '${badChar[0]}'; ` +
          'expected only base64url characters [A-Za-z0-9-_] with no padding, ' +
          'so the code was mistyped, truncated, or is not a LanShare pairing code'
      );
    }
    const raw = base64UrlDecode(compact);
    if (raw.length === 0) {
      throw MalformedPayloadError(
        'pairing code decoded to zero bytes; the code is truncated or corrupted'
      );
    }
    let inflated;
    try {
      inflated = await inflateRaw(raw);
    } catch (err) {
      throw MalformedPayloadError(
        'pairing code could not be decompressed ' +
          `(${err && err.message ? err.message : String(err)}); ` +
          'the code is truncated, corrupted, or not a LanShare pairing code'
      );
    }
    const text = bytesToText(inflated);
    if (!text.includes('v=')) {
      throw MalformedPayloadError(
        'decompressed payload is not a session description (missing v= line); ' +
          'the code is corrupted or is not a LanShare pairing code'
      );
    }
    return text;
  }

  /**
   * Synchronous estimate of the encoded payload length in characters,
   * without running the async compression pipeline.
   *
   * Where Node's zlib is available the estimate is exact (it compresses with
   * the same raw-deflate settings the native path uses); elsewhere it is a
   * conservative upper bound: the base64url length of the trimmed but
   * uncompressed SDP, which deflate only shrinks for payloads of this size.
   * @param {string} sdp session description
   * @returns {number} estimated (or exact) encoded character count
   */
  function estimateEncodedSize(sdp) {
    const trimmed = trimCandidates(sdp);
    const bytes = textToBytes(trimmed);
    const zlib = nodeZlib();
    if (zlib) {
      const compressed = zlib.deflateRawSync(Buffer.from(bytes));
      return base64UrlLength(compressed.length);
    }
    return base64UrlLength(bytes.length);
  }

  return {
    PairingCodecError,
    NoUsableCandidatesError,
    MalformedPayloadError,
    trimCandidates,
    encodePayload,
    encodeText,
    decodePayload,
    estimateEncodedSize,
  };
});
