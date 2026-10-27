// Capri as a cut-paper puppet, built from the traced reference art in art.js.
// The trace is cut into pieces (mane core, hair spikes, torso, legs, head,
// loose shards), nested so children ride on their parents, and each piece
// rotates about its own joint. Every mood has its own motion: tempo, sway,
// how the hair flares and flicks, how the legs swing, how the head tilts and
// twitches. The face (visor, ringed eyes, white teeth for a mouth) rides on the head and
// is drawn live so it can blink, look around and talk.
//
// Poses step at 12 fps ("on twos", like hand-drawn anime) while glitch
// tearing runs faster. The art lives in <defs> and is drawn through <use>
// copies, so the glitch layers (tinted ghosts, sliding bands) mirror the live pose.

window.Capri = window.Capri || {};

(() => {
  const { ART, Limbs, Mouth } = window.Capri;
  // Room below the traced frame for legs that dangle.
  const VB = { w: ART.width, h: ART.height + 90 };
  const POSE_EASE = 0.32;
  const K = VB.w / 260; // effects were tuned on a 260-unit-wide rig
  const STEP_MS = 1000 / 12;
  const GLITCH_MS = 45;
  const BANDS = 9;
  const LAYERS = ['purple', 'blue', 'pink', 'shade', 'green'];
  // Eye proportions, as fractions of the ring's outer radius, measured on a
  // close-up of her face: a green ring set in a pointed black socket, a black
  // gap, a flat blue iris with a dark edge and a white pupil in its middle.
  const EYE = { ring: 0.15, iris: 0.54, white: [0.22, 0.24] };
  // At desktop size her face is a few pixels across, so it is drawn a bit
  // bigger than in the frame, and the eyes a bit bigger within it.
  const FACE_SCALE = 1.35;
  const EYE_SCALE = 1.12;
  const EYE_R = ART.face.ring * EYE_SCALE;

  const C = {
    ...ART.colors,
    white: '#f6f6f9',
    cyan: '#00f0ff',
    iris: '#0567db',
    irisEdge: '#033d8c',
  };

  // Face: lid 0 open .. 1 shut, lidRot > 0 slants angrily and < 0 droopily,
  // iris and white scale the eye parts, mouth picks the mouth's shape and zig
  // how far it bulges (see mouth.js).
  // Motion: tempo speeds everything up, sway/locks/legs scale the swing of the
  // body, hair and legs, flare pushes the hair spikes outward, tilt is the
  // resting head angle, twitch is how often she snaps and flicks, bob scales
  // the bounce. bristle shivers the hair, chaos jitters everything.
  const MOODS = {
    idle: { mouth: 'zig', zig: 1, lid: 0, lidRot: 0, iris: 1, white: 1,
      tempo: 1, sway: 1, locks: 1, flare: 0, legs: 1, tilt: 0, twitch: 1, bob: 1 },
    hype: { mouth: 'open', zig: 1.1, lid: 0, lidRot: 0, iris: 0.9, white: 1.2,
      tempo: 1.8, sway: 1.4, locks: 1.6, flare: 0.8, legs: 2.6, tilt: 0, twitch: 1.6, bob: 2.2 },
    smug: { mouth: 'zig', zig: 1.3, lid: 0.45, lidRot: -10, iris: 1, white: 1,
      tempo: 0.7, sway: 0.8, locks: 0.7, flare: 0, legs: 0.8, tilt: -7, twitch: 0.3, bob: 0.6 },
    curious: { mouth: 'o', zig: 1, lid: 0, lidRot: 0, iris: 1.12, white: 1.15,
      tempo: 1, sway: 0.7, locks: 1, flare: 0.3, legs: 0.6, tilt: 11, twitch: 0.6, bob: 0.8 },
    mischief: { mouth: 'grin', zig: 1.25, lid: 0.32, lidRot: 14, iris: 0.95, white: 1,
      tempo: 1.4, sway: 1.5, locks: 1.2, flare: 0.2, legs: 1.8, tilt: -9, twitch: 1.2, bob: 1.2 },
    annoyed: { mouth: 'zig', zig: 0.5, lid: 0.42, lidRot: 20, iris: 0.85, white: 0.8,
      tempo: 2.2, sway: 0.4, locks: 0.6, flare: 0.5, legs: 0.3, tilt: 4, twitch: 2, bob: 0.4, bristle: true },
    soft: { mouth: 'grin', zig: 0.65, lid: 0.25, lidRot: -6, iris: 1.1, white: 1.3,
      tempo: 0.55, sway: 0.9, locks: 0.8, flare: -0.2, legs: 0.7, tilt: 6, twitch: 0.2, bob: 0.7 },
    glitch: { mouth: 'open', zig: 1.4, lid: 0, lidRot: 0, iris: 0.7, white: 0.6,
      tempo: 2, sway: 1.2, locks: 1.5, flare: 0.4, legs: 1.5, tilt: 0, twitch: 3, bob: 1.5, chaos: true },
  };

  // Her lower face: black under the mask, down to a pointed chin, so the
  // mouth always has room. And the mouth's corners on it.
  const JAW = [[276, 308.6], [321, 307.2], [316, 313], [304, 320.5], [296, 322.5], [286, 318], [279, 313]];
  const MOUTH = [[288, 312.6], [309.5, 310.6]];

  const jit = (amount) => (Math.random() * 2 - 1) * amount;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const pts = (list) => list.map(([x, y]) => `${x},${y}`).join(' ');
  const f1 = (n) => n.toFixed(1);
  const f2 = (n) => n.toFixed(2);
  const RAD = Math.PI / 180;

  // Where point p lands after rotating by deg about (cx, cy).
  function rotateAbout([x, y], cx, cy, deg) {
    const c = Math.cos(deg * RAD);
    const s = Math.sin(deg * RAD);
    return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
  }

  // The black socket around an eye: a four-pointed star with concave sides,
  // longest toward the outer corner (side = -1 for her right eye, on the
  // left of the picture), always covering a margin around the ring.
  function socketPath(x, y, R, side) {
    const tips = [
      [1.8 * side, 0.12],
      [0.3 * side, 1.42],
      [-1.32 * side, 0.02],
      [-0.42 * side, -1.38],
    ].map(([u, v]) => [x + u * R, y + v * R]);
    let d = `M${tips[0].map(f2).join(',')}`;
    for (let i = 0; i < 4; i++) {
      const a = tips[i];
      const b = tips[(i + 1) % 4];
      // Bow each side out so its middle sits 1.2R from the center.
      const mid = Math.atan2((a[1] + b[1]) / 2 - y, (a[0] + b[0]) / 2 - x);
      const mx = x + Math.cos(mid) * 1.2 * R;
      const my = y + Math.sin(mid) * 1.2 * R;
      d += `Q${f2(2 * mx - (a[0] + b[0]) / 2)},${f2(2 * my - (a[1] + b[1]) / 2)} ${b.map(f2).join(',')}`;
    }
    return `${d}Z`;
  }

  function eyeMarkup(eye, i) {
    const R = EYE_R;
    const { x, y } = eye;
    return `
      <clipPath id="eyeClip${i}"><circle cx="${x}" cy="${y}" r="${f2(R * (1 - EYE.ring))}"/></clipPath>
      <path d="${socketPath(x, y, R, i === 0 ? -1 : 1)}" fill="${C.ink}"/>
      <g clip-path="url(#eyeClip${i})">
        <g id="iris${i}">
          <circle cx="${x}" cy="${y}" r="${f2(R * EYE.iris)}" fill="${C.iris}" stroke="${C.irisEdge}" stroke-width="${f2(R * 0.05)}"/>
          <ellipse id="white${i}" cx="${x}" cy="${y}" rx="${f2(R * EYE.white[0])}" ry="${f2(R * EYE.white[1])}" fill="${C.white}"/>
        </g>
        <rect id="lid${i}" x="${x - R * 2}" y="${y - R * 3}" width="${R * 4}" height="${R * 2}" fill="${C.ink}"/>
      </g>
      <circle cx="${x}" cy="${y}" r="${f2(R * (1 - EYE.ring / 2))}" fill="none" stroke="${C.green}" stroke-width="${f2(R * EYE.ring)}"/>`;
  }

  function faceMarkup() {
    const F = ART.face;
    const cx = (F.eyes[0].x + F.eyes[1].x) / 2;
    const cy = (F.eyes[0].y + F.eyes[1].y) / 2 + 4;
    return `<g id="face" transform="translate(${cx} ${cy}) scale(${FACE_SCALE}) translate(${-cx} ${-cy})">
      <polygon points="${pts(F.visor)}" fill="${C.green}"/>
      <polygon points="${pts(F.wedge)}" fill="${C.ink}"/>
      ${F.sockets.map((s) => `<polygon points="${pts(s)}" fill="${C.ink}"/>`).join('')}
      ${F.eyes.map(eyeMarkup).join('')}
      <polygon points="${pts(JAW)}" fill="${C.ink}"/>
      ${Mouth.markup('mouth', 0.9)}
    </g>`;
  }

  // One piece and, nested inside it, everything that hangs off it. The torso
  // carries the limbs: one layer behind it and one in front.
  function pieceMarkup(piece, children, limbs) {
    const layers = LAYERS.filter((k) => piece[k]).map((k) => {
      const path = `<path fill-rule="evenodd" fill="${C[k]}" d="${piece[k]}"/>`;
      if (k !== 'pink') return path;
      return `${path}
        <path class="glitter" fill-rule="evenodd" fill="url(#glitter)" d="${piece.pink}"/>
        <path class="twinkle" fill-rule="evenodd" fill="url(#twinkle)" d="${piece.pink}"/>`;
    });
    const torso = piece.kind === 'torso';
    return `<g class="piece" data-name="${piece.name}">
      ${torso ? `<g id="limbsBack">${limbs.back}</g>` : ''}
      <path fill-rule="evenodd" fill="${C.ink}" d="${piece.base}"/>
      ${layers.join('')}
      ${torso ? '<g id="limbsFront"></g>' : ''}
      ${piece.kind === 'head' ? faceMarkup() : ''}
      ${(children.get(piece.name) || []).map((p) => pieceMarkup(p, children, limbs)).join('')}
    </g>`;
  }

  function markup() {
    const children = new Map();
    const limbs = Limbs.markup();
    for (const piece of ART.pieces) {
      const key = piece.parent || '';
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(piece);
    }
    const pattern = (id, href) =>
      `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${VB.w}" height="${VB.h}">
        <image href="${href}" width="${VB.w}" height="${VB.h}"/>
      </pattern>`;
    const bandClips = Array.from({ length: BANDS }, (_, i) =>
      `<clipPath id="band${i}"><rect id="bandRect${i}" x="${-VB.w}" y="0" width="${VB.w * 3}" height="0"/></clipPath>`).join('');
    const slices = Array.from({ length: BANDS }, (_, i) =>
      `<g clip-path="url(#band${i})"><use id="slice${i}" href="#art"/></g>`).join('');
    const tint = (id, color) =>
      `<filter id="${id}" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB">
        <feFlood flood-color="${color}"/><feComposite in2="SourceAlpha" operator="in"/>
      </filter>`;

    return `
    <style>#art.tearing .glitter, #art.tearing .twinkle { display: none; }</style>
    <defs>
      ${pattern('glitter', ART.glitter)}
      ${pattern('twinkle', ART.twinkle)}
      ${tint('tintPink', C.pink)}
      ${tint('tintCyan', C.cyan)}
      ${limbs.defs}
      ${bandClips}
      <g id="art">
        <g id="body">${children.get('').map((p) => pieceMarkup(p, children, limbs)).join('')}</g>
      </g>
    </defs>
    <g id="stage">
      <use id="ghostPink" href="#art" filter="url(#tintPink)" style="display:none"/>
      <use id="ghostCyan" href="#art" filter="url(#tintCyan)" style="display:none"/>
      <use id="main" class="hit" href="#art"/>
      <g id="slices" style="display:none">${slices}</g>
    </g>`;
  }

  class Rig {
    constructor(svg) {
      svg.setAttribute('viewBox', `0 0 ${VB.w} ${VB.h}`);
      svg.innerHTML = markup();
      const $ = (id) => svg.querySelector(`#${id}`);
      this.el = {
        art: $('art'),
        body: $('body'),
        stage: $('stage'),
        main: $('main'),
        slices: $('slices'),
        ghostPink: $('ghostPink'),
        ghostCyan: $('ghostCyan'),
      };
      this.limbs = new Limbs(svg);
      this.mouth = new Mouth(svg, 'mouth', MOUTH[0], MOUTH[1], { depth: 0.55 });
      this.pieces = ART.pieces.map((p) => {
        const [px, py] = p.pivot;
        const piece = {
          name: p.name,
          kind: p.kind,
          el: svg.querySelector(`#art .piece[data-name="${p.name}"]`),
          px,
          py,
          phase: Math.random() * Math.PI * 2,
          freq: 0.8 + Math.random() * 0.6,
          sign: Math.random() < 0.5 ? -1 : 1,
          flick: 0,
        };
        if (p.tip) {
          const dx = p.tip[0] - px;
          const dy = p.tip[1] - py;
          piece.len = Math.hypot(dx, dy);
          piece.dir = [dx / piece.len, dy / piece.len];
          piece.axis = Math.atan2(dy, dx) / RAD;
        }
        return piece;
      });
      this.piece = Object.fromEntries(this.pieces.map((p) => [p.name, p]));
      this.twinkles = [...svg.querySelectorAll('#art .twinkle')];
      this.eyes = ART.face.eyes.map((eye, i) => ({
        ...eye,
        iris: $(`iris${i}`),
        white: $(`white${i}`),
        lid: $(`lid${i}`),
      }));
      this.bands = Array.from({ length: BANDS }, (_, i) => ({ rect: $(`bandRect${i}`), use: $(`slice${i}`) }));

      this.mood = 'idle';
      this.moodUntil = 0;
      this.talking = false;
      this.thinking = false;
      this.glitch = 0; // 0..1, set by whoever is animating a warp
      this.gaze = { x: 0, y: 0 };
      this.gazeTarget = { x: 0, y: 0 };
      this.vel = { x: 0, y: 0 }; // smoothed screen velocity, px/s
      this.velTarget = { x: 0, y: 0 };
      this.clock = Math.random() * 100;
      this.lastStep = -Infinity;
      this.lastGlitch = 0;
      this.glitching = false;
      this.pulseUntil = 0;
      this.blinkUntil = 0;
      this.nextBlink = performance.now() + 1500;
      this.twitchUntil = 0;
      this.twitchAngle = 0;
    }

    get moods() {
      return Object.keys(MOODS);
    }

    get poses() {
      return this.limbs.poses;
    }

    get pose() {
      return this.limbs.name;
    }

    get sleeping() {
      return this.limbs.name === 'sleep';
    }

    // Switch pose. The joints ease over a few frames, with a flicker of
    // glitch to sell the snap.
    setPose(name) {
      if (!this.limbs.set(name)) return false;
      this.pulse(0.35, 90);
      return true;
    }

    // Which way to point, as a screen angle in degrees (0 = right).
    pointAt(deg) {
      this.limbs.pointAt(deg);
    }

    setMood(mood, holdMs = 9000) {
      if (!MOODS[mood]) return;
      this.mood = mood;
      this.moodUntil = performance.now() + holdMs;
    }

    // Gaze in -1..1 per axis.
    lookAt(x, y) {
      this.gazeTarget.x = clamp(x, -1, 1);
      this.gazeTarget.y = clamp(y, -1, 1);
    }

    // How fast she is being moved across the screen (px/s); her hair and
    // shins trail behind.
    drift(vx, vy) {
      this.velTarget.x = vx;
      this.velTarget.y = vy;
    }

    // A short burst of glitch tearing that clears itself.
    pulse(intensity = 0.6, ms = 120) {
      this.glitch = Math.max(this.glitch, intensity);
      this.pulseUntil = performance.now() + ms;
    }

    tick(now) {
      if (this.mood !== 'idle' && now > this.moodUntil) this.mood = 'idle';
      if (this.pulseUntil && now > this.pulseUntil) {
        this.pulseUntil = 0;
        this.glitch = 0;
      }
      const m = MOODS[this.mood];
      if (!this.pulseUntil && this.glitch === 0) {
        if (this.thinking && Math.random() < 0.05) this.pulse(0.45, 90);
        else if (m.chaos && Math.random() < 0.03) this.pulse(0.7, 110);
      }

      if (now - this.lastStep >= STEP_MS) {
        const dt = Math.min(0.25, (now - this.lastStep) / 1000);
        this.lastStep = now;
        this.animate(now, dt, m);
      }
      if (this.glitch > 0.01) {
        if (now - this.lastGlitch >= GLITCH_MS) {
          this.lastGlitch = now;
          this.tear(this.glitch);
        }
      } else if (this.glitching) {
        this.mend();
      }
    }

    animate(now, dt, m) {
      const energy = this.talking ? 1.3 : this.thinking ? 1.2 : 1;
      const tempo = m.tempo * (this.talking ? 1.3 : 1);
      this.clock += dt * tempo;
      const c = this.clock;
      this.vel.x += (this.velTarget.x - this.vel.x) * 0.5;
      this.vel.y += (this.velTarget.y - this.vel.y) * 0.5;
      const chaos = (deg) => (m.chaos ? jit(deg) : 0);

      // Head: resting tilt, a slow sway, a nod while talking, a lean toward
      // where she's looking, and every so often a sharp twitch she holds.
      if (now > this.twitchUntil && Math.random() < 0.012 * m.twitch * energy) {
        this.twitchAngle = jit(13);
        this.twitchUntil = now + 250 + Math.random() * 500;
      }
      const twitch = now < this.twitchUntil ? this.twitchAngle : 0;
      const nod = this.talking ? 3.5 * Math.sin(c * 9) : 0;
      let head = m.tilt + 4 * Math.sin(c * 1.7) * m.sway + twitch + nod + this.gaze.x * 6 + chaos(9);

      const sway = 2.2 * Math.sin(c * 1.1 + 0.5) * m.sway + this.gaze.x * 1.5 - clamp(this.vel.x * 0.004, -4, 4) + chaos(3);
      this.limbs.step(c, POSE_EASE, { energy: (this.sleeping ? 0.3 : energy) * Math.min(1.6, m.legs), torso: sway, vel: this.vel });
      const torso = sway + this.limbs.torso;
      head += this.limbs.head;
      this.turn('torso', torso);
      this.turn('head', head);

      // The mane sways about her head and follows it wherever the torso and
      // neck carry it, without whipping around as hard as the head itself.
      const T = this.piece.torso;
      const H = this.piece.head;
      const M = this.piece.mane;
      let center = rotateAbout([M.px, M.py], H.px, H.py, head * 0.5);
      center = rotateAbout(center, T.px, T.py, torso);
      const mane = head * 0.3 + 2 * Math.sin(c * 0.9) * m.sway - clamp(this.vel.x * 0.006, -6, 6) + chaos(3);
      const breathe = 1 + 0.018 * Math.sin(c * 2.4) * energy + 0.02 * m.flare;
      M.el.setAttribute(
        'transform',
        `translate(${f2(center[0] - M.px)} ${f2(center[1] - M.py)}) ` +
          `translate(${f1(M.px)} ${f1(M.py)}) rotate(${f2(mane)}) scale(${f2(breathe)}) translate(${f1(-M.px)} ${f1(-M.py)})`,
      );

      const flickChance = 0.006 * m.twitch * energy;
      for (const p of this.pieces) {
        if (p.kind === 'lock') this.poseLock(p, c, m, energy, flickChance);
        else if (p.kind === 'shard') this.poseShard(p, c, m, energy);
      }

      const bob = Math.sin(c * (this.sleeping ? 1.2 : 2.6)) * 2.4 * m.bob * energy + jit(0.6);
      const [lx, ly] = this.limbs.lift;
      this.el.body.setAttribute('transform', `translate(${f1(lx)} ${f1(ly + bob)})`);

      for (const tw of this.twinkles) {
        const r = Math.random();
        tw.setAttribute('opacity', r < 0.35 ? '0' : r < 0.7 ? '0.55' : '1');
      }

      this.poseEyes(now, m);
      this.mouth.pose(m, this);
    }

    turn(name, deg) {
      const p = this.piece[name];
      if (p) p.el.setAttribute('transform', `rotate(${f2(deg)} ${f1(p.px)} ${f1(p.py)})`);
    }

    // A hair spike: waves about its root, stretches outward when she flares,
    // sometimes flicks hard, and streams away from the way she's moving.
    poseLock(p, c, m, energy, flickChance) {
      const amp = (3 + p.len / 16) * m.locks * energy;
      let deg = amp * Math.sin(c * 2.6 * p.freq + p.phase) * p.sign;
      if (m.bristle) deg += jit(amp * 0.7);
      if (m.chaos) deg += jit(amp);
      if (Math.random() < flickChance) p.flick = (8 + Math.random() * 10) * (Math.random() < 0.5 ? -1 : 1);
      deg += p.flick;
      p.flick *= 0.55;
      // Turn the tip toward -velocity: the cross product of the spike's
      // direction with the trailing direction.
      const trail = (p.dir[0] * -this.vel.y - p.dir[1] * -this.vel.x) * 0.02;
      deg += clamp(trail, -22, 22);
      const stretch = 1 + 0.1 * m.flare + 0.035 * Math.sin(c * 3.1 * p.freq + p.phase);
      p.el.setAttribute(
        'transform',
        `translate(${f1(p.px)} ${f1(p.py)}) rotate(${f2(deg + p.axis)}) scale(${f2(stretch)} 1) ` +
          `rotate(${f2(-p.axis)}) translate(${f1(-p.px)} ${f1(-p.py)})`,
      );
    }

    // A loose shard: swings from the point nearest the body, jitters, and
    // now and then blinks out for a frame.
    poseShard(p, c, m, energy) {
      const flicker = Math.random() < 0.02 * energy * (m.chaos ? 3 : 1);
      p.el.style.display = flicker && Math.random() < 0.5 ? 'none' : '';
      const kick = flicker ? 5 : 1;
      const deg = 3 * Math.sin(c * 2 * p.freq + p.phase) * energy * m.sway + jit(kick) + (m.chaos ? jit(6) : 0);
      p.el.setAttribute(
        'transform',
        `translate(${f1(jit(kick))} ${f1(jit(kick))}) rotate(${f2(deg)} ${f1(p.px)} ${f1(p.py)})`,
      );
    }

    poseEyes(now, m) {
      const R = EYE_R;
      if (now > this.nextBlink) {
        this.blinkUntil = now + STEP_MS * 2;
        this.nextBlink = now + 1800 + Math.random() * 4500;
      }
      let gx = this.gazeTarget.x;
      let gy = this.gazeTarget.y;
      if (this.thinking) {
        gx = Math.cos(now / 160);
        gy = Math.sin(now / 160);
      }
      this.gaze.x += (gx - this.gaze.x) * 0.6;
      this.gaze.y += (gy - this.gaze.y) * 0.6;
      // How far the iris can travel and still sit inside the ring.
      const reach = R * (1 - EYE.ring - EYE.iris * m.iris) - 0.3;

      this.eyes.forEach((eye, i) => {
        let closure = now < this.blinkUntil || this.sleeping ? 1 : m.lid;
        if (m.chaos && Math.random() < 0.3) closure = Math.random() * 0.8;
        const slant = (m.lidRot || 0) * (i === 0 ? 1 : -1);
        eye.iris.setAttribute(
          'transform',
          `translate(${f2(eye.x + this.gaze.x * reach)} ${f2(eye.y + this.gaze.y * reach)}) scale(${m.iris}) translate(${-eye.x} ${-eye.y})`,
        );
        eye.white.setAttribute('rx', f2(R * EYE.white[0] * m.white));
        eye.white.setAttribute('ry', f2(R * EYE.white[1] * m.white));
        eye.lid.setAttribute('y', f2(eye.y - R * 3));
        eye.lid.setAttribute('height', f2(R * 2 + closure * R * 2));
        eye.lid.setAttribute('transform', `rotate(${slant} ${eye.x} ${eye.y})`);
      });
    }

    // One frame of glitch: tinted ghosts split apart, the body tears into
    // horizontal bands that slide sideways, and at high intensity whole
    // frames drop out.
    tear(intensity) {
      const { el } = this;
      this.glitching = true;
      // Twelve copies of the glitter are too slow, and nobody sees it mid-tear.
      el.art.classList.add('tearing');
      const blank = intensity > 0.6 && Math.random() < 0.12;
      const sliced = intensity > 0.18;

      el.main.style.display = sliced || blank ? 'none' : '';
      el.slices.style.display = sliced && !blank ? '' : 'none';
      if (sliced) {
        const cuts = Array.from({ length: BANDS - 1 }, () => Math.random() * VB.h).sort((a, b) => a - b);
        cuts.unshift(-VB.h * 0.2);
        cuts.push(VB.h * 1.2);
        this.bands.forEach((band, i) => {
          band.rect.setAttribute('y', f1(cuts[i]));
          band.rect.setAttribute('height', f1(cuts[i + 1] - cuts[i] + 0.5));
          const dx = Math.random() < 0.45 ? 0 : jit(36 * K * intensity);
          band.use.setAttribute('transform', `translate(${f1(dx)} 0)`);
        });
      }

      const split = (2 + 9 * intensity) * K;
      for (const [ghost, dir] of [[el.ghostPink, -1], [el.ghostCyan, 1]]) {
        ghost.style.display = blank ? 'none' : '';
        ghost.setAttribute('opacity', (0.35 + 0.5 * intensity).toFixed(2));
        ghost.setAttribute('transform', `translate(${f1(dir * split + jit(2 * K))} ${f1(jit(3 * K * intensity))})`);
      }
      const skew = f1(jit(10 * intensity));
      el.stage.setAttribute('transform', `translate(${VB.w / 2} ${VB.h / 2}) skewX(${skew}) translate(${-VB.w / 2} ${-VB.h / 2})`);
    }

    mend() {
      const { el } = this;
      this.glitching = false;
      el.art.classList.remove('tearing');
      el.main.style.display = '';
      el.slices.style.display = 'none';
      el.ghostPink.style.display = 'none';
      el.ghostCyan.style.display = 'none';
      el.stage.removeAttribute('transform');
    }
  }

  window.Capri.Rig = Rig;
  window.Capri.RIG_VIEWBOX = VB;
  window.Capri.MOODS = MOODS;
})();
