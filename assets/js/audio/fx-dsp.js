/* Planet Sound — sound shaping: a tape machine and a three-band multiband compressor.
 *
 * ONE file, used three ways, so what you hear is what you export:
 *   - as an AudioWorklet (`ps-fx`)        live preview in the sound panel
 *   - as a plain script in the page       offline render for Export WAV / Export spectrogram
 *   - in Node                             the tests
 * It is a classic script (no import/export) so every browser accepts it in a worklet.
 *
 * Signal flow:   source → [varispeed] → TAPE → MULTIBAND → GRANULATOR (dry/wet) → safe ceiling → out
 *
 * TAPE   pitch (phase vocoder, time stays) · wow & flutter · tube (even harmonics) · saturate
 *        (pre/de-emphasised, so the highs go first, like tape) · overdrive · tape compression ·
 *        warmth (head bump + top-end roll-off, set by the machine) · high-pass · low-pass ·
 *        slap echo · hiss · volume.   Saturation runs at 2× the sample rate (half-band filters),
 *        so it doesn't alias.   Varispeed (playback speed) is applied outside, as a resample.
 * MULTIBAND  three bands split with Linkwitz-Riley 4th-order crossovers that add back up flat.
 *        Per band: above-threshold + ratio (downward), below-threshold + ratio (upward, or an
 *        expander when the ratio is under 1), attack, release, input, output, solo, on.
 *        Global: amount, time, output, range, soft knee, RMS/peak detection. Channels are linked.
 *
 * Everything is exactly neutral at its neutral setting. */
(function (root) {
'use strict';
const PI = Math.PI, TWO_PI = 2 * Math.PI;
const db2lin = d => Math.pow(10, d / 20);
const lin2db = x => 20 * Math.log10(Math.max(x, 1e-12));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ------------------------------------------------------------------ parameters */
const TYPES = {            // the "machine": head-bump frequency, top-end roll-off, how soon it saturates, wow depth, hiss
  cass: { bump: 160, top: 10500, sat: 1.5, wow: 2.0, hiss: 6 },
  '7':  { bump: 100, top: 14000, sat: 1.25, wow: 1.4, hiss: 3 },
  '15': { bump: 58,  top: 19000, sat: 1.0, wow: 1.0, hiss: 0 },
  '30': { bump: 34,  top: 0,     sat: 0.8, wow: 0.7, hiss: -3 },
};
const RANGES = {
  speed: [0.25, 4],
  tape: { pitch: [-12, 12], wow: [0, 1], sat: [0, 1], tube: [0, 1], drive: [0, 1], comp: [0, 1], warmth: [0, 1],
          hp: [20, 1000], lp: [1000, 22000], hiss: [0, 1], slap: [0, 1], slapMs: [30, 400], vol: [-18, 18] },
  mb: { amount: [0, 2], time: [0.1, 4], out: [-24, 24], range: [0, 36], lo: [20, 1000], hi: [400, 18000] },
  grain: { mix: [0, 1], level: [-24, 12], bufSec: [1, 30], rate: [0.5, 200], size: [5, 2000], rndSize: [0, 1], jitter: [0, 1], pos: [0, 1], spray: [0, 1], scan: [-4, 4], pitch: [-36, 36], pSpray: [0, 24], rev: [0, 1], pan: [0, 1], amp: [0, 1], voices: [1, 64], tilt: [-1, 1], smooth: [0, 1], hp: [20, 2000], lp: [200, 22000], rStart: [0, 86400], rLen: [0.5, 60], seed: [0, 99999] },
  band: { inDb: [-24, 24], outDb: [-24, 24], aThr: [-60, 0], aRat: [1, 20], bThr: [-90, -5], bRat: [0.25, 4], atk: [0.05, 300], rel: [5, 3000] },
};
function bandDefaults() { return { on: true, solo: false, inDb: 0, outDb: 0, aThr: 0, aRat: 1, bThr: -90, bRat: 1, atk: 20, rel: 200 }; }
function grainDefaults() {
  return { on: false, mix: 0.5, level: 0, src: 'live', bufSec: 10, freeze: false, free: false, mode: 'sync', rate: 20, size: 120, rndSize: 0, jitter: 0, pos: 0.5, spray: 0.2, scan: 0, pitch: 0, pSpray: 0, scale: 'free', rev: 0, pan: 0.4, amp: 0, voices: 32, tilt: 0, smooth: 1, hp: 20, lp: 22000, rStart: 0, rLen: 8, seed: 1 };
}
function defaults() {
  return {
    speed: 1,
    tape: { on: false, type: '15', pitch: 0, wow: 0, sat: 0, tube: 0, drive: 0, comp: 0, warmth: 0, hp: 20, lp: 22000, hiss: 0, slap: 0, slapMs: 120, vol: 0 },
    mb: { on: false, amount: 1, time: 1, out: 0, range: 24, knee: true, rms: true, lo: 100, hi: 2500, bands: [bandDefaults(), bandDefaults(), bandDefaults()] },
    grain: grainDefaults(),
    safe: true,
  };
}
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
function pick(src, def, ranges) {
  const out = {};
  for (const k of Object.keys(def)) {
    const d = def[k], v = src ? src[k] : undefined;
    if (ranges && ranges[k]) out[k] = clamp(num(v, d), ranges[k][0], ranges[k][1]);
    else if (typeof d === 'boolean') out[k] = typeof v === 'boolean' ? v : d;
    else if (typeof d === 'string') out[k] = typeof v === 'string' ? v : d;
    else out[k] = d;
  }
  return out;
}
/** A complete, clamped parameter set from anything (missing fields take their neutral value). */
function normalize(p) {
  const d = defaults();
  const o = { speed: clamp(num(p && p.speed, 1), RANGES.speed[0], RANGES.speed[1]), safe: !(p && p.safe === false) };
  o.tape = pick(p && p.tape, d.tape, RANGES.tape);
  if (!TYPES[o.tape.type]) o.tape.type = '15';
  o.mb = pick(p && p.mb, d.mb, RANGES.mb);
  o.mb.bands = [0, 1, 2].map(i => pick(p && p.mb && p.mb.bands && p.mb.bands[i], bandDefaults(), RANGES.band));
  o.mb.bands.forEach(b => { b.bThr = Math.min(b.bThr, b.aThr); });
  if (o.mb.hi < o.mb.lo * 1.5) o.mb.hi = Math.min(RANGES.mb.hi[1], o.mb.lo * 1.5);
  if (o.mb.hi < o.mb.lo * 1.5) o.mb.lo = o.mb.hi / 1.5;
  o.grain = pick(p && p.grain, d.grain, RANGES.grain);
  o.grain.voices = Math.round(o.grain.voices); o.grain.seed = Math.round(o.grain.seed);
  if (o.grain.src !== 'region') o.grain.src = 'live';
  if (o.grain.mode !== 'cloud') o.grain.mode = 'sync';
  if (!(o.grain.scale in SCALES)) o.grain.scale = 'free';
  return o;
}
/** True when the processing would change nothing: the file can be passed through untouched. */
function isNeutral(p) {
  const q = normalize(p);
  if (q.speed !== 1) return false;
  if (q.tape.on || q.mb.on || q.grain.on) return false;
  return true;
}

/* ------------------------------------------------------------------ small building blocks */
class Biquad {
  constructor(n) { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = new Float64Array(n); this.z2 = new Float64Array(n); }
  set(b0, b1, b2, a0, a1, a2) { this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; }
  ident() { this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = 0; }
  reset() { this.z1.fill(0); this.z2.fill(0); }
  run(x, ch) {
    const y = this.b0 * x + this.z1[ch];
    this.z1[ch] = this.b1 * x - this.a1 * y + this.z2[ch];
    this.z2[ch] = this.b2 * x - this.a2 * y;
    return y;
  }
  lp(f, fs, q) { const w = TWO_PI * f / fs, c = Math.cos(w), al = Math.sin(w) / (2 * (q || Math.SQRT1_2)); this.set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al); }
  hp(f, fs, q) { const w = TWO_PI * f / fs, c = Math.cos(w), al = Math.sin(w) / (2 * (q || Math.SQRT1_2)); this.set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al); }
  peak(f, fs, q, gDb) {
    const A = Math.pow(10, gDb / 40), w = TWO_PI * f / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }
  highShelf(f, fs, gDb) {                       // shelf slope 1
    const A = Math.pow(10, gDb / 40), w = TWO_PI * f / fs, c = Math.cos(w), s = Math.sin(w), al = s / 2 * Math.SQRT2, t = 2 * Math.sqrt(A) * al;
    this.set(A * ((A + 1) + (A - 1) * c + t), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - t),
             (A + 1) - (A - 1) * c + t, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - t);
  }
}

/** Circular buffer per channel; delay 0 is the sample just written. */
class Delay {
  constructor(n, len) {
    let s = 1; while (s < len + 8) s <<= 1;
    this.mask = s - 1; this.w = 0; this.buf = [];
    for (let c = 0; c < n; c++) this.buf.push(new Float32Array(s));
  }
  write(c, x) { this.buf[c][this.w] = x; }
  advance() { this.w = (this.w + 1) & this.mask; }
  read(c, d) { return this.buf[c][(this.w - d) & this.mask]; }
  readF(c, d) {                                  // cubic (Hermite); needs d >= 2
    const b = this.buf[c], pos = this.w - d, i = Math.floor(pos), f = pos - i, m = this.mask;
    const y0 = b[(i - 1) & m], y1 = b[i & m], y2 = b[(i + 1) & m], y3 = b[(i + 2) & m];
    return ((0.5 * (y3 - y0) + 1.5 * (y1 - y2)) * f + (y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3)) * f * f + 0.5 * (y2 - y0) * f + y1;
  }
  clear() { for (const b of this.buf) b.fill(0); }
}

/* Half-band filters for 2× oversampling (Kaiser window). Latency: M samples at the base rate, in total. */
const HB_M = 24;
const HB = (() => {
  const bessel = x => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; } return s; };
  const beta = 8, h = k => { const a = k / (HB_M + 1), w = bessel(beta * Math.sqrt(Math.max(0, 1 - a * a))) / bessel(beta); return k === 0 ? 0.5 : 0.5 * Math.sin(PI * k / 2) / (PI * k / 2) * w; };
  const up = new Float64Array(HB_M), dn = new Float64Array(HB_M);
  for (let m = 0; m < HB_M; m++) up[m] = 2 * h(2 * m - (HB_M - 1));        // odd output: 2·Σ h(2m−(M−1))·x[n−m]
  for (let m = 1; m <= HB_M; m++) dn[m - 1] = h(2 * m - (HB_M + 1));       // down: Σ h(2m−(M+1))·zb[n−m]
  let su = 0, sd = 0; for (let m = 0; m < HB_M; m++) { su += up[m]; sd += dn[m]; }
  for (let m = 0; m < HB_M; m++) { up[m] /= su; dn[m] *= 0.5 / sd; }        // exact DC gain 1
  return { up, dn };
})();
class Oversampler {
  constructor(n) {
    this.n = n; this.xh = []; this.za = []; this.zb = [];
    for (let c = 0; c < n; c++) { this.xh.push(new Float64Array(HB_M * 2)); this.za.push(new Float64Array(HB_M * 2)); this.zb.push(new Float64Array(HB_M * 2)); }
    this.p = 0;                                    // write position shared by all channels (ring of 2M)
    this.o0 = 0; this.o1 = 0;
  }
  /** One input sample → two samples at the doubled rate (this.o0, this.o1). */
  up(c, x) {
    const h = this.xh[c], L = HB_M * 2, p = this.p;
    h[p] = x;
    let s = 0; const U = HB.up;
    for (let m = 0; m < HB_M; m++) s += U[m] * h[(p - m + L) % L];
    this.o0 = h[(p - HB_M / 2 + L) % L];
    this.o1 = s;
  }
  /** Two samples at the doubled rate → one at the base rate. */
  down(c, a, b) {
    const za = this.za[c], zb = this.zb[c], L = HB_M * 2, p = this.p;
    za[p] = a; zb[p] = b;
    let s = 0.5 * za[(p - HB_M / 2 + L) % L]; const D = HB.dn;
    for (let m = 1; m <= HB_M; m++) s += D[m - 1] * zb[(p - m + L) % L];
    return s;
  }
  step() { this.p = (this.p + 1) % (HB_M * 2); }
  reset() { for (let c = 0; c < this.n; c++) { this.xh[c].fill(0); this.za[c].fill(0); this.zb[c].fill(0); } }
}

/* FFT, in place, power of two */
function makeFFT(n) {
  const bits = Math.round(Math.log2(n)), rev = new Uint32Array(n), cs = new Float64Array(n / 2), sn = new Float64Array(n / 2);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  for (let i = 0; i < n / 2; i++) { cs[i] = Math.cos(TWO_PI * i / n); sn[i] = Math.sin(TWO_PI * i / n); }
  function run(re, im, sign) {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cs[t], wi = sign * sn[t], a = i + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        }
      }
    }
  }
  return { forward: (re, im) => run(re, im, -1), inverse: (re, im) => run(re, im, 1) };
}

/* Pitch shifter: phase vocoder, 2048-point frames, 4× overlap. Time is unchanged; pitch moves by `ratio`. */
const PV_N = 2048, PV_OS = 4, PV_STEP = PV_N / PV_OS, PV_FIFO = PV_N - PV_STEP, PV_LAT = PV_N;   // PV_LAT: how late the output is (samples)
const PV_FFT = makeFFT(PV_N);
const PV_WIN = new Float64Array(PV_N); for (let i = 0; i < PV_N; i++) PV_WIN[i] = 0.5 - 0.5 * Math.cos(TWO_PI * i / PV_N);
class PitchShifter {
  constructor() {
    this.inF = new Float64Array(PV_N); this.outF = new Float64Array(PV_STEP); this.acc = new Float64Array(PV_N + PV_STEP);
    this.lastPh = new Float64Array(PV_N / 2 + 1); this.sumPh = new Float64Array(PV_N / 2 + 1);
    this.re = new Float64Array(PV_N); this.im = new Float64Array(PV_N);
    this.aM = new Float64Array(PV_N / 2 + 1); this.aF = new Float64Array(PV_N / 2 + 1);
    this.sM = new Float64Array(PV_N / 2 + 1); this.sF = new Float64Array(PV_N / 2 + 1);
    this.rover = PV_FIFO; this.gain = 1;
  }
  reset() { for (const a of [this.inF, this.outF, this.acc, this.lastPh, this.sumPh]) a.fill(0); this.rover = PV_FIFO; this.gain = 1; }
  process(x, ratio) {
    this.inF[this.rover] = x;
    const y = this.outF[this.rover - PV_FIFO];
    if (++this.rover >= PV_N) { this.rover = PV_FIFO; this._frame(ratio); }
    return y;
  }
  _frame(ratio) {
    const N = PV_N, H = N / 2, re = this.re, im = this.im, expct = TWO_PI / PV_OS;
    let eIn = 0;
    for (let k = 0; k < N; k++) { const v = this.inF[k] * PV_WIN[k]; re[k] = v; im[k] = 0; eIn += v * v * PV_WIN[k] * PV_WIN[k]; }
    PV_FFT.forward(re, im);
    for (let k = 0; k <= H; k++) {
      const a = re[k], b = im[k], ph = Math.atan2(b, a);
      let t = ph - this.lastPh[k]; this.lastPh[k] = ph;
      t -= k * expct; t -= TWO_PI * Math.round(t / TWO_PI);
      this.aM[k] = (k === 0 || k === H ? 1 : 2) * Math.sqrt(a * a + b * b);
      this.aF[k] = k + t * PV_OS / TWO_PI;
    }
    this.sM.fill(0); this.sF.fill(0);
    for (let k = 1; k <= H; k++) {
      const i = Math.round(k * ratio);
      if (i >= 1 && i <= H) { this.sM[i] += this.aM[k]; this.sF[i] = this.aF[k] * ratio; }
    }
    for (let k = 0; k <= H; k++) {
      const t = TWO_PI * (this.sF[k] - k) / PV_OS + k * expct;
      this.sumPh[k] += t; this.sumPh[k] -= TWO_PI * Math.round(this.sumPh[k] / TWO_PI);
      re[k] = this.sM[k] * Math.cos(this.sumPh[k]); im[k] = this.sM[k] * Math.sin(this.sumPh[k]);
    }
    for (let k = H + 1; k < N; k++) { re[k] = 0; im[k] = 0; }
    PV_FFT.inverse(re, im);
    // Moving the bins around changes how the overlapping frames add up, which would make the level wander. Each frame
    // is brought back to the energy of the frame that went in (smoothed), so the level stays where it was.
    let eOut = 0;
    for (let k = 0; k < N; k++) { const v = re[k] * PV_WIN[k] / N; eOut += v * v; }
    let want = eOut > 1e-20 && eIn > 1e-20 ? Math.sqrt(eIn / eOut) : 1;
    want = want > 4 ? 4 : want < 0.25 ? 0.25 : want;
    this.gain += (want - this.gain) * 0.6;
    const g = this.gain * 8 / (3 * N * PV_OS);             // Hann² at 4× overlap adds up to 1.5; the one-sided spectrum was doubled
    for (let k = 0; k < N; k++) this.acc[k] += re[k] * PV_WIN[k] * g;
    for (let k = 0; k < PV_STEP; k++) this.outF[k] = this.acc[k];
    this.acc.copyWithin(0, PV_STEP); this.acc.fill(0, N);
    this.inF.copyWithin(0, PV_STEP);
  }
}

/** Gain that keeps a noise-like signal (about −24 dBFS RMS) at the same loudness through a shaper. */
function matchGain(fn, sigma) {
  const N = 160; let s = 0, s2 = 0, w = 0;
  for (let i = 0; i <= N; i++) {
    const z = -4 + 8 * i / N, p = Math.exp(-z * z / 2), y = fn(z * sigma);
    s += p * y; s2 += p * y * y; w += p;
  }
  const v = s2 / w - (s / w) * (s / w);
  return v > 1e-18 ? sigma / Math.sqrt(v) : 1;
}
const REF_SIGMA = 0.06;

/* ------------------------------------------------------------------ TAPE */
const WOW_BASE_MS = 4;
class TapeCore {
  /** `lowLatency`: used by offline renders — when Tape is off from the start the signal is passed straight through, no delay. */
  constructor(fs, n, lowLatency) {
    this.fs = fs; this.n = n; this.fixed = !!lowLatency;
    this.wowBase = Math.round(WOW_BASE_MS * 0.001 * fs);
    this.lat = PV_LAT + HB_M + this.wowBase;
    this.pdl = new Delay(n, PV_N * 2 + 8);                 // dry history for the pitch stage
    this.dry = new Delay(n, this.lat + 8);                  // aligned dry path for the on/off crossfade
    this.wdl = new Delay(n, this.wowBase * 2 + 16);
    this.sdl = new Delay(n, Math.ceil(fs * 0.9));           // slap
    this.shift = []; for (let c = 0; c < n; c++) this.shift.push(new PitchShifter());
    this.os = new Oversampler(n); this.hbd = new Delay(n, HB_M + 8);
    this.preE = new Biquad(n); this.deE = new Biquad(n);   // at the doubled rate
    this.bump = new Biquad(n); this.top = new Biquad(n); this.hpf = new Biquad(n); this.lpf = new Biquad(n);
    this.slapHp = new Biquad(n); this.slapLp = new Biquad(n);
    this.dcx = new Float64Array(n); this.dcy = new Float64Array(n);
    this.topS = new Float64Array(n);
    this.env = 0; this.grDb = 0;
    this.hissLp = new Float64Array(n); this.seed = 0x9e3779b9 | 0;
    this.wetBuf = new Float64Array(n); this.SK = [];
    this.pm = 0; this.pmOn = false; this.m = 0; this.on = false; this.wasOn = false; this.primed = false;
    this.phW = 0; this.phF = 0; this.rnd = 0; this.rndT = 0;
    this.S = null; this.D = null; this.lastP = null;
    this.useHp = false; this.useLp = false; this.useTop = false; this.useBump = false;
  }
  _derive(p) {
    const fs = this.fs, T = TYPES[p.type], D = this.D || (this.D = {});
    const a = p.sat, t = p.tube, o = p.drive;
    D.tubeB = Math.min(1, t * 3); D.satB = Math.min(1, a * 3); D.drvB = Math.min(1, o * 3);
    D.gT = 1 + 4 * t; D.bias = 0.32 * Math.pow(t, 0.8);
    const sc = T.sat;
    D.gS = 1 + 9 * Math.pow(Math.min(1.5, a * sc), 1.6);
    D.gD = 1 + 14 * Math.pow(Math.min(1.5, o * sc), 1.3);
    const bias = D.bias, gT = D.gT, g0 = Math.tanh(gT * bias);
    D.cT = matchGain(x => Math.tanh(gT * (x + bias)) - g0, REF_SIGMA);
    D.cS = matchGain(x => Math.tanh(D.gS * x), REF_SIGMA);
    D.cD = matchGain(x => { const z = x * D.gD; return z / Math.cbrt(1 + Math.abs(z * z * z)); }, REF_SIGMA);
    D.tubeG0 = g0;
    D.emph = 6 * Math.min(1, a * 1.5);
    this.preE.highShelf(3000, fs * 2, D.emph); this.deE.highShelf(3000, fs * 2, -D.emph);
    // compression
    D.cThr = -6 - 12 * p.comp; D.cRat = 1 + 3 * p.comp; D.cMk = 0.35 * Math.abs(D.cThr) * (1 - 1 / D.cRat);
    D.cOn = p.comp > 0.002;
    D.cAtk = 1 - Math.exp(-1 / (fs * 0.0008)); D.cRel = 1 - Math.exp(-1 / (fs * 0.12));
    // warmth
    D.warm = p.warmth;
    this.useBump = p.warmth > 0.002;
    if (this.useBump) this.bump.peak(T.bump, fs, 1.1, 5 * p.warmth); else this.bump.ident();
    this.useTop = p.warmth > 0.002 && T.top > 0;
    if (this.useTop) { const fc = 22000 * Math.pow(T.top / 22000, p.warmth); this.top.lp(Math.min(fc, fs * 0.45), fs, Math.SQRT1_2); } else this.top.ident();
    this.useHp = p.hp > 20.5; if (this.useHp) this.hpf.hp(p.hp, fs, Math.SQRT1_2); else this.hpf.ident();
    this.useLp = p.lp < 21900 && p.lp < fs * 0.45; if (this.useLp) this.lpf.lp(p.lp, fs, Math.SQRT1_2); else this.lpf.ident();
    // wow & flutter: peak speed deviation (fraction) → delay amplitude
    const dev = 0.0030 * p.wow * T.wow;
    D.wowA = dev * 0.7 / (TWO_PI * 0.8) * fs;                 // wow ≈ 0.8 Hz
    D.fluA = dev * 0.3 / (TWO_PI * 9.5) * fs;                 // flutter ≈ 9.5 Hz
    D.wowInc = TWO_PI * 0.8 / fs; D.fluInc = TWO_PI * 9.5 / fs;
    D.rndA = dev * 0.25 / (TWO_PI * 2.2) * fs;
    // slap
    D.slapGain = p.slap * 0.75; D.slapFb = 0.12 + 0.38 * p.slap; D.slapD = clamp(p.slapMs * 0.001 * fs, 8, this.sdl.mask - 8);
    this.slapHp.hp(160, fs, Math.SQRT1_2); this.slapLp.lp(4200, fs, Math.SQRT1_2);
    // hiss: −90 dBFS … −42 dBFS (rms-ish), plus the machine's own floor
    D.hissG = p.hiss > 0.001 ? db2lin(-90 + 48 * p.hiss + T.hiss) * 3.2 : 0;
    D.volG = db2lin(p.vol);
    D.pitchRatio = Math.pow(2, p.pitch / 12); D.pitchOn = Math.abs(p.pitch) >= 0.005;
  }
  _snap() {                                            // set the smoothers to their targets (static renders)
    const D = this.D, S = this.S || (this.S = {});
    this.SK = ['tubeB', 'satB', 'drvB', 'gT', 'bias', 'gS', 'gD', 'cT', 'cS', 'cD', 'tubeG0', 'slapGain', 'slapFb', 'hissG', 'volG', 'wowA', 'fluA', 'rndA'];
    for (const k of this.SK) S[k] = D[k];
  }
  _activate() {
    this.os.reset();
    for (const b of [this.preE, this.deE, this.bump, this.top, this.hpf, this.lpf, this.slapHp, this.slapLp]) b.reset();
    this.dcx.fill(0); this.dcy.fill(0); this.hissLp.fill(0); this.env = 0; this.grDb = 0; this.sdl.clear();
    this.primed = false;
  }
  _prime(ratio) {                                     // start the shifter as if it had been running: replay the recent dry samples
    for (let c = 0; c < this.n; c++) {
      const s = this.shift[c]; s.reset();
      for (let k = PV_N; k >= 1; k--) s.process(this.pdl.read(c, k), ratio);
    }
    this.primed = true;
  }
  /** inA, outA: arrays of Float32Array, one per channel. */
  process(inA, outA, frames, tp) {
    const n = this.n, fs = this.fs;
    if (tp !== this.lastP) { this._derive(tp); this.lastP = tp; if (!this.S) this._snap(); }
    const D = this.D, S = this.S, SK = this.SK, onT = !!tp.on;
    if (this.fixed && !onT && !this.on && this.m === 0) {           // static render with Tape off: straight through
      for (let c = 0; c < n; c++) if (outA[c] !== inA[c]) outA[c].set(inA[c].subarray(0, frames));
      return;
    }
    if (onT && !this.on) { this._activate(); }
    this.on = onT || this.m > 1e-6 ? true : false;
    const km = 1 - Math.exp(-1 / (fs * 0.012)), ks = 1 - Math.exp(-1 / (fs * 0.012)), kp = 1 - Math.exp(-1 / (fs * 0.020));
    const mt = onT ? 1 : 0, pt = onT && D.pitchOn ? 1 : 0;
    if (this.fixed && onT && this.m === 0 && !this.firstDone) { this.m = 1; this.firstDone = true; if (D.pitchOn) { this.pm = 1; this.primed = true; } }
    for (let i = 0; i < frames; i++) {
      this.m += (mt - this.m) * km; if (Math.abs(mt - this.m) < 1e-5) this.m = mt;
      this.pm += (pt - this.pm) * kp; if (Math.abs(pt - this.pm) < 1e-5) this.pm = pt;
      for (let q = 0; q < SK.length; q++) { const k = SK[q]; S[k] += (D[k] - S[k]) * ks; }
      if (D.tubeB === 0 && S.tubeB < 1e-5) S.tubeB = 0; if (D.satB === 0 && S.satB < 1e-5) S.satB = 0; if (D.drvB === 0 && S.drvB < 1e-5) S.drvB = 0;
      // wow & flutter: one modulation for all channels
      this.phW += D.wowInc; this.phF += D.fluInc; if (this.phW > TWO_PI) this.phW -= TWO_PI; if (this.phF > TWO_PI) this.phF -= TWO_PI;
      if (--this.rndT <= 0) { this.rndT = (fs * 0.35) | 0; this.seed = (Math.imul(this.seed, 1664525) + 1013904223) | 0; this.rnd = this.seed / 2147483648; }
      this.rndS = (this.rndS || 0) + (this.rnd - (this.rndS || 0)) * 0.0004;
      const modD = this.wowBase + S.wowA * Math.sin(this.phW) + S.fluA * Math.sin(this.phF) + S.rndA * this.rndS * 3.5;
      const Bany = Math.max(S.tubeB, S.satB, S.drvB), Bw = Math.min(1, Bany * 30);
      if (Bany > 0 && !this.osOn) { this.os.reset(); this.osOn = true; } else if (Bany === 0) this.osOn = false;
      // compressor detector: linked
      let pk = 0;
      const wet = this.wetBuf;
      for (let c = 0; c < n; c++) {
        const x = inA[c][i];
        this.dry.write(c, x); this.pdl.write(c, x);
        const dryOut = this.dry.read(c, this.lat);
        if (this.m === 0 && !onT) { outA[c][i] = dryOut; wet[c] = 0; continue; }
        // 1 pitch
        let y = this.pdl.read(c, PV_LAT);
        if (this.pm > 0 || pt) {
          if (!this.primed) this._prime(D.pitchRatio);
          const sx = this.shift[c].process(x, D.pitchRatio);
          y += this.pm * (sx - y);
        } else this.primed = false;
        // 2 saturation at 2× (only while one of the three stages is in use; otherwise the signal is simply delayed to line up)
        this.hbd.write(c, y);
        const ya = this.hbd.read(c, HB_M);
        if (Bany > 0) {
        this.os.up(c, y);
        let u0 = this.os.o0, u1 = this.os.o1;
        if (S.tubeB > 1e-4) {
          const gT = S.gT, b = S.bias, g0 = S.tubeG0, cT = S.cT, B = S.tubeB;
          u0 += B * ((Math.tanh(gT * (u0 + b)) - g0) * cT - u0); u1 += B * ((Math.tanh(gT * (u1 + b)) - g0) * cT - u1);
        }
        if (S.satB > 1e-4) {
          const g = S.gS, cS = S.cS, B = S.satB;
          let e0 = this.preE.run(u0, c), e1 = this.preE.run(u1, c);
          e0 = this.deE.run(Math.tanh(g * e0) * cS, c); e1 = this.deE.run(Math.tanh(g * e1) * cS, c);
          u0 += B * (e0 - u0); u1 += B * (e1 - u1);
        } else { this.preE.run(u0, c); this.preE.run(u1, c); this.deE.run(u0, c); this.deE.run(u1, c); }
        if (S.drvB > 1e-4) {
          const g = S.gD, cD = S.cD, B = S.drvB;
          let z0 = u0 * g, z1 = u1 * g;
          z0 = z0 / Math.cbrt(1 + Math.abs(z0 * z0 * z0)) * cD; z1 = z1 / Math.cbrt(1 + Math.abs(z1 * z1 * z1)) * cD;
          u0 += B * (z0 - u0); u1 += B * (z1 - u1);
        }
        const yo = this.os.down(c, u0, u1);
        y = ya + Bw * (yo - ya);
        } else y = ya;
        // DC blocker (tube adds some)
        const dc = y - this.dcx[c] + 0.99995 * this.dcy[c]; this.dcx[c] = y; this.dcy[c] = dc; y = dc;
        // 3 tone: head bump, top-end, high-pass, low-pass
        if (this.useBump) y = this.bump.run(y, c);
        if (this.useTop) y = this.top.run(y, c);
        if (this.useHp) y = this.hpf.run(y, c);
        if (this.useLp) y = this.lpf.run(y, c);
        wet[c] = y;
        const ay = Math.abs(y); if (ay > pk) pk = ay;
      }
      // 4 tape compression (linked)
      let cg = 1;
      if (D.cOn || this.grDb < -0.01) {
        this.env += (pk > this.env ? D.cAtk : D.cRel) * (pk - this.env);
        const lv = lin2db(this.env), over = lv - D.cThr, K = 10, kk = 1 - 1 / D.cRat;
        let gr = 0;
        if (D.cOn) gr = over <= -K / 2 ? 0 : over >= K / 2 ? over * kk : kk * (over + K / 2) * (over + K / 2) / (2 * K);
        const tgt = -gr + (D.cOn ? D.cMk : 0);
        this.grDb += (tgt - this.grDb) * 0.2; cg = db2lin(this.grDb);
        if (Math.abs(this.grDb) < 0.005 && !D.cOn) { this.grDb = 0; cg = 1; }
      }
      // 5 wow/flutter, slap, hiss, volume
      for (let c = 0; c < n; c++) {
        if (this.m === 0 && !onT) continue;
        let y = wet[c] * cg;
        this.wdl.write(c, y);
        y = this.wdl.readF(c, Math.max(2, modD));
        if (S.slapGain > 1e-4 || this.sdlHot) {
          const ds = this.sdl.readF(c, c ? D.slapD * 1.07 : D.slapD);
          let fb = this.slapLp.run(this.slapHp.run(y + S.slapFb * ds, c), c);
          this.sdl.write(c, fb);
          y += S.slapGain * ds;
        } else this.sdl.write(c, 0);
        if (S.hissG > 1e-7) {
          this.seed = (Math.imul(this.seed, 1664525) + 1013904223) | 0;
          const w = this.seed / 2147483648;
          this.hissLp[c] += (w - this.hissLp[c]) * 0.35;          // a little roll-off at the top
          y += (w - this.hissLp[c] * 0.6) * S.hissG;
        }
        y *= S.volG;
        const d = this.dry.read(c, this.lat);
        outA[c][i] = d + this.m * (y - d);
      }
      this.sdlHot = S.slapGain > 1e-4;
      this.pdl.advance(); this.dry.advance(); this.wdl.advance(); this.sdl.advance(); this.hbd.advance(); if (Bany > 0) this.os.step();
    }
    this.lastGr = this.grDb;
  }
}

/* ------------------------------------------------------------------ MULTIBAND */
const MB_GATE_LO = -96, MB_GATE_HI = -84;
class LR {                                    // Linkwitz-Riley 4th order = two Butterworth biquads in series
  constructor(n) { this.a = new Biquad(n); this.b = new Biquad(n); }
  lp(f, fs) { this.a.lp(f, fs); this.b.lp(f, fs); }
  hp(f, fs) { this.a.hp(f, fs); this.b.hp(f, fs); }
  run(x, c) { return this.b.run(this.a.run(x, c), c); }
  reset() { this.a.reset(); this.b.reset(); }
}
class MultibandCore {
  constructor(fs, n) {
    this.fs = fs; this.n = n;
    this.lowLP = new LR(n); this.lowHP = new LR(n); this.midLP = new LR(n); this.highHP = new LR(n); this.apLP = new LR(n); this.apHP = new LR(n);
    this.f = [0, 0];
    this.ms = [1e-9, 1e-9, 1e-9]; this.pk = [0, 0, 0];     // detectors
    this.g = [0, 0, 0];                                     // smoothed gain change, dB
    this.cIn = [0, 0, 0]; this.cOut = [0, 0, 0]; this.cOn = [1, 1, 1]; this.cMute = [1, 1, 1];
    this.mix = 0; this.flip = 1e-20; this.lastP = null; this.lvl = [-120, -120, -120]; this.gr = [0, 0, 0];
    this.band = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    this.started = false;
  }
  _coefs(p) {
    if (p.lo === this.f[0] && p.hi === this.f[1]) return;
    const fs = this.fs, hi = Math.min(p.hi, fs * 0.45), lo = Math.min(p.lo, hi / 1.3);
    this.lowLP.lp(lo, fs); this.lowHP.hp(lo, fs); this.midLP.lp(hi, fs); this.highHP.hp(hi, fs); this.apLP.lp(hi, fs); this.apHP.hp(hi, fs);
    this.f[0] = p.lo; this.f[1] = p.hi;
  }
  process(inA, outA, frames, p, safe) {
    const n = this.n, fs = this.fs, onT = !!p.on;
    if (!onT && this.mix === 0) { for (let c = 0; c < n; c++) if (outA[c] !== inA[c]) outA[c].set(inA[c].subarray(0, frames)); return; }
    if (onT && this.mix === 0 && !this.started) { this.started = true; this.lowLP.reset(); this.lowHP.reset(); this.midLP.reset(); this.highHP.reset(); this.apLP.reset(); this.apHP.reset(); this.ms.fill(1e-9); this.pk.fill(0); this.g.fill(0); }
    if (!onT && this.mix === 0) this.started = false;
    this._coefs(p);
    const B = p.bands, anySolo = B.some(b => b.solo), tm = p.time, am = p.amount, rms = p.rms, knee = p.knee, range = p.range;
    const kms = 1 - Math.exp(-1 / (fs * 0.004)), kpkR = Math.exp(-1 / (fs * 0.02));
    const kg = 1 - Math.exp(-1 / (fs * 0.006)), kmix = 1 - Math.exp(-1 / (fs * 0.010));
    const aA = [0, 0, 0], aR = [0, 0, 0], inT = [0, 0, 0], outT = [0, 0, 0], onTg = [0, 0, 0], muteT = [0, 0, 0];
    for (let b = 0; b < 3; b++) {
      aA[b] = 1 - Math.exp(-1 / (fs * Math.max(0.00002, B[b].atk * 0.001 * tm)));
      aR[b] = 1 - Math.exp(-1 / (fs * Math.max(0.0005, B[b].rel * 0.001 * tm)));
      onTg[b] = B[b].on ? 1 : 0; inT[b] = B[b].inDb; outT[b] = B[b].outDb; muteT[b] = anySolo && !B[b].solo ? 0 : 1;
    }
    const outTarget = p.out, mixT = onT ? 1 : 0;
    const band = this.band, ms = this.ms, g = this.g, pkv = this.pk;
    const ln = [0, 0, 0], gains = [1, 1, 1];
    if (!this.init) { this.cOn = onTg.slice(); this.cIn = inT.slice(); this.cOut = outT.slice(); this.cMute = muteT.slice(); this.outG = outTarget; this.init = true; }
    for (let i = 0; i < frames; i++) {
      this.mix += (mixT - this.mix) * kmix; if (Math.abs(mixT - this.mix) < 1e-5) this.mix = mixT;
      this.outG += (outTarget - this.outG) * kg;
      this.flip = -this.flip;
      let e0 = 0, e1 = 0, e2 = 0;
      for (let c = 0; c < n; c++) {
        const s = inA[c][i] + this.flip;
        const low = this.lowLP.run(s, c), rest = this.lowHP.run(s, c);
        const lowAP = this.apLP.run(low, c) + this.apHP.run(low, c);
        band[0][c] = lowAP; band[1][c] = this.midLP.run(rest, c); band[2][c] = this.highHP.run(rest, c);
      }
      for (let b = 0; b < 3; b++) {
        this.cOn[b] += (onTg[b] - this.cOn[b]) * kg; this.cIn[b] += (inT[b] - this.cIn[b]) * kg; this.cOut[b] += (outT[b] - this.cOut[b]) * kg; this.cMute[b] += (muteT[b] - this.cMute[b]) * kg;
        const on = this.cOn[b], inLin = db2lin(this.cIn[b] * on);
        let lv2 = 0;
        for (let c = 0; c < n; c++) { const v = band[b][c] * inLin; band[b][c] = v; const a = rms ? v * v : Math.abs(v); if (a > lv2) lv2 = a; }
        let lvl;
        if (rms) { ms[b] += (lv2 - ms[b]) * kms; lvl = 10 * Math.log10(ms[b] + 1e-12); }
        else { pkv[b] = lv2 > pkv[b] ? lv2 : pkv[b] * kpkR; lvl = 20 * Math.log10(pkv[b] + 1e-6); }
        ln[b] = lvl;
        const Bb = B[b];
        let want = 0;
        if (Bb.aRat > 1.0001) {
          const over = lvl - Bb.aThr, k = 1 - 1 / Bb.aRat;
          if (knee) { const K = 10; want -= over <= -K / 2 ? 0 : over >= K / 2 ? over * k : k * (over + K / 2) * (over + K / 2) / (2 * K); }
          else if (over > 0) want -= over * k;
        }
        if (Math.abs(Bb.bRat - 1) > 0.0001) {
          const under = Bb.bThr - lvl, k = 1 - 1 / Bb.bRat;
          let up = 0;
          if (knee) { const K = 10; up = under <= -K / 2 ? 0 : under >= K / 2 ? under * k : k * (under + K / 2) * (under + K / 2) / (2 * K); }
          else if (under > 0) up = under * k;
          if (up > 0) up *= lvl <= MB_GATE_LO ? 0 : lvl >= MB_GATE_HI ? 1 : (lvl - MB_GATE_LO) / (MB_GATE_HI - MB_GATE_LO);
          want += up;
        }
        want *= am;
        if (want > range) want = range; else if (want < -60) want = -60;
        want *= on;
        g[b] += (want < g[b] ? aA[b] : aR[b]) * (want - g[b]);
        gains[b] = db2lin(g[b] + this.cOut[b] * on) * this.cMute[b];
      }
      const og = db2lin(this.outG);
      for (let c = 0; c < n; c++) {
        const dry = inA[c][i];
        let w = (band[0][c] * gains[0] + band[1][c] * gains[1] + band[2][c] * gains[2]) * og;
        if (safe) w = softCeil(w);
        outA[c][i] = dry + this.mix * (w - dry);
      }
    }
    for (let b = 0; b < 3; b++) { this.lvl[b] = ln[b]; this.gr[b] = g[b]; }
  }
}
const CEIL = 0.8913, KNEE = 0.75;                 // soft ceiling at −1 dBFS; it starts to bend at about −2.5 dBFS
function softCeil(x) { const a = x < 0 ? -x : x; if (a <= KNEE) return x; const y = KNEE + (CEIL - KNEE) * Math.tanh((a - KNEE) / (CEIL - KNEE)); return x < 0 ? -y : y; }

/* ------------------------------------------------------------------ GRANULATOR
 * A granular synthesizer that plays grains of the sound it is fed (after Tape and Multiband), so you hear
 * the processed sound granulated, with a dry/wet mix against the processed sound itself.
 *
 *   SOURCE   Live: the last few seconds of the processed sound, kept in a ring buffer that fills while the sound
 *            plays (Freeze holds it). Region: a stretch of the recording, rendered through Tape + Multiband first.
 *   GRAINS   Classic = regular, Cloud = random in time. Rate (grains per second) and Size set the overlap.
 *            Each grain has a window (Shape: how soft the edges are; Tilt: where the peak sits), a position in the
 *            buffer (Position + Spray, moving with Scan), a pitch (Pitch + random Pitch spray, optionally quantised to
 *            a scale), a direction (Reverse), a place in the stereo field (Pan spread) and a level (Level spread).
 *   OUT      a tone filter (high-pass / low-pass) on the grains, a Level, and Dry/Wet (equal power).
 * Everything random comes from a seeded generator, so the same settings give the same result in any block size. */
const MAXV = 64;
const SCALES = {
  free: null, chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9], minorpent: [0, 3, 5, 7, 10], whole: [0, 2, 4, 6, 8, 10], fifths: [0, 7], octaves: [0],
};
function quantScale(x, sc) {
  const o = Math.floor(x / 12), r = x - o * 12; let best = 0, bd = 1e9;
  for (let i = 0; i <= sc.length; i++) { const d = i === sc.length ? 12 : sc[i], e = Math.abs(r - d); if (e < bd) { bd = e; best = d; } }
  return o * 12 + best;
}
function mulberry(seed) {
  let a = seed | 0;
  return function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
class GranulatorCore {
  constructor(fs, n) {
    this.fs = fs; this.n = n; this.nc = Math.min(2, n);
    this.cap = 0; this.ring = []; this.W = 0; this.F = 0;
    this.region = null; this.rF = 0; this.regionRate = fs;
    this.hold = false; this.run = true;
    this.vPos = new Float64Array(MAXV); this.vInc = new Float64Array(MAXV); this.vK = new Int32Array(MAXV); this.vLen = new Int32Array(MAXV);
    this.vGl = new Float32Array(MAXV); this.vGr = new Float32Array(MAXV); this.vUse = new Uint8Array(MAXV); this.act = new Int32Array(MAXV); this.nAct = 0;
    this.lut = new Float32Array(1026); this.lutKey = ''; this.mW = 0.5; this.mW2 = 0.375;
    this.seed = -1; this.rng = mulberry(1); this.cd = 0; this.scanP = 0; this.mixS = 0;
    this.hpF = new Biquad(2); this.lpF = new Biquad(2); this.fKey = ''; this.hpOn = false; this.lpOn = false;
    this.spawned = 0; this.dropped = 0; this.maxAct = 0; this.dbg = null; this.useRegion = false; this.lastU = 0;
    this.tailing = false;
  }
  _alloc(cap) { this.cap = cap; this.ring = []; for (let c = 0; c < this.nc; c++) this.ring.push(new Float32Array(cap)); this.W = 0; this.F = 0; this.killAll(); }
  killAll() { this.nAct = 0; this.vUse.fill(0); }
  /** A rendered stretch of the recording (one Float32Array per channel, at this sample rate). */
  setRegion(chs) {
    if (!chs || !chs.length || !chs[0].length) { this.clearRegion(); return; }
    const out = []; for (let c = 0; c < this.nc; c++) out.push(chs[Math.min(c, chs.length - 1)]);
    this.region = out; this.rF = out[0].length; this.killAll();
  }
  clearRegion() { this.region = null; this.rF = 0; this.killAll(); }
  _win(p) {
    const key = p.tilt + '|' + p.smooth; if (key === this.lutKey) return; this.lutKey = key;
    const x0 = 0.5 + p.tilt * 0.45, Li = Math.max(1e-4, x0 * p.smooth), Lo = Math.max(1e-4, (1 - x0) * p.smooth), L = this.lut;
    let s1 = 0, s2 = 0;
    for (let i = 0; i <= 1024; i++) {
      const x = i / 1024; let w = 1;
      if (x < Li) { const s = Math.sin(0.5 * PI * x / Li); w = s * s; } else if (x > 1 - Lo) { const s = Math.sin(0.5 * PI * (1 - x) / Lo); w = s * s; }
      L[i] = w; if (i < 1024) { s1 += w; s2 += w * w; }
    }
    L[1025] = L[1024]; this.mW = s1 / 1024; this.mW2 = s2 / 1024;
  }
  _filters(p) {
    const key = p.hp + '|' + p.lp; if (key === this.fKey) return; this.fKey = key;
    this.hpOn = p.hp > 20.5; this.lpOn = p.lp < 21900;
    if (this.hpOn) this.hpF.hp(p.hp, this.fs, 0.7071); else this.hpF.ident();
    if (this.lpOn) this.lpF.lp(Math.min(p.lp, this.fs * 0.45), this.fs, 0.7071); else this.lpF.ident();
  }
  /** x, y: arrays of Float32Array per channel. p: the normalised `grain` parameters. */
  process(inA, outA, frames, p) {
    const n = this.n, nc = this.nc, fs = this.fs;
    const wantCap = Math.max(1024, Math.round(p.bufSec * fs));
    if (wantCap !== this.cap) this._alloc(wantCap);
    if (p.seed !== this.seed) { this.seed = p.seed; this.rng = mulberry(p.seed + 1); }
    const cap = this.cap, writing = !p.freeze && !this.hold;
    if (!p.on) {
      if (writing) {
        for (let c = 0; c < nc; c++) { const r = this.ring[c], s = inA[c]; let w = this.W % cap; for (let i = 0; i < frames; i++) { r[w] = s[i]; if (++w === cap) w = 0; } }
        this.W += frames; this.F = Math.min(cap, this.F + frames);
      }
      for (let c = 0; c < n; c++) outA[c].set(inA[c].subarray(0, frames));
      this.killAll(); this.mixS = 0; this.tailing = false; return;
    }
    const useRegion = p.src === 'region' && !!this.region;
    if (useRegion !== this.useRegion) { this.useRegion = useRegion; this.killAll(); }
    const rb = useRegion ? this.region : this.ring, rCap = useRegion ? this.rF : cap;
    let cW = useRegion ? this.rF : this.W, cF = useRegion ? this.rF : this.F;
    const live = !useRegion && writing, margin = live ? 64 : 0;       // reading is kept clear of the end that is being overwritten
    let wi = this.W % cap, ring0 = this.ring[0], ring1 = nc > 1 ? this.ring[1] : null;
    const in0 = inA[0], in1 = nc > 1 ? inA[1] : null;
    let lo = 0, hi = 0, span = 0;
    this._win(p); this._filters(p);
    const lut = this.lut, mode = p.mode, quant = SCALES[p.scale] || null;
    const overlap = Math.min(p.voices, Math.max(0.02, p.rate * p.size / 1000));
    const wetGain = Math.pow(Math.max(1, overlap * this.mW2), -0.45) * Math.pow(10, p.level / 20);   // power-matched for noise-like sound (field recordings)
    const mixT = p.mix, voices = p.voices, rng = this.rng;
    const vUse = this.vUse, vPos = this.vPos, vInc = this.vInc, vK = this.vK, vLen = this.vLen, vGl = this.vGl, vGr = this.vGr, act = this.act;
    const b0 = rb[0], b1 = nc > 1 ? rb[1] : rb[0], stereo = nc > 1;
    const base = fs / p.rate, fade = 24, runOn = this.run;
    let nAct = this.nAct, cd = this.cd, scanP = this.scanP, mixS = this.mixS;
    if (!runOn) cd = Math.min(cd, 0);
    for (let i = 0; i < frames; i++) {
      if (live) {                                           // the live buffer is written sample by sample, so the result does not depend on the block size
        ring0[wi] = in0[i]; if (ring1) ring1[wi] = in1[i];
        if (++wi === cap) wi = 0; cW++; if (cF < cap) cF++;
      }
      hi = cW - 4; lo = cW - cF + 2 + margin; span = hi - lo;
      if (span > 64) { scanP += p.scan / span; if (scanP >= 1) scanP -= 1; else if (scanP < 0) scanP += 1; }
      if (runOn && span > 64) {
        cd -= 1;
        while (cd <= 0) {
          cd += mode === 'cloud' ? Math.max(1, base * Math.max(0.08, -Math.log(1 - rng() * 0.9999))) : Math.max(1, base * (p.jitter > 0 ? 1 + p.jitter * 0.9 * (rng() * 2 - 1) : 1));
          if (nAct >= voices) { this.dropped++; continue; }
          // ---- a new grain
          let len = Math.round(p.size * (p.rndSize > 0 ? Math.pow(2, p.rndSize * (rng() * 2 - 1)) : 1) * fs / 1000); if (len < 32) len = 32;
          let semis = p.pitch;
          if (p.pSpray > 0) { let r = p.pSpray * (rng() * 2 - 1); if (quant) r = quantScale(r, quant); semis += r; }
          let inc = Math.pow(2, semis / 12);
          const back = p.rev > 0 && rng() < p.rev;
          let u = p.pos + scanP; u -= Math.floor(u);
          if (p.spray > 0) u += p.spray * 0.5 * (rng() * 2 - 1);
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          let start = lo + u * span; const need = len * inc + 4;
          if (!back) { if (start + need > hi) start = Math.max(lo, hi - need); } else { if (start - need < lo) start = Math.min(hi, lo + need); }
          let pan = p.pan > 0 ? p.pan * (rng() * 2 - 1) : 0;
          const amp = p.amp > 0 ? 1 - p.amp * rng() : 1;
          let v = -1; for (let k = 0; k < MAXV; k++) { if (!vUse[k]) { v = k; break; } }
          if (v < 0) { this.dropped++; continue; }
          vPos[v] = start; vInc[v] = back ? -inc : inc; vK[v] = 0; vLen[v] = len;
          if (stereo) { const a = (pan + 1) * PI / 4; vGl[v] = Math.SQRT2 * Math.cos(a) * amp; vGr[v] = Math.SQRT2 * Math.sin(a) * amp; } else { vGl[v] = amp; vGr[v] = amp; }
          vUse[v] = 1; act[nAct++] = v; this.spawned++; this.lastU = u;
          if (this.dbg) this.dbg.push({ semis, back, u, len, pan, amp, t: this.spawned });
        }
      }
      let wl = 0, wr = 0;
      for (let a = 0; a < nAct; a++) {
        const v = act[a], pos = vPos[v], inc = vInc[v], k = vK[v], len = vLen[v];
        const d = inc > 0 ? hi - pos : pos - lo;
        if (d <= 0 || k >= len) { vUse[v] = 0; act[a] = act[--nAct]; a--; continue; }
        const ph = k / len * 1024, pi = ph | 0, pf = ph - pi;
        let w = lut[pi] + (lut[pi + 1] - lut[pi]) * pf;
        if (k < fade) w *= k / fade; else if (len - k < fade) w *= (len - k) / fade;
        if (d < 64) w *= d / 64;
        const i1 = Math.floor(pos), f = pos - i1, bb = i1 % rCap, ia = bb === 0 ? rCap - 1 : bb - 1, ic = bb + 1 === rCap ? 0 : bb + 1, id = ic + 1 === rCap ? 0 : ic + 1;
        const f2 = f * f;
        let y0 = b0[ia], y1 = b0[bb], y2 = b0[ic], y3 = b0[id];
        const xl = ((0.5 * (y3 - y0) + 1.5 * (y1 - y2)) * f + (y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3)) * f2 + 0.5 * (y2 - y0) * f + y1;
        let xr = xl;
        if (stereo) { y0 = b1[ia]; y1 = b1[bb]; y2 = b1[ic]; y3 = b1[id]; xr = ((0.5 * (y3 - y0) + 1.5 * (y1 - y2)) * f + (y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3)) * f2 + 0.5 * (y2 - y0) * f + y1; }
        wl += xl * w * vGl[v]; wr += xr * w * vGr[v];
        vPos[v] = pos + inc; vK[v] = k + 1;
      }
      wl *= wetGain; wr *= wetGain;
      if (this.hpOn) { wl = this.hpF.run(wl, 0); if (stereo) wr = this.hpF.run(wr, 1); }
      if (this.lpOn) { wl = this.lpF.run(wl, 0); if (stereo) wr = this.lpF.run(wr, 1); }
      mixS += (mixT - mixS) * 0.003;
      const dg = Math.cos(mixS * PI / 2), wg = Math.sin(mixS * PI / 2);
      outA[0][i] = inA[0][i] * dg + wl * wg;
      if (nc > 1) outA[1][i] = inA[1][i] * dg + wr * wg;
    }
    for (let c = nc; c < n; c++) outA[c].set(inA[c].subarray(0, frames));
    if (nAct > this.maxAct) this.maxAct = nAct;
    if (live) { this.W = cW; this.F = cF; }
    this.nAct = nAct; this.cd = cd; this.scanP = scanP; this.mixS = mixS; this.tailing = nAct > 0;
    this.info = { span, lo, F: cF, W: cW, region: useRegion };
  }
  /** For the display: where the sounding grains read from (0 = oldest, 1 = newest) and how loud they are right now. */
  grains(max) {
    const out = [], inf = this.info; if (!inf || inf.span <= 0) return out;
    for (let a = 0; a < this.nAct && out.length < max; a++) {
      const v = this.act[a], x = (this.vPos[v] - inf.lo) / inf.span;
      out.push([x < 0 ? 0 : x > 1 ? 1 : x, Math.sin(PI * this.vK[v] / this.vLen[v])]);
    }
    return out;
  }
  get fill() { return this.useRegion ? 1 : this.F / (this.cap || 1); }
}

/* ------------------------------------------------------------------ the chain */
class FxChain {
  /** @param {number} fs @param {number} n channels @param {{lowLatency?:boolean}} [o] */
  constructor(fs, n, o) {
    this.fs = fs; this.n = n; this.o = o || {};
    this.tape = new TapeCore(fs, n, this.o.lowLatency);
    this.mb = new MultibandCore(fs, n);
    this.grain = new GranulatorCore(fs, n);
    this.tmp = []; this.tmp2 = []; this.size = 0;
    this.safeS = 0;
  }
  /** Samples of delay the chain adds while Tape is on (a static render with Tape off adds none). */
  get latency() { return this.tape.lat; }
  _alloc(frames) { if (frames > this.size) { this.size = frames; this.tmp = []; this.tmp2 = []; for (let c = 0; c < this.n; c++) { this.tmp.push(new Float32Array(frames)); this.tmp2.push(new Float32Array(frames)); } } }
  /** x, y: arrays of Float32Array (one per channel), `frames` long. p: normalised parameters. */
  process(x, y, frames, p) {
    this._alloc(frames);
    const t = this.tmp.map(a => a.subarray(0, frames)), t2 = this.tmp2.map(a => a.subarray(0, frames));
    this.tape.process(x, t, frames, p.tape);
    this.mb.process(t, t2, frames, p.mb, p.safe && (p.mb.on || this.mb.mix > 0));
    this.grain.process(t2, t, frames, p.grain);          // (always runs: its live buffer fills even while it is off)
    const gOn = p.grain.on;
    const ceil = p.safe && (p.tape.on || this.tape.m > 0 || gOn);
    for (let c = 0; c < this.n; c++) {
      const a = t[c], o = y[c];
      if (ceil && (gOn || (!p.mb.on && this.mb.mix === 0))) for (let i = 0; i < frames; i++) o[i] = softCeil(a[i]); else o.set(a);
    }
  }
  meters() { return { lvl: this.mb.lvl.slice(), gr: this.mb.gr.slice(), tapeGr: this.tape.lastGr || 0 }; }
  /** What the granulator is doing now, for its display. */
  grainInfo() { const g = this.grain; return { n: g.nAct, fill: g.fill, scan: g.scanP, grains: g.grains(40), region: g.useRegion }; }
}

/* ------------------------------------------------------------------ offline helpers */
/** Resample channels by `speed` (>1 plays faster: shorter and higher). Band-limited windowed-sinc. */
function resample(chs, speed) {
  if (speed === 1) return chs;
  const n = chs[0].length, outN = Math.floor(n / speed), half = 16, fc = Math.min(1, 1 / speed) * 0.96, W = Math.ceil(half / fc);
  const TAB = 512, tab = new Float64Array((half * TAB) + 2);
  for (let i = 0; i < tab.length; i++) { const u = i / TAB, a = u / half, w = a >= 1 ? 0 : 0.42 + 0.5 * Math.cos(PI * a) + 0.08 * Math.cos(2 * PI * a); tab[i] = (u === 0 ? 1 : Math.sin(PI * u) / (PI * u)) * w; }
  return chs.map(ch => {
    const o = new Float32Array(outN);
    for (let j = 0; j < outN; j++) {
      const t = j * speed, i0 = Math.floor(t);
      let s = 0;
      for (let k = i0 - W + 1; k <= i0 + W; k++) {
        if (k < 0 || k >= n) continue;
        const u = Math.abs(t - k) * fc; if (u >= half) continue;
        const q = u * TAB, qi = q | 0, f = q - qi;
        s += ch[k] * (tab[qi] + (tab[qi + 1] - tab[qi]) * f);
      }
      o[j] = s * fc;
    }
    return o;
  });
}
/** Render a whole recording: speed, then Tape and Multiband. Returns the new channels (latency removed, echo tail kept). */
async function render(chs, fs, params, onProgress) {
  const p = normalize(params), n = chs.length;
  let region = null;
  if (p.grain.on && p.grain.src === 'region') region = await bakeRegion(chs, fs, p);
  let x = p.speed !== 1 ? resample(chs, p.speed) : chs;
  if (!p.tape.on && !p.mb.on && !p.grain.on) return x;
  const len = x[0].length;
  const chain = new FxChain(fs, n, { lowLatency: true });
  if (region) chain.grain.setRegion(region);
  const lat = p.tape.on ? chain.latency : 0;
  const tail = (p.tape.on && p.tape.slap > 0.01 ? Math.ceil(fs * (p.tape.slapMs * 0.001 * 7 + 0.3)) : 0) + (p.grain.on ? Math.ceil(fs * (p.grain.size * 0.001 * 2 + 0.25)) : 0);
  const total = len + lat + tail, BLK = 4096;
  const out = x.map(() => new Float32Array(len + tail));
  const inB = x.map(() => new Float32Array(BLK)), outB = x.map(() => new Float32Array(BLK));
  let done = 0, lastYield = Date.now();
  while (done < total) {
    const f = Math.min(BLK, total - done);
    for (let c = 0; c < n; c++) { const b = inB[c]; b.fill(0); if (done < len) b.set(x[c].subarray(done, Math.min(len, done + f))); }
    chain.process(inB.map(b => b.subarray(0, f)), outB.map(b => b.subarray(0, f)), f, p);
    for (let c = 0; c < n; c++) {
      for (let i = 0; i < f; i++) { const k = done + i - lat; if (k >= 0 && k < out[c].length) out[c][k] = outB[c][i]; }
    }
    done += f;
    if (onProgress && Date.now() - lastYield > 40) { onProgress(done / total); await new Promise(r => setTimeout(r, 0)); lastYield = Date.now(); }
  }
  if (onProgress) onProgress(1);
  return out;
}
/** The stretch of the recording the granulator reads from (Region source), run through speed, Tape and Multiband. */
async function bakeRegion(chs, fs, params, onProgress) {
  const p = normalize(params), n = chs[0].length;
  const a = Math.min(n - 1, Math.round(p.grain.rStart * fs)), b = Math.min(n, a + Math.round(p.grain.rLen * fs));
  if (b - a < 64) return null;
  const q = JSON.parse(JSON.stringify(p)); q.grain.on = false;
  return render(chs.map(c => c.subarray(a, b)), fs, q, onProgress);
}
/** A one-line description of the processing, for the file's metadata and the review text. */
function describe(params) {
  const p = normalize(params), parts = [];
  if (p.speed !== 1) parts.push(`speed ${(p.speed * 100).toFixed(p.speed * 100 % 1 ? 1 : 0)}%`);
  if (p.tape.on) {
    const t = p.tape, bits = [];
    if (Math.abs(t.pitch) >= 0.005) bits.push(`pitch ${t.pitch > 0 ? '+' : ''}${t.pitch.toFixed(2)} st`);
    for (const [k, l] of [['sat', 'saturate'], ['tube', 'tube'], ['drive', 'overdrive'], ['comp', 'compress'], ['warmth', 'warmth'], ['wow', 'wow/flutter'], ['slap', 'slap'], ['hiss', 'hiss']]) if (t[k] > 0.004) bits.push(`${l} ${Math.round(t[k] * 100)}%`);
    if (t.hp > 20.5) bits.push(`HP ${Math.round(t.hp)} Hz`);
    if (t.lp < 21900) bits.push(`LP ${t.lp >= 1000 ? (t.lp / 1000).toFixed(1) + ' kHz' : Math.round(t.lp) + ' Hz'}`);
    if (Math.abs(t.vol) >= 0.05) bits.push(`${t.vol > 0 ? '+' : ''}${t.vol.toFixed(1)} dB`);
    parts.push(`tape (${{ cass: 'cassette', '7': '7½ ips', '15': '15 ips', '30': '30 ips' }[t.type]}${bits.length ? ', ' + bits.join(', ') : ''})`);
  }
  if (p.mb.on) {
    const m = p.mb, names = ['low', 'mid', 'high'];
    parts.push(`multiband (${m.lo >= 1000 ? (m.lo / 1000).toFixed(2) + ' kHz' : Math.round(m.lo) + ' Hz'} / ${m.hi >= 1000 ? (m.hi / 1000).toFixed(2) + ' kHz' : Math.round(m.hi) + ' Hz'}, amount ${Math.round(m.amount * 100)}%` +
      m.bands.map((b, i) => `; ${names[i]} ${b.aRat > 1.001 ? `above ${b.aThr.toFixed(0)} dB 1:${b.aRat.toFixed(2)}` : ''}${b.bRat !== 1 ? ` below ${b.bThr.toFixed(0)} dB 1:${b.bRat.toFixed(2)}` : ''}`.replace(/ $/, '')).join('') + ')');
  }
  if (p.grain.on) {
    const g = p.grain, bits = [];
    bits.push(g.src === 'region' ? `region ${g.rStart.toFixed(1)}–${(g.rStart + g.rLen).toFixed(1)} s` : `live buffer ${g.bufSec.toFixed(0)} s${g.freeze ? ' frozen' : ''}`);
    bits.push(`${g.mode === 'cloud' ? 'cloud ' : ''}${g.rate.toFixed(g.rate < 10 ? 1 : 0)} grains/s`, `size ${g.size < 100 ? g.size.toFixed(0) : Math.round(g.size)} ms`);
    bits.push(`position ${Math.round(g.pos * 100)}%`);
    if (g.spray > 0.004) bits.push(`spray ${Math.round(g.spray * 100)}%`);
    if (Math.abs(g.scan) > 0.004) bits.push(`scan ${g.scan.toFixed(2)}x`);
    if (Math.abs(g.pitch) >= 0.005) bits.push(`pitch ${g.pitch > 0 ? '+' : ''}${g.pitch.toFixed(1)} st`);
    if (g.pSpray >= 0.05) bits.push(`pitch spray ${g.pSpray.toFixed(1)} st${g.scale !== 'free' ? ' (' + g.scale + ')' : ''}`);
    if (g.rev > 0.004) bits.push(`reverse ${Math.round(g.rev * 100)}%`);
    bits.push(`wet ${Math.round(g.mix * 100)}%`);
    parts.push(`granulator (${bits.join(', ')})`);
  }
  return parts.join('; ');
}

const api = { defaults, normalize, isNeutral, RANGES, TYPES, SCALES, FxChain, TapeCore, MultibandCore, GranulatorCore, PitchShifter, Oversampler, Biquad, resample, render, bakeRegion, describe, softCeil, quantScale, PV_LAT, HB_M, makeFFT, bandDefaults, grainDefaults };
root.PsFx = api;
if (typeof module !== 'undefined') module.exports = api;

/* ------------------------------------------------------------------ the worklet */
if (typeof registerProcessor === 'function') {
  class PsFxProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const o = (options && options.processorOptions) || {};
      this.n = Math.max(1, Math.min(8, (o.channels | 0) || 2));
      this.chain = new FxChain(sampleRate, this.n);
      this.p = normalize(o.params); this.tick = 0; this.run = true; this.playing = false;
      this.port.onmessage = e => {
        const d = e.data || {};
        if (d.params) this.p = normalize(d.params);
        if (d.region) this.chain.grain.setRegion(d.region.chs);
        if (d.clearRegion) this.chain.grain.clearRegion();
        if (d.transport) { this.playing = !!d.transport.playing; }
      };
    }
    process(inputs, outputs) {
      const out = outputs[0], inp = inputs[0];
      if (!out || !out.length) return true;
      const frames = out[0].length, n = this.n, x = [], y = [];
      for (let c = 0; c < n; c++) { x.push((inp && (inp[c] || inp[0])) || (this.zero || (this.zero = new Float32Array(frames)))); y.push(out[c] || out[0]); }
      const g = this.chain.grain;                                    // the granulator runs while the sound plays, or always if 'free'
      g.hold = !this.playing && !this.p.grain.free;                    // (not playing: the live buffer keeps what it has)
      g.run = this.playing || this.p.grain.free;
      this.chain.process(x, y, frames, this.p);
      if (++this.tick % 6 === 0) { const m = this.chain.meters(); if (this.p.grain.on) m.grain = this.chain.grainInfo(); this.port.postMessage({ meters: m }); }
      return true;
    }
  }
  registerProcessor('ps-fx', PsFxProcessor);
}
})(typeof globalThis !== 'undefined' ? globalThis : this);
