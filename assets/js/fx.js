/* Planet Sound — sound shaping: shared state, presets, live preview engine, offline render.
 *
 * The DSP itself lives in audio/fx-dsp.js (one file for the AudioWorklet, the export and the tests).
 * Here:
 *   - fxState        the current settings (Tape + Multiband + speed). One place; the panel, the player and Export all read it.
 *   - FxPlayback     plays a decoded recording through the worklet, so the knobs can be heard while the sound plays.
 *   - renderFx       the same DSP run offline over the whole recording (Export WAV, Export spectrogram).
 *   - spectrogram    a log-frequency spectrogram of any audio, drawn like the archive's own.
 */
const HERE = import.meta.url;

let dspP = null;
/** Load the DSP into the page (the same file the worklet runs). Resolves to the PsFx API. */
export function loadDsp() {
  if (!dspP) dspP = import('./audio/fx-dsp.js').then(() => globalThis.PsFx).catch(e => { dspP = null; throw e; });
  return dspP;
}

/* ------------------------------------------------------------------ presets */
export const TAPE_PRESETS = [
  ['Clean (flat)', {}],
  ['Easy does it', { sat: 0.22, warmth: 0.35, comp: 0.15 }],
  ['Tape compression', { sat: 0.3, comp: 0.7, warmth: 0.3, vol: 1 }],
  ['Slammed', { type: '7', sat: 0.75, drive: 0.35, tube: 0.2, comp: 0.8, warmth: 0.5 }],
  ['Cassette', { type: 'cass', sat: 0.35, warmth: 0.8, wow: 0.45, hiss: 0.25, hp: 40, lp: 12000 }],
  ['Lo-fi tape', { type: 'cass', sat: 0.55, drive: 0.15, wow: 0.8, hiss: 0.55, warmth: 0.6, hp: 120, lp: 5500 }],
  ['Tape slap', { sat: 0.2, warmth: 0.3, slap: 0.55, slapMs: 95 }],
  ['Slowed reel (−5 st)', { type: '7', sat: 0.25, warmth: 0.5, wow: 0.25, __speed: 0.75 }],
  ['Half speed', { sat: 0.25, warmth: 0.5, __speed: 0.5 }],
  ['Octave down (time kept)', { sat: 0.2, warmth: 0.4, pitch: -12 }],
  ['Fast reel (+7 st)', { sat: 0.15, warmth: 0.3, hiss: 0.1, __speed: 1.5 }],
];
const B = (a, b, c) => [a, b, c];
const band = o => ({ on: true, solo: false, inDb: 0, outDb: 0, aThr: 0, aRat: 1, bThr: -90, bRat: 1, atk: 20, rel: 200, ...o });
export const MB_PRESETS = [
  ['Flat (no change)', { bands: B(band({}), band({}), band({})) }],
  ['OTT · classic', {
    lo: 100, hi: 2500, amount: 1, out: -1,
    bands: B(band({ aThr: -24, aRat: 4, bThr: -42, bRat: 2.5, atk: 22, rel: 180, outDb: 1 }),
             band({ aThr: -26, aRat: 4, bThr: -44, bRat: 3, atk: 6, rel: 90 }),
             band({ aThr: -28, aRat: 4, bThr: -46, bRat: 3.5, atk: 1.5, rel: 60, outDb: 1.5 })),
  }],
  ['OTT · reference (screenshot)', {
    lo: 98.3, hi: 1660, amount: 1, time: 1,
    bands: B(band({ inDb: 6, aThr: -21.8, aRat: 1.75, atk: 156, rel: 364 }),
             band({ inDb: 6, aThr: -23.2, aRat: 1.75, atk: 102, rel: 282 }),
             band({ inDb: 6, aThr: -22, aRat: 1.75, atk: 79.5, rel: 219 })),
  }],
  ['Gentle glue', {
    lo: 120, hi: 3000, amount: 1, out: 0,
    bands: B(band({ aThr: -26, aRat: 2, atk: 30, rel: 220 }), band({ aThr: -26, aRat: 2, atk: 20, rel: 160 }), band({ aThr: -28, aRat: 1.8, atk: 8, rel: 120 })),
  }],
  ['Bring up the room', {
    lo: 150, hi: 3500, amount: 1, range: 18,
    bands: B(band({ aThr: -20, aRat: 2, bThr: -50, bRat: 1.6, atk: 40, rel: 300 }),
             band({ aThr: -22, aRat: 2.5, bThr: -52, bRat: 2.4, atk: 12, rel: 200 }),
             band({ aThr: -24, aRat: 2.5, bThr: -54, bRat: 2.2, atk: 5, rel: 150 })),
  }],
  ['Tame the boom (low band)', {
    lo: 140, hi: 3000, amount: 1,
    bands: B(band({ aThr: -32, aRat: 5, atk: 10, rel: 160 }), band({}), band({})),
  }],
  ['Quieten the hiss (expander)', {
    lo: 150, hi: 4000, amount: 1,
    bands: B(band({}), band({}), band({ bThr: -50, bRat: 0.45, atk: 8, rel: 220 })),
  }],
  ['Dense & bright', {
    lo: 90, hi: 2200, amount: 1, out: -2,
    bands: B(band({ aThr: -22, aRat: 3, bThr: -40, bRat: 2, atk: 25, rel: 200 }),
             band({ aThr: -24, aRat: 3.5, bThr: -42, bRat: 2.5, atk: 8, rel: 100 }),
             band({ aThr: -26, aRat: 4, bThr: -44, bRat: 3, atk: 2, rel: 70, outDb: 3 })),
  }],
];

/* ------------------------------------------------------------------ state */
/** The settings every part of the app shares. The Multiband starts on the classic OTT curve, switched off. */
export const fxState = {
  P: null, subs: new Set(), dsp: null,
  async init() {
    if (this.P) return this.P;
    this.dsp = await loadDsp();
    this.P = this.fresh();
    return this.P;
  },
  fresh() {
    const d = this.dsp.defaults();
    Object.assign(d.mb, { ...MB_PRESETS[1][1], on: false, bands: MB_PRESETS[1][1].bands.map(b => ({ ...b })) });
    return this.dsp.normalize(d);
  },
  get() { return this.P; },
  /** change(p): mutate a draft; it is clamped and everyone is told. */
  update(change) {
    const draft = JSON.parse(JSON.stringify(this.P));
    change(draft);
    this.P = this.dsp.normalize(draft);
    for (const f of this.subs) f(this.P);
  },
  reset() { this.P = this.fresh(); for (const f of this.subs) f(this.P); },
  subscribe(f) { this.subs.add(f); return () => this.subs.delete(f); },
  neutral() { return !this.P || this.dsp.isNeutral(this.P); },
  describe() { return this.P ? this.dsp.describe(this.P) : ''; },
};
export function applyTapePreset(draft, preset) {
  const { __speed, ...rest } = preset;
  draft.tape = { ...globalThis.PsFx.defaults().tape, ...rest, on: true };
  draft.speed = __speed || 1;
}
export function applyMbPreset(draft, preset) {
  const d = globalThis.PsFx.defaults().mb;
  draft.mb = { ...d, ...preset, on: true, knee: draft.mb.knee, rms: draft.mb.rms };
  draft.mb.bands = preset.bands.map(b => ({ ...b }));
}

/* ------------------------------------------------------------------ live playback through the worklet */
export class FxPlayback {
  /** @param {{onEnded?:Function}} cb */
  constructor(cb) {
    this.cb = cb || {}; this.ctx = null; this.node = null; this.buffer = null; this.src = null;
    this.playing = false; this.offset = 0; this.t0 = 0; this.rate = 1; this.levelDb = 0; this.params = null; this.meters = null;
    this.an = null; this.ready = false; this.opening = null;
  }
  /** Create the audio context. Call it inside a tap or click: iPhone only starts audio from one. */
  open() {
    if (this.opening) return this.opening;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    try { this.ctx.resume(); } catch {}
    this.opening = (async () => {
      await this.ctx.audioWorklet.addModule(new URL('./audio/fx-dsp.js', HERE));
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      this.split = this.ctx.createChannelSplitter(2);
      this.an = [this.ctx.createAnalyser(), this.ctx.createAnalyser()];
      this.an.forEach(a => { a.fftSize = 1024; a.smoothingTimeConstant = 0; });
      this.gain.connect(this.split);
      this.ready = true;
      this.setLevelDb(this.levelDb);
    })();
    return this.opening;
  }
  async decode(arrayBuffer) {
    await this.open();
    const buf = await new Promise((res, rej) => { const r = this.ctx.decodeAudioData(arrayBuffer, res, rej); if (r && r.then) r.then(res, rej); });
    this.setBuffer(buf);
    return buf;
  }
  setBuffer(buf) {
    this._kill(); this.offset = 0;
    if (this.node) { try { this.node.disconnect(); } catch {} this.node = null; }
    this.buffer = buf;
    const n = Math.min(2, buf.numberOfChannels);
    this.node = new AudioWorkletNode(this.ctx, 'ps-fx', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [n],
      channelCount: n, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      processorOptions: { channels: n, params: this.params },
    });
    this.node.port.onmessage = e => { if (e.data && e.data.meters) this.meters = e.data.meters; };
    this.node.connect(this.gain);
    try { this.split.disconnect(); } catch {}
    this.gain.connect(this.split);
    this.split.connect(this.an[0], 0); this.split.connect(this.an[1], n > 1 ? 1 : 0);
  }
  get duration() { return this.buffer ? this.buffer.duration : 0; }
  position() { return this.buffer ? (this.playing ? Math.min(this.buffer.duration, this.offset + (this.ctx.currentTime - this.t0) * this.rate) : this.offset) : 0; }
  _kill() { const s = this.src; this.src = null; if (s) { s.onended = null; try { s.stop(); } catch {} try { s.disconnect(); } catch {} } }
  _start(off) {
    this._kill();
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer; s.playbackRate.value = this.rate; s.connect(this.node);
    s.onended = () => { if (this.src === s) { this.src = null; this.playing = false; this.offset = this.buffer.duration; if (this.cb.onEnded) this.cb.onEnded(); } };
    s.start(0, Math.max(0, Math.min(off, this.buffer.duration - 0.001)));
    this.src = s; this.t0 = this.ctx.currentTime; this.offset = off; this.playing = true;
  }
  play() {
    if (!this.buffer) return;
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    if (this.offset >= this.buffer.duration - 0.02) this.offset = 0;
    this._start(this.offset);
  }
  pause() { if (!this.buffer) return; this.offset = this.position(); this._kill(); this.playing = false; }
  seek(sec) { if (!this.buffer) return; sec = Math.max(0, Math.min(this.buffer.duration - 0.01, sec)); if (this.playing) this._start(sec); else this.offset = sec; }
  setParams(p) {
    this.params = p;
    if (this.node) this.node.port.postMessage({ params: p });
    this.setSpeed(p.speed);
  }
  setSpeed(r) {
    if (r === this.rate) return;
    if (this.playing && this.src) { this.offset = this.position(); this.t0 = this.ctx.currentTime; this.src.playbackRate.value = r; }
    this.rate = r;
  }
  setLevelDb(db) {
    this.levelDb = db;
    if (this.gain) this.gain.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx.currentTime, 0.05);
  }
  destroy() {
    this._kill(); this.playing = false;
    try { this.node && this.node.disconnect(); } catch {}
    try { this.ctx && this.ctx.close(); } catch {}
    this.ctx = null; this.node = null; this.buffer = null; this.ready = false; this.opening = null;
  }
}

/* ------------------------------------------------------------------ offline render and spectrogram */
/** Run the chosen processing over a whole recording. chs: Float32Array per channel. Returns new channels. */
export async function renderFx(chs, rate, params, onProgress) {
  const dsp = await loadDsp();
  return dsp.render(chs, rate, params, onProgress);
}

function fftReal(n) {                          // one shared FFT for the spectrogram
  const dsp = globalThis.PsFx; return dsp.makeFFT(n);
}
/**
 * A log-frequency spectrogram (30 Hz to 22 kHz, like the archive's) of the given channels, drawn in `ink` on `bg`.
 * @returns {HTMLCanvasElement}
 */
export async function spectrogram(chs, rate, { ink = '#1E2B4D', bg = '#F7F7F4', width = 1600, height = 420 } = {}) {
  await loadDsp();
  const N = 2048, H = N / 2, fft = fftReal(N), len = chs[0].length;
  const mono = new Float32Array(len);
  for (let c = 0; c < chs.length; c++) for (let i = 0; i < len; i++) mono[i] += chs[c][i] / chs.length;
  const win = new Float64Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const fMin = 30, fMax = Math.min(22000, rate / 2 * 0.98), lr = Math.log(fMax / fMin);
  const rowBin = new Float64Array(height);
  for (let y = 0; y < height; y++) rowBin[y] = (fMin * Math.exp(lr * (1 - y / (height - 1)))) / (rate / N);
  const cv = document.createElement('canvas'); cv.width = width; cv.height = height;
  const g = cv.getContext('2d'), img = g.createImageData(width, height);
  const parse = c => { const e = document.createElement('canvas').getContext('2d'); e.fillStyle = c; e.fillRect(0, 0, 1, 1); const d = e.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]]; };
  const I = parse(ink), Bg = parse(bg);
  const re = new Float64Array(N), im = new Float64Array(N), mag = new Float64Array(H + 1);
  let last = 0;
  for (let x = 0; x < width; x++) {
    const c0 = Math.round((len - N) * (width === 1 ? 0 : x / (width - 1)));
    for (let k = 0; k < N; k++) { const i = c0 + k; re[k] = (i >= 0 && i < len ? mono[i] : 0) * win[k]; im[k] = 0; }
    fft.forward(re, im);
    for (let k = 0; k <= H; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / (N / 4);
    for (let y = 0; y < height; y++) {
      const b = rowBin[y], k0 = Math.min(H - 1, Math.floor(b)), f = b - k0;
      const m = Math.max(mag[k0] * (1 - f) + mag[k0 + 1] * f, 1e-9);
      const db = 20 * Math.log10(m);
      let a = (db + 96) / 70; a = a < 0 ? 0 : a > 1 ? 1 : a; a = Math.pow(a, 1.15);
      const o = (y * width + x) * 4;
      img.data[o] = Bg[0] + (I[0] - Bg[0]) * a; img.data[o + 1] = Bg[1] + (I[1] - Bg[1]) * a; img.data[o + 2] = Bg[2] + (I[2] - Bg[2]) * a; img.data[o + 3] = 255;
    }
    if (x - last > 40) { last = x; await new Promise(r => setTimeout(r, 0)); }
  }
  g.putImageData(img, 0, 0);
  return cv;
}
