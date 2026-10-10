/* Talking to the Planet Sound Worker. */

const CFG = window.PLANET_SOUND || {};
export const API = (CFG.apiBase || '').replace(/\/$/, '');
const KEY = 'ps-key', USER = 'ps-user';

export const identity = {
  get key() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } },
  get user() { try { return JSON.parse(localStorage.getItem(USER) || 'null'); } catch { return null; } },
  set(key, user) { try { localStorage.setItem(KEY, key); localStorage.setItem(USER, JSON.stringify(user || null)); } catch {} },
  setUser(user) { try { localStorage.setItem(USER, JSON.stringify(user || null)); } catch {} },
  clear() { try { localStorage.removeItem(KEY); localStorage.removeItem(USER); } catch {} },
};

export const mediaUrl = path => (path ? (/^https?:/.test(path) ? path : API + path) : null);

export class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export async function call(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
  const h = { ...headers };
  if (auth && identity.key) h.Authorization = 'Bearer ' + identity.key;
  if (body !== undefined && !(body instanceof Blob)) { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  let r;
  try { r = await fetch(API + path, { method, headers: h, body }); }
  catch { throw new ApiError(0, 'No connection to Planet Sound right now.'); }
  let data = null; try { data = await r.json(); } catch {}
  if (!r.ok) throw new ApiError(r.status, (data && data.error) || `The server answered ${r.status}.`);
  return data;
}

/** Make sure this device has a listener key; creates one on first need. */
export async function ensureIdentity(name) {
  // Publishing needs a signed-in account (sign-in by email). Nothing is created silently.
  if (identity.key && identity.user && identity.user.email) return identity.user;
  throw new ApiError(401, 'Sign in with your email to publish. Your recording is kept and will publish when you are signed in.');
}

function xhrPut(url, blob, onProgress, headers = {}) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded); };
    x.onload = () => {
      let d = null; try { d = JSON.parse(x.responseText); } catch {}
      if (x.status >= 200 && x.status < 300) res(d); else rej(new ApiError(x.status, (d && d.error) || 'Upload failed.'));
    };
    x.onerror = () => rej(new ApiError(0, 'The upload was interrupted. It will be retried.'));
    x.send(blob);
  });
}

const SINGLE_MAX = 90 * 1024 * 1024, PART = 20 * 1024 * 1024;

/** Upload one file; returns its storage key. Large audio goes up in parts. */
export async function upload(blob, ext, onProgress) {
  const auth = { Authorization: 'Bearer ' + identity.key };
  if (blob.size <= SINGLE_MAX) {
    const d = await xhrPut(`${API}/api/upload?ext=${encodeURIComponent(ext)}`, blob, onProgress, auth);
    return d.key;
  }
  const start = await call(`/api/upload/multipart?ext=${encodeURIComponent(ext)}&size=${blob.size}`, { method: 'POST' });
  const parts = [];
  try {
    for (let i = 0, n = 1; i < blob.size; i += PART, n++) {
      const chunk = blob.slice(i, i + PART);
      let tries = 0, p;
      for (;;) {
        try {
          p = await xhrPut(`${API}/api/upload/multipart/part?key=${encodeURIComponent(start.key)}&uploadId=${encodeURIComponent(start.uploadId)}&part=${n}`,
            chunk, loaded => onProgress && onProgress(i + loaded), auth);
          break;
        } catch (e) { if (++tries >= 3) throw e; await new Promise(r => setTimeout(r, 1500 * tries)); }
      }
      parts.push(p);
    }
    const done = await call('/api/upload/multipart/complete', { method: 'POST', body: { key: start.key, uploadId: start.uploadId, parts } });
    return done.key;
  } catch (e) {
    call('/api/upload/multipart/complete', { method: 'POST', body: { key: start.key, uploadId: start.uploadId, abort: true } }).catch(() => {});
    throw e;
  }
}
