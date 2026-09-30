/* DanceLab service worker.
 *
 * App shell: network-first so updates arrive on the next open, cache fallback when offline.
 *
 * Media: a <video> element cannot send an Authorization header and Google no longer accepts the
 * token as a URL parameter, so the app plays the same-origin virtual URL ./media?id=…&t=… and this
 * worker turns each request into an authenticated Drive request. Files are kept on the device in
 * 4 MB parts (Cache Storage): a part is stored the first time it passes through, the rest of the
 * file is fetched ahead while the lesson is open, and lessons uploaded from this device are stored
 * at upload time. Every later seek is served from disk. The most recent 2 GB stay; when the cap is
 * reached the least recently played lesson goes first.
 *
 * Never touches other Google API requests. */
const VERSION = 'bl-v45';
const MEDIA_CACHE = 'bl-media-1';                   // outlives app updates (not tied to VERSION)
const PART = 4 * 1024 * 1024;                       // bytes per cached part
const CAP = +new URL(self.location.href).searchParams.get('cap') || 2 * 1024 * 1024 * 1024;   // bytes kept on the device (?cap= is a test hook)
const SCOPE = self.registration.scope;
const MEDIA_PATH = new URL('./media', SCOPE).pathname;
const PART_PATH = new URL('./media-part', SCOPE).pathname;   // cache keys only, never fetched
const INDEX_URL = new URL('./media-index', SCOPE).href;      // cache key of the JSON index
// Drive endpoint; the test harness registers the worker with ?drive=<fake server> instead.
const DRIVE = new URL(self.location.href).searchParams.get('drive') || 'https://www.googleapis.com/drive/v3/files/';
const SHELL = ['./', './index.html', './styles.css', './app.js', './gemini.js', './config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== MEDIA_CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === MEDIA_PATH) { e.respondWith(serveMedia(e, url)); return; }
  if (url.pathname === PART_PATH || url.href === INDEX_URL) return;
  if (e.request.method !== 'GET') return;
  e.respondWith(shell(e));
});
self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type === 'store' && d.id && d.blob) e.waitUntil(storeBlob(d.id, d.blob, d.mime || d.blob.type || 'video/mp4'));
  else if (d.type === 'evict' && d.id) e.waitUntil(evict(d.id));
  else if (d.type === 'clear') e.waitUntil(clearMedia());
});

async function shell(e) {
  try {
    // Revalidate with the server instead of trusting the HTTP cache: GitHub Pages sends a
    // 10-minute max-age, which otherwise lets a fresh index.html pair with a stale stylesheet.
    const net = await fetch(e.request, { cache: 'no-cache' });
    if (net.ok) { const c = await caches.open(VERSION); c.put(e.request, net.clone()); }
    return net;
  } catch (err) {
    const hit = await caches.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    if (e.request.mode === 'navigate') { const s = await caches.match('./index.html'); if (s) return s; }
    throw err;
  }
}

// ---------- index: { files: { [id]: { size, type, parts: [0|1…], used } } } ----------
let indexP = null;
async function verifyCache() { if (indexP && !(await caches.has(MEDIA_CACHE))) indexP = null; }   // storage purged behind our back
function loadIndex() {
  if (!indexP) indexP = (async () => {
    try { const c = await caches.open(MEDIA_CACHE); const r = await c.match(INDEX_URL); if (r) { const j = await r.json(); if (j && j.files) return j; } } catch (e) { /* fresh */ }
    return { files: {} };
  })();
  return indexP;
}
let saveChain = Promise.resolve();
function scheduleSave() {
  saveChain = saveChain.then(async () => {
    const idx = await loadIndex(); const c = await caches.open(MEDIA_CACHE);
    await c.put(INDEX_URL, new Response(JSON.stringify(idx), { headers: { 'content-type': 'application/json' } }));
  }).catch(() => {});
  return saveChain;
}
const partsOf = size => Math.ceil(size / PART);
const partKey = (id, n) => new URL('./media-part?id=' + encodeURIComponent(id) + '&p=' + n, SCOPE).href;
const bytesOf = e => e.size;                                    // a lesson reserves its full size once it starts caching
const isQuota = e => e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));

async function ensureRoom(size, keepId) {
  const idx = await loadIndex();
  for (;;) {
    const total = Object.values(idx.files).reduce((s, e) => s + bytesOf(e), 0);
    if (total + size <= CAP) return true;
    if (!(await evictOne(keepId))) return false;
  }
}
async function evictOne(keepId) {
  const idx = await loadIndex();
  const victim = Object.keys(idx.files).filter(id => id !== keepId).sort((a, b) => idx.files[a].used - idx.files[b].used)[0];
  if (!victim) return false;
  await evict(victim);
  return true;
}
async function evict(id) {
  const idx = await loadIndex(); const e = idx.files[id];
  if (prefetching && prefetching.id === id) prefetching.stop = true;
  if (!e) return;
  delete idx.files[id];
  const c = await caches.open(MEDIA_CACHE);
  for (let n = 0; n < e.parts.length; n++) await c.delete(partKey(id, n));
  await scheduleSave();
}
async function clearMedia() {
  if (prefetching) prefetching.stop = true;
  indexP = Promise.resolve({ files: {} });
  await caches.delete(MEDIA_CACHE);
}
// Stores one part; on the first part of a lesson the room is reserved (evicting least recently
// played lessons); on a quota error one more lesson is evicted and the put retried once.
async function storePart(id, n, buf, size, type) {
  const idx = await loadIndex(); let e = idx.files[id];
  if (!e) {
    if (size > CAP || !(await ensureRoom(size, id))) return false;
    e = idx.files[id] = { size, type, parts: new Array(partsOf(size)).fill(0), used: Date.now() };
  }
  const c = await caches.open(MEDIA_CACHE);
  if (e.parts[n] && await c.match(partKey(id, n))) return true;
  const put = () => c.put(partKey(id, n), new Response(buf, { headers: { 'content-type': type, 'content-length': String(buf.byteLength) } }));
  try { await put(); } catch (err) {
    if (!isQuota(err) || !(await evictOne(id))) return false;
    try { await put(); } catch (err2) { return false; }
  }
  if (!idx.files[id]) return false;                       // evicted meanwhile
  e.parts[n] = 1; await scheduleSave();
  return true;
}
async function storeBlob(id, blob, type) {
  const size = blob.size; if (!size || size > CAP) return;
  await verifyCache();
  const idx = await loadIndex(); if (idx.files[id] && idx.files[id].parts.every(Boolean)) return;
  for (let n = 0; n < partsOf(size); n++) {
    const buf = await blob.slice(n * PART, Math.min(size, (n + 1) * PART)).arrayBuffer();
    if (!(await storePart(id, n, buf, size, type))) return;
  }
  const e = idx.files[id]; if (e) { e.used = Date.now(); await scheduleSave(); }
}
async function touch(id) {
  const idx = await loadIndex(); const e = idx.files[id];
  if (e && Date.now() - e.used > 60000) { e.used = Date.now(); scheduleSave(); }
}

// ---------- parts: cache → in-flight fetch → Drive ----------
const inflight = new Map();   // partKey → Promise<ArrayBuffer>
// Loads one part, delivering bytes as they arrive: deliver(chunk, offsetInPart). Cached parts arrive
// in one piece; parts fetched from Drive stream through while being collected for the cache.
async function loadPart(c, id, n, size, type, token, keep, deliver) {
  const key = partKey(id, n);
  const hit = await c.match(key);
  if (hit) { const buf = await hit.arrayBuffer(); if (deliver) deliver(new Uint8Array(buf), 0); return; }
  { const e = (await loadIndex()).files[id]; if (e && e.parts[n]) { e.parts[n] = 0; scheduleSave(); } }   // index said we had it: correct it
  if (inflight.has(key)) { const buf = await inflight.get(key); if (deliver) deliver(new Uint8Array(buf), 0); return; }
  const p = fetchPart(id, n, size, token, deliver).then(async buf => { if (keep) await storePart(id, n, buf, size, type); return buf; });
  inflight.set(key, p);
  p.catch(() => {}).finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
  await p;
}
async function fetchPart(id, n, size, token, deliver) {
  const start = n * PART, end = Math.min(size, start + PART) - 1, want = end - start + 1;
  const res = await fetch(DRIVE + encodeURIComponent(id) + '?alt=media', { headers: { Authorization: 'Bearer ' + token, Range: `bytes=${start}-${end}` } });
  if (res.status !== 206) { const err = new Error('drive ' + res.status); err.status = res.status; try { await res.body.cancel(); } catch (e) { /* ignore */ } throw err; }
  const out = new Uint8Array(want); let got = 0; const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > want) { reader.cancel().catch(() => {}); throw new Error('long part'); }
    out.set(value, got);
    if (deliver) deliver(value, got);
    got += value.length;
  }
  if (got !== want) throw new Error('short part');
  return out.buffer;
}
async function lookup(id, token) {
  try {
    const r = await fetch(DRIVE + encodeURIComponent(id) + '?fields=size,mimeType', { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return { size: 0, type: '' };
    const j = await r.json(); return { size: +j.size || 0, type: j.mimeType || '' };
  } catch (e) { return { size: 0, type: '' }; }
}

// ---------- read-ahead: one lesson at a time, from the playhead forward, wrapping around ----------
let prefetching = null;   // { id, token, size, type, cursor, stop, promise }
function prefetch(id, token, size, type, cursor) {
  if (prefetching && prefetching.id === id && !prefetching.stop) { prefetching.cursor = cursor; prefetching.token = token; return prefetching.promise; }
  if (prefetching) prefetching.stop = true;
  const st = { id, token, size, type, cursor, stop: false };
  st.promise = (async () => {
    if (size > CAP) return;
    const c = await caches.open(MEDIA_CACHE); const total = partsOf(size); let failures = 0;
    for (;;) {
      if (st.stop) return;
      const idx = await loadIndex(); const e = idx.files[id];
      const have = e ? e.parts : [];
      let n = -1;
      for (let k = 0; k < total; k++) { const m = (st.cursor + k) % total; if (!have[m]) { n = m; break; } }
      if (n < 0) return;
      try { await loadPart(c, id, n, size, type, st.token, true, null); failures = 0; }
      catch (err) {
        if (err.status === 401 || err.status === 403 || ++failures > 3) return;
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      // a fetched part that did not get stored means there is no room (cap, quota): stop
      const after = (await loadIndex()).files[id]; if (!after || !after.parts[n]) return;
    }
  })().catch(() => {}).finally(() => { if (prefetching === st) prefetching = null; });
  prefetching = st;
  return st.promise;
}

// ---------- the media response ----------
function parseRange(h, size) {
  if (!h) return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim()); if (!m || (m[1] === '' && m[2] === '')) return { start: 0, end: size - 1, partial: false };   // malformed: ignore the header
  let start, end;
  if (m[1] === '') { const suf = +m[2]; if (!suf) return null; start = Math.max(0, size - suf); end = size - 1; }
  else { start = +m[1]; end = m[2] === '' ? size - 1 : Math.min(+m[2], size - 1); }
  if (start >= size || start > end) return null;
  return { start, end, partial: true };
}
async function serveMedia(e, url) {
  const req = e.request;
  const id = url.searchParams.get('id'), token = url.searchParams.get('t');
  if (!id || !token) return new Response('', { status: 400 });
  const keep = url.searchParams.get('keep') !== '0';
  await verifyCache();
  const idx = await loadIndex(); const entry = idx.files[id];
  let size = +url.searchParams.get('size') || (entry && entry.size) || 0;
  let type = url.searchParams.get('mime') || (entry && entry.type) || '';
  if (!size) { const m = await lookup(id, token); size = m.size; type = type || m.type; }
  if (!size) return passThrough(req, id, token);                 // nothing known about the file: plain relay
  if ((!entry && !keep) || size > CAP) return passThrough(req, id, token);   // caching off and nothing stored, or too big to keep: plain relay
  type = type || 'video/mp4';
  const r = parseRange(req.headers.get('range'), size);
  if (!r) return new Response('', { status: 416, headers: { 'content-range': 'bytes */' + size } });
  const { start, end, partial } = r;
  touch(id);
  if (keep) e.waitUntil(prefetch(id, token, size, type, Math.floor(start / PART)));
  const h = new Headers({ 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'content-length': String(end - start + 1) });
  if (partial) h.set('content-range', `bytes ${start}-${end}/${size}`);
  const body = req.method === 'HEAD' ? null : partStream(id, size, type, token, keep, start, end);
  return new Response(body, { status: partial ? 206 : 200, headers: h });
}
function partStream(id, size, type, token, keep, start, end) {
  let n = Math.floor(start / PART); const last = Math.floor(end / PART); let cancelled = false; let cache = null;
  return new ReadableStream({
    async pull(ctrl) {
      if (cancelled) return;
      if (n > last) { ctrl.close(); return; }
      cache = cache || await caches.open(MEDIA_CACHE);
      const pStart = n * PART;
      const from = Math.max(start, pStart) - pStart, to = Math.min(end, Math.min(size, pStart + PART) - 1) - pStart + 1;
      if (prefetching && prefetching.id === id) prefetching.cursor = n + 1;
      try {
        await loadPart(cache, id, n, size, type, token, keep, (chunk, off) => {
          if (cancelled) return;
          const s = Math.max(off, from), t = Math.min(off + chunk.length, to);
          if (t > s) { try { ctrl.enqueue(chunk.subarray(s - off, t - off)); } catch (err) { cancelled = true; } }
        });
      } catch (err) { if (!cancelled) { cancelled = true; try { ctrl.error(err); } catch (e2) { /* closed */ } } return; }
      n++;
    },
    cancel() { cancelled = true; }
  });
}
// The pre-cache relay: forward the range to Drive and rebuild Content-Range, which Google does not
// expose to cross-origin readers.
async function passThrough(req, id, token) {
  const headers = { Authorization: 'Bearer ' + token };
  const range = req.headers.get('range'); if (range) headers.Range = range;
  try {
    const res = await fetch(DRIVE + encodeURIComponent(id) + '?alt=media', { headers, signal: req.signal });
    const h = new Headers();
    const ct = res.headers.get('content-type'); if (ct) h.set('content-type', ct);
    const cl = res.headers.get('content-length'); if (cl) h.set('content-length', cl);
    h.set('accept-ranges', 'bytes'); h.set('cache-control', 'no-store');
    if (res.status === 206) {
      const m = /bytes=(\d*)-(\d*)/.exec(range || ''); const start = m && m[1] ? +m[1] : 0; const len = cl ? +cl : 0;
      const end = len ? start + len - 1 : (m && m[2] ? +m[2] : 0);
      h.set('content-range', `bytes ${start}-${end}/*`);
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  } catch (err) { return new Response('', { status: 502 }); }
}
