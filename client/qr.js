// client/qr.js
// Self-contained QR encoder, byte mode only, with no runtime dependency.
//
// Covers QR versions 1-40 at error-correction level M (preferred) with level L
// as a fallback when the payload cannot fit at M. The input is a base64url
// pairing payload treated as raw bytes; the output is a module matrix (quiet
// zone excluded) plus a renderer that draws the matrix onto an HTML canvas
// with the quiet zone added.
//
// encode() additionally refuses matrices above the legibility limit, so the
// caller falls back to the link/copy forms instead of showing a code no phone
// can scan. Version selection, data encoding, Reed-Solomon error correction
// over GF(256), module placement, data masking with standard penalty scoring,
// and format/version information all follow ISO/IEC 18004.
//
// Usable from a browser via `window.LanQR` and from Node via require() so the
// encoder can be tested without a browser.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LanQR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Smallest/largest version the tables below cover.
  const MIN_VERSION = 1;
  const MAX_VERSION = 40;

  // Legibility guard (spec task 2.6): encode() refuses any symbol larger
  // than version 25 (117x117 modules). A denser code will not scan reliably
  // from a phone screen, so the caller must fall back to the link/copy
  // forms instead. The refusal is a QrError naming that fallback, never a
  // thrown-off-a-cliff TypeError.
  const MAX_LEGIBLE_VERSION = 25;
  const MAX_LEGIBLE_MODULES = 4 * MAX_LEGIBLE_VERSION + 17; // 117

  // Quiet zone width in modules. Added by the renderer only; the matrix
  // returned by encode() never includes it.
  const QUIET_ZONE_MODULES = 4;

  function QrError(message, code) {
    const err = new Error(message);
    err.name = 'QrError';
    if (code) err.code = code;
    return err;
  }

  // Error-correction block layout per version, from ISO/IEC 18004 Table 9
  // (values cross-checked against Thonky's error-correction table).
  // Each entry is [dataCodewords, ecPerBlock,
  //                group1blocks, group1data, group2blocks, group2data].
  // Only L and M are needed: M is the operating level, L the fallback.
  const ECC = {
    L: [
      null,
      [19, 7, 1, 19, 0, 0],
      [34, 10, 1, 34, 0, 0],
      [55, 15, 1, 55, 0, 0],
      [80, 20, 1, 80, 0, 0],
      [108, 26, 1, 108, 0, 0],
      [136, 18, 2, 68, 0, 0],
      [156, 20, 2, 78, 0, 0],
      [194, 24, 2, 97, 0, 0],
      [232, 30, 2, 116, 0, 0],
      [274, 18, 2, 68, 2, 69],
      [324, 20, 4, 81, 0, 0],
      [370, 24, 2, 92, 2, 93],
      [428, 26, 4, 107, 0, 0],
      [461, 30, 3, 115, 1, 116],
      [523, 22, 5, 87, 1, 88],
      [589, 24, 5, 98, 1, 99],
      [647, 28, 1, 107, 5, 108],
      [721, 30, 5, 120, 1, 121],
      [795, 28, 3, 113, 4, 114],
      [861, 28, 3, 107, 5, 108],
      [932, 28, 4, 116, 4, 117],
      [1006, 28, 2, 111, 7, 112],
      [1094, 30, 4, 121, 5, 122],
      [1174, 30, 6, 117, 4, 118],
      [1276, 26, 8, 106, 4, 107],
      [1370, 28, 10, 114, 2, 115],
      [1468, 30, 8, 122, 4, 123],
      [1531, 30, 3, 117, 10, 118],
      [1631, 30, 7, 116, 7, 117],
      [1735, 30, 5, 115, 10, 116],
      [1843, 30, 13, 115, 3, 116],
      [1955, 30, 17, 115, 0, 0],
      [2071, 30, 17, 115, 1, 116],
      [2191, 30, 13, 115, 6, 116],
      [2306, 30, 12, 121, 7, 122],
      [2434, 30, 6, 121, 14, 122],
      [2566, 30, 17, 122, 4, 123],
      [2702, 30, 4, 122, 18, 123],
      [2812, 30, 20, 117, 4, 118],
      [2956, 30, 19, 118, 6, 119],
    ],
    M: [
      null,
      [16, 10, 1, 16, 0, 0],
      [28, 16, 1, 28, 0, 0],
      [44, 26, 1, 44, 0, 0],
      [64, 18, 2, 32, 0, 0],
      [86, 24, 2, 43, 0, 0],
      [108, 16, 4, 27, 0, 0],
      [124, 18, 4, 31, 0, 0],
      [154, 22, 2, 38, 2, 39],
      [182, 22, 3, 36, 2, 37],
      [216, 26, 4, 43, 1, 44],
      [254, 30, 1, 50, 4, 51],
      [290, 22, 6, 36, 2, 37],
      [334, 22, 8, 37, 1, 38],
      [365, 24, 4, 40, 5, 41],
      [415, 24, 5, 41, 5, 42],
      [453, 28, 7, 45, 3, 46],
      [507, 28, 10, 46, 1, 47],
      [563, 26, 9, 43, 4, 44],
      [627, 26, 3, 44, 11, 45],
      [669, 26, 3, 41, 13, 42],
      [714, 26, 17, 42, 0, 0],
      [782, 28, 17, 46, 0, 0],
      [860, 28, 4, 47, 14, 48],
      [914, 28, 6, 45, 14, 46],
      [1000, 28, 8, 47, 13, 48],
      [1062, 28, 19, 46, 4, 47],
      [1128, 28, 22, 45, 3, 46],
      [1193, 28, 3, 45, 23, 46],
      [1267, 28, 21, 45, 7, 46],
      [1373, 28, 19, 47, 10, 48],
      [1455, 28, 2, 46, 29, 47],
      [1541, 28, 10, 46, 23, 47],
      [1631, 28, 14, 46, 21, 47],
      [1725, 28, 14, 46, 23, 47],
      [1812, 28, 12, 47, 26, 48],
      [1914, 28, 6, 47, 34, 48],
      [1992, 28, 29, 46, 14, 47],
      [2102, 28, 13, 46, 32, 47],
      [2216, 28, 40, 47, 7, 48],
      [2334, 28, 18, 47, 31, 48],
    ],
  };

  // Alignment pattern centre coordinates per version (ISO/IEC 18004 Annex E;
  // values match Thonky's alignment-pattern-locations table).
  const ALIGNMENT = [
    null,
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
    [6, 30, 54],
    [6, 32, 58],
    [6, 34, 62],
    [6, 26, 46, 66],
    [6, 26, 48, 70],
    [6, 26, 50, 74],
    [6, 30, 54, 78],
    [6, 30, 56, 82],
    [6, 30, 58, 86],
    [6, 34, 62, 90],
    [6, 28, 50, 72, 94],
    [6, 26, 50, 74, 98],
    [6, 30, 54, 78, 102],
    [6, 28, 54, 80, 106],
    [6, 32, 58, 84, 110],
    [6, 30, 58, 86, 114],
    [6, 34, 62, 90, 118],
    [6, 26, 50, 74, 98, 122],
    [6, 30, 54, 78, 102, 126],
    [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134],
    [6, 34, 60, 86, 112, 138],
    [6, 30, 58, 86, 114, 142],
    [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150],
    [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158],
    [6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166],
    [6, 30, 58, 86, 114, 142, 170],
  ];

  // Remainder (filler) bits per version: the final message is padded with
  // this many zero bits after interleaving.
  const REMAINDER_BITS = [
    0, 7, 7, 7, 7, 7, 0, 0, 0, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3, 3,
    4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 0, 0, 0, 0, 0, 0,
  ];

  // Format-information EC bits (ISO/IEC 18004): L=01, M=00, Q=11, H=10.
  const FORMAT_EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  function eccEntry(version, level) {
    const table = ECC[level];
    if (!table) throw QrError(`unknown error-correction level ${level}`, 'QR_LEVEL');
    const e = table[version];
    if (!e) throw QrError(`version out of range: ${version}`, 'QR_VERSION');
    return {
      version,
      level,
      dataCodewords: e[0],
      ecPerBlock: e[1],
      group1blocks: e[2],
      group1data: e[3],
      group2blocks: e[4],
      group2data: e[5],
    };
  }

  // Character-count indicator width for byte mode: 8 bits for versions 1-9,
  // 16 bits for versions 10-40.
  function countBits(version) {
    return version <= 9 ? 8 : 16;
  }

  // Largest payload (in bytes) that fits this version/level in byte mode:
  // 4 mode bits + count bits + 8 bits per byte must fit the data codewords.
  function byteCapacity(version, level) {
    const info = eccEntry(version, level);
    return Math.floor((info.dataCodewords * 8 - 4 - countBits(version)) / 8);
  }

  // Smallest version that fits byteLen bytes: level M first, then level L.
  // Level L is used only when M cannot fit the payload within versions 1-40.
  function selectVersion(byteLen) {
    for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
      if (byteLen <= byteCapacity(v, 'M')) return { version: v, level: 'M' };
    }
    for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
      if (byteLen <= byteCapacity(v, 'L')) return { version: v, level: 'L' };
    }
    throw QrError(
      `payload of ${byteLen} bytes exceeds the largest supported QR symbol ` +
        `(version ${MAX_VERSION}); fall back to the link/copy forms instead of a code`,
      'QR_TOO_LARGE'
    );
  }

  // --- Galois field GF(256) with primitive polynomial 0x11D ---

  function gfBuildTables() {
    const exp = new Array(512);
    const log = new Array(256);
    let x = 1;
    for (let i = 0; i < 255; i++) {
      exp[i] = x;
      log[x] = i;
      x <<= 1;
      if (x >= 256) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
    return { exp, log };
  }

  const GF = gfBuildTables();

  function gfMultiply(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF.exp[GF.log[a] + GF.log[b]];
  }

  // Generator polynomial for ecCount error-correction codewords:
  // g(x) = (x - a^0)(x - a^1)...(x - a^(ecCount-1)), coefficients high-first.
  // (Subtraction is addition in GF(256), hence x + a^i.)
  function generatorPoly(ecCount) {
    let poly = [1];
    for (let i = 0; i < ecCount; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMultiply(poly[j], GF.exp[i]);
      }
      poly = next;
    }
    return poly;
  }

  // Reed-Solomon remainder: divide the message polynomial (times x^ecCount)
  // by the generator polynomial; the ecCount remainder terms are the EC
  // codewords. Addition/subtraction is XOR throughout.
  function rsRemainder(data, ecCount) {
    const gen = generatorPoly(ecCount);
    const work = data.slice();
    for (let i = 0; i < ecCount; i++) work.push(0);
    for (let i = 0; i < data.length; i++) {
      const factor = work[i];
      if (factor !== 0) {
        for (let j = 0; j < gen.length; j++) {
          work[i + j] ^= gfMultiply(gen[j], factor);
        }
      }
    }
    return work.slice(data.length);
  }

  // --- Data encoding (byte mode) ---

  function pushBits(bits, value, count) {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  }

  // Mode indicator 0100, count, 8-bit bytes, terminator (up to 4 zero bits),
  // zero-pad to a byte boundary, then alternating pad bytes 0xEC/0x11.
  function buildDataCodewords(bytes, version, level) {
    const info = eccEntry(version, level);
    const totalBits = info.dataCodewords * 8;
    const bits = [];
    pushBits(bits, 0x4, 4);
    pushBits(bits, bytes.length, countBits(version));
    for (let i = 0; i < bytes.length; i++) pushBits(bits, bytes[i], 8);
    if (bits.length > totalBits) {
      throw QrError(
        `payload of ${bytes.length} bytes does not fit version ${version}-${level}`,
        'QR_CAPACITY'
      );
    }
    const terminator = Math.min(4, totalBits - bits.length);
    for (let i = 0; i < terminator; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      out.push(b);
    }
    const pads = [0xec, 0x11];
    let k = 0;
    while (out.length < info.dataCodewords) out.push(pads[k++ % 2]);
    return out;
  }

  // Split data codewords into the version's blocks, compute one RS block per
  // data block, then interleave: all first data bytes, then all second bytes
  // (short blocks are skipped once exhausted), then the EC bytes likewise.
  function interleaveBlocks(dataCodewords, version, level) {
    const info = eccEntry(version, level);
    const blocks = [];
    let offset = 0;
    const groups = [
      [info.group1blocks, info.group1data],
      [info.group2blocks, info.group2data],
    ];
    for (let g = 0; g < 2; g++) {
      for (let b = 0; b < groups[g][0]; b++) {
        blocks.push(dataCodewords.slice(offset, offset + groups[g][1]));
        offset += groups[g][1];
      }
    }
    const ecBlocks = blocks.map((block) => rsRemainder(block, info.ecPerBlock));
    const out = [];
    let maxData = 0;
    for (let b = 0; b < blocks.length; b++) {
      if (blocks[b].length > maxData) maxData = blocks[b].length;
    }
    for (let i = 0; i < maxData; i++) {
      for (let b = 0; b < blocks.length; b++) {
        if (i < blocks[b].length) out.push(blocks[b][i]);
      }
    }
    for (let i = 0; i < info.ecPerBlock; i++) {
      for (let b = 0; b < ecBlocks.length; b++) out.push(ecBlocks[b][i]);
    }
    return out;
  }

  // --- Format and version information ---

  // 15-bit format string (returned as an integer, MSB is bit 14): 5 data bits
  // (EC level + mask), 10 BCH bits (generator 10100110111), XORed with the
  // mask pattern 101010000010010.
  function formatBits(level, mask) {
    const data = (FORMAT_EC_BITS[level] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
  }

  // 18-bit version string for versions >= 7 (returned as an integer, MSB is
  // bit 17): 6 version bits, 12 BCH bits (generator 1111100100101).
  function versionBits(version) {
    let rem = version;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    return ((version << 12) | rem) & 0x3ffff;
  }

  // --- Masking and penalty scoring ---

  // True when the data mask inverts the module at column x, row y.
  function maskApplies(mask, x, y) {
    switch (mask) {
      case 0:
        return (x + y) % 2 === 0;
      case 1:
        return y % 2 === 0;
      case 2:
        return x % 3 === 0;
      case 3:
        return (x + y) % 3 === 0;
      case 4:
        return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5:
        return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6:
        return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7:
        return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      default:
        return false;
    }
  }

  function runPenalty(runLen) {
    return runLen >= 5 ? 3 + (runLen - 5) : 0;
  }

  // Standard penalty score (lower is better): N1 runs of 5+ same-colour
  // modules, N2 2x2 blocks of one colour, N3 finder-like 11-module patterns,
  // N4 deviation of the dark-module ratio from 50%.
  function penaltyScore(modules) {
    const size = modules.length;
    let score = 0;
    for (let y = 0; y < size; y++) {
      let colour = modules[y][0];
      let len = 1;
      for (let x = 1; x < size; x++) {
        if (modules[y][x] === colour) len++;
        else {
          score += runPenalty(len);
          colour = modules[y][x];
          len = 1;
        }
      }
      score += runPenalty(len);
    }
    for (let x = 0; x < size; x++) {
      let colour = modules[0][x];
      let len = 1;
      for (let y = 1; y < size; y++) {
        if (modules[y][x] === colour) len++;
        else {
          score += runPenalty(len);
          colour = modules[y][x];
          len = 1;
        }
      }
      score += runPenalty(len);
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
          score += 3;
        }
      }
    }
    const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x <= size - 11; x++) {
        let a = true;
        let b = true;
        for (let k = 0; k < 11; k++) {
          if (modules[y][x + k] !== p1[k]) a = false;
          if (modules[y][x + k] !== p2[k]) b = false;
        }
        if (a || b) score += 40;
      }
    }
    for (let x = 0; x < size; x++) {
      for (let y = 0; y <= size - 11; y++) {
        let a = true;
        let b = true;
        for (let k = 0; k < 11; k++) {
          if (modules[y + k][x] !== p1[k]) a = false;
          if (modules[y + k][x] !== p2[k]) b = false;
        }
        if (a || b) score += 40;
      }
    }
    let dark = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) dark += modules[y][x];
    }
    const total = size * size;
    score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
    return score;
  }

  // --- Matrix construction ---

  function blankMatrix(size) {
    const modules = [];
    const func = [];
    const blank = [];
    for (let y = 0; y < size; y++) {
      modules.push(new Array(size).fill(0));
      func.push(new Array(size).fill(false));
      blank.push(new Array(size).fill(false));
    }
    return { modules, func, blank };
  }

  function setFunction(grid, x, y, value) {
    if (x < 0 || y < 0 || x >= grid.modules.length || y >= grid.modules.length) return;
    grid.modules[y][x] = value ? 1 : 0;
    grid.func[y][x] = true;
  }

  // Reserve a format/version cell: a function module that additionally reads
  // as light while masks are being scored (see buildMatrix).
  function reserveInfo(grid, x, y) {
    setFunction(grid, x, y, 0);
    if (x >= 0 && y >= 0 && x < grid.modules.length && y < grid.modules.length) {
      grid.blank[y][x] = true;
    }
  }

  function drawFinder(grid, x, y) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const dark =
          dx >= 0 &&
          dx <= 6 &&
          dy >= 0 &&
          dy <= 6 &&
          (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        // Separator ring (dx/dy in -1..7 but outside 0..6) is always light.
        setFunction(grid, x + dx, y + dy, dark);
      }
    }
  }

  function drawAlignment(grid, cx, cy) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const edge = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(grid, cx + dx, cy + dy, edge === 2 || (dx === 0 && dy === 0));
      }
    }
  }

  function drawFunctionPatterns(grid, version) {
    const size = grid.modules.length;
    drawFinder(grid, 0, 0);
    drawFinder(grid, size - 7, 0);
    drawFinder(grid, 0, size - 7);
    for (let i = 8; i < size - 8; i++) {
      const v = i % 2 === 0 ? 1 : 0;
      setFunction(grid, i, 6, v);
      setFunction(grid, 6, i, v);
    }
    const centres = ALIGNMENT[version];
    const last = centres[centres.length - 1];
    for (let a = 0; a < centres.length; a++) {
      for (let b = 0; b < centres.length; b++) {
        const x = centres[a];
        const y = centres[b];
        // Alignment patterns overlapping the finder patterns are omitted.
        if ((x === 6 && y === 6) || (x === 6 && y === last) || (x === last && y === 6)) continue;
        drawAlignment(grid, x, y);
      }
    }
    // Reserve the format-information areas (values are drawn per mask later):
    // copy 1 around the top-left finder, copy 2 along the bottom/left and
    // top/right edges, plus the fixed dark module.
    for (let i = 0; i < 6; i++) {
      reserveInfo(grid, 8, i);
      reserveInfo(grid, i, 8);
    }
    reserveInfo(grid, 8, 7);
    reserveInfo(grid, 7, 8);
    reserveInfo(grid, 8, 8);
    for (let i = 0; i < 6; i++) reserveInfo(grid, 5 - i, 8);
    for (let i = 0; i < 7; i++) reserveInfo(grid, 8, size - 7 + i);
    for (let i = 0; i < 8; i++) reserveInfo(grid, size - 1 - i, 8);
    reserveInfo(grid, 8, size - 8);
    // Reserve the version-information areas for versions >= 7.
    if (version >= 7) {
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        reserveInfo(grid, a, b);
        reserveInfo(grid, b, a);
      }
    }
  }

  // Standard zig-zag data placement from the bottom right, skipping function
  // modules and the vertical timing column. Remainder bits read as zero.
  function placeData(grid, finalCodewords, remainderCount) {
    const size = grid.modules.length;
    const totalDataBits = finalCodewords.length * 8;
    let bitIndex = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (grid.func[y][x]) continue;
          let bit = 0;
          if (bitIndex < totalDataBits) {
            bit = (finalCodewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1;
          }
          grid.modules[y][x] = bit;
          bitIndex++;
        }
      }
    }
  }

  // Draw one copy-pair of the 15 format bits plus the fixed dark module.
  // Coordinates are (x = column, y = row).
  function drawFormat(grid, size, bits15) {
    const bit = (i) => (bits15 >>> i) & 1;
    for (let i = 0; i < 6; i++) {
      setFunction(grid, 8, i, bit(i));
      setFunction(grid, i, 8, bit(i));
    }
    setFunction(grid, 8, 7, bit(6));
    setFunction(grid, 8, 8, bit(7));
    setFunction(grid, 7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFunction(grid, 15 - i - 1, 8, bit(i));
    for (let i = 8; i < 15; i++) setFunction(grid, 8, size - 15 + i, bit(i));
    for (let i = 0; i < 8; i++) setFunction(grid, size - 1 - i, 8, bit(i));
    setFunction(grid, 8, size - 8, 1);
  }

  function drawVersion(grid, size, version) {
    if (version < 7) return;
    const bits18 = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const v = (bits18 >>> i) & 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(grid, a, b, v);
      setFunction(grid, b, a, v);
    }
  }

  function copyModules(modules) {
    return modules.map((row) => row.slice());
  }

  function applyMaskTo(modules, func, mask) {
    const size = modules.length;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!func[y][x] && maskApplies(mask, x, y)) modules[y][x] ^= 1;
      }
    }
  }

  function buildMatrix(version, level, finalCodewords, forcedMask) {
    const size = 4 * version + 17;
    const grid = blankMatrix(size);
    drawFunctionPatterns(grid, version);
    placeData(grid, finalCodewords, REMAINDER_BITS[version - 1]);
    drawVersion(grid, size, version);

    let mask = forcedMask;
    if (mask == null) {
      // Evaluate all 8 masks and keep the lowest penalty; ties keep the
      // smaller mask number. Scoring reads the format/version/dark-module
      // cells as light (they carry no data yet and their final values must
      // not tip a close-mask decision); the shipped symbol still carries the
      // real format and version bits. This matches the reference
      // qrcode-generator lineage (python-qrcode test-mode scoring) and is
      // validated by the independent-source fixtures in tests/qr.test.js.
      let best = Infinity;
      mask = 0;
      for (let m = 0; m < 8; m++) {
        const trial = copyModules(grid.modules);
        applyMaskTo(trial, grid.func, m);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            if (grid.blank[y][x]) trial[y][x] = 0;
          }
        }
        const score = penaltyScore(trial);
        if (score < best) {
          best = score;
          mask = m;
        }
      }
    } else if (mask < 0 || mask > 7 || Math.floor(mask) !== mask) {
      throw QrError(`invalid mask override: ${mask}`, 'QR_MASK');
    }
    applyMaskTo(grid.modules, grid.func, mask);
    drawFormat(grid, size, formatBits(level, mask));
    return { size, mask, modules: grid.modules };
  }

  /**
   * Encode a base64url pairing payload as a QR symbol.
   * @param {string} text payload bytes (base64url alphabet; any
   *   single-byte characters are accepted and encoded as byte mode)
   * @param {{mask?: number}} [options] optional forced mask 0-7 (testing)
   * @returns {{version:number, level:string, size:number, mask:number,
   *   modules:number[][]}} matrix EXCLUDES the quiet zone
   */
  function encode(text, options) {
    if (typeof text !== 'string' || text.length === 0) {
      throw QrError('cannot encode an empty payload as a QR code', 'QR_EMPTY');
    }
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c > 255) {
        throw QrError(
          `payload character at index ${i} is outside byte range and cannot be byte-mode encoded`,
          'QR_CHARSET'
        );
      }
      bytes.push(c);
    }
    const sel = selectVersion(bytes.length);
    const size = 4 * sel.version + 17;
    if (size > MAX_LEGIBLE_MODULES) {
      throw QrError(
        `payload needs version ${sel.version} (${size}x${size} modules), ` +
          `past the legibility limit of version ${MAX_LEGIBLE_VERSION} ` +
          `(${MAX_LEGIBLE_MODULES}x${MAX_LEGIBLE_MODULES} modules); ` +
          `fall back to the link/copy forms instead of a code`,
        'QR_TOO_LARGE'
      );
    }
    const forcedMask = options && options.mask != null ? options.mask : null;
    const dataCodewords = buildDataCodewords(bytes, sel.version, sel.level);
    const finalCodewords = interleaveBlocks(dataCodewords, sel.version, sel.level);
    const built = buildMatrix(sel.version, sel.level, finalCodewords, forcedMask);
    return {
      version: sel.version,
      level: sel.level,
      size: built.size,
      mask: built.mask,
      modules: built.modules,
    };
  }

  /**
   * Render an encode() result onto a canvas with a quiet zone around it.
   * Safe to call without a DOM: a missing/incomplete canvas (or a canvas
   * whose context is unavailable, as in Node tests) makes this a no-op that
   * returns false instead of throwing.
   * @returns {boolean} true when something was drawn
   */
  function renderToCanvas(canvas, code, options) {
    if (!canvas || typeof canvas.getContext !== 'function' || !code || !code.modules) {
      return false;
    }
    options = options || {};
    const scale = options.scale > 0 ? Math.floor(options.scale) : 4;
    const margin = options.margin == null ? QUIET_ZONE_MODULES : Math.max(0, Math.floor(options.margin));
    const dark = options.dark || '#000000';
    const light = options.light || '#ffffff';
    const size = code.size;
    const extent = (size + margin * 2) * scale;
    let ctx = null;
    try {
      ctx = canvas.getContext('2d');
    } catch (err) {
      return false;
    }
    if (!ctx || typeof ctx.fillRect !== 'function') return false;
    canvas.width = extent;
    canvas.height = extent;
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, extent, extent);
    ctx.fillStyle = dark;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (code.modules[y][x]) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
      }
    }
    return true;
  }

  return {
    MIN_VERSION,
    MAX_VERSION,
    MAX_LEGIBLE_VERSION,
    MAX_LEGIBLE_MODULES,
    QUIET_ZONE_MODULES,
    QrError,
    selectVersion,
    encode,
    renderToCanvas,
    internals: {
      eccEntry,
      countBits,
      byteCapacity,
      gfBuildTables,
      gfMultiply,
      generatorPoly,
      rsRemainder,
      buildDataCodewords,
      interleaveBlocks,
      formatBits,
      versionBits,
      maskApplies,
      penaltyScore,
    },
  };
});
