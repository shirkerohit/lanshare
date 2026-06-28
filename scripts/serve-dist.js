const fs = require('fs');
const http = require('http');
const path = require('path');
const { networkInterfaces } = require('os');

const rootDir = path.join(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const port = Number(process.env.PORT || 3000);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error('dist/index.html was not found. Run `npm run build` first.');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const requestedPath = path
    .normalize(decodeURIComponent(pathname))
    .replace(/^[/\\]+/, '')
    .replace(/^(\.\.[/\\])+/, '');
  const filePath = path.resolve(distDir, requestedPath);

  if (!filePath.startsWith(path.resolve(distDir) + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(port, '0.0.0.0', () => {
  const localIp = getLocalIp();
  console.log('\nStatic LanShare preview running');
  console.log(`  Local:   http://localhost:${port}`);
  if (localIp) console.log(`  Network: http://${localIp}:${port}`);
  console.log('  Mode:    static manual pairing\n');
});

function getLocalIp() {
  const interfaces = networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }

  return null;
}
