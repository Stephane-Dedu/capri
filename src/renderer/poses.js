// Capri's arms and legs, and the poses they make. The body above the hips is
// traced from the anime, but the limbs are drawn, so they can take any pose:
// each is a chain of tapered, jagged segments in her style (black glass with
// a violet rim, green panels or glittering pink) bending at its joints, with
// a pointed foot or a claw hand at the end.
//
// Angles are degrees in the torso's frame (0 = right, 90 = down). The first
// angle of a limb is absolute; the rest bend relative to the segment before.

window.Capri = window.Capri || {};

(() => {
  const C = window.Capri.ART.colors;
  const RIM = [3, 1]; // the violet edge sits down and to the right, as in the trace
  const RAD = Math.PI / 180;
  const f1 = (n) => n.toFixed(1);
  const f2 = (n) => n.toFixed(2);

  // Roots in art units (where the traced shoulders and hips are). 'A' is the
  // limb on the left of the picture. segs: [length, width at root, width at end].
  const LIMBS = {
    legA: { root: [287, 452], segs: [[100, 26, 15], [110, 15, 6]], end: 'foot', look: 'green' },
    legB: { root: [313, 455], segs: [[100, 26, 15], [110, 15, 6]], end: 'foot', look: 'pink' },
    armA: { root: [273, 341], segs: [[66, 11, 8], [62, 8, 5]], end: 'hand', look: 'ink' },
    armB: { root: [325, 344], segs: [[66, 11, 8], [62, 8, 5]], end: 'hand', look: 'pink' },
  };
  const ORDER = ['armA', 'armB', 'legA', 'legB'];

  // Each pose: angles per limb, torso lean, head tilt, a body offset, which
  // limbs come in front of the torso, and fidgets: [limb, joint, amplitude,
  // frequency (Hz), phase] wobbling on top.
  const POSES = {
    // The reference frame: perched on something, one leg out, one down.
    perch: {
      legA: [176, 4, 16], legB: [6, 110, 22], armA: [100, -10, 40], armB: [80, 10, -40],
      fidget: [['legB', 1, 5, 0.5, 0], ['legB', 2, 12, 0.9, 1], ['legA', 0, 2, 0.4, 2]],
    },
    // Sitting on air, legs crossed: the under leg hangs straight, the top one
    // rests on its knee with the foot bobbing out front. Hands on the knee.
    crossed: {
      legA: [14, 76, 6], legB: [4, 52, -20], armA: [52, -40, 10], armB: [66, -30, 6],
      torso: 3,
      fidget: [['legB', 2, 16, 1.3, 0], ['legB', 1, 4, 0.65, 1]],
    },
    // Lying back in the air, hands behind her head, legs crossed out.
    chill: {
      legA: [38, 8, 14], legB: [26, 26, -12], armA: [-134, 141, 25], armB: [-46, -141, -25],
      torso: -34, head: -6, lift: [10, 18],
      fidget: [['legB', 2, 18, 0.9, 0], ['legB', 1, 5, 0.45, 1]],
    },
    // Hovering: legs dangling and kicking one after the other.
    float: {
      legA: [104, 26, 24], legB: [78, 36, 18], armA: [116, 16, 18], armB: [64, -16, -18],
      fidget: [['legA', 1, 12, 0.8, 0], ['legB', 1, 12, 0.8, Math.PI], ['armA', 1, 6, 0.5, 0], ['armB', 1, 6, 0.5, 2]],
    },
    // Coiled to pounce, claws out (the crouching frame).
    crouch: {
      legA: [196, -108, 64], legB: [-16, 110, -64], armA: [168, -26, -24], armB: [12, 26, 24],
      torso: 5, lift: [0, 28],
      fidget: [['armA', 2, 10, 2.2, 0], ['armB', 2, 10, 2.2, 1]],
    },
    // Arms flung up, legs kicking: a task got done.
    victory: {
      legA: [112, 44, 24], legB: [66, 22, 10], armA: [-120, -16, -12], armB: [-60, 16, 12],
      head: -4, lift: [0, -10],
      fidget: [['armA', 0, 8, 2.4, 0], ['armB', 0, 8, 2.4, Math.PI], ['legA', 1, 16, 2, 0], ['legB', 1, 16, 2, 2]],
    },
    // One arm out at something (set by pointAt), the other on her hip.
    point: {
      legA: [100, 20, 22], legB: [76, 30, 16], armA: [104, -118, 0], armB: [0, 0, 0],
      fidget: [['legA', 1, 8, 0.8, 0], ['legB', 1, 8, 0.8, 2]],
    },
    // Curled up asleep, hugging her knees.
    sleep: {
      legA: [-76, 166, 20], legB: [-102, -166, -20], armA: [62, -96, 10], armB: [116, 96, -10],
      torso: 10, head: 14, lift: [0, 34], front: ['legA', 'legB', 'armA', 'armB'],
      fidget: [],
    },
    // Claw at her chin, legs loosely crossed: waiting on a thought.
    think: {
      legA: [100, 6, 20], legB: [76, 34, -10], armA: [104, -6, 20], armB: [122, -204, 6],
      head: 8, front: ['armB'],
      fidget: [['armB', 2, 10, 1.6, 0], ['legB', 2, 12, 0.7, 1]],
    },
    // On her belly in mid-air, propped on her elbows, feet kicking behind her.
    lounge: {
      legA: [100, -100, -6], legB: [84, -88, 4], armA: [-150, 150, 0], armB: [-128, 140, 0],
      torso: -72, head: 52, lift: [16, 70], front: ['armA', 'armB'],
      fidget: [['legA', 1, 22, 0.8, 0], ['legB', 1, 22, 0.8, Math.PI], ['legA', 2, 10, 0.8, 1]],
    },
    // Sitting with one knee pulled up and an arm around it.
    hug: {
      legA: [170, 8, 6], legB: [-58, 146, 20], armA: [136, -24, 10], armB: [80, -80, 30],
      torso: 6, head: -5, lift: [0, 22], front: ['legB', 'armB'],
      fidget: [['legA', 2, 10, 0.9, 0], ['armB', 2, 6, 0.5, 1]],
    },
    // Floating cross-legged, hands out front, typing into the air: Claude
    // Code is working.
    hack: {
      legA: [24, 136, 26], legB: [156, -136, -26], armA: [72, -84, -16], armB: [108, 84, 16],
      front: ['armA', 'armB'],
      fidget: [['armA', 2, 14, 5.5, 0], ['armB', 2, 14, 6.2, 1], ['armA', 1, 4, 3, 2], ['armB', 1, 4, 2.6, 0]],
    },
  };

  // A small seeded random, so every launch draws the same limbs.
  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const d = (points) => `M${points.map((p) => p.map(f1).join(',')).join('L')}Z`;

  // A tapered segment along +x from its joint, with jagged sides and a
  // little spike off the far joint, like the anime's knees and elbows.
  function segmentOutline(L, w0, w1, rand) {
    const top = [];
    const bottom = [];
    const n = 4;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const w = (w0 + (w1 - w0) * t) / 2;
      const j = i > 0 && i < n ? 1 + (rand() - 0.5) * 0.4 : 1;
      top.push([t * L, -w * j]);
      bottom.push([t * L + (rand() - 0.5) * 3, w * (i > 0 && i < n ? 1 + (rand() - 0.5) * 0.4 : 1)]);
    }
    const spike = [L * 0.86, -(w1 / 2) - w1 * 0.9];
    return [[-w0 * 0.3, 0], ...top.slice(0, 4), spike, top[4], [L + w1 * 0.45, 0], ...bottom.reverse()];
  }

  // Panels painted on a segment, by the limb's look.
  function panels(look, i, L, w0, w1) {
    const w = (t) => (w0 + (w1 - w0) * t) / 2;
    if (look === 'green' && i === 0) {
      return [['green', [[L * 0.42, -w(0.42) + 1.5], [L * 0.8, -w(0.8) + 1.5], [L * 0.74, w(0.74) * 0.35], [L * 0.38, w(0.38) * 0.45]]]];
    }
    if (look === 'green') return [['green', [[L * 0.55, -w(0.55) + 1], [L * 0.72, -w(0.72) + 1], [L * 0.66, w(0.66) * 0.2]]]];
    if (look === 'pink') {
      // Two glittering slabs with a black zigzag between them.
      const a = [[L * 0.06, -w(0.06) + 2], [L * 0.46, -w(0.46) + 1.5], [L * 0.38, 0], [L * 0.5, w(0.5) - 1.5], [L * 0.08, w(0.08) - 2]];
      const b = [[L * 0.56, -w(0.56) + 1.5], [L * 0.94, -w(0.94) + 1], [L * 0.94, w(0.94) - 1], [L * 0.62, w(0.62) - 1.5], [L * 0.52, 0]];
      return [['pink', a], ['pink', b]];
    }
    return [];
  }

  function footOutline() {
    return [[-4, -5], [9, -4.5], [36, -0.5], [37, 0.8], [10, 3.5], [2, 5], [-6, 9], [-3, 4]];
  }

  // Long thin claws fanned out from a narrow palm.
  function handShapes() {
    const shapes = [[[-2, -4], [8, -5.5], [12, 0], [8, 5.5], [-2, 4]]];
    const fingers = [[-34, 25], [-11, 29], [11, 28], [33, 23], [-74, 15]];
    for (const [deg, len] of fingers) {
      const a = deg * RAD;
      const bx = 8 + Math.cos(a) * 3;
      const by = Math.sin(a) * 4;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      shapes.push([
        [bx - uy * 1.7, by + ux * 1.7],
        [bx + ux * len * 0.55 - uy * 1.2, by + uy * len * 0.55 + ux * 1.2],
        [bx + ux * len, by + uy * len],
        [bx + ux * len * 0.55 + uy * 1.1, by + uy * len * 0.55 - ux * 1.1],
        [bx + uy * 1.7, by - ux * 1.7],
      ]);
    }
    return shapes;
  }

  function limbMarkup(name, limb, seed) {
    const rand = seeded(seed);
    let inner = '';
    // Build from the end of the chain inward, nesting each piece in its parent.
    const end = limb.end === 'foot' ? [footOutline()] : handShapes();
    const endD = end.map(d).join('');
    inner = `<g id="${name}-end"><path class="rim" fill="${C.purple}" d="${endD}"/><path fill="${C.ink}" d="${endD}"/></g>`;
    for (let i = limb.segs.length - 1; i >= 0; i--) {
      const [L, w0, w1] = limb.segs[i];
      const outline = d(segmentOutline(L, w0, w1, rand));
      const paint = panels(limb.look, i, L, w0, w1)
        .map(([color, poly]) => {
          const fill = `<path fill="${C[color]}" d="${d(poly)}"/>`;
          return color === 'pink' ? `${fill}<path fill="url(#limbGlitter)" d="${d(poly)}"/>` : fill;
        })
        .join('');
      inner = `<g id="${name}-${i}">
        <path class="rim" fill="${C.purple}" d="${outline}"/>
        <circle r="${f1(w0 / 2)}" fill="${C.ink}"/>
        <path fill="${C.ink}" d="${outline}"/>
        ${paint}
        ${inner}
      </g>`;
    }
    return `<g class="limb" data-limb="${name}">${inner}</g>`;
  }

  const wrap = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;

  class Limbs {
    // Markup for the <defs> pattern and for the two layers the rig puts
    // behind and in front of the torso.
    static markup() {
      return {
        defs: `<pattern id="limbGlitter" patternUnits="userSpaceOnUse" width="${window.Capri.ART.width}" height="${window.Capri.ART.height}" patternTransform="translate(-170 -150)">
          <image href="${window.Capri.ART.glitter}" width="${window.Capri.ART.width}" height="${window.Capri.ART.height}"/>
        </pattern>`,
        back: ORDER.map((name, i) => limbMarkup(name, LIMBS[name], 11 + i * 7)).join(''),
      };
    }

    constructor(svg) {
      this.back = svg.querySelector('#limbsBack');
      this.front = svg.querySelector('#limbsFront');
      this.limbs = ORDER.map((name) => {
        const limb = LIMBS[name];
        const count = limb.segs.length + 1;
        return {
          name,
          ...limb,
          el: svg.querySelector(`.limb[data-limb="${name}"]`),
          parts: [...limb.segs.map((_, i) => svg.querySelector(`#${name}-${i}`)), svg.querySelector(`#${name}-end`)],
          rims: [...limb.segs.map((_, i) => svg.querySelector(`#${name}-${i} > .rim`)), svg.querySelector(`#${name}-end > .rim`)],
          angles: [...POSES.float[name]].slice(0, count),
        };
      });
      this.byName = Object.fromEntries(this.limbs.map((l) => [l.name, l]));
      this.name = 'float';
      this.torso = 0;
      this.head = 0;
      this.lift = [0, 0];
      this.aim = 0;
      this.layer();
    }

    get poses() {
      return Object.keys(POSES);
    }

    set(name) {
      if (!POSES[name] || name === this.name) return false;
      this.name = name;
      this.layer();
      return true;
    }

    // The direction (degrees, torso frame) the pointing arm reaches.
    pointAt(deg) {
      this.aim = wrap(deg);
    }

    // Limbs listed in the pose's `front` go in front of the torso.
    layer() {
      const front = POSES[this.name].front ?? [];
      for (const limb of this.limbs) {
        const parent = front.includes(limb.name) ? this.front : this.back;
        if (limb.el.parentNode !== parent) parent.append(limb.el);
      }
    }

    target(limb) {
      const pose = POSES[this.name];
      if (this.name === 'point') {
        // Reach with whichever arm is on that side; the other goes on the hip.
        const right = Math.abs(this.aim) < 90;
        if (limb.name === (right ? 'armB' : 'armA')) return [this.aim, right ? -8 : 8, 0];
        if (limb.name === (right ? 'armA' : 'armB')) return right ? [104, -118, 0] : [76, 118, 0];
      }
      return pose[limb.name];
    }

    // One step (12 fps): ease every joint toward the pose, add the pose's
    // fidgets and the mood's energy, and trail the legs behind fast moves.
    step(clock, ease, { energy = 1, torso = 0, vel = { x: 0, y: 0 } } = {}) {
      const pose = POSES[this.name];
      this.torso += ((pose.torso ?? 0) - this.torso) * ease;
      this.head += ((pose.head ?? 0) - this.head) * ease;
      const lift = pose.lift ?? [0, 0];
      this.lift = this.lift.map((v, i) => v + (lift[i] - v) * ease);
      const trail = Math.max(-18, Math.min(18, vel.x * 0.015));

      for (const limb of this.limbs) {
        const goal = this.target(limb);
        let world = torso + this.torso;
        limb.angles.forEach((a, j) => {
          limb.angles[j] = a + wrap(goal[j] - a) * ease;
          let angle = limb.angles[j];
          for (const [name, joint, amp, freq, phase] of pose.fidget) {
            if (name === limb.name && joint === j) angle += amp * energy * Math.sin(clock * freq * Math.PI * 2 + phase);
          }
          if (limb.end === 'foot' && j > 0) angle -= trail * j * 0.6;
          const at = j === 0 ? `translate(${limb.root[0]} ${limb.root[1]}) ` : `translate(${limb.segs[j - 1][0]} 0) `;
          limb.parts[j].setAttribute('transform', `${at}rotate(${f2(angle)})`);
          // Keep the violet rim on the same side of the screen however the
          // segment turns.
          world += angle;
          const c = Math.cos(-world * RAD);
          const s = Math.sin(-world * RAD);
          limb.rims[j].setAttribute('transform', `translate(${f2(RIM[0] * c - RIM[1] * s)} ${f2(RIM[0] * s + RIM[1] * c)})`);
        });
      }
    }
  }

  window.Capri.Limbs = Limbs;
  window.Capri.POSES = POSES;
})();
