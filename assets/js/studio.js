/* The recorder and the publishing steps. */
import { $, $$, fmtBytes, fmtDb, fmtFormat, fmtTime, toast, ask, tagButtons, toLocalInput, fromLocalInput, placeName, fmtCoords } from './ui.js';
import { supportsRecording, listInputs, openInput, Recorder, importFile, retagFlac, addBext } from './audio/engine.js';
import { ensureIdentity, upload, call, identity } from './api.js';
import { outbox, prefs } from './store.js';
import { drawWave } from './player.js';

const MAX_SECONDS = 60 * 60;    // one hour per take
let deps = null;
let rec = null, inputInfo = null, take = null, state = 'off';
let history = [], clipOn = false, holdDb = [-90, -90], holdT = [0, 0], lastMeter = null, raf = 0;
let t0 = 0, bytes = 0, timer = 0;
let loc = null, tags = [], photo = null, specUrl = null, audioUrl = null;

const el = id => document.getElementById(id);

export function initStudio(d) {
  deps = d;
  el('rec-open').addEventListener('click', openStudio);
  el('s-close').addEventListener('click', closeStudio);
  el('s-rec').addEventListener('click', onRecButton);
  el('s-clip').addEventListener('click', () => { clipOn = false; el('s-clip').classList.remove('on'); });
  el('s-again').addEventListener('click', () => discardTake(true));
  el('s-listen').addEventListener('click', listenBack);
  el('s-keep').addEventListener('click', () => go('place'));
  el('s-file').addEventListener('change', onFile);
  el('s-input').addEventListener('change', () => arm(el('s-input').value));
  $$('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
  el('p-gps').addEventListener('click', useGps);
  el('p-map').addEventListener('click', placeOnMap);
  el('p-next').addEventListener('click', placeNext);
  el('p-lat').addEventListener('change', typedCoords);
  el('p-lng').addEventListener('change', typedCoords);
  el('d-next').addEventListener('click', () => { if (!el('d-title').value.trim()) { el('d-title').focus(); el('d-title').placeholder = 'Give it a title first'; return; } go('publish'); });
  el('d-photo-in').addEventListener('change', e => readPhoto(e.target.files[0]));
  el('d-photo-clear').addEventListener('click', () => { photo = null; showPhoto(); });
  el('u-go').addEventListener('click', publish);
  addEventListener('resize', () => { if (state === 'review') drawReview(); });
  addEventListener('keydown', e => {
    if (el('studio').hidden) return;
    if (e.key === 'Escape') { closeStudio(); }
    if (e.code === 'Space' && currentStep() === 'take' && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); onRecButton(); }
  });
}

function currentStep() { const p = $$('.studio .pane').find(x => !x.hidden); return p && p.dataset.pane; }
function go(step) {
  if (step !== 'take' && !take) return;
  $$('.studio .pane').forEach(p => { p.hidden = p.dataset.pane !== step; });
  const order = ['take', 'place', 'describe', 'publish'];
  $$('.steps li').forEach(li => {
    const i = order.indexOf(li.dataset.step), cur = order.indexOf(step);
    if (i === cur) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    li.classList.toggle('done', i < cur);
  });
  el('studio').scrollTop = 0;
  if (step === 'take') { if (!take) arm(); }
  else releaseInput();
  if (step === 'place') { if (!loc) useGps(true); renderLoc(); }
  if (step === 'describe') {
    const f = el('d-title'); if (!f.value) setTimeout(() => f.focus(), 50);
  }
  if (step === 'publish') {
    const has = !!identity.key;
    el('u-key-note').textContent = has ? 'Published under your listener key. Only you can edit it.'
      : 'Publishing creates a listener key on this device. It proves the recording is yours, so only you can edit it.';
    el('u-credit').value = el('u-credit').value || (identity.user && identity.user.name) || prefs.get('credit', '');
    el('u-msg').textContent = ''; el('u-msg').classList.remove('err');
  }
}

/* ---------------- open / close ---------------- */
export function openStudio() {
  if (!el('studio').hidden) return;
  deps.beforeOpen && deps.beforeOpen();
  el('studio').hidden = false;
  document.body.style.overflow = 'hidden';
  resetForm();
  go('take');
}
async function closeStudio() {
  if (state === 'recording') { const ok = await ask({ title: 'Stop and discard this take?', body: 'The recording in progress will not be kept.', yes: 'Discard', no: 'Keep recording', danger: true }); if (!ok) return; }
  else if (take) { const ok = await ask({ title: 'Discard this recording?', body: 'It hasn’t been published or saved yet.', yes: 'Discard', no: 'Keep it', danger: true }); if (!ok) return; }
  await releaseInput();
  stopListen();
  take = null; state = 'off';
  cancelAnimationFrame(raf);
  el('studio').hidden = true;
  document.body.style.overflow = '';
}
function resetForm() {
  take = null; loc = null; tags.length = 0; photo = null;
  if (specUrl) URL.revokeObjectURL(specUrl); if (audioUrl) URL.revokeObjectURL(audioUrl); specUrl = audioUrl = null;
  ['d-title', 'd-notes', 'p-lat', 'p-lng', 'p-place'].forEach(i => { el(i).value = ''; });
  el('d-title').placeholder = 'Courtyard, early morning';
  el('d-equip').value = prefs.get('equipment', '');
  $$('input[name="vis"]').forEach(r => { r.checked = r.value === 'public'; });
  el('u-dl').checked = prefs.get('allowDownload', false);
  el('u-progress').hidden = true; el('u-go').disabled = false;
  tagButtons(el('d-tags'), tags, { onChange: s => { el('d-tagcount').textContent = s.length ? `${s.length} of 3` : 'up to three'; } });
  el('d-tagcount').textContent = 'up to three';
  showPhoto();
  setIdleUi();
}

/* ---------------- input & metering ---------------- */
async function arm(deviceId) {
  await releaseInput();
  setIdleUi();
  if (!supportsRecording()) { msg('This browser can’t record. You can import a file instead.', true); el('s-rec').disabled = true; return; }
  msg('');
  try {
    const { stream, info } = await openInput(deviceId || prefs.get('input', ''));
    inputInfo = info;
    rec = new Recorder(stream, { channels: info.channels, sampleRate: info.sampleRate, onMeter: onMeter, onProgress: p => { bytes = p.bytes; } });
    await rec.arm();
    state = 'armed';
    el('s-rec').disabled = false;
    el('s-info').textContent = `${(rec.sampleRate / 1000).toFixed(rec.sampleRate % 1000 ? 1 : 0)} kHz, 24-bit FLAC, ${info.channels === 1 ? 'mono' : 'stereo'}` +
      (info.processingOff ? ', voice processing off' : ', the browser may be applying voice processing');
    if (deviceId) prefs.set('input', deviceId);
    const inputs = await listInputs();
    const sel = el('s-input'); sel.innerHTML = '';
    for (const d of inputs) { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || 'Microphone'; if (d.deviceId === info.deviceId || (!info.deviceId && d.label === info.label)) o.selected = true; sel.append(o); }
    sel.parentElement.hidden = inputs.length < 2;
    el('d-equip').placeholder = info.label ? info.label.replace(/\s*\(.*\)\s*$/, '') : 'Phone microphone';
    loop();
  } catch (e) {
    state = 'off';
    el('s-rec').disabled = true;
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    msg(denied ? 'Microphone access is blocked. Allow it in the browser’s site settings, or import a file instead.'
      : 'No microphone could be opened. You can import a file instead.', true);
  }
}
async function releaseInput() {
  const r = rec; rec = null;
  if (r) await r.close();
  if (state === 'armed') state = take ? 'review' : 'off';
}
function onMeter(m) {
  lastMeter = m;
  const pk = Math.max(...m.peak);
  history.push({ v: pk, rec: state === 'recording' });
  if (history.length > 4000) history.splice(0, history.length - 4000);
  if (pk >= 0.999) { clipOn = true; el('s-clip').classList.add('on'); }
}

function loop() {
  cancelAnimationFrame(raf);
  const frame = () => {
    if (el('studio').hidden) return;
    if (state === 'armed' || state === 'recording' || state === 'finishing') { drawLive(); drawMeters(); }
    if (state === 'recording') {
      const s = (performance.now() - t0) / 1000;
      setClock(s);
      el('s-size').textContent = bytes ? `${fmtBytes(bytes)} FLAC` : '';
      if (s >= MAX_SECONDS) stopRecording();
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
}
function setClock(s) {
  const m = Math.floor(s / 60), r = Math.floor(s % 60), t = Math.floor((s * 10) % 10);
  el('s-clock').innerHTML = `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}<small>.${t}</small>`;
}
function colors() {
  const c = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  return { ink: c('--ink'), graphite: c('--graphite'), rule: c('--rule'), signal: c('--signal'), paper: c('--paper') };
}
function fit(cv) {
  const dpr = Math.min(2, devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  return { g, w, h };
}
const toY = v => { const db = v > 0 ? 20 * Math.log10(v) : -120; return Math.max(0, Math.min(1, (db + 60) / 60)); };
function drawLive() {
  const { g, w, h } = fit(el('s-wave')), c = colors();
  const mid = h / 2, nowX = Math.round(w * 0.82), bar = 3;
  g.fillStyle = c.rule; g.fillRect(0, mid - 0.5, w, 1);
  // dBFS guides at −20 and −6
  g.globalAlpha = 0.5; for (const db of [-20, -6]) { const y = ((db + 60) / 60) * (h / 2 - 6); g.fillRect(0, mid - y, w, 1); g.fillRect(0, mid + y, w, 1); } g.globalAlpha = 1;
  const n = Math.floor(nowX / bar);
  const start = Math.max(0, history.length - n);
  for (let i = start; i < history.length; i++) {
    const x = nowX - (history.length - i) * bar;
    const hh = Math.max(1, toY(history[i].v) * (h / 2 - 6));
    g.fillStyle = history[i].v >= 0.999 ? c.signal : history[i].rec ? c.ink : c.graphite;
    g.globalAlpha = history[i].rec ? 1 : 0.4;
    g.fillRect(x, mid - hh, bar - 1, hh * 2);
  }
  g.globalAlpha = 1;
  g.fillStyle = state === 'recording' ? c.signal : c.graphite;
  g.fillRect(nowX, 8, 2, h - 16);
}
function drawMeters() {
  const cv = el('s-meter');
  const { g, w, h } = fit(cv), c = colors();
  const chans = (lastMeter && lastMeter.peak.length) || (inputInfo ? inputInfo.channels : 1);
  const left = 22, right = 64, trackW = w - left - right, rowH = chans === 1 ? 14 : 11, top = 4;
  const now = performance.now();
  const X = db => left + Math.max(0, Math.min(1, (db + 60) / 60)) * trackW;
  g.font = '500 11px Franklin, sans-serif'; g.textBaseline = 'middle';
  for (let ch = 0; ch < chans; ch++) {
    const y = top + ch * (rowH + 4);
    const pk = lastMeter ? lastMeter.peak[ch] : 0, rms = lastMeter ? lastMeter.rms[ch] : 0;
    const pdb = pk > 0 ? 20 * Math.log10(pk) : -90, rdb = rms > 0 ? 20 * Math.log10(rms) : -90;
    if (pdb >= holdDb[ch] || now - holdT[ch] > 2000) { holdDb[ch] = pdb; holdT[ch] = now; }
    g.fillStyle = c.graphite; g.fillText(chans === 1 ? 'M' : ch ? 'R' : 'L', 4, y + rowH / 2);
    g.fillStyle = c.rule; g.fillRect(left, y, trackW, rowH);
    g.fillStyle = c.ink; g.globalAlpha = 0.35; g.fillRect(left, y, X(rdb) - left, rowH); g.globalAlpha = 1;
    g.fillStyle = pdb > -3 ? c.signal : c.ink; g.fillRect(left, y + rowH * 0.25, X(pdb) - left, rowH * 0.5);
    if (holdDb[ch] > -60) { g.fillStyle = holdDb[ch] > -1 ? c.signal : c.ink; g.fillRect(X(holdDb[ch]) - 1, y, 2, rowH); }
    g.fillStyle = c.ink; g.textAlign = 'right';
    g.fillText(holdDb[ch] > -90 ? fmtDb(holdDb[ch]) : '−∞', w - 8, y + rowH / 2);
    g.textAlign = 'left';
  }
  const sy = top + chans * (rowH + 4) + 8;
  g.fillStyle = c.graphite; g.font = '10.5px Franklin, sans-serif'; g.textAlign = 'center';
  for (const db of (w < 520 ? [-60, -40, -20, -12, -6, 0] : [-60, -40, -30, -20, -12, -6, -3, 0])) { g.fillRect(X(db), sy - 6, 1, 4); g.fillText(db ? String(db).replace('-', '−') : '0', X(db), sy + 4); }
  g.textAlign = 'right'; g.fillText('dBFS', w - 8, sy + 4); g.textAlign = 'left';
}

function setIdleUi() {
  history = []; clipOn = false; holdDb = [-90, -90];
  el('s-clip').classList.remove('on');
  el('s-rec').className = 'big-rec'; el('s-rec').setAttribute('aria-label', 'Start recording');
  el('s-review').hidden = true; el('s-spec').hidden = true; el('s-wave').hidden = false;
  el('s-size').textContent = ''; setClock(0);
  $('.alt').hidden = false; el('s-input').disabled = false;
}

/* ---------------- recording ---------------- */
async function onRecButton() {
  if (state === 'armed') startRecording();
  else if (state === 'recording') stopRecording();
  else if (state === 'review') listenBack();
}
function startRecording() {
  if (!rec) return;
  history = history.slice(-60);
  rec.record();
  const r = rec;
  setTimeout(() => { if (rec === r && state === 'recording' && r.ctx && r.ctx.state !== 'running') msg('The phone has not started the microphone. Tap the square to stop, then record again.', true); }, 1500);
  state = 'recording'; t0 = performance.now(); bytes = 0;
  el('s-rec').className = 'big-rec on'; el('s-rec').setAttribute('aria-label', 'Stop recording');
  el('s-input').disabled = true; $('.alt').hidden = true;
  msg('Recording. Tap the square to stop.');
  if (navigator.wakeLock) navigator.wakeLock.request('screen').then(l => { rec && (rec.wake = l); }).catch(() => {});
}
async function stopRecording() {
  if (!rec || state !== 'recording') return;
  state = 'finishing';
  el('s-rec').disabled = true;
  msg('Finishing the file…');
  try {
    if (rec.wake) rec.wake.release().catch(() => {});
    const result = await rec.stop();
    await adoptTake(result);
  } catch (e) {
    console.error(e); msg('The recording could not be finished. Please try again.', true); state = 'armed';
  } finally { el('s-rec').disabled = false; }
}
async function onFile(e) {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (state === 'recording') return;
  await releaseInput();
  msg('Reading the file…');
  el('s-rec').disabled = true;
  try {
    const r = await importFile(f, p => msg(`Reading the file… ${Math.round(p.fraction * 100)}%`));
    r.fileName = f.name;
    if (!el('d-title').value) el('d-title').value = f.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 140);
    await adoptTake(r);
  } catch (err) {
    msg(err.message || 'That file could not be read.', true);
    el('s-rec').disabled = false;
    arm();
  }
}
async function adoptTake(r) {
  take = r; state = 'review';
  lastMeter = null; holdDb = [-90, -90];
  await releaseInput();
  if (specUrl) URL.revokeObjectURL(specUrl);
  specUrl = r.spectrogram ? URL.createObjectURL(r.spectrogram) : null;
  el('s-rec').className = 'big-rec review'; el('s-rec').setAttribute('aria-label', 'Listen back'); el('s-rec').disabled = false;
  el('s-review').hidden = false; $('.alt').hidden = true;
  setClock(r.duration);
  const t = r.tech;
  el('s-size').textContent = `${fmtBytes(r.master.size)} ${t.codec}`;
  const facts = [fmtFormat(t)];
  if (r.lufs != null) facts.push(`${fmtDb(r.lufs)} LUFS integrated`);
  if (r.peakDb != null) facts.push(`peak ${fmtDb(r.peakDb)} dBFS`);
  el('s-info').textContent = facts.join(', ');
  if (r.clippedSamples > 0) { clipOn = true; el('s-clip').classList.add('on'); }
  msg(r.duration < 1 ? 'That take is under a second long. Record again?' :
    r.clippedSamples > 0 ? `Listen back before you keep it. ${r.clippedSamples.toLocaleString()} samples hit full scale; the loud parts may be distorted.` :
    r.peakDb != null && r.peakDb < -40 ? 'Listen back before you keep it. The level is very low; that may be right for a quiet place.' :
    'Listen back before you keep it.');
  drawReview();
}
function drawReview() {
  if (!take) return;
  const s = el('s-spec');
  if (specUrl) {
    s.hidden = false; s.classList.remove('empty');
    s.style.webkitMaskImage = s.style.maskImage = `url(${specUrl})`;
    el('s-wave').hidden = true;
  } else {
    el('s-wave').hidden = false;
    drawWave(el('s-wave'), take.peaks, 1);
  }
  drawMeters();
}
async function discardTake(rearm) {
  const ok = !take || await ask({ title: 'Record again?', body: 'This take will be discarded.', yes: 'Discard take', no: 'Keep it', danger: true });
  if (!ok) return;
  stopListen();
  take = null; state = 'off';
  if (rearm) arm();
}
function listenBack() {
  const a = el('s-audio');
  if (!take) return;
  if (!a.paused) { stopListen(); return; }
  if (!audioUrl) audioUrl = URL.createObjectURL(take.master);
  if (a.src !== audioUrl) a.src = audioUrl;
  a.currentTime = 0;
  a.play().then(() => { el('s-listen').textContent = 'Stop'; }).catch(() => msg('This browser can’t play the file back, but it will be stored as recorded.', true));
  a.onended = stopListen;
}
function stopListen() { const a = el('s-audio'); try { a.pause(); } catch {} el('s-listen').textContent = 'Listen back'; }
function msg(t, err) { const m = el('s-msg'); m.textContent = t; m.classList.toggle('err', !!err); }

/* ---------------- place ---------------- */
function renderLoc() {
  el('p-loc').textContent = loc ? fmtCoords(loc.lat, loc.lng) + (loc.acc ? ` (within ${Math.round(loc.acc)} m)` : '') : 'Not set';
  if (loc) { el('p-lat').value = loc.lat.toFixed(5); el('p-lng').value = loc.lng.toFixed(5); }
}
async function setLoc(lat, lng, acc) {
  loc = { lat, lng, acc }; renderLoc();
  const name = await placeName(lat, lng);
  if (name && (!el('p-place').value || el('p-place').dataset.auto === '1')) { el('p-place').value = name; el('p-place').dataset.auto = '1'; }
}
function useGps(quiet) {
  if (!navigator.geolocation) { if (quiet !== true) el('p-loc').textContent = 'This device can’t share its position. Place it on the map instead.'; return; }
  if (quiet !== true) el('p-loc').textContent = 'Finding your position…';
  navigator.geolocation.getCurrentPosition(
    p => setLoc(p.coords.latitude, p.coords.longitude, p.coords.accuracy),
    () => { if (quiet !== true || !loc) el('p-loc').textContent = 'Position unavailable. Place it on the map or type coordinates.'; },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
}
function typedCoords() {
  const la = parseFloat(el('p-lat').value.replace(',', '.')), lo = parseFloat(el('p-lng').value.replace(',', '.'));
  if (isFinite(la) && isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) setLoc(la, lo);
}
async function placeOnMap() {
  el('studio').hidden = true;
  const r = await deps.pick(loc ? { lat: loc.lat, lng: loc.lng, zoom: 15 } : null);
  el('studio').hidden = false;
  if (r) setLoc(r.lat, r.lng);
}
function placeNext() {
  typedCoords();
  if (!loc) { el('p-loc').textContent = 'Set where it was recorded first.'; return; }
  if (!el('d-when').value) el('d-when').value = toLocalInput(take.recordedAt);
  go('describe');
}

/* ---------------- describe ---------------- */
async function readPhoto(f) {
  if (!f) return;
  try { photo = await shrinkImage(f); showPhoto(); }
  catch { toast('That image could not be read.'); }
}
export async function shrinkImage(f, max = 1600) {
  const bmp = await createImageBitmap(f);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * s); cv.height = Math.round(bmp.height * s);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  return await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.86));
}
function showPhoto() {
  const p = el('d-photo');
  if (photo) { p.style.backgroundImage = `url(${URL.createObjectURL(photo)})`; p.textContent = ''; el('d-photo-clear').hidden = false; }
  else { p.style.backgroundImage = ''; p.textContent = 'None'; el('d-photo-clear').hidden = true; }
}

/* ---------------- publish ---------------- */
async function publish() {
  const btn = el('u-go');
  btn.disabled = true;
  const vis = $('input[name="vis"]:checked').value;
  const credit = el('u-credit').value.trim();
  prefs.set('credit', credit); prefs.set('equipment', el('d-equip').value.trim()); prefs.set('allowDownload', el('u-dl').checked);
  const meta = {
    id: crypto.randomUUID(),
    title: el('d-title').value.trim() || 'Untitled recording',
    notes: el('d-notes').value.trim(),
    tags: tags.slice(),
    lat: loc.lat, lng: loc.lng, place: el('p-place').value.trim(),
    recordedAt: fromLocalInput(el('d-when').value) || take.recordedAt,
    equipment: el('d-equip').value.trim(),
    credit, visibility: vis, allowDownload: el('u-dl').checked,
    duration: take.duration, lufs: take.lufs, peakDb: take.peakDb, backgroundLufs: take.backgroundLufs,
    clippedSamples: take.clippedSamples, peaks: take.peaks, tech: take.tech,
  };
  let master = take.master;
  if (take.mime === 'audio/wav' && take.tech.source === 'recorded') {
    master = await addBext(master, { title: meta.title, place: meta.place, id: meta.id, recordedAt: meta.recordedAt, channels: take.tech.channels });
  } else if (take.mime === 'audio/flac' && take.tech.source !== 'imported') {
    master = await retagFlac(master, {
      TITLE: meta.title, ARTIST: credit, DATE: meta.recordedAt, LOCATION: meta.place,
      COORDINATES: `${meta.lat.toFixed(6)},${meta.lng.toFixed(6)}`, DESCRIPTION: meta.notes, GENRE: 'Field recording',
      EQUIPMENT: meta.equipment, ORGANIZATION: 'Planet Sound', LOUDNESS: meta.lufs != null ? `${meta.lufs} LUFS` : '',
    });
  }
  const entry = { id: meta.id, meta, ext: take.ext, created: Date.now(), files: { audio: master, spectrogram: take.spectrogram, photo }, keys: {} };
  await outbox.put(entry).catch(() => {});
  el('u-progress').hidden = false;
  el('u-msg').textContent = 'Uploading…'; el('u-msg').classList.remove('err');
  try {
    const sound = await sendEntry(entry, f => { el('u-progress').firstElementChild.style.width = (f * 100).toFixed(1) + '%'; });
    take = null; state = 'off';
    el('studio').hidden = true; document.body.style.overflow = '';
    deps.onPublished(sound);
  } catch (e) {
    console.warn(e);
    btn.disabled = false;
    if (e.status && e.status !== 0 && e.status < 500 && e.status !== 429) {
      el('u-msg').textContent = e.message; el('u-msg').classList.add('err');
      return;
    }
    // network trouble: it is safe in the outbox and will go up later
    take = null; state = 'off';
    el('studio').hidden = true; document.body.style.overflow = '';
    deps.onQueued(entry, e);
  }
}

/** Upload an outbox entry (resuming where it left off) and create it. */
export async function sendEntry(entry, onFraction) {
  const m = entry.meta;
  await ensureIdentity(m.credit);
  const files = Object.entries(entry.files).filter(([, b]) => b);
  const total = files.reduce((a, [, b]) => a + b.size, 0) || 1;
  let done = 0;
  for (const [k, b] of files) {
    if (!entry.keys[k]) {
      const ext = k === 'audio' ? entry.ext : k === 'photo' ? 'jpg' : 'png';
      entry.keys[k] = await upload(b, ext, loaded => onFraction && onFraction((done + loaded) / total));
      await outbox.patch(entry.id, { keys: entry.keys }).catch(() => {});
    }
    done += b.size; onFraction && onFraction(done / total);
  }
  const r = await call('/api/sounds', { method: 'POST', body: { ...m, audioKey: entry.keys.audio, spectrogramKey: entry.keys.spectrogram || null, photoKey: entry.keys.photo || null } });
  await outbox.remove(entry.id).catch(() => {});
  // remember that this device (with this key) published it, so it always shows in Your archive
  try {
    const k = identity.key, prev = prefs.get('mine', null);
    const ids = prev && prev.key === k ? (prev.ids || []) : [];
    if (k && !ids.includes(r.sound.id)) prefs.set('mine', { key: k, ids: [...ids, r.sound.id].slice(-5000) });
  } catch {}
  return { ...r.sound, mine: true };
}
