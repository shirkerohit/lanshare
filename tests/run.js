// tests/run.js
// Zero-dependency test runner. Discovers tests/*.test.js, runs each exported
// test function, and exits non-zero if anything fails.

'use strict';

const fs = require('fs');
const path = require('path');

const files = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

const filter = process.argv[2] ? process.argv[2].toLowerCase() : null;

let passed = 0;
let skipped = 0;
const failures = [];

function record(file, suiteName, testName, err) {
  failures.push({ file, suiteName, testName, err });
  console.log(`    FAIL  ${testName}`);
  console.log(`          ${err && err.message ? err.message : String(err)}`);
  if (err && err.stack) {
    const line = err.stack.split('\n').find((l) => l.includes(__dirname));
    if (line) console.log(`          ${line.trim()}`);
  }
}

async function run() {
  if (files.length === 0) {
    console.log('No test files found in tests/*.test.js');
    process.exit(1);
  }

  for (const file of files) {
    const full = path.join(__dirname, file);
    let mod;
    try {
      mod = require(full);
    } catch (err) {
      failures.push({ file, suiteName: file, testName: '<load>', err });
      console.log(`  ${file}\n    FAIL  <load>\n          ${err.message}`);
      continue;
    }

    const suiteName = mod.name || file;
    const tests = mod.tests || {};
    const entries = Object.entries(tests);

    console.log(`\n  ${suiteName}`);

    for (const [testName, fn] of entries) {
      if (filter) {
        const haystack = `${suiteName} ${testName}`.toLowerCase();
        if (!haystack.includes(filter)) {
          skipped++;
          continue;
        }
      }

      try {
        await fn();
        passed++;
        console.log(`    ok    ${testName}`);
      } catch (err) {
        record(file, suiteName, testName, err);
      }
    }
  }

  console.log('');
  if (failures.length === 0) {
    const tail = skipped ? `, ${skipped} skipped` : '';
    console.log(`PASS  ${passed} passed${tail}`);
    process.exit(0);
  }

  console.log(`FAIL  ${passed} passed, ${failures.length} failed`);
  for (const f of failures) {
    console.log(`  ${f.suiteName} > ${f.testName}`);
  }
  process.exit(1);
}

run().catch((err) => {
  console.error('Runner crashed:', err);
  process.exit(1);
});