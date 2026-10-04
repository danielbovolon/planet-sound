/* Planet Sound — streaming FLAC encoder.
 *
 * Lossless, integer PCM in, FLAC bitstream out, one 4096-sample frame at a
 * time so a long take never has to sit in memory as raw PCM. Uses FLAC's
 * fixed polynomial predictors (orders 0–4) with partitioned Rice coding and
 * per-frame stereo decorrelation (left/side, right/side, mid/side). That is
 * the same toolset as `flac -0`/`-1` and lands within a few percent of it.
 *
 * Every frame is bit-exact: decoding returns exactly the integers fed in.
 */

const BLOCK = 4096;

/* ---------- CRCs ---------- */
const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let j = 0; j < 8; j++) d = (d & 0x8000) ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}
function crc8(buf, start, end) { let c = 0; for (let i = start; i < end; i++) c = CRC8[c ^ buf[i]]; return c; }
function crc16(buf, start, end) { let c = 0; for (let i = start; i < end; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ buf[i]]; return c; }

/* ---------- bit writer ---------- */
class BitWriter {
  constructor(size = 1 << 16) { this.buf = new Uint8Array(size); this.pos = 0; this.acc = 0; this.n = 0; }
  ensure(extra) {
    if (this.pos + extra + 8 <= this.buf.length) return;
    let s = this.buf.length * 2; while (s < this.pos + extra + 8) s *= 2;
    const nb = new Uint8Array(s); nb.set(this.buf.subarray(0, this.pos)); this.buf = nb;
  }
  // write the low `bits` bits of `v` (bits <= 24 per call keeps the accumulator exact)
  w(v, bits) {
    while (bits > 16) { bits -= 16; this.w((v / (2 ** bits)) & 0xffff, 16); v = v % (2 ** bits); if (v < 0) v += 2 ** bits; }
    this.acc = (this.acc << bits) | (v & ((1 << bits) - 1));
    this.n += bits;
    while (this.n >= 8) { this.n -= 8; this.buf[this.pos++] = (this.acc >>> this.n) & 0xff; }
    this.acc &= (1 << this.n) - 1;
  }
  signed(v, bits) { this.w(v < 0 ? v + 2 ** bits : v, bits); }
  unary(q) { // q zeros then a one
    while (q >= 16) { this.w(0, 16); q -= 16; }
    this.w(1, q + 1);
  }
  align() { if (this.n) this.w(0, 8 - this.n); }
  bytes() { return this.buf.subarray(0, this.pos); }
}

/* ---------- residual helpers ---------- */
function fixedResidual(x, n, order, out) {
  switch (order) {
    case 0: for (let i = 0; i < n; i++) out[i] = x[i]; break;
    case 1: for (let i = 1; i < n; i++) out[i] = x[i] - x[i - 1]; break;
    case 2: for (let i = 2; i < n; i++) out[i] = x[i] - 2 * x[i - 1] + x[i - 2]; break;
    case 3: for (let i = 3; i < n; i++) out[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
    case 4: for (let i = 4; i < n; i++) out[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4]; break;
  }
}
const zz = r => (r >= 0 ? 2 * r : -2 * r - 1);

function riceCost(sum, count, k) { // approx bits for `count` zigzag values summing to `sum`
  return count * (k + 1) + Math.floor(sum / 2 ** k);
}
function bestK(sum, count, maxK) {
  if (count === 0) return 0;
  const mean = sum / count;
  let k = mean > 1 ? Math.max(0, Math.floor(Math.log2(mean))) : 0;
  if (k > maxK) k = maxK;
  let best = k, bc = riceCost(sum, count, k);
  for (const c of [k - 1, k + 1]) {
    if (c < 0 || c > maxK) continue;
    const cc = riceCost(sum, count, c);
    if (cc < bc) { bc = cc; best = c; }
  }
  return best;
}

/* choose partition order + Rice params for residual[order..n) */
function planRice(res, n, order) {
  const u = new Float64Array(n); // zigzag values (Float64 keeps 26-bit sums exact)
  for (let i = order; i < n; i++) u[i] = zz(res[i]);
  let maxP = 0;
  while (maxP < 8 && (n % (2 << maxP)) === 0 && (n >> (maxP + 1)) > order) maxP++;
  let best = null;
  for (let p = 0; p <= maxP; p++) {
    const parts = 1 << p, ps = n >> p;
    const ks = new Array(parts);
    let bits = 0, maxK = 0;
    for (let j = 0; j < parts; j++) {
      const a = j === 0 ? order : j * ps, b = (j + 1) * ps;
      let s = 0; for (let i = a; i < b; i++) s += u[i];
      const k = bestK(s, b - a, 30);
      ks[j] = k; if (k > maxK) maxK = k;
      bits += riceCost(s, b - a, k);
    }
    const paramBits = maxK > 14 ? 5 : 4;
    bits += parts * paramBits + 6;
    if (!best || bits < best.bits) best = { p, ks, bits, paramBits };
  }
  best.u = u;
  return best;
}

function subframeEstimate(x, n, bps) {
  // constant?
  let constant = true; for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
  if (constant) return { type: 'const', bits: 8 + bps };
  const res = new Int32Array(n);
  let best = null;
  const maxOrder = Math.min(4, n - 1);
  for (let o = 0; o <= maxOrder; o++) {
    fixedResidual(x, n, o, res);
    let s = 0; for (let i = o; i < n; i++) { const r = res[i]; s += r >= 0 ? r : -r; }
    if (!best || s < best.sum) best = { order: o, sum: s };
  }
  fixedResidual(x, n, best.order, res);
  const plan = planRice(res, n, best.order);
  const bits = 8 + best.order * bps + plan.bits;
  const verbatim = 8 + n * bps;
  if (bits >= verbatim) return { type: 'verbatim', bits: verbatim };
  return { type: 'fixed', order: best.order, plan, bits };
}

function writeSubframe(bw, x, n, bps, est) {
  if (est.type === 'const') { bw.w(0, 8); bw.signed(x[0], bps); return; }
  if (est.type === 'verbatim') { bw.w(0x02, 8); bw.ensure(n * 4); for (let i = 0; i < n; i++) bw.signed(x[i], bps); return; }
  const { order, plan } = est;
  bw.w((0x08 | order) << 1, 8);           // 0 | 001xxx | 0 (no wasted bits)
  for (let i = 0; i < order; i++) bw.signed(x[i], bps);
  bw.w(plan.paramBits === 5 ? 1 : 0, 2);  // RICE / RICE2
  bw.w(plan.p, 4);
  const parts = 1 << plan.p, ps = n >> plan.p, u = plan.u;
  bw.ensure(Math.ceil(plan.bits / 8) + 64);
  for (let j = 0; j < parts; j++) {
    const k = plan.ks[j];
    bw.w(k, plan.paramBits);
    const a = j === 0 ? order : j * ps, b = (j + 1) * ps;
    const div = 2 ** k;
    for (let i = a; i < b; i++) {
      const v = u[i];
      const q = Math.floor(v / div);
      bw.unary(q);
      if (k) bw.w(v - q * div, k);
    }
  }
}

function utf8Num(v) { // FLAC's UTF-8-style frame number
  if (v < 0x80) return [v];
  const out = [];
  let bytes = v < 0x800 ? 2 : v < 0x10000 ? 3 : v < 0x200000 ? 4 : v < 0x4000000 ? 5 : 6;
  for (let i = bytes - 1; i > 0; i--) { out.unshift(0x80 | (v & 0x3f)); v = Math.floor(v / 64); }
  out.unshift(((0xff00 >> bytes) & 0xff) | v);
  return out;
}

export class FlacEncoder {
  /** @param {{sampleRate:number, channels:number, bitsPerSample:number}} o */
  constructor(o) {
    this.sampleRate = o.sampleRate;
    this.channels = o.channels;
    this.bps = o.bitsPerSample;
    this.frames = [];          // Uint8Array per frame
    this.bytes = 0;
    this.frameNo = 0;
    this.total = 0;
    this.minFrame = Infinity; this.maxFrame = 0;
    this.pending = Array.from({ length: this.channels }, () => new Int32Array(BLOCK));
    this.fill = 0;
    this.scale = 2 ** (this.bps - 1);
  }

  /** Feed float samples (-1..1), one Float32Array per channel. */
  pushFloat(chs) {
    const n = chs[0].length, s = this.scale, max = s - 1, min = -s;
    let off = 0;
    while (off < n) {
      const take = Math.min(BLOCK - this.fill, n - off);
      for (let c = 0; c < this.channels; c++) {
        const src = chs[Math.min(c, chs.length - 1)], dst = this.pending[c];
        for (let i = 0; i < take; i++) {
          let v = Math.round(src[off + i] * s);
          dst[this.fill + i] = v > max ? max : v < min ? min : v;
        }
      }
      this.fill += take; off += take;
      if (this.fill === BLOCK) { this._frame(BLOCK); this.fill = 0; }
    }
  }
  /** Feed integer samples already at this.bps, one Int32Array per channel. */
  pushInt(chs) {
    const n = chs[0].length;
    let off = 0;
    while (off < n) {
      const take = Math.min(BLOCK - this.fill, n - off);
      for (let c = 0; c < this.channels; c++) this.pending[c].set(chs[c].subarray(off, off + take), this.fill);
      this.fill += take; off += take;
      if (this.fill === BLOCK) { this._frame(BLOCK); this.fill = 0; }
    }
  }
  flush() { if (this.fill) { this._frame(this.fill); this.fill = 0; } }

  _frame(n) {
    const bps = this.bps, ch = this.channels;
    const X = this.pending.map(a => a.subarray(0, n));
    let assign = ch - 1, subs, ests;
    if (ch === 2) {
      const L = X[0], R = X[1];
      const S = new Int32Array(n), M = new Int32Array(n);
      for (let i = 0; i < n; i++) { S[i] = L[i] - R[i]; M[i] = (L[i] + R[i]) >> 1; }
      const eL = subframeEstimate(L, n, bps), eR = subframeEstimate(R, n, bps);
      const eS = subframeEstimate(S, n, bps + 1), eM = subframeEstimate(M, n, bps);
      const opts = [
        { a: 1, s: [L, R], e: [eL, eR], b: [bps, bps] },
        { a: 8, s: [L, S], e: [eL, eS], b: [bps, bps + 1] },
        { a: 9, s: [S, R], e: [eS, eR], b: [bps + 1, bps] },
        { a: 10, s: [M, S], e: [eM, eS], b: [bps, bps + 1] },
      ];
      let best = opts[0];
      for (const o of opts) if (o.e[0].bits + o.e[1].bits < best.e[0].bits + best.e[1].bits) best = o;
      assign = best.a; subs = best; ests = best.e;
    } else {
      ests = X.map(x => subframeEstimate(x, n, bps));
      subs = { s: X, b: X.map(() => bps) };
    }

    const bw = new BitWriter(n * ch * 4 + 64);
    bw.w(0xfff8, 16);
    const bsCode = n === BLOCK ? 12 : 7;
    bw.w(bsCode, 4);
    bw.w(0, 4);              // sample rate: from STREAMINFO
    bw.w(assign, 4);
    bw.w(0, 3);              // sample size: from STREAMINFO
    bw.w(0, 1);
    for (const b of utf8Num(this.frameNo)) bw.w(b, 8);
    if (bsCode === 7) bw.w(n - 1, 16);
    bw.w(crc8(bw.buf, 0, bw.pos), 8);
    for (let c = 0; c < ch; c++) writeSubframe(bw, subs.s[c], n, subs.b[c], ests[c]);
    bw.align();
    const crc = crc16(bw.buf, 0, bw.pos);
    bw.w(crc, 16);
    const frame = bw.bytes().slice();
    this.frames.push(frame);
    this.bytes += frame.length;
    if (frame.length < this.minFrame) this.minFrame = frame.length;
    if (frame.length > this.maxFrame) this.maxFrame = frame.length;
    this.frameNo++;
    this.total += n;
  }

  /**
   * Assemble the finished file. `tags` become a VORBIS_COMMENT block, so the
   * catalogue metadata travels inside the master itself.
   * @param {Record<string,string|string[]>} [tags]
   * @returns {Blob}
   */
  finish(tags = {}) {
    this.flush();
    const si = new BitWriter(64);
    si.w(BLOCK, 16); si.w(BLOCK, 16);
    si.w(this.frames.length ? this.minFrame : 0, 24);
    si.w(this.maxFrame, 24);
    si.w(this.sampleRate, 20);
    si.w(this.channels - 1, 3);
    si.w(this.bps - 1, 5);
    si.w(Math.floor(this.total / 2 ** 32) & 0xf, 4);
    si.w(Math.floor(this.total / 65536) & 0xffff, 16);
    si.w(this.total & 0xffff, 16);
    for (let i = 0; i < 16; i++) si.w(0, 8); // MD5 unknown
    const streaminfo = si.bytes();

    const enc = new TextEncoder();
    const vendor = enc.encode('Planet Sound FLAC encoder');
    const entries = [];
    for (const [k, v] of Object.entries(tags)) {
      for (const one of [].concat(v)) if (one !== undefined && one !== null && String(one) !== '') entries.push(enc.encode(`${k.toUpperCase()}=${one}`));
    }
    const vcLen = 4 + vendor.length + 4 + entries.reduce((a, e) => a + 4 + e.length, 0);
    const vc = new Uint8Array(vcLen); const dv = new DataView(vc.buffer);
    let o = 0;
    dv.setUint32(o, vendor.length, true); o += 4; vc.set(vendor, o); o += vendor.length;
    dv.setUint32(o, entries.length, true); o += 4;
    for (const e of entries) { dv.setUint32(o, e.length, true); o += 4; vc.set(e, o); o += e.length; }

    const blockHeader = (last, type, len) => new Uint8Array([(last ? 0x80 : 0) | type, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
    const parts = [
      new Uint8Array([0x66, 0x4c, 0x61, 0x43]), // "fLaC"
      blockHeader(false, 0, streaminfo.length), streaminfo,
      blockHeader(true, 4, vc.length), vc,
      ...this.frames,
    ];
    return new Blob(parts, { type: 'audio/flac' });
  }
}
