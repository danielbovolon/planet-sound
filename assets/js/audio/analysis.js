/* Planet Sound — streaming measurement of a take.
 *
 * Fed the same float blocks as the encoder, it keeps only small summaries:
 *  - integrated loudness (ITU-R BS.1770-4 / EBU R128: K-weighting, 400 ms
 *    blocks at 75 % overlap, absolute −70 LUFS and relative −10 LU gates)
 *  - sample peak per channel, clipped-sample count
 *  - a background-level estimate (10th percentile of short blocks), which is
 *    what a field recordist actually wants to know about a location
 *  - a waveform envelope and a log-frequency spectrogram, both bounded in
 *    memory however long the take runs.
 */

/* K-weighting biquads for any sample rate (coefficients as in libebur128) */
function kWeighting(fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const s1 = {
    b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0,
    a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const s2 = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [s1, s2];
}

/* radix-2 complex FFT, in place */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++) {
        const a = i + k, b = a + h;
        const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

const N_FFT = 2048, HOP = 1024, ROWS = 192, MAX_COLS = 6000, ENV_BIN = 256, MAX_ENV = 40000;

export class Analyzer {
  constructor(sampleRate, channels) {
    this.fs = sampleRate; this.ch = channels;
    this.filters = Array.from({ length: channels }, () => kWeighting(sampleRate).map(c => ({ ...c, z1: 0, z2: 0 })));
    this.sub = Math.round(sampleRate * 0.1);       // 100 ms sub-blocks
    this.subFill = 0;
    this.subSum = new Float64Array(channels);
    this.subs = [];                                 // per-100ms channel-summed mean squares
    this.peak = new Float64Array(channels);
    this.clips = 0;
    this.samples = 0;
    // envelope
    this.env = []; this.envMax = 0; this.envFill = 0; this.envMerge = 1; this.envPending = 0; this._envCount = 0;
    // spectrogram
    this.win = new Float32Array(N_FFT);
    for (let i = 0; i < N_FFT; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N_FFT - 1));
    this.ring = new Float32Array(N_FFT); this.ringFill = 0; this.sinceHop = 0;
    this.re = new Float64Array(N_FFT); this.im = new Float64Array(N_FFT);
    this.cols = []; this.colMerge = 1; this.colPending = null; this.colPendingN = 0;
    const fMin = 30, fMax = Math.min(sampleRate / 2, 22000);
    this.fMin = fMin; this.fMax = fMax;
    this.rowBins = [];
    for (let r = 0; r < ROWS; r++) {
      const f0 = fMin * (fMax / fMin) ** (r / ROWS), f1 = fMin * (fMax / fMin) ** ((r + 1) / ROWS);
      const b0 = Math.max(1, Math.floor(f0 * N_FFT / sampleRate));
      const b1 = Math.max(b0, Math.min(N_FFT / 2 - 1, Math.floor(f1 * N_FFT / sampleRate)));
      this.rowBins.push([b0, b1]);
    }
    // Hann window coherent gain is 0.5, so a full-scale sine peaks at N/4.
    this.ref = N_FFT / 4;
  }

  push(chs) {
    const n = chs[0].length, C = this.ch;
    for (let i = 0; i < n; i++) {
      let mono = 0, absMax = 0;
      for (let c = 0; c < C; c++) {
        const x = chs[Math.min(c, chs.length - 1)][i];
        const a = x < 0 ? -x : x;
        if (a > this.peak[c]) this.peak[c] = a;
        if (a > absMax) absMax = a;
        if (a >= 0.9999) this.clips++;
        mono += x;
        // K-weighting, two cascaded biquads (transposed direct form II)
        const f = this.filters[c];
        let s = f[0], y = s.b0 * x + s.z1; s.z1 = s.b1 * x - s.a1 * y + s.z2; s.z2 = s.b2 * x - s.a2 * y;
        const y1 = y; s = f[1];
        y = s.b0 * y1 + s.z1; s.z1 = s.b1 * y1 - s.a1 * y + s.z2; s.z2 = s.b2 * y1 - s.a2 * y;
        this.subSum[c] += y * y;
      }
      mono /= C;
      if (++this.subFill === this.sub) {
        let ms = 0; for (let c = 0; c < C; c++) { ms += this.subSum[c] / this.sub; this.subSum[c] = 0; }
        this.subs.push(ms); this.subFill = 0;
      }
      // envelope
      if (absMax > this.envMax) this.envMax = absMax;
      if (++this.envFill === ENV_BIN) {
        this._envPush(this.envMax); this.envMax = 0; this.envFill = 0;
      }
      // spectrogram ring
      this.ring[this.ringFill++] = mono;
      if (this.ringFill === N_FFT) this.ringFill = 0;
      if (++this.sinceHop === HOP) { this.sinceHop = 0; if (this.samples + i + 1 >= N_FFT) this._column(); }
    }
    this.samples += n;
  }

  _envPush(v) {
    // bounded: when full, halve resolution by merging neighbours (max)
    if (this.envMerge > 1) {
      this.envPending = Math.max(this.envPending, v);
      if (++this._envCount < this.envMerge) return;
      v = this.envPending; this.envPending = 0;
    }
    this._envCount = 0;
    this.env.push(v);
    if (this.env.length >= MAX_ENV) {
      const m = [];
      for (let i = 0; i < this.env.length; i += 2) m.push(Math.max(this.env[i], this.env[i + 1] || 0));
      this.env = m; this.envMerge *= 2;
    }
  }

  _column() {
    const re = this.re, im = this.im, w = this.win;
    for (let i = 0; i < N_FFT; i++) { re[i] = this.ring[(this.ringFill + i) % N_FFT] * w[i]; im[i] = 0; }
    fft(re, im);
    const col = new Float32Array(ROWS);
    for (let r = 0; r < ROWS; r++) {
      const [b0, b1] = this.rowBins[r];
      let m = 0;
      for (let b = b0; b <= b1; b++) { const v = re[b] * re[b] + im[b] * im[b]; if (v > m) m = v; }
      col[r] = 10 * Math.log10(m / (this.ref * this.ref) + 1e-14); // dBFS
    }
    if (this.colMerge > 1) {
      if (!this.colPending) { this.colPending = col; this.colPendingN = 1; }
      else { for (let r = 0; r < ROWS; r++) if (col[r] > this.colPending[r]) this.colPending[r] = col[r]; this.colPendingN++; }
      if (this.colPendingN < this.colMerge) return;
      this.cols.push(this.colPending); this.colPending = null;
    } else this.cols.push(col);
    if (this.cols.length >= MAX_COLS) {
      const m = [];
      for (let i = 0; i < this.cols.length; i += 2) {
        const a = this.cols[i], b = this.cols[i + 1];
        if (!b) { m.push(a); continue; }
        const c = new Float32Array(ROWS); for (let r = 0; r < ROWS; r++) c[r] = a[r] > b[r] ? a[r] : b[r];
        m.push(c);
      }
      this.cols = m; this.colMerge *= 2;
    }
  }

  /** Summary numbers + envelope + spectrogram grid. */
  result() {
    const blocks = [];
    for (let i = 0; i + 4 <= this.subs.length; i++) {
      const ms = (this.subs[i] + this.subs[i + 1] + this.subs[i + 2] + this.subs[i + 3]) / 4;
      blocks.push(ms);
    }
    const lk = ms => -0.691 + 10 * Math.log10(ms + 1e-20);
    let lufs = null, background = null;
    const abs = blocks.filter(ms => lk(ms) > -70);
    if (abs.length) {
      const g = abs.reduce((a, b) => a + b, 0) / abs.length;
      const rel = lk(g) - 10;
      const gated = abs.filter(ms => lk(ms) > rel);
      if (gated.length) lufs = lk(gated.reduce((a, b) => a + b, 0) / gated.length);
    }
    if (blocks.length) {
      const sorted = blocks.map(lk).sort((a, b) => a - b);
      background = sorted[Math.floor(sorted.length * 0.1)];
      if (background < -90) background = null;
    }
    const peaks = Array.from(this.peak);
    const peakDb = Math.max(...peaks) > 0 ? 20 * Math.log10(Math.max(...peaks)) : null;
    return {
      duration: this.samples / this.fs,
      lufs: lufs === null ? null : round1(lufs),
      peakDb: peakDb === null ? null : round1(peakDb),
      backgroundLufs: background === null ? null : round1(background),
      clippedSamples: this.clips,
      envelope: this.env.slice(),
      spectrogram: { cols: this.cols.slice(), rows: ROWS, fMin: this.fMin, fMax: this.fMax },
    };
  }
}
const round1 = v => Math.round(v * 10) / 10;

/** Reduce an envelope to `n` points (0..255) on a −60…0 dBFS scale.
 *  Logarithmic on purpose: levels stay honest (a quiet take looks quiet)
 *  while a −40 dBFS ambience is still visible as shape, not a flat line. */
export function envelopeToPeaks(env, n = 800) {
  if (!env.length) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * env.length / n), b = Math.max(a + 1, Math.floor((i + 1) * env.length / n));
    let m = 0; for (let k = a; k < b && k < env.length; k++) if (env[k] > m) m = env[k];
    const db = m > 0 ? 20 * Math.log10(m) : -120;
    out.push(Math.round(Math.max(0, Math.min(1, (db + 60) / 60)) * 255));
  }
  return out;
}
