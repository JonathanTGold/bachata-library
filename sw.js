/* DanceLab service worker: caches the app shell, network-first so updates
 * arrive on the next open. Never touches Google API requests. */
const VERSION = 'bl-v11';
// Same-origin virtual path the app uses for video playback. The service worker turns it into an
// authenticated Drive request, because a <video> element cannot send an Authorization header and
// Google no longer accepts the token as a URL parameter.
const MEDIA_PATH = new URL('./media', self.registration.scope).pathname;
const SHELL = ['./', './index.html', './styles.css', './app.js', './gemini.js', './config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin && url.pathname === MEDIA_PATH) { e.respondWith(proxyMedia(e.request, url)); return; }
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      // Revalidate with the server instead of trusting the HTTP cache: GitHub Pages sends a
      // 10-minute max-age, which otherwise lets a fresh index.html pair with a stale stylesheet.
      const net = await fetch(e.request, { cache: 'no-cache' });
      if (net.ok) { const c = await caches.open(VERSION); c.put(e.request, net.clone()); }
      return net;
    } catch (err) {
      const hit = await caches.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      if (e.request.mode === 'navigate') { const shell = await caches.match('./index.html'); if (shell) return shell; }
      throw err;
    }
  })());
});

// Google does not expose Content-Range to cross-origin readers, so it is rebuilt here from the
// requested range, the body length, and the file size (passed by the app, or looked up once).
const sizeCache = new Map();
async function fileSize(id, token) {
  if (sizeCache.has(id)) return sizeCache.get(id);
  try {
    const r = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?fields=size', { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json(); const n = +j.size || 0; if (n) sizeCache.set(id, n); return n;
  } catch (e) { return 0; }
}
async function proxyMedia(req, url) {
  const id = url.searchParams.get('id'), token = url.searchParams.get('t');
  if (!id || !token) return new Response('', { status: 400 });
  const headers = { Authorization: 'Bearer ' + token };
  const range = req.headers.get('range');
  if (range) headers.Range = range;
  try {
    // Forward the player's abort signal: when it seeks elsewhere, the old download from Drive
    // must stop too, or it keeps competing for the phone's bandwidth.
    const res = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media', { headers, signal: req.signal });
    const h = new Headers();
    const ct = res.headers.get('content-type'); if (ct) h.set('content-type', ct);
    const cl = res.headers.get('content-length'); if (cl) h.set('content-length', cl);
    h.set('accept-ranges', 'bytes');
    h.set('cache-control', 'no-store');
    if (res.status === 206) {
      let total = +url.searchParams.get('size') || 0;
      if (!total) total = await fileSize(id, token);
      const m = /bytes=(\d*)-(\d*)/.exec(range || '');
      const start = m && m[1] ? +m[1] : 0;
      const len = cl ? +cl : 0;
      const end = len ? start + len - 1 : (m && m[2] ? +m[2] : Math.max(0, total - 1));
      h.set('content-range', 'bytes ' + start + '-' + end + '/' + (total || '*'));
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  } catch (err) {
    return new Response('', { status: 502 });
  }
}
