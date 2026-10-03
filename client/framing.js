// client/framing.js
// Self-describing binary envelope for chunked file transfer.
//
// Replaces the previous header/payload pair (a JSON `chunk_meta` message
// followed by a bare binary buffer) which required the receiver to correlate
// the two out of band, in arrival order, against a single pending-metadata slot
// per peer. Every message here carries its own routing and ordering
// information, so chunks from concurrent transfers cannot be misassociated
// regardless of the order they arrive in.
//
// Usable from a browser via `window.Framing` and from Node via require() so the
// wire format can be tested without a browser.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Framing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Protocol version. Bumped when the envelope layout or the handshake contract
  // changes in a way an older peer cannot parse. Peers exchange this in the
  // channel handshake and refuse to transfer on mismatch rather than
  // misinterpreting each other's bytes.
  const PROTOCOL_VERSION = 2;

  // Message types carried in the envelope header.
  const MSG = {
    CHUNK: 1,
  };

  // Envelope header, 16 bytes, all little-endian:
  //
  //   offset  size  field
  //   0       1     version       protocol version, so a stale peer is detectable
  //   1       1     type          MSG.*
  //   2       2     flags         reserved, must be 0
  //   4       4     transferId    opaque id, unique per connection
  //   8       4     seq           zero-based chunk index
  //   12      4     payloadLength byte length of payload following the header
  //
  // A 16-byte header keeps the uint32 fields 4-byte aligned for cheap typed
  // array reads, and leaves room for a flags field without moving offsets.
  const HEADER_SIZE = 16;

  // Upper bound on an accepted payload, to reject a malformed length before
  // attempting an allocation. Comfortably above the 256KB chunk size so a
  // legitimate oversized final chunk is not rejected.
  const MAX_PAYLOAD = 16 * 1024 * 1024;

  function ProtocolError(message) {
    const err = new Error(message);
    err.name = 'ProtocolError';
    return err;
  }

  function assertVersion(version) {
    if (version !== PROTOCOL_VERSION) {
      throw ProtocolError(
        `unsupported protocol version ${version}, expected ${PROTOCOL_VERSION}`
      );
    }
  }

  /**
   * Build a framed chunk envelope.
   * @param {number} transferId
   * @param {number} seq
   * @param {ArrayBuffer|Uint8Array} payload
   * @returns {ArrayBuffer}
   */
  function encodeChunk(transferId, seq, payload) {
    if (!Number.isInteger(transferId) || transferId < 0 || transferId > 0xffffffff) {
      throw ProtocolError(`transferId out of range: ${transferId}`);
    }
    if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffff) {
      throw ProtocolError(`seq out of range: ${seq}`);
    }

    const bytes = toUint8Array(payload);
    if (bytes.byteLength > MAX_PAYLOAD) {
      throw ProtocolError(`payload too large: ${bytes.byteLength}`);
    }

    const out = new Uint8Array(HEADER_SIZE + bytes.byteLength);
    const view = new DataView(out.buffer);

    view.setUint8(0, PROTOCOL_VERSION);
    view.setUint8(1, MSG.CHUNK);
    view.setUint16(2, 0); // flags
    view.setUint32(4, transferId);
    view.setUint32(8, seq);
    view.setUint32(12, bytes.byteLength);

    out.set(bytes, HEADER_SIZE);
    return out.buffer;
  }

  /**
   * Parse a framed chunk envelope.
   * @param {ArrayBuffer|Uint8Array} buffer
   * @returns {{version:number,type:number,transferId:number,seq:number,payload:Uint8Array}}
   */
  function decodeChunk(buffer) {
    const bytes = toUint8Array(buffer);

    if (bytes.byteLength < HEADER_SIZE) {
      throw ProtocolError(
        `buffer too small to be a framed chunk: ${bytes.byteLength} bytes`
      );
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint8(0);
    const type = view.getUint8(1);
    const flags = view.getUint16(2);
    const transferId = view.getUint32(4);
    const seq = view.getUint32(8);
    const payloadLength = view.getUint32(12);

    assertVersion(version);

    if (type !== MSG.CHUNK) {
      throw ProtocolError(`unknown message type ${type}`);
    }
    if (flags !== 0) {
      throw ProtocolError(`unknown flags set: ${flags}`);
    }
    if (payloadLength > MAX_PAYLOAD) {
      throw ProtocolError(`declared payload too large: ${payloadLength}`);
    }

    const available = bytes.byteLength - HEADER_SIZE;
    if (available < payloadLength) {
      throw ProtocolError(
        `truncated chunk: header declares ${payloadLength} payload bytes, ` +
        `buffer carries ${available}`
      );
    }

    return {
      version,
      type,
      transferId,
      seq,
      payload: bytes.subarray(HEADER_SIZE, HEADER_SIZE + payloadLength),
    };
  }

  /**
   * True when the buffer starts with a plausible framed header of a version we
   * support. Used to tell a framed chunk apart from other binary traffic on the
   * same channel without throwing.
   */
  function isFramedChunk(buffer) {
    const bytes = toUint8Array(buffer);
    if (bytes.byteLength < HEADER_SIZE) return false;
    const version = bytes[0];
    return version === PROTOCOL_VERSION && bytes[1] === MSG.CHUNK;
  }

  function toUint8Array(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    if (Array.isArray(input)) return Uint8Array.from(input);
    throw ProtocolError('cannot interpret value as binary data');
  }

  return {
    PROTOCOL_VERSION,
    MSG,
    HEADER_SIZE,
    MAX_PAYLOAD,
    ProtocolError,
    encodeChunk,
    decodeChunk,
    isFramedChunk,
  };
});