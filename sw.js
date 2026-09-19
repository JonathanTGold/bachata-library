/* Bachata Library service worker: caches the app shell, network-first so updates
 * arrive on the next open. Never touches Google API requests. */
const VERSION = 'bl-v2';
// Same-origin virtual path the app uses for video playback. The service worker turns it into an
// authenticated Drive request, because a <video> element cannot send an Authorization header and
// Google no longer accepts the token as a URL parameter.
const MEDIA_PATH = new URL('./media', self.registration.scope).pathname;
const SHELL = ['./', './index.html', './styles.css', './app.js', './config.js', './manifest.webmanifest',
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
      const net = await fetch(e.request);
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

async function proxyMedia(req, url) {
  const id = url.searchParams.get('id'), token = url.searchParams.get('t');
  if (!id || !token) return new Response('', { status: 400 });
  const headers = { Authorization: 'Bearer ' + token };
  const range = req.headers.get('range');
  if (range) headers.Range = range;
  try {
    const res = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media', { headers });
    const h = new Headers();
    for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) { const v = res.headers.get(k); if (v) h.set(k, v); }
    if (!h.has('accept-ranges')) h.set('accept-ranges', 'bytes');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  } catch (err) {
    return new Response('', { status: 502 });
  }
}
