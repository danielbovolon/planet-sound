/* Planet Sound — "N contributors" on the Index page.
 * The number is counted by the archive itself (/api/stats: different people with a sound on the public map),
 * so it follows additions and removals without anyone editing a text. It is fetched when the page opens,
 * when the Index is shown, whenever the tab comes back into view, and every two minutes while it is open.
 * If the archive can't be reached (or runs an older version), the line simply stays hidden. */
import { $ } from './ui.js';

export function initContributors({ call, getView }) {
  const line = $('#index-contrib'), n = $('#contrib-n'), l = $('#contrib-l'), sm = $('#contrib-s');
  let last = 0, busy = false;
  const show = c => {
    if (!Number.isFinite(c) || c < 0) { line.hidden = true; return; }
    n.textContent = c.toLocaleString(); l.textContent = c === 1 ? 'contributor' : 'contributors'; if (sm) sm.textContent = c === 1 ? 'has added sound to the project' : 'have added sound to the project'; line.hidden = false;
  };
  async function refresh(force) {
    if (busy || (!force && Date.now() - last < 5000)) return;
    busy = true;
    try { const d = await call('/api/stats'); last = Date.now(); show(Number(d && d.contributors)); }
    catch { /* keep whatever is shown */ }
    finally { busy = false; }
  }
  refresh(true);
  setInterval(() => { if (!document.hidden && getView() === 'index') refresh(true); }, 120000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && getView() === 'index') refresh(); });
  document.addEventListener('click', e => { if (e.target.closest && e.target.closest('[data-view="index"]')) refresh(); });
  window.addEventListener('planet-sound:loaded', () => refresh());
  return { refresh };
}
