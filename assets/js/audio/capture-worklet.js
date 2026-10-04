/* Runs on the audio thread. Hands raw float blocks straight to the encoder
 * worker (never through the UI thread) and sends light meter readings to the
 * page roughly every 20 ms. */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options.processorOptions.channels;
    this.block = 2048;
    this.buf = Array.from({ length: this.channels }, () => new Float32Array(this.block));
    this.fill = 0;
    this.out = null;          // MessagePort to the encoder worker
    this.recording = false;
    this.mPeak = new Float32Array(this.channels);
    this.mSq = new Float64Array(this.channels);
    this.mN = 0;
    this.meterEvery = Math.round(sampleRate / 50);
    this.port.onmessage = e => {
      const d = e.data;
      if (d.port) this.out = d.port;
      if (d.cmd === 'record') { this.recording = true; this.fill = 0; }
      if (d.cmd === 'stop') { this._flush(); this.recording = false; if (this.out) this.out.postMessage({ end: true }); }
    };
  }
  _flush() {
    if (!this.out || !this.fill) return;
    const chs = this.buf.map(b => b.slice(0, this.fill));
    this.out.postMessage({ chs }, chs.map(c => c.buffer));
    this.fill = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const n = input[0].length;
    for (let c = 0; c < this.channels; c++) {
      const src = input[Math.min(c, input.length - 1)];
      let pk = this.mPeak[c], sq = this.mSq[c];
      for (let i = 0; i < n; i++) { const v = src[i]; const a = v < 0 ? -v : v; if (a > pk) pk = a; sq += v * v; }
      this.mPeak[c] = pk; this.mSq[c] = sq;
    }
    this.mN += n;
    if (this.mN >= this.meterEvery) {
      this.port.postMessage({ meter: { peak: Array.from(this.mPeak), rms: Array.from(this.mSq, s => Math.sqrt(s / this.mN)) } });
      this.mPeak.fill(0); this.mSq.fill(0); this.mN = 0;
    }
    if (this.recording) {
      let off = 0;
      while (off < n) {
        const take = Math.min(this.block - this.fill, n - off);
        for (let c = 0; c < this.channels; c++) {
          const src = input[Math.min(c, input.length - 1)];
          this.buf[c].set(src.subarray(off, off + take), this.fill);
        }
        this.fill += take; off += take;
        if (this.fill === this.block) {
          const chs = this.buf;
          if (this.out) this.out.postMessage({ chs }, chs.map(c => c.buffer));
          this.buf = Array.from({ length: this.channels }, () => new Float32Array(this.block));
          this.fill = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('ps-capture', CaptureProcessor);
