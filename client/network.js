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
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;

    if (isLocal) {
      this.nodes.set(id, { id, name, palette, isLocal: true, x: cx, y: cy, targetX: cx, targetY: cy, radius: 28, alpha: 1 });
      return;
    }

    // Place new node in orbit around center
    const count = this.nodes.size;
    const angle = (count / 8) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 90 + Math.random() * 60;
    const tx = cx + Math.cos(angle) * dist;
    const ty = cy + Math.sin(angle) * dist;

    this.nodes.set(id, {
      id, name, palette, isLocal: false,
      x: cx, y: cy, // start at center, animate out
      targetX: tx, targetY: ty,
      radius: 20,
      alpha: 0,
      pulsePhase: Math.random() * Math.PI * 2,
    });
  }

  removeNode(id) {
    const node = this.nodes.get(id);
    if (node) {
      node.removing = true;
      setTimeout(() => this.nodes.delete(id), 800);
    }
  }

  _repositionNodes() {
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    let i = 0;
    for (const [, node] of this.nodes) {
      if (node.isLocal) {
        node.x = cx; node.y = cy;
        node.targetX = cx; node.targetY = cy;
      } else {
        const angle = (i / (this.nodes.size - 1)) * Math.PI * 2;
        const dist = 100 + (this.canvas.width < 400 ? -20 : 20);
        node.targetX = cx + Math.cos(angle) * dist;
        node.targetY = cy + Math.sin(angle) * dist;
        i++;
      }
    }
  }

  spawnPacket(fromId, toId, color = '#00ffcc') {
    const from = this.nodes.get(fromId);
    const to = this.nodes.get(toId);
    if (!from || !to) return;

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
      glow.addColorStop(0, p.color + '88');
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
    grad.addColorStop(0, (a.palette?.[0] || '#00ffcc') + '88');
    grad.addColorStop(1, (b.palette?.[0] || '#00ffcc') + '44');
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
    const { x, y, radius, alpha, palette, isLocal, name, pulsePhase } = node;

    ctx.globalAlpha = alpha;

    // Pulse ring for remote nodes
    if (!isLocal && pulsePhase !== undefined) {
      const pulse = Math.sin(this.time * 0.04 + pulsePhase) * 0.5 + 0.5;
      ctx.beginPath();
      ctx.arc(x, y, radius + 6 + pulse * 4, 0, Math.PI * 2);
      ctx.strokeStyle = (palette?.[0] || '#00ffcc') + '44';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Node circle
    const grad = ctx.createRadialGradient(x - radius * 0.3, y - radius * 0.3, 0, x, y, radius);
    grad.addColorStop(0, palette?.[0] || '#00ffcc');
    grad.addColorStop(1, palette?.[1] || '#004466');
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // Border
    ctx.strokeStyle = palette?.[0] || '#00ffcc';
    ctx.lineWidth = isLocal ? 2 : 1.5;
    ctx.stroke();

    // Name label
    ctx.fillStyle = '#ffffff';
    ctx.font = `${isLocal ? 11 : 9}px "Space Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(name.substr(0, 12), x, y + radius + 14);

    if (isLocal) {
      ctx.fillStyle = palette?.[0] || '#00ffcc';
      ctx.font = '8px monospace';
      ctx.fillText('YOU', x, y + 3);
    }

    ctx.globalAlpha = 1;
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

window.NetworkVisualizer = NetworkVisualizer;
