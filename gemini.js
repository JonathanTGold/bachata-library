/* Bachata Library · gemini.js
 * Optional video analysis with the Gemini API, entirely in the browser with the user's own
 * API key. Uploads the clip to Gemini's file storage, waits for processing, asks for a title,
 * a description and chapters as structured JSON, then deletes the uploaded copy.
 *
 * Exposes window.GeminiClient = { analyzeVideo(source, opts), DEFAULT_MODEL, GeminiError }.
 *   source: a File/Blob, or a remote descriptor { size, type, name, fetchRange(start, end) -> Blob }
 *           (the video is relayed in chunks, so a large clip never sits in memory as a whole)
 *   opts: { key, model, lang, onProgress({ stage, frac, detail }) }
 *         stage is one of 'upload' | 'process' | 'analyze' | 'retry' | 'fallback'
 *   resolves: { title, desc, chapters: [{ name, t }] }   (t in seconds)
 */
(function () {
'use strict';

const BASE = 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'gemini-3.6-flash';
// Tried in order when the chosen model is overloaded or unavailable.
const FALLBACK_MODELS = ['gemini-3-flash-preview', 'gemini-flash-latest'];
const RETRY_DELAYS_MS = [4000, 12000];
const UPLOAD_CHUNK = 8 * 1024 * 1024; // multiple of 256 KiB, as the upload protocol requires
const PROCESS_POLL_MS = 2000;
const PROCESS_MAX_POLLS = 120; // 4 minutes

const PROMPTS = {
  he: 'נתחו את סרטון סיכום שיעור הריקוד הזה. ענו בעברית.\n' +
      'החזירו: כותרת קצרה (עד 8 מילים); תיאור מפורט שמכסה את הרעיונות המרכזיים, טכניקת התנועה, ' +
      'טיפים להובלה ולמובלים, תרגילים, והכללים שהמורה הדגיש או הדגישה; ו‑3 עד 8 פרקים כלליים, ' +
      'לכל אחד זמן התחלה בפורמט MM:SS וכותרת נושא קצרה.\n' +
      'הכותרת מתארת את תוכן השיעור עצמו, למשל „הלו בובה, שדו רגיל ושדו נגדי”, בלי קידומות כמו „סיכום שיעור” או „שיעור ריקוד”.\n' +
      'השתמשו במונחי הריקוד שהמורה משתמש בהם. אל תמציאו תוכן שלא מופיע בסרטון.',
  en: 'Analyze this dance lesson recap video. Answer in English.\n' +
      'Return: a short title (max 8 words); a detailed description covering the core concepts, ' +
      'movement technique, leading and following tips, exercises, and the rules the instructor stressed; ' +
      'and 3 to 8 broad chapters, each with a start time in MM:SS and a short topic title.\n' +
      'The title names the content itself, for example "Hello Bubba, regular and counter shadow", with no prefix such as "Lesson summary" or "Dance lesson".\n' +
      'Use the dance vocabulary the instructor uses. Do not invent content that is not in the video.'
};

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING', description: 'Short lesson title, at most 8 words' },
    description: { type: 'STRING', description: 'Detailed description of what the lesson covered' },
    chapters: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          start: { type: 'STRING', description: 'Start time as MM:SS' },
          title: { type: 'STRING', description: 'Short topic title' }
        },
        required: ['start', 'title']
      }
    }
  },
  required: ['title', 'description', 'chapters']
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

class GeminiError extends Error {
  constructor(message, status, kind) { super(message); this.status = status; this.kind = kind; }
}
// kind: 'key' | 'quota' | 'busy' | 'model' | 'network' | 'other'
function classify(status, message) {
  const msg = message || '';
  if (status === 400 && /API key/i.test(msg)) return 'key';
  if (status === 401 || status === 403) return 'key';
  if (status === 429 && /quota|exceeded|limit/i.test(msg)) return 'quota';
  if (status === 429 || status === 503 || /high demand|overloaded|try again later/i.test(msg)) return 'busy';
  if (status === 404) return 'model';
  return 'other';
}

async function call(url, key, init = {}) {
  const headers = Object.assign({ 'x-goog-api-key': key }, init.headers || {});
  const res = await fetch(url, Object.assign({}, init, { headers }));
  if (!res.ok) {
    let msg = '';
    try { const j = await res.json(); msg = (j.error && j.error.message) || ''; } catch (e) { /* no body */ }
    throw new GeminiError(msg || ('HTTP ' + res.status), res.status, classify(res.status, msg));
  }
  return res;
}

// Resumable upload: one request opens the session, then the bytes go up in chunks. Each chunk is
// read only when it is sent, so a File is streamed from disk and a remote source is pulled piece
// by piece. This keeps memory flat on phones even for long clips.
async function startUploadSession(size, mime, name, key) {
  const start = await call(`${BASE}/upload/v1beta/files`, key, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: (name || 'lesson').slice(0, 100) } })
  });
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new GeminiError('Upload session not returned by Gemini', 0, 'other');
  return uploadUrl;
}
function sendChunk(uploadUrl, key, offset, chunk, isLast, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl);
    xhr.setRequestHeader('x-goog-api-key', key);
    xhr.setRequestHeader('X-Goog-Upload-Offset', String(offset));
    xhr.setRequestHeader('X-Goog-Upload-Command', isLast ? 'upload, finalize' : 'upload');
    xhr.upload.onprogress = e => { if (onProgress && e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (!isLast) { resolve(null); return; }
        try { resolve(JSON.parse(xhr.responseText).file); } catch (e) { reject(new GeminiError('Unexpected upload response', xhr.status, 'other')); }
      } else {
        let msg = ''; try { msg = JSON.parse(xhr.responseText).error.message; } catch (e) { /* ignore */ }
        reject(new GeminiError(msg || ('Upload failed ' + xhr.status), xhr.status, classify(xhr.status, msg)));
      }
    };
    xhr.onerror = () => reject(new GeminiError('Network error during upload', 0, 'network'));
    xhr.send(chunk);
  });
}
async function uploadSource(source, key, onProgress) {
  const size = source.size;
  if (!size) throw new GeminiError('Video size unknown', 0, 'other');
  const mime = source.type || 'video/mp4';
  const uploadUrl = await startUploadSession(size, mime, source.name, key);
  const getChunk = (start, end) => typeof source.slice === 'function' ? Promise.resolve(source.slice(start, end)) : source.fetchRange(start, end - 1);
  // Two-stage pipeline: while one chunk is being sent, the next one is already being fetched,
  // so a relay from Drive overlaps its download and upload instead of doing them in turn.
  let offset = 0, file = null;
  let next = getChunk(0, Math.min(UPLOAD_CHUNK, size));
  while (offset < size) {
    const end = Math.min(offset + UPLOAD_CHUNK, size);
    const chunk = await next;
    const isLast = end >= size;
    if (!isLast) next = getChunk(end, Math.min(end + UPLOAD_CHUNK, size));
    const result = await sendChunk(uploadUrl, key, offset, chunk, isLast, loaded => onProgress && onProgress(Math.min(1, (offset + loaded) / size)));
    if (isLast) file = result;
    offset = end;
  }
  if (!file || !file.name) throw new GeminiError('Upload did not complete', 0, 'other');
  return file;
}

async function waitUntilActive(fileName, key) {
  for (let i = 0; i < PROCESS_MAX_POLLS; i++) {
    const f = await (await call(`${BASE}/v1beta/${fileName}`, key)).json();
    if (f.state === 'ACTIVE') return f;
    if (f.state === 'FAILED') throw new GeminiError('Gemini could not process this video', 0, 'other');
    await sleep(PROCESS_POLL_MS);
  }
  throw new GeminiError('Video processing timed out', 0, 'other');
}

// Models like to open titles with "lesson summary"; the app's list already says what it is.
const TITLE_PREFIX = /^(?:סיכום|תקציר|תיאור)\s+(?:של\s+)?(?:ה?שיעור|ה?תרגול|ה?אימון)(?:\s+(?:ריקוד|בצ'אטה|בצ׳אטה|באצ'טה|באצ׳טה|סלסה|קיזומבה|זוק))?(?:\s+(?:מס'|מספר)?\s*\d+)?\s*[:\-–—]?\s*|^(?:dance\s+)?(?:lesson|class|practice)\s+(?:summary|recap)(?:\s*#?\d+)?\s*[:\-–—]?\s*/i;
function cleanTitle(t) {
  const orig = String(t || '').trim();
  let out = orig.replace(TITLE_PREFIX, '').trim();
  // "סיכום שיעור ריקוד בצ'אטה" would collapse to one word; then only drop the leading "summary".
  if (out.split(/\s+/).filter(Boolean).length < 2) out = orig.replace(/^(?:סיכום|תקציר|summary)\s+/i, '').trim();
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : orig;
}

function parseTime(s) {
  const parts = String(s || '').trim().split(':').map(x => parseInt(x, 10));
  if (!parts.length || parts.some(isNaN)) return null;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

async function generate(fileUri, mime, key, model, lang) {
  const body = {
    contents: [{ role: 'user', parts: [{ fileData: { fileUri, mimeType: mime } }, { text: PROMPTS[lang] || PROMPTS.en }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.3 }
  };
  const res = await call(`${BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`, key, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const j = await res.json();
  const cand = (j.candidates || [])[0];
  const text = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts.map(p => p.text || '').join('') : '';
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new GeminiError('Gemini returned an unreadable answer', 0, 'other'); }
  return {
    title: cleanTitle(data.title),
    desc: String(data.description || '').trim(),
    chapters: (Array.isArray(data.chapters) ? data.chapters : [])
      .map(c => ({ name: String(c.title || '').trim(), t: parseTime(c.start) }))
      .filter(c => c.name && c.t != null)
      .sort((a, b) => a.t - b.t)
  };
}

async function generateWithRetries(fileUri, mime, key, model, lang, report) {
  const models = [model].concat(FALLBACK_MODELS.filter(m => m !== model));
  let lastErr = null;
  for (let mi = 0; mi < models.length; mi++) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await generate(fileUri, mime, key, models[mi], lang);
      } catch (e) {
        lastErr = e;
        if (e.kind === 'busy' && attempt < RETRY_DELAYS_MS.length) { report('retry', 0, models[mi]); await sleep(RETRY_DELAYS_MS[attempt]); continue; }
        // Each model has its own quota, so an exhausted one is worth a try on the next model too.
        if (e.kind === 'busy' || e.kind === 'model' || e.kind === 'quota') break;
        throw e; // key, network, other: retrying will not help
      }
    }
    if (mi + 1 < models.length) report('fallback', 0, models[mi + 1]);
  }
  throw lastErr;
}

async function deleteFile(fileName, key) {
  try { await call(`${BASE}/v1beta/${fileName}`, key, { method: 'DELETE' }); } catch (e) { /* files expire on their own after 48 hours */ }
}

async function analyzeVideo(source, { key, model, lang, onProgress } = {}) {
  if (!key) throw new GeminiError('Missing API key', 0, 'key');
  const report = (stage, frac, detail) => { if (onProgress) onProgress({ stage, frac, detail }); };
  report('upload', 0);
  const uploaded = await uploadSource(source, key, frac => report('upload', frac));
  try {
    report('process');
    const active = await waitUntilActive(uploaded.name, key);
    report('analyze');
    return await generateWithRetries(active.uri, active.mimeType || source.type || 'video/mp4', key, (model || DEFAULT_MODEL).trim(), lang, report);
  } finally {
    deleteFile(uploaded.name, key);
  }
}

window.GeminiClient = { analyzeVideo, cleanTitle, DEFAULT_MODEL, GeminiError };
})();
