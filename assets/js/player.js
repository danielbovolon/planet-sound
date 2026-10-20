/* Playback. The file is streamed untouched; a gain stage brings each entry to
 * a common loudness (−20 LUFS, never pushing peaks above −1 dBFS) so moving
 * between a forest and a market doesn't throw the listener. A two-channel
 * peak meter reads the signal after that gain.
 *
 * Sound shaping (Tape, Multiband, speed): when the listener turns any of it on, the recording is decoded
 * once and played through the effects (fx.js) instead of through the audio element, from the same
 * position. Nothing changes for anyone who doesn't touch it. */
import { FxPlayback } from './fx.js';

const TARGET = -20, CEILING = -1;

export class Player {
  constructor({ audio, onTime, onState, meter }) {
    this.a = audio; this.onTime = onTime; this.onState = onState; this.meterCv = meter;
    // Phones (iPhone Safari especially) are strict about cross-origin media: with crossOrigin set, the
    // Range preflight can fail and playback stops. On touch devices play the file plainly instead, and
    // do the level matching with the element's own volume (attenuation only) rather than a Web Audio graph.
    this.phone = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
    // Safari (desktop and iPhone) can't reliably play FLAC in an audio element. Those browsers get a
    // 16-bit WAV copy, which plays everywhere. Brave and Chrome keep playing the FLAC directly.
    this.needWav = this.phone || /^((?!chrome|chromium|android|crios|edg).)*safari/i.test(navigator.userAgent);
    if (!this.phone) this.a.crossOrigin = 'anonymous';
    this.a.preload = 'metadata';
    this.levelMatch = true; this.sound = null; this.ctx = null; this.raf = 0;
    this.hold = [-90, -90]; this.holdT = [0, 0]; this.level = [-90, -90];
    this.fxp = null; this.fxMode = false; this.fxReady = false; this.fxPrep = null; this.fxError = '';
    this.rawBlob = null; this.srcUrl = ''; this.loop = false;
    this.a.addEventListener('timeupdate', () => { if (!this.fxMode) this._time(); });
    this.a.addEventListener('durationchange', () => { if (!this.fxMode) this._time(); });
    this.a.addEventListener('play', () => { if (this.fxMode) return; this.onState('playing'); this._loop(); });
    this.a.addEventListener('pause', () => { if (this.fxMode) return; this.onState('paused'); });
    this.a.addEventListener('ended', () => { if (this.fxMode) return; this.onState('ended'); });
    this.a.addEventListener('waiting', () => { if (!this.fxMode) this.onState('loading'); });
    this.a.addEventListener('playing', () => { if (!this.fxMode) this.onState('playing'); });
    this.a.addEventListener('error', () => { if (this.sound && !this.fxMode) this.onState('error', this.a.error); });
  }
  _graph() {
    if (this.ctx || this.phone) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.src = this.ctx.createMediaElementSource(this.a);
      this.gain = this.ctx.createGain();
      this.split = this.ctx.createChannelSplitter(2);
      this.an = [this.ctx.createAnalyser(), this.ctx.createAnalyser()];
      this.an.forEach(a => { a.fftSize = 1024; a.smoothingTimeConstant = 0; });
      this.src.connect(this.gain); this.gain.connect(this.ctx.destination);
      this.gain.connect(this.split); this.split.connect(this.an[0], 0); this.split.connect(this.an[1], 1);
      this.buf = new Float32Array(1024);
      this.elAn = this.an;
      this._applyGain();
    } catch (e) { console.warn('Web Audio unavailable; playing without level matching', e); this.ctx = null; }
  }
  gainDb() {
    const s = this.sound; if (!s || !this.levelMatch || s.tech == null || s.tech.lufs == null) return 0;
    let g = TARGET - s.tech.lufs;
    if (s.tech.peakDb != null) g = Math.min(g, CEILING - s.tech.peakDb);
    return Math.max(-18, Math.min(24, g));
  }
  _applyGain() {
    if (this.gain) this.gain.gain.setTargetAtTime(10 ** (this.gainDb() / 20), this.ctx.currentTime, 0.05);
    else if (this.phone) this.a.volume = Math.max(0, Math.min(1, 10 ** (this.gainDb() / 20)));
    if (this.fxp && this.fxp.ready) this.fxp.setLevelDb(this.gainDb());
  }
  setLevelMatch(on) { this.levelMatch = on; this._applyGain(); }
  /** Loop the recording. Works the same through the plain element and through the effects engine. */
  setLoop(on) { this.loop = !!on; this.a.loop = this.loop; if (this.fxp) this.fxp.setLoop(this.loop); }
  isPlaying() { return this.fxMode ? !!(this.fxp && this.fxp.playing) : !this.a.paused; }
  load(sound, url) {
    this.stop();
    this.sound = sound;
    this.seq = (this.seq || 0) + 1;
    this.srcUrl = url || ''; this.rawBlob = null;
    this.a.src = url || '';
    // Every browser: play a downloaded copy (same-origin blob) once it's ready. The streamed link
    // gave decode errors (code 3) on Brave and iPhone, while the downloaded file plays correctly.
    if (url) this._prefetch(url, this.seq);
    if (url) this.a.load();
    if ('mediaSession' in navigator && sound) {
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: sound.title || 'Recording', artist: sound.place || 'Planet Sound', album: 'Planet Sound' }); } catch {}
    }
    this._applyGain();
    this._time();
    this._drawMeter(true);
  }
  /* iPhone Safari can stall while streaming a file in pieces, with the play button
     showing "playing" but no sound. On phones, download the whole recording in the
     background as soon as it is opened and play that copy; the direct link stays as
     the fallback until the copy is ready. */
  _prefetch(url, seq) {
    const q = () => this.seq === seq;
    fetch(url, { cache: 'no-store' }).then(r => (r.ok ? r.blob() : null)).then(async b => {
      if (b && q()) this.rawBlob = b;                 // kept for sound shaping, which decodes the original
      if (!b || !q() || !this.a.paused) return;
      if (this.needWav && !/\.wav$/i.test(url)) { try { b = await this._toWav(b); } catch (e) { console.warn('WAV copy failed', e); } }
      if (!q() || !this.a.paused) return;
      if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = URL.createObjectURL(b);
      if (this.fxMode) return;
      this.a.src = this.blobUrl; this.a.load();
    }).catch(() => {});
  }
  /* Decode the FLAC with the browser's own decoder and re-pack it as 16-bit PCM WAV.
     Long recordings are left as they are, to keep memory use sensible. */
  async _toWav(blob) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const data = await blob.arrayBuffer();
    const audio = await new Promise((res, rej) => { const r = ctx.decodeAudioData(data, res, rej); if (r && r.then) r.then(res, rej); });
    ctx.close && ctx.close().catch(() => {});
    return encodeWav(audio);
  }
  async toggle() {
    if (!this.sound || !this.a.src) return;
    if (this.fxMode) {
      if (this.fxp.playing) { this.fxp.pause(); this.onState('paused'); }
      else { this.fxp.play(); this.onState('playing'); this._loop(); }
      return;
    }
    if (!this.a.paused) { this.a.pause(); return; }
    this._graph();
    // iOS/Safari only starts audio inside the tap itself: resume and play synchronously, never await first.
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    const p = this.a.play();
    if (p && p.catch) p.catch(e => { if (e && e.name !== 'AbortError') this.onState('error', e); });
  }
  stop() { this.fxDrop(); try { this.a.pause(); } catch {} cancelAnimationFrame(this.raf); }
  seek(frac) {
    const d = this.duration();
    if (!d) return;
    if (this.fxMode) { this.fxp.seek(Math.max(0, Math.min(d - 0.01, frac * d))); this._time(); return; }
    this.a.currentTime = Math.max(0, Math.min(d - 0.01, frac * d)); this._time();
  }
  duration() {
    if (this.fxMode) return this.fxp.duration;
    return isFinite(this.a.duration) && this.a.duration > 0 ? this.a.duration : (this.sound && this.sound.duration) || 0;
  }
  _time() {
    if (this.fxMode) { const sp = this.fxp.rate || 1; this.onTime(this.fxp.position() / sp, this.fxp.duration / sp); return; }
    this.onTime(this.a.currentTime || 0, this.duration());
  }
  _loop() {
    cancelAnimationFrame(this.raf);
    const step = () => {
      this._time(); this._drawMeter();
      const playing = this.fxMode ? this.fxp.playing : !this.a.paused;
      if (playing) this.raf = requestAnimationFrame(step);
      else this._drawMeter(true);
    };
    this.raf = requestAnimationFrame(step);
  }

  /* ---------------- sound shaping ---------------- */
  /** Call inside a tap or click. Starts the audio engine and decodes the recording in the background.
   *  Resolves true when the effects can be heard live, false when this browser can't. */
  fxPrepare() {
    if (!this.sound || !this.srcUrl) return Promise.resolve(false);
    if (this.fxPrep) return this.fxPrep;
    this.fxError = '';
    if (!(window.AudioContext || window.webkitAudioContext) || !window.AudioWorkletNode) { this.fxError = 'Live preview needs a newer browser. Export still works.'; return (this.fxPrep = Promise.resolve(false)); }
    const seq = this.seq, fxp = new FxPlayback({ onEnded: () => { if (!this.fxMode) return; if (this.loop && this.fxp) { this.fxp.seek(0); this.fxp.play(); this.onState('playing'); this._loop(); } else this.onState('ended'); }, onBake: s => { if (this.fxp === fxp && this.onFxBake) this.onFxBake(s); } });
    this.fxp = fxp; fxp.loop = this.loop;
    const opened = fxp.open();                       // the audio context is created here, inside the tap
    this.fxPrep = (async () => {
      await opened;
      let blob = this.rawBlob;
      if (!blob) { const r = await fetch(this.srcUrl, { cache: 'no-store' }); if (!r.ok) throw new Error('download'); blob = await r.blob(); if (seq === this.seq) this.rawBlob = blob; }
      if (seq !== this.seq || this.fxp !== fxp) return false;
      if (this.sound && this.sound.tech && this.sound.tech.audioBytes > 400 * 1024 * 1024) throw new Error('too large');
      await fxp.decode(await blob.arrayBuffer());
      if (seq !== this.seq || this.fxp !== fxp) return false;
      fxp.setLevelDb(this.gainDb());
      this.fxReady = true;
      return true;
    })().catch(e => {
      console.warn('sound shaping unavailable', e);
      if (this.fxp === fxp) { this.fxError = /too large/.test(e && e.message) ? 'This recording is too large to preview live. Export still works.' : 'Live preview isn’t available here. Export still works.'; this.fxDrop(); }
      return false;
    });
    return this.fxPrep;
  }
  /** Route playback through the effects (from the same position) and give them these settings. */
  fxUse(params) {
    if (!this.fxReady || !this.fxp) return false;
    this.fxp.setParams(params);
    if (!this.fxMode) {
      this.fxMode = true;
      const was = !this.a.paused, pos = this.a.currentTime || 0;
      try { this.a.pause(); } catch {}
      this.an = this.fxp.an; if (!this.buf) this.buf = new Float32Array(1024);
      this.fxp.seek(pos);
      if (was) this.fxp.play();
      this._applyGain();
      this.onState(this.fxp.playing ? 'playing' : 'paused');
      if (this.fxp.playing) this._loop();
    }
    this._time();
    return true;
  }
  /** Free the effects engine (a new sound, or the panel closed). */
  fxDrop() {
    const fxp = this.fxp, was = this.fxMode;
    this.fxMode = false; this.fxReady = false; this.fxPrep = null; this.fxp = null;
    this.an = this.elAn;                             // the element's own meter taps (none until it has played)
    if (fxp) fxp.destroy();
    if (was) { cancelAnimationFrame(this.raf); this.onState('paused'); }
  }
  _drawMeter(reset) {
    const cv = this.meterCv; if (!cv) return;
    const dpr = Math.min(2, devicePixelRatio || 1), w = cv.clientWidth || 120, h = cv.clientHeight || 14;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const ink = css('--ink'), rule = css('--rule'), signal = css('--signal');
    const now = performance.now();
    for (let c = 0; c < 2; c++) {
      let db = -90;
      if (!reset && this.an) {
        this.an[c].getFloatTimeDomainData(this.buf);
        let pk = 0; for (let i = 0; i < this.buf.length; i++) { const v = Math.abs(this.buf[i]); if (v > pk) pk = v; }
        db = pk > 0 ? 20 * Math.log10(pk) : -90;
      }
      // PPM-like: instant rise, 20 dB/s fall, 1.5 s peak hold
      this.level[c] = reset ? -90 : (db > this.level[c] ? db : Math.max(db, this.level[c] - 20 / 60));
      if (db >= this.hold[c] || now - this.holdT[c] > 1500) { this.hold[c] = reset ? -90 : db; this.holdT[c] = now; }
      const y = c ? h / 2 + 1 : 0, bh = h / 2 - 1;
      const x = v => Math.max(0, Math.min(1, (v + 60) / 60)) * w;
      g.fillStyle = rule; g.fillRect(0, y, w, bh);
      g.fillStyle = this.level[c] > -3 ? signal : ink; g.fillRect(0, y, x(this.level[c]), bh);
      if (this.hold[c] > -60) { g.fillStyle = this.hold[c] > -1 ? signal : ink; g.fillRect(x(this.hold[c]) - 1, y, 2, bh); }
    }
  }
}

/** Draw a stored envelope (0..255 on a −60…0 dBFS scale), mirrored. */
export function drawWave(cv, peaks, progress = 0) {
  const dpr = Math.min(2, devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const ink = css('--ink'), soft = css('--graphite');
  const mid = h / 2;
  if (!peaks || !peaks.length) { g.fillStyle = soft; g.globalAlpha = 0.35; g.fillRect(0, mid - 0.5, w, 1); g.globalAlpha = 1; return; }
  const bar = 2, gap = 1, n = Math.floor(w / (bar + gap));
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * peaks.length / n), b = Math.max(a + 1, Math.floor((i + 1) * peaks.length / n));
    let m = 0; for (let k = a; k < b; k++) if (peaks[k] > m) m = peaks[k];
    const hh = Math.max(1, (m / 255) * (h / 2 - 1));
    const x = i * (bar + gap);
    const played = x / w <= progress;
    g.fillStyle = played ? ink : soft; g.globalAlpha = played ? 1 : 0.45;
    g.fillRect(x, mid - hh, bar, hh * 2);
  }
  g.globalAlpha = 1;
}

/** 16-bit PCM WAV from a decoded AudioBuffer (max two channels). */
export function encodeWav(buf) {
  const ch = Math.min(2, buf.numberOfChannels), rate = buf.sampleRate, n = buf.length;
  if (n / rate > 45 * 60) throw new Error('recording too long to convert');
  const bytes = n * ch * 2, out = new DataView(new ArrayBuffer(44 + bytes));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + bytes, true); str(8, 'WAVE'); str(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, bytes, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const v = Math.max(-1, Math.min(1, chans[c][i]));
    out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2;
  }
  return new Blob([out], { type: 'audio/wav' });
}
