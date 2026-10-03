// tests/qr.test.js
// Tests for the self-contained byte-mode QR encoder in client/qr.js.
//
// Wherever a value comes from outside this repo it is cited inline:
// - Reed-Solomon vectors: Thonky's QR Code Tutorial, "Error Correction
//   Coding" (https://www.thonky.com/qr-code-tutorial/error-correction-coding)
// - Format/version strings: Thonky's "Format and Version String Tables"
//   (https://www.thonky.com/qr-code-tutorial/format-version-tables)
// - Reference matrices/hashes: python-qrcode 8.2 (independent implementation,
//   https://github.com/lincolnloop/python-qrcode) with the payload wrapped as
//   QRData(payload, MODE_8BIT_BYTE), ERROR_CORRECT_M, auto version; the matrix
//   below is get_matrix() with the quiet-zone border stripped, hashed as the
//   join of '1'/'0' rows with SHA-256.

'use strict';

const assert = require('./assert');
const crypto = require('crypto');
const QR = require('../client/qr.js');

const { internals } = QR;

function shaMatrix(modules) {
  return crypto
    .createHash('sha256')
    .update(modules.map((row) => row.join('')).join(''))
    .digest('hex');
}

function isQrError(fn) {
  try {
    fn();
  } catch (err) {
    return err && err.name === 'QrError';
  }
  return false;
}

// Independent-source fixture A: full 21x21 reference matrix for the 11-byte
// payload 'HELLO-WORLD' at version 1-M (reference chose mask 4).
const FIXTURE_A_PAYLOAD = 'HELLO-WORLD';
const FIXTURE_A_ROWS = [
  '111111101110001111111',
  '100000100011101000001',
  '101110100101101011101',
  '101110101111101011101',
  '101110101010101011101',
  '100000101101001000001',
  '111111101010101111111',
  '000000001011100000000',
  '100010111101011111001',
  '000101011011100001111',
  '101110110101011010010',
  '000011000100010000000',
  '100010101010101100110',
  '000000001110111101011',
  '111111101110101011010',
  '100000100111110010011',
  '101110101001011110110',
  '101110100110100011011',
  '101110100011000111000',
  '100000100111010000000',
  '111111101011111110101',
];

// Independent-source fixtures B-E: payload, expected version/mask, and the
// SHA-256 of the reference matrix (same generation method as fixture A).
const FIXTURE_BCD_E = [
  {
    payload: 'ABCDEFGHIJKLMNOPQRSTUVWX12',
    version: 2,
    mask: 7,
    sha: '6437bb8ff2b53f1fc211799a5895fefd3aebb0febacc81099b90f6ee46d40fcc',
  },
  {
    payload: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh01234567',
    version: 3,
    mask: 2,
    sha: '2b1bfe2e31cb1f024bdc309a7b624e71fdd00011c9858cf6823a867115bfc4b0',
  },
  {
    payload:
      '0dSjgZe_MVqb4R23kNCTQJOv8FaLoBmnU9yDA5-fs1K7YxWXEtizwpuPcl6rIhGH' +
      '0dSjgZe_MVqb4R23kNCTQJOv8FaLoBmnU9yD',
    version: 6,
    mask: 7,
    sha: '67caa06691f83b7e9cf4308ec1dbd02a03072313a9eb6a4ac2867a0fc2b2f3a2',
  },
  {
    // 594-char realistic-size payload: the 64-char base64url unit repeats;
    // written as head + repeats so the exact reference bytes are preserved.
    payload:
      'b4R23kNCTQJOv8FaLoBmnU9yDA5-fs1K7YxWXEtizwpuPcl6rIhGH0dSjgZe_MVqb' +
      '4R23kNCTQJOv8FaLoBmnU9yDA5-fs1K7YxWXEtizwpuPcl6rIhGH0dSjgZe_MVqb'.repeat(8) +
      '4R23kNCTQJOv8FaLo',
    version: 19,
    mask: 2,
    sha: '779500c440b355aec6e6a43b6bb8ca174f6e79245f6165177acde5cfc0de1e2e',
  },
];

// Read the 15 format bits of copy 1 back out of a matrix: cells
// (col 8, rows 0-5) = bits 0-5, (8,7) = bit 6, (8,8) = bit 7, (7,8) = bit 8,
// (row 8, cols 5-0) = bits 9-14. Returns the integer with bit 14 as MSB.
function readFormatCopy1(modules) {
  const at = (x, y) => modules[y][x];
  let bits = 0;
  for (let i = 0; i < 6; i++) bits |= at(8, i) << i;
  bits |= at(8, 7) << 6;
  bits |= at(8, 8) << 7;
  bits |= at(7, 8) << 8;
  for (let i = 9; i < 15; i++) bits |= at(15 - i - 1, 8) << i;
  return bits;
}

function makeStubCanvas() {
  const rects = [];
  const ctx = {
    fillStyle: null,
    fillRect(x, y, w, h) {
      rects.push({ x, y, w, h, style: this.fillStyle });
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext(type) {
      assert.equal(type, '2d');
      return ctx;
    },
  };
  return { canvas, rects };
}

const tests = {
  'GF(256) tables match the published log/antilog values': () => {
    // Thonky "Error Correction Coding", steps 5-6: powers of two under
    // byte-wise modulo 100011101, e.g. 2^8 = 256 XOR 285 = 29.
    const t = internals.gfBuildTables();
    assert.equal(t.exp[0], 1);
    assert.equal(t.exp[7], 128);
    assert.equal(t.exp[8], 29);
    assert.equal(t.exp[9], 58);
    assert.equal(t.exp[10], 116);
    assert.equal(t.exp[11], 232);
    assert.equal(t.exp[12], 205);
    // Step 6: 16 * 32 = 2^4 * 2^5 = 2^9 = 58 in GF(256).
    assert.equal(internals.gfMultiply(16, 32), 58);
    assert.equal(internals.gfMultiply(0, 123), 0);
    assert.equal(internals.gfMultiply(123, 0), 0);
  },

  'generator polynomials match the published coefficients': () => {
    // Thonky step 7: g(x) for 2 EC codewords is x^2 + 3x + 2, for 3 it is
    // x^3 + 7x^2 + 14x + 8 (alpha^3 = 8).
    assert.deepEqual(internals.generatorPoly(2), [1, 3, 2]);
    assert.deepEqual(internals.generatorPoly(3), [1, 7, 14, 8]);
    // Thonky step 8: g(x) for 10 EC codewords in alpha notation is
    // x^10 + a^251 x^9 + a^67 x^8 + a^46 x^7 + a^61 x^6 + a^118 x^5 +
    // a^70 x^4 + a^64 x^3 + a^94 x^2 + a^32 x + a^45.
    const gen10 = internals.generatorPoly(10);
    assert.equal(gen10.length, 11);
    assert.equal(gen10[0], 1);
    const t = internals.gfBuildTables();
    const expected = [251, 67, 46, 61, 118, 70, 64, 94, 32, 45];
    for (let i = 0; i < expected.length; i++) {
      assert.equal(gen10[i + 1], t.exp[expected[i]]);
    }
  },

  'Reed-Solomon remainder matches the published HELLO WORLD vector': () => {
    // Thonky step 8-9: the 1-M data codewords for HELLO WORLD leave the
    // remainder 196 35 39 119 235 215 231 226 93 23 (10 EC codewords).
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    assert.deepEqual(
      internals.rsRemainder(data, 10),
      [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]
    );
  },

  'byte payload v1-M matches the independent reference matrix exactly': () => {
    const r = QR.encode(FIXTURE_A_PAYLOAD);
    assert.equal(r.version, 1);
    assert.equal(r.level, 'M');
    assert.equal(r.mask, 4);
    assert.equal(r.size, 21);
    assert.deepEqual(r.modules.map((row) => row.join('')), FIXTURE_A_ROWS);
  },

  'larger payloads match independent reference hashes (v2, v3, v6, v19)': () => {
    // Versions 6 and 19 exercise multi-block interleaving; 19 additionally
    // exercises the version-information blocks. A hash mismatch here means
    // the encoder disagrees with an independent implementation bit for bit.
    for (const f of FIXTURE_BCD_E) {
      const r = QR.encode(f.payload);
      assert.equal(r.version, f.version, `version for ${f.payload.length}-byte payload`);
      assert.equal(r.level, 'M', `level for ${f.payload.length}-byte payload`);
      assert.equal(r.mask, f.mask, `mask for ${f.payload.length}-byte payload`);
      assert.equal(r.size, 4 * f.version + 17);
      assert.equal(shaMatrix(r.modules), f.sha, `matrix hash for v${f.version}`);
    }
  },

  'rejects an empty payload': () => {
    assert.ok(isQrError(() => QR.encode('')));
    assert.ok(isQrError(() => QR.encode(null)));
    assert.ok(isQrError(() => QR.encode(undefined)));
  },

  'rejects characters outside byte range': () => {
    assert.ok(isQrError(() => QR.encode('abc\u0100')));
  },

  'exact-capacity payload fits; one byte more steps up a version': () => {
    // v1-M holds 14 bytes, v2-M holds 26, v3-M holds 42 in byte mode.
    assert.equal(internals.byteCapacity(1, 'M'), 14);
    assert.equal(internals.byteCapacity(2, 'M'), 26);
    assert.equal(internals.byteCapacity(3, 'M'), 42);
    assert.equal(QR.encode('A'.repeat(14)).version, 1);
    assert.equal(QR.encode('A'.repeat(15)).version, 2);
    assert.equal(QR.encode('A'.repeat(26)).version, 2);
    assert.equal(QR.encode('A'.repeat(27)).version, 3);
    assert.equal(QR.encode('A'.repeat(42)).version, 3);
    assert.equal(QR.encode('A'.repeat(43)).version, 4);
  },

  'selects the smallest version at level M': () => {
    assert.deepEqual(QR.selectVersion(1), { version: 1, level: 'M' });
    assert.deepEqual(QR.selectVersion(14), { version: 1, level: 'M' });
    assert.deepEqual(QR.selectVersion(15), { version: 2, level: 'M' });
    assert.deepEqual(QR.selectVersion(594), { version: 19, level: 'M' });
  },

  'falls back to level L only when M cannot fit': () => {
    // 2400 bytes exceeds the largest M symbol (v40-M holds 2331) but fits L.
    const sel = QR.selectVersion(2400);
    assert.equal(sel.level, 'L');
    assert.equal(sel.version, 36);
    // Small payloads never use the fallback.
    assert.equal(QR.selectVersion(100).level, 'M');
  },

  '594-char realistic payload encodes at version 19-M': () => {
    const r = QR.encode(FIXTURE_BCD_E[3].payload);
    assert.equal(FIXTURE_BCD_E[3].payload.length, 594);
    assert.equal(r.version, 19);
    assert.equal(r.level, 'M');
    assert.equal(r.size, 93);
  },

  'auto mask is always a valid mask 0-7': () => {
    for (let n = 1; n <= 60; n++) {
      const r = QR.encode('B'.repeat(n));
      assert.ok(Number.isInteger(r.mask) && r.mask >= 0 && r.mask <= 7, `mask for len ${n}`);
    }
  },

  'format bits match the published format strings': () => {
    // Thonky "Format and Version String Tables": M/4 = 100010111111001,
    // M/7 = 100101010100000, M/2 = 101111001111100.
    const asBits = (v) => v.toString(2).padStart(15, '0');
    assert.equal(asBits(internals.formatBits('M', 4)), '100010111111001');
    assert.equal(asBits(internals.formatBits('M', 7)), '100101010100000');
    assert.equal(asBits(internals.formatBits('M', 2)), '101111001111100');
  },

  'format information in the matrix decodes consistently for every mask': () => {
    // Pin each mask and check the matrix cells carry that mask's format
    // string: the placed bits must equal the computed formatBits value, the
    // second copy must agree, and the dark module must be set.
    for (let m = 0; m < 8; m++) {
      const r = QR.encode('FORMAT-CHECK-0123456789', { mask: m });
      assert.equal(r.mask, m);
      const expected = internals.formatBits('M', m);
      assert.equal(readFormatCopy1(r.modules), expected, `copy 1 mask ${m}`);
      const size = r.size;
      for (let i = 8; i < 15; i++) {
        assert.equal(r.modules[size - 15 + i][8], (expected >>> i) & 1, `copy 2 vertical mask ${m} bit ${i}`);
      }
      for (let i = 0; i < 8; i++) {
        assert.equal(r.modules[8][size - 1 - i], (expected >>> i) & 1, `copy 2 horizontal mask ${m} bit ${i}`);
      }
      assert.equal(r.modules[size - 8][8], 1, `dark module mask ${m}`);
    }
  },

  'version information matches the published version string': () => {
    // Thonky "Format and Version String Tables": version 7 = 000111110010010100.
    const asBits = (v) => v.toString(2).padStart(18, '0');
    assert.equal(asBits(internals.versionBits(7)), '000111110010010100');
  },

  'interleaved blocks carry consistent Reed-Solomon codewords': () => {
    // De-interleave per the block layout and check every block's EC tail
    // against a fresh rsRemainder of its data head. The 130-byte payload
    // lands on v8-M with uneven groups (2x38 + 2x39), exercising the
    // short-block skip in both the data and EC interleave.
    for (const [text, version] of [['C'.repeat(100), 6], ['D'.repeat(130), 8]]) {
      const bytes = [...text].map((c) => c.charCodeAt(0));
      const sel = QR.selectVersion(bytes.length);
      assert.equal(sel.version, version);
      assert.equal(sel.level, 'M');
      const info = internals.eccEntry(version, 'M');
      const dc = internals.buildDataCodewords(bytes, version, 'M');
      const fin = internals.interleaveBlocks(dc, version, 'M');
      const nBlocks = info.group1blocks + info.group2blocks;
      assert.equal(fin.length, info.dataCodewords + nBlocks * info.ecPerBlock);
      const lens = [];
      for (let b = 0; b < info.group1blocks; b++) lens.push(info.group1data);
      for (let b = 0; b < info.group2blocks; b++) lens.push(info.group2data);
      const dataBlocks = lens.map(() => []);
      let p = 0;
      for (let i = 0; i < Math.max(...lens); i++) {
        for (let b = 0; b < nBlocks; b++) {
          if (i < lens[b]) dataBlocks[b].push(fin[p++]);
        }
      }
      const ecBlocks = lens.map(() => []);
      for (let i = 0; i < info.ecPerBlock; i++) {
        for (let b = 0; b < nBlocks; b++) ecBlocks[b].push(fin[p++]);
      }
      assert.equal(p, fin.length);
      // Blocks were sliced sequentially, so block order reassembles dc.
      assert.deepEqual([].concat(...dataBlocks), dc);
      for (let b = 0; b < nBlocks; b++) {
        assert.deepEqual(ecBlocks[b], internals.rsRemainder(dataBlocks[b], info.ecPerBlock), `block ${b} v${version}`);
      }
    }
  },

  'matrix excludes the quiet zone; renderer adds it': () => {
    const r = QR.encode(FIXTURE_A_PAYLOAD);
    assert.equal(r.modules.length, r.size);
    for (const row of r.modules) assert.equal(row.length, r.size);
    // Corner (0,0) is the finder pattern's dark corner: with a quiet zone it
    // would be light.
    assert.equal(r.modules[0][0], 1);

    const { canvas, rects } = makeStubCanvas();
    const ok = QR.renderToCanvas(canvas, r, { scale: 3, margin: 4 });
    assert.ok(ok);
    assert.equal(canvas.width, (r.size + 8) * 3);
    assert.equal(canvas.height, (r.size + 8) * 3);
    // No dark module may intrude into the quiet zone.
    const dark = rects.filter((rc) => rc.style === '#000000');
    assert.ok(dark.length > 0);
    for (const rc of dark) {
      assert.ok(rc.x >= 4 * 3 && rc.y >= 4 * 3, 'dark rect inside quiet zone');
    }
  },

  'renderer draws dark modules at the right offsets': () => {
    const r = QR.encode(FIXTURE_A_PAYLOAD);
    const { canvas, rects } = makeStubCanvas();
    assert.ok(QR.renderToCanvas(canvas, r, { scale: 2, margin: 4 }));
    let darkCount = 0;
    for (const row of r.modules) for (const v of row) darkCount += v;
    const dark = rects.filter((rc) => rc.style === '#000000');
    assert.equal(dark.length, darkCount);
    // Finder corner (0,0) is dark: its rect starts after the quiet zone.
    assert.ok(dark.some((rc) => rc.x === 8 && rc.y === 8 && rc.w === 2 && rc.h === 2));
  },

  'renderer no-ops safely without a canvas': () => {
    const r = QR.encode(FIXTURE_A_PAYLOAD);
    assert.equal(QR.renderToCanvas(null, r), false);
    assert.equal(QR.renderToCanvas(undefined, r), false);
    assert.equal(QR.renderToCanvas({}, r), false);
    assert.equal(QR.renderToCanvas({ getContext: () => null }, r), false);
    assert.equal(
      QR.renderToCanvas(
        {
          getContext() {
            throw new Error('no DOM');
          },
        },
        r
      ),
      false
    );
    assert.equal(QR.renderToCanvas(makeStubCanvas().canvas, null), false);
  },

  'oversize payload refuses with a link/copy fallback, not a crash': () => {
    // Past the legibility limit (needs v27, limit is v25) but inside v40.
    try {
      QR.encode('E'.repeat(1100));
      assert.ok(false, 'expected a legibility refusal');
    } catch (err) {
      assert.equal(err.name, 'QrError');
      assert.equal(err.code, 'QR_TOO_LARGE');
      assert.match(String(err.message), /link\/copy/);
    }
    // Past everything the tables cover.
    try {
      QR.encode('F'.repeat(3000));
      assert.ok(false, 'expected a too-large refusal');
    } catch (err) {
      assert.equal(err.name, 'QrError');
      assert.equal(err.code, 'QR_TOO_LARGE');
      assert.match(String(err.message), /link\/copy/);
    }
  },
};

module.exports = { name: 'qr', tests };
