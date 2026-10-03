// tests/assert.js
// Minimal assertion helpers for the LanShare test suite.

'use strict';

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

function fail(message) {
  throw new AssertionError(message);
}

function ok(value, message) {
  if (!value) fail(message || `expected truthy, got ${format(value)}`);
}

function notOk(value, message) {
  if (value) fail(message || `expected falsy, got ${format(value)}`);
}

function format(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'bigint') return `${v}n`;
  if (v instanceof ArrayBuffer) return `ArrayBuffer(${v.byteLength})`;
  if (ArrayBuffer.isView(v)) return `${v.constructor.name}(${v.byteLength})[${Array.from(v).slice(0, 8).join(',')}...]`;
  if (v && v.constructor && v.constructor.name === 'Blob') return `Blob(${v.size})`;
  if (v === undefined) return 'undefined';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function equal(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    fail(message || `expected ${format(expected)}, got ${format(actual)}`);
  }
}

function notEqual(actual, unexpected, message) {
  if (Object.is(actual, unexpected)) {
    fail(message || `expected value to differ from ${format(unexpected)}`);
  }
}

function bytesEqual(actual, expected, message) {
  const a = toBytes(actual);
  const b = toBytes(expected);

  if (a.length !== b.length) {
    fail(message || `byte length differs: expected ${b.length}, got ${a.length}`);
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      fail(message || `bytes differ at index ${i}: expected ${b[i]}, got ${a[i]}`);
    }
  }
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (Array.isArray(input)) return Uint8Array.from(input);
  return Uint8Array.from(input);
}

function deepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) fail(message || `expected ${b}, got ${a}`);
}

function match(value, regexp, message) {
  if (!regexp.test(String(value))) {
    fail(message || `expected ${format(value)} to match ${regexp}`);
  }
}

function includes(haystack, needle, message) {
  const found = typeof haystack === 'string'
    ? haystack.includes(needle)
    : Array.from(haystack || []).some((v) => Object.is(v, needle));
  if (!found) fail(message || `expected ${format(haystack)} to include ${format(needle)}`);
}

function throws(fn, message) {
  try {
    fn();
  } catch {
    return;
  }
  fail(message || 'expected function to throw');
}

async function rejects(promiseOrFn, message) {
  try {
    const p = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
    await p;
  } catch {
    return;
  }
  fail(message || 'expected promise to reject');
}

module.exports = {
  AssertionError,
  fail,
  ok,
  notOk,
  equal,
  notEqual,
  bytesEqual,
  deepEqual,
  match,
  includes,
  throws,
  rejects,
  toBytes,
};