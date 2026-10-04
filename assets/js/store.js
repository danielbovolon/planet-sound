/* Device storage. The outbox holds finished entries until they are safely on
 * the server, so a recording made with no signal is never lost. */

const DB = 'planet-sound', VER = 1;
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res) => {
    let r;
    try { r = indexedDB.open(DB, VER); } catch { return res(null); }
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null);
    r.onblocked = () => res(null);
  });
  return dbp;
}
function tx(store, mode, fn) {
  return open().then(d => d ? new Promise((res, rej) => {
    const t = d.transaction(store, mode); const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
  }) : undefined);
}

/* Safari has trouble reading Blobs back out of IndexedDB in some versions;
 * storing ArrayBuffers plus a type is reliable everywhere. */
async function pack(entry) {
  const o = { ...entry, files: {} };
  for (const [k, b] of Object.entries(entry.files || {})) if (b) o.files[k] = { buf: await b.arrayBuffer(), type: b.type, name: b.name || null };
  return o;
}
function unpack(o) {
  const e = { ...o, files: {} };
  for (const [k, f] of Object.entries(o.files || {})) e.files[k] = new Blob([f.buf], { type: f.type });
  return e;
}

export const outbox = {
  async put(entry) { const p = await pack(entry); return tx('outbox', 'readwrite', s => s.put(p)); },
  async all() { const rows = await tx('outbox', 'readonly', s => s.getAll()); return (rows || []).map(unpack); },
  async remove(id) { return tx('outbox', 'readwrite', s => s.delete(id)); },
  async patch(id, fields) {
    const rows = await tx('outbox', 'readonly', s => s.get(id));
    if (!rows) return;
    return tx('outbox', 'readwrite', s => s.put({ ...rows, ...fields }));
  },
};

export const prefs = {
  get(k, d = null) { try { const v = localStorage.getItem('ps-' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ps-' + k, JSON.stringify(v)); } catch {} },
};
