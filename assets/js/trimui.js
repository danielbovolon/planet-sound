/* Planet Sound — choosing where a recording starts and ends.
 *
 * One editor, two uses:
 *   take   "Edit recording" in the recorder, before publishing: Cut removes what is outside for good.
 *   entry  "Trim" on a published entry (owner only): the stretch is stored with the entry; what is outside is only
 *          hidden, never deleted, and can be brought back here at any time.
 * The picture is the recording's spectrogram (or its waveform); two handles set the start and the end, and the
 * stretch between them can be dragged as a whole. Arrow keys move a handle by 0.1 s (Shift: 1 s), and the times can
 * be typed. "Play" plays only the stretch that will be kept. */
import { paint as paintSpec } from './specpal.js';
import { drawWave } from './player.js';

const MIN_LEN = 0.2;
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
/** 75.25 → "1:15.3" */
export function fmtT(s) {
  s = Math.max(0, s); const m = Math.floor(s / 60), r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}
function parseT(t) {
  t = String(t).trim().replace(',', '.'); if (!t) return NaN;
  const p = t.split(':').map(Number); if (p.some(x => !isFinite(x))) return NaN;
  return p.length === 1 ? p[0] : p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2];
}

let dlg = null;
function build() {
  dlg = el('dialog', 'sheet trim-dlg'); dlg.id = 'trim-dlg';
  dlg.innerHTML = `
    <form method="dialog" class="sheet-head"><h2 id="tr-title"></h2><button class="x" aria-label="Close" value="close"></button></form>
    <div class="sheet-body">
      <p class="hint" id="tr-hint"></p>
      <div class="trim-view" id="tr-view">
        <div class="sono-img trim-spec" id="tr-spec" aria-hidden="true"></div>
        <canvas class="trim-wave" id="tr-wave" aria-hidden="true"></canvas>
        <div class="trim-shade l" id="tr-sl"></div><div class="trim-shade r" id="tr-sr"></div>
        <div class="trim-sel" id="tr-sel" title="Drag to move the stretch"></div>
        <i class="trim-head" id="tr-head" hidden></i>
        <div class="trim-h a" id="tr-a" role="slider" tabindex="0" aria-label="Start"><span></span></div>
        <div class="trim-h b" id="tr-b" role="slider" tabindex="0" aria-label="End"><span></span></div>
      </div>
      <div class="trim-axis" id="tr-axis" aria-hidden="true"></div>
      <div class="trim-row">
        <label class="trim-t"><span>Start</span><input id="tr-ta" inputmode="decimal" autocomplete="off" spellcheck="false"></label>
        <button type="button" class="btn trim-play" id="tr-play"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.6v12.8L18.6 12z"/></svg><span>Play</span></button>
        <label class="trim-t"><span>End</span><input id="tr-tb" inputmode="decimal" autocomplete="off" spellcheck="false"></label>
      </div>
      <p class="trim-len" id="tr-len"></p>
      <p class="s-msg" id="tr-msg" role="status"></p>
      <div class="row end trim-foot"><button type="button" class="btn quiet" id="tr-reset"></button><button type="button" class="btn ghost" id="tr-no">Cancel</button><button type="button" class="btn solid" id="tr-yes"></button></div>
    </div>`;
  document.body.append(dlg);
  return dlg;
}

/**
 * Open the editor. Resolves to { start, end }, to 'reset' (entry: show the whole recording again), or null.
 * @param {{mode:'take'|'entry', duration:number, specUrl?:string|null, peaks?:number[]|null, audioUrl?:string|null,
 *          start?:number, end?:number, trimmed?:boolean, apply?:(r:{start:number,end:number}|'reset', say:(t:string,err?:boolean)=>void)=>Promise<boolean>}} o
 *   apply: does the work (cut / save) while the editor stays open; resolve true to close it.
 */
export function editTrim(o) {
  const d = dlg || build(), $ = s => d.querySelector(s);
  const dur = Math.max(MIN_LEN, o.duration || 0);
  let a = Math.max(0, Math.min(dur - MIN_LEN, o.start || 0)), b = Math.max(a + MIN_LEN, Math.min(dur, o.end || dur));
  const take = o.mode === 'take';
  $('#tr-title').textContent = take ? 'Edit recording' : 'Trim';
  $('#tr-hint').textContent = take
    ? 'Drag the two handles to where the recording should start and end. What is outside is cut away for good when you press Cut.'
    : 'Drag the two handles to where the recording should start and end. What is outside is only hidden: it stays stored, and you can bring it back here at any time.';
  $('#tr-yes').textContent = take ? 'Cut' : 'Save';
  $('#tr-reset').textContent = 'Whole recording';
  $('#tr-reset').hidden = take ? true : !o.trimmed;
  $('#tr-msg').textContent = ''; $('#tr-msg').classList.remove('err');

  // the picture
  const spec = $('#tr-spec'), wave = $('#tr-wave');
  spec.hidden = !o.specUrl; wave.hidden = !!o.specUrl;
  if (o.specUrl) { spec.classList.remove('empty'); paintSpec(spec, o.specUrl); }

  // the axis: a tick every so often
  const axis = $('#tr-axis'); axis.innerHTML = '';
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600], step = steps.find(s => dur / s <= 6) || 900;
  for (let t = 0; t <= dur + 1e-6; t += step) { const s = el('span', '', fmtT(t).replace(/\.0$/, '')); s.style.left = `${t / dur * 100}%`; axis.append(s); }

  // preview player
  const audio = new Audio(); audio.preload = 'auto'; audio.setAttribute('playsinline', '');
  if (o.audioUrl) audio.src = o.audioUrl; else $('#tr-play').disabled = true;
  let raf = 0, playing = false;
  const head = $('#tr-head');
  const stop = () => { playing = false; cancelAnimationFrame(raf); try { audio.pause(); } catch {} head.hidden = true; $('#tr-play span').textContent = 'Play'; $('#tr-play').classList.remove('on'); };
  const tick = () => {
    if (!playing) return;
    const t = audio.currentTime;
    if (t >= b - 0.01 || audio.ended) { stop(); return; }
    head.hidden = false; head.style.left = `${t / dur * 100}%`;
    raf = requestAnimationFrame(tick);
  };
  $('#tr-play').onclick = () => {
    if (playing) { stop(); return; }
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    try { audio.currentTime = a; } catch {}
    playing = true; $('#tr-play span').textContent = 'Stop'; $('#tr-play').classList.add('on');
    const p = audio.play(); if (p && p.catch) p.catch(() => { stop(); say('This browser could not play the preview.', true); });
    raf = requestAnimationFrame(tick);
  };

  const say = (t, err = false) => { $('#tr-msg').textContent = t; $('#tr-msg').classList.toggle('err', err); };
  function render() {
    const A = a / dur * 100, B = b / dur * 100;
    $('#tr-sl').style.width = `${A}%`; $('#tr-sr').style.left = `${B}%`; $('#tr-sr').style.width = `${100 - B}%`;
    $('#tr-sel').style.left = `${A}%`; $('#tr-sel').style.width = `${B - A}%`;
    $('#tr-a').style.left = `${A}%`; $('#tr-b').style.left = `${B}%`;
    $('#tr-a').setAttribute('aria-valuenow', a.toFixed(1)); $('#tr-a').setAttribute('aria-valuetext', fmtT(a));
    $('#tr-b').setAttribute('aria-valuenow', b.toFixed(1)); $('#tr-b').setAttribute('aria-valuetext', fmtT(b));
    if (document.activeElement !== $('#tr-ta')) $('#tr-ta').value = fmtT(a);
    if (document.activeElement !== $('#tr-tb')) $('#tr-tb').value = fmtT(b);
    const cut = dur - (b - a);
    $('#tr-len').textContent = cut < 0.05 ? `The whole recording, ${fmtT(dur)}.` : `Keeps ${fmtT(b - a)} of ${fmtT(dur)}. ${take ? 'Cuts' : 'Hides'} ${fmtT(cut)}.`;
    $('#tr-yes').disabled = take && cut < 0.05;
  }
  const setA = v => { a = Math.max(0, Math.min(b - MIN_LEN, v)); render(); };
  const setB = v => { b = Math.min(dur, Math.max(a + MIN_LEN, v)); render(); };

  // dragging
  const view = $('#tr-view');
  const tAt = e => { const r = view.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur; };
  let drag = null;
  view.onpointerdown = e => {
    const t = tAt(e), r = view.getBoundingClientRect(), px = dur / r.width;
    const da = Math.abs(t - a) / px, db = Math.abs(t - b) / px;
    if (Math.min(da, db) <= 22) drag = { m: da <= db ? 'a' : 'b' };
    else if (t > a && t < b) drag = { m: 'move', off: t - a, len: b - a };
    else drag = { m: t < a ? 'a' : 'b' };
    if (drag.m === 'a') setA(t); else if (drag.m === 'b') setB(t);
    view.setPointerCapture(e.pointerId); e.preventDefault();
  };
  view.onpointermove = e => {
    if (!drag) return; const t = tAt(e);
    if (drag.m === 'a') setA(t); else if (drag.m === 'b') setB(t);
    else { const s = Math.max(0, Math.min(dur - drag.len, t - drag.off)); a = s; b = s + drag.len; render(); }
  };
  view.onpointerup = view.onpointercancel = () => { drag = null; };
  const keys = (setter, get) => e => {
    const st = e.shiftKey ? 1 : 0.1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { setter(get() - st); e.preventDefault(); }
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { setter(get() + st); e.preventDefault(); }
    if (e.key === 'Home') { setter(-1e9); e.preventDefault(); } if (e.key === 'End') { setter(1e9); e.preventDefault(); }
  };
  $('#tr-a').onkeydown = keys(setA, () => a); $('#tr-b').onkeydown = keys(setB, () => b);
  const typed = (inp, setter) => { inp.onchange = () => { const v = parseT(inp.value); if (isFinite(v)) setter(v); inp.value = fmtT(inp === $('#tr-ta') ? a : b); }; inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); inp.onchange(); } }; };
  typed($('#tr-ta'), setA); typed($('#tr-tb'), setB);

  return new Promise(resolve => {
    let busy = false;
    const finish = v => { stop(); audio.removeAttribute('src'); try { audio.load(); } catch {} d.onclose = null; if (d.open) d.close(); resolve(v); };
    const act = async v => {
      if (busy) return;
      if (!o.apply) return finish(v);
      busy = true; stop(); $('#tr-yes').disabled = true; $('#tr-reset').disabled = true;
      try { if (await o.apply(v, say)) finish(v); }
      finally { busy = false; $('#tr-yes').disabled = false; $('#tr-reset').disabled = false; }
    };
    $('#tr-yes').onclick = () => act({ start: +a.toFixed(3), end: +b.toFixed(3) });
    $('#tr-reset').onclick = () => act('reset');
    $('#tr-no').onclick = () => finish(null);
    d.onclose = () => { if (!busy) finish(null); };
    d.showModal();
    render();
    if (!o.specUrl) requestAnimationFrame(() => drawWave(wave, o.peaks || null, 1));
  });
}
