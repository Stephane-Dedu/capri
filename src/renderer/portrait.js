// Capri's face in close-up, traced from the anime (portrait-art.js), with live
// eyes and mouth that mirror the rig: same mood, same blinks, same gaze, and
// she talks when the rig talks. Used twice: the avatar in the chat header and
// the cut-in panel she pops up for big moments, like an anime close-up.

window.Capri = window.Capri || {};

(() => {
  const P = window.Capri.PORTRAIT;
  const { ART, MOODS, Mouth } = window.Capri;
  const C = { ...ART.colors, white: '#f6f6f9', iris: '#0567db', irisEdge: '#033d8c' };
  const f1 = (n) => n.toFixed(1);
  const f2 = (n) => n.toFixed(2);
  let count = 0;

  class Portrait {
    // view: the part of the close-up to show, [x, y, w, h] in its pixels.
    constructor(svg, view = [0, 0, P.width, P.height]) {
      const id = `pt${count++}`;
      this.svg = svg;
      svg.setAttribute('viewBox', view.join(' '));
      svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
      svg.innerHTML = this.markup(id);
      const $ = (sel) => svg.querySelector(sel);
      this.eyes = P.eyes.map((eye, i) => ({
        ...eye,
        irisEl: $(`#${id}iris${i}`),
        whiteEl: $(`#${id}white${i}`),
        lidEl: $(`#${id}lid${i}`),
      }));
      this.mouth = new Mouth(svg, `${id}mouth`, P.mouth[0], P.mouth[P.mouth.length - 1]);
    }

    markup(id) {
      const eyes = P.eyes
        .map((eye, i) => {
          const [cx, cy, rx, ry, rot] = eye.ring;
          const t = eye.thick;
          const [ix, iy, ir] = eye.iris;
          const [wx, wy, wr] = eye.white;
          return `
          <clipPath id="${id}clip${i}"><ellipse cx="${cx}" cy="${cy}" rx="${f2(rx - t)}" ry="${f2(ry - t)}" transform="rotate(${rot} ${cx} ${cy})"/></clipPath>
          <g clip-path="url(#${id}clip${i})">
            <g id="${id}iris${i}">
              <circle cx="${ix}" cy="${iy}" r="${ir}" fill="${C.iris}" stroke="${C.irisEdge}" stroke-width="${f2(ir * 0.08)}"/>
              <circle id="${id}white${i}" cx="${wx}" cy="${wy}" r="${wr}" fill="${C.white}" stroke="${C.ink}" stroke-width="${f2(wr * 0.12)}"/>
            </g>
            <rect id="${id}lid${i}" x="${f1(cx - rx * 2)}" y="${f1(cy - ry * 3)}" width="${f1(rx * 4)}" height="${f1(ry * 2)}" fill="${C.ink}"/>
          </g>
          <ellipse cx="${cx}" cy="${cy}" rx="${f2(rx - t / 2)}" ry="${f2(ry - t / 2)}" transform="rotate(${rot} ${cx} ${cy})" fill="none" stroke="${C.green}" stroke-width="${t}"/>`;
        })
        .join('');
      return `
        <defs>
          <pattern id="${id}glitter" patternUnits="userSpaceOnUse" width="${P.width}" height="${P.height}">
            <image href="${P.glitter}" width="${P.width}" height="${P.height}"/>
          </pattern>
        </defs>
        <path fill-rule="evenodd" fill="${C.ink}" d="${P.base}"/>
        <path fill-rule="evenodd" fill="${C.purple}" d="${P.purple}"/>
        <path fill-rule="evenodd" fill="${C.pink}" d="${P.pink}"/>
        <path fill-rule="evenodd" fill="url(#${id}glitter)" d="${P.pink}"/>
        <path fill-rule="evenodd" fill="${C.green}" d="${P.green}"/>
        ${eyes}
        ${Mouth.markup(`${id}mouth`, 2.6)}`;
    }

    // Copy the rig's face: its mood, blink, gaze and talking.
    mirror(rig, now) {
      const m = MOODS[rig.mood] ?? MOODS.idle;
      const blinking = now < rig.blinkUntil;
      this.eyes.forEach((eye, i) => {
        const [cx, cy, rx, ry] = eye.ring;
        const [ix, iy, ir] = eye.iris;
        const reach = Math.min(rx, ry) - eye.thick - ir * m.iris - 1;
        const gx = ix + rig.gaze.x * reach;
        const gy = iy + rig.gaze.y * reach;
        eye.irisEl.setAttribute('transform', `translate(${f2(gx)} ${f2(gy)}) scale(${m.iris}) translate(${-ix} ${-iy})`);
        eye.whiteEl.setAttribute('r', f2(eye.white[2] * m.white));
        const closure = blinking ? 1 : m.lid;
        const slant = (m.lidRot || 0) * (i === 0 ? 1 : -1);
        eye.lidEl.setAttribute('height', f1(ry * 2 + closure * ry * 2));
        eye.lidEl.setAttribute('transform', `rotate(${slant} ${cx} ${cy})`);
      });
      this.mouth.pose(m, rig);
    }
  }

  // The face, framed tight around the eyes and mouth: for small avatars.
  Portrait.FACE_VIEW = [110, 142, 240, 190];

  window.Capri.Portrait = Portrait;
})();
