/* Planet Sound — small conveniences on the entry card.
 *   - the photo is a small thumbnail beside the place; a tap enlarges it a little, and it shrinks again
 *     when you tap anywhere else, scroll or swipe
 *   - full screen for the whole card (the browser's Fullscreen API where it exists, a full-window
 *     layout where it doesn't — iPhone Safari only has that for video)
 */
import { $ } from './ui.js';

export function initCardPlus({ card }) {
  const wrap = $('#c-thumbwrap'), img = $('#c-photo'), scroller = card.querySelector('.card-scroll');

  /* ---- photo thumbnail ---- */
  const big = () => wrap.classList.contains('big');
  function setBig(on) {
    wrap.classList.toggle('big', on);
    img.setAttribute('aria-expanded', String(on));
    img.setAttribute('aria-label', on ? 'Shrink photo' : 'Enlarge photo');
  }
  function setPhoto(url, alt) {
    setBig(false);
    if (!url) { wrap.hidden = true; img.removeAttribute('src'); return; }
    if (img.getAttribute('src') !== url) img.src = url;
    img.alt = alt || '';
    wrap.hidden = false;
  }
  img.addEventListener('click', e => { e.stopPropagation(); setBig(!big()); });
  img.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setBig(!big()); } });
  // anywhere else on screen, or any movement of the card, puts it back
  document.addEventListener('pointerdown', e => { if (big() && !wrap.contains(e.target)) setBig(false); }, true);
  scroller.addEventListener('scroll', () => { if (big()) setBig(false); }, { passive: true });
  scroller.addEventListener('touchmove', () => { if (big()) setBig(false); }, { passive: true });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && big()) setBig(false); });

  /* ---- full screen ---- */
  const btn = $('#c-full');
  // the whole page goes full screen (not just the card), so the glass card keeps the map behind it and looks the same
  const root = document.documentElement;
  const native = !!(root.requestFullscreen || root.webkitRequestFullscreen);
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  const isFull = () => card.classList.contains('expanded');
  function paint() {
    const on = isFull();
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Leave full screen' : 'Full screen');
    btn.title = on ? 'Leave full screen' : 'Full screen';
    document.body.classList.toggle('card-expanded', on);
  }
  async function enter() {
    card.classList.add('expanded'); paint();
    if (native) {
      try { await (root.requestFullscreen || root.webkitRequestFullscreen).call(root); } catch { /* the full-window layout stays */ }
    }
  }
  async function leave() {
    card.classList.remove('expanded'); paint();
    if (fsEl() === root) { try { await (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch {} }
  }
  btn.addEventListener('click', () => (isFull() ? leave() : enter()));
  const onFsChange = () => { if (isFull() && native && fsEl() !== root && !card.dataset.entering) { card.classList.remove('expanded'); paint(); } };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  // the layout-only version has no browser Esc, so give it one
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isFull() && fsEl() !== root) leave(); });

  return { setPhoto, leave: () => { setBig(false); if (isFull()) leave(); } };
}
