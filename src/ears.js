// What she hears. Audio comes in as 16 kHz mono frames from two sources: the
// mic ('me', captured in the page) and the computer's audio ('call': a
// ScreenCaptureKit helper on macOS, Chromium's loopback on Windows). An
// energy VAD cuts each stream into utterances, Whisper turns them into text,
// and the lines go into the transcript. Push-to-talk borrows the mic: while
// the key is held, mic audio goes to your question instead of the log.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { RATE } = require('./whisper');

const WIN = 480; // 30 ms analysis window
const PRE_ROLL = 14; // windows kept from before speech starts (~0.4 s)
const END_QUIET = 30; // quiet windows that end an utterance (~0.9 s)
const MIN_VOICED = 8; // shortest utterance worth transcribing (~0.25 s of speech: "Capri")
const MAX_SAMPLES = RATE * 25;

class Ears extends EventEmitter {
  constructor({ whisper, transcript, binDir }) {
    super();
    this.whisper = whisper;
    this.transcript = transcript;
    this.listening = false;
    this.wake = false; // listen to the mic for the wake word, even with the log off
    this.onSpeech = null; // (text) => true if it was for her (the wake word), so it stays out of the log
    this.question = null; // mic frames while push-to-talk is held
    this.mutedUntil = 0;
    this.lastCall = 0;
    this.segmenters = {
      me: new Segmenter((samples) => this.heard('me', samples)),
      call: new Segmenter((samples) => this.heard('call', samples)),
    };
    this.dance = false; // follow the computer's audio for music, even with the log off
    this.groove = new Groove();
    this.groove.on('music', (on) => this.emit('music', on));
    this.groove.on('beat', (level) => this.emit('beat', level));
    this.system = process.platform === 'darwin' ? new SystemAudio(binDir) : null;
    this.system?.on('frame', (samples) => this.feed('call', samples));
    this.system?.on('error', (message) => this.emit('warn', `can't hear the computer's audio: ${message}`));
  }

  // The computer's audio is needed for the log and for dancing.
  get systemWanted() {
    return this.listening || this.dance;
  }

  syncSystem() {
    if (this.systemWanted) this.system?.start();
    else this.system?.stop();
    if (!this.dance) this.groove.reset();
  }

  setDance(on) {
    this.dance = on;
    this.syncSystem();
    this.emit('mic');
  }

  // The page needs the mic for the log and for push-to-talk.
  get micWanted() {
    return this.listening || Boolean(this.question);
  }

  // Someone's been talking on the computer lately: probably a call.
  get inCall() {
    return Date.now() - this.lastCall < 90000;
  }

  setListening(on) {
    if (on === this.listening) return;
    this.listening = on;
    this.transcript.mark(on ? 'listening on' : 'listening off');
    for (const s of Object.values(this.segmenters)) s.reset();
    if (on) {
      this.transcript.prune();
      this.whisper.start().catch((err) => this.emit('warn', err.message));
    }
    this.syncSystem();
    this.emit('mic');
  }

  feed(source, samples) {
    if (Date.now() < this.mutedUntil) return; // her own voice
    if (source === 'call' && this.dance) this.groove.push(samples);
    if (source === 'me' && this.question) this.question.push(samples);
    else if (this.listening || (source === 'me' && this.wake)) this.segmenters[source]?.push(samples);
  }

  async heard(source, samples) {
    try {
      const text = await this.whisper.transcribe(samples);
      if (!text) return;
      if (source === 'me' && this.onSpeech?.(text)) return;
      if (!this.listening) return;
      if (source === 'call') this.lastCall = Date.now();
      this.transcript.add(source, text);
    } catch (err) {
      this.emit('warn', err.message);
    }
  }

  // Push-to-talk.
  startQuestion() {
    this.question = [];
    this.segmenters.me.reset();
    this.emit('mic');
  }

  cancelQuestion() {
    this.question = null;
    this.emit('mic');
  }

  async endQuestion() {
    const frames = this.question;
    this.question = null;
    this.emit('mic');
    if (!frames?.length) return '';
    return this.whisper.transcribe(join(frames));
  }

  // While she talks, so her own voice stays out of the log.
  mute(ms) {
    this.mutedUntil = Math.max(this.mutedUntil, Date.now() + ms);
  }

  stop() {
    this.system?.stop();
  }
}

// Music on the computer's audio, for her to dance to: steady sound without
// the pauses speech has, held for a few seconds, and its beats (sudden jumps
// in loudness). Levels only; nothing is transcribed.
class Groove extends EventEmitter {
  constructor() {
    super();
    this.carry = new Float32Array(0);
    this.recent = []; // the last ~4 s of window levels
    this.avg = 0;
    this.sinceBeat = 0;
    this.streak = 0; // windows in a row that agree on music / no music
    this.playing = false;
  }

  push(samples) {
    const buf = join([this.carry, samples]);
    let i = 0;
    for (; i + WIN <= buf.length; i += WIN) this.window(buf.subarray(i, i + WIN));
    this.carry = buf.slice(i);
  }

  window(w) {
    let sum = 0;
    for (const v of w) sum += v * v;
    const rms = Math.sqrt(sum / w.length);
    this.recent.push(rms);
    if (this.recent.length > 133) this.recent.shift();
    const mean = this.recent.reduce((a, b) => a + b, 0) / this.recent.length;
    const quiet = this.recent.filter((v) => v < 0.008).length / this.recent.length;
    const music = this.recent.length > 100 && mean > 0.015 && quiet < 0.05;
    this.streak = music === this.playing ? 0 : this.streak + 1;
    if (this.streak > 100) {
      this.playing = music;
      this.streak = 0;
      this.emit('music', music);
    }
    this.sinceBeat++;
    if (this.playing && rms > this.avg * 1.35 && rms > 0.02 && this.sinceBeat > 9) {
      this.sinceBeat = 0;
      this.emit('beat', Math.min(1, rms * 5));
    }
    this.avg += (rms - this.avg) * 0.1;
  }

  reset() {
    this.recent = [];
    if (this.playing) this.emit('music', false);
    this.playing = false;
    this.streak = 0;
  }
}

// Cuts a stream into utterances: speech starts after a few loud windows and
// ends after ~0.9 s of quiet. "Loud" is relative to a noise floor that drops
// fast in pauses and rises slowly, so fans and room noise don't count.
class Segmenter {
  constructor(onSegment) {
    this.onSegment = onSegment;
    this.floor = 0.004;
    this.carry = new Float32Array(0);
    this.reset();
  }

  reset() {
    this.pre = [];
    this.chunks = [];
    this.length = 0;
    this.voiced = 0;
    this.quiet = 0;
    this.loud = 0;
    this.active = false;
  }

  push(samples) {
    const buf = join([this.carry, samples]);
    let i = 0;
    for (; i + WIN <= buf.length; i += WIN) this.window(buf.slice(i, i + WIN));
    this.carry = buf.slice(i);
  }

  window(w) {
    let sum = 0;
    for (const v of w) sum += v * v;
    const rms = Math.sqrt(sum / w.length);
    const speech = rms > Math.max(0.01, this.floor * 3);
    this.floor += (rms - this.floor) * (rms < this.floor ? 0.05 : 0.002);
    if (!this.active) {
      this.pre.push(w);
      if (this.pre.length > PRE_ROLL) this.pre.shift();
      this.loud = speech ? this.loud + 1 : 0;
      if (this.loud < 3) return;
      this.active = true;
      this.chunks = this.pre;
      this.pre = [];
      this.length = this.chunks.length * WIN;
      this.voiced = this.loud;
      this.quiet = 0;
      return;
    }
    this.chunks.push(w);
    this.length += WIN;
    if (speech) {
      this.voiced++;
      this.quiet = 0;
    } else {
      this.quiet++;
    }
    if (this.quiet >= END_QUIET || this.length >= MAX_SAMPLES) this.cut();
  }

  cut() {
    // Keep ~0.3 s of the trailing quiet.
    const chunks = this.chunks.slice(0, this.chunks.length - Math.max(0, this.quiet - 10));
    const enough = this.voiced >= MIN_VOICED;
    this.reset();
    if (enough) this.onSegment(join(chunks));
  }
}

// The Mac's own audio, through a small Swift helper (tools/capri-ears.swift)
// built on first use with the Xcode command line tools. It writes 16 kHz mono
// float samples to stdout. Needs Screen Recording permission.
class SystemAudio extends EventEmitter {
  constructor(binDir) {
    super();
    this.binDir = binDir;
    this.child = null;
    this.wanted = false;
  }

  async start() {
    this.wanted = true;
    if (this.child) return;
    let bin;
    try {
      bin = await this.build();
    } catch (err) {
      this.emit('error', `couldn't build the audio helper (${err.message.split('\n')[0]}). Is Xcode's command line tools installed?`);
      return;
    }
    if (!this.wanted || this.child) return;
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let rest = Buffer.alloc(0);
    let err = '';
    child.stdout.on('data', (data) => {
      const buf = rest.length ? Buffer.concat([rest, data]) : data;
      const usable = buf.length - (buf.length % 4);
      rest = buf.subarray(usable);
      const copy = Buffer.from(buf.subarray(0, usable));
      this.emit('frame', new Float32Array(copy.buffer, copy.byteOffset, usable / 4));
    });
    child.stderr.on('data', (data) => {
      err = (err + data).slice(-400);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (this.wanted && code) this.emit('error', err.trim().split('\n').pop() || `helper exited (${code})`);
    });
  }

  build() {
    const src = path.join(__dirname, '..', 'tools', 'capri-ears.swift');
    const bin = path.join(this.binDir, 'capri-ears');
    const fresh = (() => {
      try {
        return fs.statSync(bin).mtimeMs >= fs.statSync(src).mtimeMs;
      } catch {
        return false;
      }
    })();
    if (fresh) return Promise.resolve(bin);
    fs.mkdirSync(this.binDir, { recursive: true });
    return new Promise((resolve, reject) => {
      execFile('swiftc', ['-O', '-parse-as-library', src, '-o', bin], { timeout: 180000 }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(bin)));
    });
  }

  stop() {
    this.wanted = false;
    this.child?.kill();
    this.child = null;
  }
}

function join(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

module.exports = { Ears, Segmenter, Groove };
