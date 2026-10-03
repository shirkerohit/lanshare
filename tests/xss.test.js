// tests/xss.test.js
// XSS / trust-boundary tests for client/ui.js.
//
// client/ui.js is a browser class, so — like tests/webrtc.test.js — each test
// evaluates the real source in a vm sandbox with the smallest set of fakes the
// file touches (document, window, localStorage, Identity, timers), drives the
// render paths with hostile peer-supplied values, and asserts on behaviour:
// what landed in innerHTML / textContent and whether any script node exists.
//
// Nothing here inspects the source text; every assertion is on rendered output.
// The crafted-type test doubles as the RED test for the verified pre-fix bug
// (`const typeLabel = peer.info.type || 'device'` interpolated into innerHTML
// unescaped): against the pre-fix code it fails, because the raw tag appears.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('./assert');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'client', 'ui.js'), 'utf8');

// ---------------------------------------------------------------------------
// Minimal fake DOM: stores innerHTML as a string (no parsing, no execution)
// and models textContent as inert. querySelectorAll('script') scans the stored
// HTML the way a real DOM would expose parsed <script> elements.
// ---------------------------------------------------------------------------

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

function findScripts(html) {
  const out = [];
  const re = /<script[\s>]/gi;
  let m;
  while ((m = re.exec(html))) out.push({ tag: 'script', at: m.index });
  return out;
}

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this._doc = doc || null;
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() { } };
    this.classList = new FakeClassList();
    this._html = '';
    this._text = '';
    this.id = '';
    this.className = '';
    this.value = '';
    this.placeholder = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text; }
  get firstChild() { return this.children[0] || null; }
  appendChild(child) {
    this.children.push(child);
    if (child && child.id && this._doc) this._doc._ids.set(child.id, child);
    return child;
  }
  insertBefore(child) { this.children.unshift(child); return child; }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    return child;
  }
  remove() { }
  click() { }
  select() { }
  addEventListener() { }
  setAttribute() { }
  getAttribute() { return null; }
  closest() { return null; }
  querySelector() { return new FakeElement('stub', this._doc); }
  querySelectorAll(sel) {
    if (/(^|[\s,>])script\b/i.test(String(sel))) return findScripts(this._html);
    return [];
  }
}

function createDocument() {
  const doc = {
    _ids: new Map(),
    body: new FakeElement('body'),
    documentElement: new FakeElement('html'),
    getElementById(id) {
      if (!doc._ids.has(id)) {
        const el = new FakeElement('div', doc);
        el.id = id;
        doc._ids.set(id, el);
      }
      return doc._ids.get(id);
    },
    createElement(tag) { return new FakeElement(tag, doc); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    execCommand() { },
  };
  doc.body._doc = doc;
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

function createSandbox() {
  const doc = createDocument();
  const storage = createStorage();
  const sandbox = {
    console: { log() { }, warn() { }, error() { }, debug() { } },
    document: doc,
    localStorage: storage,
    navigator: {},
    Identity: {
      getPalette() { return ['#00ffcc', '#ffffff']; },
      drawAvatar() { },
    },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: () => 0,
    setTimeout: () => 0, // never fires: notifications/cards persist for assertions
    clearTimeout: () => { },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'client/ui.js' });
  return { sandbox, UI: sandbox.UI, doc, storage };
}

function makeUI() {
  const env = createSandbox();
  const ui = new env.UI();
  ui.local = { id: 'local-peer', name: 'Local' };
  return { ui, ...env };
}

function notes(doc) {
  return doc.getElementById('notifications').children;
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const TYPE_IMG = '<img src=x onerror="alert(1)">';
const NAME_SCRIPT = "<script>alert('peer-name')</script>";
const CHAT_SCRIPT = "<script>alert('chat')</script>";
const SVG_ONLOAD = '<svg onload=alert(1)>';
const ATTR_BREAKOUT = 'x" onmouseover="alert(1)';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests = {
  // RED test for the verified bug: pre-fix ui.js interpolated
  // `${typeIcon} ${typeLabel}` with typeLabel raw. Against the pre-fix code
  // this fails (raw <img> present, no &lt;); against the fix it passes.
  'RED: crafted device type renders literally and executes nothing': () => {
    const { ui, doc } = makeUI();
    ui.addPeer('evil-peer', { name: 'Honest Name', type: TYPE_IMG });

    const card = doc.getElementById('peers-grid').children[0];
    assert.ok(card, 'peer card should be rendered');
    const html = card.innerHTML;
    assert.ok(html.includes('&lt;img'), `escaped type expected, got: ${html}`);
    assert.notOk(html.includes('<img'), `raw <img> must not appear, got: ${html}`);
    assert.notOk(/<[a-z][^>]*\bon\w+\s*=/i.test(html),
      `no live event handler on a real tag may survive, got: ${html}`);
    assert.equal(card.querySelectorAll('script').length, 0, 'no script node may exist');
  },

  // The exact pre-fix interpolation shape is unsafe, and this suite catches it.
  'RED: the pre-fix `${typeIcon} ${typeLabel}` shape is caught by this suite': () => {
    const typeIcon = '💻';
    const typeLabel = TYPE_IMG;
    const vulnerable = `${typeIcon} ${typeLabel}`; // pre-fix ui.js:410 shape
    assert.ok(vulnerable.includes('<img'), 'sanity: the old shape really is raw HTML');

    // The fixed render path must never produce that shape.
    const { ui, doc } = makeUI();
    ui.addPeer('evil-peer-2', { name: 'Honest Name', type: TYPE_IMG });
    const html = doc.getElementById('peers-grid').children[0].innerHTML;
    assert.notOk(html.includes('<img'), 'fixed output must not contain the raw tag');
    assert.ok(html.includes('&lt;img'), 'fixed output must contain the escaped tag');
  },

  'crafted peer name in the device card renders literally': () => {
    const { ui, doc } = makeUI();
    ui.addPeer('evil-peer', { name: NAME_SCRIPT, type: 'desktop' });

    const html = doc.getElementById('peers-grid').children[0].innerHTML;
    assert.ok(html.includes('&lt;script&gt;'), `escaped name expected, got: ${html}`);
    assert.notOk(html.includes('<script'), `raw <script> must not appear, got: ${html}`);
  },

  'peer id cannot break out of data-peer attributes': () => {
    const { ui, doc } = makeUI();
    ui.addPeer(ATTR_BREAKOUT, { name: 'Safe Name', type: 'desktop' });

    const html = doc.getElementById('peers-grid').children[0].innerHTML;
    assert.notOk(html.includes('onmouseover="alert'),
      `attribute breakout must be neutralised, got: ${html}`);
    assert.ok(html.includes('&quot;'), `quotes must be escaped, got: ${html}`);
  },

  'crafted name in join/leave notifications is inert text': () => {
    const { ui, doc } = makeUI();
    ui.addPeer('p1', { name: NAME_SCRIPT, type: 'desktop' });
    ui.removePeer('p1');

    const shown = notes(doc).map((n) => n.textContent);
    assert.equal(shown.length, 2);
    assert.ok(shown[0].includes(NAME_SCRIPT), `join note must carry the literal name: ${shown[0]}`);
    assert.ok(shown[1].includes(NAME_SCRIPT), `leave note must carry the literal name: ${shown[1]}`);
    // textContent path: nothing is parsed as markup.
    assert.equal(doc.getElementById('notifications').innerHTML, '');
  },

  'forgetKnownPeer notification with a hostile saved name is inert text': () => {
    const { ui, doc, storage } = makeUI();
    storage.setItem('lanshare_known_peers', JSON.stringify({
      evil: { id: 'evil', info: { name: NAME_SCRIPT }, lastConnectedAt: Date.now() },
    }));
    ui.forgetKnownPeer('evil');

    const shown = notes(doc).map((n) => n.textContent);
    assert.equal(shown.length, 1);
    assert.ok(shown[0].includes(NAME_SCRIPT), `literal name expected: ${shown[0]}`);
  },

  'saved-device list renders a hostile stored name literally': () => {
    const { ui, doc, storage } = makeUI();
    storage.setItem('lanshare_known_peers', JSON.stringify({
      evil: { id: 'evil', info: { name: NAME_SCRIPT }, lastConnectedAt: Date.now() },
    }));
    ui._renderKnownDevices();

    const html = doc.getElementById('known-devices').innerHTML;
    assert.ok(html.includes('&lt;script&gt;'), `escaped name expected, got: ${html}`);
    assert.notOk(html.includes('<script'), `raw <script> must not appear, got: ${html}`);
  },

  'chat message attribution renders a hostile sender name literally': () => {
    const { ui, doc } = makeUI();
    ui.addChatMessage({ fromPeer: 'evil', name: NAME_SCRIPT, text: 'hello', timestamp: Date.now() });

    const el = doc.getElementById('chat-feed').children[0];
    assert.ok(el.innerHTML.includes('&lt;script&gt;'), `escaped name expected: ${el.innerHTML}`);
    assert.notOk(el.innerHTML.includes('<script'), `raw <script> must not appear: ${el.innerHTML}`);
    assert.equal(el.querySelectorAll('script').length, 0, 'no script node may exist');
  },

  'chat body with script tags and event handlers executes nothing': () => {
    const { ui, doc } = makeUI();
    ui.addChatMessage({
      fromPeer: 'evil',
      name: 'Evil',
      text: `${CHAT_SCRIPT} ${SVG_ONLOAD} <div onclick="alert(1)">x</div>`,
      timestamp: Date.now(),
    });

    const el = doc.getElementById('chat-feed').children[0];
    const body = el.innerHTML;
    assert.ok(body.includes('&lt;script&gt;'), `script must be escaped: ${body}`);
    assert.ok(body.includes('&lt;svg'), `svg must be escaped: ${body}`);
    assert.notOk(body.includes('<script'), `raw <script> must not appear: ${body}`);
    assert.notOk(body.includes('<svg'), `raw <svg> must not appear: ${body}`);
    assert.equal(el.querySelectorAll('script').length, 0, 'no script node may exist');
  },

  'chat markdown still formats benign input after escaping': () => {
    const { ui, doc } = makeUI();
    ui.addChatMessage({
      fromPeer: 'local-peer',
      name: 'Me',
      text: '**bold** and *em* and `code`',
      timestamp: Date.now(),
    });

    const body = doc.getElementById('chat-feed').children[0].innerHTML;
    assert.ok(body.includes('<strong>bold</strong>'), `bold must render: ${body}`);
    assert.ok(body.includes('<em>em</em>'), `em must render: ${body}`);
    assert.ok(body.includes('<code>code</code>'), `code must render: ${body}`);
  },

  'hostile markup inside code spans and bold renders literally': () => {
    const { ui, doc } = makeUI();
    ui.addChatMessage({
      fromPeer: 'evil', name: 'Evil', timestamp: Date.now(),
      text: '`<img src=x onerror=alert(1)>` **<script>alert(1)</script>** ```<svg onload=alert(1)>```',
    });

    const body = doc.getElementById('chat-feed').children[0].innerHTML;
    assert.ok(body.includes('<code>&lt;img'), `code span must hold literal text: ${body}`);
    assert.ok(body.includes('<strong>&lt;script&gt;'), `bold must hold literal text: ${body}`);
    assert.ok(body.includes('<pre><code>&lt;svg'), `fence must hold literal text: ${body}`);
    assert.notOk(body.includes('<img'), `raw <img> must not appear: ${body}`);
    assert.notOk(body.includes('<script'), `raw <script> must not appear: ${body}`);
    assert.notOk(body.includes('<svg'), `raw <svg> must not appear: ${body}`);
  },

  'speed-test result with hostile peer name and latency renders literally': () => {
    const { ui, doc } = makeUI();
    ui.peers.set('evil', { id: 'evil', info: { name: NAME_SCRIPT }, connectedAt: Date.now() });
    ui.addSpeedTestResult('evil', { mbps: 12.5, latency: SVG_ONLOAD, duration: 1.2, bytesSent: 1024 });

    const history = doc.getElementById('speedtest-history');
    assert.equal(history.children.length, 1);
    const html = history.children[0].innerHTML;
    assert.ok(html.includes('&lt;script&gt;'), `escaped name expected: ${html}`);
    assert.ok(html.includes('&lt;svg'), `escaped latency expected: ${html}`);
    assert.notOk(html.includes('<script'), `raw <script> must not appear: ${html}`);
    assert.notOk(html.includes('<svg'), `raw <svg> must not appear: ${html}`);
  },

  'incoming-file and typing surfaces carry hostile values as inert text': () => {
    const { ui, doc } = makeUI();
    ui.peers.set('evil', { id: 'evil', info: { name: NAME_SCRIPT }, connectedAt: Date.now() });
    ui.showIncoming({ fromPeerId: 'evil', fileName: CHAT_SCRIPT });
    ui.showTyping(NAME_SCRIPT, true);

    const shown = notes(doc).map((n) => n.textContent);
    assert.equal(shown.length, 1);
    assert.ok(shown[0].includes(CHAT_SCRIPT), `file name must be literal: ${shown[0]}`);
    assert.ok(shown[0].includes(NAME_SCRIPT), `sender must be literal: ${shown[0]}`);
    assert.equal(doc.getElementById('notifications').innerHTML, '');

    const typing = doc.getElementById('typing-indicator');
    assert.equal(typing.textContent, `${NAME_SCRIPT} is typing...`);
  },
};

module.exports = { name: 'xss', tests };
