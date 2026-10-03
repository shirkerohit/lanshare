// tests/app-flow.test.js
// Flow-wiring tests for client/app.js (OpenSpec changes: signaling-rooms,
// pairing-friction, static-mode-trust).
//
// client/app.js is a browser IIFE, so like tests/webrtc.test.js this file
// evaluates the real source inside a vm sandbox and drives the exported
// AppFlow seam with fakes standing in for PeerManager / UI / TransferEngine.
// Every assertion is on observable behaviour, never on source text.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('./assert');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'client', 'app.js'), 'utf8');

// ---------------------------------------------------------------------------
// Fakes (the shared contracts, exactly named)
// ---------------------------------------------------------------------------

function makeUI() {
  return {
    calls: [],
    pending: new Map(),   // requestId -> peerId (showPairingPending)
    requests: new Map(),  // requestId -> args (showPairingRequest)
    notifications: [],
    statusCalls: [],
    peers: new Map(),
    confirmSendNext: true,
    confirmSendCalls: [],
    confirmIncomingNext: true,
    confirmIncomingCalls: [],
    shownCodes: [],
    clearedCodes: 0,
    incomingShown: [],
    manualCodes: [],

    showPairingRequest(args) {
      this.requests.set(args.requestId, args);
      this.calls.push(['showPairingRequest', args.requestId]);
    },
    clearPairingRequest(requestId) {
      this.requests.delete(requestId);
      this.calls.push(['clearPairingRequest', requestId]);
    },
    showPairingPending(requestId, peerId) {
      this.pending.set(requestId, peerId);
      this.calls.push(['showPairingPending', requestId, peerId]);
    },
    clearPairingPending(requestId) {
      this.pending.delete(requestId);
      this.calls.push(['clearPairingPending', requestId]);
    },
    async confirmSend(args) {
      this.confirmSendCalls.push(args);
      return this.confirmSendNext;
    },
    async confirmIncoming(args) {
      this.confirmIncomingCalls.push(args);
      return this.confirmIncomingNext;
    },
    showConfirmationCode(words) {
      this.shownCodes.push(words);
      this.calls.push(['showConfirmationCode', words]);
    },
    clearConfirmationCode() {
      this.clearedCodes++;
      this.calls.push(['clearConfirmationCode']);
    },
    showNotification(text, type) {
      this.notifications.push({ text, type });
    },
    setPairingStatus(text, isError) {
      this.statusCalls.push({ text, isError });
    },
    setManualCode(value) {
      this.manualCodes.push(value);
    },
    showIncoming(data) {
      this.incomingShown.push(data);
    },
    clearTransfer(peerId) {
      this.calls.push(['clearTransfer', peerId]);
    },
  };
}

function makePeerManager() {
  return {
    requestCalls: [],
    respondCalls: [],
    connectCalls: [],
    sentJson: [],
    manualCalls: [],
    nextRequest: 0,

    // Contract: requestPairing(peerId) -> requestId
    requestPairing(peerId) {
      this.nextRequest++;
      const id = `req-${this.nextRequest}`;
      this.requestCalls.push(peerId);
      return id;
    },
    // Contract: respondPairing(requestId, accept, peerId)
    respondPairing(requestId, accept, peerId) {
      this.respondCalls.push({ requestId, accept, peerId });
    },
    // Contract: getEndpoint() -> string|null
    getEndpoint() {
      return null;
    },
    // Existing manual path (webrtc.js): offer -> response, answer -> apply.
    async processManualCode(code) {
      this.manualCalls.push(code);
      if (String(code).includes('ANSWER')) return { role: 'answer' };
      return { role: 'offer', responseCode: `RESP:${code}` };
    },
    // Existing initiator entry point used by app.js.
    _initiatePeerConnection(peerId) {
      this.connectCalls.push(peerId);
    },
    sendJsonToPeer(peerId, msg) {
      this.sentJson.push({ peerId, msg });
      return true;
    },
  };
}

function makeTransfer() {
  return {
    sendFileCalls: [],
    outgoing: new Map(), // transfer state that must survive signaling blips
    incoming: new Map(),
    async sendFile(file, peerId, onProgress) {
      this.sendFileCalls.push({ file, peerId, onProgress: typeof onProgress });
      return 'transfer-1';
    },
  };
}

function makeCodec() {
  return {
    decodeCalls: [],
    async decodePayload(code) {
      this.decodeCalls.push(code);
      if (String(code).includes('BAD')) throw new Error('pairing code is not valid');
      return `DECODED:${code}`;
    },
    async encodePayload(sdp) {
      return `PAY:${sdp}`;
    },
  };
}

function makeLocation(hash) {
  return { hash: hash || '', pathname: '/', search: '' };
}

function makeHistory() {
  return {
    calls: [],
    replaceState(...args) {
      this.calls.push(args);
    },
  };
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

function loadAppFlow({ withCrypto = true } = {}) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    TextEncoder,
    TextDecoder,
  };
  if (withCrypto) {
    sandbox.crypto = require('crypto').webcrypto;
  }
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'client/app.js' });
  assert.ok(sandbox.AppFlow, 'app.js must export the AppFlow test seam');
  return sandbox.AppFlow;
}

function makeFlow(AppFlow, overrides = {}) {
  const ui = overrides.ui || makeUI();
  const peerManager = overrides.peerManager || makePeerManager();
  const transfer = overrides.transfer || makeTransfer();
  const codec = overrides.codec || makeCodec();
  const location = overrides.location || makeLocation('');
  const history = overrides.history || makeHistory();
  const flow = AppFlow.createAppFlow({
    peerManager, ui, transfer, codec, location, history, localId: 'local-peer',
  });
  return { flow, ui, peerManager, transfer, codec, location, history };
}

function notified(ui, pattern) {
  return ui.notifications.filter((n) => pattern.test(n.text));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests = {
  'outgoing request shows pending; accept connects the initiator exactly once': () => {
    const AppFlow = loadAppFlow();
    const { flow, ui, peerManager } = makeFlow(AppFlow);

    const requestId = flow.requestPair('peer-b');
    assert.ok(requestId, 'requestPair returns a request id');
    assert.deepEqual(ui.pending.get(requestId), 'peer-b');
    assert.deepEqual(peerManager.requestCalls, ['peer-b']);

    const out = flow.handleMessage({ type: 'pairing_accepted', requestId, peerId: 'peer-b' });
    assert.equal(out, 'accepted');
    assert.deepEqual(peerManager.connectCalls, ['peer-b'], 'initiator connects on accept');
    assert.equal(ui.pending.has(requestId), false, 'pending state is cleared');
  },

  'duplicate accept for the same request connects only once': () => {
    const AppFlow = loadAppFlow();
    const { flow, peerManager } = makeFlow(AppFlow);

    const requestId = flow.requestPair('peer-b');
    flow.handleMessage({ type: 'pairing_accepted', requestId, peerId: 'peer-b' });
    flow.handleMessage({ type: 'pairing_accepted', requestId, peerId: 'peer-b' });
    flow.handleMessage({ type: 'pairing_accept', requestId, peerId: 'peer-b' });
    assert.equal(peerManager.connectCalls.length, 1, 'initiator connects exactly once');
  },

  'incoming request accept responds true and waits; decline responds false; neither connects': () => {
    const AppFlow = loadAppFlow();
    const { flow, ui, peerManager } = makeFlow(AppFlow);

    const out = flow.handleMessage({
      type: 'pairing_request', requestId: 'r-1', peerId: 'peer-a', info: { name: 'A' },
    });
    assert.equal(out, 'requested');
    assert.equal(ui.requests.has('r-1'), true, 'recipient sees the request');

    ui.requests.get('r-1').onAccept();
    assert.deepEqual(peerManager.respondCalls, [{ requestId: 'r-1', accept: true, peerId: 'peer-a' }]);
    assert.equal(peerManager.connectCalls.length, 0, 'recipient waits for the offer, does not connect');

    flow.handleMessage({
      type: 'pairing_request', requestId: 'r-2', peerId: 'peer-c', info: { name: 'C' },
    });
    ui.requests.get('r-2').onDecline();
    assert.deepEqual(peerManager.respondCalls[1], { requestId: 'r-2', accept: false, peerId: 'peer-c' });
    assert.equal(peerManager.connectCalls.length, 0, 'decline connects nothing');
  },

  'declined request connects nothing on the requester side': () => {
    const AppFlow = loadAppFlow();
    const { flow, ui, peerManager } = makeFlow(AppFlow);

    const requestId = flow.requestPair('peer-b');
    const out = flow.handleMessage({ type: 'pairing_declined', requestId, peerId: 'peer-b' });
    assert.equal(out, 'declined');
    assert.equal(peerManager.connectCalls.length, 0, 'no handshake after a decline');
    assert.equal(ui.pending.has(requestId), false, 'pending state is cleared');
    assert.ok(notified(ui, /declined/i).length >= 1, 'requester is informed');
  },

  'expired request ignores a late accept': () => {
    const AppFlow = loadAppFlow();
    const { flow, peerManager } = makeFlow(AppFlow);

    const requestId = flow.requestPair('peer-b');
    assert.equal(flow.handleMessage({ type: 'pairing_expired', requestId, peerId: 'peer-b' }), 'expired');
    const out = flow.handleMessage({ type: 'pairing_accepted', requestId, peerId: 'peer-b' });
    assert.equal(out, 'ignored-expired', 'late accept is ignored');
    assert.equal(peerManager.connectCalls.length, 0, 'no connection from a stale request');
  },

  'expiry clears pending on both sides and notifies': () => {
    const AppFlow = loadAppFlow();
    const { flow, ui } = makeFlow(AppFlow);

    const requestId = flow.requestPair('peer-b');
    flow.handleMessage({
      type: 'pairing_request', requestId: 'r-in', peerId: 'peer-c', info: {},
    });
    flow.handleMessage({ type: 'pairing_expired', requestId, peerId: 'peer-b' });
    flow.handleMessage({ type: 'pairing_expired', requestId: 'r-in', peerId: 'peer-c' });

    assert.equal(ui.pending.has(requestId), false, 'outgoing pending cleared');
    assert.equal(ui.requests.has('r-in'), false, 'incoming request cleared');
    assert.ok(
      ui.calls.some((c) => c[0] === 'clearPairingPending' || c[0] === 'clearPairingRequest'),
      'clear calls issued'
    );
    assert.ok(notified(ui, /timed out|expir/i).length >= 1, 'expiry is reported');
  },

  'signaling_down shows reconnect banner and keeps transfer state; signaling_up clears': () => {
    const AppFlow = loadAppFlow();
    const { flow, ui, transfer } = makeFlow(AppFlow);

    transfer.outgoing.set('t-9', { fileName: 'big.bin' });
    transfer.incoming.set('t-10', { fileName: 'in.bin' });

    assert.equal(flow.handleMessage({ type: 'signaling_down' }), 'signaling_down');
    assert.equal(flow.state.signalingDown, true);
    const banner = notified(ui, /reconnecting/i);
    assert.ok(banner.length >= 1, 'reconnect banner shown');
    assert.ok(/transfers continue/i.test(banner[0].text), 'banner says transfers continue');
    assert.equal(transfer.outgoing.has('t-9'), true, 'outgoing transfer state kept');
    assert.equal(transfer.incoming.has('t-10'), true, 'incoming transfer state kept');

    assert.equal(flow.handleMessage({ type: 'signaling_up' }), 'signaling_up');
    assert.equal(flow.state.signalingDown, false, 'banner state cleared');
    assert.equal(transfer.outgoing.has('t-9'), true, 'transfers still intact after up');
  },

  'reconnect_required names the peer with a re-pair hint': () => {
    const AppFlow = loadAppFlow();
    const { flow, ui } = makeFlow(AppFlow);

    const out = flow.handleMessage({ type: 'reconnect_required', peerId: 'peer-z', reason: 'retries_exhausted' });
    assert.equal(out, 'reconnect_required');
    assert.equal(ui.notifications.length, 1);
    assert.ok(ui.notifications[0].text.includes('peer-z'), 'notice names the peer');
    assert.ok(/re-pair/i.test(ui.notifications[0].text), 'notice carries a re-pair hint');
  },

  'sendFile declined by confirmSend transmits zero bytes and creates no state': async () => {
    const AppFlow = loadAppFlow();
    const { flow, ui, transfer } = makeFlow(AppFlow);
    ui.confirmSendNext = false;

    const file = { name: 'report.pdf', size: 12345 };
    const result = await flow.sendFileWithConfirm(file, 'peer-a');
    assert.equal(result, null, 'decline sends nothing');
    assert.equal(transfer.sendFileCalls.length, 0, 'zero bytes via the engine');
    assert.equal(ui.confirmSendCalls.length, 1);
    assert.equal(ui.confirmSendCalls[0].fileName, 'report.pdf');
    assert.equal(ui.confirmSendCalls[0].fileSize, 12345);
    assert.ok(ui.confirmSendCalls[0].peerName, 'confirmation names the destination');
  },

  'sendFile confirmed by confirmSend transmits': async () => {
    const AppFlow = loadAppFlow();
    const { flow, ui, transfer } = makeFlow(AppFlow);
    ui.confirmSendNext = true;
    ui.peers.set('peer-a', { info: { name: 'Ana' } });

    const file = { name: 'photo.png', size: 99 };
    const result = await flow.sendFileWithConfirm(file, 'peer-a');
    assert.equal(result, 'transfer-1');
    assert.equal(transfer.sendFileCalls.length, 1);
    assert.equal(ui.confirmSendCalls[0].peerName, 'Ana', 'confirmation names the device');
  },

  'incoming declined discards and notifies sender; accepted surfaces': async () => {
    const AppFlow = loadAppFlow();
    const { flow, ui, peerManager } = makeFlow(AppFlow);

    ui.confirmIncomingNext = false;
    const declined = await flow.handleIncomingWithConfirm({
      transferId: 42, peerId: 'peer-a', fileName: 'secret.zip', fileSize: 7,
    });
    assert.equal(declined, false);
    assert.equal(ui.incomingShown.length, 0, 'declined file is discarded, never surfaced');
    assert.equal(peerManager.sentJson.length, 1, 'sender is notified');
    assert.deepEqual(peerManager.sentJson[0].msg, { type: 'transfer_declined', transferId: 42 });
    assert.equal(peerManager.sentJson[0].peerId, 'peer-a');

    ui.confirmIncomingNext = true;
    const accepted = await flow.handleIncomingWithConfirm({
      transferId: 43, peerId: 'peer-a', fileName: 'ok.zip', fileSize: 8,
    });
    assert.equal(accepted, true);
    assert.equal(ui.incomingShown.length, 1);
    assert.equal(ui.confirmIncomingCalls[1].fileName, 'ok.zip');
    assert.ok(ui.confirmIncomingCalls[1].fromName, 'incoming confirmation names the sender');
  },

  'fragment #o= restores the offer flow and scrubs the hash first': async () => {
    const AppFlow = loadAppFlow();
    const location = makeLocation('#o=OFFER123');
    const history = makeHistory();
    const { flow, ui, peerManager, codec } = makeFlow(AppFlow, { location, history });

    let scrubbedAtDecode = -1;
    const origDecode = codec.decodePayload.bind(codec);
    codec.decodePayload = async (code) => {
      scrubbedAtDecode = history.calls.length;
      return origDecode(code);
    };

    const pending = flow.restoreFragment();
    assert.equal(history.calls.length, 1, 'hash scrubbed synchronously, before decode resolves');
    assert.ok(!String(history.calls[0][2]).includes('#'), 'scrubbed URL keeps no fragment');
    const res = await pending;
    assert.equal(scrubbedAtDecode, 1, 'decode ran only after the scrub');
    assert.deepEqual(res, { handled: true, ok: true, kind: 'offer', result: res.result });
    assert.deepEqual(peerManager.manualCalls, ['DECODED:OFFER123'], 'decoded offer drives the manual path');
    assert.ok(ui.manualCodes.length >= 1 || ui.statusCalls.length >= 1, 'answer/status surfaces');
  },

  'fragment #a= restores the answer flow': async () => {
    const AppFlow = loadAppFlow();
    const location = makeLocation('#a=ANSWER456');
    const history = makeHistory();
    const { flow, peerManager } = makeFlow(AppFlow, { location, history });

    const res = await flow.restoreFragment();
    assert.equal(res.handled, true);
    assert.equal(res.ok, true);
    assert.equal(res.kind, 'answer');
    assert.deepEqual(peerManager.manualCalls, ['DECODED:ANSWER456'], 'decoded answer is applied');
    assert.ok(!String(history.calls[0][2]).includes('#'), 'hash scrubbed');
  },

  'malformed fragment errors cleanly with no state disturbance': async () => {
    const AppFlow = loadAppFlow();
    const location = makeLocation('#o=BAD!!!');
    const history = makeHistory();
    const { flow, ui, peerManager } = makeFlow(AppFlow, { location, history });

    const res = await flow.restoreFragment();
    assert.equal(res.handled, true);
    assert.equal(res.ok, false, 'malformed link fails');
    assert.equal(history.calls.length, 1, 'hash still scrubbed first');
    assert.equal(peerManager.manualCalls.length, 0, 'manual path never engaged');
    const errored =
      ui.statusCalls.some((s) => s.isError) || ui.notifications.some((n) => n.type === 'error');
    assert.ok(errored, 'user gets a clear error');
    assert.equal(flow.state.confirm.has('manual'), false, 'no confirmation state created');
    assert.equal(flow.state.outgoing.size, 0, 'no pairing state created');
  },

  'non-pairing hash is ignored': async () => {
    const AppFlow = loadAppFlow();
    const { flow, peerManager } = makeFlow(AppFlow, { location: makeLocation('#panel-chat') });
    const res = await flow.restoreFragment();
    assert.deepEqual(res, { handled: false });
    assert.equal(peerManager.manualCalls.length, 0);
  },

  'confirmation code is identical on both sides, different when altered': async () => {
    const AppFlow = loadAppFlow();
    const a = makeFlow(AppFlow);
    const b = makeFlow(AppFlow);

    const wordsA = await a.flow.beginConfirmation('peer-x', 'OFFER-abc', 'ANSWER-abc');
    const wordsB = await b.flow.beginConfirmation('peer-x', 'ANSWER-abc', 'OFFER-abc');
    assert.equal(wordsA.length, 4, 'four words');
    assert.deepEqual(wordsA, wordsB, 'same exchange, either order -> identical code');
    assert.deepEqual(a.ui.shownCodes[0], wordsA, 'shown via ui.showConfirmationCode');

    const wordsC = await b.flow.beginConfirmation('peer-x', 'ANSWER-abc', 'OFFER-abd');
    assert.ok(wordsC.join(' ') !== wordsA.join(' '), 'altered payload -> different code');
    for (const w of wordsA) {
      assert.ok(AppFlow.CONFIRM_WORDS.includes(w), `word ${w} comes from the fixed list`);
    }
  },

  'unconfirmed pairing never enables transfer; confirm or skip enables': async () => {
    const AppFlow = loadAppFlow();
    const { flow, ui, transfer } = makeFlow(AppFlow);

    await flow.beginConfirmation('peer-g', 'OFFER-1', 'ANSWER-1');
    assert.equal(flow.isTransferEnabled('peer-g'), false, 'unconfirmed pairing blocks transfer');
    const blocked = await flow.sendFileWithConfirm({ name: 'x', size: 1 }, 'peer-g');
    assert.equal(blocked, null);
    assert.equal(transfer.sendFileCalls.length, 0);
    assert.ok(notified(ui, /confirm/i).length >= 1, 'user is told to confirm');

    flow.confirmPairing('peer-g');
    assert.equal(flow.isTransferEnabled('peer-g'), true);
    assert.equal(ui.clearedCodes, 1, 'code cleared after confirm');
    const sent = await flow.sendFileWithConfirm({ name: 'x', size: 1 }, 'peer-g');
    assert.equal(sent, 'transfer-1');

    await flow.beginConfirmation('peer-s', 'OFFER-2', 'ANSWER-2');
    assert.equal(flow.isTransferEnabled('peer-s'), false);
    flow.skipPairing('peer-s');
    assert.equal(flow.isTransferEnabled('peer-s'), true, 'explicit skip records and enables');
    assert.equal(flow.state.confirm.get('peer-s').skipped, true, 'skip is recorded');
  },

  'manual input accepts raw payload, full links, and whitespace': () => {
    const AppFlow = loadAppFlow();

    assert.deepEqual(AppFlow.normalizePairingInput('  ABC-123\n'), { kind: null, payload: 'ABC-123' });
    assert.deepEqual(
      AppFlow.normalizePairingInput('https://lanshare.local/#o=ABC123'),
      { kind: 'offer', payload: 'ABC123' }
    );
    assert.deepEqual(
      AppFlow.normalizePairingInput('open https://host:3000/?x=1#o=AB\nCD&foo=1 to pair'),
      { kind: 'offer', payload: 'ABCD' }
    );
    assert.deepEqual(
      AppFlow.normalizePairingInput('#a=  ZZ 99 '),
      { kind: 'answer', payload: 'ZZ99' }
    );
  },

  'confirmation word list has 256 unique words': () => {
    const AppFlow = loadAppFlow();
    assert.equal(AppFlow.CONFIRM_WORDS.length, 256, 'fixed 256-word list');
    assert.equal(new Set(AppFlow.CONFIRM_WORDS).size, 256, 'no duplicates');
    for (const w of AppFlow.CONFIRM_WORDS) {
      assert.ok(typeof w === 'string' && w.length > 0 && w === w.trim(), `clean word, got ${w}`);
    }
  },

  'sha256 subtle and embedded fallback agree': async () => {
    const withSubtle = loadAppFlow({ withCrypto: true });
    const without = loadAppFlow({ withCrypto: false });
    const a = await withSubtle.sha256Hex('OFFER-abc|ANSWER-abc');
    const b = await without.sha256Hex('OFFER-abc|ANSWER-abc');
    assert.equal(a.length, 64);
    assert.equal(a, b, 'fallback matches crypto.subtle');
    const words = await without.deriveConfirmationWords('ANSWER-abc', 'OFFER-abc');
    const words2 = await withSubtle.deriveConfirmationWords('OFFER-abc', 'ANSWER-abc');
    assert.deepEqual(words, words2);
  },
};

module.exports = { name: 'app-flow', tests };
