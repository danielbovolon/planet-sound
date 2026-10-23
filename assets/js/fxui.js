/* Planet Sound — "Sound shaping" panel inside the sound panel: Tape, Multiband, Granulator, Delay, Reverb.
 *
 * Every control changes fxState (fx.js). The player plays through the effects while any of it is on,
 * and Export WAV / Export spectrogram render the same settings over the whole recording.
 * The settings belong to the entry on screen: a different entry starts clean.
 */
import { createKnob } from './knobs.js';
import { initGrainUi } from './grainui.js';
import { initSpaceUi } from './spaceui.js';
let tpPre = { i: '', snap: null }, mbPre = { i: '', snap: null };   // the chosen preset stays shown while the settings still match it
import { fxState, loadDsp, TAPE_PRESETS, MB_PRESETS, applyTapePreset, applyMbPreset } from './fx.js';

const $ = (s, r = document) => r.querySelector(s);
const tapeSnap = p => JSON.stringify([p.tape, p.speed]);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const BAND_COLORS = ['#D9A321', '#2A9D9F', '#D9663A'];
const BAND_NAMES = ['Low', 'Mid', 'High'];
const sign = v => (v > 0 ? '+' : v < 0 ? '−' : '');
const dbf = v => `${sign(v)}${Math.abs(v).toFixed(1)} dB`;
const hzf = v => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`);
const msf = v => (v < 1 ? `${v.toFixed(2)} ms` : v < 10 ? `${v.toFixed(1)} ms` : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);
const ratio = v => `1 : ${v.toFixed(2)}`;
const pct = v => (v ? `${Math.round(v)} %` : 'Off');
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

export async function initFxUi({ player, toast }) {
  const box = $('#shape');
  if (!box) return { setSound() {} };
  let dsp;
  try { dsp = await loadDsp(); await fxState.init(); } catch (e) { console.warn('Sound shaping unavailable', e); box.remove(); return { setSound() {} }; }
  const R = dsp.RANGES;
  const rack = $('#rack'), tapeEl = $('#rk-tape'), mbEl = $('#rk-mb'), note = $('#rack-note'), stateEl = $('#shape-state');
  let sel = 0, soundId = null, noteTimer = 0;
  const K = { tape: {}, mb: {}, band: [], gain: [] };

  const say = (t, err = false) => { note.textContent = t; note.classList.toggle('err', err); };
  const P = () => fxState.get();
  /** Change settings. `auto` turns the named effect on (any knob you touch, you want to hear). */
  const chg = (auto, f) => fxState.update(d => { f(d); if (auto) d[auto].on = true; });

  /* ---------------- Tape ---------------- */
  tapeEl.innerHTML = `
    <div class="rack-head">
      <button type="button" class="sw" id="tp-on" aria-pressed="false"><i class="lamp"></i>On</button>
      <select id="tp-pre" aria-label="Tape preset"><option value="">Presets…</option>${TAPE_PRESETS.map(([n], i) => `<option value="${i}">${n}</option>`).join('')}</select>
      <span class="mini-seg" id="tp-type" role="group" aria-label="Tape machine">
        <button type="button" data-t="cass" title="Cassette">Cass</button><button type="button" data-t="7" title="7½ inches per second">7½</button><button type="button" data-t="15" title="15 inches per second">15</button><button type="button" data-t="30" title="30 inches per second">30</button>
      </span>
    </div>
    <div class="grp"><h4>Transport</h4><div class="knobs three" id="tp-g1"></div></div>
    <div class="grp"><h4>Saturation</h4><div class="knobs" id="tp-g2"></div></div>
    <div class="grp"><h4>Tone</h4><div class="knobs" id="tp-g3"></div></div>
    <div class="grp"><h4>Echo · output</h4><div class="knobs three" id="tp-g4"></div></div>`;
  const kn = (parent, o) => { const h = el('div'); parent.append(h); return createKnob(h, { small: true, ...o }); };
  const pctKnob = (parent, key, label, hint) => kn(parent, {
    label, min: 0, max: 100, step: 1, value: 0, def: 0, origin: 0, format: pct, speech: v => (v ? `${v} percent` : 'off'), hint,
    onInput: v => chg('tape', d => { d.tape[key] = v / 100; }),
  });
  K.tape.speed = kn($('#tp-g1'), {
    label: 'Speed', min: R.speed[0], max: R.speed[1], scale: 'log', steps: 240, value: 1, def: 1, origin: 1, detent: true, round: v => +v.toFixed(3),
    format: v => `${Math.round(v * 100)} %`, speech: v => `${Math.round(v * 100)} percent of normal speed`,
    hint: 'Playback speed, like a tape machine: pitch and time move together. Double-click to reset.',
    onInput: v => chg(null, d => { d.speed = v; }),
  });
  K.tape.pitch = kn($('#tp-g1'), {
    label: 'Pitch', min: -12, max: 12, step: 0.1, value: 0, def: 0, origin: 0, detent: true,
    format: v => (v ? `${sign(v)}${Math.abs(v).toFixed(1)} st` : '0 st'), speech: v => `${v.toFixed(1)} semitones`,
    hint: 'Pitch shift in semitones. The speed stays the same.',
    onInput: v => chg('tape', d => { d.tape.pitch = v; }),
  });
  K.tape.wow = pctKnob($('#tp-g1'), 'wow', 'Wow', 'Wow and flutter: the slow and fast pitch wobble of a tape transport.');
  K.tape.sat = pctKnob($('#tp-g2'), 'sat', 'Saturate', 'Tape saturation. The highs give way first, like real tape.');
  K.tape.tube = pctKnob($('#tp-g2'), 'tube', 'Tube', 'Even-harmonic warmth, like a valve stage.');
  K.tape.drive = pctKnob($('#tp-g2'), 'drive', 'Overdrive', 'A harder, grittier drive stage.');
  K.tape.comp = pctKnob($('#tp-g2'), 'comp', 'Compress', 'Tape compression: peaks are squashed softly, the quiet parts come up.');
  K.tape.warmth = pctKnob($('#tp-g3'), 'warmth', 'Warmth', 'Head bump in the lows and a gentle roll-off at the top. What it does depends on the machine.');
  K.tape.hp = kn($('#tp-g3'), {
    label: 'High-pass', min: R.tape.hp[0], max: R.tape.hp[1], scale: 'log', steps: 120, value: 20, def: 20, origin: 20, round: v => Math.round(v),
    format: v => (v <= 20.5 ? 'Off' : hzf(v)), speech: v => (v <= 20.5 ? 'off' : `${Math.round(v)} hertz`), hint: 'Cuts the lows.',
    onInput: v => chg('tape', d => { d.tape.hp = v; }),
  });
  K.tape.lp = kn($('#tp-g3'), {
    label: 'Low-pass', min: R.tape.lp[0], max: R.tape.lp[1], scale: 'log', steps: 120, value: 22000, def: 22000, origin: 22000, round: v => Math.round(v / 10) * 10,
    format: v => (v >= 21900 ? 'Off' : hzf(v)), speech: v => (v >= 21900 ? 'off' : `${Math.round(v)} hertz`), hint: 'Cuts the highs.',
    onInput: v => chg('tape', d => { d.tape.lp = v; }),
  });
  K.tape.hiss = pctKnob($('#tp-g3'), 'hiss', 'Hiss', 'Tape hiss added under the sound.');
  K.tape.slap = pctKnob($('#tp-g4'), 'slap', 'Slap', 'A tape slapback echo, dark and a little wobbly.');
  K.tape.slapMs = kn($('#tp-g4'), {
    label: 'Time', min: 30, max: 400, step: 1, value: 120, def: 120, origin: 30, format: v => `${Math.round(v)} ms`, hint: 'Delay time of the slap echo.',
    onInput: v => chg('tape', d => { d.tape.slapMs = v; }),
  });
  K.tape.vol = kn($('#tp-g4'), {
    label: 'Volume', min: -18, max: 18, step: 0.5, value: 0, def: 0, origin: 0, format: dbf, speech: v => `${v.toFixed(1)} decibels`, hint: 'Output level of the tape.',
    onInput: v => chg('tape', d => { d.tape.vol = v; }),
  });
  $('#tp-on').addEventListener('click', () => chg(null, d => { d.tape.on = !d.tape.on; }));
  $('#tp-pre').addEventListener('change', e => { const i = e.target.value; if (i === '') return; fxState.update(d => applyTapePreset(d, TAPE_PRESETS[+i][1])); tpPre = { i, snap: tapeSnap(fxState.get()) }; $('#tp-pre').value = i; });
  $('#tp-type').addEventListener('click', e => { const b = e.target.closest('button[data-t]'); if (b) chg('tape', d => { d.tape.type = b.dataset.t; }); });

  /* ---------------- Multiband ---------------- */
  mbEl.innerHTML = `
    <div class="rack-head">
      <button type="button" class="sw" id="mb-on" aria-pressed="false"><i class="lamp"></i>On</button>
      <select id="mb-pre" aria-label="Multiband preset"><option value="">Presets…</option>${MB_PRESETS.map(([n], i) => `<option value="${i}">${n}</option>`).join('')}</select>
      <span class="mini-seg" id="mb-det" role="group" aria-label="Level detection"><button type="button" data-r="1" title="Follow the average level">RMS</button><button type="button" data-r="0" title="Follow the peaks">Peak</button></span>
      <span class="mini-seg" id="mb-knee" role="group" aria-label="Knee"><button type="button" data-k="1">Soft knee</button><button type="button" data-k="0">Hard</button></span>
    </div>
    <div class="strip" id="mb-strip"><canvas aria-label="The three bands. Drag the two lines to move the crossover frequencies."></canvas></div>
    <div class="knobs" id="mb-g0"></div>
    <div class="band-tabs" id="mb-tabs" role="tablist" aria-label="Band"></div>
    <div class="band-body"><canvas class="curve" id="mb-curve" aria-label="Transfer curve of the selected band"></canvas><div class="knobs" id="mb-g1"></div></div>`;
  K.mb.amount = kn($('#mb-g0'), {
    label: 'Amount', min: 0, max: 200, step: 1, value: 100, def: 100, origin: 0, format: v => `${Math.round(v)} %`, hint: 'How much of the compression is applied. 100 % is as set; 0 is off; more is more.',
    onInput: v => chg('mb', d => { d.mb.amount = v / 100; }),
  });
  K.mb.time = kn($('#mb-g0'), {
    label: 'Time', min: 0.1, max: 4, scale: 'log', steps: 120, value: 1, def: 1, origin: 1, detent: true, round: v => +v.toFixed(2), format: v => `${Math.round(v * 100)} %`,
    hint: 'Scales every attack and release time. Below 100 % is faster, above is slower.',
    onInput: v => chg('mb', d => { d.mb.time = v; }),
  });
  K.mb.range = kn($('#mb-g0'), {
    label: 'Range', min: 0, max: 36, step: 1, value: 24, def: 24, origin: 0, format: v => `${Math.round(v)} dB`, hint: 'The most a band can be turned up (upward compression).',
    onInput: v => chg('mb', d => { d.mb.range = v; }),
  });
  K.mb.out = kn($('#mb-g0'), {
    label: 'Output', min: -24, max: 24, step: 0.5, value: 0, def: 0, origin: 0, format: dbf, hint: 'Output level.',
    onInput: v => chg('mb', d => { d.mb.out = v; }),
  });
  const tabs = $('#mb-tabs');
  for (let b = 0; b < 3; b++) {
    const t = el('div', 'band-tab'); t.setAttribute('role', 'tab'); t.tabIndex = 0; t.dataset.b = b; t.style.setProperty('--bc', BAND_COLORS[b]);
    t.innerHTML = `<span class="bt-name"><i></i>${BAND_NAMES[b]}</span><span class="bt-hz"></span><span class="bt-btns"><button type="button" class="on" data-a="on" title="Band on. Off: the band passes through untouched." aria-label="${BAND_NAMES[b]} band on">On</button><button type="button" data-a="solo" title="Hear only this band" aria-label="Solo ${BAND_NAMES[b]} band">Solo</button></span><span class="bt-gain"></span>`;
    tabs.append(t);
    K.gain.push(kn(t.querySelector('.bt-gain'), {
      label: 'Gain', min: -24, max: 24, step: 0.5, value: 0, def: 0, origin: 0, format: dbf, speech: v => `${BAND_NAMES[b]} band gain ${dbf(v)}`,
      hint: `${BAND_NAMES[b]} band level, after the compressor. Double-click to reset.`,
      onInput: v => chg('mb', d => { d.mb.bands[b].outDb = v; }),
    }));
  }
  const g1 = $('#mb-g1');
  const bk = (label, key, o) => { const k = kn(g1, { label, ...o, onInput: v => chg('mb', d => { d.mb.bands[sel][key] = v; }) }); K.band.push([key, k]); return k; };
  bk('Above', 'aThr', { min: -60, max: 0, step: 0.5, value: 0, def: 0, origin: 0, format: dbf, hint: 'Threshold above which the band is turned down.' });
  bk('Ratio ↓', 'aRat', { min: 1, max: 20, scale: 'log', steps: 160, value: 1, def: 1, origin: 1, round: v => +v.toFixed(2), format: ratio, hint: 'Compression ratio above the threshold. 1 : 1 does nothing.' });
  bk('Below', 'bThr', { min: -90, max: -5, step: 0.5, value: -90, def: -90, origin: -90, format: dbf, hint: 'Threshold below which the band is turned up (or down, if the ratio is under 1).' });
  bk('Ratio ↑', 'bRat', { min: 0.25, max: 4, scale: 'log', steps: 160, value: 1, def: 1, origin: 1, detent: true, round: v => +v.toFixed(2), format: ratio, hint: 'Above 1: upward compression, quiet parts come up. Below 1: an expander, quiet parts go down.' });
  bk('Attack', 'atk', { min: 0.05, max: 300, scale: 'log', steps: 160, value: 20, def: 20, origin: 0.05, round: v => (v < 1 ? +v.toFixed(2) : v < 10 ? +v.toFixed(1) : Math.round(v)), format: msf, hint: 'How fast the band is turned down.' });
  bk('Release', 'rel', { min: 5, max: 3000, scale: 'log', steps: 160, value: 200, def: 200, origin: 5, round: v => Math.round(v), format: msf, hint: 'How fast the band comes back.' });
  bk('Input', 'inDb', { min: -24, max: 24, step: 0.5, value: 0, def: 0, origin: 0, format: dbf, hint: 'Level into the band, before the compressor.' });
  K.mb.lo = kn($('#mb-g0'), {
    label: 'Low split', min: R.mb.lo[0], max: R.mb.lo[1], scale: 'log', steps: 160, value: 100, def: 100, origin: 20, round: v => +v.toPrecision(3), format: hzf, hint: 'Crossover between the low and mid bands.',
    onInput: v => chg('mb', d => { d.mb.lo = v; }),
  });
  K.mb.hi = kn($('#mb-g0'), {
    label: 'High split', min: R.mb.hi[0], max: R.mb.hi[1], scale: 'log', steps: 160, value: 2500, def: 2500, origin: 400, round: v => +v.toPrecision(3), format: hzf, hint: 'Crossover between the mid and high bands.',
    onInput: v => chg('mb', d => { d.mb.hi = v; }),
  });
  $('#mb-g0').classList.add('three'); $('#mb-g0').style.gridTemplateColumns = 'repeat(3, 1fr)';
  $('#mb-on').addEventListener('click', () => chg(null, d => { d.mb.on = !d.mb.on; }));
  $('#mb-pre').addEventListener('change', e => { const i = e.target.value; if (i === '') return; fxState.update(d => applyMbPreset(d, MB_PRESETS[+i][1])); mbPre = { i, snap: JSON.stringify(fxState.get().mb) }; $('#mb-pre').value = i; });
  $('#mb-det').addEventListener('click', e => { const b = e.target.closest('button[data-r]'); if (b) chg('mb', d => { d.mb.rms = b.dataset.r === '1'; }); });
  $('#mb-knee').addEventListener('click', e => { const b = e.target.closest('button[data-k]'); if (b) chg('mb', d => { d.mb.knee = b.dataset.k === '1'; }); });
  tabs.addEventListener('click', e => {
    const t = e.target.closest('.band-tab'); if (!t) return;
    const b = +t.dataset.b, a = e.target.closest('button[data-a]');
    if (a) { chg('mb', d => { const bd = d.mb.bands[b]; if (a.dataset.a === 'on') bd.on = !bd.on; else bd.solo = !bd.solo; }); return; }
    sel = b; syncBands(P()); drawCurve();
  });
  tabs.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('band-tab')) { e.preventDefault(); sel = +e.target.dataset.b; syncBands(P()); drawCurve(); } });
  $('#rk-safe').addEventListener('change', e => chg(null, d => { d.safe = e.target.checked; }));
  $('#rk-reset').addEventListener('click', () => { fxState.reset(); say('Back to a clean sound.'); clearTimeout(noteTimer); noteTimer = setTimeout(() => say(''), 2500); });

  /* tabs: Tape | Multiband */
  const grEl = $('#rk-gr');
  const grain = initGrainUi({ host: grEl, player, chg, say });
  player.onFxBake = s => grain.onBake(s);
  const dlEl = $('#rk-dl'), rvEl = $('#rk-rv');
  const space = initSpaceUi({ dlHost: dlEl, rvHost: rvEl, chg });
  const tabBtns = [$('#tab-tape'), $('#tab-mb'), $('#tab-gr'), $('#tab-dl'), $('#tab-rv')], panes = [tapeEl, mbEl, grEl, dlEl, rvEl];
  function showTab(i) { tabBtns.forEach((b, k) => b.setAttribute('aria-selected', String(k === i))); panes.forEach((p, k) => { p.hidden = k !== i; }); if (i === 1) { sizeCanvases(); drawStrip(); drawCurve(); } if (i === 2) grain.draw(); if (i >= 3) space.draw(); }
  tabBtns.forEach((b, i) => b.addEventListener('click', () => showTab(i)));

  /* ---------------- state → controls ---------------- */
  function syncBands(p) {
    const B = p.mb.bands[sel];
    for (const [key, k] of K.band) k.set(B[key], false);
    [...tabs.children].forEach((t, b) => {
      const bd = p.mb.bands[b];
      K.gain[b].set(bd.outDb, false);
      t.setAttribute('aria-selected', String(b === sel));
      const [on, solo] = t.querySelectorAll('.bt-btns button');
      on.setAttribute('aria-pressed', String(bd.on)); solo.setAttribute('aria-pressed', String(bd.solo));
      const lo = b === 0 ? 20 : p.mb.lo, hi = b === 2 ? 20000 : b === 0 ? p.mb.lo : p.mb.hi;
      t.querySelector('.bt-hz').textContent = b === 0 ? `up to ${hzf(p.mb.lo)}` : b === 1 ? `${hzf(p.mb.lo)} – ${hzf(p.mb.hi)}` : `from ${hzf(p.mb.hi)}`;
    });
  }
  function sync(p) {
    const t = p.tape;
    K.tape.speed.set(p.speed, false); K.tape.pitch.set(t.pitch, false); K.tape.wow.set(t.wow * 100, false);
    K.tape.sat.set(t.sat * 100, false); K.tape.tube.set(t.tube * 100, false); K.tape.drive.set(t.drive * 100, false); K.tape.comp.set(t.comp * 100, false);
    K.tape.warmth.set(t.warmth * 100, false); K.tape.hp.set(t.hp, false); K.tape.lp.set(t.lp, false); K.tape.hiss.set(t.hiss * 100, false);
    K.tape.slap.set(t.slap * 100, false); K.tape.slapMs.set(t.slapMs, false); K.tape.vol.set(t.vol, false);
    $('#tp-on').setAttribute('aria-pressed', String(t.on)); $('#tp-on .lamp').classList.toggle('on', t.on);
    $$('#tp-type button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.t === t.type)));
    const m = p.mb;
    K.mb.amount.set(m.amount * 100, false); K.mb.time.set(m.time, false); K.mb.range.set(m.range, false); K.mb.out.set(m.out, false); K.mb.lo.set(m.lo, false); K.mb.hi.set(m.hi, false);
    $('#mb-on').setAttribute('aria-pressed', String(m.on)); $('#mb-on .lamp').classList.toggle('on', m.on);
    $$('#mb-det button').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.r === '1') === m.rms)));
    $$('#mb-knee button').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.k === '1') === m.knee)));
    syncBands(p);
    $('#lamp-tape').classList.toggle('on', t.on); $('#lamp-mb').classList.toggle('on', m.on); $('#lamp-gr').classList.toggle('on', p.grain.on);
    $('#lamp-dl').classList.toggle('on', p.delay.on); $('#lamp-rv').classList.toggle('on', p.verb.on);
    grain.sync(p); grEl.classList.toggle('off', !p.grain.on); space.sync(p);
    $('#rk-safe').checked = p.safe;
    tapeEl.classList.toggle('off', !t.on); mbEl.classList.toggle('off', !m.on);
    const parts = []; if (t.on) parts.push('Tape'); if (m.on) parts.push('Multiband'); if (p.grain.on) parts.push('Granulator'); if (p.delay.on) parts.push('Delay'); if (p.verb.on) parts.push('Reverb'); if (p.speed !== 1) parts.push(`${Math.round(p.speed * 100)} % speed`);
    stateEl.textContent = parts.length ? parts.join(' + ') : 'Off'; stateEl.classList.toggle('live', parts.length > 0);
    box.dataset.shaped = parts.length ? '1' : '';
    $('#tp-pre').value = tpPre.snap && tapeSnap(p) === tpPre.snap ? tpPre.i : '';
    $('#mb-pre').value = mbPre.snap && JSON.stringify(p.mb) === mbPre.snap ? mbPre.i : '';
    drawStrip(); drawCurve();
  }

  /* ---------------- drawing: band strip and transfer curve ---------------- */
  const stripCv = $('#mb-strip canvas'), curveCv = $('#mb-curve');
  let W = 0, H = 0;
  function sizeCanvases() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    for (const cv of [stripCv, curveCv]) {
      const w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) continue;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    }
  }
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const f2x = (f, w) => (Math.log(f / 20) / Math.log(1000)) * w;
  const x2f = (x, w) => 20 * Math.pow(1000, Math.max(0, Math.min(1, x / w)));
  function drawStrip() {
    const cv = stripCv; if (!cv || mbEl.hidden || !cv.clientWidth) return;
    const dpr = cv.width / cv.clientWidth, w = cv.clientWidth, h = cv.clientHeight, g = cv.getContext('2d'), p = P();
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const ink = css('--ink'), grey = css('--graphite');
    const xs = [0, f2x(p.mb.lo, w), f2x(p.mb.hi, w), w], live = player.fxp && player.fxp.meters && player.fxMode ? player.fxp.meters : null;
    for (let b = 0; b < 3; b++) {
      g.globalAlpha = p.mb.on ? (p.mb.bands[b].on ? 0.22 : 0.08) : 0.1; g.fillStyle = BAND_COLORS[b]; g.fillRect(xs[b], 0, xs[b + 1] - xs[b], h);
      g.globalAlpha = 1;
      // gain change: down from the top = turned down, up from the bottom = turned up
      const gr = live && p.mb.on ? live.gr[b] : 0;
      if (Math.abs(gr) > 0.05) {
        const mh = Math.min(1, Math.abs(gr) / 24) * (h * 0.5 - 6);
        g.fillStyle = BAND_COLORS[b]; g.globalAlpha = 0.85;
        if (gr < 0) g.fillRect(xs[b] + 3, 4, xs[b + 1] - xs[b] - 6, mh); else g.fillRect(xs[b] + 3, h - 4 - mh, xs[b + 1] - xs[b] - 6, mh);
        g.globalAlpha = 1;
      }
      g.fillStyle = ink; g.font = '700 10.5px system-ui, sans-serif'; g.textAlign = 'center'; g.globalAlpha = 0.85;
      g.fillText(BAND_NAMES[b].toUpperCase(), (xs[b] + xs[b + 1]) / 2, h / 2 + 4); g.globalAlpha = 1;
    }
    // frequency ticks
    g.fillStyle = grey; g.font = '10px system-ui, sans-serif'; g.textAlign = 'center';
    for (const [f, l] of [[50, '50'], [100, '100'], [500, '500'], [1000, '1k'], [5000, '5k'], [10000, '10k']]) { const x = f2x(f, w); g.globalAlpha = .5; g.fillRect(x, h - 8, 1, 8); g.globalAlpha = .8; g.fillText(l, x, h - 10); }
    g.globalAlpha = 1;
    // crossover handles
    for (const x of [xs[1], xs[2]]) { g.strokeStyle = ink; g.lineWidth = 2; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); g.fillStyle = ink; g.fillRect(x - 4, h / 2 - 11, 8, 22); g.fillStyle = css('--sheet'); g.fillRect(x - 1, h / 2 - 7, 2, 14); }
  }
  /** The curve of one band, with the same maths as the processor. */
  function bandGain(bd, m, lvl) {
    let want = 0; const K = 10, knee = m.knee;
    const f = (u, r) => { const k = 1 - 1 / r; return knee ? (u <= -K / 2 ? 0 : u >= K / 2 ? u * k : k * (u + K / 2) * (u + K / 2) / (2 * K)) : (u > 0 ? u * k : 0); };
    if (bd.aRat > 1.0001) want -= f(lvl - bd.aThr, bd.aRat);
    if (Math.abs(bd.bRat - 1) > 0.0001) { let up = f(bd.bThr - lvl, bd.bRat); if (up > 0) up *= lvl <= -96 ? 0 : lvl >= -84 ? 1 : (lvl + 96) / 12; want += up; }
    want *= m.amount; return Math.max(-60, Math.min(m.range, want));
  }
  function drawCurve() {
    const cv = curveCv; if (!cv || mbEl.hidden || !cv.clientWidth) return;
    const dpr = cv.width / cv.clientWidth, w = cv.clientWidth, h = cv.clientHeight, g = cv.getContext('2d'), p = P(), bd = p.mb.bands[sel];
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const ink = css('--ink'), grey = css('--graphite'), rule = css('--glass-line') || css('--rule'), lo = -90, hi = 0, pad = 6;
    const X = v => pad + (v - lo) / (hi - lo) * (w - 2 * pad), Y = v => h - pad - (Math.max(lo - 12, Math.min(hi + 12, v)) - lo) / (hi - lo) * (h - 2 * pad);
    g.strokeStyle = rule; g.lineWidth = 1;
    for (const v of [-80, -60, -40, -20]) { g.beginPath(); g.moveTo(X(v), pad); g.lineTo(X(v), h - pad); g.moveTo(pad, Y(v)); g.lineTo(w - pad, Y(v)); g.stroke(); }
    g.setLineDash([3, 3]); g.strokeStyle = grey; g.globalAlpha = .6; g.beginPath(); g.moveTo(X(lo), Y(lo)); g.lineTo(X(hi), Y(hi)); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    // thresholds
    g.strokeStyle = BAND_COLORS[sel]; g.globalAlpha = .55; g.lineWidth = 1.5;
    if (bd.aRat > 1.0001) { g.beginPath(); g.moveTo(X(bd.aThr), pad); g.lineTo(X(bd.aThr), h - pad); g.stroke(); }
    if (Math.abs(bd.bRat - 1) > 0.0001) { g.beginPath(); g.moveTo(X(bd.bThr), pad); g.lineTo(X(bd.bThr), h - pad); g.stroke(); }
    g.globalAlpha = 1;
    // transfer
    const on = p.mb.on && bd.on;
    g.strokeStyle = ink; g.lineWidth = 2.2; g.globalAlpha = on ? 1 : 0.45; g.beginPath();
    for (let i = 0; i <= 120; i++) { const v = lo + (hi - lo) * i / 120, o = v + bd.inDb + (on ? bandGain(bd, p.mb, v + bd.inDb) : 0) + bd.outDb * (p.mb.bands[sel].on ? 1 : 0); const x = X(v), y = Y(o); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
    g.stroke(); g.globalAlpha = 1;
    // live level
    const m = player.fxp && player.fxMode ? player.fxp.meters : null;
    if (m && p.mb.on && m.lvl[sel] > -95) { const v = Math.min(0, m.lvl[sel]), o = v + bd.inDb + m.gr[sel] + bd.outDb; g.fillStyle = css('--signal'); g.beginPath(); g.arc(X(v), Y(o), 4, 0, 7); g.fill(); }
    g.fillStyle = grey; g.font = '10px system-ui, sans-serif'; g.textAlign = 'left'; g.fillText('in →', pad + 2, h - pad - 3); g.save(); g.translate(pad + 9, pad + 22); g.rotate(-Math.PI / 2); g.fillText('out', 0, 0); g.restore();
  }
  // dragging the crossover lines
  { let drag = null;
    const pos = e => { const r = stripCv.getBoundingClientRect(); return e.clientX - r.left; };
    stripCv.addEventListener('pointerdown', e => {
      const x = pos(e), w = stripCv.clientWidth, p = P(), xl = f2x(p.mb.lo, w), xh = f2x(p.mb.hi, w);
      const dl = Math.abs(x - xl), dh = Math.abs(x - xh);
      if (Math.min(dl, dh) > 16) return;
      drag = dl <= dh ? 'lo' : 'hi'; stripCv.setPointerCapture(e.pointerId); e.preventDefault();
    });
    stripCv.addEventListener('pointermove', e => {
      if (!drag) return;
      const f = x2f(pos(e), stripCv.clientWidth), p = P();
      chg('mb', d => { if (drag === 'lo') d.mb.lo = Math.min(f, d.mb.hi / 1.5); else d.mb.hi = Math.max(f, d.mb.lo * 1.5); });
    });
    const up = () => { drag = null; }; stripCv.addEventListener('pointerup', up); stripCv.addEventListener('pointercancel', up);
  }
  // live meters: redraw while the panel is open and the effect is running
  let raf = 0;
  function tick() { raf = 0; if (!box.open || (mbEl.hidden && grEl.hidden)) return; if (!mbEl.hidden) { drawStrip(); drawCurve(); } else grain.draw(); raf = requestAnimationFrame(tick); }
  function startTick() { if (!raf && box.open && (!mbEl.hidden || !grEl.hidden)) raf = requestAnimationFrame(tick); }
  addEventListener('resize', () => { sizeCanvases(); drawStrip(); drawCurve(); grain.resize(); space.draw(); });

  /* ---------------- hooking the player ---------------- */
  function apply(p) {
    if (!player.sound) return;
    if (player.fxReady) { player.fxUse(p); return; }
    if (!fxState.neutral() && !player.fxPrep) prepare();   // no gesture yet: the audio engine may start suspended until Play
  }
  async function prepare() {
    const id = soundId;
    say('Preparing the sound…');
    const ok = await player.fxPrepare();
    if (id !== soundId) return;
    if (ok) { say(''); if (!fxState.neutral()) player.fxUse(P()); }
    else say(player.fxError || 'Live preview isn’t available here. Export still works.', true);
  }
  fxState.subscribe(p => { sync(p); apply(p); });
  box.addEventListener('toggle', () => { if (box.open) { sizeCanvases(); drawStrip(); drawCurve(); space.draw(); startTick(); if (!player.fxPrep) prepare(); } else if (raf) { cancelAnimationFrame(raf); raf = 0; } });
  rack.addEventListener('pointerdown', () => { if (player.sound && !player.fxPrep) prepare(); }, { capture: true });   // inside a tap: iPhone only starts audio from one
  tabBtns[1].addEventListener('click', startTick); tabBtns[2].addEventListener('click', startTick);

  sync(P());
  showTab(0);

  return {
    /** Call whenever an entry is shown (the card opens or fills in). A different entry starts clean. */
    setSound(s) {
      if (!s) return;
      if (s.id === soundId) { box.hidden = !s.audio; return; }
      soundId = s.id;
      grain.reset(); fxState.reset(); say('');
      box.open = false; box.hidden = !s.audio;
    },
    /** True if anything is switched on or changed: the export then renders it. */
    shaped() { return !fxState.neutral(); },
    /** The same entry was loaded again (after a trim): start the live preview again if anything is switched on. */
    refresh() { if (!fxState.neutral() && player.sound) prepare(); },
    close() { box.open = false; },
  };
}
