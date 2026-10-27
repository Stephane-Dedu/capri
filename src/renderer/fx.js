// Full-screen effects canvas: shard bursts, data streaks between warp points,
// scanline afterimages, shock rings and drifting glyphs. Idle when empty.

window.Capri = window.Capri || {};

(() => {
  const SHARD_COLORS = ['#ff2a6d', '#ff2a6d', '#3dff8f', '#a73cff', '#f4f7ff', '#00f0ff'];
  const GLYPHS = '01░▒▓<>/\\#$%&{}[]ｱｶﾌﾞﾘ';
  const rand = (a, b) => a + Math.random() * (b - a);
  const jitter = (amount) => (Math.random() * 2 - 1) * amount;
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  class FX {
    constructor(canvas) {
      this.canvas = canvas;
      this.g = canvas.getContext('2d');
      this.parts = [];
      this.dirty = false;
      this.resize();
      addEventListener('resize', () => this.resize());
    }

    resize() {
      const dpr = devicePixelRatio || 1;
      this.canvas.width = Math.round(innerWidth * dpr);
      this.canvas.height = Math.round(innerHeight * dpr);
      this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    shards(x, y, count = 14, force = 1) {
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const speed = rand(0.12, 0.6) * force;
        const size = rand(4, 13);
        this.parts.push({
          kind: 'shard', x, y, max: rand(380, 800),
          vx: Math.cos(a) * speed, vy: Math.sin(a) * speed - 0.05,
          rot: Math.random() * 6.28, spin: jitter(0.012),
          color: pick(SHARD_COLORS),
          shape: [[0, -size], [size * rand(0.3, 0.8), size * rand(0.2, 0.7)], [-size * rand(0.3, 0.8), size * rand(0, 0.6)]],
        });
      }
    }

    // A jagged line of data from one warp point to the next.
    streak(x1, y1, x2, y2) {
      const n = Math.max(4, Math.round(Math.hypot(x2 - x1, y2 - y1) / 40));
      const nx = -(y2 - y1);
      const ny = x2 - x1;
      const len = Math.hypot(nx, ny) || 1;
      const points = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const off = i === 0 || i === n ? 0 : jitter(18);
        points.push([x1 + (x2 - x1) * t + (nx / len) * off, y1 + (y2 - y1) * t + (ny / len) * off]);
      }
      this.parts.push({ kind: 'streak', points, max: 280 });
    }

    // Scanline afterimage left where Capri used to be.
    ghost(x, y, w, h) {
      const lines = Array.from({ length: 14 }, () => ({ y: rand(0, h), h: rand(1, 4), color: pick(['#ff2a6d', '#00f0ff', '#3dff8f']) }));
      this.parts.push({ kind: 'ghost', x, y, w, h, lines, max: 420 });
    }

    ring(x, y) {
      this.parts.push({ kind: 'ring', x, y, max: 340 });
    }

    glyphs(x, y, count = 6) {
      for (let i = 0; i < count; i++) {
        this.parts.push({
          kind: 'glyph', x: x + jitter(40), y: y + jitter(30), max: rand(500, 900),
          vx: jitter(0.04), vy: rand(-0.09, -0.03),
          ch: pick(GLYPHS), color: pick(SHARD_COLORS),
        });
      }
    }

    frame(dt) {
      const { g } = this;
      if (!this.parts.length) {
        if (this.dirty) {
          g.clearRect(0, 0, innerWidth, innerHeight);
          this.dirty = false;
        }
        return;
      }
      g.clearRect(0, 0, innerWidth, innerHeight);
      this.dirty = true;

      this.parts = this.parts.filter((p) => {
        p.age = (p.age || 0) + dt;
        const t = p.age / p.max;
        if (t >= 1) return false;
        g.save();
        g.globalAlpha = 1 - t;
        DRAW[p.kind](g, p, t, dt);
        g.restore();
        return true;
      });
    }
  }

  const DRAW = {
    shard(g, p, t, dt) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 0.0004 * dt;
      p.rot += p.spin * dt;
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      g.fillStyle = p.color;
      g.beginPath();
      g.moveTo(...p.shape[0]);
      g.lineTo(...p.shape[1]);
      g.lineTo(...p.shape[2]);
      g.closePath();
      g.fill();
    },

    streak(g, p) {
      if (Math.random() < 0.2) return; // flicker
      const path = () => {
        g.beginPath();
        p.points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      };
      g.lineJoin = 'miter';
      g.translate(jitter(2), jitter(2));
      g.strokeStyle = 'rgba(255, 42, 109, 0.45)';
      g.lineWidth = 7;
      path();
      g.stroke();
      g.strokeStyle = '#3dff8f';
      g.lineWidth = 1.5;
      g.translate(3, 0);
      path();
      g.stroke();
      g.strokeStyle = '#f4f7ff';
      g.lineWidth = 1.5;
      g.translate(-3, 0);
      path();
      g.stroke();
    },

    ghost(g, p) {
      for (const line of p.lines) {
        if (Math.random() < 0.3) continue;
        g.fillStyle = line.color;
        g.fillRect(p.x + jitter(14), p.y + line.y + jitter(3), p.w * (0.4 + Math.random() * 0.6), line.h);
      }
    },

    ring(g, p, t) {
      const r = 10 + t * 90;
      g.translate(p.x, p.y);
      g.rotate(Math.PI / 4);
      g.strokeStyle = '#ff2a6d';
      g.lineWidth = 2;
      g.strokeRect(-r / 2, -r / 2, r, r);
      g.strokeStyle = '#3dff8f';
      g.lineWidth = 1;
      g.strokeRect(-r / 3, -r / 3, (r * 2) / 3, (r * 2) / 3);
    },

    glyph(g, p, t, dt) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (Math.random() < 0.08) p.ch = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      g.font = '12px "Cascadia Code", Consolas, monospace';
      g.fillStyle = p.color;
      g.fillText(p.ch, p.x, p.y);
    },
  };

  window.Capri.FX = FX;
})();
