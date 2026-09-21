/* DanceLab · gemini.js
 * Optional video analysis with the Gemini API, entirely in the browser with the user's own
 * API key. Uploads the clip to Gemini's file storage, waits for processing, asks for a title,
 * a description and chapters as structured JSON, then deletes the uploaded copy.
 *
 * Exposes window.GeminiClient = { analyzeVideo(source, opts), DEFAULT_MODEL, GeminiError }.
 *   source: a File/Blob, or a remote descriptor { size, type, name, fetchRange(start, end) -> Blob }
 *           (the video is relayed in chunks, so a large clip never sits in memory as a whole)
 *   opts: { key, model, lang, tags: [{ key, label, hint }], onProgress({ stage, frac, detail }) }
 *         stage is one of 'upload' | 'process' | 'analyze' | 'retry' | 'fallback'
 *   resolves: { title, desc, tags: [key], chapters: [{ name, t }] }   (t in seconds)
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

// Canonical dance vocabulary. The model hears Hebrew-accented English terms and otherwise invents a
// phonetic spelling each time ("אנגלוק", "אמלוק", "אמנלוק" for hammerlock). The prompt shows the
// accepted spellings, and normalizeTerms() below repairs the common mistakes deterministically.
const LEXICON = [
  { he: 'האמרלוק', en: 'hammerlock', alt: ['אנגלוק', 'אמלוק', 'אמנלוק', 'המרלוק', 'אמרלוק', 'ארמלוק', 'ארם לוק', 'הנגלוק', 'האנגלוק', 'האנגלון', 'אנגלון'] },
  { he: 'שדו', en: 'shadow position', alt: ['שאדו', 'שאדוו', 'שדואו', 'צ׳דו'] },
  { he: 'סומבררו', en: 'sombrero', alt: ['סומבררה', 'סומבררו', 'סמבררו'] },
  { he: 'קרוס בודי', en: 'cross body lead', alt: ['קרוס באדי', 'קרוסבודי', 'קרוס בדי'] },
  { he: 'כריכה', en: 'wrap (cuddle)', alt: [] },
  { he: 'בודי רול', en: 'body roll', alt: ['בודירול', 'בודי רולל', 'בדי רול'] },
  { he: 'גל גוף', en: 'body wave', alt: [] },
  { he: 'איזולציה', en: 'isolation', alt: ['איזולציא', 'אייזולציה'] },
  { he: 'בסיס', en: 'basic step', alt: [] },
  { he: 'טאפ', en: 'tap', alt: ['טפ'] },
  { he: 'סיבוב פנימי', en: 'inside turn', alt: [] },
  { he: 'סיבוב חיצוני', en: 'outside turn', alt: [] },
  { he: 'הכנה', en: 'prep (preparation for a turn)', alt: [] },
  { he: 'מסגרת', en: 'frame', alt: [] },
  { he: 'קונטרה', en: 'counter tension', alt: ['קונטרא'] },
  { he: 'אחיזה סגורה', en: 'closed hold', alt: [] },
  { he: 'אחיזה פתוחה', en: 'open hold', alt: [] },
  { he: 'חיבוק צמוד', en: 'close embrace', alt: [] },
  { he: 'הובלה', en: 'lead', alt: [] },
  { he: 'הלבשה על הראש', en: 'hand over the head', alt: [] },
  { he: 'טוויסט', en: 'twist', alt: ['טוויסת', 'טויסט'] },
  { he: 'תפנית', en: 'pivot', alt: [] },
  { he: 'סחיפה', en: 'sweep', alt: [] },
  { he: 'הטיה', en: 'tilt (cambré)', alt: [] },
  { he: 'קמברה', en: 'cambré', alt: ['קמבריי', 'קמבראה'] },
  { he: 'דיפ', en: 'dip', alt: ['דיפּ'] },
  { he: 'אקסטנשן', en: 'extension', alt: ['אקסטנשיין', 'אקסטנשין'] },
  { he: 'ספוטינג', en: 'spotting', alt: ['ספוטינק'] },
  { he: 'אינטרו', en: 'intro', alt: ['אינטרואו'] },
  { he: 'סינקופה', en: 'syncopation', alt: ['סינקופציה'] },
  { he: 'סטיילינג', en: 'styling', alt: ['סטיילינק', 'סטיילנג'] },
  { he: 'שיינס', en: 'shines (solo footwork)', alt: ['שיינז'] },
  { he: 'דומיניקני', en: 'Dominican style', alt: [] },
  { he: 'סנסואל', en: 'sensual', alt: ['סנשואל', 'סנסואלי'] },
  { he: 'אנצ׳ופה', en: 'enchufla (salsa)', alt: ["אנצ'ופלה", 'אנצופה'] },
  { he: 'דילה קה נו', en: 'dile que no (salsa)', alt: [] }
];
function lexiconText(lang) {
  return LEXICON.map(x => lang === 'he' ? `${x.he} (${x.en})` : `${x.en} (Hebrew: ${x.he})`).join(', ');
}
function tagsText(tags, lang) {
  if (!tags || !tags.length) return '';
  const lines = tags.map(t => `- ${t.key}: ${t.label}${t.hint ? ' — ' + t.hint : ''}`).join('\n');
  return lang === 'he'
    ? `\nתגיות: בחרו אחת או יותר מהקטגוריות הבאות שמתארות במה השיעור עסק (החזירו את המפתח באנגלית בלבד):\n${lines}\n`
    : `\nTags: choose one or more of these categories for what the lesson worked on (return the key only):\n${lines}\n`;
}
function buildPrompt(lang, tags) {
  const lex = lexiconText(lang);
  if (lang === 'he') {
    return 'נתחו את סרטון סיכום שיעור הריקוד הזה. ענו בעברית.\n' +
      'החזירו: כותרת קצרה (עד 12 מילים) שמונה את הפיגורות או הנושאים שנלמדו; תיאור מפורט שמכסה את הרעיונות המרכזיים, טכניקת התנועה, ' +
      'טיפים להובלה ולמובלים, תרגילים, והכללים שהמורה הדגיש או הדגישה; 3 עד 8 פרקים כלליים, ' +
      'לכל אחד זמן התחלה בפורמט MM:SS וכותרת נושא קצרה; ותגיות.\n' +
      'הכותרת מתארת את תוכן השיעור עצמו, למשל „האמרלוק, שדו רגיל ושדו נגדי”, בלי קידומות כמו „סיכום שיעור” או „שיעור ריקוד”.\n' +
      'מונחי ריקוד: מורים בישראל אומרים את שמות הפיגורות באנגלית במבטא ישראלי. השתמשו אך ורק באיות הבא כשמונח מהרשימה נשמע בסרטון, ' +
      'גם אם ההגייה לא ברורה, ואל תמציאו תעתיק אחר: ' + lex + '.\n' +
      'הסתמכו גם על מה שרואים בסרטון כדי לזהות את הפיגורה (למשל יד מאחורי הגב = האמרלוק; המוביל מאחורי המובלת = שדו). ' +
      'מונח שלא ברשימה: כתבו אותו כפי שהמורה אומר אותו, ואם הוא באנגלית הוסיפו את המקור באנגלית בסוגריים בפעם הראשונה.\n' +
      'אל תמציאו תוכן שלא מופיע בסרטון.' + tagsText(tags, 'he');
  }
  return 'Analyze this dance lesson recap video. Answer in English.\n' +
    'Return: a short title (max 12 words) naming the figures or topics taught; a detailed description covering the core concepts, ' +
    'movement technique, leading and following tips, exercises, and the rules the instructor stressed; ' +
    '3 to 8 broad chapters, each with a start time in MM:SS and a short topic title; and tags.\n' +
    'The title names the content itself, for example "Hammerlock, shadow and counter shadow", with no prefix such as "Lesson summary" or "Dance lesson".\n' +
    'Dance vocabulary: use exactly these spellings whenever one of these terms is heard, even with an accent, and never invent another transcription: ' + lex + '.\n' +
    'Use what is visible in the video to confirm the figure (an arm folded behind the back = hammerlock; the lead behind the follow = shadow position). ' +
    'A term not in the list: write it as the instructor says it.\n' +
    'Do not invent content that is not in the video.' + tagsText(tags, 'en');
}

function buildSchema(tags) {
  const schema = {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING', description: 'Short lesson title, at most 12 words, naming the figures or topics' },
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
  if (tags && tags.length) {
    schema.properties.tags = { type: 'ARRAY', description: 'One or more category keys that describe what the lesson worked on', items: { type: 'STRING', enum: tags.map(t => t.key) } };
    schema.required.push('tags');
  }
  return schema;
}

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

// Repairs known misspellings of the canonical terms (whole words only, with an optional ה/ל/ב/ו prefix).
const TERM_FIXES = LEXICON.filter(x => x.alt.length).map(x => ({
  re: new RegExp('(^|[^\\u05d0-\\u05ea])([הלבומש]?)(' + x.alt.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![\\u05d0-\\u05ea])', 'g'),
  he: x.he
}));
function normalizeTerms(text) {
  let out = String(text || '');
  for (const f of TERM_FIXES) out = out.replace(f.re, (m, before, prefix) => before + prefix + (prefix && f.he.startsWith('ה') ? f.he.slice(1) : f.he));
  return out;
}

function parseTime(s) {
  const parts = String(s || '').trim().split(':').map(x => parseInt(x, 10));
  if (!parts.length || parts.some(isNaN)) return null;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

async function generate(fileUri, mime, key, model, lang, tags) {
  const body = {
    contents: [{ role: 'user', parts: [{ fileData: { fileUri, mimeType: mime } }, { text: buildPrompt(lang, tags) }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: buildSchema(tags), temperature: 0.2 }
  };
  const res = await call(`${BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`, key, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const j = await res.json();
  const cand = (j.candidates || [])[0];
  const text = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts.map(p => p.text || '').join('') : '';
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new GeminiError('Gemini returned an unreadable answer', 0, 'other'); }
  const allowed = new Set((tags || []).map(t => t.key));
  return {
    title: normalizeTerms(cleanTitle(data.title)),
    desc: normalizeTerms(String(data.description || '').trim()),
    tags: [...new Set((Array.isArray(data.tags) ? data.tags : []).map(String).filter(t => allowed.has(t)))],
    chapters: (Array.isArray(data.chapters) ? data.chapters : [])
      .map(c => ({ name: normalizeTerms(String(c.title || '').trim()), t: parseTime(c.start) }))
      .filter(c => c.name && c.t != null)
      .sort((a, b) => a.t - b.t)
  };
}

async function generateWithRetries(fileUri, mime, key, model, lang, tags, report) {
  const models = [model].concat(FALLBACK_MODELS.filter(m => m !== model));
  let lastErr = null;
  for (let mi = 0; mi < models.length; mi++) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await generate(fileUri, mime, key, models[mi], lang, tags);
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

async function analyzeVideo(source, { key, model, lang, tags, onProgress } = {}) {
  if (!key) throw new GeminiError('Missing API key', 0, 'key');
  const report = (stage, frac, detail) => { if (onProgress) onProgress({ stage, frac, detail }); };
  report('upload', 0);
  const uploaded = await uploadSource(source, key, frac => report('upload', frac));
  try {
    report('process');
    const active = await waitUntilActive(uploaded.name, key);
    report('analyze');
    return await generateWithRetries(active.uri, active.mimeType || source.type || 'video/mp4', key, (model || DEFAULT_MODEL).trim(), lang, tags, report);
  } finally {
    deleteFile(uploaded.name, key);
  }
}

window.GeminiClient = { analyzeVideo, cleanTitle, normalizeTerms, LEXICON, DEFAULT_MODEL, GeminiError };
})();
