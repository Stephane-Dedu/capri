// Local speech-to-text: whisper.cpp's whisper-server, started once with the
// model in memory and fed short WAV clips over HTTP on 127.0.0.1. Nothing
// leaves the machine. Its built-in Silero VAD drops silence and noise, which
// is where Whisper otherwise makes things up.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { EventEmitter } = require('node:events');

const PORT = Number(process.env.CAPRI_WHISPER_PORT) || 47915;
const MODEL = process.env.CAPRI_WHISPER_MODEL || 'large-v3-turbo-q5_0';
const MODELS = {
  whisper: { file: `ggml-${MODEL}.bin`, url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODEL}.bin` },
  vad: { file: 'ggml-silero-v5.1.2.bin', url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin' },
};
const RATE = 16000;

class Whisper extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.child = null;
    this.starting = null;
    this.queue = Promise.resolve();
  }

  // Text for 16 kHz mono samples, or '' for silence. Clips go one at a time.
  transcribe(samples) {
    const run = this.queue.then(() => this.post(samples));
    this.queue = run.catch(() => {});
    return run;
  }

  async post(samples) {
    await this.start();
    const form = new FormData();
    form.append('file', new Blob([wav(samples)], { type: 'audio/wav' }), 'clip.wav');
    form.append('response_format', 'json');
    const res = await fetch(`http://127.0.0.1:${PORT}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`whisper-server: HTTP ${res.status}`);
    return clean((await res.json()).text);
  }

  start() {
    this.starting ??= this.boot().catch((err) => {
      this.starting = null;
      throw err;
    });
    return this.starting;
  }

  async boot() {
    const bin = findServer();
    if (!bin) throw new Error('whisper-server not found: install whisper.cpp (brew install whisper.cpp)');
    const model = await this.ensure(MODELS.whisper);
    const vad = await this.ensure(MODELS.vad);
    this.child = spawn(bin, ['-m', model, '--host', '127.0.0.1', '--port', String(PORT), '-l', 'auto', '--prompt', 'Capri.', '--vad', '-vm', vad, '-sns', '-nt', '-t', '6'], {
      stdio: ['ignore', 'ignore', process.env.CAPRI_DEBUG ? 'inherit' : 'ignore'],
    });
    this.child.on('exit', () => {
      this.child = null;
      this.starting = null;
    });
    for (let i = 0; i < 240; i++) {
      if (!this.child) throw new Error('whisper-server exited on startup');
      try {
        await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(500) });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error('whisper-server did not start');
  }

  // The model file, downloaded on first use.
  async ensure({ file, url }) {
    const target = path.join(this.dir, file);
    if (fs.existsSync(target)) return target;
    fs.mkdirSync(this.dir, { recursive: true });
    this.emit('status', `downloading ${file}…`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`couldn't download ${file}: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(`${target}.part`));
    fs.renameSync(`${target}.part`, target);
    this.emit('status', `${file} ready.`);
    return target;
  }

  stop() {
    this.child?.kill();
    this.child = null;
    this.starting = null;
  }
}

function findServer() {
  const name = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH ?? '').split(path.delimiter)]) {
    if (dir && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' }).split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

// What Whisper says over silence, music or noise, in the languages it likes
// to hallucinate in.
const NOISE = /^[\s.,!?…-]*(thank you|thanks for watching|thank you for watching|you|bye|merci|merci d'avoir regardé|sous-titr\w*.*|.*amara\.org.*|\[[^\]]*\]|\([^)]*\)|♪+|\*[^*]*\*)?[\s.,!?…-]*$/i;

function clean(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return NOISE.test(t) ? '' : t;
}

// 16-bit PCM WAV, mono, 16 kHz.
function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

module.exports = { Whisper, RATE, clean };
