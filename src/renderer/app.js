// Capri's behavior: where she is, when she warps, how she reacts to the
// cursor, and the glue between the rig, the effects layer, the chat panel
// and the main process.

(() => {
  const { Rig, FX, Chat, QUIPS, RIG_VIEWBOX, ART, Portrait, shortModel } = window.Capri;
  const { bridge } = window;

  // 400px for the traced frame, plus the room below it for dangling legs.
  const HEIGHT = Math.round((400 * RIG_VIEWBOX.h) / ART.height);
  const SIZE = { w: Math.round((HEIGHT * RIG_VIEWBOX.w) / RIG_VIEWBOX.h), h: HEIGHT };
  // Her face, as a fraction of the sprite box (she is mostly hair).
  const FACE_AT = {
    x: (ART.face.eyes[0].x + ART.face.eyes[1].x) / 2 / RIG_VIEWBOX.w,
    y: (ART.face.eyes[0].y + ART.face.eyes[1].y) / 2 / RIG_VIEWBOX.h,
  };
  const EDGE = 14;
  // The cut-in frames her face from the close-up, like the anime does.
  const CUTIN_VIEW = [55, 118, 380, 226];
  const CUTIN_MS = 2300;
  // Poses: what she does with herself between jobs, and when she nods off.
  const IDLE_POSES = { perch: 3, crossed: 3, chill: 2, float: 2, lounge: 2, hug: 2 };
  const SLEEP_AFTER = 4 * 60000;

  // Warp choreography, in ms: charge up (tearing), collapse to a scanline,
  // vanish, expand at the destination, then let the glitch settle.
  const WARPS = {
    big: { charge: 190, collapse: 70, gap: 110, expand: 90, settle: 280, shards: [26, 14], force: 1.2, ring: true, streak: true, glyphs: 6 },
    hop: { charge: 100, collapse: 55, gap: 45, expand: 70, settle: 170, shards: [10, 6], force: 0.8, ring: false, streak: true, glyphs: 0 },
    blink: { charge: 45, collapse: 0, gap: 30, expand: 0, settle: 110, shards: [5, 3], force: 0.5, ring: false, streak: false, glyphs: 0 },
  };

  // Keyed by Claude Code's error kinds, plus 'engine' for the SDK itself.
  const ERRORS = {
    authentication_failed: "i can't log in. run `claude` in a terminal, /login, then poke me again. (if you set CAPRI_USE_API_KEY, your ANTHROPIC_API_KEY is the problem.)",
    oauth_org_not_allowed: "your claude login isn't allowed in this org. check `claude` in a terminal.",
    billing_error: 'billing says no. check your claude account.',
    rate_limit: 'rate limited. even i need a breather. try again in a sec.',
    overloaded: 'the servers are overloaded. give it a moment, choom.',
    server_error: 'something broke upstream. try again?',
    model_not_found: "that model doesn't exist for you. /model auto fixes it.",
    max_output_tokens: '...reply cut off at the token limit.',
    engine: "claude code flatlined under me. is `claude` installed and logged in?",
  };

  const rand = (a, b) => a + Math.random() * (b - a);
  const jitter = (amount) => (Math.random() * 2 - 1) * amount;
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

  async function tween(ms, fn) {
    const start = performance.now();
    for (;;) {
      const t = Math.min(1, (performance.now() - start) / ms);
      fn(t);
      if (t >= 1) return;
      await nextFrame();
    }
  }

  const wrap = document.getElementById('capri');
  const svg = document.getElementById('rig');
  const bubble = document.getElementById('bubble');
  const rig = new Rig(svg);
  const fx = new FX(document.getElementById('fx'));
  const avatar = new Portrait(document.getElementById('avatar'), Portrait.FACE_VIEW);
  const cutin = { el: document.getElementById('cutin'), face: new Portrait(document.getElementById('cutinFace'), CUTIN_VIEW), timer: 0 };
  const chat = new Chat(document.getElementById('chat'), {
    onSend: send,
    onEscape: escape,
    onAnswer: (id, choice, note) => bridge.answer(id, choice, note),
  });

  const state = {
    pos: { x: innerWidth - SIZE.w - 80, y: innerHeight - SIZE.h - EDGE },
    scale: { x: 1, y: 1 },
    moving: false, // a warp is in progress
    acting: false, // an idle routine (possibly several warps) is in progress
    summoning: false,
    wander: true,
    replying: false,
    gazeOverride: null,
    nextAction: performance.now() + 5000,
    nextQuip: performance.now() + rand(45000, 90000),
    dodgeReadyAt: 0,
    info: {},
    lastActivity: performance.now(),
    idlePose: 'perch',
    working: 'think', // 'think' until the first tool call, then 'hack'
    idlePoseUntil: 0,
    poseOverride: null, // { pose, until }
  };
  const mouse = { x: -1, y: -1, t: 0, speed: 0 };
  let drag = null;
  let through = true;
  let reply = null;
  let bubbleTimer = 0;

  wrap.style.width = `${SIZE.w}px`;
  wrap.style.height = `${SIZE.h}px`;

  // ---- placement ---------------------------------------------------------

  function center() {
    return { x: state.pos.x + SIZE.w / 2, y: state.pos.y + SIZE.h / 2 };
  }

  function clampPos(p) {
    return {
      x: clamp(p.x, EDGE, innerWidth - SIZE.w - EDGE),
      y: clamp(p.y, EDGE, innerHeight - SIZE.h - EDGE),
    };
  }

  function place() {
    wrap.style.transform = `translate3d(${Math.round(state.pos.x)}px, ${Math.round(state.pos.y)}px, 0)`;
  }

  function faceCenter() {
    return { x: state.pos.x + SIZE.w * FACE_AT.x, y: state.pos.y + SIZE.h * FACE_AT.y };
  }

  function squash(sx, sy) {
    state.scale.x = sx;
    state.scale.y = sy;
    svg.style.transform = `scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
  }

  // Mostly hang around the screen edges, out of the way.
  function randomSpot() {
    const maxX = innerWidth - SIZE.w - EDGE;
    const maxY = innerHeight - SIZE.h - EDGE;
    for (let i = 0; i < 8; i++) {
      let p;
      if (Math.random() < 0.65) {
        const side = Math.floor(Math.random() * 4);
        if (side === 0) p = { x: rand(EDGE, maxX), y: maxY - rand(0, 40) };
        else if (side === 1) p = { x: rand(EDGE, maxX), y: EDGE + rand(0, 40) };
        else if (side === 2) p = { x: EDGE + rand(0, 40), y: rand(EDGE, maxY) };
        else p = { x: maxX - rand(0, 40), y: rand(EDGE, maxY) };
      } else {
        p = { x: rand(EDGE, maxX), y: rand(EDGE, maxY) };
      }
      if (Math.hypot(p.x - state.pos.x, p.y - state.pos.y) > 260) return p;
    }
    return { x: rand(EDGE, maxX), y: rand(EDGE, maxY) };
  }

  function nearbySpot(min, max, awayFrom) {
    const c = center();
    const a = awayFrom ? Math.atan2(c.y - awayFrom.y, c.x - awayFrom.x) + jitter(0.6) : Math.random() * Math.PI * 2;
    const d = rand(min, max);
    return { x: state.pos.x + Math.cos(a) * d, y: state.pos.y + Math.sin(a) * d };
  }

  // ---- movement ----------------------------------------------------------

  async function act(routine) {
    if (state.acting) return;
    state.acting = true;
    try {
      await routine();
    } finally {
      state.acting = false;
    }
  }

  async function warp(to, kind = 'big') {
    if (state.moving) return false;
    state.moving = true;
    const W = WARPS[kind];
    const from = center();
    const dest = clampPos(to);
    const toC = { x: dest.x + SIZE.w / 2, y: dest.y + SIZE.h / 2 };
    try {
      await tween(W.charge, (t) => {
        rig.glitch = 0.3 + 0.7 * t;
        squash(1 + jitter(0.12 * t), 1 - 0.08 * t);
      });
      fx.ghost(state.pos.x, state.pos.y, SIZE.w, SIZE.h);
      fx.shards(from.x, from.y, W.shards[0], W.force);
      if (W.ring) fx.ring(from.x, from.y);
      if (W.glyphs) fx.glyphs(from.x, from.y, W.glyphs);
      if (W.collapse) await tween(W.collapse, (t) => squash(1 + 1.3 * t, 1 - 0.97 * t));

      wrap.style.visibility = 'hidden';
      if (W.streak) fx.streak(from.x, from.y, toC.x, toC.y);
      await sleep(W.gap);

      state.pos = dest;
      place();
      wrap.style.visibility = '';
      fx.shards(toC.x, toC.y, W.shards[1], W.force * 0.6);
      if (W.ring) fx.ring(toC.x, toC.y);
      rig.glitch = 1;
      if (W.expand) await tween(W.expand, (t) => squash(2.3 - 1.3 * t, 0.03 + 0.97 * t));
      squash(1, 1);
      await tween(W.settle, (t) => {
        rig.glitch = 1 - t;
      });
    } finally {
      rig.glitch = 0;
      squash(1, 1);
      wrap.style.visibility = '';
      state.moving = false;
      refreshHover();
    }
    return true;
  }

  // A stutter-step run: several tiny blinks in roughly one direction.
  async function skitter() {
    let a = Math.random() * Math.PI * 2;
    const hops = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < hops; i++) {
      const d = rand(40, 90);
      let to = { x: state.pos.x + Math.cos(a) * d, y: state.pos.y + Math.sin(a) * d };
      const clamped = clampPos(to);
      if (clamped.x !== to.x || clamped.y !== to.y) {
        a += Math.PI * (0.5 + Math.random());
        to = clamped;
      }
      if (!(await warp(to, 'blink'))) return;
      await sleep(rand(50, 160));
      if (chat.isOpen || drag || state.summoning) return;
    }
  }

  function lookAround() {
    state.gazeOverride = { x: jitter(1), y: jitter(0.6), until: performance.now() + 1800 };
    rig.setMood(pick(['curious', 'mischief', 'smug']), 2500);
  }

  async function idleAction() {
    const r = Math.random();
    if (r < 0.3) await warp(nearbySpot(70, 220), 'hop');
    else if (r < 0.52) await warp(randomSpot(), 'big');
    else if (r < 0.7) await skitter();
    else if (r < 0.86) rig.pulse(rand(0.4, 0.8), rand(80, 200));
    else lookAround();
  }

  async function arrive() {
    wrap.style.visibility = 'hidden';
    place();
    await sleep(500);
    const c = center();
    fx.glyphs(c.x, c.y, 10);
    fx.ring(c.x, c.y);
    await sleep(160);
    wrap.style.visibility = '';
    fx.shards(c.x, c.y, 18, 0.9);
    rig.glitch = 1;
    await tween(110, (t) => squash(2.3 - 1.3 * t, 0.03 + 0.97 * t));
    squash(1, 1);
    await tween(380, (t) => {
      rig.glitch = 1 - t;
    });
    rig.glitch = 0;
    say(pick(QUIPS.boot), 4200);
  }

  async function summon(cursor) {
    if (chat.isOpen) {
      closeChat();
      return;
    }
    state.summoning = true;
    while (state.moving) await nextFrame();
    const left = cursor.x - SIZE.w - 40;
    await warp({ x: left < EDGE ? cursor.x + 40 : left, y: cursor.y - SIZE.h * 0.6 }, 'big');
    state.summoning = false;
    rig.setMood('hype', 2500);
    openChat();
  }

  function behave(now) {
    if (state.acting || state.moving || drag || rig.sleeping) return;
    if (now >= state.nextQuip) {
      state.nextQuip = now + rand(45000, 100000);
      if (!chat.isOpen && Math.random() < 0.6) say(pick(QUIPS.idle));
    }
    if (now < state.nextAction) return;
    const roaming = state.wander && !chat.isOpen && !state.replying;
    state.nextAction = now + (roaming ? rand(3500, 9500) : rand(3000, 7000));
    if (roaming) act(idleAction);
    else if (Math.random() < 0.6) rig.pulse(rand(0.25, 0.5), rand(60, 130));
  }

  function updateGaze(now) {
    if (state.gazeOverride && now < state.gazeOverride.until) {
      rig.lookAt(state.gazeOverride.x, state.gazeOverride.y);
      return;
    }
    const c = faceCenter();
    let target;
    if (now - mouse.t < 3000 && mouse.x >= 0) {
      target = mouse;
    } else if (chat.isOpen) {
      const box = chat.root.getBoundingClientRect();
      target = { x: box.left + box.width / 2, y: box.top + box.height - 40 };
    } else {
      target = { x: innerWidth / 2, y: innerHeight / 2 };
    }
    rig.lookAt((target.x - c.x) / 300, (target.y - c.y) / 300);
  }

  // ---- poses -------------------------------------------------------------

  function weighted(table) {
    let r = Math.random() * Object.values(table).reduce((a, b) => a + b, 0);
    for (const [key, w] of Object.entries(table)) if ((r -= w) < 0) return key;
    return Object.keys(table)[0];
  }

  // Working: typing into the air. Waiting on a permission: pointing at the
  // card. Between jobs she perches, crosses her legs, lies back or floats,
  // and if you leave her alone long enough she curls up and sleeps.
  function choosePose(now) {
    if (state.poseOverride && now < state.poseOverride.until) return state.poseOverride.pose;
    state.poseOverride = null;
    if (drag) return 'float';
    if (chat.pendingAsk !== null && chat.isOpen) return 'point';
    if (state.replying) return state.working;
    if (!chat.isOpen && now - state.lastActivity > SLEEP_AFTER) return 'sleep';
    if (now > state.idlePoseUntil) {
      let next = weighted(IDLE_POSES);
      if (next === state.idlePose) next = weighted(IDLE_POSES);
      state.idlePose = next;
      state.idlePoseUntil = now + rand(18000, 45000);
    }
    return state.idlePose;
  }

  function strikePose(pose, ms) {
    state.poseOverride = { pose, until: performance.now() + ms };
  }

  function updatePose(now) {
    const wasAsleep = rig.sleeping;
    rig.setPose(choosePose(now));
    if (rig.pose === 'point') {
      // Aim from her shoulders at the permission card.
      const card = chat.root.querySelector('.perm:not(.answered)') ?? chat.root;
      const box = card.getBoundingClientRect();
      const c = faceCenter();
      rig.pointAt(Math.atan2(box.top + box.height / 2 - (c.y + SIZE.h * 0.08), box.left + box.width / 2 - c.x) / (Math.PI / 180));
    }
    if (wasAsleep && !rig.sleeping) {
      rig.setMood('glitch', 1200);
      say(pick(QUIPS.wake), 2200);
    }
  }

  // Anything you do keeps her up (and wakes her).
  function touch() {
    state.lastActivity = performance.now();
  }

  // ---- overlays ----------------------------------------------------------

  function say(text, ms = 3200) {
    if (chat.isOpen) return;
    bubble.textContent = text;
    bubble.hidden = false;
    bubble.classList.remove('glitch-in');
    void bubble.offsetWidth;
    bubble.classList.add('glitch-in');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(hideBubble, ms);
    positionBubble();
  }

  function hideBubble() {
    clearTimeout(bubbleTimer);
    bubble.hidden = true;
  }

  function positionBubble() {
    const w = bubble.offsetWidth;
    const h = bubble.offsetHeight;
    const x = clamp(state.pos.x + SIZE.w / 2 - w / 2, 8, innerWidth - w - 8);
    let y = state.pos.y - h + 4;
    if (y < 8) y = state.pos.y + SIZE.h + 4;
    bubble.style.left = `${Math.round(x)}px`;
    bubble.style.top = `${Math.round(y)}px`;
  }

  function syncOverlays() {
    if (chat.isOpen) chat.anchor(state.pos, SIZE);
    if (!bubble.hidden) positionBubble();
    if (!cutin.el.hidden) positionCutIn();
  }

  // Her face in close-up beside her for a couple of seconds. The chat
  // header already shows it while the panel is open.
  function cutIn(mood) {
    if (chat.isOpen) return;
    rig.setMood(mood, CUTIN_MS + 1500);
    clearTimeout(cutin.timer);
    const { el } = cutin;
    el.hidden = false;
    el.classList.remove('glitch-in', 'out');
    void el.offsetWidth;
    el.classList.add('glitch-in');
    positionCutIn();
    cutin.face.mirror(rig, performance.now());
    cutin.timer = setTimeout(() => {
      el.classList.add('out');
      cutin.timer = setTimeout(() => {
        el.hidden = true;
        el.classList.remove('out');
      }, 220);
    }, CUTIN_MS);
  }

  function positionCutIn() {
    const { el } = cutin;
    const face = faceCenter();
    const left = face.x > innerWidth / 2;
    const x = clamp(left ? state.pos.x - el.offsetWidth + SIZE.w * 0.2 : state.pos.x + SIZE.w * 0.8, 8, innerWidth - el.offsetWidth - 8);
    const y = clamp(face.y - el.offsetHeight * 0.9, 8, innerHeight - el.offsetHeight - 8);
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  }

  // ---- mouse: click-through, drag, click, dodge --------------------------

  function setThrough(value) {
    if (value === through) return;
    through = value;
    bridge.setMouseThrough(value);
  }

  function refreshHover() {
    if (drag || mouse.x < 0) return;
    const el = document.elementFromPoint(mouse.x, mouse.y);
    setThrough(!(el && el.closest('.hit')));
  }

  addEventListener('mousemove', (e) => {
    const now = performance.now();
    touch();
    const dt = Math.max(1, now - mouse.t);
    const dist = mouse.x < 0 ? 0 : Math.hypot(e.clientX - mouse.x, e.clientY - mouse.y);
    mouse.speed = mouse.speed * 0.7 + (dist / dt) * 0.3;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.t = now;

    if (drag) {
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) > 5) {
        drag.moved = true;
        rig.setMood('glitch', 1500);
      }
      if (drag.moved) {
        state.pos = clampPos({ x: drag.ox + dx, y: drag.oy + dy });
        place();
        rig.glitch = 0.15;
      }
      return;
    }

    setThrough(!(e.target instanceof Element && e.target.closest('.hit')));

    // Swipe at her fast and she might dodge.
    if (state.wander && !chat.isOpen && !state.moving && !state.acting && now > state.dodgeReadyAt && mouse.speed > 1.6) {
      const c = center();
      if (Math.hypot(e.clientX - c.x, e.clientY - c.y) < 110) {
        state.dodgeReadyAt = now + 5000;
        if (Math.random() < 0.5) {
          say(pick(QUIPS.dodge), 1600);
          act(() => warp(nearbySpot(160, 320, { x: e.clientX, y: e.clientY }), 'hop'));
        } else {
          rig.setMood('mischief', 2000);
        }
      }
    }
  });

  svg.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || state.moving) return;
    e.preventDefault();
    drag = { sx: e.clientX, sy: e.clientY, ox: state.pos.x, oy: state.pos.y, moved: false };
    setThrough(false);
  });

  addEventListener('mouseup', () => {
    if (!drag) return;
    const { moved } = drag;
    drag = null;
    rig.glitch = 0;
    if (moved) {
      say(pick(QUIPS.drop), 1800);
      rig.pulse(0.8, 160);
      const c = center();
      fx.shards(c.x, c.y, 8, 0.6);
      state.nextAction = performance.now() + 6000;
    } else {
      toggleChat();
    }
    refreshHover();
  });

  svg.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    bridge.menu();
  });

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && chat.isOpen) escape(false);
  });

  addEventListener('resize', () => {
    state.pos = clampPos(state.pos);
    place();
  });

  // ---- chat --------------------------------------------------------------

  function openChat() {
    touch();
    const first = !chat.opened;
    hideBubble();
    chat.open();
    if (first) chat.addCapri(pick(QUIPS.hello));
    if (!state.replying) rig.setMood('curious', 3000);
    syncOverlays();
  }

  function closeChat() {
    chat.close();
    state.nextAction = performance.now() + rand(2500, 5000);
    refreshHover();
  }

  function toggleChat() {
    if (chat.isOpen) closeChat();
    else openChat();
  }

  // Esc stops her mid-task, like in the CLI; otherwise it closes the panel.
  async function escape(closeOnly) {
    if (!closeOnly && state.replying && (await bridge.interrupt())) {
      chat.addSys('interrupted. what now?');
      rig.setMood('annoyed', 2500);
      return;
    }
    closeChat();
  }

  function send(text) {
    if (text.startsWith('/')) {
      command(text);
      return;
    }
    // Typing while a permission card waits answers it: no, do this instead.
    const ask = chat.pendingAsk;
    if (ask !== null) {
      chat.addUser(text);
      chat.answer(ask, 'deny', text);
      return;
    }
    chat.addUser(text);
    startWork();
    bridge.chat(text);
  }

  function startWork() {
    touch();
    state.replying = true;
    state.working = 'think';
    rig.thinking = true;
    chat.setStatus('busy');
  }

  const LOCAL_HELP = [
    '/new fresh conversation · /stop stop working · /resume pick up my last session here',
    '/cd <folder> where i work · /mode default|acceptEdits|plan|auto · /model auto|<name>',
    '/hooks on|off hear from your other claude code sessions · /quiet toggle my commentary',
    '/pose [name] strike a pose · /warp · esc stop or close · ctrl+shift+space summon',
    'any other /command goes to claude code',
  ].join('\n');

  async function command(text) {
    const [, name = '', arg = ''] = text.match(/^\/(\S*)\s*([\s\S]*)$/) ?? [];
    const lower = name.toLowerCase();
    if (lower === 'help') {
      chat.addSys(LOCAL_HELP);
    } else if (lower === 'new' || lower === 'reset' || lower === 'clear') {
      bridge.reset();
    } else if (lower === 'stop') {
      escape(false);
    } else if (lower === 'warp') {
      act(() => warp(randomSpot(), 'big'));
    } else if (lower === 'pose') {
      const pose = arg.trim().toLowerCase();
      if (rig.poses.includes(pose)) {
        touch();
        strikePose(pose, 60000);
      } else {
        chat.addSys(`poses: ${rig.poses.join(' · ')} (i hold one for a minute)`);
      }
    } else if (['cd', 'pwd', 'mode', 'model', 'resume', 'hooks', 'quiet', 'commands'].includes(lower)) {
      chat.addUser(text);
      const result = await bridge.command(lower, arg);
      if (result.error) {
        chat.addSys(result.error);
        rig.setMood('annoyed', 2000);
      } else {
        chat.addSys(result.text);
      }
    } else {
      // Claude Code's own slash commands, skills and custom commands.
      chat.addUser(text);
      startWork();
      bridge.chat(text);
    }
  }

  // The reply bubble currently streaming, if any. Each message between tool
  // calls gets its own bubble.
  function closeReply() {
    if (reply) reply.finish();
    reply = null;
  }

  function endWork() {
    closeReply();
    state.replying = false;
    rig.thinking = false;
    chat.setStatus(chat.pendingAsk !== null ? 'ask' : 'ok');
  }

  bridge.on('agent:text', (delta) => {
    if (!reply) reply = chat.beginReply((mood) => rig.setMood(mood, 9000));
    rig.thinking = false;
    reply.push(delta);
  });

  bridge.on('agent:tool', (tool) => {
    closeReply();
    chat.addTool(tool);
    state.working = 'hack';
    rig.thinking = true;
    chat.setStatus('work');
  });

  bridge.on('agent:tool-done', (result) => {
    chat.toolDone(result);
    if (result.error) rig.pulse(0.5, 120);
  });

  bridge.on('agent:permission', (p) => {
    closeReply();
    chat.addPermission(p);
    chat.setStatus('ask');
    rig.setMood('curious', 8000);
    rig.pulse(0.7, 160);
    if (!chat.isOpen) {
      say(`${pick(QUIPS.ask)} ${p.summary}`, 9000);
      cutIn('curious');
    }
  });

  bridge.on('agent:permission-closed', ({ id }) => {
    chat.closePermission(id);
    if (state.replying) chat.setStatus('work');
  });

  bridge.on('agent:busy', (busy) => {
    if (busy && !state.replying) startWork();
  });

  bridge.on('agent:done', (result) => {
    endWork();
    if (result.interrupted) return;
    if (!result.ok) {
      chat.addSys(result.subtype === 'error_max_turns' ? 'hit the turn limit. say "continue" and i keep going.' : `that run broke: ${result.text || result.subtype}`);
      rig.setMood('annoyed', 5000);
      return;
    }
    // Long jobs get a sign-off line in the log, and a shout if you looked away.
    if (result.ms > 15000) chat.addSys(`✓ done · ${formatTime(result.ms)}${result.turns > 1 ? ` · ${result.turns} turns` : ''}`);
    if (result.ms > 15000) strikePose('victory', 2800);
    if (!chat.isOpen) {
      say(result.ms > 15000 ? pick(QUIPS.done) : pick(QUIPS.waiting), 5000);
      if (result.ms > 15000) celebrate();
    }
  });

  bridge.on('agent:error', (err) => {
    if (reply) chat.failReply(reply);
    endWork();
    const text = ERRORS[err.kind] ?? `${ERRORS.engine} [${err.message}]`;
    chat.addSys(text);
    rig.setMood('annoyed', 6000);
    rig.pulse(0.9, 200);
    if (!chat.isOpen) say(text, 5000);
  });

  bridge.on('agent:warn', (warn) => {
    chat.addSys(ERRORS[warn.kind] ?? `upstream says: ${warn.message || warn.kind}`);
    rig.setMood('annoyed', 4000);
  });

  bridge.on('agent:ready', (info) => chat.setInfo({ ...state.info, model: info.model }));
  bridge.on('agent:info', (info) => {
    state.info = info;
    chat.setInfo(info);
  });
  bridge.on('agent:mode', () => {});
  // She called in the big brain (or went back to the fast one).
  bridge.on('agent:route', (r) => {
    if (r.tier !== 'deep') return;
    // What she says after the hand-off goes in a new bubble.
    closeReply();
    chat.addSys(`↑ ${shortModel(r.model)} takes this one · ${r.reason}`);
    rig.setMood('glitch', 900);
    rig.pulse(0.6, 160);
  });

  bridge.on('activity', touch);

  // Other Claude Code sessions, and her own commentary.
  bridge.on('notice', (n) => {
    if (n.mood) rig.setMood(n.mood, 6000);
    if (chat.isOpen) {
      chat.addNotice(n);
    } else {
      say(n.project && n.kind !== 'quip' ? `[${n.project}] ${n.text}` : n.text, n.kind === 'quip' ? 4500 : 7000);
    }
    if (n.kind === 'done') celebrate();
    else if (n.kind === 'attention') {
      touch();
      strikePose('crouch', 1800);
      cutIn('curious');
      act(() => warp(nearbySpot(60, 140), 'hop'));
    } else rig.pulse(0.5, 140);
  });

  function celebrate() {
    touch();
    rig.setMood('hype', 4000);
    strikePose('victory', 2800);
    cutIn('hype');
    rig.pulse(1, 260);
    const c = center();
    fx.shards(c.x, c.y - SIZE.h * 0.2, 14, 1);
  }

  bridge.on('summon', (cursor) => summon(cursor));
  bridge.on('warp', () => act(() => warp(randomSpot(), 'big')));
  bridge.on('wander', (on) => {
    state.wander = on;
    say(on ? 'free roam: ON' : "ok ok, i'll sit still.", 1800);
  });
  bridge.on('reset', ({ project } = {}) => {
    endWork();
    chat.clear();
    chat.addCapri(project ? `jacked into ${project}. new folder, new mess. what are we doing?` : pick(QUIPS.reset));
    rig.setMood('glitch', 1500);
    rig.pulse(1, 250);
  });

  function formatTime(ms) {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }

  // ---- main loop ---------------------------------------------------------

  let last = performance.now();
  let lastPos = { ...state.pos };
  let mirrored = 0;
  function loop(now) {
    const dt = Math.min(64, now - last);
    last = now;
    // Her hair trails when she's dragged or hops; a warp's jump doesn't count.
    const step = Math.hypot(state.pos.x - lastPos.x, state.pos.y - lastPos.y);
    const v = dt > 0 && step < 120 ? 1000 / dt : 0;
    rig.drift((state.pos.x - lastPos.x) * v, (state.pos.y - lastPos.y) * v);
    lastPos = { ...state.pos };
    updateGaze(now);
    rig.talking = chat.typing;
    updatePose(now);
    rig.tick(now);
    // The close-ups copy her face whenever the rig steps a frame.
    if (rig.lastStep !== mirrored) {
      mirrored = rig.lastStep;
      if (chat.isOpen) avatar.mirror(rig, now);
      if (!cutin.el.hidden) cutin.face.mirror(rig, now);
    }
    fx.frame(dt);
    chat.step();
    syncOverlays();
    behave(now);
    requestAnimationFrame(loop);
  }

  bridge.status().then((info) => {
    state.info = info;
    chat.setInfo(info);
    state.wander = info.wandering;
  });
  squash(1, 1);
  act(arrive);
  requestAnimationFrame(loop);
})();
