// tests/pairing-codec.test.js
// Tests for the compact pairing payload codec (client/pairing-codec.js).
//
// Pipeline under test: trim SDP by whole candidate lines -> raw-deflate ->
// unpadded base64url on one line; decode reverses it. The round-trip property
// that matters is byte-identity: decode(encode(sdp)) === trim(sdp).

'use strict';

const assert = require('./assert');
const zlib = require('zlib');
const Codec = require('../client/pairing-codec.js');

const {
  trimCandidates,
  encodePayload,
  encodeText,
  decodePayload,
  estimateEncodedSize,
} = Codec;

const FINGERPRINT_HEX = Array.from({ length: 32 }, (_, i) =>
  i.toString(16).padStart(2, '0').toUpperCase()
).join(':');

function candidateLine(n, protocol, ip, port) {
  return `a=candidate:${n} 1 ${protocol} 211393715${n} ${ip} ${port} typ host`;
}

const STRUCT_HEAD = [
  'v=0',
  'o=- 4610447321403182948 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:X7k9',
  'a=ice-pwd:X7k9Q2mZ8tVbN4pL6sDfH1j',
  `a=fingerprint:sha-256 ${FINGERPRINT_HEX}`,
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
];

// Realistic multi-interface host: Wi-Fi, Ethernet, Docker bridge, WSL, VPN,
// plus the unusable candidates trimming must remove. CRLF endings like real SDP.
function realisticSdp() {
  const lines = [...STRUCT_HEAD];
  let n = 0;
  const next = () => ++n;
  lines.push(candidateLine(next(), 'udp', '192.168.1.50', 53556)); // Wi-Fi, kept
  lines.push(candidateLine(next(), 'udp', '192.168.1.50', 53558)); // duplicate IP, dropped
  lines.push(candidateLine(next(), 'tcp', '192.168.1.50', 9)); // TCP, dropped
  lines.push(candidateLine(next(), 'udp', '10.0.0.5', 54111)); // Ethernet, kept
  lines.push(candidateLine(next(), 'tcp', '10.0.0.5', 9)); // TCP, dropped
  lines.push(candidateLine(next(), 'udp', '172.17.0.1', 54222)); // Docker, kept
  lines.push(candidateLine(next(), 'udp', '172.17.0.1', 54230)); // duplicate IP, dropped
  lines.push(candidateLine(next(), 'udp', '172.21.21.5', 54333)); // WSL, kept
  lines.push(candidateLine(next(), 'udp', '10.8.0.2', 54444)); // VPN, kept
  lines.push(candidateLine(next(), 'udp', 'fe80::a654:3ff:fe12:3456', 54555)); // link-local, dropped
  lines.push('a=candidate:11 1 udp 2113937151 fe80::1 54556 typ host'); // link-local w/ zone id form, dropped
  lines.push(candidateLine(next(), 'udp', 'fd00::1a2b', 54666)); // unique-local, dropped
  lines.push(candidateLine(next(), 'udp', '169.254.10.20', 54777)); // v4 link-local, dropped
  lines.push(candidateLine(next(), 'udp', '100.64.0.5', 54888)); // CGNAT, dropped
  lines.push(candidateLine(next(), 'udp', '192.0.2.10', 54999)); // TEST-NET-1, dropped
  lines.push(candidateLine(next(), 'udp', '198.51.100.7', 55001)); // TEST-NET-2, dropped
  lines.push(candidateLine(next(), 'udp', '203.0.113.9', 55002)); // TEST-NET-3, dropped
  lines.push(
    'a=candidate:19 1 udp 2113937151 f8a3c9e2-1b2c-4d5e-8f90-1234567890ab.local 55003 typ host'
  ); // mDNS hostname, kept
  lines.push('a=end-of-candidates');
  return lines.join('\r\n') + '\r\n';
}

// Worst case: dozens of interfaces, duplicates, TCP and IPv6 noise.
function manyInterfaceSdp() {
  const lines = [...STRUCT_HEAD];
  let n = 0;
  for (let i = 0; i < 16; i++) {
    n += 1;
    lines.push(`a=candidate:${n} 1 udp 2113937151 192.168.${i}.10 ${50000 + i} typ host`);
    n += 1;
    lines.push(`a=candidate:${n} 1 udp 2113937151 192.168.${i}.10 ${51000 + i} typ host`); // duplicate
  }
  for (let i = 0; i < 12; i++) {
    n += 1;
    lines.push(`a=candidate:${n} 1 udp 2113937151 10.1.${i}.4 ${52000 + i} typ host`);
  }
  for (let i = 0; i < 8; i++) {
    n += 1;
    lines.push(`a=candidate:${n} 1 udp 2113937151 172.16.${i}.9 ${53000 + i} typ host`);
  }
  for (let i = 0; i < 10; i++) {
    n += 1;
    lines.push(`a=candidate:${n} 1 tcp 2113937151 192.168.1.${50 + i} 9 typ host tcp`);
  }
  for (let i = 0; i < 6; i++) {
    n += 1;
    lines.push(`a=candidate:${n} 1 udp 2113937151 fe80::a654:3ff:fe12:340${i} ${54000 + i} typ host`);
  }
  for (let i = 0; i < 4; i++) {
    n += 1;
    lines.push(`a=candidate:${n} 1 udp 2113937151 fd00::${i} ${55000 + i} typ host`);
  }
  n += 1;
  lines.push(`a=candidate:${n} 1 udp 2113937151 2001:db8::1 56000 typ host`); // global IPv6, kept
  lines.push('a=end-of-candidates');
  return lines.join('\r\n') + '\r\n';
}

function candidateIps(trimmed) {
  return trimmed
    .split('\r\n')
    .filter((l) => l.startsWith('a=candidate:'))
    .map((l) => l.split(/\s+/)[4]);
}

function toUnpaddedBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function rejectsNamed(promise, name, pattern) {
  try {
    await promise;
  } catch (err) {
    assert.equal(err.name, name, `expected error name ${name}, got ${err.name}: ${err.message}`);
    if (pattern) assert.match(err.message, pattern);
    return;
  }
  assert.fail(`expected ${name} to be thrown, but the call succeeded`);
}

const tests = {
  'round trip is byte-identical on a realistic multi-interface SDP': async () => {
    const sdp = realisticSdp();
    const trimmed = trimCandidates(sdp);
    assert.ok(trimmed.length < sdp.length, 'trimming should remove bytes');
    assert.ok(trimmed.includes('\r\n'), 'CRLF line endings are preserved');

    const code = await encodePayload(sdp);
    const decoded = await decodePayload(code);
    assert.equal(decoded, trimmed);
  },

  'realistic payload is under 700 chars and worst-case under 3000': async () => {
    const realistic = await encodePayload(realisticSdp());
    assert.ok(
      realistic.length < 700,
      `realistic payload is ${realistic.length} chars, budget is 700`
    );

    const worst = await encodePayload(manyInterfaceSdp());
    assert.ok(worst.length < 3000, `worst-case payload is ${worst.length} chars, budget is 3000`);

    // The worst-case fixture still round-trips byte-identical.
    assert.equal(await decodePayload(worst), trimCandidates(manyInterfaceSdp()));
  },

  'duplicate-IP candidates keep the first and drop the rest': async () => {
    const sdp = realisticSdp();
    const trimmed = trimCandidates(sdp);
    assert.ok(
      trimmed.includes('192.168.1.50 53556'),
      'first occurrence of the duplicate IP is kept'
    );
    assert.notOk(
      trimmed.includes('192.168.1.50 53558'),
      'second occurrence of the duplicate IP is dropped'
    );
    assert.notOk(trimmed.includes('172.17.0.1 54230'), 'duplicate Docker IP is dropped');
    assert.ok(trimmed.includes('172.17.0.1 54222'), 'first Docker candidate is kept');

    const ips = candidateIps(trimmed);
    assert.equal(ips.length, new Set(ips).size, 'no IP appears twice after trimming');
  },

  'TCP candidates are dropped while UDP host candidates survive': () => {
    const trimmed = trimCandidates(realisticSdp());
    const tcpLeft = trimmed
      .split('\r\n')
      .filter((l) => /^a=candidate:\S+ \S+ tcp /i.test(l));
    assert.equal(tcpLeft.length, 0, `expected no TCP candidates, found ${tcpLeft.length}`);
    assert.ok(trimmed.includes('192.168.1.50 53556 typ host'), 'Wi-Fi UDP host survives');
    assert.ok(trimmed.includes('10.0.0.5 54111 typ host'), 'Ethernet UDP host survives');
  },

  'structural lines are never dropped': () => {
    const trimmed = trimCandidates(realisticSdp());
    for (const line of [
      'a=ice-ufrag:X7k9',
      'a=ice-pwd:X7k9Q2mZ8tVbN4pL6sDfH1j',
      `a=fingerprint:sha-256 ${FINGERPRINT_HEX}`,
      'a=setup:actpass',
      'a=mid:0',
      'a=sctp-port:5000',
      'a=end-of-candidates',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 0.0.0.0',
      'o=- 4610447321403182948 2 IN IP4 127.0.0.1',
    ]) {
      assert.ok(trimmed.includes(line), `structural line survived: ${line.slice(0, 40)}`);
    }
  },

  'unreachable ranges are dropped but all RFC1918 host candidates are kept': () => {
    const trimmed = trimCandidates(realisticSdp());
    const ips = candidateIps(trimmed);
    for (const kept of [
      '192.168.1.50',
      '10.0.0.5',
      '172.17.0.1',
      '172.21.21.5',
      '10.8.0.2',
      'f8a3c9e2-1b2c-4d5e-8f90-1234567890ab.local',
    ]) {
      assert.ok(ips.includes(kept), `RFC1918/host candidate kept: ${kept}`);
    }
    assert.equal(ips.length, 6, `expected 6 kept candidates, got ${ips.length}: ${ips}`);
    for (const dropped of [
      'fe80::a654:3ff:fe12:3456',
      'fe80::1',
      'fd00::1a2b',
      '169.254.10.20',
      '100.64.0.5',
      '192.0.2.10',
      '198.51.100.7',
      '203.0.113.9',
    ]) {
      assert.notOk(ips.includes(dropped), `unreachable candidate dropped: ${dropped}`);
    }
  },

  'decoding never adds lines the encoder did not emit': async () => {
    const withoutEoc = realisticSdp().replace('a=end-of-candidates\r\n', '');
    const decoded = await decodePayload(await encodePayload(withoutEoc));
    assert.equal(decoded, trimCandidates(withoutEoc));
    assert.notOk(decoded.includes('end-of-candidates'), 'no phantom line is added');
  },

  'an SDP with zero usable candidates fails with NoUsableCandidatesError': async () => {
    const unusable = [
      'v=0',
      'o=- 1 2 IN IP4 127.0.0.1',
      'a=candidate:1 1 tcp 1 192.168.1.2 9 typ host tcp',
      'a=candidate:2 1 udp 1 fe80::1 5000 typ host',
      'a=candidate:3 1 udp 1 fd00::5 5001 typ host',
    ].join('\r\n');
    await rejectsNamed(encodePayload(unusable), 'NoUsableCandidatesError', /no usable.*candidate/i);
    assert.throws(() => trimCandidates(unusable));

    const none = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n';
    await rejectsNamed(encodePayload(none), 'NoUsableCandidatesError', /no usable.*candidate/i);

    await rejectsNamed(encodePayload('   '), 'PairingCodecError', /empty/i);
  },

  'decode rejects empty, garbage, padded and truncated input with named errors': async () => {
    const code = await encodePayload(realisticSdp());

    await rejectsNamed(decodePayload(''), 'MalformedPayloadError', /empty/i);
    await rejectsNamed(decodePayload('  \n\t  '), 'MalformedPayloadError', /empty/i);
    await rejectsNamed(decodePayload('!!!not-a-code!!!'), 'MalformedPayloadError', /invalid character '!'/);
    await rejectsNamed(decodePayload(code + '='), 'MalformedPayloadError', /invalid character '='/);
    await rejectsNamed(decodePayload('ab+cd'), 'MalformedPayloadError', /invalid character '\+'/);
    await rejectsNamed(decodePayload('ab/cd'), 'MalformedPayloadError', /invalid character '\/'/);
    await rejectsNamed(
      decodePayload(code.slice(0, code.length - 12)),
      'MalformedPayloadError',
      /truncat|corrupt|decompress|inflate/i
    );
    await rejectsNamed(decodePayload('A'), 'MalformedPayloadError', /invalid.*length.*truncat/i);
    await rejectsNamed(decodePayload(42), 'MalformedPayloadError', /must be a string, got number/);
  },

  'decode rejects compressed payloads that are not session descriptions': async () => {
    const notSdp = toUnpaddedBase64Url(zlib.deflateRawSync(Buffer.from('hello, not sdp')));
    await rejectsNamed(
      decodePayload(notSdp),
      'MalformedPayloadError',
      /not a session description/i
    );

    const repetitive = toUnpaddedBase64Url(zlib.deflateRawSync(Buffer.from('x'.repeat(64))));
    await rejectsNamed(
      decodePayload(repetitive),
      'MalformedPayloadError',
      /not a session description/i
    );

    const randomBytes = toUnpaddedBase64Url(Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1));
    await rejectsNamed(
      decodePayload(randomBytes),
      'MalformedPayloadError',
      /decompress|inflate|truncat|corrupt/i
    );
  },

  'decode tolerates whitespace and newlines pasted from chat clients': async () => {
    const sdp = realisticSdp();
    const code = await encodePayload(sdp);
    // Simulate a chat client wrapping the long line every 16 chars.
    const wrapped = code.replace(/(.{16})/g, '$1 \n');
    const pasted = `  \r\n ${wrapped}\r\n  `;
    assert.equal(await decodePayload(pasted), trimCandidates(sdp));
    assert.equal(await decodePayload(code.split('').join(' ')), trimCandidates(sdp));
  },

  'encoded output is single-line unpadded base64url': async () => {
    for (const sdp of [realisticSdp(), manyInterfaceSdp()]) {
      const code = await encodePayload(sdp);
      assert.match(code, /^[A-Za-z0-9-_]+$/, 'only base64url characters');
      assert.notOk(/[+/=\s]/.test(code), 'no padding, no base64 std chars, no whitespace');
    }
  },

  'estimateEncodedSize matches the actual encoded length': async () => {
    for (const sdp of [realisticSdp(), manyInterfaceSdp()]) {
      const code = await encodePayload(sdp);
      assert.equal(estimateEncodedSize(sdp), code.length);
      assert.ok(
        code.length < Buffer.byteLength(trimCandidates(sdp)),
        'compression actually shrinks the payload'
      );
    }
  },

  'encodeText round-trips a manual pairing envelope': async () => {
    // This is the app.js produce path: an old-format manual offer (base64
    // JSON) has its inner SDP trimmed, is re-stringified, and compressed.
    // The consume path inflates it back to JSON the old code accepts.
    const offerJson = JSON.stringify(manualOfferEnvelope(realisticSdp()));
    const envelope = JSON.parse(offerJson);
    envelope.signal.sdp.sdp = trimCandidates(envelope.signal.sdp.sdp);
    const slim = JSON.stringify(envelope);

    const code = await encodeText(slim);
    assert.match(code, /^[A-Za-z0-9-_]+$/);
    assert.ok(code.length < offerJson.length, 'compressed must beat the old base64');

    const back = await decodePayload(code);
    assert.equal(back, slim);
    const restored = JSON.parse(back);
    assert.equal(restored.app, 'lanshare');
    assert.equal(restored.role, 'offer');
    assert.ok(restored.signal.sdp.sdp.includes('a=ice-ufrag:'));
    assert.ok(restored.signal.sdp.sdp.includes('a=fingerprint:'));
  },

  'encodeText rejects empty input': async () => {
    await assert.rejects(() => encodeText(''), /empty/);
    await assert.rejects(() => encodeText(null), /empty|must be a string/);
  },

  'old-format base64 is distinguishable from new-format payloads': async () => {
    // Transition safety (task 7.5): the submit path must route each format
    // correctly. Old codes contain + / = which the new charset rejects.
    const oldCode = Buffer.from(JSON.stringify(manualOfferEnvelope(realisticSdp()))).toString('base64');
    const looksNew = /^[A-Za-z0-9\-_]+$/.test(oldCode.replace(/\s+/g, ''));
    if (oldCode.includes('+') || oldCode.includes('/') || oldCode.includes('=')) {
      assert.notOk(looksNew, 'old base64 with +/= must not be mistaken for new format');
    }
    const fresh = await encodeText(JSON.stringify(manualOfferEnvelope(realisticSdp())));
    assert.ok(/^[A-Za-z0-9\-_]+$/.test(fresh));
  },
};

function manualOfferEnvelope(sdp) {
  return {
    app: 'lanshare',
    version: 1,
    role: 'offer',
    connectionId: 'pair_test123',
    from: { peerId: 'peerA', info: { name: 'TestNode', type: 'laptop' } },
    signal: { sdp: { type: 'offer', sdp } },
  };
}

module.exports = { name: 'pairing-codec', tests };
