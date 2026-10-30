// The page's side of her ears and voice. Mic: the microphone (and, on
// Windows, the computer's loopback audio) as 16 kHz frames for the main
// process. Voice: plays what she says through the bitcrusher, and meters it
// so her jaw moves with the words.

window.Capri = window.Capri || {};

(() => {
  let shared = null;

  // One AudioContext for everything, with the worklets loaded.
  async function context() {
    shared ??= (async () => {
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule('worklets.js');
      return ctx;
    })();
    const ctx = await shared;
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  }

  class Mic {
    constructor({ onFrame, onError }) {
      this.onFrame = onFrame;
      this.onError = onError;
      this.inputs = {};
      this.queue = Promise.resolve();
    }

    // { mic, loopback }: which inputs main wants open.
    set({ mic, loopback }) {
      this.queue = this.queue
        .then(() => this.toggle('me', mic, () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })))
        .then(() =>
          this.toggle('call', loopback, async () => {
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            for (const track of stream.getVideoTracks()) track.stop();
            return stream;
          }),
        )
        .catch((err) => this.onError(err));
    }

    async toggle(source, on, open) {
      const current = this.inputs[source];
      if (on && !current) {
        const stream = await open();
        const ctx = await context();
        const node = ctx.createMediaStreamSource(stream);
        // No outputs: Chromium still runs it, since it has a live input.
        const tap = new AudioWorkletNode(ctx, 'tap', { numberOfInputs: 1, numberOfOutputs: 0 });
        tap.port.onmessage = (e) => this.onFrame(source, e.data);
        node.connect(tap);
        this.inputs[source] = { stream, node, tap };
      } else if (!on && current) {
        current.node.disconnect();
        current.tap.port.onmessage = null;
        for (const track of current.stream.getTracks()) track.stop();
        delete this.inputs[source];
      }
    }
  }

  class Voice {
    constructor({ onStart }) {
      this.onStart = onStart;
      this.queue = Promise.resolve();
      this.meter = null;
      this.buf = new Float32Array(512);
    }

    // Queue a WAV (ArrayBuffer) to play after whatever she's saying now.
    play(wav) {
      this.queue = this.queue.then(() => this.playNow(wav)).catch(() => {});
      return this.queue;
    }

    async playNow(wav) {
      const ctx = await context();
      const audio = await ctx.decodeAudioData(wav);
      const source = ctx.createBufferSource();
      source.buffer = audio;
      const crush = new AudioWorkletNode(ctx, 'crush', { outputChannelCount: [1], processorOptions: { bits: 6, hold: 3, mix: 0.8 } });
      const low = ctx.createBiquadFilter();
      low.type = 'highpass';
      low.frequency.value = 170;
      const high = ctx.createBiquadFilter();
      high.type = 'lowpass';
      high.frequency.value = 5400;
      const meter = ctx.createAnalyser();
      meter.fftSize = 512;
      source.connect(crush).connect(low).connect(high).connect(meter).connect(ctx.destination);
      this.meter = meter;
      this.onStart(audio.duration * 1000);
      await new Promise((resolve) => {
        source.onended = resolve;
        source.start();
      });
      this.meter = null;
      for (const node of [source, crush, low, high, meter]) node.disconnect();
    }

    // Two quick raps on your window: filtered clicks, no file needed.
    async knock() {
      const ctx = await context();
      const length = Math.round(ctx.sampleRate * 0.05);
      const rap = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = rap.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (length / 6));
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 1400;
      band.Q.value = 3;
      const gain = ctx.createGain();
      gain.gain.value = 0.7;
      band.connect(gain).connect(ctx.destination);
      this.onStart(500);
      for (const at of [0, 0.16]) {
        const source = ctx.createBufferSource();
        source.buffer = rap;
        source.connect(band);
        source.start(ctx.currentTime + at);
      }
      setTimeout(() => band.disconnect(), 800);
    }

    // How loud she is right now, roughly 0..1.
    get level() {
      if (!this.meter) return 0;
      this.meter.getFloatTimeDomainData(this.buf);
      let sum = 0;
      for (const v of this.buf) sum += v * v;
      return Math.sqrt(sum / this.buf.length);
    }
  }

  window.Capri.Mic = Mic;
  window.Capri.Voice = Voice;
})();
