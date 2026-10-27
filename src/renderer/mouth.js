// Capri's mouth. She has no lips: her lower face is black and the mouth is
// white teeth cut into it, in four shapes from the anime. Closed, a thin
// zigzag like a lightning bolt. A grin, a band that starts as a thin line and
// swells into a row of teeth. Open, a big wedge hanging under a sawtooth edge.
// And a small wedge for "o". Shared by the rig and the close-up portrait.

window.Capri = window.Capri || {};

(() => {
  const WHITE = '#f6f6f9';
  const f1 = (n) => n.toFixed(1);

  // Each shape in the mouth's own frame: u runs 0..1 from corner a to corner
  // b, v is down from the baseline, both in mouth widths. s scales how far it
  // bulges, o (0..1) how far the jaw drops.
  const SHAPES = {
    zig: (s) => ({
      line: [[0, 0.02], [0.36, -0.07 * s], [0.43, 0.05 * s], [0.68, -0.05 * s], [0.74, 0.04 * s], [1, -0.03]],
    }),
    grin: (s) => ({
      fill: [
        [0, 0], [0.3, -0.01], [0.42, -0.04 * s], [0.5, 0.01], [0.58, -0.06 * s], [0.66, 0], [0.75, -0.07 * s],
        [0.83, -0.01], [0.92, -0.07 * s], [1, -0.12 * s], [0.98, 0.03 * s], [0.86, 0.13 * s], [0.66, 0.16 * s],
        [0.48, 0.1 * s], [0.28, 0.035 * s], [0.08, 0.008],
      ],
    }),
    open: (s, o) => ({
      fill: [
        [0, 0], [0.1, 0.09 * s], [0.2, -0.01], [0.32, 0.12 * s], [0.44, 0], [0.56, 0.12 * s], [0.68, -0.01],
        [0.8, 0.1 * s], [0.9, -0.02], [1, -0.04], [0.92, 0.1 + 0.2 * o * s], [0.64, 0.2 + 0.36 * o * s],
        [0.42, 0.24 + 0.46 * o * s], [0.22, 0.16 + 0.24 * o * s],
      ],
    }),
    o: (s) => ({
      fill: [[0.3, 0], [0.45, 0.03], [0.51, -0.03], [0.68, -0.02], [0.5, 0.48 * s]],
    }),
  };

  class Mouth {
    static markup(id, width) {
      return `<polyline id="${id}line" fill="none" stroke="${WHITE}" stroke-width="${width}" stroke-linejoin="miter" stroke-miterlimit="6"/>
        <path id="${id}fill" fill="${WHITE}"/>`;
    }

    // a, b: the mouth's corners, left and right as she faces you. depth
    // flattens the shapes where there's little room under the mask.
    constructor(svg, id, a, b, { depth = 1 } = {}) {
      this.line = svg.querySelector(`#${id}line`);
      this.fill = svg.querySelector(`#${id}fill`);
      this.a = a;
      this.b = b;
      this.depth = depth;
      this.jaw = 0;
    }

    // Where (u, v) in the mouth's frame lands in the picture.
    at([u, v]) {
      const down = v * this.depth;
      const [ax, ay] = this.a;
      const dx = this.b[0] - ax;
      const dy = this.b[1] - ay;
      return [ax + dx * u - dy * down, ay + dy * u + dx * down];
    }

    draw(kind, size = 1, open = 1) {
      const { line, fill } = SHAPES[kind](size, open);
      this.line.setAttribute('points', line ? line.map((p) => this.at(p).map(f1).join(',')).join(' ') : '');
      this.fill.setAttribute('d', fill ? `M${fill.map((p) => this.at(p).map(f1).join(',')).join('L')}Z` : '');
    }

    // One step (12 fps) for a mood: talking flaps the jaw, thinking twitches
    // the closed zigzag.
    pose(m, { talking, thinking }) {
      const size = Math.max(0.5, Math.min(1.5, m.zig));
      if (talking) {
        // Mostly open, at a new depth each step, shut now and then.
        this.jaw = this.jaw && Math.random() < 0.3 ? 0 : [0.15, 0.45, 0.8, 1][Math.floor(Math.random() * 4)];
        if (this.jaw) this.draw('open', 1, this.jaw);
        else this.draw(m.mouth === 'grin' ? 'grin' : 'zig', size);
      } else if (thinking) {
        this.draw('zig', 0.4 + Math.random() * 0.9);
      } else {
        this.draw(m.mouth, size, m.mouth === 'open' ? 1 : 0);
      }
    }
  }

  window.Capri.Mouth = Mouth;
})();
