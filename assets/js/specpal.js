/* Planet Sound — spectrogram palettes.
 * Five ways of printing the same spectrogram, after the conventions of professional analysis and
 * restoration tools. Nothing is named on screen: a long press on the spectrogram moves to the next one,
 * and the one on screen is the one exported.
 *   0  archive ink   — the theme's ink on the page (black-on-white analysis view)
 *   1  fire          — black, indigo, magenta, orange, yellow (restoration-suite heat map)
 *   2  spectrum      — black, blue, cyan, green, yellow, red (classic analyser rainbow)
 *   3  perceptual    — violet, blue, teal, green, yellow (perceptually uniform)
 *   4  white on black — greyscale on black (acoustic-analysis view)
 * Spectrogram images are alpha-only PNGs: alpha is energy, 0 = the noise floor, 255 = the loudest. */
import { prefs } from './store.js';

export const PALETTES = [
  { id: 'ink', kind: 'ink' },
  { id: 'fire', kind: 'map', stops: [[0, '#000000'], [0.14, '#0d0829'], [0.32, '#3b0f70'], [0.5, '#8c2981'], [0.66, '#de4968'], [0.8, '#fe9f6d'], [0.92, '#fcde9c'], [1, '#fffbe8']] },
  { id: 'spectrum', kind: 'map', stops: [[0, '#000000'], [0.12, '#000c3a'], [0.3, '#0033c8'], [0.46, '#00b4ff'], [0.6, '#00e676'], [0.74, '#ffee00'], [0.88, '#ff7a00'], [1, '#ff1a1a']] },
  { id: 'perceptual', kind: 'map', stops: [[0, '#000000'], [0.1, '#2a0a3e'], [0.25, '#46327e'], [0.42, '#365c8d'], [0.58, '#1f9a8a'], [0.74, '#4ac16d'], [0.88, '#a0da39'], [1, '#fde725']] },
  { id: 'gray', kind: 'map', stops: [[0, '#000000'], [0.5, '#5a5a5a'], [1, '#ffffff']] },
];
const KEY = 'specPalette';

export function currentIndex() {
  const id = prefs.get(KEY, 'ink');
  const i = PALETTES.findIndex(p => p.id === id);
  return i < 0 ? 0 : i;
}
export function current() { return PALETTES[currentIndex()]; }
export function next() {
  const p = PALETTES[(currentIndex() + 1) % PALETTES.length];
  prefs.set(KEY, p.id);
  document.documentElement.dataset.specPal = p.id;
  painted.forEach((v, el) => paint(el, v.url, v.crop));
  return p;
}
document.documentElement.dataset.specPal = current().id;

function hex(c) { return [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)); }
function css(name, fb) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb; }
function parse(c) { const e = document.createElement('canvas').getContext('2d'); e.fillStyle = c; e.fillRect(0, 0, 1, 1); const d = e.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]]; }

/** 256 RGB entries for a palette. The ink palette is ink over `bg` (default: the page's sheet colour). */
export function lut(p = current(), { ink, bg } = {}) {
  const out = new Uint8ClampedArray(256 * 3);
  if (p.kind === 'ink') {
    const I = parse(ink || css('--ink', '#1E2B4D')), B = parse(bg || css('--sheet', '#F7F7F4'));
    for (let i = 0; i < 256; i++) { const a = i / 255; for (let c = 0; c < 3; c++) out[i * 3 + c] = B[c] + (I[c] - B[c]) * a; }
    return out;
  }
  const st = p.stops.map(([t, c]) => [t, hex(c)]);
  for (let i = 0; i < 256; i++) {
    const t = i / 255; let k = 0;
    while (k < st.length - 2 && t > st[k + 1][0]) k++;
    const [t0, c0] = st[k], [t1, c1] = st[k + 1], f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = c0[c] + (c1[c] - c0[c]) * f;
  }
  return out;
}

const cache = new Map();          // `${url}|${palette}` -> object URL of the coloured picture
const painted = new Map();        // element -> { url, crop } it shows
async function bitmap(url) {
  const r = await fetch(url); if (!r.ok) throw new Error('spectrogram');
  return createImageBitmap(await r.blob());
}
/** The spectrogram at `url` coloured with palette `p` on an opaque canvas. */
export async function colourCanvas(url, p = current(), opts) {
  const bmp = await bitmap(url);
  const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
  const g = cv.getContext('2d'); g.drawImage(bmp, 0, 0);
  const img = g.getImageData(0, 0, cv.width, cv.height), d = img.data, L = lut(p, opts);
  for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] * 3; d[i] = L[a]; d[i + 1] = L[a + 1]; d[i + 2] = L[a + 2]; d[i + 3] = 255; }
  g.putImageData(img, 0, 0);
  return cv;
}

/** Show part of the picture: crop = { s0, w } as fractions of the width (a trimmed entry). */
function cropStyle(el, crop) {
  const size = crop && crop.w < 0.9999 ? `${100 / crop.w}% 100%` : '100% 100%';
  const pos = crop && crop.w < 0.9999 ? `${(crop.s0 / (1 - crop.w)) * 100}% 0%` : '0% 0%';
  el.style.webkitMaskSize = el.style.maskSize = size; el.style.webkitMaskPosition = el.style.maskPosition = pos;
  el.style.backgroundSize = size; el.style.backgroundPosition = pos;
}
/** Show the spectrogram at `url` in element `el` (a .sono-img) in the current palette, optionally only a stretch of it. */
export async function paint(el, url, crop) {
  if (!el) return;
  if (!url) { painted.delete(el); el.classList.remove('heat'); el.style.backgroundImage = ''; el.style.webkitMaskImage = el.style.maskImage = ''; cropStyle(el, null); return; }
  painted.set(el, { url, crop: crop || null });
  cropStyle(el, crop);
  const p = current();
  if (p.kind === 'ink') {
    // the ink palette prints through a mask, so it follows light and dark themes by itself
    el.classList.remove('heat'); el.style.backgroundImage = '';
    el.style.webkitMaskImage = el.style.maskImage = `url("${url}")`;
    return;
  }
  const key = `${url}|${p.id}`;
  let out = cache.get(key);
  if (!out) {
    try {
      const cv = await colourCanvas(url, p);
      out = URL.createObjectURL(await new Promise(r => cv.toBlob(r, 'image/png')));
      cache.set(key, out);
    } catch { return; }
  }
  const now = painted.get(el); if (!now || now.url !== url || current().id !== p.id) return;   // something newer is on screen
  el.style.webkitMaskImage = el.style.maskImage = 'none';
  el.style.backgroundImage = `url("${out}")`;
  el.classList.add('heat');
}
