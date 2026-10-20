/* Planet Sound — rotary knobs (the recorder's Gain, the Tape and Multiband controls).
 *
 * The look: a small piece of 1960s Italian studio hardware — a fluted ivory bakelite knob on a chrome
 * skirt, a printed scale around it, a red pointer. The scale lights up as the value rises.
 *
 * A knob is a real slider for assistive technology (role="slider", arrow keys) and a knob for everyone else:
 *   drag up or down (Shift: fine) · mouse wheel · arrow keys (Shift: five steps, PageUp/Down: big steps)
 *   Home / End · double-click or double-tap to return to the default.
 *   `detent`: dragging past the default sticks for a moment (a centre click), for Pitch, Speed and the like.
 * Drawing is SVG; the colours come from recorder.css / fx.css.
 */
const NS = 'http://www.w3.org/2000/svg';
const A0 = -135, A1 = 135;                       // sweep in degrees, 0 = straight up
const C = 50;
const TICKS = 21;
let uid = 0, defsDone = false;

function ensureDefs() {
  if (defsDone || typeof document === 'undefined') return;
  defsDone = true;
  const d = document.createElementNS(NS, 'svg');
  d.setAttribute('width', '0'); d.setAttribute('height', '0'); d.setAttribute('aria-hidden', 'true');
  d.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  d.innerHTML = `<defs>
    <radialGradient id="psk-skirt" cx="38%" cy="30%" r="85%"><stop offset="0" stop-color="#f4f3ee"/><stop offset=".45" stop-color="#a9acaf"/><stop offset=".8" stop-color="#5d6064"/><stop offset="1" stop-color="#2b2d30"/></radialGradient>
    <linearGradient id="psk-rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".85"/><stop offset=".5" stop-color="#ffffff" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity=".5"/></linearGradient>
    <radialGradient id="psk-body" cx="36%" cy="28%" r="90%"><stop offset="0" stop-color="#fbf4de"/><stop offset=".5" stop-color="#e8dab6"/><stop offset="1" stop-color="#a99466"/></radialGradient>
    <radialGradient id="psk-cap" cx="40%" cy="32%" r="80%"><stop offset="0" stop-color="#fffaf0"/><stop offset=".6" stop-color="#efe3c4"/><stop offset="1" stop-color="#cdb98b"/></radialGradient>
    <linearGradient id="psk-ptr" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e5522a"/><stop offset=".5" stop-color="#cf3f19"/><stop offset="1" stop-color="#9d2d0e"/></linearGradient>
    <filter id="psk-blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2"/></filter>
  </defs>`;
  document.body.prepend(d);
}
const pt = (a, r) => { const t = (a - 90) * Math.PI / 180; return [C + r * Math.cos(t), C + r * Math.sin(t)]; };
const f2 = n => n.toFixed(2);
const FLUTES = (() => {                          // the fluted edge of the knob: 36 short radial strokes
  let d = '';
  for (let i = 0; i < 36; i++) { const a = i * 10, [x0, y0] = pt(a, 30.6), [x1, y1] = pt(a, 33.2); d += `M${f2(x0)} ${f2(y0)}L${f2(x1)} ${f2(y1)}`; }
  return d;
})();

/**
 * @param {HTMLElement} host   an empty element; the name, the knob and its value are built inside it
 * @param {{label:string, min:number, max:number, step?:number, value:number, def?:number, origin?:number, scale?:'lin'|'log',
 *          steps?:number, round?:(v:number)=>number, detent?:boolean, small?:boolean,
 *          format:(v:number)=>string, speech?:(v:number)=>string, onInput?:(v:number)=>void, hint?:string}} o
 *   step: value step of a linear knob. A log knob has `steps` positions (default 120) and `round` to tidy the value.
 */
export function createKnob(host, o) {
  ensureDefs();
  const log = o.scale === 'log';
  const def = o.def ?? o.value, origin = o.origin ?? o.min;
  const steps = o.steps || (log ? 120 : Math.max(1, Math.round((o.max - o.min) / o.step)));
  const dec = o.step ? (String(o.step).split('.')[1] || '').length : 3;
  const toN = v => log ? Math.log(v / o.min) / Math.log(o.max / o.min) : (v - o.min) / (o.max - o.min);
  const fromN = n => log ? o.min * Math.pow(o.max / o.min, n) : o.min + n * (o.max - o.min);
  const tidy = v => (o.round ? o.round(v) : +v.toFixed(dec));
  const snapN = n => Math.round(Math.max(0, Math.min(1, n)) * steps) / steps;
  const clampV = v => Math.max(o.min, Math.min(o.max, v));
  const fromGesture = n => { n = snapN(n); const v = n <= 0 ? o.min : n >= 1 ? o.max : tidy(fromN(n)); return clampV(v); };
  const ang = v => A0 + (A1 - A0) * toN(v);
  let value = clampV(o.value), disabled = false, drag = null, lastTap = 0;

  host.classList.add('knob-box'); if (o.small) host.classList.add('sm');
  host.innerHTML = '';
  const name = document.createElement('span'); name.className = 'knob-name'; name.textContent = o.label;
  const knob = document.createElement('div');
  knob.className = 'knob'; knob.tabIndex = 0; knob.setAttribute('role', 'slider');
  knob.setAttribute('aria-label', o.label);
  knob.setAttribute('aria-valuemin', o.min); knob.setAttribute('aria-valuemax', o.max);
  if (o.hint) knob.title = o.hint;
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('aria-hidden', 'true');
  const el = (tag, attrs, parent = svg) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.append(e); return e; };
  // printed scale
  const ticks = [];
  for (let i = 0; i < TICKS; i++) {
    const a = A0 + (A1 - A0) * i / (TICKS - 1), major = i % 5 === 0, [x0, y0] = pt(a, major ? 40.5 : 42), [x1, y1] = pt(a, 47);
    const t = el('line', { x1: f2(x0), y1: f2(y0), x2: f2(x1), y2: f2(y1), class: 'k-tick' + (major ? ' major' : '') });
    ticks.push({ el: t, a });
  }
  { const [x0, y0] = pt(ang(def), 38.5), [x1, y1] = pt(ang(def), 48.5); el('line', { x1: f2(x0), y1: f2(y0), x2: f2(x1), y2: f2(y1), class: 'k-def' }); }
  // the knob itself
  el('ellipse', { cx: 50, cy: 56, rx: 37, ry: 35, class: 'k-shadow', filter: 'url(#psk-blur)' });
  el('circle', { cx: 50, cy: 50, r: 37, fill: 'url(#psk-skirt)' });
  el('circle', { cx: 50, cy: 50, r: 36.6, fill: 'none', stroke: 'url(#psk-rim)', 'stroke-width': 1.2 });
  const rot = el('g', {});
  el('circle', { cx: 50, cy: 50, r: 33.2, fill: 'url(#psk-body)', class: 'k-body' }, rot);
  el('path', { d: FLUTES, class: 'k-flutes' }, rot);
  el('circle', { cx: 50, cy: 50, r: 24.5, fill: 'url(#psk-cap)', class: 'k-cap' }, rot);
  el('circle', { cx: 50, cy: 50, r: 24.5, fill: 'none', class: 'k-cap-ring' }, rot);
  el('path', { d: 'M47.6 27.5 L52.4 27.5 L51.4 12.6 Q50 11.2 48.6 12.6 Z', fill: 'url(#psk-ptr)', class: 'k-pointer' }, rot);
  el('ellipse', { cx: 41, cy: 38, rx: 9, ry: 4.6, transform: 'rotate(-38 41 38)', fill: '#fff', opacity: '.22', class: 'k-shine' });
  knob.append(svg);
  const out = document.createElement('output'); out.className = 'knob-val';
  host.append(name, knob, out);

  function paint() {
    const a = ang(value), lo = Math.min(a, ang(origin)), hi = Math.max(a, ang(origin));
    for (const t of ticks) t.el.classList.toggle('lit', t.a >= lo - 0.01 && t.a <= hi + 0.01 && (value !== origin || Math.abs(t.a - a) < 0.01));
    rot.setAttribute('transform', `rotate(${f2(a)} ${C} ${C})`);
    out.textContent = o.format(value);
    knob.setAttribute('aria-valuenow', value);
    knob.setAttribute('aria-valuetext', (o.speech || o.format)(value));
    knob.classList.toggle('is-default', value === def);
  }
  function set(v, notify = true) {
    v = clampV(+v);
    if (!isFinite(v) || v === value) return;
    value = v; paint(); if (notify && o.onInput) o.onInput(value);
  }
  const setN = n => set(fromGesture(n));
  const nowN = () => toN(value);

  knob.addEventListener('pointerdown', e => {
    if (disabled || e.button > 0) return;
    knob.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, n: nowN(), moved: false, stuck: false };
    knob.classList.add('is-drag'); e.preventDefault(); knob.focus({ preventScroll: true });
  });
  knob.addEventListener('pointermove', e => {
    if (!drag) return;
    const dy = drag.y - e.clientY;
    if (Math.abs(dy) > 3) drag.moved = true;
    const span = e.shiftKey ? 900 : 220;             // pixels for the whole range; Shift = fine
    let n = drag.n + dy / span;
    if (o.detent) {                                   // a centre click: hold the default until the pointer has gone clearly past it
      const dn = toN(def), w = 0.035;
      if (Math.abs(n - dn) < w) n = dn;
    }
    setN(n);
  });
  const end = e => {
    if (!drag) return;
    const tap = !drag.moved; drag = null; knob.classList.remove('is-drag');
    if (tap && e.type === 'pointerup') {
      const now = performance.now();
      if (now - lastTap < 340) { set(def); lastTap = 0; } else lastTap = now;
    }
  };
  knob.addEventListener('pointerup', end); knob.addEventListener('pointercancel', end);
  knob.addEventListener('wheel', e => {
    if (disabled) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;                // one notch = a few steps; Shift = a single step
    setN(nowN() + dir * (e.shiftKey ? 1 : Math.max(1, Math.round(steps / 60))) / steps);
  }, { passive: false });
  knob.addEventListener('keydown', e => {
    if (disabled) return;
    const st = (e.shiftKey ? 5 : 1) / steps, big = 0.1;
    const k = { ArrowUp: st, ArrowRight: st, ArrowDown: -st, ArrowLeft: -st, PageUp: big, PageDown: -big }[e.key];
    if (k !== undefined) { e.preventDefault(); setN(nowN() + k); }
    else if (e.key === 'Home') { e.preventDefault(); set(o.min); }
    else if (e.key === 'End') { e.preventDefault(); set(o.max); }
    else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); set(def); }
  });
  knob.addEventListener('dblclick', e => { if (!disabled) { e.preventDefault(); set(def); } });

  paint();
  return {
    el: knob, host,
    get value() { return value; },
    set,                                   // set(v, notify = true)
    reset() { set(def); },
    disable(on, why) { disabled = !!on; knob.setAttribute('aria-disabled', String(!!on)); knob.tabIndex = on ? -1 : 0; host.classList.toggle('is-off', !!on); if (why) knob.title = why; },
  };
}
