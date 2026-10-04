/* Small shared helpers: formatting, dialogs, toasts. */

export const TAGS = ['Voice', 'Water', 'Wind', 'Birds', 'Insects', 'Animals', 'Traffic', 'Machinery', 'Footsteps',
  'Bells', 'Music', 'Market', 'Crowd', 'Rain', 'Thunder', 'Indoors', 'Nature', 'Night', 'Dawn', 'Ritual',
  'Work', 'Transport', 'Silence', 'Weather', 'Urban', 'Underwater'];

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const accession = no => 'PS ' + String(no ?? '').padStart(4, '0');

export function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
export function fmtDate(iso, withTime = false) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return '';
  const o = { day: 'numeric', month: 'long', year: 'numeric' };
  if (withTime) Object.assign(o, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString(undefined, o);
}
export function fmtShortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
export function fmtCoords(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return '';
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? 'E' : 'W'}`;
}
export function fmtBytes(b) {
  if (!b && b !== 0) return '';
  if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}
export const fmtDb = v => (v == null ? '' : (v < 0 ? '−' : '') + Math.abs(v).toFixed(1));
export function fmtFormat(t, short = false) {
  if (!t || !t.codec) return '';
  const parts = [t.codec];
  if (t.sampleRate) parts.push((t.sampleRate / 1000).toFixed(t.sampleRate % 1000 ? 1 : 0) + ' kHz');
  if (t.bitDepth && !short) parts.push(t.bitDepth + '-bit');
  else if (t.bitDepth && short) parts[0] = `${t.codec} ${t.bitDepth}`;
  if (t.channels && !short) parts.push(t.channels === 1 ? 'mono' : t.channels === 2 ? (t.dualMono ? 'dual mono' : 'stereo') : t.channels + ' ch');
  return short ? parts.join(', ') : parts.join(', ');
}

/* ---- toast ---- */
let toastTimer;
export function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---- ask: in-page confirm/prompt ---- */
export function ask({ title, body = '', yes = 'OK', no = 'Cancel', danger = false, extra = null }) {
  const d = $('#ask');
  $('#ask-title').textContent = title;
  $('#ask-body').textContent = body;
  const ex = $('#ask-extra'); ex.innerHTML = ''; if (extra) ex.append(extra);
  const y = $('#ask-yes'), n = $('#ask-no');
  y.textContent = yes; y.classList.toggle('danger', danger);
  n.textContent = no || ''; n.hidden = !no;
  return new Promise(res => {
    const done = v => { d.close(); y.onclick = n.onclick = null; d.onclose = null; res(v); };
    y.onclick = () => done(true);
    n.onclick = () => done(false);
    d.onclose = () => res(false);
    d.showModal();
  });
}

export function tagButtons(container, selected, { max = 3, onChange, all = false } = {}) {
  container.innerHTML = '';
  const list = all ? ['All', ...TAGS] : TAGS;
  for (const t of list) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'tag'; b.textContent = t; b.dataset.tag = t;
    container.append(b);
  }
  const refresh = () => {
    for (const b of container.children) {
      const t = b.dataset.tag;
      const on = all ? (t === 'All' ? !selected.length : selected.includes(t)) : selected.includes(t);
      b.setAttribute('aria-pressed', String(on));
      b.disabled = !all && !on && selected.length >= max;
    }
  };
  container.onclick = e => {
    const b = e.target.closest('.tag'); if (!b) return;
    const t = b.dataset.tag;
    if (all) { selected.length = 0; if (t !== 'All') selected.push(t); }
    else { const i = selected.indexOf(t); if (i > -1) selected.splice(i, 1); else if (selected.length < max) selected.push(t); }
    refresh(); onChange && onChange(selected);
  };
  refresh();
  return refresh;
}

/** "2026-10-03T18:04" in local time, for datetime-local inputs */
export function toLocalInput(iso) {
  const d = iso ? new Date(iso) : new Date(); if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(v) { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d.toISOString() : null; }

const placeCache = new Map();
/** Reverse-geocode to "Town, Country" (OpenStreetMap Nominatim, polite use). */
export async function placeName(lat, lng) {
  const k = lat.toFixed(3) + ',' + lng.toFixed(3);
  if (placeCache.has(k)) return placeCache.get(k);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=12&addressdetails=1&accept-language=${encodeURIComponent(navigator.language || 'en')}`);
    if (!r.ok) return '';
    const d = await r.json(), a = d.address || {};
    const local = a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality || a.county || a.state || '';
    const name = [local, a.country].filter(Boolean).join(', ') || (d.name || '');
    placeCache.set(k, name);
    return name;
  } catch { return ''; }
}
