// client/network.js
// Canvas-based network topology visualization with animated packets

class NetworkVisualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.nodes = new Map(); // peerId -> node
    this.packets = [];
    this.animFrame = null;
    this.running = false;
    this.localId = null;
    this.time = 0;
  }

  start(localId, localName, localPalette) {
    this.localId = localId;
    this.running = true;
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this.addNode(localId, localName, localPalette, true);
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
  }

  _resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth || 600;
    const h = parent.clientHeight || 400;
    this.canvas.width = w;
    this.canvas.height = h;
    this._repositionNodes();
  }

  addNode(id, name, palette, isLocal = false) {
    const w = Number.isFinite(this.canvas.width) ? this.canvas.width : 600;
    const h = Number.isFinite(this.canvas.height) ? this.canvas.height : 400;
    const cx = w / 2;
    const cy = h / 2;
    const safePalette = normalizePalette(palette);
    const safeName = typeof name === 'string' ? name : String(name ?? id ?? 'peer');

    if (isLocal) {
      this.nodes.set(id, { id, name: safeName, palette: safePalette, isLocal: true, x: cx, y: cy, targetX: cx, targetY: cy, radius: 28, alpha: 1 });
      return;
    }

    // Place new node in orbit around center
    const count = this.nodes.size;
    const angle = (count / 8) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 90 + Math.random() * 60;
    let tx = cx + Math.cos(angle) * dist;
    let ty = cy + Math.sin(angle) * dist;
    if (!Number.isFinite(tx)) tx = cx;
    if (!Number.isFinite(ty)) ty = cy;

    this.nodes.set(id, {
      id, name: safeName, palette: safePalette, isLocal: false,
      x: cx, y: cy, // start at center, animate out
      targetX: tx, targetY: ty,
      radius: 20,
      alpha: 0,
      pulsePhase: Math.random() * Math.PI * 2,
    });
  }

  removeNode(id) {
    if (id == null) return;
    const node = this.nodes.get(id);
    if (!node) return;
    node.removing = true;
    setTimeout(() => this.nodes.delete(id), 800);
  }

  _repositionNodes() {
    const w = Number.isFinite(this.canvas.width) ? this.canvas.width : 600;
    const h = Number.isFinite(this.canvas.height) ? this.canvas.height : 400;
    const cx = w / 2;
    const cy = h / 2;
    let remoteCount = 0;
    for (const [, node] of this.nodes) {
      if (!node.isLocal) remoteCount++;
    }
    let i = 0;
    for (const [, node] of this.nodes) {
      if (node.isLocal) {
        node.x = cx; node.y = cy;
        node.targetX = cx; node.targetY = cy;
      } else {
        const angle = remoteCount > 0 ? (i / remoteCount) * Math.PI * 2 : 0;
        const dist = 100 + (w < 400 ? -20 : 20);
        const tx = cx + Math.cos(angle) * dist;
        const ty = cy + Math.sin(angle) * dist;
        node.targetX = Number.isFinite(tx) ? tx : cx;
        node.targetY = Number.isFinite(ty) ? ty : cy;
        if (!Number.isFinite(node.x)) node.x = cx;
        if (!Number.isFinite(node.y)) node.y = cy;
        i++;
      }
    }
  }

  spawnPacket(fromId, toId, color = '#00ffcc') {
    const from = this.nodes.get(fromId);
    const to = this.nodes.get(toId);
    if (!from || !to) return;
    if (!Number.isFinite(from.x) || !Number.isFinite(from.y)) return;
    if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) return;

    this.packets.push({
      x: from.x, y: from.y,
      tx: to.x, ty: to.y,
      fromId, toId,
      progress: 0,
      speed: 0.012 + Math.random() * 0.008,
      color,
      size: 3 + Math.random() * 2,
    });
  }

  _loop() {
    if (!this.running) return;
    this.animFrame = requestAnimationFrame(() => this._loop());
    this._draw();
    this.time++;
  }

  _draw() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Subtle grid background
    this._drawGrid();

    // Animate nodes toward targets
    for (const [, node] of this.nodes) {
      node.x += (node.targetX - node.x) * 0.06;
      node.y += (node.targetY - node.y) * 0.06;

      if (node.removing) {
        node.alpha = Math.max(0, node.alpha - 0.02);
      } else {
        node.alpha = Math.min(1, node.alpha + 0.03);
      }
    }

    // Draw connection lines
    const localNode = this.nodes.get(this.localId);
    if (localNode) {
      for (const [id, node] of this.nodes) {
        if (id === this.localId) continue;
        this._drawConnection(localNode, node);
      }
    }

    // Animate and draw packets
    this.packets = this.packets.filter(p => {
      p.progress += p.speed;

      // Update target positions
      const from = this.nodes.get(p.fromId);
      const to = this.nodes.get(p.toId);
      if (from) { p.x = from.x; }
      if (to) { p.tx = to.x; p.ty = to.y; }

      const px = lerp(p.x, p.tx, p.progress);
      const py = lerp(p.y, p.ty, p.progress);

      ctx.beginPath();
      ctx.arc(px, py, p.size, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = 1 - p.progress * 0.3;
      ctx.fill();

      // Glow
      ctx.beginPath();
      ctx.arc(px, py, p.size * 2.5, 0, Math.PI * 2);
      const glow = ctx.createRadialGradient(px, py, 0, px, py, p.size * 2.5);
      glow.addColorStop(0, withAlpha(p.color, 0.53));
      glow.addColorStop(1, 'transparent');
      ctx.fillStyle = glow;
      ctx.fill();
      ctx.globalAlpha = 1;

      return p.progress < 1;
    });

    // Draw nodes
    for (const [, node] of this.nodes) {
      this._drawNode(node);
    }
  }

  _drawGrid() {
    const { ctx, canvas } = this;
    const spacing = 40;
    ctx.strokeStyle = 'rgba(0,255,200,0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < canvas.width; x += spacing) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
    }
    for (let y = 0; y < canvas.height; y += spacing) {
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
    }
    ctx.stroke();
  }

  _drawConnection(a, b) {
    const { ctx } = this;
    const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    grad.addColorStop(0, withAlpha(normalizePalette(a.palette)[0], 0.53));
    grad.addColorStop(1, withAlpha(normalizePalette(b.palette)[0], 0.27));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = Math.min(a.alpha, b.alpha) * 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  _drawNode(node) {
    const { ctx } = this;
    // Repair any non-finite state in place so a bad value can never persist.
    const cx = Number.isFinite(this.canvas.width) ? this.canvas.width / 2 : 300;
    const cy = Number.isFinite(this.canvas.height) ? this.canvas.height / 2 : 200;
    if (!Number.isFinite(node.x)) node.x = cx;
    if (!Number.isFinite(node.y)) node.y = cy;
    if (!Number.isFinite(node.targetX)) node.targetX = cx;
    if (!Number.isFinite(node.targetY)) node.targetY = cy;
    if (!Number.isFinite(node.radius)) node.radius = node.isLocal ? 28 : 20;
    if (!Number.isFinite(node.alpha)) node.alpha = 1;
    const safePalette = normalizePalette(node.palette);
    node.palette = safePalette;
    const safeName = typeof node.name === 'string' ? node.name : String(node.name ?? node.id ?? '');
    const { x, y, radius, alpha, isLocal } = node;
    const pulsePhase = Number.isFinite(node.pulsePhase) ? node.pulsePhase : 0;

    ctx.globalAlpha = alpha;

    // Pulse ring for remote nodes
    if (!isLocal && node.pulsePhase !== undefined) {
      const pulse = Math.sin(this.time * 0.04 + pulsePhase) * 0.5 + 0.5;
      ctx.beginPath();
      ctx.arc(x, y, radius + 6 + pulse * 4, 0, Math.PI * 2);
      ctx.strokeStyle = withAlpha(safePalette[0], 0.27);
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Node circle
    const grad = ctx.createRadialGradient(x - radius * 0.3, y - radius * 0.3, 0, x, y, radius);
    grad.addColorStop(0, safePalette[0]);
    grad.addColorStop(1, safePalette[1]);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Border
    ctx.strokeStyle = safePalette[0];
    ctx.lineWidth = isLocal ? 2 : 1.5;
    ctx.stroke();

    // Name label
    ctx.fillStyle = '#ffffff';
    ctx.font = `${isLocal ? 11 : 9}px "Space Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(safeName.substr(0, 12), x, y + radius + 14);

    if (isLocal) {
      ctx.fillStyle = safePalette[0];
      ctx.font = '8px monospace';
      ctx.fillText('YOU', x, y + 3);
    }

    ctx.globalAlpha = 1;
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function isColorString(value) {
  return typeof value === 'string' && value.trim().length >= 2;
}

function normalizePalette(palette) {
  const d0 = '#00ffcc';
  const d1 = '#004466';
  if (!Array.isArray(palette)) return [d0, d1];
  return [
    isColorString(palette[0]) ? palette[0] : d0,
    isColorString(palette[1]) ? palette[1] : d1,
  ];
}

function withAlpha(color, alpha) {
  const value = String(color || '#00ffcc').trim();
  if (!value) return `rgba(0, 255, 204, ${alpha})`;

  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (hex.length === 3) {
      const full = hex.split('').map((c) => c + c).join('');
      const int = parseInt(full, 16);
      return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
    }
    if (hex.length === 6) {
      const int = parseInt(hex, 16);
      return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
    }
    return `rgba(0, 255, 204, ${alpha})`;
  }

  if (value.startsWith('hsl(')) {
    const m = value.match(/hsl\(([^,]+),\s*([^,]+),\s*([^)]+)\)/i);
    if (m) {
      return `hsla(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
    }
  }

  if (value.startsWith('hsla(')) {
    return value.replace(/hsla\(([^,]+),\s*([^,]+),\s*([^)]+),\s*[^)]+\)/i, `hsla($1, $2, $3, ${alpha})`);
  }

  if (value.startsWith('rgb(')) {
    return value.replace(/rgb\(([^,]+),\s*([^,]+),\s*([^)]+)\)/i, `rgba($1, $2, $3, ${alpha})`);
  }

  if (value.startsWith('rgba(')) {
    return value.replace(/rgba\(([^,]+),\s*([^,]+),\s*([^)]+),\s*[^)]+\)/i, `rgba($1, $2, $3, ${alpha})`);
  }

  return `rgba(0, 255, 204, ${alpha})`;
}

window.NetworkVisualizer = NetworkVisualizer;
