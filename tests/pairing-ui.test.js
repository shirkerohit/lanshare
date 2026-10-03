// tests/pairing-ui.test.js
// Tests for the visible pairing and confirmation UI in client/ui.js.
//
// client/ui.js is a browser class, so — like tests/webrtc.test.js and
// tests/xss.test.js — each test evaluates the real source in a vm sandbox
// with stubbed globals (document, window, navigator, localStorage,
// Identity, timers), drives the pairing panel/request/confirmation paths,
// and asserts on behaviour: DOM structure strings, parsed payloads, and
// Promise outcomes. Nothing here inspects pixels or the source text.
//
// client/qr.js is loaded into the same sandbox (unless a test opts out) so
// the QR path exercises the real encoder; pairing payloads here are short
// base64url strings, which is all the UI layer may assume about them.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('./assert');

const UI_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'client', 'ui.js'), 'utf8');
const QR_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'client', 'qr.js'), 'utf8');

// ---------------------------------------------------------------------------
// Fake DOM: stores innerHTML as a string AND parses <button> children out of
// it so tests can both assert on structure strings and drive behaviour by
// clicking the parsed buttons. querySelector supports the small selector set
// the UI code uses ([data-act=".."], #id, .class, tag).
// ---------------------------------------------------------------------------

const SEEDED_HIDDEN = new Set([
  'pairing-panel',
  'pairing-qr-fallback',
  'pairing-error',
  'confirmation-overlay',
  'signaling-banner',
]);

class FakeClassList {
  constructor() { this._s = new Set(); }
  add(...c) { c.forEach((x) => this._s.add(x)); }
  remove(...c) { c.forEach((x) => this._s.delete(x)); }
  toggle(c, force) {
    if (force === undefined) this._s.has(c) ? this._s.delete(c) : this._s.add(c);
    else if (force) this._s.add(c);
    else this._s.delete(c);
    return this._s.has(c);
  }
  contains(c) { return this._s.has(c); }
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([\w-]+)(?:="([^"]*)")?/g;
  let m;
  while ((m = re.exec(src))) attrs[m[1]] = m[2] === undefined ? '' : m[2];
  return attrs;
}

function matches(el, sel) {
  const s = String(sel).trim();
  let m = s.match(/^\[data-act="([^"]+)"\]$/);
  if (m) return el.dataset && el.dataset.act === m[1];
  if (s.startsWith('#')) return el.id === s.slice(1);
  if (s.startsWith('.')) return el.classList.contains(s.slice(1));
  return el.tagName === s.toUpperCase();
}

function findAll(root, sel, out) {
  for (const child of root.children) {
    if (matches(child, sel)) out.push(child);
    findAll(child, sel, out);
  }
  return out;
}

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this._doc = doc || null;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this.style = { setProperty() { } };
    this.classList = new FakeClassList();
    this._listeners = {};
    this._html = '';
    this._text = '';
    this.id = '';
    this.className = '';
    this.value = '';
    this.placeholder = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.width = 0;
    this.height = 0;
    this._focused = false;
  }

  set innerHTML(v) {
    this._html = String(v);
    this.children = this.children.filter((c) => !c._parsed);
    const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
    let m;
    while ((m = re.exec(this._html))) {
      const btn = new FakeElement('button', this._doc);
      btn._parsed = true;
      const attrs = parseAttrs(m[1]);
      for (const [k, val] of Object.entries(attrs)) {
        if (k === 'class') btn.className = val;
        else if (k === 'type') btn.type = val;
        else if (k.startsWith('data-')) {
          btn.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val;
        } else btn.attributes[k] = val;
      }
      btn.textContent = m[2].replace(/<[^>]+>/g, '');
      this.appendChild(btn);
    }
  }
  get innerHTML() { return this._html; }

  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }

  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  addEventListener(type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  }
  click() {
    for (const fn of this._listeners.click || []) fn({});
  }
  focus() { this._focused = true; }
  select() { }
  querySelector(sel) {
    const found = findAll(this, sel, []);
    return found.length ? found[0] : null;
  }
  querySelectorAll(sel) { return findAll(this, sel, []); }
  closest() { return null; }
}

function createDocument() {
  const doc = {
    _ids: new Map(),
    execCalls: [],
    body: null,
    documentElement: null,
    getElementById(id) {
      if (!doc._ids.has(id)) {
        const el = new FakeElement('div', doc);
        el.id = id;
        if (SEEDED_HIDDEN.has(id)) el.classList.add('hidden');
        doc._ids.set(id, el);
      }
      return doc._ids.get(id);
    },
    createElement(tag) { return new FakeElement(tag, doc); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    execCommand(cmd) { doc.execCalls.push(cmd); return true; },
  };
  doc.body = new FakeElement('body', doc);
  doc.documentElement = new FakeElement('html', doc);
  return doc;
}

function createStorage() {
  const m = new Map();
  return {
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    clear() { m.clear(); },
  };
}

function createSandbox({ withQr = true, withClipboard = true } = {}) {
  const doc = createDocument();
  const storage = createStorage();
  const timers = [];
  const clipboardWrites = [];
  const sandbox = {
    console: { log() { }, warn() { }, error() { }, debug() { } },
    document: doc,
    localStorage: storage,
    navigator: withClipboard
      ? { clipboard: { writeText: async (t) => { clipboardWrites.push(t); } } }
      : {},
    Identity: {
      getPalette() { return ['#00ffcc', '#ffffff']; },
      drawAvatar() { },
    },
    requestAnimationFrame: () => 0,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => { },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  if (withQr) vm.runInContext(QR_SOURCE, sandbox, { filename: 'client/qr.js' });
  vm.runInContext(UI_SOURCE, sandbox, { filename: 'client/ui.js' });
  return {
    sandbox, UI: sandbox.UI, doc, storage, timers, clipboardWrites,
    fireTimers() { const p = timers.splice(0); p.forEach((fn) => fn()); },
  };
}

function makeUI(opts) {
  const env = createSandbox(opts);
  const ui = new env.UI();
  ui.local = { id: 'local-peer', name: 'Local' };
  return { ui, ...env };
}

/** Attach a working 2d context stub to the pairing QR canvas. */
function enableCanvas(doc) {
  const canvas = doc.getElementById('pairing-qr');
  canvas.getContext = () => ({ fillRect() { } });
  return canvas;
}

function stripTags(html) {
  return String(html).replace(/<[^>]+>/g, '');
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** True when the promise settles before the microtask queue drains. */
async function settled(promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  await flush();
  await flush();
  return done;
}

// A fixed 64-char base64url payload: all the UI layer may assume.
const RAW = 'aB3_xK9mQ2vZ7cF4hJ8nL1pR5tW6yD0eG-uH3iK9lM2nO7pQ4rS8tU1vW5xY6zA0b';

const tests = {
  'four forms decode identically from one payload': async () => {
    const { ui, doc, clipboardWrites } = makeUI();
    enableCanvas(doc);
    const link = `https://lanshare.test/#o=${RAW}`;

    assert.equal(ui.showPairingPanel({ raw: RAW, link }), true);

    // Copy value.
    assert.equal(await ui.copyPairingCode(), true);
    assert.equal(clipboardWrites.length, 1);
    assert.equal(clipboardWrites[0], RAW);

    // Clickable link carries the same payload in its fragment.
    const linkEl = doc.getElementById('pairing-link');
    assert.equal(linkEl.getAttribute('href'), link);
    const fromLink = ui.acceptEitherForm(linkEl.textContent);
    assert.equal(fromLink.kind, 'link');
    assert.equal(fromLink.role, 'offer');
    assert.equal(fromLink.payload, RAW);

    // Grouped text strips back to the same payload.
    const groupedHtml = doc.getElementById('pairing-grouped').innerHTML;
    assert.ok(groupedHtml.includes('pair-group'), `grouped text must be chunked, got: ${groupedHtml}`);
    const fromGrouped = ui.acceptEitherForm(stripTags(groupedHtml));
    assert.equal(fromGrouped.kind, 'raw');
    assert.equal(fromGrouped.payload, RAW);

    // QR path encodes the same payload and draws onto our canvas.
    const canvas = doc.getElementById('pairing-qr');
    assert.ok(canvas.width > 0, 'QR canvas should have been sized by renderToCanvas');
    assert.equal(canvas.classList.contains('hidden'), false);
    assert.equal(doc.getElementById('pairing-qr-fallback').classList.contains('hidden'), true);
  },

  'QR_TOO_LARGE falls back to link+copy+grouped without throwing': () => {
    const { ui, doc } = makeUI();
    enableCanvas(doc);
    const huge = 'X'.repeat(4000);
    const link = `https://lanshare.test/#o=${huge}`;

    let threw = null;
    let shown = false;
    try {
      shown = ui.showPairingPanel({ raw: huge, link });
    } catch (err) {
      threw = err;
    }
    assert.equal(threw, null, `QR_TOO_LARGE must not throw, got: ${threw && threw.message}`);
    assert.equal(shown, true);

    // No unscannable code is shown; the other three forms are all present.
    assert.equal(doc.getElementById('pairing-qr').classList.contains('hidden'), true);
    assert.equal(doc.getElementById('pairing-qr-fallback').classList.contains('hidden'), false);
    assert.equal(doc.getElementById('pairing-link').getAttribute('href'), link);
    assert.equal(stripTags(doc.getElementById('pairing-grouped').innerHTML), huge);
  },

  'no QR library or canvas still shows link+copy+grouped': async () => {
    const { ui, doc, clipboardWrites } = makeUI({ withQr: false });
    assert.equal(ui.showPairingPanel({ raw: RAW, link: `https://x/#a=${RAW}` }), true);
    assert.equal(doc.getElementById('pairing-link').textContent.includes(RAW), true);
    assert.equal(stripTags(doc.getElementById('pairing-grouped').innerHTML), RAW);
    assert.equal(await ui.copyPairingCode(), true);
    assert.equal(clipboardWrites[0], RAW);
  },

  'paste of a raw payload and of a link are accepted identically': () => {
    const { ui } = makeUI();
    const link = `https://lanshare.test/some/path#o=${RAW}`;
    const fromRaw = ui.acceptEitherForm(RAW);
    const fromLink = ui.acceptEitherForm(link);
    assert.deepEqual(
      { kind: fromRaw.kind, payload: fromRaw.payload },
      { kind: 'raw', payload: RAW }
    );
    assert.equal(fromLink.kind, 'link');
    assert.equal(fromLink.payload, RAW);
    assert.equal(fromLink.payload, fromRaw.payload);
  },

  'paste auto-submits without a separate button press': () => {
    const { ui, doc, fireTimers } = makeUI();
    ui._bindPairingPanel();
    const seen = [];
    ui.onPairingSubmit = (parsed) => seen.push(parsed);

    const input = doc.getElementById('pairing-input');
    const paste = (input._listeners.paste || [])[0];
    assert.ok(paste, 'a paste listener must be bound to the pairing input');
    paste({ clipboardData: { getData: () => `https://lanshare.test/#a=${RAW}` } });
    fireTimers();

    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, 'link');
    assert.equal(seen[0].role, 'answer');
    assert.equal(seen[0].payload, RAW);
  },

  'whitespace from chat clients is tolerated': () => {
    const { ui } = makeUI();
    const mangled = `${RAW.slice(0, 8)} ${RAW.slice(8, 16)}\n${RAW.slice(16, 32)}\r\n ${RAW.slice(32)} `;
    assert.equal(ui.acceptEitherForm(mangled).payload, RAW);
  },

  'invalid input errors with no state created': () => {
    const { ui, doc } = makeUI();
    let message = null;
    try {
      ui.acceptEitherForm('!!! not a pairing code !!!');
    } catch (err) {
      message = err.message;
    }
    assert.ok(message, 'invalid input must raise');
    assert.ok(/not a valid pairing code/i.test(message), `message must say so: ${message}`);
    assert.equal(ui._pairingRaw, null);
    assert.equal(ui._pairingRequests.size, 0);
    assert.equal(ui._pairingPending.size, 0);
    assert.equal(doc.getElementById('pairing-error').classList.contains('hidden'), true);

    ui.reportPairingError(message);
    assert.equal(doc.getElementById('pairing-error').textContent, message);
    assert.equal(doc.getElementById('pairing-error').classList.contains('hidden'), false);
  },

  'focusPairingInput focuses the pairing input': () => {
    const { ui, doc } = makeUI();
    ui.focusPairingInput();
    assert.equal(doc.getElementById('pairing-input')._focused, true);
  },

  'confirmSend names file and destination, accept resolves true': async () => {
    const { ui, doc } = makeUI();
    const p = ui.confirmSend({ fileName: 'report.pdf', fileSize: 2048, peerName: 'lab-desktop' });
    const root = doc.getElementById('transfer-confirm-root');
    assert.equal(root.children.length, 1);
    const html = root.children[0].innerHTML;
    assert.ok(html.includes('report.pdf'), `file must be named: ${html}`);
    assert.ok(html.includes('lab-desktop'), `destination must be named: ${html}`);
    root.children[0].querySelector('[data-act="confirm"]').click();
    assert.equal(await p, true);
    assert.equal(root.children.length, 0, 'settled dialog must leave no DOM residue');
  },

  'confirmSend decline resolves false and escapes hostile values': async () => {
    const { ui, doc } = makeUI();
    const evil = '<script>alert(1)</script>';
    const p = ui.confirmSend({ fileName: evil, fileSize: 10, peerName: evil });
    const root = doc.getElementById('transfer-confirm-root');
    const html = root.children[0].innerHTML;
    assert.ok(html.includes('&lt;script&gt;'), `hostile values must be escaped: ${html}`);
    assert.notOk(html.includes('<script'), `raw script must not appear: ${html}`);
    root.children[0].querySelector('[data-act="cancel"]').click();
    assert.equal(await p, false);
    assert.equal(root.children.length, 0);
  },

  'confirmSend cannot be satisfied by a pre-existing gesture': async () => {
    const { ui, doc } = makeUI();
    const root = doc.getElementById('transfer-confirm-root');

    const first = ui.confirmSend({ fileName: 'a.txt', fileSize: 1, peerName: 'p1' });
    const staleAccept = root.children[0].querySelector('[data-act="confirm"]');
    staleAccept.click();
    assert.equal(await first, true);

    const second = ui.confirmSend({ fileName: 'b.txt', fileSize: 2, peerName: 'p2' });
    // The gesture that settled the first dialog must not settle the second.
    staleAccept.click();
    assert.equal(await settled(second), false, 'a stale button must not resolve the new dialog');
    assert.equal(root.children.length, 1, 'the new dialog must still be open');
    root.children[0].querySelector('[data-act="confirm"]').click();
    assert.equal(await second, true);
  },

  'confirmIncoming true and false paths name sender and file': async () => {
    const { ui, doc } = makeUI();
    const root = doc.getElementById('transfer-confirm-root');

    const yes = ui.confirmIncoming({ fileName: 'photo.png', fileSize: 512, fromName: 'phone' });
    let html = root.children[0].innerHTML;
    assert.ok(html.includes('photo.png') && html.includes('phone'), `sender and file must be named: ${html}`);
    root.children[0].querySelector('[data-act="confirm"]').click();
    assert.equal(await yes, true);

    const no = ui.confirmIncoming({ fileName: 'photo.png', fileSize: 512, fromName: 'phone' });
    root.children[0].querySelector('[data-act="cancel"]').click();
    assert.equal(await no, false);
    assert.equal(root.children.length, 0);
  },

  'pairing request banner shows and clears symmetrically': () => {
    const { ui, doc } = makeUI();
    let accepted = 0;
    let declined = 0;
    const evil = '<img src=x onerror=alert(1)>';
    ui.showPairingRequest({
      requestId: 'r1', peerId: 'peer-1', info: { name: evil },
      onAccept: () => { accepted++; }, onDecline: () => { declined++; },
    });
    const host = doc.getElementById('pairing-requests');
    assert.equal(host.children.length, 1);
    const html = host.children[0].innerHTML;
    assert.ok(html.includes('&lt;img'), `peer name must be escaped: ${html}`);
    assert.notOk(html.includes('<img'), `raw tag must not appear: ${html}`);

    host.children[0].querySelector('[data-act="accept"]').click();
    assert.equal(accepted, 1);

    // Re-showing the same id replaces rather than duplicates.
    ui.showPairingRequest({
      requestId: 'r1', peerId: 'peer-1', info: { name: 'peer-1' },
      onAccept: () => { }, onDecline: () => { declined++; },
    });
    assert.equal(host.children.length, 1);
    host.children[0].querySelector('[data-act="decline"]').click();
    assert.equal(declined, 1);

    ui.clearPairingRequest('r1');
    assert.equal(host.children.length, 0, 'cleared requests must leave no DOM residue');
    assert.equal(ui._pairingRequests.size, 0);
    ui.clearPairingRequest('r1'); // clearing twice is safe
    assert.equal(host.children.length, 0);
  },

  'pairing pending shows and clears symmetrically': () => {
    const { ui, doc } = makeUI();
    ui.showPairingPending('q1', 'peer-9');
    const host = doc.getElementById('pairing-pending');
    assert.equal(host.children.length, 1);
    assert.ok(host.children[0].innerHTML.includes('peer-9'));

    ui.showPairingPending('q1', '<b>evil</b>');
    assert.equal(host.children.length, 1, 're-showing must replace, not duplicate');
    assert.ok(host.children[0].innerHTML.includes('&lt;b&gt;'));

    ui.clearPairingPending('q1');
    assert.equal(host.children.length, 0, 'cleared pending state must leave no residue');
    assert.equal(ui._pairingPending.size, 0);
  },

  'confirmation code displays four words and clears': () => {
    const { ui, doc } = makeUI();
    const words = ['river', 'canyon', 'harbor', 'meadow'];
    assert.equal(ui.showConfirmationCode(words), true);
    const overlay = doc.getElementById('confirmation-overlay');
    const box = doc.getElementById('confirmation-words');
    assert.equal(overlay.classList.contains('hidden'), false);
    for (const w of words) assert.ok(box.innerHTML.includes(w), `word ${w} must render: ${box.innerHTML}`);

    ui.clearConfirmationCode();
    assert.equal(box.innerHTML, '');
    assert.equal(overlay.classList.contains('hidden'), true);

    assert.equal(ui.showConfirmationCode(['only', 'two']), false);
    assert.equal(overlay.classList.contains('hidden'), true);
  },

  'confirmation code escapes hostile words': () => {
    const { ui, doc } = makeUI();
    assert.equal(ui.showConfirmationCode(['<script>', 'b', 'c', 'd']), true);
    const html = doc.getElementById('confirmation-words').innerHTML;
    assert.ok(html.includes('&lt;script&gt;'), `word must be escaped: ${html}`);
    assert.notOk(html.includes('<script'), `raw script must not appear: ${html}`);
  },

  'grouped text makes a single-character change visible': () => {
    const { ui, doc } = makeUI();
    enableCanvas(doc);
    ui.showPairingPanel({ raw: RAW, link: `#o=${RAW}` });
    const before = doc.getElementById('pairing-grouped').innerHTML;

    const changed = `${RAW.slice(0, 20)}${RAW[20] === 'A' ? 'B' : 'A'}${RAW.slice(21)}`;
    ui.showPairingPanel({ raw: changed, link: `#o=${changed}` });
    const after = doc.getElementById('pairing-grouped').innerHTML;
    assert.notOk(before === after, 'one changed character must change the grouped rendering');
    assert.equal(stripTags(after), changed);
  },

  'signaling banner shows, reconnect notice names the peer, clear hides': () => {
    const { ui, doc } = makeUI();
    ui.showSignalingBanner();
    const banner = doc.getElementById('signaling-banner');
    assert.equal(banner.classList.contains('hidden'), false);
    assert.ok(banner.textContent.length > 0);

    ui.showReconnectNotice('peer-7');
    assert.equal(banner.classList.contains('hidden'), false);
    assert.ok(banner.textContent.includes('peer-7'), `notice must name the peer: ${banner.textContent}`);

    ui.clearSignalingBanner();
    assert.equal(banner.classList.contains('hidden'), true);
    assert.equal(banner.textContent, '');
  },

  'copy falls back when the clipboard API is missing': async () => {
    const { ui, doc } = makeUI({ withClipboard: false });
    ui.showPairingPanel({ raw: RAW, link: `#o=${RAW}` });
    assert.equal(await ui.copyPairingCode(), true);
    assert.ok(doc.execCalls.includes('copy'), 'fallback must use execCommand');
  },
};

module.exports = { name: 'pairing-ui', tests };
