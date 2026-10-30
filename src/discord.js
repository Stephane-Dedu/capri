// Capri in your Discord voice channel: your own bot (from the Discord
// developer portal) follows you into voice and says her lines there, in her
// voice (voice.js) through the same glitch as on the desktop. She only
// talks: she joins deafened and never hears the channel. Needs the bot's
// token and your Discord user id in .env (DISCORD_BOT_TOKEN,
// DISCORD_USER_ID), and /discord on (or the tray).

const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const voice = require('./voice');

const RATE = 48000; // what Discord wants: 48 kHz, stereo, 16-bit
const STALE_MS = 20000; // a line that waited longer than this isn't worth saying
// Her glitch, as on the page (renderer/sound.js and worklets.js).
const CRUSH = { bits: 6, hold: 3, mix: 0.8 };
const HIGHPASS = 170;
const LOWPASS = 5400;

class Discord extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.dv = null; // @discordjs/voice
    this.connection = null;
    this.player = null;
    this.channel = null;
    this.queue = [];
    this.speaking = false;
    this.status = 'off';
  }

  get configured() {
    return Boolean(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_USER_ID);
  }

  get connected() {
    return Boolean(this.connection && this.channel);
  }

  setStatus(status) {
    this.status = status;
    this.emit('change');
  }

  // Logs the bot in and joins your voice channel, now and whenever you move.
  async start() {
    if (this.client) return;
    if (!this.configured) {
      this.setStatus('needs DISCORD_BOT_TOKEN and DISCORD_USER_ID in .env');
      return;
    }
    let djs;
    try {
      djs = require('discord.js');
      this.dv = require('@discordjs/voice');
    } catch {
      this.setStatus('the Discord libraries are missing (npm install)');
      return;
    }
    const me = process.env.DISCORD_USER_ID;
    const client = new djs.Client({ intents: [djs.GatewayIntentBits.Guilds, djs.GatewayIntentBits.GuildVoiceStates] });
    this.client = client;
    client.on(djs.Events.VoiceStateUpdate, (_before, after) => {
      if (after.id === me) this.follow(after.channel);
    });
    client.once(djs.Events.ClientReady, () => {
      const here = client.guilds.cache.map((guild) => guild.voiceStates.cache.get(me)?.channel).find(Boolean);
      this.setStatus(here ? 'joining' : 'waiting for you in a voice channel');
      this.follow(here ?? null);
    });
    client.on(djs.Events.Error, (err) => this.emit('warn', err.message));
    try {
      this.setStatus('connecting');
      await client.login(process.env.DISCORD_BOT_TOKEN);
    } catch (err) {
      this.client = null;
      client.destroy();
      this.setStatus(`couldn't log in: ${err.message}`);
    }
  }

  async stop() {
    this.leave();
    this.queue = [];
    await this.client?.destroy();
    this.client = null;
    this.setStatus('off');
  }

  // You joined, moved or left: she does the same.
  follow(channel) {
    if (!channel) {
      if (this.connection) this.leave();
      if (this.client) this.setStatus('waiting for you in a voice channel');
      return;
    }
    if (this.channel?.id === channel.id && this.connection) return;
    const { joinVoiceChannel, createAudioPlayer, NoSubscriberBehavior } = this.dv;
    this.connection?.destroy();
    this.connection = joinVoiceChannel({ channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: true, selfMute: false });
    this.player ??= createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.connection.subscribe(this.player);
    this.channel = channel;
    this.setStatus(`in ${channel.name}`);
  }

  leave() {
    this.connection?.destroy();
    this.connection = null;
    this.channel = null;
  }

  // Queues a line; false when she isn't in a channel to say it.
  say(text) {
    if (!this.connected) return false;
    this.queue.push({ text: String(text), at: Date.now() });
    this.drain();
    return true;
  }

  async drain() {
    if (this.speaking) return;
    this.speaking = true;
    try {
      while (this.queue.length) {
        const line = this.queue.shift();
        if (Date.now() - line.at > STALE_MS) continue;
        await this.play(line.text).catch((err) => this.emit('warn', err.message));
      }
    } finally {
      this.speaking = false;
    }
  }

  async play(text) {
    const wav = await voice.synth(text);
    if (!wav || !this.connected) return;
    const { createAudioResource, StreamType, entersState, AudioPlayerStatus } = this.dv;
    this.player.play(createAudioResource(Readable.from([toDiscord(wav)]), { inputType: StreamType.Raw }));
    await entersState(this.player, AudioPlayerStatus.Playing, 5000).catch(() => {});
    await entersState(this.player, AudioPlayerStatus.Idle, 60000).catch(() => {});
  }

  describe() {
    return `discord: ${this.status}`;
  }
}

// ---- her voice, for Discord ---------------------------------------------------

// A 16-bit WAV (any rate, mono or stereo) as Discord PCM through her glitch:
// 48 kHz, stereo, 16-bit little-endian.
function toDiscord(wav) {
  const { rate, channels, data } = readWav(wav);
  const frames = Math.floor(data.length / (2 * channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let v = 0;
    for (let c = 0; c < channels; c++) v += data.readInt16LE((i * channels + c) * 2);
    mono[i] = v / channels / 32768;
  }
  let out = glitch(resample(mono, rate, RATE), RATE);
  out = biquad(out, RATE, 'highpass', HIGHPASS);
  out = biquad(out, RATE, 'lowpass', LOWPASS);
  const pcm = Buffer.alloc(out.length * 4);
  for (let i = 0; i < out.length; i++) {
    const s = Math.max(-32768, Math.min(32767, Math.round(out[i] * 32767)));
    pcm.writeInt16LE(s, i * 4);
    pcm.writeInt16LE(s, i * 4 + 2);
  }
  return pcm;
}

function readWav(buf) {
  let rate = 22050;
  let channels = 1;
  let data = null;
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(at + 10);
      rate = buf.readUInt32LE(at + 12);
    } else if (id === 'data') {
      data = buf.subarray(at + 8, Math.min(buf.length, at + 8 + size));
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (!data) throw new Error('not a WAV');
  return { rate, channels, data };
}

// Linear resampling.
function resample(input, from, to) {
  if (from === to) return input;
  const out = new Float32Array(Math.floor((input.length * to) / from));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const t = x - j;
    out[i] = (input[j] ?? 0) * (1 - t) + (input[j + 1] ?? input[j] ?? 0) * t;
  }
  return out;
}

// The page's 'crush' worklet: fewer bits, each sample held a few times, and
// now and then a burst that crunches harder.
function glitch(input, rate) {
  const out = new Float32Array(input.length);
  let held = 0;
  let burst = 0;
  let untilBurst = rate * (1 + Math.random() * 2);
  for (let i = 0; i < input.length; i++) {
    if (--untilBurst <= 0) {
      burst = Math.round(rate * (0.04 + Math.random() * 0.06));
      untilBurst = rate * (1.5 + Math.random() * 3);
    }
    const bursting = burst > 0;
    if (bursting) burst--;
    const hold = bursting ? CRUSH.hold * 3 : CRUSH.hold;
    const levels = 2 ** ((bursting ? 3 : CRUSH.bits) - 1);
    if (i % hold === 0) held = Math.round(input[i] * levels) / levels;
    out[i] = held * CRUSH.mix + input[i] * (1 - CRUSH.mix);
  }
  return out;
}

// A Web Audio-style biquad filter (Q 1, as BiquadFilterNode's default).
function biquad(input, rate, type, freq, q = 1) {
  const w = (2 * Math.PI * freq) / rate;
  const alpha = Math.sin(w) / (2 * q);
  const cos = Math.cos(w);
  const [b0, b1, b2] = type === 'lowpass' ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return out;
}

module.exports = { Discord, toDiscord, readWav };
