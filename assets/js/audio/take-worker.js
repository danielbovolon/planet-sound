/* Encoder + analyser, off the UI thread. One worker per take. */
import { FlacEncoder } from './flac.js';

/* Uncompressed PCM WAV, written as it records. Plays in every browser and opens
   directly in any DAW. Samples are kept as small chunks so memory stays bounded. */
class WavWriter {
  constructor(o) { this.rate = o.sampleRate; this.ch = o.channels; this.bps = o.bitsPerSample || 24; this.parts = []; this.bytes = 0; }
  pushFloat(chs) {
    const n = chs[0].length, bytesPer = this.bps / 8, scale = 2 ** (this.bps - 1), max = scale - 1, min = -scale;
    const out = new Uint8Array(n * this.ch * bytesPer);
    let o = 0;
    for (let i = 0; i < n; i++) for (let c = 0; c < this.ch; c++) {
      const src = chs[Math.min(c, chs.length - 1)];
      let v = Math.round(src[i] * scale); v = v > max ? max : v < min ? min : v;
      for (let k = 0; k < bytesPer; k++) out[o + k] = (v >> (8 * k)) & 255;
      o += bytesPer;
    }
    this.parts.push(out); this.bytes += out.length;
  }
  finish() {
    const dataLen = this.bytes;
    if (dataLen > 0xffffffff - 36) throw new Error('recording too long for a WAV file');
    const h = new DataView(new ArrayBuffer(44)), str = (o, s) => { for (let i = 0; i < 4; i++) h.setUint8(o + i, s.charCodeAt(i)); };
    const bytesPer = this.bps / 8;
    str(0, 'RIFF'); h.setUint32(4, 36 + dataLen, true); str(8, 'WAVE'); str(12, 'fmt ');
    h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, this.ch, true);
    h.setUint32(24, this.rate, true); h.setUint32(28, this.rate * this.ch * bytesPer, true);
    h.setUint16(32, this.ch * bytesPer, true); h.setUint16(34, this.bps, true);
    str(36, 'data'); h.setUint32(40, dataLen, true);
    return new Blob([h.buffer, ...this.parts], { type: 'audio/wav' });
  }
}
import { Analyzer } from './analysis.js';

let enc = null, an = null, channels = 1, ended = null, lastProgress = 0;
let dualMono = true, gotEnd = false;

function feed(chs) {
  if (dualMono && chs.length === 2) {
    const a = chs[0], b = chs[1];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { dualMono = false; break; }
  }
  if (enc) enc.pushFloat(chs);
  an.push(chs);
  const now = Date.now();
  if (now - lastProgress > 250) {
    lastProgress = now;
    postMessage({ type: 'progress', seconds: an.samples / an.fs, bytes: enc ? enc.bytes : 0 });
  }
}

onmessage = e => {
  const d = e.data;
  if (d.type === 'init') {
    channels = d.channels;
    const o = { sampleRate: d.sampleRate, channels, bitsPerSample: d.bits || 24 };
    enc = d.encode === false ? null : d.format === 'flac' ? new FlacEncoder(o) : new WavWriter(o);
    an = new Analyzer(d.sampleRate, channels);
    dualMono = channels === 2;
    if (d.port) {
      d.port.onmessage = m => {
        if (m.data.chs) feed(m.data.chs);
        if (m.data.end) { gotEnd = true; if (ended) ended(); }
      };
    }
  } else if (d.type === 'data') {
    feed(d.chs);
  } else if (d.type === 'finish') {
    const done = () => {
      const analysis = an.result();
      analysis.dualMono = channels === 2 && dualMono && an.samples > 0;
      const blob = enc ? enc.finish(d.tags || {}) : null;
      postMessage({ type: 'done', blob, analysis });
    };
    if (d.waitForEnd && !gotEnd) ended = done; else done();
  }
};
