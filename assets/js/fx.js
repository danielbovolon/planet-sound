/* Planet Sound — sound shaping: shared state, presets, live preview engine, offline render.
 *
 * The DSP itself lives in audio/fx-dsp.js (one file for the AudioWorklet, the export and the tests).
 * Here:
 *   - fxState        the current settings (speed, Tape, Multiband, Granulator, Delay, Reverb). One place; the panel, the player and Export all read it.
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
  ['OTT', {
    lo: 100, hi: 2500, amount: 1, out: -1,
    bands: B(band({ aThr: -24, aRat: 4, bThr: -42, bRat: 2.5, atk: 22, rel: 180, outDb: 1 }),
             band({ aThr: -26, aRat: 4, bThr: -44, bRat: 3, atk: 6, rel: 90 }),
             band({ aThr: -28, aRat: 4, bThr: -46, bRat: 3.5, atk: 1.5, rel: 60, outDb: 1.5 })),
  }],
  ['Multiband compression', {
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

export const GRAIN_PRESETS = [
  ['Texture cloud', { mode: 'cloud', rate: 30, size: 180, spray: 0.6, pan: 0.7, mix: 0.65 }],
  ['Shimmer (+12 st)', { mode: 'cloud', rate: 40, size: 140, pitch: 12, spray: 0.5, pan: 0.6, mix: 0.4, lp: 12000 }],
  ['Frozen pad (hold the buffer)', { mode: 'cloud', rate: 14, size: 650, spray: 0.35, pan: 0.85, mix: 0.85, freeze: true, lp: 9000, free: true }],
  ['Octave swarm', { mode: 'cloud', rate: 60, size: 90, pSpray: 12, scale: 'octaves', spray: 0.8, pan: 0.7, mix: 0.5 }],
  ['Pentatonic rain', { mode: 'cloud', rate: 25, size: 260, pSpray: 12, scale: 'pentatonic', spray: 0.5, pan: 0.8, mix: 0.6 }],
  ['Time-stretch (slow scan)', { src: 'region', rate: 25, size: 200, spray: 0.04, scan: 0.1, pan: 0.2, mix: 1 }],
  ['Glitch stutter', { rate: 12, size: 60, jitter: 0.4, spray: 0.05, rev: 0.3, smooth: 0.25, pan: 0.5, mix: 0.6 }],
  ['Reverse wash', { rev: 1, rate: 18, size: 420, spray: 0.3, pan: 0.5, mix: 0.6, lp: 7000 }],
  ['Rumble (−12 st)', { rate: 12, size: 350, pitch: -12, spray: 0.2, pan: 0.3, mix: 0.7, lp: 4000 }],
  ['Dust (sparse grains)', { mode: 'cloud', rate: 3, size: 90, pSpray: 7, spray: 1, pan: 1, mix: 0.7 }],
  ['Chirps (rising grains)', { mode: 'cloud', rate: 20, size: 120, glide: 12, gSpray: 6, win: 'expo', smooth: 0.5, spray: 0.5, pan: 0.8, mix: 0.6 }],
  ['Falling grains', { rate: 15, size: 400, glide: -12, gSpray: 4, win: 'gauss', spray: 0.4, pan: 0.7, mix: 0.65 }],
  ['Rhythmic (probability)', { mode: 'sync', rate: 8, size: 90, prob: 0.55, win: 'expo', smooth: 0.7, panMode: 'alt', pan: 0.9, spray: 0.1, mix: 0.7 }],
  ['Wandering scanner (LFO)', { rate: 30, size: 220, spray: 0.15, lfoRate: 0.12, lfoShape: 'drift', lfoPos: 0.9, lfoPitch: 3, pan: 0.6, mix: 0.75 }],
  ['Filter-swept cloud', { mode: 'cloud', rate: 40, size: 160, spray: 0.5, lfoRate: 0.25, lfoShape: 'sine', lfoCut: 0.8, lp: 6000, pan: 0.7, mix: 0.7 }],
  ['Feedback swarm', { mode: 'cloud', rate: 45, size: 240, pitch: 7, pSpray: 5, scale: 'fifths', fb: 0.7, spray: 0.4, pan: 0.8, mix: 0.6, lp: 9000 }],
  ['Bit-crushed glitch', { rate: 14, size: 70, jitter: 0.5, rev: 0.4, bits: 7, down: 6, win: 'trap', panMode: 'alt', pan: 0.8, spray: 0.1, mix: 0.6 }],
  ['Swelling octaves', { mode: 'cloud', rate: 6, size: 900, win: 'rexpo', smooth: 0.4, spray: 0.3, pSpray: 12, scale: 'octaves', panMode: 'pitch', pan: 0.9, mix: 0.7 }],
  ['Stepping pitch (random LFO)', { mode: 'sync', rate: 12, size: 110, lfoRate: 3, lfoShape: 'random', lfoPitch: 12, pan: 0.6, mix: 0.6 }],
];

export const DELAY_PRESETS = [
  ['Slapback', { mode: 'mono', time: 95, fb: 0.08, mix: 0.3, lc: 120, hc: 6000 }],
  ['Quarter-second echo', { mode: 'stereo', time: 250, fb: 0.35, mix: 0.3 }],
  ['Ping-pong', { mode: 'pingpong', time: 330, fb: 0.5, mix: 0.35, hc: 8000 }],
  ['Tape echo (dark, wobbly)', { mode: 'mono', time: 380, fb: 0.55, mix: 0.35, lc: 180, hc: 3200, drive: 0.45, modRate: 0.7, modDepth: 0.35 }],
  ['Dub (long feedback)', { mode: 'pingpong', time: 500, fb: 0.8, mix: 0.4, lc: 250, hc: 2400, drive: 0.3, duck: 0.4 }],
  ['Canyon (diffused)', { mode: 'stereo', time: 700, offset: 12, fb: 0.6, mix: 0.35, diffuse: 0.8, hc: 5000 }],
  ['Doubling (short, moving)', { mode: 'stereo', time: 18, offset: -30, fb: 0, mix: 0.45, modRate: 0.8, modDepth: 0.6, lc: 20, hc: 22000 }],
  ['Stutter', { mode: 'pingpong', time: 90, fb: 0.7, mix: 0.5, lc: 400, hc: 7000 }],
  ['Ducked echo (for voices)', { mode: 'stereo', time: 300, offset: 8, fb: 0.45, mix: 0.4, duck: 0.8 }],
];
export const VERB_PRESETS = [
  ['Small room', { size: 0.2, decay: 0.5, pre: 5, damp: 6000, early: 0.7, diff: 0.7, mix: 0.25 }],
  ['Wooden chamber', { size: 0.4, decay: 1.2, pre: 12, damp: 5000, bass: 1.2, early: 0.5, mix: 0.3 }],
  ['Concert hall', { size: 0.75, decay: 2.6, pre: 25, damp: 7000, bass: 1.3, early: 0.35, mod: 0.3, mix: 0.3 }],
  ['Plate', { size: 0.45, decay: 2, pre: 0, damp: 12000, bass: 0.8, early: 0, diff: 1, mod: 0.2, lc: 150, mix: 0.3 }],
  ['Bright ambience', { size: 0.3, decay: 0.8, pre: 8, damp: 16000, early: 0.6, lc: 200, mix: 0.2 }],
  ['Dark cave', { size: 0.85, decay: 4.5, pre: 40, damp: 1800, bass: 1.6, early: 0.3, mix: 0.35 }],
  ['Cathedral', { size: 1, decay: 7, pre: 60, damp: 4500, bass: 1.4, early: 0.25, mod: 0.4, mix: 0.35 }],
  ['Vast space (20 s)', { size: 1, decay: 20, pre: 120, damp: 3500, early: 0, mod: 0.6, mix: 0.45 }],
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
export function applyGrainPreset(draft, preset) {
  const d = globalThis.PsFx.grainDefaults(), keep = { src: draft.grain.src, bufSec: draft.grain.bufSec, rStart: draft.grain.rStart, rLen: draft.grain.rLen, free: false, freeze: false, seed: draft.grain.seed };
  draft.grain = { ...d, ...keep, ...preset, on: true };
}
export function applyDelayPreset(draft, preset) { draft.delay = { ...globalThis.PsFx.delayDefaults(), ...preset, on: true }; }
export function applyVerbPreset(draft, preset) { draft.verb = { ...globalThis.PsFx.verbDefaults(), ...preset, on: true }; }
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
    this.playing = false; this.offset = 0; this.t0 = 0; this.rate = 1; this.levelDb = 0; this.params = null; this.meters = null; this.loop = false;
    this.an = null; this.ready = false; this.opening = null;
    this.regionSig = ''; this.bakeTimer = 0; this.bakeSeq = 0; this.region = null; this.baking = false;
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
  /** Decode a recording; with `win` ({a, b} seconds) only that stretch is kept. */
  async decode(arrayBuffer, win) {
    await this.open();
    let buf = await new Promise((res, rej) => { const r = this.ctx.decodeAudioData(arrayBuffer, res, rej); if (r && r.then) r.then(res, rej); });
    if (win) {
      const sr = buf.sampleRate, s0 = Math.max(0, Math.round(win.a * sr)), s1 = Math.min(buf.length, Math.round(win.b * sr));
      if (s1 - s0 > 64) { const nb = this.ctx.createBuffer(buf.numberOfChannels, s1 - s0, sr); for (let c = 0; c < buf.numberOfChannels; c++) nb.copyToChannel(buf.getChannelData(c).subarray(s0, s1), c); buf = nb; }
    }
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
    this.regionSig = ''; this.region = null; this._transport();
    if (this.params) this._wantRegion(this.params);
    this.node.connect(this.gain);
    try { this.split.disconnect(); } catch {}
    this.gain.connect(this.split);
    this.split.connect(this.an[0], 0); this.split.connect(this.an[1], n > 1 ? 1 : 0);
  }
  get duration() { return this.buffer ? this.buffer.duration : 0; }
  position() {
    if (!this.buffer) return 0;
    if (!this.playing) return this.offset;
    const p = this.offset + (this.ctx.currentTime - this.t0) * this.rate, d = this.buffer.duration;
    return this.loop ? p % d : Math.min(d, p);
  }
  setLoop(on) { this.loop = !!on; if (this.src) this.src.loop = this.loop; }
  _kill() { const s = this.src; this.src = null; if (s) { s.onended = null; try { s.stop(); } catch {} try { s.disconnect(); } catch {} } }
  _start(off) {
    this._kill();
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer; s.playbackRate.value = this.rate; s.loop = this.loop; s.connect(this.node);
    s.onended = () => { if (this.src === s) { this.src = null; this.playing = false; this.offset = this.buffer.duration; this._transport(); if (this.cb.onEnded) this.cb.onEnded(); } };
    s.start(0, Math.max(0, Math.min(off, this.buffer.duration - 0.001)));
    this.src = s; this.t0 = this.ctx.currentTime; this.offset = off; this.playing = true; this._transport();
  }
  _transport() { if (this.node) this.node.port.postMessage({ transport: { playing: this.playing } }); }
  play() {
    if (!this.buffer) return;
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    if (this.offset >= this.buffer.duration - 0.02) this.offset = 0;
    this._start(this.offset);
  }
  pause() { if (!this.buffer) return; this.offset = this.position(); this._kill(); this.playing = false; this._transport(); }
  seek(sec) { if (!this.buffer) return; sec = Math.max(0, Math.min(this.buffer.duration - 0.01, sec)); if (this.playing) this._start(sec); else this.offset = sec; }
  setParams(p) {
    this.params = p;
    if (this.node) this.node.port.postMessage({ params: p });
    this.setSpeed(p.speed);
    this._wantRegion(p);
  }
  /** The granulator's Region source is a stretch of the recording rendered through speed, Tape and Multiband.
   *  It is rendered again (after a short pause) whenever any of those settings, or the stretch, change. */
  _wantRegion(p) {
    const g = p.grain;
    if (!g || !g.on || g.src !== 'region' || !this.buffer || !this.node) return;
    const sig = JSON.stringify([p.speed, p.tape, p.mb, p.safe, g.rStart, g.rLen]);
    if (sig === this.regionSig) return;
    this.regionSig = sig; clearTimeout(this.bakeTimer);
    const seq = ++this.bakeSeq;
    if (this.cb.onBake) this.cb.onBake({ state: 'waiting' });
    this.bakeTimer = setTimeout(() => this._bake(p, sig, seq), this.region ? 450 : 30);
  }
  async _bake(p, sig, seq) {
    if (!this.buffer || !this.node) return;
    this.baking = true;
    try {
      const dsp = await loadDsp(), b = this.buffer, chs = [];
      for (let c = 0; c < Math.min(2, b.numberOfChannels); c++) chs.push(b.getChannelData(c));
      const out = await dsp.bakeRegion(chs, b.sampleRate, p, f => { if (seq === this.bakeSeq && this.cb.onBake) this.cb.onBake({ state: 'baking', fraction: f }); });
      if (seq !== this.bakeSeq || !this.node) return;
      if (!out) { this.node.port.postMessage({ clearRegion: true }); this.region = null; if (this.cb.onBake) this.cb.onBake({ state: 'empty' }); return; }
      this.region = out;
      this.node.port.postMessage({ region: { chs: out } });       // (structured clone: the page keeps its copy for the display)
      if (this.cb.onBake) this.cb.onBake({ state: 'ready', chs: out });
    } catch (e) { console.warn('granulator region', e); if (this.cb.onBake) this.cb.onBake({ state: 'error' }); this.regionSig = ''; }
    finally { if (seq === this.bakeSeq) this.baking = false; }
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
    clearTimeout(this.bakeTimer); this.bakeSeq++;
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
export async function spectrogram(chs, rate, { ink = '#1E2B4D', bg = '#F7F7F4', width = 1600, height = 420, lut = null } = {}) {
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
      if (lut) { const j = Math.round(a * 255) * 3; img.data[o] = lut[j]; img.data[o + 1] = lut[j + 1]; img.data[o + 2] = lut[j + 2]; }
      else { img.data[o] = Bg[0] + (I[0] - Bg[0]) * a; img.data[o + 1] = Bg[1] + (I[1] - Bg[1]) * a; img.data[o + 2] = Bg[2] + (I[2] - Bg[2]) * a; }
      img.data[o + 3] = 255;
    }
    if (x - last > 40) { last = x; await new Promise(r => setTimeout(r, 0)); }
  }
  g.putImageData(img, 0, 0);
  return cv;
}
