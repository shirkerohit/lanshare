const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const clientDir = path.join(rootDir, 'client');
const distDir = path.join(rootDir, 'dist');

const files = [
  'index.html',
  'styles.css',
  'identity.js',
  'webrtc.js',
  'transfer.js',
  'network.js',
  'ui.js',
  'app.js',
];

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

for (const file of files) {
  fs.copyFileSync(path.join(clientDir, file), path.join(distDir, file));
}

const indexPath = path.join(distDir, 'index.html');
const staticFlag = '  <script>window.LANSHARE_STATIC = true;</script>\n';
let html = fs.readFileSync(indexPath, 'utf8');

if (!html.includes('window.LANSHARE_STATIC')) {
  html = html.replace('  <script src="app.js"></script>', `${staticFlag}  <script src="app.js"></script>`);
}

fs.writeFileSync(indexPath, html);

console.log('\nStatic LanShare build ready');
console.log(`  Folder: ${distDir}`);
console.log(`  Open:   ${path.join(distDir, 'index.html')}`);
console.log('  Deploy: upload the dist/ folder to GitHub Pages or any static host\n');
