/* Planet Sound — the Granulator panel (the third tab of "Sound shaping").
 *
 * It grains the sound after Tape and Multiband, so you hear the processed sound granulated, with Dry / Wet.
 * What you see: the buffer the grains are taken from (Live: the last seconds of the sound; Region: a stretch of
 * the recording), the position and spray, and every grain that is sounding right now.
 *   drag on the buffer: set the Position · drag the overview: move the Region, drag its ends to resize it.
 * All the DSP is in audio/fx-dsp.js (GranulatorCore). Here: controls, drawing, presets. */
import { createKnob } from './knobs.js';
import { fxState, GRAIN_PRESETS, applyGrainPreset } from './fx.js';

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const sign = v => (v > 0 ? '+' : v < 0 ? '−' : '');
const dbf = v => `${sign(v)}${Math.abs(v).toFixed(1)} dB`;
const hzf = v => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`);
const msf = v => (v < 10 ? `${v.toFixed(1)} ms` : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);
const pct = v => (v ? `${Math.round(v)} %` : 'Off');
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const secf = v => `${v.toFixed(v < 10 ? 2 : 1)} s`;
const WIN_NAMES = [['hann', 'Hann (soft)'], ['gauss', 'Gauss'], ['tri', 'Triangle'], ['trap', 'Trapezoid'], ['expo', 'Decay (hit)'], ['rexpo', 'Swell']];
const PAN_NAMES = [['random', 'Random'], ['alt', 'Alternate L/R'], ['pos', 'By position'], ['pitch', 'By pitch']];
const LFO_NAMES = [['sine', 'Sine'], ['tri', 'Triangle'], ['saw', 'Ramp'], ['square', 'Square'], ['random', 'Random steps'], ['drift', 'Drift']];
const opts = list => list.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
const SCALE_NAMES = [['free', 'Free (any pitch)'], ['chromatic', 'Chromatic'], ['major', 'Major'], ['minor', 'Minor'], ['pentatonic', 'Pentatonic'], ['minorpent', 'Minor pentatonic'], ['whole', 'Whole tone'], ['fifths', 'Fifths'], ['octaves', 'Octaves']];

/**
 * @param {{host:HTMLElement, player:any, chg:(auto:string|null, f:(d:any)=>void)=>void, say:(t:string, err?:boolean)=>void}} o
 */
export function initGrainUi({ host, player, chg, say }) {
  const P = () => fxState.get().grain;
  host.innerHTML = `
    <div class="rack-head">
      <button type="button" class="sw" id="gr-on" aria-pressed="false"><i class="lamp"></i>On</button>
      <select id="gr-pre" aria-label="Granulator preset"><option value="">Presets…</option>${GRAIN_PRESETS.map(([n], i) => `<option value="${i}">${n}</option>`).join('')}</select>
      <span class="mini-seg" id="gr-mode" role="group" aria-label="Grain timing"><button type="button" data-m="sync" title="Grains at an even rate">Classic</button><button type="button" data-m="cloud" title="Grains at random times, on average at the Rate">Cloud</button></span>
    </div>
    <div class="rack-head gr-src">
      <span class="mini-seg" id="gr-src" role="group" aria-label="Where the grains come from">
        <button type="button" data-s="live" title="The last seconds of the sound, after Tape and Multiband">Live</button><button type="button" data-s="region" title="A stretch of the recording, rendered through Tape and Multiband">Region</button>
      </span>
      <span class="mini-seg" id="gr-buf" role="group" aria-label="Live buffer length"><button type="button" data-b="2">2 s</button><button type="button" data-b="5">5 s</button><button type="button" data-b="10">10 s</button><button type="button" data-b="30">30 s</button></span>
      <button type="button" class="sw" id="gr-freeze" aria-pressed="false" title="Stop the live buffer taking in new sound and keep what it has"><i class="lamp"></i>Freeze</button>
    </div>
    <div class="gr-view"><canvas id="gr-buf-cv" aria-label="The buffer the grains are taken from. Drag to set the position."></canvas><span class="gr-cap l" id="gr-capl"></span><span class="gr-cap r" id="gr-capr"></span></div>
    <div class="gr-over" id="gr-over-box" hidden><canvas id="gr-over" aria-label="The whole recording. Drag the highlighted stretch to move it, drag its ends to resize it."></canvas></div>
    <div class="grp"><h4>Grains</h4><div class="knobs" id="gr-g1"></div></div>
    <div class="grp"><h4>Position</h4><div class="knobs" id="gr-g2"></div></div>
    <div class="grp"><h4>Pitch <label class="gr-scale">Scale <select id="gr-scale" aria-label="Quantise the random pitch to a scale">${SCALE_NAMES.map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select></label></h4><div class="knobs three" id="gr-g3"></div></div>
    <div class="grp"><h4>Window <label class="gr-scale">Type <select id="gr-win" aria-label="Grain window">${opts(WIN_NAMES)}</select></label></h4><div class="knobs" id="gr-g4"></div></div>
    <div class="grp"><h4>Spread <label class="gr-scale">Mode <select id="gr-panm" aria-label="How the grains are placed left to right">${opts(PAN_NAMES)}</select></label></h4><div class="knobs" id="gr-g6"></div></div>
    <div class="grp"><h4><span class="gr-lfo-h">Modulation <i class="gr-lfo-dot" id="gr-lfo-dot" aria-hidden="true"></i></span> <label class="gr-scale">LFO <select id="gr-lfosh" aria-label="LFO shape">${opts(LFO_NAMES)}</select></label></h4><div class="knobs" id="gr-g7"></div></div>
    <div class="grp"><h4>Texture</h4><div class="knobs three" id="gr-g8"></div></div>
    <div class="grp"><h4>Output</h4><div class="knobs" id="gr-g5"></div></div>
    <div class="gr-foot"><button type="button" class="sw" id="gr-free" aria-pressed="false" title="Keep the granulator sounding when the recording is stopped, so you can shape a texture without the sound playing"><i class="lamp"></i>Free-running</button><span class="gr-read" id="gr-read"></span></div>`;
  const $ = s => host.querySelector(s);
  const K = {};
  const kn = (id, o) => { const h = el('div'); $(id).append(h); return createKnob(h, { small: true, ...o }); };
  const pctKnob = (id, key, label, hint, def = 0) => kn(id, {
    label, min: 0, max: 100, step: 1, value: def * 100, def: def * 100, origin: 0, format: pct, speech: v => (v ? `${v} percent` : 'off'), hint,
    onInput: v => chg('grain', d => { d.grain[key] = v / 100; }),
  });
  // Grains
  K.rate = kn('#gr-g1', { label: 'Rate', min: 0.5, max: 200, scale: 'log', steps: 160, value: 20, def: 20, origin: 0.5, round: v => +v.toPrecision(3), format: v => `${v < 10 ? v.toFixed(1) : Math.round(v)} Hz`, speech: v => `${v.toFixed(1)} grains per second`, hint: 'How many grains start every second.', onInput: v => chg('grain', d => { d.grain.rate = v; }) });
  K.size = kn('#gr-g1', { label: 'Size', min: 5, max: 2000, scale: 'log', steps: 160, value: 120, def: 120, origin: 5, round: v => (v < 100 ? +v.toFixed(1) : Math.round(v)), format: msf, hint: 'Length of each grain.', onInput: v => chg('grain', d => { d.grain.size = v; }) });
  let presetIdx = '', presetSnap = null;   // the chosen preset stays shown for as long as the settings still match it
  K.rndSize = pctKnob('#gr-g1', 'rndSize', 'Size var', 'Random grain length: up to an octave longer or shorter.');
  K.jitter = pctKnob('#gr-g1', 'jitter', 'Time var', 'Classic only: how irregular the timing is.');
  K.prob = kn('#gr-g1', { label: 'Chance', min: 0, max: 100, step: 1, value: 100, def: 100, origin: 100, format: v => (v >= 99.5 ? 'Always' : `${Math.round(v)} %`), hint: 'The chance that each grain sounds. Lower leaves gaps: sparse, rhythmic patterns.', onInput: v => chg('grain', d => { d.grain.prob = v / 100; }) });
  // Position
  K.pos = kn('#gr-g2', { label: 'Position', min: 0, max: 100, step: 0.5, value: 50, def: 50, origin: 0, format: v => `${Math.round(v)} %`, hint: 'Where in the buffer the grains are taken from. Live: 0 is the oldest, 100 the newest.', onInput: v => chg('grain', d => { d.grain.pos = v / 100; }) });
  K.spray = pctKnob('#gr-g2', 'spray', 'Spray', 'Random position: the grains are scattered around the Position.', 0.2);
  K.scan = kn('#gr-g2', { label: 'Scan', min: -4, max: 4, step: 0.05, value: 0, def: 0, origin: 0, detent: true, format: v => (v ? `${sign(v)}${Math.abs(v).toFixed(2)}×` : 'Off'), speech: v => `${v.toFixed(2)} times`, hint: 'Moves the Position through the buffer by itself. 1× is the speed of the sound; negative runs backwards.', onInput: v => chg('grain', d => { d.grain.scan = v; }) });
  K.voices = kn('#gr-g2', { label: 'Voices', min: 1, max: 64, step: 1, value: 32, def: 32, origin: 1, format: v => `${Math.round(v)}`, hint: 'The most grains that may sound at once.', onInput: v => chg('grain', d => { d.grain.voices = v; }) });
  // Pitch
  K.pitch = kn('#gr-g3', { label: 'Pitch', min: -36, max: 36, step: 0.1, value: 0, def: 0, origin: 0, detent: true, format: v => (v ? `${sign(v)}${Math.abs(v).toFixed(1)} st` : '0 st'), speech: v => `${v.toFixed(1)} semitones`, hint: 'Pitch of every grain, in semitones. Shift: fine steps.', onInput: v => chg('grain', d => { d.grain.pitch = v; }) });
  K.pSpray = kn('#gr-g3', { label: 'Pitch spray', min: 0, max: 24, step: 0.1, value: 0, def: 0, origin: 0, format: v => (v ? `±${v.toFixed(1)} st` : 'Off'), hint: 'Random pitch for each grain, up to this many semitones either way. Use Scale to make it musical.', onInput: v => chg('grain', d => { d.grain.pSpray = v; }) });
  K.rev = pctKnob('#gr-g3', 'rev', 'Reverse', 'How many grains are played backwards.');
  K.glide = kn('#gr-g3', { label: 'Glide', min: -24, max: 24, step: 0.1, value: 0, def: 0, origin: 0, detent: true, format: v => (v ? `${sign(v)}${Math.abs(v).toFixed(1)} st` : 'Off'), hint: 'Each grain bends in pitch while it plays: up (chirps) or down (falling).', onInput: v => chg('grain', d => { d.grain.glide = v; }) });
  K.gSpray = kn('#gr-g3', { label: 'Glide spray', min: 0, max: 24, step: 0.1, value: 0, def: 0, origin: 0, format: v => (v ? `±${v.toFixed(1)} st` : 'Off'), hint: 'A random bend for each grain, up to this much either way.', onInput: v => chg('grain', d => { d.grain.gSpray = v; }) });
  // Shape / spread
  K.smooth = kn('#gr-g4', { label: 'Shape', min: 0, max: 100, step: 1, value: 100, def: 100, origin: 0, format: v => (v >= 99.5 ? 'Soft' : v <= 0.5 ? 'Hard' : `${Math.round(v)} %`), hint: 'The edges of each grain: soft is smooth, hard is a click.', onInput: v => chg('grain', d => { d.grain.smooth = v / 100; }) });
  K.tilt = kn('#gr-g4', { label: 'Tilt', min: -100, max: 100, step: 1, value: 0, def: 0, origin: 0, detent: true, format: v => (v ? `${sign(v)}${Math.abs(Math.round(v))} %` : 'Centre'), hint: 'Where the grain peaks. Left: a hit and a tail. Right: a swell and a cut.', onInput: v => chg('grain', d => { d.grain.tilt = v / 100; }) });
  K.pan = pctKnob('#gr-g6', 'pan', 'Pan', 'How far left and right the grains go. Pan sets how: at random, alternating, by where in the buffer they come from, or by their pitch (higher to the right).', 0.4);
  K.amp = pctKnob('#gr-g6', 'amp', 'Level', 'Each grain at a random level.');
  // modulation
  const depth = (key, label, hint) => kn('#gr-g7', { label, min: -100, max: 100, step: 1, value: 0, def: 0, origin: 0, detent: true, format: v => (v ? `${sign(v)}${Math.abs(Math.round(v))} %` : 'Off'), hint, onInput: v => chg('grain', d => { d.grain[key] = v / 100; }) });
  K.lfoRate = kn('#gr-g7', { label: 'Rate', min: 0.02, max: 20, scale: 'log', steps: 160, value: 0.5, def: 0.5, origin: 0.02, round: v => +v.toPrecision(2), format: v => (v < 1 ? `${v.toFixed(2)} Hz` : `${v.toFixed(1)} Hz`), hint: 'Speed of the LFO. Below 0.1 Hz it takes longer than ten seconds to go round.', onInput: v => chg('grain', d => { d.grain.lfoRate = v; }) });
  K.lfoPos = depth('lfoPos', '→ Position', 'The LFO moves where the grains are taken from.');
  K.lfoPitch = kn('#gr-g7', { label: '→ Pitch', min: -24, max: 24, step: 0.1, value: 0, def: 0, origin: 0, detent: true, format: v => (v ? `${sign(v)}${Math.abs(v).toFixed(1)} st` : 'Off'), hint: 'The LFO moves the pitch of new grains, up to this many semitones.', onInput: v => chg('grain', d => { d.grain.lfoPitch = v; }) });
  K.lfoSize = depth('lfoSize', '→ Size', 'The LFO makes the grains longer and shorter, up to two octaves.');
  K.lfoDens = depth('lfoDens', '→ Density', 'The LFO makes the grains come faster and slower.');
  K.lfoCut = depth('lfoCut', '→ Filter', 'The LFO sweeps the low-pass of the grains (from the Low-pass setting, or from 18 kHz if it is off).');
  // texture
  K.fb = kn('#gr-g8', { label: 'Feedback', min: 0, max: 95, step: 1, value: 0, def: 0, origin: 0, format: pct, hint: 'Live source: the grains are fed back into the buffer, so they are grained again and again. Evolving, self-similar textures.', onInput: v => chg('grain', d => { d.grain.fb = v / 100; }) });
  K.bits = kn('#gr-g8', { label: 'Bits', min: 4, max: 24, step: 1, value: 24, def: 24, origin: 24, format: v => (v >= 24 ? 'Off' : `${Math.round(v)} bit`), hint: 'Fewer bits: a grainier, noisier, digital sound.', onInput: v => chg('grain', d => { d.grain.bits = v; }) });
  K.down = kn('#gr-g8', { label: 'Rate ÷', min: 1, max: 32, scale: 'log', steps: 60, value: 1, def: 1, origin: 1, round: v => Math.round(v), format: v => (v <= 1 ? 'Off' : `÷ ${Math.round(v)}`), hint: 'Sample-rate reduction: aliasing, metallic, lo-fi.', onInput: v => chg('grain', d => { d.grain.down = v; }) });
  // Output
  K.mix = kn('#gr-g5', { label: 'Dry / Wet', min: 0, max: 100, step: 1, value: 50, def: 50, origin: 0, format: v => (v <= 0 ? 'Dry' : v >= 100 ? 'Wet' : `${Math.round(v)} % wet`), speech: v => `${Math.round(v)} percent wet`, hint: 'Dry is the sound after Tape and Multiband. Wet is the grains.', onInput: v => chg('grain', d => { d.grain.mix = v / 100; }) });
  K.level = kn('#gr-g5', { label: 'Level', min: -24, max: 12, step: 0.5, value: 0, def: 0, origin: 0, format: dbf, hint: 'Level of the grains.', onInput: v => chg('grain', d => { d.grain.level = v; }) });
  K.hp = kn('#gr-g5', { label: 'High-pass', min: 20, max: 2000, scale: 'log', steps: 120, value: 20, def: 20, origin: 20, round: v => Math.round(v), format: v => (v <= 20.5 ? 'Off' : hzf(v)), hint: 'Cuts the lows of the grains.', onInput: v => chg('grain', d => { d.grain.hp = v; }) });
  K.lp = kn('#gr-g5', { label: 'Low-pass', min: 200, max: 22000, scale: 'log', steps: 120, value: 22000, def: 22000, origin: 22000, round: v => Math.round(v / 10) * 10, format: v => (v >= 21900 ? 'Off' : hzf(v)), hint: 'Cuts the highs of the grains.', onInput: v => chg('grain', d => { d.grain.lp = v; }) });

  $('#gr-on').addEventListener('click', () => chg(null, d => { d.grain.on = !d.grain.on; }));
  $('#gr-pre').addEventListener('change', e => { const i = e.target.value; if (i === '') return; fxState.update(d => applyGrainPreset(d, GRAIN_PRESETS[+i][1])); presetIdx = i; presetSnap = JSON.stringify(fxState.get().grain); $('#gr-pre').value = i; });
  $('#gr-mode').addEventListener('click', e => { const b = e.target.closest('button[data-m]'); if (b) chg('grain', d => { d.grain.mode = b.dataset.m; }); });
  $('#gr-src').addEventListener('click', e => { const b = e.target.closest('button[data-s]'); if (b) chg('grain', d => { d.grain.src = b.dataset.s; }); });
  $('#gr-buf').addEventListener('click', e => { const b = e.target.closest('button[data-b]'); if (b) chg('grain', d => { d.grain.bufSec = +b.dataset.b; }); });
  $('#gr-freeze').addEventListener('click', () => chg('grain', d => { d.grain.freeze = !d.grain.freeze; }));
  $('#gr-free').addEventListener('click', () => chg('grain', d => { d.grain.free = !d.grain.free; }));
  $('#gr-scale').addEventListener('change', e => chg('grain', d => { d.grain.scale = e.target.value; }));
  $('#gr-win').addEventListener('change', e => chg('grain', d => { d.grain.win = e.target.value; }));
  $('#gr-panm').addEventListener('change', e => chg('grain', d => { d.grain.panMode = e.target.value; }));
  $('#gr-lfosh').addEventListener('change', e => chg('grain', d => { d.grain.lfoShape = e.target.value; }));

  /* ---------------- drawing ---------------- */
  const bufCv = $('#gr-buf-cv'), overCv = $('#gr-over'), overBox = $('#gr-over-box');
  let region = null, regionPeaks = null, overPeaks = null, overFor = null, bake = { state: '' };
  const COLS = 700;
  function peaksOf(chs, cols) {
    const n = chs[0].length, out = new Float32Array(cols * 2), step = n / cols;
    for (let x = 0; x < cols; x++) {
      const a = Math.floor(x * step), b = Math.max(a + 1, Math.floor((x + 1) * step)); let mn = 0, mx = 0;
      for (const ch of chs) for (let i = a; i < b && i < n; i += Math.max(1, ((b - a) / 24) | 0)) { const v = ch[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      out[x * 2] = mn; out[x * 2 + 1] = mx;
    }
    let pk = 1e-4; for (let i = 0; i < out.length; i++) pk = Math.max(pk, Math.abs(out[i]));
    for (let i = 0; i < out.length; i++) out[i] /= pk;
    return out;
  }
  function size(cv) {
    const dpr = Math.min(2, devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return false;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    return true;
  }
  function wave(g, peaks, w, h, x0, x1, color, alpha) {
    if (!peaks) return;
    g.fillStyle = color; g.globalAlpha = alpha;
    const cols = peaks.length / 2, mid = h / 2;
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x1)); x++) {
      const c = Math.min(cols - 1, Math.floor(x / w * cols)), mn = peaks[c * 2], mx = peaks[c * 2 + 1];
      g.fillRect(x, mid - mx * (mid - 4), 1, Math.max(1, (mx - mn) * (mid - 4)));
    }
    g.globalAlpha = 1;
  }
  function draw() {
    const p = P(), live = player.fxp && player.fxMode && player.fxp.meters && player.fxp.meters.grain ? player.fxp.meters.grain : null;
    if (size(bufCv)) {
      const dpr = bufCv.width / bufCv.clientWidth, w = bufCv.clientWidth, h = bufCv.clientHeight, g = bufCv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
      const ink = css('--ink'), grey = css('--graphite'), signal = css('--signal'), rule = css('--glass-line') || css('--rule');
      const isRegion = p.src === 'region', fill = isRegion ? 1 : (live ? live.fill : 0);
      g.fillStyle = grey; g.globalAlpha = 0.08; g.fillRect(0, 0, w, h); g.globalAlpha = 1;
      if (isRegion) wave(g, regionPeaks, w, h, 0, w, ink, 0.55);
      else {
        // live: the newest sound is at the right; the part not yet filled is empty
        const x0 = (1 - fill) * w;
        g.fillStyle = grey; g.globalAlpha = 0.16; g.fillRect(x0, 0, w - x0, h); g.globalAlpha = 1;
        g.strokeStyle = grey; g.globalAlpha = 0.35; g.lineWidth = 1;
        for (let x = w - 1; x > x0; x -= 22) { g.beginPath(); g.moveTo(x + .5, h * .35); g.lineTo(x + .5, h * .65); g.stroke(); }
        g.globalAlpha = 1;
      }
      // position + spray (the Scan moves the position by itself)
      let u = p.pos + (live ? live.scan : 0); u -= Math.floor(u);
      const a = Math.max(0, u - p.spray / 2) * w, b = Math.min(1, u + p.spray / 2) * w;
      g.fillStyle = signal; g.globalAlpha = 0.14; g.fillRect(a, 0, Math.max(2, b - a), h); g.globalAlpha = 1;
      g.fillStyle = signal; g.fillRect(u * w - 1, 0, 2, h);
      // the grains sounding now
      if (live && live.grains && p.on) {
        g.fillStyle = signal;
        for (const [x, win] of live.grains) { g.globalAlpha = 0.25 + 0.6 * win; g.fillRect(x * w - 1, h - 4 - win * (h - 12), 3, win * (h - 12) + 4); }
        g.globalAlpha = 1;
      }
      g.strokeStyle = rule; g.lineWidth = 1; g.strokeRect(0.5, 0.5, w - 1, h - 1);
    }
    if (!overBox.hidden && size(overCv)) {
      const dpr = overCv.width / overCv.clientWidth, w = overCv.clientWidth, h = overCv.clientHeight, g = overCv.getContext('2d'), ink = css('--ink'), signal = css('--signal');
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
      const dur = player.fxp && player.fxp.buffer ? player.fxp.buffer.duration : 0;
      wave(g, overPeaks, w, h, 0, w, ink, 0.45);
      if (dur > 0) {
        const x0 = p.rStart / dur * w, x1 = Math.min(dur, p.rStart + p.rLen) / dur * w;
        g.fillStyle = signal; g.globalAlpha = 0.18; g.fillRect(x0, 0, Math.max(3, x1 - x0), h); g.globalAlpha = 1;
        g.fillStyle = signal; g.fillRect(x0 - 1, 0, 3, h); g.fillRect(x1 - 2, 0, 3, h);
      }
    }
    const dot = $('#gr-lfo-dot'), lfoUsed = ['lfoPos', 'lfoPitch', 'lfoSize', 'lfoDens', 'lfoCut'].some(k => Math.abs(p[k]) > 0.004);
    if (dot) { dot.classList.toggle('on', lfoUsed && p.on); dot.style.setProperty('--lfo', live && lfoUsed ? String(live.lfo || 0) : '0'); }
    $('#gr-capl').textContent = p.src === 'region' ? secf(p.rStart) : '';
    $('#gr-capr').textContent = p.src === 'region' ? secf(p.rStart + p.rLen) : (p.freeze ? 'frozen' : '');
  }
  /** Overview peaks of the whole recording (once per sound). */
  function updateOverview() {
    const b = player.fxp && player.fxp.buffer; if (!b) { overPeaks = null; overFor = null; return; }
    if (overFor === b) return; overFor = b;
    const chs = []; for (let c = 0; c < Math.min(2, b.numberOfChannels); c++) chs.push(b.getChannelData(c));
    overPeaks = peaksOf(chs, COLS);
  }

  /* dragging: the Position on the buffer; the stretch on the overview */
  { let drag = false;
    const set = e => { const r = bufCv.getBoundingClientRect(), u = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); chg('grain', d => { d.grain.pos = Math.round(u * 1000) / 1000; }); };
    bufCv.addEventListener('pointerdown', e => { drag = true; bufCv.setPointerCapture(e.pointerId); set(e); e.preventDefault(); });
    bufCv.addEventListener('pointermove', e => { if (drag) set(e); });
    const up = () => { drag = false; }; bufCv.addEventListener('pointerup', up); bufCv.addEventListener('pointercancel', up);
  }
  { let drag = null;
    const dur = () => (player.fxp && player.fxp.buffer ? player.fxp.buffer.duration : 0);
    overCv.addEventListener('pointerdown', e => {
      const d = dur(); if (!d) return;
      const r = overCv.getBoundingClientRect(), x = e.clientX - r.left, w = r.width, p = P();
      const x0 = p.rStart / d * w, x1 = Math.min(d, p.rStart + p.rLen) / d * w;
      if (Math.abs(x - x0) < 12) drag = { m: 'a' }; else if (Math.abs(x - x1) < 12) drag = { m: 'b' };
      else if (x > x0 && x < x1) drag = { m: 'move', off: x / w * d - p.rStart };
      else { const t = x / w * d; drag = { m: 'move', off: p.rLen / 2 }; chg('grain', g => { g.grain.rStart = Math.max(0, Math.min(d - g.grain.rLen, t - p.rLen / 2)); }); }
      overCv.setPointerCapture(e.pointerId); e.preventDefault();
    });
    overCv.addEventListener('pointermove', e => {
      if (!drag) return;
      const d = dur(), r = overCv.getBoundingClientRect(), t = Math.max(0, Math.min(d, (e.clientX - r.left) / r.width * d));
      chg('grain', g => {
        const q = g.grain, end = q.rStart + q.rLen;
        if (drag.m === 'move') q.rStart = Math.max(0, Math.min(Math.max(0, d - q.rLen), t - drag.off));
        else if (drag.m === 'a') { const s = Math.min(t, end - 0.5); q.rStart = Math.max(s, end - 60); q.rLen = end - q.rStart; }
        else { q.rLen = Math.max(0.5, Math.min(60, t - q.rStart)); }
      });
    });
    const up = () => { drag = null; }; overCv.addEventListener('pointerup', up); overCv.addEventListener('pointercancel', up);
  }

  /* ---------------- state → controls ---------------- */
  let lastOn = false, hintT = 0;
  function sync(p) {
    const g = p.grain;
    if (g.on && !lastOn && !(player.fxp && player.fxp.playing) && !g.free) { say('Press play: the grains run along with the sound. “Free-running” lets them play without it.'); clearTimeout(hintT); hintT = setTimeout(() => say(''), 6000); }
    lastOn = g.on;
    K.rate.set(g.rate, false); K.size.set(g.size, false); K.rndSize.set(g.rndSize * 100, false); K.jitter.set(g.jitter * 100, false);
    K.pos.set(g.pos * 100, false); K.spray.set(g.spray * 100, false); K.scan.set(g.scan, false); K.voices.set(g.voices, false);
    K.pitch.set(g.pitch, false); K.pSpray.set(g.pSpray, false); K.rev.set(g.rev * 100, false);
    K.smooth.set(g.smooth * 100, false); K.tilt.set(g.tilt * 100, false); K.pan.set(g.pan * 100, false); K.amp.set(g.amp * 100, false);
    K.mix.set(g.mix * 100, false); K.level.set(g.level, false); K.hp.set(g.hp, false); K.lp.set(g.lp, false);
    K.prob.set(g.prob * 100, false); K.glide.set(g.glide, false); K.gSpray.set(g.gSpray, false);
    K.lfoRate.set(g.lfoRate, false); K.lfoPos.set(g.lfoPos * 100, false); K.lfoPitch.set(g.lfoPitch, false); K.lfoSize.set(g.lfoSize * 100, false); K.lfoDens.set(g.lfoDens * 100, false); K.lfoCut.set(g.lfoCut * 100, false);
    K.fb.set(g.fb * 100, false); K.bits.set(g.bits, false); K.down.set(g.down, false);
    K.tilt.disable(g.win === 'expo' || g.win === 'rexpo', 'Not for this window type');
    $('#gr-win').value = g.win; $('#gr-panm').value = g.panMode; $('#gr-lfosh').value = g.lfoShape;
    K.fb.disable(g.src !== 'live' || g.freeze, g.src !== 'live' ? 'Live source only' : 'Not while frozen');
    $('#gr-on').setAttribute('aria-pressed', String(g.on)); $('#gr-on .lamp').classList.toggle('on', g.on);
    host.querySelectorAll('#gr-mode button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === g.mode)));
    host.querySelectorAll('#gr-src button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.s === g.src)));
    host.querySelectorAll('#gr-buf button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.b === g.bufSec)));
    $('#gr-buf').hidden = g.src !== 'live'; $('#gr-freeze').hidden = g.src !== 'live';
    $('#gr-freeze').setAttribute('aria-pressed', String(g.freeze)); $('#gr-freeze .lamp').classList.toggle('on', g.freeze);
    $('#gr-free').setAttribute('aria-pressed', String(g.free)); $('#gr-free .lamp').classList.toggle('on', g.free);
    $('#gr-scale').value = g.scale; $('#gr-pre').value = presetSnap && JSON.stringify(g) === presetSnap ? presetIdx : '';
    K.jitter.disable(g.mode === 'cloud', 'Classic timing only');
    overBox.hidden = g.src !== 'region';
    const ov = g.rate * g.size / 1000;
    $('#gr-read').textContent = `Overlap ${ov < 10 ? ov.toFixed(1) : Math.round(ov)}×`;
    updateOverview(); draw();
  }

  return {
    sync, draw, resize() { draw(); },
    /** from the player: the Region is being rendered / is ready */
    onBake(s) {
      bake = s;
      if (s.state === 'ready') { regionPeaks = peaksOf(s.chs, COLS); say(''); }
      else if (s.state === 'baking') say(`Rendering the region… ${Math.round((s.fraction || 0) * 100)}%`);
      else if (s.state === 'waiting') say('Rendering the region with Tape and Multiband…');
      else if (s.state === 'error') say('The region could not be rendered.', true);
      else if (s.state === 'empty') say('Pick a stretch of the recording first.', true);
      draw();
    },
    reset() { regionPeaks = null; overPeaks = null; overFor = null; bake = { state: '' }; },
    get baking() { return bake.state === 'baking' || bake.state === 'waiting'; },
  };
}
