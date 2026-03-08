// client/identity.js
// Device identity management and canvas avatar generation

const adjectives = [
  'Quantum', 'Turbo', 'Pixel', 'Nano', 'Vector', 'Lambda', 'Hyper', 'Alpha',
  'Sigma', 'Delta', 'Cyber', 'Nexus', 'Ultra', 'Mega', 'Giga', 'Tera',
  'Polar', 'Solar', 'Lunar', 'Astro', 'Sonic', 'Atomic', 'Cosmic', 'Fusion',
  'Neon', 'Laser', 'Photon', 'Proton', 'Neutron', 'Binary', 'Cipher', 'Flux',
  'Nova', 'Pulsar', 'Quasar', 'Radix', 'Vortex', 'Zenith', 'Apex', 'Helix'
];

const nouns = [
  'Node', 'Kernel', 'Raptor', 'Packet', 'Signal', 'Fox', 'Hawk', 'Wolf',
  'Storm', 'Blade', 'Core', 'Drift', 'Echo', 'Forge', 'Grid', 'Hub',
  'Ion', 'Jade', 'Link', 'Mesh', 'Net', 'Orb', 'Port', 'Pulse',
  'Relay', 'Sync', 'Thread', 'Unit', 'Volt', 'Wave', 'Byte', 'Cache',
  'Drive', 'Edge', 'Frame', 'Gate', 'Host', 'Index', 'Jump', 'Key'
];

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return Math.abs(h);
}

function generateDeviceName(seed) {
  const h = simpleHash(seed);
  const adj = adjectives[h % adjectives.length];
  const noun = nouns[Math.floor(h / adjectives.length) % nouns.length];
  return `${adj}${noun}`;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function detectDeviceType() {
  const ua = navigator.userAgent;
  if (/tablet|ipad|playbook|silk/i.test(ua)) return 'tablet';
  if (/mobile|iphone|ipod|android|blackberry|mini|smartphone|iemobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

// Generate a deterministic color palette from an id
function getPalette(id) {
  const h = simpleHash(id);
  const hue = h % 360;
  const hue2 = (hue + 140) % 360;
  const hue3 = (hue + 220) % 360;
  return [
    `hsl(${hue}, 90%, 65%)`,
    `hsl(${hue2}, 80%, 55%)`,
    `hsl(${hue3}, 70%, 50%)`,
  ];
}

// Draw a unique geometric avatar to a canvas element
function drawAvatar(canvas, id, size = 64) {
  const ctx = canvas.getContext('2d');
  canvas.width = size;
  canvas.height = size;

  const h = simpleHash(id);
  const palette = getPalette(id);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2;

  // Background circle
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  const bg = ctx.createRadialGradient(cx * 0.8, cy * 0.8, 0, cx, cy, r);
  bg.addColorStop(0, `hsla(${h % 360}, 30%, 18%, 1)`);
  bg.addColorStop(1, `hsla(${(h + 60) % 360}, 20%, 8%, 1)`);
  ctx.fillStyle = bg;
  ctx.fill();

  const shapeType = h % 5;
  const segments = 3 + (h % 5);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((h % 360) * Math.PI / 180);

  if (shapeType === 0) {
    // Star polygon
    drawStar(ctx, 0, 0, r * 0.55, r * 0.28, segments, palette[0]);
  } else if (shapeType === 1) {
    // Concentric rings
    for (let i = 3; i >= 1; i--) {
      drawRing(ctx, 0, 0, r * 0.18 * i, r * 0.08, palette[i - 1]);
    }
  } else if (shapeType === 2) {
    // Triangle grid
    drawTriGrid(ctx, 0, 0, r * 0.6, segments, palette);
  } else if (shapeType === 3) {
    // Hexagonal pattern
    drawHex(ctx, 0, 0, r * 0.52, palette[0], palette[1]);
  } else {
    // Diamond cluster
    drawDiamonds(ctx, 0, 0, r * 0.5, segments, palette);
  }

  ctx.restore();

  // Outer glow ring
  ctx.beginPath();
  ctx.arc(cx, cy, r - 1.5, 0, Math.PI * 2);
  ctx.strokeStyle = palette[0];
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.4;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawStar(ctx, x, y, outerR, innerR, points, color) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const angle = (i * Math.PI) / points - Math.PI / 2;
    const radius = i % 2 === 0 ? outerR : innerR;
    const px = x + Math.cos(angle) * radius;
    const py = y + Math.sin(angle) * radius;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawRing(ctx, x, y, r, width, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function drawTriGrid(ctx, x, y, r, n, palette) {
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    const nx = x + Math.cos(angle) * r * 0.5;
    const ny = y + Math.sin(angle) * r * 0.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(nx + Math.cos(angle + Math.PI / 2) * r * 0.35, ny + Math.sin(angle + Math.PI / 2) * r * 0.35);
    ctx.lineTo(nx + Math.cos(angle - Math.PI / 2) * r * 0.35, ny + Math.sin(angle - Math.PI / 2) * r * 0.35);
    ctx.closePath();
    ctx.fillStyle = palette[i % palette.length];
    ctx.globalAlpha = 0.7 + (i % 3) * 0.1;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawHex(ctx, x, y, r, fill, stroke) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3 - Math.PI / 6;
    const px = x + Math.cos(angle) * r;
    const py = y + Math.sin(angle) * r;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Inner hexagon
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3 - Math.PI / 6;
    const px = x + Math.cos(angle) * r * 0.45;
    const py = y + Math.sin(angle) * r * 0.45;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = stroke;
  ctx.fill();
}

function drawDiamonds(ctx, x, y, r, n, palette) {
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    const dx = x + Math.cos(angle) * r * 0.4;
    const dy = y + Math.sin(angle) * r * 0.4;
    const dr = r * 0.25;
    ctx.save();
    ctx.translate(dx, dy);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, -dr);
    ctx.lineTo(dr * 0.6, 0);
    ctx.lineTo(0, dr);
    ctx.lineTo(-dr * 0.6, 0);
    ctx.closePath();
    ctx.fillStyle = palette[i % palette.length];
    ctx.fill();
    ctx.restore();
  }
}

// Get or create persistent device identity
function getOrCreateIdentity() {
  let id = localStorage.getItem('lanshare_peer_id');
  let name = localStorage.getItem('lanshare_peer_name');

  if (!id) {
    id = generateId();
    localStorage.setItem('lanshare_peer_id', id);
  }

  if (!name) {
    name = generateDeviceName(id);
    localStorage.setItem('lanshare_peer_name', name);
  }

  const type = detectDeviceType();
  const palette = getPalette(id);

  return { id, name, type, palette, connectedAt: Date.now() };
}

window.Identity = {
  getOrCreateIdentity,
  drawAvatar,
  getPalette,
  simpleHash,
  detectDeviceType,
};
