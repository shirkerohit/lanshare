// tests/harness.test.js
// Verifies the assertion helpers, and the runner's discovery and exit codes.
// The runner is exercised in an isolated sandbox directory so that running the
// suite never re-enters itself.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const assert = require('./assert');

function runSandbox(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanshare-runner-'));
  try {
    fs.copyFileSync(path.join(__dirname, 'run.js'), path.join(dir, 'run.js'));
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body);
    }
    try {
      const stdout = execFileSync(process.execPath, [path.join(dir, 'run.js')], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout };
    } catch (err) {
      return { code: err.status === undefined ? 1 : err.status, stdout: err.stdout || '' };
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PASSING = 'module.exports = { name: "probe", tests: { "passes": () => {}, "also passes": () => {} } };\n';
const FAILING = 'module.exports = { name: "probe", tests: { "passes": () => {}, "fails": () => { throw new Error("expected failure"); } } };\n';
const ASYNC_REJECT = 'module.exports = { name: "probe", tests: { "awaits": async () => { await Promise.resolve(); }, "rejects": async () => { throw new Error("async failure"); } } };\n';

const tests = {
  'assert.ok passes on truthy values': () => {
    assert.ok(true);
    assert.ok(1);
    assert.ok('text');
  },

  'assert.ok throws on falsy values': () => {
    assert.throws(() => assert.ok(false), /expected truthy/);
    assert.throws(() => assert.ok(0), /expected truthy/);
    assert.throws(() => assert.ok(''), /expected truthy/);
  },

  'assert.equal compares with Object.is': () => {
    assert.equal(1, 1);
    assert.equal('a', 'a');
    assert.throws(() => assert.equal(1, 2), /expected 2, got 1/);
  },

  'assert.equal treats NaN as self-equal but unequal to numbers': () => {
    assert.equal(NaN, NaN);
    assert.throws(() => assert.equal(NaN, 0), /NaN/);
  },

  'assert.bytesEqual compares binary content': () => {
    assert.bytesEqual(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3]));
    assert.throws(() => assert.bytesEqual(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 4])), /index 2/);
    assert.throws(() => assert.bytesEqual(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2])), /byte length differs/);
  },

  'assert.bytesEqual accepts ArrayBuffer, views and plain arrays': () => {
    const source = Uint8Array.from([9, 8, 7]);
    assert.bytesEqual(source, source.buffer);
    assert.bytesEqual(source, [9, 8, 7]);
    assert.bytesEqual(source, new Uint8Array(source));
  },

  'assert.throws matches a pattern': () => {
    assert.throws(() => { throw new Error('boom happened'); }, /boom/);
    assert.throws(() => assert.fail('nope'), /nope/);
  },

  'assert.rejects awaits a rejecting promise': async () => {
    await assert.rejects(Promise.reject(new Error('async boom')), /async boom/);
    await assert.rejects(async () => { throw new Error('thrown'); });
  },

  'assert.rejects fails when the promise resolves': async () => {
    await assert.rejects(async () => {
      await assert.rejects(Promise.resolve('fine'), /expected promise to reject/);
    });
  },

  'assert.deepEqual compares structures': () => {
    assert.deepEqual({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] });
    assert.throws(() => assert.deepEqual({ a: 1 }, { a: 2 }), /expected/);
  },

  'assert.includes works on strings and arrays': () => {
    assert.includes('hello world', 'world');
    assert.includes([1, 2, 3], 2);
    assert.throws(() => assert.includes([1, 2], 9), /to include/);
  },

  'suite file exposes a name and tests object': () => {
    const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js'));
    assert.ok(files.length >= 2, `expected at least two test files, found ${files.length}`);
    assert.includes(files, 'harness.test.js');
    assert.includes(files, 'framing.test.js');
  },

  'runner exits zero and reports counts when all tests pass': () => {
    const result = runSandbox({ 'a.test.js': PASSING });
    assert.equal(result.code, 0, `expected exit 0, got ${result.code}\n${result.stdout}`);
    assert.match(result.stdout, /PASS {2}2 passed/);
    assert.notOk(/FAIL/.test(result.stdout));
  },

  'runner exits non-zero when a test fails': () => {
    const result = runSandbox({ 'a.test.js': FAILING });
    assert.equal(result.code, 1, `expected exit 1, got ${result.code}\n${result.stdout}`);
    assert.match(result.stdout, /FAIL {2}1 passed, 1 failed/);
    assert.match(result.stdout, /expected failure/);
  },

  'runner surfaces the failure message and the suite and test name': () => {
    const result = runSandbox({ 'a.test.js': FAILING });
    assert.match(result.stdout, /fails/);
    assert.match(result.stdout, /probe > fails/);
  },

  'runner awaits async tests and catches async rejections': () => {
    const result = runSandbox({ 'a.test.js': ASYNC_REJECT });
    assert.equal(result.code, 1, `expected exit 1, got ${result.code}\n${result.stdout}`);
    assert.match(result.stdout, /async failure/);
  },

  'runner reports a load error when a test file cannot be required': () => {
    const result = runSandbox({ 'a.test.js': 'throw new Error("cannot load");\n' });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /cannot load/);
  },

  'runner exits non-zero when no test files exist': () => {
    const result = runSandbox({});
    assert.equal(result.code, 1);
    assert.match(result.stdout, /No test files found/);
  },
};

module.exports = { name: 'harness', tests };