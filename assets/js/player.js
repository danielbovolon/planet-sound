/* Playback. The file is streamed untouched; a gain stage brings each entry to
 * a common loudness (−20 LUFS, never pushing peaks above −1 dBFS) so moving
 * between a forest and a market doesn't throw the listener. A two-channel
 * peak meter reads the signal after that gain. */

const TARGET = -20, CEILING = -1;

export class Player {
  constructor({ audio, onTime, onState, meter }) {
    this.a = audio; this.onTime = onTime; this.onState = onState; this.meterCv = meter;
    this.a.crossOrigin = 'anonymous';
    this.a.preload = 'metadata';
    this.levelMatch = true; this.sound = null; this.ctx = null; this.raf = 0;
    this.hold = [-90, -90]; this.holdT = [0, 0]; this.level = [-90, -90];
    this.a.addEventListener('timeupdate', () => this._time());
    this.a.addEventListener('durationchange', () => this._time());
    this.a.addEventListener('play', () => { this.onState('playing'); this._loop(); });
    this.a.addEventListener('pause', () => { this.onState('paused'); });
    this.a.addEventListener('ended', () => { this.onState('ended'); });
    this.a.addEventListener('waiting', () => this.onState('loading'));
    this.a.addEventListener('playing', () => this.onState('playing'));
    this.a.addEventListener('error', () => { if (this.sound) this.onState('error', this.a.error); });
  }
  _graph() {
    if (this.ctx) return;
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
  }
  setLevelMatch(on) { this.levelMatch = on; this._applyGain(); }
  load(sound, url) {
    this.stop();
    this.sound = sound;
    this.a.src = url || '';
    if (url) this.a.load();
    if ('mediaSession' in navigator && sound) {
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: sound.title || 'Recording', artist: sound.place || 'Planet Sound', album: 'Planet Sound' }); } catch {}
    }
    this._applyGain();
    this._time();
    this._drawMeter(true);
  }
  async toggle() {
    if (!this.sound || !this.a.src) return;
    if (!this.a.paused) { this.a.pause(); return; }
    this._graph();
    // iOS/Safari only starts audio inside the tap itself: resume and play synchronously, never await first.
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    const p = this.a.play();
    if (p && p.catch) p.catch(e => { if (e && e.name !== 'AbortError') this.onState('error', e); });
  }
  stop() { try { this.a.pause(); } catch {} cancelAnimationFrame(this.raf); }
  seek(frac) {
    const d = this.duration();
    if (d) { this.a.currentTime = Math.max(0, Math.min(d - 0.01, frac * d)); this._time(); }
  }
  duration() { return isFinite(this.a.duration) && this.a.duration > 0 ? this.a.duration : (this.sound && this.sound.duration) || 0; }
  _time() { this.onTime(this.a.currentTime || 0, this.duration()); }
  _loop() {
    cancelAnimationFrame(this.raf);
    const step = () => {
      this._time(); this._drawMeter();
      if (!this.a.paused) this.raf = requestAnimationFrame(step);
      else this._drawMeter(true);
    };
    this.raf = requestAnimationFrame(step);
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
