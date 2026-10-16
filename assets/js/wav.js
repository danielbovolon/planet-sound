/* Planet Sound — WAV writing with name and description inside the file.
 * Pure functions (no DOM), so they can be tested on their own.
 *
 * What goes into a shared WAV:
 *   - bext  Broadcast Wave chunk: description (256 ASCII chars), originator, reference, date and time
 *   - LIST/INFO  title (INAM), credit (IART), full description (ICMT, UTF-8), date (ICRD), software (ISFT)
 * Players, DAWs (Reaper, Pro Tools, Logic, Wavelab) and tools like BWF MetaEdit read these.
 */

const enc = new TextEncoder();
const u32 = n => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
const u16 = n => new Uint8Array([n & 255, (n >>> 8) & 255]);
const tag4 = s => new Uint8Array([...s].map(c => c.charCodeAt(0)));

/** Plain ASCII, one line: accents dropped, anything else becomes "?". For the bext chunk. */
export const ascii = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s+/g, ' ').replace(/[^\x20-\x7e]/g, '?').trim();

function concat(list) {
  const out = new Uint8Array(list.reduce((a, b) => a + b.length, 0));
  let o = 0; for (const b of list) { out.set(b, o); o += b.length; }
  return out;
}
/** RIFF chunk: id, size, payload, pad byte if the size is odd. */
function chunk(id, payload) {
  return concat([tag4(id), u32(payload.length), payload, payload.length & 1 ? new Uint8Array(1) : new Uint8Array(0)]);
}

function isoParts(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return null;
  const s = d.toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 19) };
}

/** Broadcast Wave "bext" chunk, version 1 (602 bytes). */
function bextChunk(m) {
  const b = new Uint8Array(602);
  const put = (off, text, len) => { const t = ascii(text).slice(0, len); for (let i = 0; i < t.length; i++) b[off + i] = t.charCodeAt(i); };
  put(0, m.description || m.title || '', 256);
  put(256, 'Planet Sound', 32);
  put(288, m.reference || '', 32);
  const p = isoParts(m.recordedAt);
  if (p) { put(320, p.date, 10); put(330, p.time, 8); }
  b.set(u16(1), 346);   // BWF version 1
  return chunk('bext', b);
}

/** LIST/INFO chunk: the readable tags most software shows. UTF-8, NUL-terminated. */
function infoChunk(m) {
  const sub = (id, text) => {
    const t = String(text ?? '').trim();
    return t ? chunk(id, concat([enc.encode(t), new Uint8Array(1)])) : new Uint8Array(0);
  };
  const p = isoParts(m.recordedAt);
  return chunk('LIST', concat([
    tag4('INFO'),
    sub('INAM', m.title), sub('IART', m.credit), sub('ICMT', m.description),
    sub('ICRD', p ? p.date : ''), sub('ISFT', 'Planet Sound'),
  ]));
}

const MASKS = { 1: 0x4, 2: 0x3, 3: 0x7, 4: 0x33, 5: 0x37, 6: 0x3F, 7: 0x13F, 8: 0x63F };
/** "fmt " payload for integer PCM. More than two channels use WAVE_FORMAT_EXTENSIBLE. */
export function pcmFmt(channels, rate, bits) {
  const block = channels * (bits / 8);
  const base = [u16(channels > 2 ? 0xFFFE : 1), u16(channels), u32(rate), u32(rate * block), u16(block), u16(bits)];
  if (channels <= 2) return concat(base);
  return concat([...base, u16(22), u16(bits), u32(MASKS[channels] || 0),
    new Uint8Array([1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71])]);
}

/** RIFF/WAVE = fmt + bext + LIST/INFO + data. Returned as a Blob so big files are not copied again. */
export function assemble(fmt, data, meta) {
  const head = [chunk('fmt ', fmt), bextChunk(meta), infoChunk(meta)];
  const pad = data.length & 1 ? [new Uint8Array(1)] : [];
  const body = 4 + head.reduce((a, b) => a + b.length, 0) + 8 + data.length + pad.length;
  return new Blob([tag4('RIFF'), u32(body), tag4('WAVE'), ...head, tag4('data'), u32(data.length), data, ...pad], { type: 'audio/wav' });
}

/** Is this ArrayBuffer a RIFF/WAVE file? */
export function isWav(ab) {
  const u = new Uint8Array(ab, 0, Math.min(12, ab.byteLength));
  const t = (o) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  return u.length >= 12 && t(0) === 'RIFF' && t(8) === 'WAVE';
}

/** Find the "fmt " and "data" chunks of a WAV file. */
export function parseWav(ab) {
  if (!isWav(ab)) return null;
  const u = new Uint8Array(ab), dv = new DataView(ab);
  const t = o => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  let o = 12, fmt = null, data = null;
  while (o + 8 <= u.length) {
    const id = t(o), start = o + 8;
    let size = dv.getUint32(o + 4, true);
    if (start + size > u.length) size = u.length - start;      // streamed or cut file: take what is there
    if (id === 'fmt ') fmt = u.subarray(start, start + size);
    else if (id === 'data') data = u.subarray(start, start + size);
    o = start + size + (size & 1);
  }
  return fmt && data ? { fmt, data } : null;
}

/** An existing WAV with new name/description chunks. The audio bytes are carried over untouched. */
export function rewriteWav(ab, meta) {
  const w = parseWav(ab);
  return w ? assemble(w.fmt, w.data, meta) : null;
}

/** 24-bit PCM WAV from decoded audio (one Float32Array per channel). */
export function wavFromChannels(chs, rate, meta) {
  const nch = chs.length, n = chs[0].length;
  const out = new Uint8Array(n * nch * 3);
  let o = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      let x = chs[c][i]; x = x > 1 ? 1 : x < -1 ? -1 : x;
      const v = Math.round(x < 0 ? x * 8388608 : x * 8388607);
      out[o++] = v & 255; out[o++] = (v >> 8) & 255; out[o++] = (v >> 16) & 255;
    }
  }
  return assemble(pcmFmt(nch, rate, 24), out, meta);
}

/** A safe file name (no path characters, no extension). */
export function safeName(s, fallback = 'Planet Sound') {
  const t = String(s ?? '').replace(/\.wav$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return t || fallback;
}
