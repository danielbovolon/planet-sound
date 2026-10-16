/* Planet Sound — sharing.
 *   Share Planet Sound   (About)
 *   Share sound          (sound panel; the link opens that panel directly: ?no=12)
 *   Share collection     (Your archive, Index) and Share my archive: a link that opens the list
 *   Share WAV            (sound panel): the file itself, with a name and a description inside it
 * Loaded after app.js. It reads the page and the API; it does not change app.js.
 */
import { $, $$, esc, accession, fmtTime, fmtCoords, fmtDate, fmtBytes, toast } from './ui.js';
import { call, mediaUrl, identity } from './api.js';
import { prefs } from './store.js';
import { isWav, rewriteWav, wavFromChannels, safeName } from './wav.js';

const baseUrl = () => location.origin + location.pathname.replace(/index\.html$/, '');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/* ---------------- link sharing ---------------- */
/** Phones: the system share sheet. Computers: copy the link. Returns 'shared' | 'copied' | 'cancelled' | 'failed'. */
async function shareLink({ title, text, url }) {
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) { await navigator.share({ title, text, url }); return 'shared'; }
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch (e) {
    return e && e.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}
function report(result, extra = '') {
  if (result === 'copied') toast('Link copied' + (extra ? '. ' + extra : ''), extra ? 6000 : 3200);
  else if (result === 'failed') toast('Could not share from here. Copy the address from the browser bar.', 5000);
  else if (extra && result === 'shared') toast(extra, 6000);
}

/* ---- the app ---- */
const shareApp = $('#share-app');
if (shareApp) shareApp.addEventListener('click', async () => {
  report(await shareLink({
    title: 'Planet Sound',
    text: 'An open archive of the world’s sound. Field recordings, each kept at the place and moment it was made.',
    url: baseUrl(),
  }));
});

/* ---------------- collections and archive ---------------- */
function cachedSounds() { const c = prefs.get('cache', null); return (c && c.sounds) || []; }
function ownIds() { const m = prefs.get('mine', null); return new Set(m && identity.key && m.key === identity.key ? m.ids || [] : []); }

/** Link that opens a list of recordings: ?album=Name&nos=3,7,12 (accession numbers, public ones only). */
function albumUrl(name, sounds) {
  const nos = sounds.slice(0, 300).map(s => s.no).join(',');
  return `${baseUrl()}?album=${encodeURIComponent(name)}&nos=${nos}`;
}
async function shareAlbum(name, sounds, requested = sounds.length) {
  const pub = sounds.filter(s => s.visibility === 'public');
  if (!pub.length) return toast('Nothing public to share yet. Private recordings can’t be opened by other people.', 5000);
  const left = requested - pub.length;
  const result = await shareLink({
    title: `${name} · Planet Sound`,
    text: `${name}: ${plural(pub.length, 'field recording')} on Planet Sound`,
    url: albumUrl(name, pub),
  });
  report(result, left > 0 ? `${plural(left, 'private or removed recording')} left out.` : '');
}
/** Resolve collection ids to recordings; asks the server only if the cached catalogue lacks some. */
async function resolveIds(ids) {
  let map = new Map(cachedSounds().map(s => [s.id, s]));
  if (ids.some(id => !map.has(id))) {
    try { map = new Map((await call('/api/sounds')).sounds.map(s => [s.id, s])); } catch {}
  }
  return ids.map(id => map.get(id)).filter(Boolean);
}
async function shareCollection(id) {
  const c = (prefs.get('collections', []) || []).find(x => x.id === id);
  if (!c) return;
  await shareAlbum(c.name, await resolveIds(c.ids), c.ids.length);
}
async function shareMyArchive() {
  const own = ownIds();
  const mine = cachedSounds().filter(s => s.mine || own.has(s.id));
  const u = identity.user;
  await shareAlbum(u && u.name ? `${u.name}’s archive` : 'My archive', mine);
}

/* Your archive: a Share button on every collection, and one for the whole archive. */
const youBody = $('#you-body');
function decorateYou() {
  $$('.coll', youBody).forEach(row => {
    const show = $('[data-show]', row);
    if (!show || $('[data-share-coll]', row)) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn quiet'; b.textContent = 'Share'; b.dataset.shareColl = show.dataset.show;
    show.before(b);
  });
  const stats = $('.you-stats', youBody);
  if (stats && !$('#y-share-archive', youBody) && cachedSounds().some(s => (s.mine || ownIds().has(s.id)) && s.visibility === 'public')) {
    const wrap = document.createElement('div');
    wrap.className = 'row'; wrap.style.marginTop = '10px';
    wrap.innerHTML = '<button type="button" class="btn" id="y-share-archive">Share my archive</button>';
    stats.after(wrap);
  }
}
if (youBody) {
  new MutationObserver(decorateYou).observe(youBody, { childList: true });
  youBody.addEventListener('click', e => {
    const c = e.target.closest('[data-share-coll]');
    if (c) return void shareCollection(c.dataset.shareColl);
    if (e.target.closest('#y-share-archive')) shareMyArchive();
  });
}

/* Index: a Share button appears next to the collection filter once a collection is chosen. */
function syncIndexShare() {
  const sel = $('#coll-filter');
  let b = $('#coll-share');
  if (!sel) { if (b) b.remove(); return; }
  if (!b) {
    b = document.createElement('button');
    b.type = 'button'; b.className = 'btn quiet'; b.id = 'coll-share'; b.textContent = 'Share collection';
    b.addEventListener('click', () => { const s = $('#coll-filter'); if (s && s.value) shareCollection(s.value); });
    sel.closest('label').after(b);
  }
  b.hidden = !sel.value;
}
{
  const fr = $('.filter-right');
  if (fr) { new MutationObserver(syncIndexShare).observe(fr, { childList: true, subtree: true }); fr.addEventListener('change', syncIndexShare); syncIndexShare(); }
}

/* ---- opening a shared collection link ---- */
async function openAlbumLink() {
  const p = new URLSearchParams(location.search);
  const nos = [...new Set((p.get('nos') || '').split(',').map(x => parseInt(x, 10)).filter(n => n > 0))].slice(0, 300);
  if (!nos.length) return;
  const name = (p.get('album') || '').trim().slice(0, 80) || 'Shared collection';
  let list;
  try { list = (await call('/api/sounds')).sounds; } catch (e) { return toast(e.message, 5000); }
  const byNo = new Map(list.map(s => [s.no, s]));
  const items = nos.map(n => byNo.get(n)).filter(Boolean);
  if (!items.length) return toast('Those recordings are no longer in the archive.', 5000);

  $('#spot-title').textContent = `${name} · ${plural(items.length, 'recording')}`;
  // the same list the app uses for several recordings in one place, so a tap opens the sound panel
  $('#spot-list').innerHTML = items.map(s => `<li><button type="button" data-id="${esc(s.id)}"><span>${esc(s.title)}</span><small>${esc(accession(s.no))}${s.place ? ', ' + esc(s.place) : ''}${s.duration ? ', ' + fmtTime(s.duration) : ''}</small></button></li>`).join('');
  const dlg = $('#spot');
  $('.spot-foot', dlg)?.remove();
  const foot = document.createElement('div');
  foot.className = 'spot-foot';
  const missing = nos.length - items.length;
  foot.innerHTML = `${missing ? `<p class="hint">${plural(missing, 'recording')} no longer available.</p>` : ''}<div class="row end"><button type="button" class="btn" id="spot-share">Share this collection</button></div>`;
  dlg.append(foot);
  $('#spot-share', foot).addEventListener('click', async () => report(await shareLink({
    title: `${name} · Planet Sound`, text: `${name}: ${plural(items.length, 'field recording')} on Planet Sound`, url: albumUrl(name, items),
  })));
  dlg.addEventListener('close', () => foot.remove(), { once: true });
  if (!dlg.open) dlg.showModal();
}

/* ---------------- Share WAV ---------------- */
const card = $('#card'), dlBtn = $('#c-dl'), wavBtn = $('#c-sharewav');
/* shown only where the app itself offers the download: the author allowed it, or it is yours */
function syncWavButton() { if (wavBtn) wavBtn.hidden = !dlBtn || dlBtn.hidden || card.hidden; }
if (wavBtn && dlBtn) {
  new MutationObserver(syncWavButton).observe(dlBtn, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(syncWavButton).observe(card, { attributes: true, attributeFilter: ['hidden'] });
  syncWavButton();
}

const MAX_BYTES = 300 * 1024 * 1024;   // a browser has to hold the file in memory twice
const dlg = document.createElement('dialog');
dlg.className = 'sheet small'; dlg.id = 'wav-dlg';
dlg.innerHTML = `
  <form method="dialog" class="sheet-head"><h2>Share WAV</h2><button class="x" aria-label="Close" value="close"></button></form>
  <label class="field"><span>File name</span><input id="w-name" maxlength="100" autocomplete="off" spellcheck="false"></label>
  <label class="field"><span>Description</span><textarea id="w-desc" rows="4" maxlength="1000"></textarea></label>
  <p class="hint" id="w-info"></p>
  <div class="progress" id="w-prog" hidden><div></div></div>
  <p class="s-msg" id="w-msg" role="status"></p>
  <div class="row end"><button type="button" class="btn quiet" id="w-save">Save a copy</button><button type="button" class="btn solid" id="w-go">Prepare WAV</button></div>`;
document.body.append(dlg);
const W = { sound: null, raw: null, file: null, stamp: '', busy: false };
const wEl = id => $('#' + id, dlg);
const setMsg = (t, err = false) => { const m = wEl('w-msg'); m.textContent = t; m.classList.toggle('err', err); };
const setProg = f => { const p = wEl('w-prog'); p.hidden = f == null; if (f != null) p.firstElementChild.style.width = Math.round(Math.min(1, f) * 100) + '%'; };
const stampNow = () => wEl('w-name').value + '\u0001' + wEl('w-desc').value;

function setGo(label, disabled = false) { const g = wEl('w-go'); g.textContent = label; g.disabled = disabled; }
function invalidate() { W.file = null; if (!W.busy && W.sound) { setGo('Prepare WAV'); setMsg(''); setProg(null); } }
wEl('w-name').addEventListener('input', invalidate);
wEl('w-desc').addEventListener('input', invalidate);

async function openWav() {
  const no = new URLSearchParams(location.search).get('no');
  if (!no) return toast('Open a sound first.');
  wavBtn.disabled = true;
  try {
    const { sound: s } = await call('/api/sounds/' + encodeURIComponent(no));
    if (!s.audio) return toast('This entry has no audio.');
    if (!(s.allowDownload || s.mine)) return toast('The recordist has not allowed downloads of the original.', 5000);
    W.sound = s; W.raw = null; W.file = null; W.busy = false;
    const acc = accession(s.no).replace(/\s+/g, '-');
    wEl('w-name').value = `${acc} ${s.title}`.slice(0, 100);
    const lines = [s.notes, [s.place, fmtCoords(s.lat, s.lng)].filter(Boolean).join(', '),
      s.recordedAt ? 'Recorded ' + fmtDate(s.recordedAt, true) : '', s.credit ? 'Recorded by ' + s.credit : '', s.equipment ? 'Equipment: ' + s.equipment : '',
      `${accession(s.no)} on Planet Sound`].filter(Boolean);
    wEl('w-desc').value = lines.join('\n');
    const t = s.tech || {};
    const src = (t.codec || '').toUpperCase();
    const est = s.duration && t.sampleRate && t.channels ? s.duration * t.sampleRate * t.channels * 3 : 0;
    wEl('w-info').textContent = (src === 'WAV'
      ? 'The original is already a WAV. The audio is passed through unchanged; the name and description are written into the file.'
      : `The original is ${src || 'compressed audio'}. It is converted to a 24-bit WAV${est ? ` (about ${fmtBytes(est)})` : ''}; the name and description are written into the file.`)
      + (s.tech && s.tech.audioBytes > MAX_BYTES ? ' This recording is very large for a phone or browser.' : '');
    setMsg(''); setProg(null); setGo('Prepare WAV', !!(s.tech && s.tech.audioBytes > MAX_BYTES));
    if (s.tech && s.tech.audioBytes > MAX_BYTES) setMsg('Too large to prepare here. Share the link instead.', true);
    dlg.showModal();
  } catch (e) { toast(e.message, 5000); }
  finally { wavBtn.disabled = false; }
}
if (wavBtn) wavBtn.addEventListener('click', openWav);

async function fetchAudio(url, expected) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('The recording could not be downloaded.');
  const total = Number(r.headers.get('Content-Length')) || expected || 0;
  if (!r.body || !total) return r.arrayBuffer();
  const rd = r.body.getReader(), parts = []; let got = 0;
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    parts.push(value); got += value.length; setProg(got / total * 0.7);
  }
  return new Blob(parts).arrayBuffer();
}
async function decode(ab, rate) {
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx; try { ctx = new AC({ sampleRate: rate || undefined }); } catch { ctx = new AC(); }
  try { return await ctx.decodeAudioData(ab); } finally { ctx.close().catch(() => {}); }
}

/** Download the original, write the WAV (with name and description inside). Needs no tap to share yet. */
async function prepare() {
  const s = W.sound, name = safeName(wEl('w-name').value), desc = wEl('w-desc').value.trim();
  W.busy = true; setGo('Preparing…', true); wEl('w-save').disabled = true;
  try {
    setMsg('Downloading…'); setProg(0);
    if (!W.raw) W.raw = await fetchAudio(mediaUrl(s.audio), s.tech && s.tech.audioBytes);
    setProg(0.75); setMsg(isWav(W.raw) ? 'Writing name and description…' : 'Converting to WAV…');
    await new Promise(r => setTimeout(r, 30));   // let the page paint
    const meta = { title: name, description: desc, credit: s.credit, recordedAt: s.recordedAt, reference: accession(s.no).replace(/\s+/g, '-') };
    let blob = isWav(W.raw) ? rewriteWav(W.raw, meta) : null;
    if (!blob) {
      const buf = await decode(W.raw.slice(0), s.tech && s.tech.sampleRate);
      const chs = Array.from({ length: Math.min(buf.numberOfChannels, 8) }, (_, c) => buf.getChannelData(c));
      blob = wavFromChannels(chs, buf.sampleRate, meta);
    }
    W.file = new File([blob], name + '.wav', { type: 'audio/wav' });
    W.stamp = stampNow(); setProg(1);
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [W.file] }));
    setMsg(`Ready: ${W.file.name} (${fmtBytes(W.file.size)}).`);
    setGo(canShare ? 'Share…' : 'Download WAV');
  } catch (e) {
    console.warn('share wav', e);
    setMsg(e && e.name === 'EncodingError' || /decode/i.test(String(e && e.message))
      ? 'This browser could not read the original. Try Brave or Chrome on a computer.' : (e.message || 'Could not prepare the file.'), true);
    setGo('Prepare WAV'); setProg(null);
  } finally { W.busy = false; wEl('w-save').disabled = false; }
}
function saveCopy() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(W.file); a.download = W.file.name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}
/* The share sheet needs a fresh tap, so preparing and sharing are two separate taps. */
wEl('w-go').addEventListener('click', async () => {
  if (W.busy) return;
  if (!W.file || W.stamp !== stampNow()) return prepare();
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [W.file] }));
  if (!canShare) return saveCopy();
  try {
    await navigator.share({ files: [W.file], title: wEl('w-name').value.trim(), text: wEl('w-desc').value.trim() });
    dlg.close();
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    setMsg('The share sheet could not take the file. It can be saved instead.', true); setGo('Download WAV');
  }
});
wEl('w-save').addEventListener('click', async () => {
  if (W.busy) return;
  if (!W.file || W.stamp !== stampNow()) { await prepare(); if (!W.file) return; }
  saveCopy();
});
dlg.addEventListener('close', () => { W.raw = null; W.file = null; W.sound = null; });

/* ---------------- boot ---------------- */
openAlbumLink();
