/* Planet Sound API — Cloudflare Worker + D1 (catalogue) + R2 (audio, images).
 *
 * Identity: no passwords, no email. A listener gets a random key the first
 * time they contribute; the key is the proof of ownership and can be carried
 * to another device. Only its SHA-256 is stored.
 *
 * Contributors can add and edit their own entries. Only the archive owner
 * (holder of ADMIN_TOKEN) can remove entries, from admin.html.
 */

const TAG_VOCAB = ['Voice', 'Water', 'Wind', 'Birds', 'Insects', 'Animals', 'Traffic', 'Machinery', 'Footsteps',
  'Bells', 'Music', 'Market', 'Crowd', 'Rain', 'Thunder', 'Indoors', 'Nature', 'Night', 'Dawn', 'Ritual',
  'Work', 'Transport', 'Silence', 'Weather', 'Urban', 'Underwater'];
const LIMITS = {
  singleUpload: 95 * 1024 * 1024,           // one PUT; larger audio goes multipart
  audio: 1024 * 1024 * 1024,                // 1 GB per master
  image: 12 * 1024 * 1024,
  dailyUploadBytes: 3 * 1024 * 1024 * 1024, // per listener per day
  dailySounds: 60,
  dailyIdentitiesPerIp: 25,
};
const MEDIA_TYPES = {
  flac: 'audio/flac', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', mp4: 'audio/mp4',
  ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};
const AUDIO_EXT = new Set(['flac', 'wav', 'mp3', 'm4a', 'aac', 'mp4', 'ogg', 'opus', 'webm', 'aif', 'aiff']);

/* ---------------- helpers ---------------- */
const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (s, m) => { throw new HttpError(s, m); };

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  const b = crypto.getRandomValues(new Uint8Array(20));
  let s = ''; for (const x of b) s += alphabet[x & 31];
  return 'PS-' + s.match(/.{5}/g).join('-');
}
function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = !allowed.length || allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : allowed[0],
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
    // Range / If-None-Match are sent by the browser's media player when it streams
    // a recording; without them allowed here, Chrome blocks playback entirely.
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,Range,If-None-Match,If-Range',
    'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges,ETag',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
});
async function body(req) { try { return await req.json(); } catch { fail(400, 'Expected a JSON body.'); } }
const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };

async function ipHash(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  return (await sha256(ip + (env.ADMIN_TOKEN || 'salt'))).slice(0, 24);
}

/* ---------------- identity ---------------- */
async function currentUser(req, env, required = true) {
  const h = req.headers.get('Authorization') || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!key) { if (required) fail(401, 'This needs your listener key.'); return null; }
  const u = await env.DB.prepare('SELECT id, name, collections, created_at FROM users WHERE key_hash = ?').bind(await sha256(key)).first();
  if (!u && required) fail(401, 'That listener key is not recognised.');
  return u || null;
}
function isAdmin(req, env) {
  const h = req.headers.get('Authorization') || '';
  return !!env.ADMIN_TOKEN && h === 'Bearer ' + env.ADMIN_TOKEN;
}

async function createIdentity(req, env) {
  const ip = await ipHash(req, env);
  const day = today();
  const row = await env.DB.prepare('SELECT n FROM ip_log WHERE ip_hash = ? AND day = ?').bind(ip, day).first();
  if (row && row.n >= LIMITS.dailyIdentitiesPerIp) fail(429, 'Too many new listeners from this network today. Try again tomorrow.');
  const b = await req.json().catch(() => ({}));
  const id = crypto.randomUUID(), key = randomKey();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, key_hash, name, created_at, ip_hash) VALUES (?, ?, ?, ?, ?)').bind(id, await sha256(key), clip(b.name, 80), now(), ip),
    env.DB.prepare('INSERT INTO ip_log (ip_hash, day, n) VALUES (?, ?, 1) ON CONFLICT (ip_hash, day) DO UPDATE SET n = n + 1').bind(ip, day),
  ]);
  return json({ user: { id, name: clip(b.name, 80) }, key }, 201);
}

/* ---------------- sounds ---------------- */
const LIST_COLS = `seq, id, owner_id, visibility, title, tags, lat, lng, place, recorded_at, created_at, credit, duration,
  codec, lossless, sample_rate, bit_depth, channels, lufs, audio_key, spec_key, photo_key, allow_download`;

function shapeSound(r, me, full = false) {
  const s = {
    no: r.seq, id: r.id, visibility: r.visibility, title: r.title, tags: safeJson(r.tags, []),
    lat: r.lat, lng: r.lng, place: r.place, recordedAt: r.recorded_at, createdAt: r.created_at,
    credit: r.credit, duration: r.duration,
    tech: { codec: r.codec, lossless: !!r.lossless, sampleRate: r.sample_rate, bitDepth: r.bit_depth, channels: r.channels, lufs: r.lufs },
    audio: r.audio_key ? '/media/' + r.audio_key : null,
    spectrogram: r.spec_key ? '/media/' + r.spec_key : null,
    photo: r.photo_key ? '/media/' + r.photo_key : null,
    allowDownload: !!r.allow_download,
    mine: !!(me && r.owner_id === me.id),
  };
  if (full) {
    s.notes = r.notes; s.equipment = r.equipment; s.updatedAt = r.updated_at;
    s.tech.peakDb = r.peak_db; s.tech.backgroundLufs = r.background_lufs; s.tech.clipped = r.clipped;
    s.tech.audioType = r.audio_type; s.tech.audioBytes = r.audio_bytes;
    s.peaks = safeJson(r.peaks, null);
  }
  return s;
}
function safeJson(t, d) { try { return t ? JSON.parse(t) : d; } catch { return d; } }

async function listSounds(req, env) {
  const me = await currentUser(req, env, false);
  const q = me
    ? env.DB.prepare(`SELECT ${LIST_COLS} FROM sounds WHERE visibility = 'public' OR owner_id = ? ORDER BY seq DESC`).bind(me.id)
    : env.DB.prepare(`SELECT ${LIST_COLS} FROM sounds WHERE visibility = 'public' ORDER BY seq DESC`);
  const { results } = await q.all();
  return json({ sounds: results.map(r => shapeSound(r, me)), me: me ? { id: me.id, name: me.name } : null },
    200, me ? {} : { 'Cache-Control': 'public, max-age=30' });
}

async function getSound(req, env, id) {
  const me = await currentUser(req, env, false);
  const r = await env.DB.prepare('SELECT * FROM sounds WHERE id = ? OR seq = ?').bind(id, Number(id) || -1).first();
  if (!r) fail(404, 'No entry with that number.');
  const mine = me && r.owner_id === me.id;
  if (!mine && r.visibility !== 'public') fail(404, 'No entry with that number.');
  return json({ sound: shapeSound(r, me, true) });
}

function readFields(b, partial) {
  const f = {};
  const set = (k, v) => { if (v !== undefined) f[k] = v; };
  if (!partial || 'title' in b) set('title', clip(b.title, 140) || (partial ? undefined : 'Untitled recording'));
  if (!partial || 'notes' in b) set('notes', clip(b.notes, 2000));
  if (!partial || 'tags' in b) set('tags', JSON.stringify((Array.isArray(b.tags) ? b.tags : []).filter(t => TAG_VOCAB.includes(t)).slice(0, 3)));
  if (!partial || 'lat' in b) { const v = num(b.lat, -90, 90); if (v === null) fail(400, 'Latitude must be between −90 and 90.'); f.lat = v; }
  if (!partial || 'lng' in b) { const v = num(b.lng, -180, 180); if (v === null) fail(400, 'Longitude must be between −180 and 180.'); f.lng = v; }
  if (!partial || 'place' in b) set('place', clip(b.place, 160));
  if (!partial || 'credit' in b) set('credit', clip(b.credit, 80));
  if (!partial || 'equipment' in b) set('equipment', clip(b.equipment, 160));
  if (!partial || 'recordedAt' in b) { const d = b.recordedAt ? new Date(b.recordedAt) : null; set('recorded_at', d && !isNaN(d) ? d.toISOString() : null); }
  if (!partial || 'visibility' in b) set('visibility', b.visibility === 'private' ? 'private' : 'public');
  if (!partial || 'allowDownload' in b) set('allow_download', b.allowDownload ? 1 : 0);
  return f;
}
function readTech(b) {
  const t = b.tech || {};
  return {
    duration: num(b.duration, 0, 86400),
    codec: clip(t.codec, 24), lossless: t.lossless ? 1 : 0,
    sample_rate: num(t.sampleRate, 1000, 768000), bit_depth: num(t.bitDepth, 8, 64), channels: num(t.channels, 1, 32),
    lufs: num(b.lufs, -120, 10), peak_db: num(b.peakDb, -200, 30), background_lufs: num(b.backgroundLufs, -120, 10),
    clipped: num(b.clippedSamples, 0, 1e12),
    peaks: Array.isArray(b.peaks) ? JSON.stringify(b.peaks.slice(0, 2000).map(v => Math.max(0, Math.min(255, v | 0)))) : null,
  };
}

async function ownUpload(env, me, key, kind) {
  if (!key) return null;
  if (!key.startsWith(`m/${me.id}/`)) fail(400, 'That file was not uploaded by you.');
  const ext = key.split('.').pop();
  if (kind === 'audio' && !AUDIO_EXT.has(ext)) fail(400, 'Audio must be FLAC, WAV, MP3, M4A, Ogg, Opus, WebM or AIFF.');
  if (kind !== 'audio' && !['png', 'jpg', 'jpeg', 'webp'].includes(ext)) fail(400, 'Images must be PNG, JPEG or WebP.');
  const u = await env.DB.prepare('SELECT bytes FROM uploads WHERE key = ? AND owner_id = ?').bind(key, me.id).first();
  if (!u) fail(400, 'That upload did not finish. Try publishing again.');
  return { key, bytes: u.bytes, type: MEDIA_TYPES[ext] };
}

async function createSound(req, env) {
  const me = await currentUser(req, env);
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM sounds WHERE owner_id = ? AND created_at >= ?").bind(me.id, today()).first();
  if (n.n >= LIMITS.dailySounds) fail(429, `You have added ${LIMITS.dailySounds} sounds today, the daily limit. The rest can wait until tomorrow.`);
  const b = await body(req);
  const f = readFields(b, false), t = readTech(b);
  const audio = await ownUpload(env, me, b.audioKey, 'audio');
  if (!audio) fail(400, 'An entry needs its audio.');
  const spec = await ownUpload(env, me, b.spectrogramKey, 'image');
  const photo = await ownUpload(env, me, b.photoKey, 'image');
  const id = typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id) ? b.id : crypto.randomUUID();
  const exists = await env.DB.prepare('SELECT id, owner_id FROM sounds WHERE id = ?').bind(id).first();
  if (exists) { if (exists.owner_id === me.id) return getSound(req, env, id); fail(409, 'That entry already exists.'); }
  const row = {
    id, owner_id: me.id, ...f, ...t, created_at: now(),
    credit: f.credit || me.name || null,
    audio_key: audio.key, audio_type: audio.type, audio_bytes: audio.bytes,
    spec_key: spec ? spec.key : null, photo_key: photo ? photo.key : null,
  };
  const cols = Object.keys(row);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sounds (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map(c => row[c])),
    env.DB.prepare(`UPDATE uploads SET attached = 1 WHERE key IN (?, ?, ?)`).bind(audio.key, row.spec_key, row.photo_key),
  ]);
  return getSound(req, env, id);
}

async function updateSound(req, env, id) {
  const me = await currentUser(req, env);
  const r = await env.DB.prepare('SELECT id, owner_id, photo_key FROM sounds WHERE id = ?').bind(id).first();
  if (!r || r.owner_id !== me.id) fail(404, 'Only the person who recorded this can change it.');
  const b = await body(req);
  const f = readFields(b, true);
  let oldPhoto = null;
  if ('photoKey' in b) {
    const p = b.photoKey ? await ownUpload(env, me, b.photoKey, 'image') : null;
    f.photo_key = p ? p.key : null;
    if (r.photo_key && r.photo_key !== f.photo_key) oldPhoto = r.photo_key;
  }
  if (!Object.keys(f).length) return getSound(req, env, id);
  f.updated_at = now();
  const cols = Object.keys(f);
  await env.DB.prepare(`UPDATE sounds SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`).bind(...cols.map(c => f[c]), id).run();
  if (f.photo_key) await env.DB.prepare('UPDATE uploads SET attached = 1 WHERE key = ?').bind(f.photo_key).run();
  if (oldPhoto) await env.MEDIA.delete(oldPhoto).catch(() => {});
  return getSound(req, env, id);
}

async function deleteSound(env, id) {   // admin only
  const r = await env.DB.prepare('SELECT * FROM sounds WHERE id = ?').bind(id).first();
  if (!r) fail(404, 'No entry with that id.');
  const keys = [r.audio_key, r.spec_key, r.photo_key].filter(Boolean);
  if (keys.length) await env.MEDIA.delete(keys).catch(() => {});
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sounds WHERE id = ?').bind(id),
    ...keys.map(k => env.DB.prepare('DELETE FROM uploads WHERE key = ?').bind(k)),
  ]);
  return json({ ok: true });
}

/* ---------------- uploads ---------------- */
async function checkQuota(env, me, bytes) {
  const u = await env.DB.prepare('SELECT COALESCE(SUM(bytes),0) AS b FROM uploads WHERE owner_id = ? AND created_at >= ?').bind(me.id, today()).first();
  if (u.b + bytes > LIMITS.dailyUploadBytes) fail(429, 'You have reached today’s upload allowance (3 GB). It resets tomorrow.');
}
function uploadKey(me, ext) {
  ext = String(ext || '').toLowerCase();
  if (!MEDIA_TYPES[ext]) fail(400, 'That file type is not accepted.');
  return { key: `m/${me.id}/${crypto.randomUUID()}.${ext}`, ext, type: MEDIA_TYPES[ext] };
}
async function putUpload(req, env, url) {
  const me = await currentUser(req, env);
  const { key, ext, type } = uploadKey(me, url.searchParams.get('ext'));
  const len = Number(req.headers.get('Content-Length') || 0);
  const max = AUDIO_EXT.has(ext) ? LIMITS.singleUpload : LIMITS.image;
  if (!len) fail(411, 'Missing file size.');
  if (len > max) fail(413, 'That file is too large for a single upload.');
  await checkQuota(env, me, len);
  await env.MEDIA.put(key, req.body, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
  await env.DB.prepare('INSERT INTO uploads (key, owner_id, bytes, created_at) VALUES (?, ?, ?, ?)').bind(key, me.id, len, now()).run();
  return json({ key }, 201);
}
async function mpuStart(req, env, url) {
  const me = await currentUser(req, env);
  const { key, ext, type } = uploadKey(me, url.searchParams.get('ext'));
  if (!AUDIO_EXT.has(ext)) fail(400, 'Only audio can be sent in parts.');
  const size = Number(url.searchParams.get('size') || 0);
  if (size > LIMITS.audio) fail(413, 'Recordings are limited to 1 GB.');
  await checkQuota(env, me, size);
  const mpu = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
  return json({ key, uploadId: mpu.uploadId }, 201);
}
async function mpuPart(req, env, url) {
  const me = await currentUser(req, env);
  const key = url.searchParams.get('key'), uploadId = url.searchParams.get('uploadId'), part = Number(url.searchParams.get('part'));
  if (!key || !key.startsWith(`m/${me.id}/`) || !uploadId || !(part >= 1 && part <= 10000)) fail(400, 'Bad part upload.');
  const mpu = env.MEDIA.resumeMultipartUpload(key, uploadId);
  const p = await mpu.uploadPart(part, req.body);
  return json({ partNumber: p.partNumber, etag: p.etag });
}
async function mpuComplete(req, env) {
  const me = await currentUser(req, env);
  const b = await body(req);
  if (!b.key || !b.key.startsWith(`m/${me.id}/`)) fail(400, 'Bad upload.');
  const mpu = env.MEDIA.resumeMultipartUpload(b.key, b.uploadId);
  if (b.abort) { await mpu.abort(); return json({ ok: true }); }
  const obj = await mpu.complete(b.parts);
  await env.DB.prepare('INSERT INTO uploads (key, owner_id, bytes, created_at) VALUES (?, ?, ?, ?)').bind(b.key, me.id, obj.size, now()).run();
  return json({ key: b.key }, 201);
}

/* ---------------- media ---------------- */
async function serveMedia(req, env, key) {
  const range = req.headers.get('Range');
  const opts = {};
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      if (m[1] === '' && m[2] !== '') opts.range = { suffix: Number(m[2]) };
      else opts.range = m[2] === '' ? { offset: Number(m[1]) } : { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 };
    }
  }
  const etag = req.headers.get('If-None-Match');
  // Never answer a Range request with 304: media players can't use it and fail. Conditional
  // revalidation is only for plain downloads.
  if (etag && !range) opts.onlyIf = { etagDoesNotMatch: etag.replace(/"/g, '') };
  const obj = await env.MEDIA.get(key, opts);
  if (!obj) return new Response('Not found', { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('ETag', obj.httpEtag);
  h.set('Accept-Ranges', 'bytes');
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges');
  if (!h.get('Cache-Control')) h.set('Cache-Control', 'public, max-age=31536000, immutable');
  const dl = new URL(req.url).searchParams.get('download');
  if (dl) h.set('Content-Disposition', `attachment; filename="${dl.replace(/[^\w.\-]+/g, '_').slice(0, 120)}"`);
  if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers: h });
  if (opts.range && obj.range) {
    const off = obj.range.offset ?? (obj.size - obj.range.suffix), len = obj.range.length ?? (obj.size - off);
    h.set('Content-Range', `bytes ${off}-${off + len - 1}/${obj.size}`);
    h.set('Content-Length', String(len));
    return new Response(req.method === 'HEAD' ? null : obj.body, { status: 206, headers: h });
  }
  h.set('Content-Length', String(obj.size));
  return new Response(req.method === 'HEAD' ? null : obj.body, { status: 200, headers: h });
}

/* ---------------- admin ---------------- */
async function admin(req, env, url, parts) {
  if (!isAdmin(req, env)) fail(401, 'Admin token required.');
  const [, , , what, id] = parts; // /api/admin/<what>/<id>
  if (what === 'sounds' && !id && req.method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT seq, id, title, place, credit, created_at, recorded_at, visibility, duration, audio_key, audio_bytes FROM sounds ORDER BY seq DESC`).all();
    const stats = await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM sounds) AS sounds, (SELECT COUNT(*) FROM users) AS listeners,
      (SELECT COALESCE(SUM(bytes),0) FROM uploads) AS bytes`).first();
    return json({ sounds: results, stats });
  }
  if (what === 'sounds' && id && req.method === 'DELETE') return deleteSound(env, id);
  fail(404, 'Unknown admin action.');
}

/* ---------------- router ---------------- */
async function route(req, env, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const parts = p.split('/');
  const m = req.method;
  if (p.startsWith('/media/') && (m === 'GET' || m === 'HEAD')) return serveMedia(req, env, decodeURIComponent(p.slice(7)));
  if (p === '/' || p === '/api' || p === '/api/health') {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM sounds WHERE visibility = 'public'").first();
    return json({ ok: true, service: 'planet-sound', sounds: r.n });
  }
  if (p === '/api/identity' && m === 'POST') return createIdentity(req, env);
  if (p === '/api/me' && m === 'GET') { const u = await currentUser(req, env); return json({ user: { id: u.id, name: u.name, createdAt: u.created_at } }); }
  if (p === '/api/me' && m === 'PATCH') {
    const u = await currentUser(req, env); const b = await body(req);
    await env.DB.prepare('UPDATE users SET name = ? WHERE id = ?').bind(clip(b.name, 80), u.id).run();
    return json({ user: { id: u.id, name: clip(b.name, 80) } });
  }
  if (p === '/api/me/rotate' && m === 'POST') {
    const u = await currentUser(req, env); const key = randomKey();
    await env.DB.prepare('UPDATE users SET key_hash = ? WHERE id = ?').bind(await sha256(key), u.id).run();
    return json({ key });
  }
  if (p === '/api/me/collections' && m === 'GET') { const u = await currentUser(req, env); return json({ collections: safeJson(u.collections, []) }); }
  if (p === '/api/me/collections' && m === 'PUT') {
    const u = await currentUser(req, env); const b = await body(req);
    const cols = (Array.isArray(b.collections) ? b.collections : []).slice(0, 200).map(c => ({
      id: clip(c.id, 64), name: clip(c.name, 80) || 'Untitled', ids: (Array.isArray(c.ids) ? c.ids : []).slice(0, 2000).map(x => clip(x, 64)), created: clip(c.created, 40),
    }));
    const text = JSON.stringify(cols);
    if (text.length > 400000) fail(413, 'That is a lot of collections. Remove a few first.');
    await env.DB.prepare('UPDATE users SET collections = ? WHERE id = ?').bind(text, u.id).run();
    return json({ ok: true });
  }
  if (p === '/api/sounds' && m === 'GET') return listSounds(req, env);
  if (p === '/api/sounds' && m === 'POST') return createSound(req, env);
  if (parts[1] === 'api' && parts[2] === 'sounds' && parts[3]) {
    const id = parts[3];
    if (!parts[4] && m === 'GET') return getSound(req, env, id);
    if (!parts[4] && m === 'PATCH') return updateSound(req, env, id);
    if (!parts[4] && m === 'DELETE') fail(403, 'Entries can only be removed by the archive owner.');
  }
  if (p === '/api/upload' && m === 'PUT') return putUpload(req, env, url);
  if (p === '/api/upload/multipart' && m === 'POST') return mpuStart(req, env, url);
  if (p === '/api/upload/multipart/part' && m === 'PUT') return mpuPart(req, env, url);
  if (p === '/api/upload/multipart/complete' && m === 'POST') return mpuComplete(req, env);
  if (parts[1] === 'api' && parts[2] === 'admin') return admin(req, env, url, parts);
  fail(404, 'Not found.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try { res = await route(req, env, url); }
    catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e && e.stack || e);
      res = json({ error: status === 500 ? 'Something went wrong on the server. Try again in a moment.' : e.message }, status);
    }
    if (!url.pathname.startsWith('/media/')) {
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) h.set(k, v);
      res = new Response(res.body, { status: res.status, headers: h });
    }
    return res;
  },
  // Daily: remove uploads that never became an entry (abandoned publishes).
  async scheduled(event, env) {
    const cutoff = new Date(Date.now() - 2 * 86400e3).toISOString();
    const { results } = await env.DB.prepare('SELECT key FROM uploads WHERE attached = 0 AND created_at < ? LIMIT 500').bind(cutoff).all();
    if (!results.length) return;
    await env.MEDIA.delete(results.map(r => r.key));
    await env.DB.batch(results.map(r => env.DB.prepare('DELETE FROM uploads WHERE key = ?').bind(r.key)));
    await env.DB.prepare('DELETE FROM ip_log WHERE day < ?').bind(cutoff.slice(0, 10)).run();
  },
};
