/* Planet Sound — the Delay and Reverb panels of "Sound shaping".
 * All the DSP is in audio/fx-dsp.js (DelayCore, ReverbCore). Here: controls, presets and a small picture of
 * each: the echoes as they will fall (left above the line, right below), and the reverb's envelope. */
import { createKnob } from './knobs.js';
import { fxState, DELAY_PRESETS, VERB_PRESETS, applyDelayPreset, applyVerbPreset } from './fx.js';

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const sign = v => (v > 0 ? '+' : v < 0 ? '−' : '');
const hzf = v => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`);
const msf = v => (v < 10 ? `${v.toFixed(1)} ms` : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);
const pct = v => (v ? `${Math.round(v)} %` : 'Off');
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const mixf = v => (v <= 0 ? 'Dry' : `${Math.round(v)} %`);

function sizeCv(cv) {
  const dpr = Math.min(2, devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return null;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h); return { g, w, h };
}

/**
 * @param {{dlHost:HTMLElement, rvHost:HTMLElement, chg:(auto:string|null, f:(d:any)=>void)=>void, kn:Function}} o
 */
export function initSpaceUi({ dlHost, rvHost, chg }) {
  const K = { dl: {}, rv: {} };
  const kn = (parent, o) => { const h = el('div'); parent.append(h); return createKnob(h, { small: true, ...o }); };
  let dlPre = { i: '', snap: null }, rvPre = { i: '', snap: null };

  /* ---------------- Delay ---------------- */
  dlHost.innerHTML = `
    <div class="rack-head">
      <button type="button" class="sw" id="dl-on" aria-pressed="false"><i class="lamp"></i>On</button>
      <select id="dl-pre" aria-label="Delay preset"><option value="">Presets…</option>${DELAY_PRESETS.map(([n], i) => `<option value="${i}">${n}</option>`).join('')}</select>
    </div>
    <div class="rack-head">
      <span class="mini-seg" id="dl-mode" role="group" aria-label="Delay mode">
        <button type="button" data-m="stereo" title="Two delay lines, left and right; Offset moves the right one">Stereo</button><button type="button" data-m="pingpong" title="The echoes bounce from left to right">Ping-pong</button><button type="button" data-m="mono" title="One delay line, the same on both sides">Mono</button>
      </span>
      <button type="button" class="sw" id="dl-frz" aria-pressed="false" title="Hold the echoes in the loop forever and take in no new sound. In an export, the echoes left at the end are held."><i class="lamp"></i>Freeze</button>
    </div>
    <div class="fx-pic"><canvas id="dl-cv" aria-label="The echoes: left above the line, right below, fading as they repeat"></canvas></div>
    <div class="grp"><h4>Time · repeats</h4><div class="knobs" id="dl-g1"></div></div>
    <div class="grp"><h4>In the loop</h4><div class="knobs" id="dl-g2"></div></div>
    <div class="grp"><h4>Movement · output</h4><div class="knobs" id="dl-g3"></div></div>`;
  const $d = s => dlHost.querySelector(s);
  const dset = key => v => chg('delay', d => { d.delay[key] = v; });
  K.dl.time = kn($d('#dl-g1'), { label: 'Time', min: 1, max: 2000, scale: 'log', steps: 240, value: 350, def: 350, origin: 1, round: v => (v < 10 ? +v.toFixed(1) : Math.round(v)), format: msf, hint: 'Time between the echoes. Turning it while the sound plays glides, like a tape echo.', onInput: dset('time') });
  K.dl.offset = kn($d('#dl-g1'), { label: 'Offset', min: -50, max: 50, step: 1, value: 0, def: 0, origin: 0, detent: true, format: v => (v ? `R ${sign(v)}${Math.abs(Math.round(v))} %` : 'None'), hint: 'Stereo mode: the right echo comes this much later (or earlier) than the left.', onInput: dset('offset') });
  K.dl.fb = kn($d('#dl-g1'), { label: 'Feedback', min: 0, max: 98, step: 1, value: 35, def: 35, origin: 0, format: v => (v ? `${Math.round(v)} %` : 'One echo'), hint: 'How much of each echo comes round again: more repeats.', onInput: v => chg('delay', d => { d.delay.fb = v / 100; }) });
  K.dl.mix = kn($d('#dl-g1'), { label: 'Mix', min: 0, max: 100, step: 1, value: 30, def: 30, origin: 0, format: mixf, hint: 'Level of the echoes. Up to 50 % the sound itself stays at full level; above, it fades out.', onInput: v => chg('delay', d => { d.delay.mix = v / 100; }) });
  K.dl.lc = kn($d('#dl-g2'), { label: 'Low cut', min: 20, max: 2000, scale: 'log', steps: 120, value: 80, def: 80, origin: 20, round: v => Math.round(v), format: v => (v <= 20.5 ? 'Off' : hzf(v)), hint: 'Each repeat loses more of its lows.', onInput: dset('lc') });
  K.dl.hc = kn($d('#dl-g2'), { label: 'High cut', min: 500, max: 22000, scale: 'log', steps: 120, value: 9000, def: 9000, origin: 22000, round: v => Math.round(v / 10) * 10, format: v => (v >= 21900 ? 'Off' : hzf(v)), hint: 'Each repeat gets darker, like tape or an analog delay.', onInput: dset('hc') });
  K.dl.drive = kn($d('#dl-g2'), { label: 'Drive', min: 0, max: 100, step: 1, value: 0, def: 0, origin: 0, format: pct, hint: 'The repeats saturate as they go round.', onInput: v => chg('delay', d => { d.delay.drive = v / 100; }) });
  K.dl.diffuse = kn($d('#dl-g2'), { label: 'Diffusion', min: 0, max: 100, step: 1, value: 0, def: 0, origin: 0, format: pct, hint: 'Smears each repeat, so the echoes melt into a wash.', onInput: v => chg('delay', d => { d.delay.diffuse = v / 100; }) });
  K.dl.modRate = kn($d('#dl-g3'), { label: 'Mod rate', min: 0.05, max: 10, scale: 'log', steps: 120, value: 0.6, def: 0.6, origin: 0.05, round: v => +v.toPrecision(2), format: v => `${v < 1 ? v.toFixed(2) : v.toFixed(1)} Hz`, hint: 'Speed of the wobble.', onInput: dset('modRate') });
  K.dl.modDepth = kn($d('#dl-g3'), { label: 'Mod depth', min: 0, max: 100, step: 1, value: 0, def: 0, origin: 0, format: pct, hint: 'How much the delay time wobbles: from a slight tape flutter to a chorus.', onInput: v => chg('delay', d => { d.delay.modDepth = v / 100; }) });
  K.dl.width = kn($d('#dl-g3'), { label: 'Width', min: 0, max: 100, step: 1, value: 100, def: 100, origin: 0, format: v => (v <= 0 ? 'Mono' : `${Math.round(v)} %`), hint: 'Stereo width of the echoes.', onInput: v => chg('delay', d => { d.delay.width = v / 100; }) });
  K.dl.duck = kn($d('#dl-g3'), { label: 'Ducking', min: 0, max: 100, step: 1, value: 0, def: 0, origin: 0, format: pct, hint: 'The echoes step back while the sound is loud and come up in the gaps.', onInput: v => chg('delay', d => { d.delay.duck = v / 100; }) });
  $d('#dl-on').addEventListener('click', () => chg(null, d => { d.delay.on = !d.delay.on; }));
  $d('#dl-frz').addEventListener('click', () => chg('delay', d => { d.delay.freeze = !d.delay.freeze; }));
  $d('#dl-mode').addEventListener('click', e => { const b = e.target.closest('button[data-m]'); if (b) chg('delay', d => { d.delay.mode = b.dataset.m; }); });
  $d('#dl-pre').addEventListener('change', e => { const i = e.target.value; if (i === '') return; fxState.update(d => applyDelayPreset(d, DELAY_PRESETS[+i][1])); dlPre = { i, snap: JSON.stringify(fxState.get().delay) }; e.target.value = i; });

  /* ---------------- Reverb ---------------- */
  rvHost.innerHTML = `
    <div class="rack-head">
      <button type="button" class="sw" id="rv-on" aria-pressed="false"><i class="lamp"></i>On</button>
      <select id="rv-pre" aria-label="Reverb preset"><option value="">Presets…</option>${VERB_PRESETS.map(([n], i) => `<option value="${i}">${n}</option>`).join('')}</select>
      <button type="button" class="sw" id="rv-frz" aria-pressed="false" title="Hold the reverb tail forever and take in no new sound. In an export, the tail at the end is held."><i class="lamp"></i>Freeze</button>
    </div>
    <div class="fx-pic"><canvas id="rv-cv" aria-label="The reverb over time: pre-delay, early reflections and the decay of the lows and highs"></canvas></div>
    <div class="grp"><h4>Space</h4><div class="knobs" id="rv-g1"></div></div>
    <div class="grp"><h4>Tone</h4><div class="knobs" id="rv-g2"></div></div>
    <div class="grp"><h4>Character</h4><div class="knobs" id="rv-g3"></div></div>`;
  const $r = s => rvHost.querySelector(s);
  const rset = key => v => chg('verb', d => { d.verb[key] = v; });
  K.rv.size = kn($r('#rv-g1'), { label: 'Size', min: 0, max: 100, step: 1, value: 60, def: 60, origin: 0, format: v => `${Math.round(v)} %`, hint: 'From a small room to a cathedral: how far apart the reflections are.', onInput: v => chg('verb', d => { d.verb.size = v / 100; }) });
  K.rv.decay = kn($r('#rv-g1'), { label: 'Decay', min: 0.1, max: 30, scale: 'log', steps: 200, value: 2.5, def: 2.5, origin: 0.1, round: v => (v < 10 ? +v.toFixed(2) : +v.toFixed(1)), format: v => `${v < 10 ? v.toFixed(v < 1 ? 2 : 1) : Math.round(v)} s`, hint: 'Reverb time (RT60): how long until the tail has fallen by 60 dB.', onInput: rset('decay') });
  K.rv.pre = kn($r('#rv-g1'), { label: 'Pre-delay', min: 1, max: 500, scale: 'log', steps: 160, value: 20, def: 20, origin: 1, round: v => (v < 10 ? +v.toFixed(1) : Math.round(v)), format: v => (v <= 1 ? '0 ms' : msf(v)), hint: 'Time before the reverb starts. A longer gap makes a bigger space and keeps the sound clear.', onInput: v => chg('verb', d => { d.verb.pre = v <= 1 ? 0 : v; }) });
  K.rv.mix = kn($r('#rv-g1'), { label: 'Mix', min: 0, max: 100, step: 1, value: 30, def: 30, origin: 0, format: mixf, hint: 'Level of the reverb. Up to 50 % the sound itself stays at full level; above, it fades out.', onInput: v => chg('verb', d => { d.verb.mix = v / 100; }) });
  K.rv.damp = kn($r('#rv-g2'), { label: 'Damping', min: 500, max: 20000, scale: 'log', steps: 160, value: 7000, def: 7000, origin: 20000, round: v => Math.round(v / 10) * 10, format: v => (v >= 19500 ? 'Off' : hzf(v)), hint: 'The highs die away sooner than the rest, as in a real room. Lower is darker.', onInput: rset('damp') });
  K.rv.bass = kn($r('#rv-g2'), { label: 'Bass ×', min: 0.3, max: 3, scale: 'log', steps: 120, value: 1, def: 1, origin: 1, detent: true, round: v => +v.toFixed(2), format: v => `${v.toFixed(2)}×`, hint: 'How long the lows ring compared with the rest. Above 1: a warmer, boomier room.', onInput: rset('bass') });
  K.rv.lc = kn($r('#rv-g2'), { label: 'Low cut', min: 20, max: 1000, scale: 'log', steps: 120, value: 80, def: 80, origin: 20, round: v => Math.round(v), format: v => (v <= 20.5 ? 'Off' : hzf(v)), hint: 'Takes the lows out of the reverb only.', onInput: rset('lc') });
  K.rv.hc = kn($r('#rv-g2'), { label: 'High cut', min: 1000, max: 22000, scale: 'log', steps: 120, value: 16000, def: 16000, origin: 22000, round: v => Math.round(v / 10) * 10, format: v => (v >= 21900 ? 'Off' : hzf(v)), hint: 'Takes the highs out of the reverb only.', onInput: rset('hc') });
  K.rv.diff = kn($r('#rv-g3'), { label: 'Diffusion', min: 0, max: 100, step: 1, value: 75, def: 75, origin: 0, format: pct, hint: 'Low: separate echoes you can hear. High: a smooth, dense tail.', onInput: v => chg('verb', d => { d.verb.diff = v / 100; }) });
  K.rv.early = kn($r('#rv-g3'), { label: 'Early', min: 0, max: 100, step: 1, value: 40, def: 40, origin: 0, format: pct, hint: 'Level of the first reflections from the walls.', onInput: v => chg('verb', d => { d.verb.early = v / 100; }) });
  K.rv.mod = kn($r('#rv-g3'), { label: 'Mod', min: 0, max: 100, step: 1, value: 30, def: 30, origin: 0, format: pct, hint: 'A slow movement in the tail, so it doesn’t ring. More is lusher, a little chorus.', onInput: v => chg('verb', d => { d.verb.mod = v / 100; }) });
  K.rv.width = kn($r('#rv-g3'), { label: 'Width', min: 0, max: 100, step: 1, value: 100, def: 100, origin: 0, format: v => (v <= 0 ? 'Mono' : `${Math.round(v)} %`), hint: 'Stereo width of the reverb.', onInput: v => chg('verb', d => { d.verb.width = v / 100; }) });
  $r('#rv-on').addEventListener('click', () => chg(null, d => { d.verb.on = !d.verb.on; }));
  $r('#rv-frz').addEventListener('click', () => chg('verb', d => { d.verb.freeze = !d.verb.freeze; }));
  $r('#rv-pre').addEventListener('change', e => { const i = e.target.value; if (i === '') return; fxState.update(d => applyVerbPreset(d, VERB_PRESETS[+i][1])); rvPre = { i, snap: JSON.stringify(fxState.get().verb) }; e.target.value = i; });

  /* ---------------- pictures ---------------- */
  function drawDelay() {
    const cv = $d('#dl-cv'); if (dlHost.hidden) return; const c = sizeCv(cv); if (!c) return;
    const { g, w, h } = c, d = fxState.get().delay, ink = css('--ink'), grey = css('--graphite'), signal = css('--signal');
    const mid = h / 2, tl = d.time, tr = d.mode === 'stereo' ? d.time * (1 + d.offset / 100) : d.time;
    const span = Math.max(1000, Math.min(8000, Math.max(tl, tr) * 7)), X = t => 6 + (t / span) * (w - 12);
    g.fillStyle = grey; g.globalAlpha = 0.35; g.fillRect(0, mid - 0.5, w, 1); g.globalAlpha = 1;
    g.font = '10px system-ui, sans-serif'; g.fillStyle = grey; g.globalAlpha = 0.8;
    g.fillText('L', 4, 12); g.fillText('R', 4, h - 4);
    for (let s = 0; s <= span; s += span > 4000 ? 1000 : 500) { g.fillRect(X(s), mid - 3, 1, 6); }
    g.globalAlpha = 1;
    // the sound itself
    g.fillStyle = ink; g.fillRect(X(0) - 1, 6, 3, mid - 8); g.fillRect(X(0) - 1, mid + 2, 3, mid - 8);
    const fb = d.freeze ? 1 : d.fb, wet = Math.min(1, 2 * d.mix);
    let aL = 1, aR = 1;
    for (let k = 1; k < 64; k++) {
      let tL, tR, left, right;
      if (d.mode === 'pingpong') { const t = tl * k; left = k % 2 === 1 ? Math.pow(fb, k - 1) : 0; right = k % 2 === 0 ? Math.pow(fb, k - 1) : 0; tL = tR = t; }
      else { tL = tl * k; tR = tr * k; left = aL; right = d.mode === 'mono' ? aL : aR; aL *= fb; aR *= fb; }
      const tone = Math.pow(d.hc / 22000, 0.25 * (k - 1)) * Math.pow(20 / Math.max(20, d.lc), 0.12 * (k - 1));
      if (tL > span && tR > span) break;
      g.fillStyle = k === 1 ? signal : ink;
      if (left > 0.004 && tL <= span) { const a = Math.min(1, left * tone); g.globalAlpha = 0.35 + 0.65 * wet; g.fillRect(X(tL) - 1, mid - 2 - a * (mid - 8), 3, a * (mid - 8)); }
      if (right > 0.004 && tR <= span) { const a = Math.min(1, right * tone); g.globalAlpha = 0.35 + 0.65 * wet; g.fillRect(X(tR) - 1, mid + 2, 3, a * (mid - 8)); }
      if (fb < 0.001 && k >= 1) break;
    }
    g.globalAlpha = 1;
    g.fillStyle = grey; g.textAlign = 'right'; g.fillText(span >= 1000 ? `${span / 1000} s` : `${span} ms`, w - 6, 12); g.textAlign = 'left';
  }
  function drawVerb() {
    const cv = $r('#rv-cv'); if (rvHost.hidden) return; const c = sizeCv(cv); if (!c) return;
    const { g, w, h } = c, v = fxState.get().verb, ink = css('--ink'), grey = css('--graphite'), signal = css('--signal');
    const span = Math.min(32, Math.max(1, (v.decay * Math.max(1, v.bass) + v.pre / 1000) * 1.15)), X = t => 6 + (t / span) * (w - 12);
    const Y = dbv => 6 + (-dbv / 60) * (h - 14);       // 0 dB at the top, −60 dB at the bottom
    g.fillStyle = grey; g.globalAlpha = 0.25; for (const dbv of [-20, -40, -60]) g.fillRect(0, Y(dbv), w, 1); g.globalAlpha = 1;
    const t0 = v.pre / 1000;
    // early reflections
    if (v.early > 0.01) { g.fillStyle = signal; const es = 0.4 + 1.2 * v.size; [7.1, 11.3, 17.9, 23.3, 31.7, 41.9, 53.1, 67.7].forEach((ms, k) => { const t = t0 + ms * es / 1000, a = v.early * [0.82, 0.72, 0.63, 0.55, 0.47, 0.4, 0.33, 0.27][k], y = Y(-6 + 20 * Math.log10(Math.max(0.05, a))); g.globalAlpha = 0.85; g.fillRect(X(t), y, 2, Math.max(2, (h - 8) * 0.55 - y)); }); g.globalAlpha = 1; }
    // decay of the lows (Bass ×) and of the highs (Damping): straight lines in dB
    const line = (rt, col, dash) => { g.strokeStyle = col; g.lineWidth = 2; g.setLineDash(dash); g.beginPath(); g.moveTo(X(t0), Y(-6)); const tEnd = v.freeze ? span : t0 + rt * 54 / 60; g.lineTo(X(Math.min(span, tEnd)), Y(v.freeze ? -6 : -6 - Math.min(54, 54 * (Math.min(span, tEnd) - t0) / (rt * 54 / 60)))); g.stroke(); g.setLineDash([]); };
    const highRt = v.damp >= 19500 ? v.decay : v.decay * Math.max(0.15, Math.pow(v.damp / 20000, 0.55));
    line(v.decay * v.bass, ink, []);
    line(highRt, grey, [4, 4]);
    g.fillStyle = grey; g.font = '10px system-ui, sans-serif';
    g.textAlign = 'right'; g.fillText(v.freeze ? 'held' : `lows ${(v.decay * v.bass).toFixed(1)} s · highs ${highRt.toFixed(1)} s`, w - 6, 13);
    g.fillText(`${span.toFixed(span < 10 ? 1 : 0)} s`, w - 6, h - 5); g.textAlign = 'left';
    if (t0 > 0) { g.fillStyle = grey; g.globalAlpha = 0.12; g.fillRect(X(0), 0, X(t0) - X(0), h); g.globalAlpha = 1; }
  }

  function sync(p) {
    const d = p.delay, v = p.verb;
    K.dl.time.set(d.time, false); K.dl.offset.set(d.offset, false); K.dl.fb.set(d.fb * 100, false); K.dl.mix.set(d.mix * 100, false);
    K.dl.lc.set(d.lc, false); K.dl.hc.set(d.hc, false); K.dl.drive.set(d.drive * 100, false); K.dl.diffuse.set(d.diffuse * 100, false);
    K.dl.modRate.set(d.modRate, false); K.dl.modDepth.set(d.modDepth * 100, false); K.dl.width.set(d.width * 100, false); K.dl.duck.set(d.duck * 100, false);
    K.dl.offset.disable(d.mode !== 'stereo', 'Stereo mode only');
    K.dl.fb.disable(d.freeze, 'Frozen: the loop is held');
    $d('#dl-on').setAttribute('aria-pressed', String(d.on)); $d('#dl-on .lamp').classList.toggle('on', d.on);
    $d('#dl-frz').setAttribute('aria-pressed', String(d.freeze)); $d('#dl-frz .lamp').classList.toggle('on', d.freeze);
    dlHost.querySelectorAll('#dl-mode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === d.mode)));
    $d('#dl-pre').value = dlPre.snap && JSON.stringify(d) === dlPre.snap ? dlPre.i : '';
    K.rv.size.set(v.size * 100, false); K.rv.decay.set(v.decay, false); K.rv.pre.set(Math.max(1, v.pre), false); K.rv.mix.set(v.mix * 100, false);
    K.rv.damp.set(v.damp, false); K.rv.bass.set(v.bass, false); K.rv.lc.set(v.lc, false); K.rv.hc.set(v.hc, false);
    K.rv.diff.set(v.diff * 100, false); K.rv.early.set(v.early * 100, false); K.rv.mod.set(v.mod * 100, false); K.rv.width.set(v.width * 100, false);
    K.rv.decay.disable(v.freeze, 'Frozen: the tail is held');
    $r('#rv-on').setAttribute('aria-pressed', String(v.on)); $r('#rv-on .lamp').classList.toggle('on', v.on);
    $r('#rv-frz').setAttribute('aria-pressed', String(v.freeze)); $r('#rv-frz .lamp').classList.toggle('on', v.freeze);
    $r('#rv-pre').value = rvPre.snap && JSON.stringify(v) === rvPre.snap ? rvPre.i : '';
    dlHost.classList.toggle('off', !d.on); rvHost.classList.toggle('off', !v.on);
    drawDelay(); drawVerb();
  }
  return { sync, draw() { drawDelay(); drawVerb(); } };
}
