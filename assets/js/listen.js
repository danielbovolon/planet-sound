/* Planet Sound — listen back to a take right after recording.
 *
 * Why it is built like this (phones are strict):
 *   - iPhone only starts sound from a tap, and only if play() is called *inside* that tap, not after an
 *     `await`. So everything slow (reading the file, making a 16-bit copy, loading the audio element) is done
 *     as soon as the take exists, and the tap itself only calls play() on an element that is already loaded.
 *   - An <audio> element plays through the speaker even when the ringer switch is off; Web Audio does not.
 *     So the element is the first choice.
 *   - After the microphone has been used, iOS can leave its audio session on the quiet earpiece route. Setting
 *     `navigator.audioSession.type = 'playback'` (where it exists) puts playback back on the speaker.
 *   - The recorder's 24-bit WAV is converted to a 16-bit copy for the preview, which every browser plays.
 *   - If the element cannot play it, a WAV take is played through Web Audio from our own decoding (no
 *     decodeAudioData, which is what fails on very long takes).
 */
import { isWav, parseWav } from './wav.js';

const AC = () => window.AudioContext || window.webkitAudioContext;

/** Read the WAV format: { tag, channels, rate, bits, align } */
function readFmt(fmt) {
  const dv = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
  let tag = dv.getUint16(0, true);
  const channels = dv.getUint16(2, true), rate = dv.getUint32(4, true), align = dv.getUint16(12, true), bits = dv.getUint16(14, true);
  if (tag === 0xFFFE && fmt.byteLength >= 26) tag = dv.getUint16(24, true);
  return { tag, channels, rate, bits, align };
}

/** Sample i of channel c as a float in -1..1, for any PCM / float WAV. */
function sampler(data, f) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength), B = f.bits / 8, step = f.align || f.channels * B;
  if (f.tag === 3 && f.bits === 32) return (i, c) => dv.getFloat32(i * step + c * 4, true);
  if (f.tag === 3 && f.bits === 64) return (i, c) => dv.getFloat64(i * step + c * 8, true);
  if (f.bits === 16) return (i, c) => dv.getInt16(i * step + c * 2, true) / 32768;
  if (f.bits === 24) return (i, c) => { const o = i * step + c * 3; let v = data[o] | (data[o + 1] << 8) | (data[o + 2] << 16); if (v & 0x800000) v -= 0x1000000; return v / 8388608; };
  if (f.bits === 32) return (i, c) => dv.getInt32(i * step + c * 4, true) / 2147483648;
  if (f.bits === 8) return (i, c) => (data[i * step + c] - 128) / 128;
  return null;
}

/** A plain 16-bit stereo-or-mono PCM WAV (44-byte header) made from any WAV master. Null if it can't. */
export function previewWav(ab) {
  const w = parseWav(ab); if (!w) return null;
  const f = readFmt(w.fmt), get = sampler(w.data, f);
  if (!get || !f.channels || !f.rate) return null;
  if (f.tag === 1 && f.bits === 16 && f.channels <= 2) return new Blob([ab], { type: 'audio/wav' });   // already fine
  const nch = Math.min(2, f.channels), frames = Math.floor(w.data.length / (f.align || f.channels * (f.bits / 8)));
  const out = new Uint8Array(44 + frames * nch * 2), dv = new DataView(out.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + frames * nch * 2, true); str(8, 'WAVEfmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, nch, true); dv.setUint32(24, f.rate, true); dv.setUint32(28, f.rate * nch * 2, true);
  dv.setUint16(32, nch * 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, frames * nch * 2, true);
  let o = 44;
  for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) {
    let x = get(i, c); x = x > 1 ? 1 : x < -1 ? -1 : x;
    dv.setInt16(o, Math.round(x < 0 ? x * 32768 : x * 32767), true); o += 2;
  }
  return new Blob([out], { type: 'audio/wav' });
}

/** Our own decoding of a WAV into Float32Arrays, for the Web Audio fallback. */
function wavChannels(ab) {
  const w = parseWav(ab); if (!w) return null;
  const f = readFmt(w.fmt), get = sampler(w.data, f); if (!get) return null;
  const nch = Math.min(2, f.channels), frames = Math.floor(w.data.length / (f.align || f.channels * (f.bits / 8)));
  const chs = []; for (let c = 0; c < nch; c++) chs.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) chs[c][i] = get(i, c);
  return { chs, rate: f.rate };
}

export class Listener {
  /** @param {{onTime?:(sec:number)=>void, onEnd?:()=>void, onState?:(playing:boolean)=>void, onError?:(text:string)=>void}} cb */
  constructor(cb) {
    this.cb = cb || {}; this.seq = 0; this.reset();
  }
  reset() {
    this.master = null; this.blob = null; this.url = null; this.audio = null; this.mode = ''; this.ready = false; this.want = false;
    this.playing = false; this.raf = 0; this.ctx = null; this.src = null; this.t0 = 0; this.duration = 0; this.wa = null;
  }
  /** Get a take ready to play. Call it as soon as the take exists. */
  async prepare(master, duration) {
    this.dispose(); const id = ++this.seq;
    this.master = master; this.duration = duration || 0;
    let blob = master;
    try {
      const head = new Uint8Array(await master.slice(0, 12).arrayBuffer());
      const riff = head.length >= 12 && String.fromCharCode(...head.slice(0, 4)) === 'RIFF' && String.fromCharCode(...head.slice(8, 12)) === 'WAVE';
      if (riff) { const ab = await master.arrayBuffer(); if (id !== this.seq) return; blob = previewWav(ab) || master; this._ab = ab.byteLength < 120e6 ? ab : null; }
    } catch (e) { console.warn('preview copy', e); blob = master; }
    if (id !== this.seq) return;
    this.blob = blob; this.url = URL.createObjectURL(blob);
    const a = new Audio(); a.preload = 'auto'; a.setAttribute('playsinline', ''); a.src = this.url;
    this.audio = a;
    a.addEventListener('ended', () => { if (this.audio === a && this.playing) this._finish(true); });
    a.addEventListener('error', () => { if (this.audio === a && this.playing) this._fallback('error'); });
    const ok = await new Promise(res => {
      let done = false; const fin = v => { if (!done) { done = true; clearTimeout(t); res(v); } };
      const t = setTimeout(() => fin(a.readyState >= 1), 6000);
      a.addEventListener('loadedmetadata', () => fin(true), { once: true });
      a.addEventListener('error', () => fin(false), { once: true });
      try { a.load(); } catch { fin(false); }
    });
    if (id !== this.seq) return;
    this.mode = ok ? 'el' : (this._canWa() ? 'wa' : 'none');
    this.ready = true;
    if (this.want) { this.want = false; this.tap(); }
  }
  _canWa() { return !!AC() && !!this._ab; }
  /** The tap. Everything here runs synchronously, inside the user's gesture. */
  tap() {
    if (this.playing) { this.stop(); return 'stopped'; }
    if (!this.ready) { this.want = true; return 'pending'; }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    if (this.mode === 'el') {
      const a = this.audio;
      try { if (a.ended || (this.duration && a.currentTime >= this.duration - 0.05)) a.currentTime = 0; } catch {}
      this.playing = true; this.cb.onState && this.cb.onState(true); this._loop();
      let p; try { p = a.play(); } catch (e) { this._fallback(e && e.name); return 'playing'; }
      if (p && p.catch) p.catch(e => { if (this.playing) this._fallback(e && e.name); });
      return 'playing';
    }
    if (this.mode === 'wa') return this._playWa() ? 'playing' : 'failed';
    this.cb.onError && this.cb.onError('This browser can’t play the take back. It is stored as recorded and will play on the map.');
    return 'failed';
  }
  _fallback(reason) {
    // the element could not play it: try Web Audio, still inside the same gesture if we are
    if (this.audio) { try { this.audio.pause(); } catch {} }
    this.playing = false; cancelAnimationFrame(this.raf);
    if (reason === 'NotAllowedError') { this.cb.onState && this.cb.onState(false); this.cb.onError && this.cb.onError('The phone did not allow the sound to start. Tap Play once more.'); return; }
    if (this._canWa() && this._playWa()) return;
    this.cb.onState && this.cb.onState(false);
    this.cb.onError && this.cb.onError('This browser can’t play the take back. It is stored as recorded and will play on the map.');
  }
  _playWa() {
    try {
      if (!this.wa) {
        // sync, from the master we already hold; the arrayBuffer was read in prepare() for WAV only if needed
        if (!this._ab) return false;
        const d = wavChannels(this._ab); if (!d) return false;
        const buf = new AudioBuffer({ numberOfChannels: d.chs.length, length: d.chs[0].length, sampleRate: d.rate });
        d.chs.forEach((c, i) => buf.copyToChannel(c, i)); this.wa = buf;
      }
      const ctx = this.ctx || (this.ctx = new (AC())());
      ctx.resume();
      const s = ctx.createBufferSource(); s.buffer = this.wa; s.connect(ctx.destination);
      s.onended = () => { if (this.src === s && this.playing) this._finish(true); };
      this.src = s; s.start(); this.t0 = ctx.currentTime; this.playing = true; this.mode = 'wa';
      this.cb.onState && this.cb.onState(true); this._loop(); return true;
    } catch (e) { console.warn('web audio fallback', e); return false; }
  }
  position() {
    if (this.mode === 'wa' && this.ctx) return Math.max(0, this.ctx.currentTime - this.t0);
    return this.audio ? this.audio.currentTime : 0;
  }
  _loop() {
    cancelAnimationFrame(this.raf);
    const step = () => { if (!this.playing) return; this.cb.onTime && this.cb.onTime(this.position()); this.raf = requestAnimationFrame(step); };
    this.raf = requestAnimationFrame(step);
  }
  _finish(ended) {
    this.playing = false; cancelAnimationFrame(this.raf);
    if (this.audio) { try { this.audio.pause(); this.audio.currentTime = 0; } catch {} }
    if (this.src) { const s = this.src; this.src = null; s.onended = null; try { s.stop(); } catch {} }
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
    this.cb.onState && this.cb.onState(false);
    this.cb.onTime && this.cb.onTime(0);
    if (ended && this.cb.onEnd) this.cb.onEnd();
  }
  stop() { if (this.playing || this.audio) this._finish(false); this.want = false; }
  seek(sec) {
    if (this.mode === 'el' && this.audio) { try { this.audio.currentTime = Math.max(0, sec); } catch {} }
    // the Web Audio fallback plays straight through
  }
  dispose() {
    this.seq++; this.stop();
    if (this.audio) { try { this.audio.removeAttribute('src'); this.audio.load(); } catch {} }
    if (this.url) URL.revokeObjectURL(this.url);
    this._ab = null; this.reset();
  }
}
