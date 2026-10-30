// Her voice, from one of three engines (/voice):
// - kokoro: a local voice you design by blending Kokoro's preset voices
//   ("bella 60 + sky 40") at a speed. Runs on your machine, free; English only
//   (its phonemizer is), so French lines go to the next engine.
// - elevenlabs: an ElevenLabs voice (ELEVENLABS_API_KEY and
//   ELEVENLABS_VOICE_ID in .env).
// - system: the OS speech synthesizer (macOS `say`, Windows SAPI through
//   PowerShell), French or English depending on the text.
// Each falls back to the next. Either way a WAV; the page (and discord.js)
// plays it through a bitcrusher, so it sounds like her.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const VOICES = {
  darwin: { en: process.env.CAPRI_VOICE_EN || 'Samantha', fr: process.env.CAPRI_VOICE_FR || 'Amélie' },
  win32: { en: 'en-US', fr: 'fr-FR' },
};
const RATE = Number(process.env.CAPRI_VOICE_RATE) || 205; // words per minute (macOS)
const MAX_CHARS = 600;
// ElevenLabs: raw 24 kHz PCM, wrapped as a WAV. Flash is their fastest model
// and speaks French and English.
const ELEVEN_RATE = 24000;
const ELEVEN_MODEL = process.env.CAPRI_ELEVENLABS_MODEL || 'eleven_flash_v2_5';
const ELEVEN_BASE = process.env.CAPRI_ELEVENLABS_BASE || 'https://api.elevenlabs.io';
// She repeats herself ("queue popped…"): recent lines are kept, by text and voice.
const CACHE = 60;
const cache = new Map();
// Kokoro: the 82M model in its 8-bit version (~90 MB, downloaded once).
const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_RATE = 24000;
const ENGINES = ['kokoro', 'elevenlabs', 'system'];
// What each engine falls back to, in order (the system voice is always last).
const FALLBACKS = { kokoro: ['kokoro', 'elevenlabs'], elevenlabs: ['elevenlabs'], system: [] };

const elevenReady = () => Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
let settings = { engine: elevenReady() ? 'elevenlabs' : 'system', blend: 'bella', speed: 1 };

// Her voice settings (main.js keeps them in her config): { engine, blend, speed }.
function configure(next = {}) {
  settings = { ...settings, ...Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== null)) };
  if (!ENGINES.includes(settings.engine)) settings.engine = 'system';
  return settings;
}

// What's worth saying out loud from a chat reply: no code, links, markdown
// or stage directions, and only the first few sentences of a long one.
function speakable(text) {
  let t = String(text ?? '')
    .replace(/\[\[\w+\]\]/g, '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\*[^*\n]{1,40}\*/g, '')
    .replace(/[*_#>|~]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > MAX_CHARS) {
    let out = '';
    for (const sentence of t.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [t]) {
      if (out && (out + sentence).length > MAX_CHARS) break;
      out += sentence;
    }
    t = out.slice(0, MAX_CHARS).trim();
  }
  return t;
}

const FRENCH = /\b(je|tu|il|elle|on|nous|vous|le|la|les|des|une|est|sont|pas|que|qui|pour|avec|dans|sur|ça|c'est|j'ai|mais|donc|aussi|très|fait|faire)\b/gi;
const ENGLISH = /\b(i|you|he|she|it|we|they|the|a|an|is|are|not|that|which|for|with|in|on|this|but|so|also|very|did|do)\b/gi;

function language(text) {
  const fr = (text.match(FRENCH) ?? []).length + (text.match(/[éèêàùçôîœ]/gi) ?? []).length * 0.5;
  const en = (text.match(ENGLISH) ?? []).length;
  return fr > en ? 'fr' : 'en';
}

// A WAV buffer of her saying `text`, or null when there's nothing to say or
// no synthesizer.
async function synth(text) {
  const words = speakable(text);
  if (!words) return null;
  const key = `${settings.engine}|${settings.blend}|${settings.speed}|${words}`;
  if (cache.has(key)) return cache.get(key);
  const english = language(words) === 'en';
  const engines = { kokoro: kokoroSay, elevenlabs: eleven };
  let wav = null;
  for (const engine of FALLBACKS[settings.engine] ?? []) {
    if (engine !== 'elevenlabs' && !english) continue; // the local voices speak English
    if (engine === 'elevenlabs' && !elevenReady()) continue;
    wav = await engines[engine](words).catch((err) => {
      // Not her voice for this line, but still a voice.
      console.warn(`[capri] ${engine}: ${err.message}; falling back`);
      return null;
    });
    if (wav) break;
  }
  wav ??= await system(words);
  if (wav) {
    cache.set(key, wav);
    if (cache.size > CACHE) cache.delete(cache.keys().next().value);
  }
  return wav;
}

// ---- Kokoro ---------------------------------------------------------------------

let kokoro = null; // Promise of { tts, Tensor, RawAudio }

// The model, loaded once (and downloaded the first time, into her data folder).
function prepare() {
  kokoro ??= (async () => {
    const transformers = require('@huggingface/transformers');
    try {
      transformers.env.cacheDir = path.join(require('electron').app.getPath('userData'), 'models');
    } catch {
      // Not in Electron (tests): the library's own cache.
    }
    const { KokoroTTS } = require('kokoro-js');
    const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: 'q8', device: 'cpu' });
    return { tts, Tensor: transformers.Tensor, RawAudio: transformers.RawAudio };
  })().catch((err) => {
    kokoro = null;
    throw err;
  });
  return kokoro;
}

function voicesDir() {
  return path.join(path.dirname(require.resolve('kokoro-js')), '..', 'voices');
}

// The English presets (Kokoro's JS phonemizer is English only).
function kokoroVoices() {
  try {
    return fs.readdirSync(voicesDir()).map((f) => f.replace(/\.bin$/, '')).filter((v) => /^[ab][fm]_/.test(v)).sort();
  } catch {
    return [];
  }
}

// "bella 60 + sky 40", "af_bella*0.6 + af_sky*0.4", "bella + sky" ->
// [{ voice, weight }], weights adding up to 1.
function parseBlend(text) {
  const names = kokoroVoices();
  const parts = String(text ?? '').split('+').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) throw new Error('which voices? e.g. "bella 60 + sky 40"');
  const out = parts.map((part) => {
    const m = part.match(/^([a-z_]+)\s*(?:[*x]\s*)?([\d.]+)?\s*%?$/i);
    if (!m) throw new Error(`can't read "${part}"`);
    const want = m[1].toLowerCase();
    const voice = names.find((n) => n === want) ?? names.find((n) => n.split('_')[1] === want);
    if (!voice) throw new Error(`no Kokoro voice "${m[1]}" (/voice voices lists them)`);
    let weight = m[2] ? Number(m[2]) : 1;
    if (weight > 1) weight /= 100;
    return { voice, weight };
  });
  const sum = out.reduce((total, x) => total + x.weight, 0) || 1;
  return out.map((x) => ({ ...x, weight: x.weight / sum }));
}

// "bella 60 + sky 40", the way she says it back.
function blendName(text) {
  const parts = parseBlend(text);
  return parts.length === 1 ? parts[0].voice.split('_')[1] : parts.map((x) => `${x.voice.split('_')[1]} ${Math.round(x.weight * 100)}`).join(' + ');
}

// A blend's style: the presets' style vectors, weighted.
const styles = new Map();
function styleOf(parts) {
  const key = parts.map((x) => `${x.voice}*${x.weight}`).join('+');
  if (styles.has(key)) return styles.get(key);
  let out = null;
  for (const { voice, weight } of parts) {
    const raw = fs.readFileSync(path.join(voicesDir(), `${voice}.bin`));
    const vec = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    out ??= new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] += vec[i] * weight;
  }
  styles.set(key, out);
  return out;
}

// Her line in the current blend, sentence by sentence (the model takes ~500
// phonemes at a time), as a 24 kHz WAV.
async function kokoroSay(words) {
  const { tts, Tensor, RawAudio } = await prepare();
  const parts = parseBlend(settings.blend);
  const style = styleOf(parts);
  // Kokoro's own text handling, with the blended style instead of one preset's.
  const speaker = Object.create(tts);
  speaker.generate_from_ids = async (ids, { speed }) => {
    const at = 256 * Math.min(Math.max(ids.dims.at(-1) - 2, 0), 509);
    const { waveform } = await tts.model({
      input_ids: ids,
      style: new Tensor('float32', style.slice(at, at + 256), [1, 256]),
      speed: new Tensor('float32', [speed], [1]),
    });
    return new RawAudio(waveform.data, KOKORO_RATE);
  };
  const chunks = [];
  for (const sentence of words.match(/[^.!?]+[.!?]*/g) ?? [words]) {
    if (!sentence.trim()) continue;
    const audio = await speaker.generate(sentence.trim(), { voice: parts[0].voice, speed: Number(settings.speed) || 1 });
    chunks.push(audio.audio, new Float32Array(Math.round(0.12 * KOKORO_RATE)));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const pcm = Buffer.alloc(total * 2);
  let at = 0;
  for (const chunk of chunks) {
    for (const v of chunk) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), (at++) * 2);
  }
  return wavOf(pcm, KOKORO_RATE);
}

async function eleven(words) {
  const res = await fetch(`${ELEVEN_BASE}/v1/text-to-speech/${encodeURIComponent(process.env.ELEVENLABS_VOICE_ID)}?output_format=pcm_${ELEVEN_RATE}`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: words, model_id: ELEVEN_MODEL }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return wavOf(Buffer.from(await res.arrayBuffer()), ELEVEN_RATE);
}

// 16-bit mono PCM with a WAV header.
function wavOf(pcm, rate) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

async function system(words) {
  const voices = VOICES[process.platform];
  if (!voices) return null;
  const lang = language(words);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-say-'));
  const input = path.join(dir, 'in.txt');
  const output = path.join(dir, 'out.wav');
  try {
    fs.writeFileSync(input, words);
    if (process.platform === 'darwin') {
      await run('say', ['-v', voices[lang], '-r', String(RATE), '-f', input, '-o', output, '--file-format=WAVE', '--data-format=LEI16@22050']);
    } else {
      const ps = [
        'Add-Type -AssemblyName System.Speech',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        `try { $s.SelectVoiceByHints('Female', 'Adult', 0, [Globalization.CultureInfo]'${voices[lang]}') } catch {}`,
        `$s.SetOutputToWaveFile('${output}')`,
        `$s.Speak([IO.File]::ReadAllText('${input}'))`,
        '$s.Dispose()',
      ].join('; ');
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    }
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = { synth, speakable, language, wavOf, configure, settings: () => ({ ...settings }), prepare, kokoroVoices, parseBlend, blendName, ENGINES };
