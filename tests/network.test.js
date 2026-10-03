// tests/network.test.js
// Tests for client/network.js (tasks 7.3 / 7.4: topology renders with only
// the local device, and stays valid for every node count).
//
// client/network.js is a browser class (window/document/canvas), so like
// tests/webrtc.test.js we evaluate the real source inside a `vm` sandbox with
// the smallest set of fakes it touches and assert on observable behaviour:
// node coordinates, never NaN/undefined, distinct targets, safe removals.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('./assert');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'client', 'network.js'), 'utf8');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeCtx() {
  const gradient = { addColorStop() {} };
  const base = {
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    measureText: () => ({ width: 0 }),
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      // Any other 2d-context method is a no-op.
      return () => {};
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

function makeCanvas(width = 600, height = 400) {
  const ctx = makeCtx();
  return {
    width,
    height,
    parentElement: { clientWidth: width, clientHeight: height },
    getContext: () => ctx,
    __ctx: ctx,
  };
}

/**
 * Evaluate client/network.js in a controlled scope and return a factory for
 * fresh NetworkVisualizer instances plus controllable timers.
 */
function createSandbox(width = 600, height = 400) {
  let nextTimerId = 1;
  const timeouts = new Map();

  const sandbox = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    setTimeout(fn, delay) {
      const id = nextTimerId++;
      timeouts.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) { timeouts.delete(id); },
    requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {},
    addEventListener() {},
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'client/network.js' });

  return {
    context: sandbox,
    NetworkVisualizer: sandbox.NetworkVisualizer,
    timeouts,
    runTimeouts() {
      const pending = Array.from(timeouts.values());
      timeouts.clear();
      for (const entry of pending) entry.fn();
      return pending.length;
    },
    createViz(w = width, h = height) {
      const canvas = makeCanvas(w, h);
      const viz = new sandbox.NetworkVisualizer(canvas);
      // Don't run the rAF loop in tests; drive _draw/_reposition manually.
      viz.running = false;
      return viz;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertFiniteNumber(value, label) {
  assert.ok(Number.isFinite(value), `${label} must be finite, got ${String(value)}`);
}

function assertValidNode(node, label) {
  assert.ok(node, `${label} should exist`);
  assertFiniteNumber(node.x, `${label}.x`);
  assertFiniteNumber(node.y, `${label}.y`);
  assertFiniteNumber(node.targetX, `${label}.targetX`);
  assertFiniteNumber(node.targetY, `${label}.targetY`);
  assert.ok(node.alpha !== undefined && node.alpha !== null, `${label}.alpha must be set`);
  assertFiniteNumber(node.alpha, `${label}.alpha`);
}

function assertAllNodesValid(viz) {
  for (const [, node] of viz.nodes) assertValidNode(node, `node ${node.id}`);
}

function targetDistance(a, b) {
  const dx = a.targetX - b.targetX;
  const dy = a.targetY - b.targetY;
  return Math.sqrt(dx * dx + dy * dy);
}

function assertTargetsDistinct(nodes, minDist = 1) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = targetDistance(nodes[i], nodes[j]);
      assert.ok(
        d >= minDist,
        `nodes ${nodes[i].id} and ${nodes[j].id} must be distinct (dist ${d})`
      );
    }
  }
}

const GOOD_PALETTE = ['hsl(170, 90%, 65%)', 'hsl(310, 80%, 55%)'];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests = {
  'local-only topology renders at centre with valid coordinates': () => {
    const env = createSandbox();
    const viz = env.createViz();
    viz.addNode('local', 'Local', GOOD_PALETTE, true);
    viz._repositionNodes();

    assert.equal(viz.nodes.size, 1);
    const local = viz.nodes.get('local');
    assertValidNode(local, 'local');
    assert.equal(local.targetX, 300);
    assert.equal(local.targetY, 200);
    assert.equal(local.x, 300);
    assert.equal(local.y, 200);

    // A full draw frame must not throw and must not corrupt the node.
    viz._draw();
    assertValidNode(viz.nodes.get('local'), 'local after draw');
  },

  'first remote node joins: both nodes valid and distinct': () => {
    const env = createSandbox();
    const viz = env.createViz();
    viz.addNode('local', 'Local', GOOD_PALETTE, true);
    viz.addNode('peer-1', 'Peer 1', GOOD_PALETTE);
    viz._repositionNodes();

    assert.equal(viz.nodes.size, 2);
    assertAllNodesValid(viz);
    const nodes = Array.from(viz.nodes.values());
    assertTargetsDistinct(nodes);
    viz._draw();
    assertAllNodesValid(viz);
  },

  'second and third remotes: all nodes valid and pairwise distinct': () => {
    const env = createSandbox();
    const viz = env.createViz();
    viz.addNode('local', 'Local', GOOD_PALETTE, true);
    viz.addNode('peer-1', 'Peer 1', GOOD_PALETTE);
    viz._repositionNodes();
    assertTargetsDistinct(Array.from(viz.nodes.values()));

    viz.addNode('peer-2', 'Peer 2', GOOD_PALETTE);
    viz._repositionNodes();
    assert.equal(viz.nodes.size, 3);
    assertAllNodesValid(viz);
    assertTargetsDistinct(Array.from(viz.nodes.values()));

    viz.addNode('peer-3', 'Peer 3', GOOD_PALETTE);
    viz._repositionNodes();
    assert.equal(viz.nodes.size, 4);
    assertAllNodesValid(viz);
    assertTargetsDistinct(Array.from(viz.nodes.values()));

    viz._draw();
    assertAllNodesValid(viz);
  },

  'removeNode is a safe no-op for unknown ids and double removal': () => {
    const env = createSandbox();
    const viz = env.createViz();
    viz.addNode('local', 'Local', GOOD_PALETTE, true);
    viz.addNode('peer-1', 'Peer 1', GOOD_PALETTE);
    viz.addNode('peer-2', 'Peer 2', GOOD_PALETTE);
    viz._repositionNodes();

    // Removing an id that was never added must not throw and must not change size.
    viz.removeNode('no-such-peer');
    viz.removeNode(undefined);
    viz.removeNode(null);
    assert.equal(viz.nodes.size, 3);
    env.runTimeouts();
    assert.equal(viz.nodes.size, 3);

    // Double removal of the same id must not throw.
    viz.removeNode('peer-1');
    viz.removeNode('peer-1');
    env.runTimeouts();
    assert.equal(viz.nodes.has('peer-1'), false);
    assert.equal(viz.nodes.size, 2);

    // Removing again after the node is gone stays a no-op.
    viz.removeNode('peer-1');
    env.runTimeouts();
    assert.equal(viz.nodes.size, 2);

    // Survivors stay valid and reposition cleanly.
    viz._repositionNodes();
    assertAllNodesValid(viz);
    viz._draw();
    assertAllNodesValid(viz);

    // Remove every remote; the lone local node must remain valid.
    viz.removeNode('peer-2');
    env.runTimeouts();
    viz._repositionNodes();
    assert.equal(viz.nodes.size, 1);
    assertValidNode(viz.nodes.get('local'), 'local');
  },

  'reposition with 0, 1, 2 and 5 remotes never produces NaN': () => {
    for (const remoteCount of [0, 1, 2, 5]) {
      const env = createSandbox();
      const viz = env.createViz();
      viz.addNode('local', 'Local', GOOD_PALETTE, true);
      for (let i = 0; i < remoteCount; i++) {
        viz.addNode(`peer-${i}`, `Peer ${i}`, GOOD_PALETTE);
      }
      viz._repositionNodes();
      assert.equal(viz.nodes.size, remoteCount + 1);
      assertAllNodesValid(viz);
      viz._draw();
      assertAllNodesValid(viz);
    }

    // Empty visualizer (no nodes at all) must also reposition without throwing.
    const env = createSandbox();
    const viz = env.createViz();
    viz._repositionNodes();
    assert.equal(viz.nodes.size, 0);
  },

  'missing and malformed palettes fall back to defaults': () => {
    const badPalettes = [
      undefined,
      null,
      'red',
      123,
      [],
      [null, undefined],
      ['', ''],
      ['r', 'x'],
      [{}, []],
    ];
    for (let i = 0; i < badPalettes.length; i++) {
      const env = createSandbox();
      const viz = env.createViz();
      viz.addNode('local', 'Local', GOOD_PALETTE, true);
      viz.addNode(`peer-${i}`, `Peer ${i}`, badPalettes[i]);
      const node = viz.nodes.get(`peer-${i}`);
      assert.ok(node, `node with palette case ${i} should be created`);
      assertValidNode(node, `palette case ${i}`);
      assert.ok(
        Array.isArray(node.palette) && node.palette.length >= 2,
        `palette case ${i} should be normalized to an array`
      );
      viz._repositionNodes();
      assertValidNode(viz.nodes.get(`peer-${i}`), `palette case ${i} after reposition`);
      // Drawing with the bad palette must not throw nor corrupt coordinates.
      viz._draw();
      assertValidNode(viz.nodes.get(`peer-${i}`), `palette case ${i} after draw`);
    }
  },

  'spawnPacket works between valid nodes and ignores removed nodes': () => {
    const env = createSandbox();
    const viz = env.createViz();
    viz.addNode('local', 'Local', GOOD_PALETTE, true);
    viz.addNode('peer-1', 'Peer 1', GOOD_PALETTE);
    viz._repositionNodes();

    viz.spawnPacket('local', 'peer-1');
    assert.equal(viz.packets.length, 1);
    assertFiniteNumber(viz.packets[0].x, 'packet.x');
    assertFiniteNumber(viz.packets[0].y, 'packet.y');

    // Unknown endpoints are safe no-ops.
    viz.spawnPacket('local', 'ghost');
    viz.spawnPacket('ghost', 'local');
    assert.equal(viz.packets.length, 1);

    // After the peer is removed, spawning to it is a safe no-op.
    viz.removeNode('peer-1');
    env.runTimeouts();
    assert.equal(viz.nodes.has('peer-1'), false);
    const before = viz.packets.length;
    viz.spawnPacket('local', 'peer-1');
    viz.spawnPacket('peer-1', 'local');
    assert.equal(viz.packets.length, before);
    viz._draw();
    assertValidNode(viz.nodes.get('local'), 'local after packet draw');
  },
};

module.exports = { name: 'network', tests };
