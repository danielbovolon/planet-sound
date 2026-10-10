/* Planet Sound — application shell. */
import { $, $$, esc, accession, fmtTime, fmtDate, fmtShortDate, fmtCoords, fmtBytes, fmtDb, fmtFormat, toast, ask, tagButtons, TAGS, toLocalInput, fromLocalInput } from './ui.js';
import { API, call, identity, mediaUrl, ensureIdentity, upload, ApiError } from './api.js';
import { outbox, prefs } from './store.js';
import { createMap } from './map.js';
import { createSpace } from './space.js';
import { createSky } from './sky.js';
import { Player, drawWave } from './player.js';
import { initStudio, sendEntry, openStudio, shrinkImage } from './studio.js';
import { encodeWav24 } from './audio/engine.js';

const S = {
  sounds: [], byId: new Map(), full: new Map(), me: null,
  q: '', tags: [], mine: false, sort: prefs.get('sort', 'new'), collection: '',
  view: 'map', current: null, collections: prefs.get('collections', []),
};

/* ---------------- theme ---------------- */
function applyTheme() {
  const t = prefs.get('theme', 'auto');
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('dark-ui', dark);
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (prefs.get('theme', 'auto') === 'auto') { applyTheme(); mapCtl && mapCtl.retheme(); redrawCard(); } });

/* ---------------- map ---------------- */
const lastView = prefs.get('mapView', null);
const mapCtl = createMap($('#map'), {
  start: lastView,
  onSelect: id => openCard(id, { fly: false }),
  onSpot: ids => showSpot(ids),
  onMoveEnd: () => { prefs.set('mapView', mapCtl.center()); },
});
// The real sky (WebGL photo sphere); the painted sky if that isn't possible.
{
  let fellBack = false;
  const fallback = () => {
    if (fellBack) return; fellBack = true;
    const c = document.createElement('canvas'); c.id = 'space'; c.setAttribute('aria-hidden', 'true');
    $('#space').replaceWith(c); createSpace(c, mapCtl.map);
  };
  if (!createSky($('#space'), mapCtl.map, { onFail: fallback })) fallback();
}
$('#locate').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('This device can’t share its position.');
  navigator.geolocation.getCurrentPosition(p => mapCtl.flyTo(p.coords.latitude, p.coords.longitude, 12), () => toast('Position unavailable.'), { timeout: 10000 });
});

/* ---------------- views ---------------- */
function setView(v) {
  S.view = v;
  $$('.views [data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  $('#map-view').hidden = v !== 'map';
  $('#index-view').hidden = v !== 'index';
  $('#about-view').hidden = v !== 'about';
  $('.bar').classList.remove('open'); $('#menu-btn').setAttribute('aria-expanded', 'false');
  if (v === 'map') requestAnimationFrame(() => mapCtl.resize());
  if (v === 'index') renderIndex();
  if (v !== 'map' && innerWidth <= 860) closeCard();
}
$$('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
$('#menu-btn').addEventListener('click', () => {
  const open = !$('.bar').classList.contains('open');
  $('.bar').classList.toggle('open', open); $('#menu-btn').setAttribute('aria-expanded', String(open));
});

/* ---------------- data ---------------- */
function visible() {
  const q = S.q.trim().toLowerCase();
  const coll = S.collection ? S.collections.find(c => c.id === S.collection) : null;
  let list = S.sounds.filter(s => {
    if (S.mine && !s.mine) return false;
    if (coll && !coll.ids.includes(s.id)) return false;
    if (S.tags.length && !S.tags.every(t => (s.tags || []).includes(t))) return false;
    if (q) {
      const hay = [s.title, s.place, s.credit, (s.tags || []).join(' '), accession(s.no)].join(' ').toLowerCase();
      if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  });
  const t = s => new Date(s.recordedAt || s.createdAt || 0).getTime() || 0;
  const sorts = { new: (a, b) => t(b) - t(a), old: (a, b) => t(a) - t(b), long: (a, b) => (b.duration || 0) - (a.duration || 0), title: (a, b) => (a.title || '').localeCompare(b.title || '') };
  return list.sort(sorts[S.sort] || sorts.new);
}
function refresh() {
  const v = visible();
  mapCtl.setData(v);
  const n = v.length, all = S.sounds.length;
  $('#map-count').textContent = !all ? '' : n === all ? `${all} recording${all === 1 ? '' : 's'}` : `${n} of ${all} recordings`;
  if (S.view === 'index') renderIndex(v);
}

async function load() {
  const cached = prefs.get('cache', null);
  if (cached && !S.sounds.length) setSounds(cached.sounds || [], true);
  try {
    const d = await call('/api/sounds');
    if (identity.key && !d.me) { /* key no longer valid */ }
    setSounds(d.sounds);
    try { prefs.set('cache', { at: Date.now(), sounds: d.sounds }); } catch {}
    return true;
  } catch (e) {
    if (!cached) toast(e.status === 0 ? 'Offline. Recording still works; entries will be published when you’re back.' : e.message, 5000);
    return false;
  }
}
function setSounds(list, fromCache) {
  S.sounds = list;
  S.byId = new Map(list.map(s => [s.id, s]));
  refresh();
}

/* ---------------- index ---------------- */
let indexTagsBound = false;
function renderIndex(v = visible()) {
  if (!indexTagsBound) {
    tagButtons($('#tag-filter'), S.tags, { all: true, onChange: () => refresh() });
    indexTagsBound = true;
  }
  const total = v.reduce((a, s) => a + (s.duration || 0), 0);
  $('#index-sum').textContent = v.length ? `${v.length} recording${v.length === 1 ? '' : 's'}, ${fmtTime(total)} of listening` : '';
  const rows = $('#rows');
  rows.innerHTML = v.map(s => `
    <button class="tr" role="row" data-id="${esc(s.id)}">
      <span class="no" role="cell">${esc(accession(s.no))}</span>
      <span class="t" role="cell">${esc(s.title)}${s.visibility === 'private' ? '<span class="priv">Only me</span>' : ''}${s.tags && s.tags.length ? `<small>${esc(s.tags.join(', '))}</small>` : ''}</span>
      <span class="p" role="cell">${esc(s.place || fmtCoords(s.lat, s.lng))}</span>
      <span class="d" role="cell">${esc(fmtShortDate(s.recordedAt || s.createdAt))}</span>
      <span class="du num" role="cell">${s.duration ? fmtTime(s.duration) : ''}</span>
      <span class="f" role="cell">${esc(fmtFormat(s.tech, true))}</span>
    </button>`).join('');
  const empty = $('#index-empty');
  empty.hidden = !!v.length;
  if (!v.length) empty.textContent = S.sounds.length ? 'Nothing matches. Clear the search or pick another tag.' : 'The archive is empty. Record the first sound.';
}
$('#rows').addEventListener('click', e => {
  const r = e.target.closest('.tr'); if (!r) return;
  setView('map'); openCard(r.dataset.id, { fly: true });
});
$('#sort').value = S.sort;
$('#sort').addEventListener('change', e => { S.sort = e.target.value; prefs.set('sort', S.sort); refresh(); });
$('#only-mine').addEventListener('change', e => { S.mine = e.target.checked; refresh(); });
let qTimer;
$('#q').addEventListener('input', e => { clearTimeout(qTimer); qTimer = setTimeout(() => { S.q = e.target.value; refresh(); }, 120); });
$('#q').addEventListener('keydown', e => {
  if (e.key === 'Enter') { const v = visible(); if (v.length === 1) openCard(v[0].id, { fly: true }); else if (S.view === 'about') setView('index'); }
  if (e.key === 'Escape') { e.target.value = ''; S.q = ''; refresh(); e.target.blur(); }
});

/* ---------------- entry card ---------------- */
const card = $('#card');
const player = new Player({
  audio: new Audio(), meter: $('#c-meter'),
  onTime: (t, d) => {
    $('#c-el').textContent = fmtTime(t); $('#c-du').textContent = fmtTime(d);
    const f = d ? t / d : 0;
    $('#c-head').style.left = `calc(22px + (100% - 44px) * ${f})`;
    if (innerWidth <= 860) $('#c-head').style.left = `calc(18px + (100% - 36px) * ${f})`;
    if (!seeking) $('#c-seek').value = String(Math.round(f * 1000));
    const s = S.current && S.full.get(S.current); if (s) drawWave($('#c-wave'), s.peaks, f);
  },
  onState: (st, err) => {
    const on = st === 'playing' || st === 'loading';
    $('#c-play').classList.toggle('on', on);
    $('#c-play').setAttribute('aria-label', on ? 'Pause' : 'Play');
    $('#c-sono').classList.toggle('playing', on);
    $('#c-status').textContent = st === 'loading' ? 'Loading…' : st === 'error' ? `This recording could not be played here${err && err.code ? ` (player code ${err.code})` : ''}. Try downloading it, or another browser.` : '';
  },
});
let seeking = false;
$('#c-play').addEventListener('click', () => player.toggle());
$('#c-seek').addEventListener('input', e => { seeking = true; player.seek(e.target.value / 1000); $('#c-sono').classList.add('cued'); });
$('#c-seek').addEventListener('change', () => { seeking = false; });
$('#c-lm').checked = prefs.get('levelMatch', true);
player.setLevelMatch($('#c-lm').checked);
$('#c-lm').addEventListener('change', e => { player.setLevelMatch(e.target.checked); prefs.set('levelMatch', e.target.checked); });
$('#c-close').addEventListener('click', closeCard);

async function openCard(id, { fly = true } = {}) {
  const base = S.byId.get(id);
  S.current = id;
  mapCtl.select(id);
  if (base) fillCard(base, true);
  card.hidden = false; card.classList.remove('full'); document.body.classList.add('card-open');
  if (base && fly) mapCtl.flyTo(base.lat, base.lng);
  history.replaceState(null, '', `?no=${base ? base.no : encodeURIComponent(id)}`);
  try {
    let full = S.full.get(id);
    if (!full) { full = (await call('/api/sounds/' + encodeURIComponent(id))).sound; S.full.set(full.id, full); }
    if (!S.byId.has(full.id)) { S.byId.set(full.id, full); }
    if (S.current !== id && S.current !== full.id) return;
    S.current = full.id;
    if (!base) { mapCtl.select(full.id); if (fly) mapCtl.flyTo(full.lat, full.lng); history.replaceState(null, '', `?no=${full.no}`); }
    fillCard(full, false);
  } catch (e) {
    if (!base) { closeCard(); toast(e.status === 404 ? 'That entry isn’t in the archive (or is private).' : e.message); }
  }
}
function closeCard() {
  card.hidden = true; document.body.classList.remove('card-open'); player.stop(); S.current = null; mapCtl.select(null);
  if (location.search) history.replaceState(null, '', location.pathname);
}
function redrawCard() { if (S.current && S.full.get(S.current)) fillCard(S.full.get(S.current), false); }

function fillCard(s, partial) {
  $('#c-no').innerHTML = `<b>${esc(accession(s.no))}</b>${s.visibility === 'private' ? ', only visible to you' : ''}`;
  $('#c-title').textContent = s.title;
  $('#c-place').textContent = s.place || '';
  $('#c-coords').textContent = fmtCoords(s.lat, s.lng);
  const spec = $('#c-spec');
  const specUrl = mediaUrl(s.spectrogram);
  spec.classList.toggle('empty', !specUrl);
  spec.style.webkitMaskImage = spec.style.maskImage = specUrl ? `url("${specUrl}")` : '';
  $('.sono-axis').hidden = !specUrl;
  $('#c-sono').classList.remove('playing', 'cued');
  if (partial) {
    if (player.sound && player.sound.id === s.id) return;
    player.load({ ...s, peaks: null }, mediaUrl(s.audio));
    $('#c-notes').textContent = ''; $('#c-facts').innerHTML = ''; $('#c-photo').hidden = true;
    drawWave($('#c-wave'), null);
  } else {
    if (!player.sound || player.sound.id !== s.id || !player.sound.peaks) {
      const playing = player.sound && player.sound.id === s.id && !player.a.paused;
      if (!playing) player.load(s, mediaUrl(s.audio)); else player.sound = s;
    }
    drawWave($('#c-wave'), s.peaks, 0);
    $('#c-notes').textContent = s.notes || '';
    const ph = $('#c-photo');
    if (s.photo) { ph.src = mediaUrl(s.photo); ph.alt = `Photo taken where ${s.title} was recorded`; ph.hidden = false; } else ph.hidden = true;
    $('#c-facts').innerHTML = factsHtml(s);
  }
  $('#c-play').disabled = !s.audio;
  const dl = $('#c-dl');
  if (s.audio && (s.allowDownload || s.mine)) {
    const ext = (s.audio.split('.').pop() || 'flac').toLowerCase();
    dl.href = mediaUrl(s.audio) + '?download=' + encodeURIComponent(`${accession(s.no).replace(' ', '-')} ${s.title}.${ext}`);
    dl.textContent = `Download ${s.tech && s.tech.codec ? s.tech.codec : ext.toUpperCase()}${s.tech && s.tech.audioBytes ? ` (${fmtBytes(s.tech.audioBytes)})` : ''}`;
    dl.hidden = false;
  } else dl.hidden = true;
  $('#c-owner').hidden = !s.mine;
}
function factsHtml(s) {
  const t = s.tech || {};
  const rows = [];
  const add = (k, v) => { if (v) rows.push(`<dt>${k}</dt><dd>${v}</dd>`); };
  add('Recorded', esc(fmtDate(s.recordedAt || s.createdAt, !!s.recordedAt)));
  add('Credit', esc(s.credit || ''));
  add('Equipment', esc(s.equipment || ''));
  add('Length', s.duration ? esc(fmtTime(s.duration)) : '');
  add('Format', esc(fmtFormat(t)) + (t.lossless ? ' <small>lossless</small>' : t.codec ? ' <small>compressed</small>' : ''));
  if (t.lufs != null) add('Loudness', `${fmtDb(t.lufs)} LUFS integrated${t.peakDb != null ? `, peak ${fmtDb(t.peakDb)} dBFS` : ''}`);
  if (t.backgroundLufs != null) add('Background', `${fmtDb(t.backgroundLufs)} LUFS <small>quietest tenth of the take</small>`);
  if (t.clipped) add('Clipping', `${Number(t.clipped).toLocaleString()} samples at full scale`);
  if (s.tags && s.tags.length) add('Tags', s.tags.map(x => `<span class="tag">${esc(x)}</span>`).join(' '));
  add('Added', esc(fmtDate(s.createdAt)));
  return rows.join('');
}

/* card on phones: drag the grip to expand */
(() => {
  const grip = $('.card-grip'); let y0 = null;
  grip.addEventListener('pointerdown', e => { y0 = e.clientY; grip.setPointerCapture(e.pointerId); });
  grip.addEventListener('pointerup', e => {
    if (y0 === null) return; const dy = e.clientY - y0; y0 = null;
    if (Math.abs(dy) < 6) card.classList.toggle('full');
    else if (dy < 0) card.classList.add('full');
    else if (card.classList.contains('full')) card.classList.remove('full'); else closeCard();
  });
})();

/* share, collections */
$('#c-share').addEventListener('click', async () => {
  const s = S.full.get(S.current) || S.byId.get(S.current); if (!s) return;
  const url = `${location.origin}${location.pathname}?no=${s.no}`;
  const text = `${s.title}${s.place ? ', ' + s.place : ''}`;
  try {
    if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Planet Sound', text, url });
    else { await navigator.clipboard.writeText(url); toast('Link copied'); }
  } catch {}
});
$('#c-collect').addEventListener('click', () => collectDialog(S.current));
/* ---------------- edit ---------------- */
let editPhoto, editLoc, editTags = [];
$('#c-edit').addEventListener('click', () => {
  const s = S.full.get(S.current); if (!s) return;
  $('#e-title').value = s.title || ''; $('#e-notes').value = s.notes || ''; $('#e-equip').value = s.equipment || '';
  $('#e-place').value = s.place || ''; $('#e-when').value = toLocalInput(s.recordedAt || s.createdAt);
  $('#e-credit').value = s.credit || ''; $('#e-dl').checked = !!s.allowDownload;
  $$('input[name="evis"]').forEach(r => { r.checked = r.value === s.visibility; });
  editTags = (s.tags || []).slice();
  tagButtons($('#e-tags'), editTags, { onChange: x => { $('#e-tagcount').textContent = x.length ? `${x.length} of 3` : 'up to three'; } });
  editLoc = { lat: s.lat, lng: s.lng }; $('#e-loc').textContent = fmtCoords(s.lat, s.lng);
  editPhoto = undefined; showEditPhoto(s.photo ? mediaUrl(s.photo) : null);
  $('#e-msg').textContent = '';
  $('#edit').showModal();
});
function showEditPhoto(url) { const p = $('#e-photo'); p.style.backgroundImage = url ? `url("${url}")` : ''; p.textContent = url ? '' : 'None'; }
$('#e-photo-in').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; editPhoto = await shrinkImage(f); showEditPhoto(URL.createObjectURL(editPhoto)); });
$('#e-photo-clear').addEventListener('click', () => { editPhoto = null; showEditPhoto(null); });
$('#e-cancel').addEventListener('click', () => $('#edit').close());
$('#e-move').addEventListener('click', async () => {
  $('#edit').close();
  const r = await pick({ ...editLoc, zoom: 15 });
  if (r) { editLoc = r; $('#e-loc').textContent = fmtCoords(r.lat, r.lng); }
  $('#edit').showModal();
});
$('#e-save').addEventListener('click', async () => {
  const s = S.full.get(S.current); if (!s) return;
  const b = {
    title: $('#e-title').value, notes: $('#e-notes').value, tags: editTags, equipment: $('#e-equip').value, place: $('#e-place').value,
    recordedAt: fromLocalInput($('#e-when').value), credit: $('#e-credit').value, allowDownload: $('#e-dl').checked,
    visibility: $('input[name="evis"]:checked').value, lat: editLoc.lat, lng: editLoc.lng,
  };
  $('#e-save').disabled = true; $('#e-msg').textContent = 'Saving…';
  try {
    if (editPhoto) b.photoKey = await upload(editPhoto, 'jpg');
    else if (editPhoto === null) b.photoKey = null;
    const { sound } = await call('/api/sounds/' + s.id, { method: 'PATCH', body: b });
    S.full.set(sound.id, sound);
    setSounds(S.sounds.map(x => (x.id === sound.id ? { ...x, ...sound } : x)));
    fillCard(sound, false); mapCtl.select(sound.id);
    $('#edit').close(); toast('Changes saved');
  } catch (e) { $('#e-msg').textContent = e.message; }
  finally { $('#e-save').disabled = false; }
});

/* ---------------- location picker (shared) ---------------- */
function pick(from) {
  const wasView = S.view; setView('map');
  const cardWas = !card.hidden; card.hidden = true;
  $('#picker').hidden = false;
  return mapCtl.pick(from, {
    coords: (la, lo) => { $('#picker-coords').textContent = fmtCoords(la, lo); },
    bind: done => {
      $('#picker-ok').onclick = () => finish(true);
      $('#picker-cancel').onclick = () => finish(false);
      function finish(ok) { $('#picker').hidden = true; card.hidden = !cardWas; if (wasView !== 'map') setView(wasView); done(ok); }
    },
  });
}

/* ---------------- spots (many sounds in one place) ---------------- */
function showSpot(ids) {
  const items = ids.map(id => S.byId.get(id)).filter(Boolean);
  $('#spot-title').textContent = `${items.length} recordings here`;
  $('#spot-list').innerHTML = items.map(s => `<li><button type="button" data-id="${esc(s.id)}"><span>${esc(s.title)}</span><small>${esc(accession(s.no))}, ${esc(fmtShortDate(s.recordedAt || s.createdAt))}${s.duration ? ', ' + fmtTime(s.duration) : ''}</small></button></li>`).join('');
  $('#spot').showModal();
}
$('#spot-list').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; $('#spot').close(); openCard(b.dataset.id, { fly: false }); });

/* ---------------- collections ---------------- */
function saveCollections() {
  prefs.set('collections', S.collections);
  if (identity.key) call('/api/me/collections', { method: 'PUT', body: { collections: S.collections } }).catch(() => {});
  renderCollectionFilter();
}
function renderCollectionFilter() {
  let sel = $('#coll-filter');
  if (!S.collections.length) { if (sel) sel.parentElement.remove(); S.collection = ''; return; }
  if (!sel) {
    const l = document.createElement('label'); l.className = 'sel';
    l.innerHTML = '<span class="sr">Collection</span><select id="coll-filter"></select>';
    $('.filter-right').prepend(l); sel = $('#coll-filter');
    sel.addEventListener('change', e => { S.collection = e.target.value; refresh(); });
  }
  sel.innerHTML = '<option value="">All entries</option>' + S.collections.map(c => `<option value="${esc(c.id)}">${esc(c.name)} (${c.ids.length})</option>`).join('');
  sel.value = S.collection;
}
async function collectDialog(id) {
  const box = document.createElement('div');
  const draw = () => {
    box.innerHTML = `<div class="pick-list">${S.collections.map(c => `<label class="check"><input type="checkbox" data-c="${esc(c.id)}" ${c.ids.includes(id) ? 'checked' : ''}> ${esc(c.name)} <small style="color:var(--graphite)">${c.ids.length}</small></label>`).join('')}</div>
      <div class="row" style="margin-top:12px"><input id="nc-name" class="field" style="flex:1;margin:0;min-height:38px;padding:0 10px;border-radius:8px;border:1px solid var(--rule);background:var(--sheet)" placeholder="New collection, e.g. Rivers" maxlength="80"><button type="button" class="btn" id="nc-add">Create</button></div>`;
    box.querySelector('#nc-add').onclick = () => {
      const n = box.querySelector('#nc-name').value.trim(); if (!n) return;
      S.collections.unshift({ id: crypto.randomUUID(), name: n, ids: [id], created: new Date().toISOString() }); saveCollections(); draw();
    };
    box.querySelectorAll('[data-c]').forEach(cb => cb.onchange = () => {
      const c = S.collections.find(x => x.id === cb.dataset.c); if (!c) return;
      if (cb.checked) { if (!c.ids.includes(id)) c.ids.push(id); } else c.ids = c.ids.filter(x => x !== id);
      saveCollections();
    });
  };
  draw();
  await ask({ title: 'Collections', body: 'Group entries from anywhere on the map: a walk, a season, a way of listening.', yes: 'Done', no: '', extra: box });
}

/* ---------------- your archive ---------------- */
/* A recording belongs to you if the server says so, or if this device published it
   with the key it holds now (covers queued recordings sent later, offline or in the background). */
function ownIds() {
  const m = prefs.get('mine', null);
  return m && identity.key && m.key === identity.key ? new Set(m.ids || []) : new Set();
}
function isMine(s) { return !!s.mine || ownIds().has(s.id); }
$('#you-btn').addEventListener('click', openYou);
async function openYou() {
  $('.bar').classList.remove('open');
  renderYou();
  $('#you').showModal();
  if (identity.key) {
    try { await load(); const d = await call('/api/me'); identity.setUser(d.user); renderYou(); }
    catch (e) { if (e.status === 401) renderYou('That listener key is no longer valid on the server.'); }
  }
}
async function renderYou(warning) {
  const body = $('#you-body');
  const mine = S.sounds.filter(isMine), priv = mine.filter(s => s.visibility === 'private');
  const pending = await outbox.all().catch(() => []);
  const u = identity.user;
  const key = identity.key;
  const theme = prefs.get('theme', 'auto');
  const flacs = mine.filter(s => s.tech && s.tech.codec === 'FLAC');
  const rows = mine.map(s => `<li><button type="button" class="y-item" data-open="${esc(s.id)}"><span class="y-title">${esc(s.title)}</span><small>${esc(s.place || accession(s.no))}${s.visibility === 'private' ? ' · private' : ''}</small></button></li>`).join('');
  body.innerHTML = `
    ${warning ? `<p class="c-flag">${esc(warning)}</p>` : ''}
    ${u && u.email ? `<section class="you-sec"><h3>Signed in</h3><p>${esc(u.email)}. Everything you publish goes to this account, from any device you sign in on.</p><button type="button" class="btn quiet" id="y-signout">Sign out on this device</button></section>`
      : `<section class="you-sec"><h3>Sign in</h3><p>One account for you, on every device. Sign in once on each device; it stays signed in there.</p><div style="display:grid;gap:8px"><input id="y-email" type="email" autocomplete="username" placeholder="Email" aria-label="Email" style="min-height:38px;padding:0 10px;border-radius:8px;border:1px solid var(--rule);background:var(--paper)"><input id="y-pass" type="password" autocomplete="current-password" placeholder="Password (at least 8 characters)" aria-label="Password" style="min-height:38px;padding:0 10px;border-radius:8px;border:1px solid var(--rule);background:var(--paper)"><div class="row"><button type="button" class="btn solid" id="y-in">Sign in</button><button type="button" class="btn quiet" id="y-new">Create account</button></div></div><p id="y-sent" class="you-note" aria-live="polite"></p><p class="you-note">There is no email recovery yet. If you forget the password, it can be reset from the admin side.</p></section>`}
    <section class="you-sec">
      <div class="you-stats"><div><b>${mine.length}</b>recordings</div><div><b>${priv.length}</b>you</div><div><b>${S.collections.length}</b>collections</div></div>
    </section>
    ${pending.length ? `<section class="you-sec"><h3>Waiting to upload</h3><p>${pending.length} recording${pending.length === 1 ? ' is' : 's are'} saved on this device and will be published when there is a connection.</p><button type="button" class="btn" id="y-retry">Try now</button></section>` : ''}
    <section class="you-sec">
      <h3>Your recordings</h3>
      ${mine.length ? `<ul class="y-list">${rows}</ul>` : '<p>No recordings yet. Everything you publish, public or private, is listed here.</p>'}
    </section>
    ${flacs.length ? `<section class="you-sec"><h3>Older recordings</h3><p>${flacs.length} recording${flacs.length === 1 ? ' is' : 's are'} stored as FLAC, which Safari and iPhone can’t always play. Converting makes a WAV copy of each one on the server. Do it on a computer with Brave or Chrome. The original FLAC is kept.</p><button type="button" class="btn" id="y-convert">Convert ${flacs.length} to WAV</button><p id="y-conv" class="you-note" aria-live="polite"></p></section>` : ''}
    <details class="you-more">
      <summary>Settings</summary>
      <section class="you-sec">
      <h3>Listener key</h3>
      ${key ? `<p>This key proves your recordings are yours. Use it to open your archive on another device. Keep it private; it can’t be recovered if lost.</p>
        <div class="keybox"><span id="y-key">${esc('PS-' + key.slice(3).replace(/[A-Z0-9]/g, '•'))}</span><button type="button" class="btn quiet" id="y-show">Show</button><button type="button" class="btn" id="y-copy">Copy</button></div>
        <div class="row" style="margin-top:10px"><button type="button" class="btn" id="y-link">Copy a link for another device</button></div>`
      : `<p>You don’t have a key yet. One is created on this device the first time you publish a recording.</p>`}
      <div class="row" style="margin-top:10px"><input id="y-in" placeholder="PS-XXXXX-XXXXX-XXXXX-XXXXX" style="flex:1;min-height:38px;padding:0 10px;border-radius:8px;border:1px solid var(--rule);background:var(--paper);text-transform:uppercase" aria-label="Listener key"><button type="button" class="btn" id="y-use">Open this archive</button></div>
    </section>
    <section class="you-sec">
      <h3>Credit</h3>
      <div class="row"><input id="y-name" value="${esc((u && u.name) || prefs.get('credit', ''))}" maxlength="80" placeholder="How recordings are credited" style="flex:1;min-height:38px;padding:0 10px;border-radius:8px;border:1px solid var(--rule);background:var(--paper)" aria-label="Credit name"><button type="button" class="btn" id="y-save-name">Save</button></div>
    </section>
    <section class="you-sec">
      <h3>Collections</h3>
      ${S.collections.length ? S.collections.map(c => `<div class="coll"><span>${esc(c.name)}<small>${c.ids.length}</small></span><span class="row"><button type="button" class="btn quiet" data-show="${esc(c.id)}">Show</button><button type="button" class="btn quiet" data-del="${esc(c.id)}">Delete</button></span></div>`).join('')
      : '<p>None yet. Use “Add to collection” on any entry.</p>'}
    </section>
    <section class="you-sec">
      <h3>Appearance</h3>
      <div class="seg" role="group" aria-label="Appearance">${['auto', 'light', 'dark'].map(t => `<button type="button" data-theme-set="${t}" aria-pressed="${theme === t}">${t === 'auto' ? 'Match device' : t === 'light' ? 'Paper' : 'Night'}</button>`).join('')}</div>
    </section>
    ${mine.length ? `<section class="you-sec"><h3>Export</h3><p>A catalogue of your recordings with links to every original file.</p><button type="button" class="btn" id="y-export">Download catalogue (JSON)</button></section>` : ''}
    ${key ? `<section class="you-sec"><h3>This device</h3><p>Signing out removes the key from this device only. Without the key you can’t edit or delete your recordings.</p><div class="row"><button type="button" class="btn" id="y-rotate">Replace key</button><button type="button" class="btn danger" id="y-out">Sign out of this device</button></div></section>` : ''}    </details>`;
  const on = (id, fn) => { const x = body.querySelector(id); if (x) x.onclick = fn; };
  body.querySelectorAll('[data-open]').forEach(b => b.onclick = () => { $('#you').close(); openCard(b.dataset.open, { fly: true }); });
  on('#y-retry', async () => { $('#you').close(); await flushOutbox(true); });
  let shown = false;
  on('#y-show', () => { shown = !shown; body.querySelector('#y-key').textContent = shown ? key : 'PS-' + key.slice(3).replace(/[A-Z0-9]/g, '•'); body.querySelector('#y-show').textContent = shown ? 'Hide' : 'Show'; });
  on('#y-copy', async () => { await navigator.clipboard.writeText(key).catch(() => {}); toast('Key copied'); });
  on('#y-link', async () => { await navigator.clipboard.writeText(`${location.origin}${location.pathname}#key=${key}`).catch(() => {}); toast('Link copied. Open it on the other device.'); });
  on('#y-use', () => useKey(body.querySelector('#y-in').value));
  on('#y-save-name', async () => {
    const name = body.querySelector('#y-name').value.trim(); prefs.set('credit', name);
    if (identity.key) { try { const d = await call('/api/me', { method: 'PATCH', body: { name } }); identity.setUser(d.user); } catch (e) { return toast(e.message); } }
    toast('Saved');
  });
  body.querySelectorAll('[data-show]').forEach(b => b.onclick = () => { S.collection = b.dataset.show; renderCollectionFilter(); $('#you').close(); setView('index'); refresh(); });
  body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    const c = S.collections.find(x => x.id === b.dataset.del);
    if (!(await ask({ title: `Delete “${c.name}”?`, body: 'The recordings stay in the archive. Only the collection goes.', yes: 'Delete', danger: true }))) return openYou();
    S.collections = S.collections.filter(x => x.id !== c.id); if (S.collection === c.id) S.collection = ''; saveCollections(); refresh(); openYou();
  });
  body.querySelectorAll('[data-theme-set]').forEach(b => b.onclick = () => { prefs.set('theme', b.dataset.themeSet); applyTheme(); mapCtl.retheme(); redrawCard(); renderYou(); });
  on('#y-export', exportCatalogue);
  const signInWith = async create => {
    const email = body.querySelector('#y-email').value.trim().toLowerCase();
    const password = body.querySelector('#y-pass').value;
    const note = body.querySelector('#y-sent');
    note.textContent = '';
    try {
      const d = await call('/api/auth/signin', { method: 'POST', body: { email, password, create }, auth: false });
      identity.set(d.key, d.user); S.full.clear(); await load(); renderYou();
      toast(`Signed in as ${d.user.email}`);
      flushOutbox(false);
    } catch (e) { note.textContent = e.message; }
  };
  on('#y-in', () => signInWith(false));
  on('#y-new', () => signInWith(true));
  on('#y-signout', async () => {
    await call('/api/auth/session', { method: 'DELETE' }).catch(() => {});
    identity.clear(); prefs.set('mine', null); closeCard(); S.full.clear(); await load(); renderYou();
    toast('Signed out on this device');
  });
  on('#y-convert', async () => {
    const btn = body.querySelector('#y-convert'), note = body.querySelector('#y-conv');
    btn.disabled = true;
    let done = 0, failed = 0;
    for (const s of flacs) {
      try {
        await convertToWav(s, p => { note.textContent = `Converting ${done + 1} of ${flacs.length}… ${Math.min(100, Math.round(p * 100))}%`; });
        done++;
      } catch (e) { failed++; console.warn('convert failed', s.id, e); }
    }
    note.textContent = `${done} converted${failed ? `, ${failed} could not be converted. Try again on a computer with Brave or Chrome` : ''}.`;
    S.full.clear(); await load(); renderYou();
  });
  on('#y-rotate', async () => {
    if (!(await ask({ title: 'Replace your key?', body: 'A new key is issued and the old one stops working everywhere. Other devices will need the new key.', yes: 'Replace key' }))) return openYou();
    try { const d = await call('/api/me/rotate', { method: 'POST' }); identity.set(d.key, identity.user); toast('New key issued'); openYou(); } catch (e) { toast(e.message); }
  });
  on('#y-out', async () => {
    $('#you').close();
    const ok = await ask({ title: 'Sign out of this device?', body: 'Make sure you have copied your key first. Without it you can’t edit your recordings.', yes: 'Sign out', danger: true });
    if (!ok) return;
    identity.clear(); prefs.set('mine', null); closeCard(); S.full.clear(); await load(); toast('Signed out of this device');
  });
}
/* Make a WAV copy of an older FLAC recording and point the entry at it. */
async function convertToWav(s, onProgress) {
  const r = await fetch(mediaUrl(s.audio), { cache: 'no-store' });
  if (!r.ok) throw new Error('download failed');
  const ab = await r.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let buf;
  try { buf = await ctx.decodeAudioData(ab); } finally { ctx.close().catch(() => {}); }
  const blob = encodeWav24(buf);
  const key = await upload(blob, 'wav', loaded => onProgress && onProgress(loaded / blob.size));
  await call('/api/sounds/' + s.id, { method: 'PATCH', body: { audioKey: key, codec: 'WAV', lossless: true, bitDepth: 24, sampleRate: buf.sampleRate, channels: Math.min(8, buf.numberOfChannels) } });
  S.full.delete(s.id);
}
async function useKey(raw) {
  const key = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^PS(-[A-Z0-9]{5}){4}$/.test(key)) return toast('That doesn’t look like a listener key (PS-XXXXX-XXXXX-XXXXX-XXXXX).');
  const prev = identity.key, prevUser = identity.user;
  identity.set(key, null);
  try {
    const d = await call('/api/me'); identity.setUser(d.user);
    const c = await call('/api/me/collections').catch(() => null);
    if (c && c.collections && c.collections.length) { S.collections = c.collections; prefs.set('collections', S.collections); renderCollectionFilter(); }
    $('#you').open && $('#you').close();
    S.full.clear(); await load();
    toast(`Archive opened${d.user.name ? ': ' + d.user.name : ''}`);
  } catch (e) {
    if (prev) identity.set(prev, prevUser); else identity.clear();
    toast(e.status === 401 ? 'That key isn’t recognised.' : e.message);
  }
}
async function exportCatalogue() {
  const mine = S.sounds.filter(isMine);
  const out = [];
  for (const s of mine) {
    let f = S.full.get(s.id);
    if (!f) { try { f = (await call('/api/sounds/' + s.id)).sound; S.full.set(f.id, f); } catch { f = s; } }
    out.push({ ...f, audio: mediaUrl(f.audio), spectrogram: mediaUrl(f.spectrogram), photo: mediaUrl(f.photo), accession: accession(f.no) });
  }
  const blob = new Blob([JSON.stringify({ format: 'planet-sound-catalogue', version: 2, exported: new Date().toISOString(), entries: out }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `planet-sound-catalogue-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ---------------- outbox ---------------- */
let flushing = false;
async function flushOutbox(loud) {
  if (flushing) return; flushing = true;
  try {
    const items = await outbox.all();
    let sent = 0;
    for (const e of items) {
      try { const s = await sendEntry(e); sent++; addSound(s); }
      catch (err) { if (loud) toast(err.message); if (err.status === 0) break; }
    }
    if (sent) toast(`${sent} recording${sent === 1 ? '' : 's'} published from this device`);
  } finally { flushing = false; }
}
addEventListener('online', () => flushOutbox(false));
function addSound(s) {
  S.full.set(s.id, s);
  const { notes, peaks, ...lite } = s;
  setSounds([lite, ...S.sounds.filter(x => x.id !== s.id)]);
}

/* ---------------- studio ---------------- */
initStudio({
  pick,
  beforeOpen: () => { player.stop(); $('.bar').classList.remove('open'); },
  onPublished: s => {
    addSound(s);
    setView('map');
    openCard(s.id, { fly: false });
    mapCtl.flyTo(s.lat, s.lng, 12);
    toast(`${accession(s.no)} published${s.visibility === 'private' ? ' to your archive' : ''}`);
  },
  onQueued: () => toast('No connection. The recording is saved on this device and will be published when you’re back online.', 6000),
});

/* ---------------- keyboard ---------------- */
addEventListener('keydown', e => {
  if (!$('#studio').hidden || document.querySelector('dialog[open]')) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (e.key === 'Escape' && !card.hidden) closeCard();
  if (e.key === ' ' && !card.hidden) { e.preventDefault(); player.toggle(); }
  if (e.key === '/') { e.preventDefault(); $('#q').focus(); }
  if (e.key === 'r' || e.key === 'R') openStudio();
});

/* ---------------- boot ---------------- */
(async function boot() {
  if (!API || /REPLACE-ME/.test(API)) toast('Set apiBase in config.js to your Worker URL.', 8000);
  const hashKey = location.hash.match(/key=(PS(?:-[A-Z0-9]{5}){4})/i);
  if (hashKey) {
    history.replaceState(null, '', location.pathname + location.search);
    if (hashKey[1].toUpperCase() !== identity.key && await ask({ title: 'Open this archive here?', body: 'This link carries a listener key. Opening it lets this device edit and remove that archive’s recordings.', yes: 'Open archive' })) await useKey(hashKey[1]);
  }
  renderCollectionFilter();
  await load();
  const p = new URLSearchParams(location.search);
  const target = p.get('no') || p.get('id');
  if (target) openCard(target, { fly: true });
  if (identity.key) call('/api/me/collections').then(d => { if (d.collections && d.collections.length && !S.collections.length) { S.collections = d.collections; prefs.set('collections', S.collections); renderCollectionFilter(); } }).catch(() => {});
  flushOutbox(false);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
