// Audio worklets. 'tap' turns a live input into 16 kHz mono frames for her
// ears (the transcript, the wake word, push-to-talk). 'crush' is her voice:
// fewer bits, a lower sample rate held step by step, and now and then a
// burst that crunches harder, like her glitch tear.

const OUT_RATE = 16000;
const FRAME = 1600; // 100 ms

class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / OUT_RATE;
    this.pos = 0; // input samples seen
    this.next = 0; // input position of the next output sample
    this.last = 0;
    this.frame = new Float32Array(FRAME);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input?.length) return true;
    const channels = input.length;
    const len = input[0].length;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < channels; c++) v += input[c][i];
      v /= channels;
      // Linear resampling between the previous sample and this one.
      while (this.next <= this.pos) {
        const t = this.next - (this.pos - 1);
        this.frame[this.n++] = this.last + (v - this.last) * t;
        if (this.n === FRAME) {
          const full = this.frame;
          this.frame = new Float32Array(FRAME);
          this.n = 0;
          this.port.postMessage(full, [full.buffer]);
        }
        this.next += this.step;
      }
      this.last = v;
      this.pos++;
    }
    return true;
  }
}

class Crush extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { bits = 6, hold = 3, mix = 0.8 } = options.processorOptions ?? {};
    this.bits = bits;
    this.hold = hold;
    this.mix = mix;
    this.count = 0;
    this.held = 0;
    this.burst = 0; // samples left in a harder-crushed burst
    this.untilBurst = sampleRate * (1 + Math.random() * 2);
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const out = outputs[0];
    if (!input) return false; // the voice line ended
    for (let i = 0; i < input.length; i++) {
      if (--this.untilBurst <= 0) {
        this.burst = Math.round(sampleRate * (0.04 + Math.random() * 0.06));
        this.untilBurst = sampleRate * (1.5 + Math.random() * 3);
      }
      const bursting = this.burst > 0;
      if (bursting) this.burst--;
      const hold = bursting ? this.hold * 3 : this.hold;
      const levels = 2 ** ((bursting ? 3 : this.bits) - 1);
      if (this.count++ % hold === 0) this.held = Math.round(input[i] * levels) / levels;
      const v = this.held * this.mix + input[i] * (1 - this.mix);
      for (const channel of out) channel[i] = v;
    }
    return true;
  }
}

registerProcessor('tap', Tap);
registerProcessor('crush', Crush);
