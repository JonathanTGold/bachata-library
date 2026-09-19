/* Bachata Library · app.js
 * A single-user progressive web app. Everything lives in the user's own Google Drive
 * under the drive.file scope: one folder per school or teacher, the video files,
 * small thumbnails, and a library.json index. There is no backend.
 */
(function () {
'use strict';

const CFG = window.BACHATA_CONFIG || {};
const APP_VERSION = '1.0.0';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
// Only the Drive scope. Asking for openid/email alongside it makes Google run its "Sign in with
// Google" flow, which silently drops the Drive scope from the issued token. The account email
// is read from the Drive API instead (about.get), which drive.file allows.
const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const ROOT_NAME = 'Bachata Library';
const INDEX_NAME = 'library.json';
const THUMBS_NAME = '.thumbnails';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const LS = { token: 'bl_token', lib: 'bl_library', clientId: 'bl_client_id', hint: 'bl_login_hint', root: 'bl_root' };
const SS = { state: 'bl_oauth_state', silent: 'bl_silent_tried', needConsent: 'bl_need_consent' };
const CHUNK = 8 * 1024 * 1024; // resumable upload chunk size, a multiple of 256 KiB

// ---------- state ----------
let token = null;            // { access_token, expires_at }
let root = null;             // { id, indexId, thumbsId }
let lib = emptyLib();
let filter = { kind: 'all', value: null };
let query = '';
let current = null;          // lesson shown on the detail screen
let thumbs = {};             // lessonId -> object URL
let thumbLinks = {};         // lessonId -> Drive thumbnailLink (fallback for imported files)
let pending = null;          // file picked in the add form
let editing = null;          // lesson being edited
let formType = 'group';
let uploading = false;
let loopA = null, loopB = null;
let lastSync = 0;
let video, toastTimer;
let blobUrl = null;          // object URL when a video was downloaded whole
let mediaTriedBlob = false;  // fallback already attempted for the current lesson

// ---------- helpers ----------
function emptyLib() { return { version: 1, updatedAt: null, sources: [], lessons: [] }; }
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const qesc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const nowIso = () => new Date().toISOString();
const fmtDate = iso => { const d = new Date(iso + 'T12:00:00'); return isNaN(d) ? (iso || '') : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }); };
const fmtDateLong = iso => { const d = new Date(iso + 'T12:00:00'); return isNaN(d) ? (iso || '') : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };
const monthOf = iso => { const d = new Date(iso + 'T12:00:00'); return isNaN(d) ? 'Unknown date' : d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); };
const fmtDur = s => (s == null || !isFinite(s)) ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const isoDate = d => { const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return x.toISOString().slice(0, 10); };
const shortErr = e => String((e && e.message) || e).slice(0, 160);
const typeBadge = t => t ? `<span class="type ${t}">${t === 'private' ? 'Private' : 'Group'}</span>` : '';
const hue = id => ['', 't2', 't3'][String(id || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 3];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function toast(msg, ms = 3200) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function normalize(d) {
  const out = emptyLib();
  out.updatedAt = d.updatedAt || null;
  out.sources = (d.sources || []).filter(s => s && s.name).map(s => ({ name: String(s.name), kind: s.kind === 'private' ? 'private' : 'school', folderId: s.folderId || null }));
  out.lessons = (d.lessons || []).filter(l => l && l.id).map(l => ({
    id: String(l.id), thumbId: l.thumbId || null, name: l.name || '', date: l.date || '', source: l.source || null,
    type: l.type === 'private' ? 'private' : (l.type === 'group' ? 'group' : null),
    figures: (l.figures || []).map(f => typeof f === 'string' ? { name: f, t: null } : { name: String(f.name || ''), t: (f.t == null ? null : +f.t) }).filter(f => f.name),
    note: l.note || '', duration: l.duration == null ? null : +l.duration, size: l.size == null ? null : +l.size,
    mimeType: l.mimeType || '', createdAt: l.createdAt || null, updatedAt: l.updatedAt || null
  }));
  return out;
}
function sortLessons() { lib.lessons.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || '')); }
function sortSources() { lib.sources.sort((a, b) => a.name.localeCompare(b.name)); }
function persistLocal() { try { localStorage.setItem(LS.lib, JSON.stringify(lib)); } catch (e) { /* storage full or disabled */ } }

// ---------- tiny IndexedDB cache for thumbnails ----------
const idb = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    if (!('indexedDB' in window)) return rej(new Error('no idb'));
    const r = indexedDB.open('bachata-library', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('thumbs');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('thumbs', mode); const req = fn(t.objectStore('thumbs'));
      t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  };
  return {
    get: k => tx('readonly', s => s.get(k)).catch(() => null),
    put: (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => {}),
    del: k => tx('readwrite', s => s.delete(k)).catch(() => {}),
    clear: () => tx('readwrite', s => s.clear()).catch(() => {})
  };
})();

// ---------- auth (OAuth 2.0 implicit flow via redirect; works inside iOS home-screen apps) ----------
function clientId() { return (localStorage.getItem(LS.clientId) || CFG.GOOGLE_CLIENT_ID || '').trim(); }
function redirectUri() { let p = location.pathname.replace(/index\.html$/, ''); if (!p.endsWith('/')) p += '/'; return location.origin + p; }
function tokenValid() { return !!(token && token.access_token && token.expires_at > Date.now()); }
function loadToken() { try { const t = JSON.parse(localStorage.getItem(LS.token)); if (t && t.expires_at > Date.now()) token = t; } catch (e) { token = null; } return token; }

function startAuth({ silent = false } = {}) {
  const id = clientId();
  if (!id) { show('auth'); toast('Add the Google client ID first.'); return false; }
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessionStorage.setItem(SS.state, state);
  const params = new URLSearchParams({ client_id: id, redirect_uri: redirectUri(), response_type: 'token', scope: SCOPES, include_granted_scopes: 'true', state });
  const hint = localStorage.getItem(LS.hint);
  if (hint) params.set('login_hint', hint);
  if (silent) params.set('prompt', 'none');
  else if (sessionStorage.getItem(SS.needConsent) === '1') { params.set('prompt', 'consent'); sessionStorage.removeItem(SS.needConsent); }
  else if (!hint) params.set('prompt', 'select_account');
  location.replace(AUTH_URL + '?' + params.toString());
  return true;
}

// Returns true (signed in), 'error', or false (no auth data in the URL).
function handleRedirect() {
  if (!location.hash || location.hash.length < 2) return false;
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has('access_token') && !h.has('error')) return false;
  history.replaceState(null, '', location.pathname + location.search);
  const expected = sessionStorage.getItem(SS.state); sessionStorage.removeItem(SS.state);
  if (h.get('error')) { console.warn('OAuth error:', h.get('error')); return 'error'; }
  if (expected && h.get('state') !== expected) { toast('Sign-in check failed. Please try again.'); return 'error'; }
  // Google lets users untick individual permissions. Without Drive access the app cannot work.
  const granted = (h.get('scope') || '').split(/[\s+]+/);
  if (granted.length && !granted.some(s => s.endsWith('/auth/drive.file'))) {
    sessionStorage.setItem(SS.needConsent, '1');
    toast('Drive access was not granted. Please sign in again and keep the Google Drive box ticked.', 7000);
    return 'error';
  }
  const ttl = parseInt(h.get('expires_in') || '3600', 10);
  token = { access_token: h.get('access_token'), expires_at: Date.now() + Math.max(60, ttl - 60) * 1000 };
  localStorage.setItem(LS.token, JSON.stringify(token));
  sessionStorage.removeItem(SS.silent);
  return true;
}

async function ensureToken() {
  if (tokenValid()) return token.access_token;
  if (!clientId()) { show('auth'); throw new Error('signed out'); }
  if (sessionStorage.getItem(SS.silent) !== '1' && localStorage.getItem(LS.hint)) {
    sessionStorage.setItem(SS.silent, '1');
    if (startAuth({ silent: true })) await new Promise(() => {}); // page is navigating away
  }
  show('auth'); throw new Error('signed out');
}

function saveClientId(v) {
  v = (v || '').trim();
  if (!/\.apps\.googleusercontent\.com$/.test(v)) { toast('That does not look like a Google client ID.'); return; }
  localStorage.setItem(LS.clientId, v);
  toast('Client ID saved.');
  if (!tokenValid()) startAuth({});
  else renderSettings();
}

function signOut() {
  const t = token && token.access_token;
  token = null; root = null; lib = emptyLib(); thumbs = {}; thumbLinks = {}; current = null;
  [LS.token, LS.lib, LS.root, LS.hint].forEach(k => localStorage.removeItem(k));
  sessionStorage.removeItem(SS.silent);
  idb.clear();
  if (t) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t), { method: 'POST' }).catch(() => {});
  show('auth');
}

async function fetchUserInfo() {
  try { const r = await api('/about', { query: { fields: 'user(emailAddress,displayName)' } }); if (r && r.user && r.user.emailAddress) localStorage.setItem(LS.hint, r.user.emailAddress); }
  catch (e) { console.warn('about.get failed', e); }
}

// ---------- Drive API ----------
async function api(path, { method = 'GET', query, body, headers = {}, raw = false, _retry = true } = {}) {
  const at = await ensureToken();
  const url = new URL(/^https?:/.test(path) ? path : API + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const init = { method, headers: Object.assign({ Authorization: 'Bearer ' + at }, headers) };
  if (body !== undefined) {
    if (body instanceof Blob || typeof body === 'string') init.body = body;
    else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(url.toString(), init);
  if (res.status === 401 && _retry) { token = null; localStorage.removeItem(LS.token); return api(path, { method, query, body, headers, raw, _retry: false }); }
  if (!res.ok) {
    let msg = ''; try { const j = await res.json(); msg = (j.error && j.error.message) || ''; } catch (e) { /* not json */ }
    throw new Error(`Drive error ${res.status}${msg ? ': ' + msg : ''}`);
  }
  if (raw) return res;
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

async function ensureRoot() {
  if (root && root.id && root.indexId && root.thumbsId) return root;
  const found = await api('/files', { query: { q: `appProperties has { key='bachata' and value='root' } and mimeType='${FOLDER_MIME}' and trashed=false`, fields: 'files(id,name)', pageSize: 5 } });
  let folder = found.files && found.files[0];
  if (!folder) folder = await api('/files', { method: 'POST', query: { fields: 'id,name' }, body: { name: ROOT_NAME, mimeType: FOLDER_MIME, appProperties: { bachata: 'root' } } });

  const idxRes = await api('/files', { query: { q: `'${folder.id}' in parents and name='${INDEX_NAME}' and trashed=false`, fields: 'files(id)', pageSize: 5 } });
  let idx = idxRes.files && idxRes.files[0];
  if (!idx) idx = await uploadJson(null, folder.id, INDEX_NAME, lib);

  const thRes = await api('/files', { query: { q: `'${folder.id}' in parents and name='${THUMBS_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`, fields: 'files(id)', pageSize: 5 } });
  let th = thRes.files && thRes.files[0];
  if (!th) th = await api('/files', { method: 'POST', query: { fields: 'id' }, body: { name: THUMBS_NAME, mimeType: FOLDER_MIME, parents: [folder.id], appProperties: { bachata: 'thumbs' } } });

  root = { id: folder.id, indexId: idx.id, thumbsId: th.id };
  localStorage.setItem(LS.root, JSON.stringify(root));
  return root;
}

function multipartBody(meta, payload, payloadType) {
  const boundary = 'blb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${payloadType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  return { body: new Blob([head, payload, tail]), type: `multipart/related; boundary=${boundary}` };
}
async function uploadJson(fileId, parentId, name, obj) {
  const meta = fileId ? {} : { name, parents: [parentId], mimeType: 'application/json', appProperties: { bachata: 'index' } };
  const { body, type } = multipartBody(meta, JSON.stringify(obj), 'application/json');
  return api(fileId ? `${UPLOAD}/${fileId}` : UPLOAD, { method: fileId ? 'PATCH' : 'POST', query: { uploadType: 'multipart', fields: 'id,modifiedTime' }, body, headers: { 'Content-Type': type } });
}
async function uploadBlob(parentId, name, blob, appProperties) {
  const meta = { name, parents: [parentId], mimeType: blob.type || 'image/jpeg', appProperties };
  const { body, type } = multipartBody(meta, blob, meta.mimeType);
  return api(UPLOAD, { method: 'POST', query: { uploadType: 'multipart', fields: 'id' }, body, headers: { 'Content-Type': type } });
}

async function loadLibrary() {
  await ensureRoot();
  const data = await api(`/files/${root.indexId}`, { query: { alt: 'media' } });
  if (data && typeof data === 'object' && Array.isArray(data.lessons)) { lib = normalize(data); sortLessons(); sortSources(); persistLocal(); }
  render();
}
async function saveLibrary() {
  lib.updatedAt = nowIso(); sortLessons(); sortSources(); persistLocal();
  await ensureRoot();
  await uploadJson(root.indexId, null, null, lib);
}

// Lists every lesson file this app created. Adds files missing from the index (uploaded from
// another device, or an upload whose index write failed). Only prunes when asked to.
async function syncFiles({ prune = false } = {}) {
  await ensureRoot();
  const files = []; let pageToken;
  do {
    const r = await api('/files', { query: { q: `appProperties has { key='bachata' and value='lesson' } and trashed=false`, fields: 'nextPageToken,files(id,name,mimeType,size,createdTime,parents,thumbnailLink,appProperties,videoMediaMetadata(durationMillis))', pageSize: 1000, pageToken } });
    files.push(...(r.files || [])); pageToken = r.nextPageToken;
  } while (pageToken);
  thumbLinks = {}; files.forEach(f => { if (f.thumbnailLink) thumbLinks[f.id] = f.thumbnailLink; });

  const ids = new Set(files.map(f => f.id));
  let removed = 0, changed = false;
  if (prune && files.length) { const before = lib.lessons.length; lib.lessons = lib.lessons.filter(l => ids.has(l.id)); removed = before - lib.lessons.length; if (removed) changed = true; }

  const known = new Set(lib.lessons.map(l => l.id));
  const orphans = files.filter(f => !known.has(f.id));
  if (orphans.length) {
    const folderNames = {};
    const pids = [...new Set(orphans.flatMap(f => f.parents || []))].filter(id => id !== root.id);
    for (const id of pids) { try { const f = await api(`/files/${id}`, { query: { fields: 'id,name' } }); folderNames[id] = f.name; } catch (e) { /* folder gone */ } }
    for (const f of orphans) {
      const ap = f.appProperties || {};
      const source = (f.parents || []).map(p => folderNames[p]).find(Boolean) || null;
      const type = ap.type === 'private' ? 'private' : (source ? 'group' : null);
      lib.lessons.push({ id: f.id, thumbId: null, name: f.name, date: ap.date || (f.createdTime || '').slice(0, 10), source, type, figures: [], note: '',
        duration: f.videoMediaMetadata && f.videoMediaMetadata.durationMillis ? Math.round(f.videoMediaMetadata.durationMillis / 1000) : null,
        size: +f.size || null, mimeType: f.mimeType || '', createdAt: f.createdTime || nowIso(), updatedAt: nowIso() });
      if (source) ensureSource(source, type || 'group');
    }
    changed = true;
  }
  if (changed) await saveLibrary();
  render();
  return { added: orphans.length, removed };
}

async function refresh() {
  lastSync = Date.now();
  try { await loadLibrary(); await syncFiles(); }
  catch (e) { if (e.message !== 'signed out') { console.error(e); toast('Could not reach Google Drive. ' + shortErr(e)); } }
}

async function rescan(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }
  try { const r = await syncFiles({ prune: true }); toast(`Done. ${plural(r.added, 'recap')} added, ${r.removed} removed.`); }
  catch (e) { if (e.message !== 'signed out') toast('Rescan failed. ' + shortErr(e)); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Rescan Drive and repair the index'; } }
}

// ---------- thumbnails ----------
async function loadThumb(l, img) {
  if (thumbs[l.id]) { img.src = thumbs[l.id]; img.classList.add('ok'); return; }
  try {
    let blob = await idb.get(l.id);
    if (!blob) {
      if (l.thumbId) { const res = await api(`/files/${l.thumbId}`, { query: { alt: 'media' }, raw: true }); blob = await res.blob(); }
      else if (thumbLinks[l.id]) {
        const at = await ensureToken();
        const res = await fetch(thumbLinks[l.id].replace(/=s\d+(-c)?$/, '=s400'), { headers: { Authorization: 'Bearer ' + at } });
        if (!res.ok) throw new Error('thumb ' + res.status);
        blob = await res.blob();
      }
      if (blob && blob.size) await idb.put(l.id, blob);
    }
    if (blob && blob.size) { thumbs[l.id] = URL.createObjectURL(blob); img.src = thumbs[l.id]; img.classList.add('ok'); }
  } catch (e) { /* keep the colored placeholder */ }
}
function loadThumbs(container) {
  container.querySelectorAll('img[data-thumb]').forEach(img => { const l = lib.lessons.find(x => x.id === img.dataset.thumb); if (l) loadThumb(l, img); });
}

// ---------- upload ----------
function extOf(n) { const m = /\.([a-z0-9]+)$/i.exec(n || ''); return m ? m[1].toLowerCase() : 'mp4'; }
function mimeOf(f) { if (f.type) return f.type; return { mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', mkv: 'video/x-matroska' }[extOf(f.name)] || 'video/mp4'; }

function putChunk(session, chunk, start, end, total, onProgress) {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', session);
    xhr.setRequestHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    xhr.upload.onprogress = e => onProgress && onProgress(e.loaded);
    xhr.onload = () => resolve(xhr);
    xhr.onerror = () => resolve(xhr);
    xhr.ontimeout = () => resolve(xhr);
    xhr.send(chunk);
  });
}
async function queryStatus(session, total) {
  const res = await fetch(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}` } });
  if (res.status === 308) { const range = res.headers.get('Range'); return { offset: range ? parseInt(range.split('-')[1], 10) + 1 : 0 }; }
  if (res.ok) return { done: true, file: await res.json() };
  throw new Error('Upload status check failed: ' + res.status);
}
async function resumableUpload(file, { name, parentId, mime, appProperties, onProgress }) {
  const at = await ensureToken();
  const meta = { name, parents: [parentId], mimeType: mime, appProperties };
  const init = await fetch(`${UPLOAD}?uploadType=resumable&fields=id,name,size,mimeType,videoMediaMetadata`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(file.size) },
    body: JSON.stringify(meta)
  });
  if (init.status === 401) { token = null; localStorage.removeItem(LS.token); await ensureToken(); throw new Error('Session expired. Please try again.'); }
  if (!init.ok) throw new Error('Could not start the upload (' + init.status + ').');
  const session = init.headers.get('Location');
  if (!session) throw new Error('Drive did not return an upload session.');

  let offset = 0, failures = 0;
  while (offset < file.size) {
    const end = Math.min(offset + CHUNK, file.size);
    const xhr = await putChunk(session, file.slice(offset, end), offset, end - 1, file.size, loaded => onProgress && onProgress(Math.min(1, (offset + loaded) / file.size)));
    if (xhr.status === 308) {
      const range = xhr.getResponseHeader('Range');
      offset = range ? parseInt(range.split('-')[1], 10) + 1 : end; failures = 0;
    } else if (xhr.status === 200 || xhr.status === 201) {
      onProgress && onProgress(1);
      return JSON.parse(xhr.responseText);
    } else if (xhr.status === 0 || xhr.status >= 500) {
      if (++failures > 6) throw new Error('Network kept failing during the upload.');
      await new Promise(r => setTimeout(r, 1000 * failures));
      const st = await queryStatus(session, file.size);
      if (st.done) { onProgress && onProgress(1); return st.file; }
      offset = st.offset;
    } else {
      throw new Error('Upload failed (' + xhr.status + ').');
    }
  }
  const st = await queryStatus(session, file.size);
  if (st.done) return st.file;
  throw new Error('Upload did not complete.');
}

// ---------- sources (schools and private teachers) ----------
function ensureSource(name, type) {
  let s = lib.sources.find(x => x.name === name);
  if (!s) { s = { name, kind: type === 'private' ? 'private' : 'school', folderId: null }; lib.sources.push(s); sortSources(); }
  return s;
}
async function ensureSourceFolder(name, type) {
  const s = ensureSource(name, type);
  await ensureRoot();
  if (s.folderId) {
    try { const f = await api(`/files/${s.folderId}`, { query: { fields: 'id,trashed' } }); if (f && !f.trashed) return s.folderId; } catch (e) { /* recreate below */ }
    s.folderId = null;
  }
  const r = await api('/files', { query: { q: `'${root.id}' in parents and name='${qesc(name)}' and mimeType='${FOLDER_MIME}' and trashed=false`, fields: 'files(id)', pageSize: 5 } });
  let f = r.files && r.files[0];
  if (!f) f = await api('/files', { method: 'POST', query: { fields: 'id' }, body: { name, mimeType: FOLDER_MIME, parents: [root.id], appProperties: { bachata: 'folder' } } });
  s.folderId = f.id;
  return f.id;
}
function lastLesson() { return lib.lessons.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0]; }
function lastType() { const l = lastLesson(); return l && l.type; }
function lastSource(kind) { const l = lib.lessons.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).find(x => x.source && x.type === (kind === 'private' ? 'private' : 'group')); return l ? l.source : null; }
function allFigureNames() { const set = new Set(); lib.lessons.forEach(l => l.figures.forEach(f => set.add(f.name))); return [...set].sort((a, b) => a.localeCompare(b)); }
function mergeFigures(oldFigs, newFigs) {
  return newFigs.map(n => { const o = oldFigs.find(f => f.name.toLowerCase() === n.name.toLowerCase()); return { name: n.name, t: o ? o.t : null }; });
}

// ---------- screens ----------
function show(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 's-' + name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.go === name));
  $('tabbar').style.display = (name === 'library' || name === 'schools') ? '' : 'none';
  if (name !== 'detail' && video && !video.paused) video.pause();
  if (name === 'auth') renderAuth();
  if (name === 'library') renderLibrary();
  if (name === 'schools') renderSchools();
  if (name === 'settings') renderSettings();
}
function render() {
  const active = document.querySelector('.screen.active'); const id = active ? active.id : '';
  if (id === 's-library') renderLibrary(); else if (id === 's-schools') renderSchools(); else if (id === 's-settings') renderSettings(); else if (id === 's-detail' && current) renderDetail();
}

function renderAuth() {
  const has = !!clientId();
  $('setup').hidden = has;
  $('btn-signin').hidden = !has;
  $('auth-hint').hidden = !has;
  $('setup-origin').textContent = location.origin;
  $('setup-redirect').textContent = redirectUri();
}

// Library
function renderChips() {
  const untagged = lib.lessons.filter(l => !l.source).length;
  const chip = (label, kind, value, cls = '') => `<button class="chip ${cls} ${filter.kind === kind && filter.value === value ? 'on' : ''}" data-kind="${kind}" data-value="${esc(value == null ? '' : value)}">${esc(label)}</button>`;
  let h = chip('All', 'all', null);
  if (untagged) h += chip(`Untagged · ${untagged}`, 'untagged', null, 'warn');
  lib.sources.filter(s => s.kind === 'school').forEach(s => { h += chip(s.name, 'source', s.name); });
  lib.sources.filter(s => s.kind === 'private').forEach(s => { h += chip(s.name, 'source', s.name, 'priv'); });
  $('chips').innerHTML = h;
}
function visibleLessons() {
  let items = lib.lessons.slice();
  if (filter.kind === 'untagged') items = items.filter(l => !l.source);
  if (filter.kind === 'source') items = items.filter(l => l.source === filter.value);
  const q = query.trim().toLowerCase();
  if (q) items = items.filter(l => [l.source, l.note, l.date, l.type, l.name, ...l.figures.map(f => f.name)].filter(Boolean).some(v => String(v).toLowerCase().includes(q)));
  return items;
}
function renderLibrary() {
  renderChips();
  const nS = lib.sources.filter(s => s.kind === 'school').length, nP = lib.sources.filter(s => s.kind === 'private').length;
  $('lib-sub').textContent = lib.lessons.length ? `${plural(lib.lessons.length, 'recap')} · ${plural(nS, 'school')} · ${plural(nP, 'private teacher')}` : 'No recaps yet';
  const items = visibleLessons();
  if (!items.length) {
    $('list').innerHTML = `<div class="empty">${lib.lessons.length ? 'Nothing matches.' : '<b>No recaps yet.</b><br>Tap + to add the first one. It uploads to a “Bachata Library” folder in your Google Drive.'}</div>`;
    return;
  }
  let h = '', last = '';
  for (const l of items) {
    const m = monthOf(l.date); if (m !== last) { h += `<div class="month">${esc(m)}</div>`; last = m; }
    const figs = l.figures.map(f => f.name);
    const title = figs.length ? figs.slice(0, 2).join(' · ') : (l.source ? `${l.source} recap` : 'Untagged recap');
    const who = l.source ? `${l.source} · ${fmtDate(l.date)}` : `Recorded ${fmtDate(l.date)} · tap to tag`;
    const badges = l.source ? typeBadge(l.type) + figs.slice(0, 2).map(f => `<span class="tag">${esc(f)}</span>`).join('') : '<span class="tag">Needs school &amp; figures</span>';
    h += `<div class="card ${l.source ? '' : 'untagged'}" data-id="${esc(l.id)}">
      <div class="thumb ${hue(l.id)}"><img data-thumb="${esc(l.id)}" alt=""><div class="play"></div>${l.duration ? `<div class="dur">${fmtDur(l.duration)}</div>` : ''}</div>
      <div class="meta"><div class="title">${esc(title)}</div><div class="who">${esc(who)}</div><div class="badges">${badges}</div></div></div>`;
  }
  $('list').innerHTML = h;
  loadThumbs($('list'));
}

// Lesson detail
async function openDetail(id) {
  const l = lib.lessons.find(x => x.id === id); if (!l) return;
  current = l; loopReset(); setRate(1);
  video.classList.remove('mirror'); $('btn-mirror').classList.remove('on');
  show('detail'); renderDetail();
  loadMedia(l);
}

// Playback. A <video> element cannot send an Authorization header, and Google rejects the token as a
// URL parameter for media. Route 1: a same-origin virtual URL that the service worker turns into an
// authenticated, range-preserving Drive request (true streaming). Route 2, if the service worker is
// not controlling the page or the media request fails: download the file with fetch() and play it
// from a blob, showing progress. Recaps are short, so this stays practical.
async function loadMedia(l) {
  setVideoLoading('');
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  video.removeAttribute('src'); video.load();
  mediaTriedBlob = false;
  let at;
  try { at = await ensureToken(); } catch (e) { return; }
  video.poster = thumbs[l.id] || '';
  const viaWorker = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;
  if (viaWorker) {
    const u = new URL('./media', location.href);
    u.searchParams.set('id', l.id); u.searchParams.set('t', at);
    video.src = u.toString(); video.load();
  } else {
    loadViaBlob(l, at);
  }
}
async function loadViaBlob(l, at) {
  if (mediaTriedBlob) return;
  mediaTriedBlob = true;
  const id = l.id;
  try {
    setVideoLoading('Loading video…');
    const res = await fetch(`${API}/files/${encodeURIComponent(id)}?alt=media`, { headers: { Authorization: 'Bearer ' + at } });
    if (!res.ok) throw new Error('Drive error ' + res.status);
    const total = +res.headers.get('content-length') || l.size || 0;
    const reader = res.body.getReader(); const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!current || current.id !== id) { reader.cancel().catch(() => {}); setVideoLoading(''); return; }
      chunks.push(value); got += value.length;
      if (total) setVideoLoading(`Loading video… ${Math.min(99, Math.round(got / total * 100))}%`);
    }
    if (!current || current.id !== id) return;
    const blob = new Blob(chunks, { type: res.headers.get('content-type') || l.mimeType || 'video/mp4' });
    blobUrl = URL.createObjectURL(blob);
    video.src = blobUrl; video.load();
    setVideoLoading('');
  } catch (e) {
    setVideoLoading('');
    if (e.message !== 'signed out') toast('Could not load this video. ' + shortErr(e), 5000);
  }
}
function setVideoLoading(msg) { const el = $('vload'); el.textContent = msg; el.hidden = !msg; }
function renderDetail() {
  const l = current; if (!l) return;
  const figs = l.figures;
  const title = figs.length ? figs.map(f => f.name).join(' · ') : (l.source ? `${l.source} recap` : 'Untagged recap');
  const who = `${l.source || 'Untagged'} · ${fmtDateLong(l.date)}`;
  $('detail-body').innerHTML = `
    <div class="section"><div class="headline"><div><div class="title">${esc(title)}</div><div class="who" style="margin-top:4px">${esc(who)} ${typeBadge(l.type)}</div></div><button class="link" data-action="edit">Edit</button></div></div>
    <div class="section"><h3>Figures in this recap</h3>
      ${figs.map((f, i) => `<div class="fig" data-fig="${i}"><span class="fname">${esc(f.name)}</span><span class="fright">${f.t != null ? `<span class="t">${fmtDur(f.t)}</span>` : '<span class="t dim">no time</span>'}<button class="x" data-remove="${i}" aria-label="Remove figure">×</button></span></div>`).join('')}
      <div class="fig add" id="mark-row"><span>+ Mark a figure at the current time</span></div>
      <div class="markwrap" id="mark-wrap" hidden><div class="input"><input id="mark-name" placeholder="Figure name" list="fig-names" autocomplete="off"><button class="mini" id="mark-add">Add</button></div><datalist id="fig-names">${allFigureNames().map(n => `<option value="${esc(n)}">`).join('')}</datalist></div>
    </div>
    <div class="section"><h3>Notes</h3><div class="note">${l.note ? esc(l.note).replace(/\n/g, '<br>') : '<span class="dim">No notes. Tap Edit to add what to practice.</span>'}</div></div>
    <div class="section"><h3>Stored in</h3><div class="note">Google Drive › ${esc(ROOT_NAME)}${l.source ? ' › ' + esc(l.source) : ''} › ${esc(l.name)}<br><a class="ext" href="https://drive.google.com/file/d/${encodeURIComponent(l.id)}/view" target="_blank" rel="noopener">Open in Drive</a></div></div>`;
}
function onDetailClick(e) {
  if (!current) return;
  const rm = e.target.closest('[data-remove]');
  if (rm) { e.stopPropagation(); const i = +rm.dataset.remove; const f = current.figures[i]; if (!f) return; current.figures.splice(i, 1); current.updatedAt = nowIso(); renderDetail(); saveLibrary().then(() => toast(`Removed “${f.name}”.`)).catch(err => toast('Could not save. ' + shortErr(err))); return; }
  if (e.target.closest('[data-action="edit"]')) { openAdd(current.id); return; }
  if (e.target.closest('#mark-row')) { $('mark-wrap').hidden = false; $('mark-name').focus(); if (!video.paused) video.pause(); return; }
  if (e.target.closest('#mark-add')) { submitMark(); return; }
  const row = e.target.closest('.fig[data-fig]');
  if (row) { const f = current.figures[+row.dataset.fig]; if (f && f.t != null) { video.currentTime = f.t; video.play().catch(() => {}); } }
}
function submitMark() {
  const name = ($('mark-name').value || '').trim(); if (!name) { toast('Type the figure name.'); return; }
  const t = Math.round((video.currentTime || 0) * 10) / 10;
  const ex = current.figures.find(f => f.name.toLowerCase() === name.toLowerCase());
  if (ex) ex.t = t; else current.figures.push({ name, t });
  current.figures.sort((a, b) => (a.t == null ? 1e9 : a.t) - (b.t == null ? 1e9 : b.t));
  current.updatedAt = nowIso();
  renderDetail();
  saveLibrary().then(() => toast(`“${name}” marked at ${fmtDur(t)}.`)).catch(err => toast('Could not save. ' + shortErr(err)));
}
function setRate(r) { video.playbackRate = r; document.querySelectorAll('.ctl[data-rate]').forEach(b => b.classList.toggle('on', parseFloat(b.dataset.rate) === r)); }
function loopStep() {
  const b = $('btn-loop');
  if (loopA === null) { loopA = video.currentTime; b.textContent = `A ${fmtDur(loopA)} · tap for B`; b.classList.add('on'); }
  else if (loopB === null) { loopB = Math.max(video.currentTime, loopA + 0.5); b.textContent = `Loop ${fmtDur(loopA)}–${fmtDur(loopB)} · tap to clear`; video.currentTime = loopA; video.play().catch(() => {}); }
  else loopReset();
}
function loopReset() { loopA = loopB = null; const b = $('btn-loop'); b.textContent = 'Loop A–B'; b.classList.remove('on'); }

// Add / edit form
function openAdd(id) {
  if (uploading) { toast('Wait for the current upload to finish.'); return; }
  editing = id ? (lib.lessons.find(l => l.id === id) || null) : null;
  if (pending && pending.url) URL.revokeObjectURL(pending.url);
  pending = null; $('f-file').value = ''; $('f-file').disabled = !!editing;
  const pick = $('pick');
  pick.classList.toggle('picked', !!editing); pick.classList.toggle('locked', !!editing);
  pick.querySelectorAll('img').forEach(i => i.remove());
  pick.querySelector('.txt').innerHTML = editing
    ? `<b>${esc(editing.name)}</b><span>${editing.duration ? fmtDur(editing.duration) + ' · ' : ''}already in Drive</span>`
    : '<b>Choose a video</b><span>Photo Library, Files, or record now</span>';
  if (editing && thumbs[editing.id]) { const img = document.createElement('img'); img.src = thumbs[editing.id]; img.alt = ''; pick.prepend(img); }
  $('add-title').textContent = editing ? (editing.source ? 'Edit lesson' : 'Tag this recap') : 'Add lesson';
  $('add-sub').textContent = editing ? 'Changes are saved to the index in your Drive.' : 'Pick the recap, tag it, done.';
  $('f-date').value = editing && editing.date ? editing.date : isoDate(new Date());
  formType = (editing && editing.type) || lastType() || 'group';
  setTypeUI();
  fillSources(editing ? editing.source : lastSource(formType));
  $('f-figs').value = editing ? editing.figures.map(f => f.name).join(', ') : '';
  $('f-note').value = editing ? editing.note : '';
  $('btn-save').textContent = editing ? 'Save changes' : 'Save & upload to Drive';
  $('btn-save').disabled = false;
  $('prog').style.display = 'none'; $('prog').querySelector('i').style.width = '0'; $('prog-hint').textContent = '';
  const del = $('btn-delete'); del.hidden = !editing; del.disabled = false; del.textContent = 'Delete this recap'; del.dataset.armed = '';
  show('add');
}
function setTypeUI() { document.querySelectorAll('#f-type button').forEach(b => b.classList.toggle('on', b.dataset.type === formType)); }
function fillSources(selected) {
  const kind = formType === 'private' ? 'private' : 'school';
  const opts = lib.sources.filter(s => s.kind === kind);
  const sel = $('f-source');
  sel.innerHTML = opts.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('')
    + `<option value="__new__">+ New ${kind === 'private' ? 'teacher' : 'school'}…</option>`
    + '<option value="">Leave untagged for now</option>';
  if (selected && opts.some(s => s.name === selected)) sel.value = selected;
  else if (opts.length) sel.value = opts[0].name;
  else sel.value = '__new__';
  $('f-source-label').textContent = kind === 'private' ? 'Teacher' : 'School';
  $('f-source-hint').textContent = kind === 'private' ? 'Private lessons are filed under the teacher’s name instead of a school.' : '';
  onSourceChange();
}
function onSourceChange() { const isNew = $('f-source').value === '__new__'; $('f-new-wrap').hidden = !isNew; if (!isNew) $('f-new').value = ''; }

function fileChosen(input) {
  const f = input.files && input.files[0]; if (!f) return;
  if (pending && pending.url) URL.revokeObjectURL(pending.url);
  const url = URL.createObjectURL(f);
  const when = new Date(f.lastModified || Date.now());
  pending = { file: f, url, when, duration: null, poster: null };
  const mb = (f.size / 1048576).toFixed(f.size > 100 * 1048576 ? 0 : 1);
  const pick = $('pick'); pick.classList.add('picked'); pick.querySelectorAll('img').forEach(i => i.remove());
  pick.querySelector('.txt').innerHTML = `<b>${esc(f.name)}</b><span>${mb} MB · reading…</span>`;
  if (!editing) $('f-date').value = isoDate(when);
  const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true; v.playsInline = true; v.src = url;
  v.onloadedmetadata = () => {
    pending.duration = isFinite(v.duration) ? v.duration : null;
    pick.querySelector('.txt').innerHTML = `<b>${esc(f.name)}</b><span>${mb} MB${pending.duration ? ' · ' + fmtDur(pending.duration) : ''}</span>`;
    try { v.currentTime = Math.min(1, (v.duration || 2) / 2); } catch (e) { /* no seek */ }
  };
  v.onseeked = () => {
    try {
      const max = 640, r = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * r); c.height = Math.round(v.videoHeight * r);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.toBlob(b => { if (b && pending && pending.file === f) { pending.poster = b; const img = document.createElement('img'); img.src = URL.createObjectURL(b); img.alt = ''; pick.prepend(img); } }, 'image/jpeg', 0.72);
    } catch (e) { /* no poster */ }
  };
  v.onerror = () => { pick.querySelector('.txt').innerHTML = `<b>${esc(f.name)}</b><span>${mb} MB · preview unavailable</span>`; };
}

function readForm() {
  const date = $('f-date').value || isoDate(new Date());
  let source = $('f-source').value, isNew = false;
  if (source === '__new__') { source = $('f-new').value.trim(); isNew = true; }
  if (!source) source = null;
  const figures = $('f-figs').value.split(',').map(s => s.trim()).filter(Boolean).map(n => ({ name: n, t: null }));
  return { date, source, isNew, figures, note: $('f-note').value.trim() };
}
function setProgress(frac) {
  const p = $('prog'); p.style.display = 'block'; p.querySelector('i').style.width = Math.round(frac * 100) + '%';
  $('prog-hint').textContent = frac < 1 ? `Uploading… ${Math.round(frac * 100)}% · keep the app open` : 'Finishing…';
}
async function saveLesson() {
  if (uploading) return;
  const form = readForm();
  if (!editing && !pending) { toast('Pick a video first.'); return; }
  if (form.isNew && !form.source) { toast(`Type the ${formType === 'private' ? 'teacher' : 'school'} name.`); return; }
  uploading = true; $('btn-save').disabled = true; $('btn-delete').disabled = true;
  try {
    await ensureRoot();
    const type = form.source ? formType : null;
    if (editing) {
      // Move or rename the file in Drive first; only touch the local record once that succeeded.
      const l = editing;
      const next = { date: form.date, source: form.source, type, figures: mergeFigures(l.figures, form.figures), note: form.note };
      const moved = l.source !== next.source || l.date !== next.date;
      if (moved) next.name = await moveLesson(Object.assign({}, l, next));
      if (form.source) ensureSource(form.source, formType);
      Object.assign(l, next, { updatedAt: nowIso() });
      await saveLibrary();
      toast('Saved.');
      const back = l; resetForm(); openDetail(back.id);
    } else {
      $('btn-save').textContent = 'Uploading…';
      const f = pending.file, mime = mimeOf(f);
      const parentId = form.source ? await ensureSourceFolder(form.source, formType) : root.id;
      const name = `${form.date} ${form.source || 'Untagged'}.${extOf(f.name)}`;
      const file = await resumableUpload(f, { name, parentId, mime, appProperties: { bachata: 'lesson', date: form.date, type: type || '' }, onProgress: setProgress });
      const l = { id: file.id, thumbId: null, name: file.name || name, date: form.date, source: form.source, type, figures: form.figures, note: form.note,
        duration: pending.duration != null ? Math.round(pending.duration) : (file.videoMediaMetadata && file.videoMediaMetadata.durationMillis ? Math.round(file.videoMediaMetadata.durationMillis / 1000) : null),
        size: +file.size || f.size, mimeType: file.mimeType || mime, createdAt: nowIso(), updatedAt: nowIso() };
      if (pending.poster) {
        try { const t = await uploadBlob(root.thumbsId, `${file.id}.jpg`, pending.poster, { bachata: 'thumb', lesson: file.id }); l.thumbId = t.id; thumbs[l.id] = URL.createObjectURL(pending.poster); idb.put(l.id, pending.poster); }
        catch (e) { console.warn('thumbnail upload failed', e); }
      }
      lib.lessons.unshift(l);
      await saveLibrary();
      toast(form.source ? 'Uploaded to Drive.' : 'Uploaded. It is waiting under Untagged.');
      resetForm(); show('library');
    }
  } catch (e) {
    console.error(e);
    if (e.message !== 'signed out') { toast('Save failed. ' + shortErr(e), 6000); $('prog-hint').textContent = 'Something went wrong. Nothing was lost; try again.'; }
  } finally {
    uploading = false; $('btn-save').disabled = false; $('btn-delete').disabled = false;
    $('btn-save').textContent = editing ? 'Save changes' : 'Save & upload to Drive';
  }
}
function resetForm() { if (pending && pending.url) URL.revokeObjectURL(pending.url); pending = null; editing = null; $('f-file').value = ''; }
async function moveLesson(l) {
  const newParent = l.source ? await ensureSourceFolder(l.source, l.type || 'group') : root.id;
  const cur = await api(`/files/${l.id}`, { query: { fields: 'parents,name' } });
  const oldParents = (cur.parents || []).filter(p => p !== newParent);
  const newName = `${l.date} ${l.source || 'Untagged'}.${extOf(l.name || cur.name)}`;
  const upd = await api(`/files/${l.id}`, { method: 'PATCH', query: { addParents: newParent, removeParents: oldParents.join(','), fields: 'id,name' }, body: { name: newName, appProperties: { bachata: 'lesson', date: l.date, type: l.type || '' } } });
  return (upd && upd.name) || newName;
}
async function deleteLesson() {
  const b = $('btn-delete'); const l = editing; if (!l || uploading) return;
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1'; b.textContent = 'Tap again to move it to the Drive trash';
    setTimeout(() => { if (b.dataset.armed === '1') { b.dataset.armed = ''; b.textContent = 'Delete this recap'; } }, 4000);
    return;
  }
  b.disabled = true; $('btn-save').disabled = true;
  try {
    await api(`/files/${l.id}`, { method: 'PATCH', body: { trashed: true } });
    if (l.thumbId) api(`/files/${l.thumbId}`, { method: 'PATCH', body: { trashed: true } }).catch(() => {});
    lib.lessons = lib.lessons.filter(x => x.id !== l.id);
    await saveLibrary(); idb.del(l.id); delete thumbs[l.id];
    toast('Moved to the Drive trash.'); resetForm(); current = null; show('library');
  } catch (e) { if (e.message !== 'signed out') toast('Delete failed. ' + shortErr(e)); }
  finally { b.disabled = false; $('btn-save').disabled = false; }
}

// Schools
function renderSchools() {
  const row = s => {
    const ls = lib.lessons.filter(l => l.source === s.name); const last = ls.map(l => l.date).sort().pop();
    return `<div class="trow" data-source="${esc(s.name)}"><div><div class="n">${esc(s.name)}</div><div class="s">${s.kind === 'private' ? 'Private teacher' : 'Group classes'}</div></div>
      <div class="count">${plural(ls.length, 'recap')}<br>${last ? 'last ' + esc(fmtDate(last)) : `<button class="link small" data-remove-source="${esc(s.name)}">Remove</button>`}</div></div>`;
  };
  const schools = lib.sources.filter(s => s.kind === 'school'), priv = lib.sources.filter(s => s.kind === 'private');
  $('schools').innerHTML = `<div class="month">Schools</div>${schools.map(row).join('') || '<div class="empty small">No schools yet.</div>'}
    <div class="month">Private teachers</div>${priv.map(row).join('') || '<div class="empty small">No private teachers yet.</div>'}
    <div class="month">Add</div>
    <div class="seg" id="src-kind"><button type="button" class="on" data-kind="school">School</button><button type="button" data-kind="private">Private teacher</button></div>
    <div class="input" style="margin-top:8px"><input id="src-name" placeholder="Name" autocomplete="off"><button class="mini" id="src-add">Add</button></div>
    <div class="hint">Schools and teachers also appear automatically when you tag a recap.</div>`;
}
function onSchoolsClick(e) {
  const rs = e.target.closest('[data-remove-source]');
  if (rs) { e.stopPropagation(); removeSource(rs.dataset.removeSource); return; }
  const kb = e.target.closest('#src-kind button');
  if (kb) { document.querySelectorAll('#src-kind button').forEach(b => b.classList.toggle('on', b === kb)); return; }
  if (e.target.closest('#src-add')) { addSource(); return; }
  const row = e.target.closest('.trow[data-source]');
  if (row) { filter = { kind: 'source', value: row.dataset.source }; show('library'); }
}
function addSource() {
  const name = ($('src-name').value || '').trim(); if (!name) { toast('Type a name.'); return; }
  const kindBtn = document.querySelector('#src-kind button.on'); const kind = kindBtn ? kindBtn.dataset.kind : 'school';
  if (lib.sources.some(s => s.name.toLowerCase() === name.toLowerCase())) { toast('Already in the list.'); return; }
  ensureSource(name, kind === 'private' ? 'private' : 'group');
  renderSchools();
  saveLibrary().then(() => toast(`Added ${name}.`)).catch(err => toast('Could not save. ' + shortErr(err)));
}
function removeSource(name) {
  if (lib.lessons.some(l => l.source === name)) { toast('Move or delete its recaps first.'); return; }
  lib.sources = lib.sources.filter(s => s.name !== name);
  if (filter.kind === 'source' && filter.value === name) filter = { kind: 'all', value: null };
  renderSchools();
  saveLibrary().then(() => toast(`Removed ${name}.`)).catch(err => toast('Could not save. ' + shortErr(err)));
}

// Settings
function renderSettings() {
  const email = localStorage.getItem(LS.hint) || '';
  $('set-sub').textContent = email ? `Signed in as ${email}` : 'Signed in';
  $('settings-body').innerHTML = `
    <div class="section"><h3>Storage</h3><div class="note">Everything lives in a folder called <b>${esc(ROOT_NAME)}</b> in your Google Drive: one subfolder per school or teacher, the videos, and a small index file.${root ? `<br><a class="ext" href="https://drive.google.com/drive/folders/${encodeURIComponent(root.id)}" target="_blank" rel="noopener">Open the folder in Drive</a>` : ''}</div></div>
    <div class="section"><h3>Maintenance</h3><button class="secondary" id="btn-rescan">Rescan Drive and repair the index</button><div class="hint">Adds recaps uploaded from another device or missing from this list, and removes entries whose files were deleted in Drive.</div></div>
    <div class="section"><h3>Account</h3><button class="secondary" id="btn-signout">Sign out</button><div class="hint">Signs out on this device only. Nothing in Drive is touched.</div></div>
    <div class="section"><h3>Advanced</h3><label class="lbl" for="set-client">Google OAuth client ID</label><div class="input"><input id="set-client" value="${esc(clientId())}" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="…apps.googleusercontent.com"></div><button class="secondary" id="btn-save-client2" style="margin-top:8px">Save client ID</button><div class="hint">Only needed if you run your own copy of this app.</div></div>
    <div class="section"><div class="hint">Bachata Library ${APP_VERSION}</div></div>`;
}

// ---------- events and boot ----------
function bindEvents() {
  $('btn-signin').addEventListener('click', () => startAuth({}));
  $('btn-save-client').addEventListener('click', () => saveClientId($('setup-client').value));
  $('btn-settings').addEventListener('click', () => show('settings'));
  $('btn-settings-back').addEventListener('click', () => show('library'));
  $('btn-back').addEventListener('click', () => show('library'));
  $('btn-add').addEventListener('click', () => openAdd(null));
  $('btn-cancel').addEventListener('click', () => { if (uploading) { toast('Upload in progress. Wait for it to finish.'); return; } const back = editing; resetForm(); if (back && back.source) openDetail(back.id); else show('library'); });
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => show(t.dataset.go)));
  $('search').addEventListener('input', e => { query = e.target.value; renderLibrary(); });
  $('chips').addEventListener('click', e => { const c = e.target.closest('.chip'); if (!c) return; filter = { kind: c.dataset.kind, value: c.dataset.kind === 'source' ? c.dataset.value : null }; renderLibrary(); });
  $('list').addEventListener('click', e => { const card = e.target.closest('.card'); if (!card) return; const l = lib.lessons.find(x => x.id === card.dataset.id); if (!l) return; if (!l.source) openAdd(l.id); else openDetail(l.id); });

  document.querySelectorAll('.ctl[data-rate]').forEach(b => b.addEventListener('click', () => setRate(parseFloat(b.dataset.rate))));
  $('btn-mirror').addEventListener('click', () => { video.classList.toggle('mirror'); $('btn-mirror').classList.toggle('on'); });
  $('btn-loop').addEventListener('click', loopStep);
  video.addEventListener('timeupdate', () => { if (loopB !== null && video.currentTime > loopB) video.currentTime = loopA; });
  video.addEventListener('error', () => {
    if (!current) return;
    const src = video.getAttribute('src') || '';
    if (src && !src.startsWith('blob:') && !mediaTriedBlob && tokenValid()) { loadViaBlob(current, token.access_token); return; }
    toast('Could not play this video. It may use a format this browser cannot decode.', 5000);
  });
  $('detail-body').addEventListener('click', onDetailClick);
  $('detail-body').addEventListener('keydown', e => { if (e.target.id === 'mark-name' && e.key === 'Enter') { e.preventDefault(); submitMark(); } });

  $('f-file').addEventListener('change', e => fileChosen(e.target));
  $('f-type').addEventListener('click', e => { const b = e.target.closest('button[data-type]'); if (!b) return; formType = b.dataset.type; setTypeUI(); fillSources(lastSource(formType)); });
  $('f-source').addEventListener('change', onSourceChange);
  $('btn-save').addEventListener('click', saveLesson);
  $('btn-delete').addEventListener('click', deleteLesson);

  $('schools').addEventListener('click', onSchoolsClick);
  $('schools').addEventListener('keydown', e => { if (e.target.id === 'src-name' && e.key === 'Enter') { e.preventDefault(); addSource(); } });
  $('settings-body').addEventListener('click', e => { const id = e.target.id; if (id === 'btn-rescan') rescan(e.target); else if (id === 'btn-signout') signOut(); else if (id === 'btn-save-client2') saveClientId($('set-client').value); });

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && tokenValid() && Date.now() - lastSync > 60000) refresh(); });
  window.addEventListener('beforeunload', e => { if (uploading) { e.preventDefault(); e.returnValue = ''; } });
}

async function boot() {
  video = $('video');
  bindEvents();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
  const r = handleRedirect();
  loadToken();
  try { const cached = JSON.parse(localStorage.getItem(LS.lib)); if (cached && Array.isArray(cached.lessons)) { lib = normalize(cached); sortLessons(); sortSources(); } } catch (e) { /* no cache */ }
  try { root = JSON.parse(localStorage.getItem(LS.root)) || null; } catch (e) { root = null; }

  if (tokenValid()) {
    show('library');
    if (r === true || !localStorage.getItem(LS.hint)) await fetchUserInfo();
    refresh();
  } else if (r !== 'error' && clientId() && localStorage.getItem(LS.hint) && sessionStorage.getItem(SS.silent) !== '1') {
    sessionStorage.setItem(SS.silent, '1');
    if (!startAuth({ silent: true })) show('auth');
  } else {
    if (r === 'error' && localStorage.getItem(LS.hint)) toast('Please sign in again.');
    show('auth');
  }
}

document.addEventListener('DOMContentLoaded', boot);
})();
