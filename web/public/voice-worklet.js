// Signalbox voice mode: microphone audio to 16 kHz, 16-bit mono frames of 0.1 s.
//
// Runs on the audio thread (AudioWorklet). Each block is low-pass filtered so
// nothing above what 16 kHz can hold folds back in, resampled by linear
// interpolation, and handed to the page as raw little-endian PCM. The page
// sends the frames to Signalbox; nothing is kept here. "flush" hands over the
// last partial frame. About every 50 ms it also reports the input level.

const TARGET_RATE = 16000;
const FRAME = 1600; // samples per frame: 0.1 s

class SignalboxMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE; // input samples per output sample
    this.pos = 0; // next output's position in the current block (-1 = last block's final sample)
    this.prev = 0;
    this.out = new Int16Array(FRAME);
    this.n = 0;
    this.filtered = new Float32Array(128);
    this.levelSum = 0;
    this.levelCount = 0;
    this.levelEvery = Math.round(sampleRate / 20);
    // Second-order Butterworth low-pass at 7 kHz.
    const w0 = (2 * Math.PI * Math.min(7000, sampleRate * 0.45)) / sampleRate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / Math.SQRT2;
    const a0 = 1 + alpha;
    this.b0 = (1 - cos) / 2 / a0;
    this.b1 = (1 - cos) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
    this.port.onmessage = (event) => {
      if (event.data === 'flush') this.flush();
    };
  }

  send(count) {
    const pcm = this.out.slice(0, count).buffer;
    this.port.postMessage({ pcm }, [pcm]);
    this.n = 0;
  }

  flush() {
    if (this.n > 0) this.send(this.n);
    this.port.postMessage({ flushed: true });
  }

  push(sample) {
    const v = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    if (this.n === FRAME) this.send(FRAME);
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;
    const length = channel.length;
    if (this.filtered.length !== length) this.filtered = new Float32Array(length);
    const f = this.filtered;
    for (let i = 0; i < length; i++) {
      const x = channel[i];
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1;
      this.x1 = x;
      this.y2 = this.y1;
      this.y1 = y;
      f[i] = y;
      this.levelSum += x * x;
    }
    this.levelCount += length;
    if (this.levelCount >= this.levelEvery) {
      this.port.postMessage({ level: Math.sqrt(this.levelSum / this.levelCount) });
      this.levelSum = 0;
      this.levelCount = 0;
    }
    let pos = this.pos;
    while (pos < length - 1) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const s0 = i0 >= 0 ? f[i0] : this.prev;
      const s1 = f[i0 + 1];
      this.push(s0 + (s1 - s0) * frac);
      pos += this.step;
    }
    this.pos = pos - length;
    this.prev = f[length - 1];
    return true;
  }
}

registerProcessor('signalbox-mic', SignalboxMic);
