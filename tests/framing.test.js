// tests/framing.test.js
// Wire-format tests for the chunk envelope. The round-trip property that
// matters is that payload bytes survive encode/decode unchanged for every size
// the transfer path can produce.

'use strict';

const assert = require('./assert');
const Framing = require('../client/framing.js');

const {
  PROTOCOL_VERSION,
  HEADER_SIZE,
  encodeChunk,
  decodeChunk,
  isFramedChunk,
  ProtocolError,
} = Framing;

function syntheticBytes(length, seed = 1) {
  const out = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = state & 0xff;
  }
  return out;
}

function isProtocolError(fn) {
  try {
    fn();
  } catch (err) {
    return err.name === 'ProtocolError';
  }
  return false;
}

const tests = {
  'header is 16 bytes so uint32 fields stay aligned': () => {
    assert.equal(HEADER_SIZE, 16);
    assert.equal(HEADER_SIZE % 4, 0);
  },

  'round trip preserves transfer id, sequence and payload': () => {
    const payload = syntheticBytes(1024, 7);
    const decoded = decodeChunk(encodeChunk(42, 9, payload));

    assert.equal(decoded.transferId, 42);
    assert.equal(decoded.seq, 9);
    assert.equal(decoded.version, PROTOCOL_VERSION);
    assert.bytesEqual(decoded.payload, payload);
  },

  'round trip at chunk size': () => {
    const payload = syntheticBytes(256 * 1024, 3);
    const decoded = decodeChunk(encodeChunk(1, 0, payload));

    assert.equal(decoded.payload.byteLength, payload.byteLength);
    assert.bytesEqual(decoded.payload, payload);
  },

  'round trip with a 1 byte payload': () => {
    const decoded = decodeChunk(encodeChunk(0, 0, Uint8Array.from([0xff])));
    assert.equal(decoded.payload.byteLength, 1);
    assert.bytesEqual(decoded.payload, [0xff]);
  },

  'round trip with a zero length payload': () => {
    const decoded = decodeChunk(encodeChunk(7, 3, new Uint8Array(0)));

    assert.equal(decoded.payload.byteLength, 0);
    assert.equal(decoded.transferId, 7);
    assert.equal(decoded.seq, 3);
  },

  'round trip at maximum transfer id and sequence': () => {
    const decoded = decodeChunk(encodeChunk(0xffffffff, 0xffffffff, Uint8Array.from([1])));
    assert.equal(decoded.transferId, 0xffffffff);
    assert.equal(decoded.seq, 0xffffffff);
  },

  'accepts ArrayBuffer, Uint8Array and plain array payloads': () => {
    const source = Uint8Array.from([1, 2, 3, 4]);
    const viaTyped = decodeChunk(encodeChunk(1, 0, source)).payload;
    const viaBuffer = decodeChunk(encodeChunk(1, 0, source.buffer)).payload;
    const viaArray = decodeChunk(encodeChunk(1, 0, [1, 2, 3, 4])).payload;

    assert.bytesEqual(viaTyped, source);
    assert.bytesEqual(viaBuffer, source);
    assert.bytesEqual(viaArray, source);
  },

  'decodes a buffer carrying a non-zero byte offset': () => {
    const payload = Uint8Array.from([10, 20, 30]);
    const framed = new Uint8Array(encodeChunk(5, 2, payload));
    const padded = new Uint8Array(framed.byteLength + 4);
    padded.set(framed, 4);

    const decoded = decodeChunk(padded.subarray(4));
    assert.equal(decoded.transferId, 5);
    assert.bytesEqual(decoded.payload, payload);
  },

  'accepts a payload exactly at the declared maximum': () => {
    const decoded = decodeChunk(encodeChunk(1, 0, new Uint8Array(Framing.MAX_PAYLOAD)));
    assert.equal(decoded.payload.byteLength, Framing.MAX_PAYLOAD);
  },

  'rejects a payload larger than the declared maximum': () => {
    assert.ok(
      isProtocolError(() => encodeChunk(1, 0, new Uint8Array(Framing.MAX_PAYLOAD + 1)))
    );
  },

  'rejects an out of range transfer id': () => {
    assert.ok(isProtocolError(() => encodeChunk(-1, 0, new Uint8Array(0))));
    assert.ok(isProtocolError(() => encodeChunk(1.5, 0, new Uint8Array(0))));
    assert.ok(isProtocolError(() => encodeChunk(0x100000000, 0, new Uint8Array(0))));
  },

  'rejects an out of range sequence number': () => {
    assert.ok(isProtocolError(() => encodeChunk(1, -1, new Uint8Array(0))));
    assert.ok(isProtocolError(() => encodeChunk(1, 1.5, new Uint8Array(0))));
  },

  'rejects a truncated buffer smaller than the header': () => {
    assert.ok(isProtocolError(() => decodeChunk(new Uint8Array(HEADER_SIZE - 1))));
    assert.ok(isProtocolError(() => decodeChunk(new Uint8Array(0))));
  },

  'rejects a chunk whose payload is shorter than declared': () => {
    const framed = new Uint8Array(encodeChunk(1, 0, syntheticBytes(512)));
    assert.ok(isProtocolError(() => decodeChunk(framed.subarray(0, HEADER_SIZE + 100))));
  },

  'rejects a mismatched protocol version': () => {
    const framed = new Uint8Array(encodeChunk(1, 0, syntheticBytes(64)));
    framed[0] = PROTOCOL_VERSION + 1;
    assert.ok(isProtocolError(() => decodeChunk(framed)));
  },

  'rejects a version from an older protocol': () => {
    const framed = new Uint8Array(encodeChunk(1, 0, syntheticBytes(64)));
    framed[0] = PROTOCOL_VERSION - 1;
    assert.ok(isProtocolError(() => decodeChunk(framed)));
  },

  'rejects an unknown message type': () => {
    const framed = new Uint8Array(encodeChunk(1, 0, syntheticBytes(64)));
    framed[1] = 99;
    assert.ok(isProtocolError(() => decodeChunk(framed)));
  },

  'rejects reserved flags being set': () => {
    const framed = new Uint8Array(encodeChunk(1, 0, syntheticBytes(64)));
    framed[2] = 1;
    assert.ok(isProtocolError(() => decodeChunk(framed)));
  },

  'rejects an oversized declared payload length': () => {
    const framed = new Uint8Array(encodeChunk(1, 0, syntheticBytes(64)));
    new DataView(framed.buffer).setUint32(12, Framing.MAX_PAYLOAD + 1);
    assert.ok(isProtocolError(() => decodeChunk(framed)));
  },

  'isFramedChunk recognises a valid envelope': () => {
    assert.ok(isFramedChunk(encodeChunk(1, 0, syntheticBytes(64))));
  },

  'isFramedChunk rejects unframed binary of any size': () => {
    assert.notOk(isFramedChunk(new Uint8Array(0)));
    assert.notOk(isFramedChunk(new Uint8Array(HEADER_SIZE - 1)));
    assert.notOk(isFramedChunk(syntheticBytes(1024)));
  },

  'isFramedChunk rejects a foreign version without throwing': () => {
    const framed = new Uint8Array(encodeChunk(1, 0, syntheticBytes(64)));
    framed[0] = 99;
    assert.notOk(isFramedChunk(framed));
  },

  'messages from different transfers decode independently': () => {
    const a = syntheticBytes(2048, 11);
    const b = syntheticBytes(2048, 22);

    const frameA = encodeChunk(100, 0, a);
    const frameB = encodeChunk(200, 0, b);

    const decodedB = decodeChunk(frameB);
    const decodedA = decodeChunk(frameA);

    assert.equal(decodedA.transferId, 100);
    assert.equal(decodedB.transferId, 200);
    assert.bytesEqual(decodedA.payload, a);
    assert.bytesEqual(decodedB.payload, b);
  },

  'payload bytes containing envelope-like values are not reinterpreted': () => {
    // A payload whose first bytes look like a header must be returned intact.
    const hostile = new Uint8Array(64);
    hostile.fill(PROTOCOL_VERSION);
    hostile[1] = 1;

    const decoded = decodeChunk(encodeChunk(4, 4, hostile));
    assert.bytesEqual(decoded.payload, hostile);
  },
};

module.exports = { name: 'framing', tests };