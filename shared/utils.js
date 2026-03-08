// shared/utils.js
// Utilities shared between client and server

const CHUNK_SIZE = 256 * 1024; // 256KB chunks

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

function generateDeviceName(seed) {
  const hashNum = simpleHash(seed);
  const adj = adjectives[hashNum % adjectives.length];
  const noun = nouns[Math.floor(hashNum / adjectives.length) % nouns.length];
  const suffix = (hashNum % 900 + 100).toString();
  return `${adj}${noun}`;
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSecond) {
  return formatBytes(bytesPerSecond) + '/s';
}

function formatETA(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '---';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function detectDeviceType() {
  const ua = navigator.userAgent;
  if (/tablet|ipad|playbook|silk/i.test(ua)) return 'tablet';
  if (/mobile|iphone|ipod|android|blackberry|opera|mini|windows\sce|palm|smartphone|iemobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

// Export for both Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generateDeviceName, simpleHash, formatBytes, formatSpeed, formatETA, generateId, CHUNK_SIZE };
}
