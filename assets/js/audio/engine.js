/* Planet Sound — audio engine (main thread).
 *
 * Recording path:  microphone → AudioWorklet → worker (24-bit WAV + analysis)
 * Import path:     WAV → parsed here → worker (24-bit WAV, or native bit depth)
 *                  anything else → kept untouched as the master, decoded only
 *                  to measure it.
 *
 * Voice processing (echo cancellation, noise suppression, auto gain) is
 * switched off wherever the browser allows it: a field recording should be
 * what the microphone heard, not what a call-quality pipeline made of it.
 */

const here = import.meta.url;
const MAX_IMPORT_BYTES = 500 * 1024 * 1024;

export function supportsRecording() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioWorkletNode);
}

export async function listInputs() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'audioinput');
  } catch { return []; }
}

export async function openInput(deviceId) {
  const base = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } };
  if (deviceId) base.deviceId = { exact: deviceId };
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: base }); }
  catch (e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw e;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  const track = stream.getAudioTracks()[0];
  const s = (track.getSettings && track.getSettings()) || {};
  return {
    stream,
    info: {
      label: track.label || 'Microphone',
      deviceId: s.deviceId || '',
      channels: Math.max(1, Math.min(2, s.channelCount || 1)),
      sampleRate: s.sampleRate || null,
      processingOff: s.echoCancellation === false && s.noiseSuppression === false && s.autoGainControl !== true,
    },
  };
}

export class Recorder {
  /**
   * @param {MediaStream} stream
   * @param {{channels:number, sampleRate?:number|null, onMeter?:Function, onProgress?:Function}} o
   */
  constructor(stream, o) {
    this.stream = stream; this.o = o;
    this.channels = o.channels || 1;
    this.state = 'idle';
  }
  async arm() {
    const AC = window.AudioContext || window.webkitAudioContext;
    try { this.ctx = o_rate(this.o.sampleRate) ? new AC({ sampleRate: this.o.sampleRate, latencyHint: 'interactive' }) : new AC(); }
    catch { this.ctx = new AC(); }
    await this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', here));
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'ps-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: this.channels, channelCountMode: 'explicit', channelInterpretation: 'discrete',
      processorOptions: { channels: this.channels },
    });
    this.node.port.onmessage = e => { if (e.data.meter && this.o.onMeter) this.o.onMeter(e.data.meter); };
    const mute = this.ctx.createGain(); mute.gain.value = 0;
    this.src.connect(this.node); this.node.connect(mute); mute.connect(this.ctx.destination);
    // Don't await: iPhone Safari may never resolve a resume() outside a tap. record() resumes it inside the tap.
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    this.sampleRate = this.ctx.sampleRate;
    this.state = 'armed';
  }
  record() {
    // Called from the Record tap: iPhone only lets the audio context start inside a tap, otherwise the take is silent.
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    this.worker = new Worker(new URL('./take-worker.js', here), { type: 'module' });
    const ch = new MessageChannel();
    this.worker.postMessage({ type: 'init', sampleRate: this.sampleRate, channels: this.channels, bits: 24, format: 'wav', port: ch.port2 }, [ch.port2]);
    this.worker.onmessage = e => { if (e.data.type === 'progress' && this.o.onProgress) this.o.onProgress(e.data); };
    this.node.port.postMessage({ port: ch.port1 }, [ch.port1]);
    this.node.port.postMessage({ cmd: 'record' });
    this.state = 'recording';
    this.startedAt = new Date();
  }
  async stop() {
    if (this.state !== 'recording') return null;
    this.state = 'finishing';
    const done = new Promise(res => {
      this.worker.onmessage = e => {
        if (e.data.type === 'progress' && this.o.onProgress) this.o.onProgress(e.data);
        if (e.data.type === 'done') res(e.data);
      };
    });
    this.node.port.postMessage({ cmd: 'stop' });
    this.worker.postMessage({ type: 'finish', waitForEnd: true });
    const { blob, analysis } = await done;
    this.worker.terminate();
    this.state = 'armed';
    return packResult({
      master: blob, mime: 'audio/wav', ext: 'wav',
      tech: { codec: 'WAV', lossless: true, sampleRate: this.sampleRate, bitDepth: 24, channels: this.channels, source: 'recorded' },
      analysis, recordedAt: this.startedAt,
    });
  }
  async close() {
    try { this.node && this.node.port.postMessage({ cmd: 'stop' }); } catch {}
    try { this.worker && this.worker.terminate(); } catch {}
    try { this.stream.getTracks().forEach(t => t.stop()); } catch {}
    try { this.ctx && await this.ctx.close(); } catch {}
    this.state = 'closed';
  }
}
function o_rate(r) { return typeof r === 'number' && r >= 8000 && r <= 192000; }

/* ---------------- import ---------------- */

export async function importFile(file, onProgress) {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('That file is larger than 500 MB. Trim it or export a shorter version first.');
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const tag = String.fromCharCode(...head.subarray(0, 4));
  if (tag === 'RIFF' && String.fromCharCode(...head.subarray(8, 12)) === 'WAVE') return importWav(file, onProgress);
  return importOther(file, tag, onProgress);
}

async function parseWavHeader(file) {
  const buf = await file.slice(0, Math.min(file.size, 1 << 20)).arrayBuffer();
  const dv = new DataView(buf);
  let p = 12, fmt = null, dataStart = -1, dataLen = 0;
  while (p + 8 <= dv.byteLength) {
    const id = String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
    const len = dv.getUint32(p + 4, true);
    if (id === 'fmt ') {
      let format = dv.getUint16(p + 8, true);
      const channels = dv.getUint16(p + 10, true), sampleRate = dv.getUint32(p + 12, true);
      const blockAlign = dv.getUint16(p + 20, true), bits = dv.getUint16(p + 22, true);
      if (format === 0xfffe && len >= 40) format = dv.getUint16(p + 32, true);
      fmt = { format, channels, sampleRate, blockAlign, bits };
    } else if (id === 'data') {
      dataStart = p + 8; dataLen = Math.min(len || file.size - dataStart, file.size - dataStart);
      break;
    }
    p += 8 + len + (len & 1);
  }
  if (!fmt || dataStart < 0) throw new Error('This WAV file has no readable audio data.');
  if (!((fmt.format === 1 && [16, 24, 32].includes(fmt.bits)) || (fmt.format === 3 && fmt.bits === 32)))
    throw new Error(`Unsupported WAV encoding (${fmt.bits}-bit, format ${fmt.format}). Export as 16- or 24-bit PCM.`);
  return { ...fmt, dataStart, dataLen };
}

async function importWav(file, onProgress) {
  const h = await parseWavHeader(file);
  const channels = Math.min(h.channels, 8);
  const outBits = h.format === 1 && h.bits === 16 ? 16 : 24;
  const worker = new Worker(new URL('./take-worker.js', here), { type: 'module' });
  worker.postMessage({ type: 'init', sampleRate: h.sampleRate, channels, bits: outBits, format: 'wav' });
  const frameBytes = h.blockAlign, bps = h.bits / 8;
  const chunkFrames = 65536;
  const total = Math.floor(h.dataLen / frameBytes);
  for (let f = 0; f < total; f += chunkFrames) {
    const n = Math.min(chunkFrames, total - f);
    const ab = await file.slice(h.dataStart + f * frameBytes, h.dataStart + (f + n) * frameBytes).arrayBuffer();
    const dv = new DataView(ab);
    const chs = Array.from({ length: channels }, () => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      const base = i * frameBytes;
      for (let c = 0; c < channels; c++) {
        const o = base + c * bps;
        let v;
        if (h.format === 3) v = dv.getFloat32(o, true);
        else if (h.bits === 16) v = dv.getInt16(o, true) / 32768;
        else if (h.bits === 24) { let x = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16); v = x / 8388608; }
        else v = dv.getInt32(o, true) / 2147483648;
        chs[c][i] = v;
      }
    }
    worker.postMessage({ type: 'data', chs }, chs.map(c => c.buffer));
    if (onProgress) onProgress({ fraction: (f + n) / total });
  }
  const res = await new Promise(r => { worker.onmessage = e => { if (e.data.type === 'done') r(e.data); }; worker.postMessage({ type: 'finish' }); });
  worker.terminate();
  return packResult({
    master: res.blob, mime: 'audio/wav', ext: 'wav',
    tech: { codec: 'WAV', lossless: true, sampleRate: h.sampleRate, bitDepth: outBits, channels, source: 'imported', convertedFrom: 'WAV' },
    analysis: res.analysis, recordedAt: file.lastModified ? new Date(file.lastModified) : null,
  });
}

function flacInfo(u8) {
  // STREAMINFO follows "fLaC" + 4-byte block header
  if (String.fromCharCode(...u8.subarray(0, 4)) !== 'fLaC') return null;
  const b = u8.subarray(8);
  const sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
  const channels = ((b[12] >> 1) & 7) + 1;
  const bitDepth = (((b[12] & 1) << 4) | (b[13] >> 4)) + 1;
  return { sampleRate, channels, bitDepth };
}

async function importOther(file, tag, onProgress) {
  const ab = await file.arrayBuffer();
  const u8 = new Uint8Array(ab, 0, Math.min(64, ab.byteLength));
  const fi = flacInfo(u8);
  const name = (file.name || '').toLowerCase();
  const ext = fi ? 'flac' : (name.match(/\.([a-z0-9]{2,4})$/) || [, ''])[1] ||
    (file.type.includes('mpeg') ? 'mp3' : file.type.includes('ogg') ? 'ogg' : file.type.includes('webm') ? 'webm' : 'm4a');
  const codec = fi ? 'FLAC' : ({ mp3: 'MP3', m4a: 'AAC', aac: 'AAC', mp4: 'AAC', ogg: 'Ogg', opus: 'Opus', webm: 'WebM', aif: 'AIFF', aiff: 'AIFF' })[ext] || ext.toUpperCase();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let buf;
  try { buf = await ctx.decodeAudioData(ab.slice(0)); }
  catch { await ctx.close().catch(() => {}); throw new Error('This browser cannot read that file. Try WAV, FLAC, MP3 or M4A.'); }
  await ctx.close().catch(() => {});
  const channels = Math.min(buf.numberOfChannels, 8);
  const worker = new Worker(new URL('./take-worker.js', here), { type: 'module' });
  worker.postMessage({ type: 'init', sampleRate: buf.sampleRate, channels, encode: false });
  const step = 65536;
  for (let o = 0; o < buf.length; o += step) {
    const chs = Array.from({ length: channels }, (_, c) => buf.getChannelData(c).slice(o, o + step));
    worker.postMessage({ type: 'data', chs }, chs.map(c => c.buffer));
    if (onProgress) onProgress({ fraction: Math.min(1, (o + step) / buf.length) });
  }
  const res = await new Promise(r => { worker.onmessage = e => { if (e.data.type === 'done') r(e.data); }; worker.postMessage({ type: 'finish' }); });
  worker.terminate();
  const lossless = !!fi || ext === 'aif' || ext === 'aiff';
  return packResult({
    master: file, mime: file.type || (fi ? 'audio/flac' : 'audio/mpeg'), ext,
    tech: {
      codec, lossless,
      sampleRate: fi ? fi.sampleRate : buf.sampleRate,
      bitDepth: fi ? fi.bitDepth : null,
      channels: fi ? fi.channels : buf.numberOfChannels,
      source: 'imported',
    },
    analysis: res.analysis, recordedAt: file.lastModified ? new Date(file.lastModified) : null,
  });
}

/** 24-bit PCM WAV from a decoded AudioBuffer (up to eight channels). */
export function encodeWav24(buf) {
  const ch = Math.min(8, buf.numberOfChannels), rate = buf.sampleRate, n = buf.length, bytesPer = 3;
  const dataLen = n * ch * bytesPer;
  if (dataLen > 0xffffffff - 36) throw new Error('recording too long for a WAV file');
  const out = new Uint8Array(44 + dataLen), h = new DataView(out.buffer);
  const str = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); h.setUint32(4, 36 + dataLen, true); str(8, 'WAVE'); str(12, 'fmt ');
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, ch, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * ch * bytesPer, true);
  h.setUint16(32, ch * bytesPer, true); h.setUint16(34, 24, true);
  str(36, 'data'); h.setUint32(40, dataLen, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    let v = Math.round(Math.max(-1, Math.min(1, chans[c][i])) * 8388607);
    if (v < 0) v += 16777216;
    out[o] = v & 255; out[o + 1] = (v >> 8) & 255; out[o + 2] = (v >> 16) & 255; o += 3;
  }
  return new Blob([out], { type: 'audio/wav' });
}

/* Insert a BWF 'bext' chunk (title, originator, origination date and time) into a WAV blob. */
export async function addBext(blob, m) {
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 1 << 16)).arrayBuffer());
  const dv = new DataView(head.buffer);
  if (String.fromCharCode(...head.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...head.subarray(8, 12)) !== 'WAVE') return blob;
  let p = 12, fmt = null, data = -1;
  while (p + 8 <= head.length) {
    const id = String.fromCharCode(...head.subarray(p, p + 4)), len = dv.getUint32(p + 4, true);
    if (id === 'fmt ') fmt = blob.slice(p, p + 8 + len);
    if (id === 'data') { data = p; break; }
    p += 8 + len + (len & 1);
  }
  if (!fmt || data < 0) return blob;
  const enc = new TextEncoder(), fill = (s, n) => { const b = new Uint8Array(n); b.set(enc.encode(s).subarray(0, n)); return b; };
  const when = m.recordedAt ? new Date(m.recordedAt) : new Date();
  const pad2 = n => String(n).padStart(2, '0');
  const date = `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}`;
  const time = `${pad2(when.getHours())}:${pad2(when.getMinutes())}:${pad2(when.getSeconds())}`;
  const history = enc.encode(`A=PCM,M=${m.channels === 1 ? 'mono' : 'stereo'},O=Planet Sound`);
  const body = 602 + history.length + (history.length & 1);
  const bext = new Uint8Array(8 + body), bdv = new DataView(bext.buffer);
  bext.set(enc.encode('bext'), 0); bdv.setUint32(4, body, true);
  let o = 8;
  bext.set(fill(`${m.title || ''} · ${m.place || ''}`.trim(), 256), o); o += 256;
  bext.set(fill('Planet Sound', 32), o); o += 32;
  bext.set(fill(String(m.id || ''), 32), o); o += 32;
  bext.set(fill(date, 10), o); o += 10;
  bext.set(fill(time, 8), o); o += 8;
  o += 8;                            // TimeReference (samples since midnight): left zero
  bdv.setUint16(o, 1, true); o += 2; // Version
  o += 64;                           // UMID
  for (let k = 0; k < 5; k++) bdv.setInt16(o + 2 * k, 0x7fff, true);   // loudness: unknown
  o += 10;
  o += 180;                          // Reserved
  bext.set(history, o);
  const riffLen = 4 + fmt.size + bext.length + (blob.size - data);
  const hdr = new DataView(new ArrayBuffer(12));
  hdr.setUint8(0, 0x52); hdr.setUint8(1, 0x49); hdr.setUint8(2, 0x46); hdr.setUint8(3, 0x46);
  hdr.setUint32(4, riffLen, true);
  hdr.setUint8(8, 0x57); hdr.setUint8(9, 0x41); hdr.setUint8(10, 0x56); hdr.setUint8(11, 0x45);
  return new Blob([hdr.buffer, fmt, bext, blob.slice(data)], { type: 'audio/wav' });
}

/* ---------------- results ---------------- */

import { envelopeToPeaks } from './analysis.js';

async function packResult({ master, mime, ext, tech, analysis, recordedAt }) {
  if (analysis.dualMono) tech.dualMono = true;
  return {
    master, mime, ext, tech,
    duration: analysis.duration,
    lufs: analysis.lufs,
    peakDb: analysis.peakDb,
    backgroundLufs: analysis.backgroundLufs,
    clippedSamples: analysis.clippedSamples,
    peaks: envelopeToPeaks(analysis.envelope, 800),
    spectrogram: await renderSpectrogram(analysis.spectrogram),
    recordedAt: recordedAt ? recordedAt.toISOString() : null,
  };
}

/** Render the grid as an alpha-only PNG: ink density = energy. The page
 *  prints it through a CSS mask in whatever ink colour the theme uses. */
export async function renderSpectrogram(g, width = 1600, height = 384) {
  const cols = g.cols;
  if (!cols.length) return null;
  const W = Math.min(width, cols.length * 2), H = height, R = g.rows;
  // dynamic range: top = 99.5th percentile of all cells, 72 dB below it is paper
  const sample = [];
  const stride = Math.max(1, Math.floor(cols.length * R / 40000));
  for (let i = 0; i < cols.length * R; i += stride) sample.push(cols[Math.floor(i / R)][i % R]);
  sample.sort((a, b) => a - b);
  const top = sample[Math.floor(sample.length * 0.995)] ?? -200;
  if (top < -110) return null;               // digital silence: nothing to print
  const floor = Math.max(top - 72, -130);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d');
  const img = cx.createImageData(W, H); const px = img.data;
  for (let x = 0; x < W; x++) {
    const a = Math.floor(x * cols.length / W), b = Math.max(a + 1, Math.floor((x + 1) * cols.length / W));
    for (let y = 0; y < H; y++) {
      const rf = (1 - (y + 0.5) / H) * (R - 1);
      const r0 = Math.floor(rf), r1 = Math.min(R - 1, r0 + 1), t = rf - r0;
      let m = -200;
      for (let k = a; k < b && k < cols.length; k++) {
        const v = cols[k][r0] * (1 - t) + cols[k][r1] * t;
        if (v > m) m = v;
      }
      let v = (m - floor) / (top - floor); v = v < 0 ? 0 : v > 1 ? 1 : v;
      const i = (y * W + x) * 4;
      px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = Math.round(Math.pow(v, 1.15) * 255);
    }
  }
  cx.putImageData(img, 0, 0);
  return await new Promise(r => cv.toBlob(r, 'image/png'));
}

/** Replace the VORBIS_COMMENT block of a FLAC blob (catalogue metadata). */
export async function retagFlac(blob, tags) {
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 1 << 20)).arrayBuffer());
  if (String.fromCharCode(...head.subarray(0, 4)) !== 'fLaC') return blob;
  let p = 4, streaminfo = null, last = false, keep = [];
  while (!last && p + 4 <= head.length) {
    last = !!(head[p] & 0x80);
    const type = head[p] & 0x7f, len = (head[p + 1] << 16) | (head[p + 2] << 8) | head[p + 3];
    const body = head.slice(p + 4, p + 4 + len);
    if (type === 0) streaminfo = body; else if (type !== 4 && type !== 1) keep.push({ type, body });
    p += 4 + len;
  }
  if (!streaminfo) return blob;
  const enc = new TextEncoder();
  const vendor = enc.encode('Planet Sound FLAC encoder');
  const entries = [];
  for (const [k, v] of Object.entries(tags)) for (const one of [].concat(v)) if (one !== undefined && one !== null && String(one) !== '') entries.push(enc.encode(`${k.toUpperCase()}=${one}`));
  const vcLen = 8 + vendor.length + entries.reduce((a, e) => a + 4 + e.length, 0);
  const vc = new Uint8Array(vcLen), dv = new DataView(vc.buffer);
  let o = 0; dv.setUint32(o, vendor.length, true); o += 4; vc.set(vendor, o); o += vendor.length;
  dv.setUint32(o, entries.length, true); o += 4;
  for (const e of entries) { dv.setUint32(o, e.length, true); o += 4; vc.set(e, o); o += e.length; }
  const hdr = (lastB, type, len) => new Uint8Array([(lastB ? 0x80 : 0) | type, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  const blocks = [{ type: 0, body: streaminfo }, ...keep, { type: 4, body: vc }];
  const parts = [new Uint8Array([0x66, 0x4c, 0x61, 0x43])];
  blocks.forEach((b, i) => { parts.push(hdr(i === blocks.length - 1, b.type, b.body.length), b.body); });
  parts.push(blob.slice(p));
  return new Blob(parts, { type: 'audio/flac' });
}
