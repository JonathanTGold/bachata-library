/* DanceLab · gemini.js
 * Optional video analysis with the Gemini API, entirely in the browser with the user's own
 * API key. Uploads the clip to Gemini's file storage, waits for processing, asks for a title,
 * a description and chapters as structured JSON, then deletes the uploaded copy.
 *
 * Exposes window.GeminiClient = { analyzeVideo(source, opts), extractAudio(source), DEFAULT_MODEL, GeminiError }.
 *   source: a File/Blob, or a remote descriptor { size, type, name, fetchRange(start, end) -> Blob }
 *           (the video is relayed in chunks, so a large clip never sits in memory as a whole)
 *   opts: { key, model, lang, tags: [{ key, label, hint }], audioOnly (default true), onProgress({ stage, frac, detail }) }
 *         stage is one of 'extract' | 'upload' | 'process' | 'analyze' | 'retry' | 'fallback'
 *   With audioOnly, a video's AAC track is pulled out of the container (no decoding) and only that
 *   is sent: a tenth of the tokens and a fraction of the upload. Falls back to the full video when
 *   the container or codec is not the usual phone recording.
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
  { he: 'דילה קה נו', en: 'dile que no (salsa)', alt: [] },
  { he: 'גואירה', en: 'güira (instrument)', alt: ['גווירה', 'גוירה', 'גואירא'] },
  { he: 'בונגו', en: 'bongo', alt: ['בונגוס'] },
  { he: 'דרצ׳ו', en: 'derecho (bachata song section)', alt: ["דרצ'ו", 'דרצו'] },
  { he: 'מחאו', en: 'majao (bachata song section)', alt: ['מאחאו', "מג'או", 'מג׳או', "מאג'או", 'מאג׳או', 'מאז׳או'] },
  { he: 'ממבו', en: 'mambo (bachata song section)', alt: ['מאמבו'] },
  { he: 'ברייק', en: 'break (musical break)', alt: ['ברק', 'בריק'] }
];
function lexiconText(lang) {
  return LEXICON.map(x => lang === 'he' ? `${x.en} → ${x.he}` : `${x.en} (Hebrew: ${x.he})`).join(', ');
}
function tagsText(tags, lang) {
  if (!tags || !tags.length) return '';
  const lines = tags.map(t => `- ${t.key}: ${t.label}${t.hint ? ' — ' + t.hint : ''}`).join('\n');
  return lang === 'he'
    ? `\nתגיות: בחרו אחת או יותר מהקטגוריות הבאות שמתארות במה השיעור עסק (החזירו את המפתח באנגלית בלבד):\n${lines}\n`
    : `\nTags: choose one or more of these categories for what the lesson worked on (return the key only):\n${lines}\n`;
}
function buildPrompt(lang, tags, mode) {
  const lex = lexiconText(lang);
  const audio = mode === 'audio', track = mode === 'track';
  if (lang === 'he') {
    if (audio) return 'נתחו את הקלטת השמע הזאת של שיעור ריקוד (קול בלבד, בלי תמונה: המורה מסביר או מסכם, לפעמים על רקע מוזיקה). ענו בעברית.\n' +
      'החזירו: כותרת קצרה (עד 12 מילים) שמונה את הפיגורות או הנושאים שנלמדו; תיאור מלא ומסודר של כל מה שנאמר בשיעור, לפי סדר הדברים, מחולק לנושאים עם כותרת משנה קצרה לכל נושא: ' +
      'ההסברים, התיקונים, הטיפים להובלה ולמובלים, התרגילים והכללים, במילים של המורה. לא תקציר קצר: כל נקודה שנאמרה נכנסת. ' +
      'בלי פרשנות, בלי מושגים או מילים שלא נאמרו, ובלי להשלים ידע מבחוץ. ' +
      'פורמט התיאור: טקסט רגיל בלבד, בלי סימני Markdown (בלי #, בלי כוכביות, בלי מקפים בתחילת שורה): לכל נושא שורת כותרת משנה קצרה, מתחתיה הפסקה שלו, ושורה ריקה בין נושא לנושא; 3 עד 8 פרקים כלליים, ' +
      'לכל אחד זמן התחלה בפורמט MM:SS וכותרת נושא קצרה; ותגיות.\n' +
      'הכותרת מתארת את תוכן השיעור עצמו, למשל „מוזיקליות: ספירות, אקסנטים וכלי הנגינה”, בלי קידומות כמו „סיכום שיעור” או „שיעור ריקוד”.\n' +
      'מונחי ריקוד: מורים בישראל אומרים את שמות הפיגורות באנגלית במבטא ישראלי. השתמשו אך ורק באיות הבא כשמונח מהרשימה נשמע בהקלטה, ' +
      'גם אם ההגייה לא ברורה, ואל תמציאו תעתיק אחר: ' + lex + '.\n' +
      'זו הקלטת קול בלבד: זהו את הנושאים לפי מה שנאמר, לפי הספירות, הקצב והמוזיקה שנשמעים. אם המורה מתייחס למוזיקה, ציינו מה נאמר על הספירה, על האקסנטים ועל כלי הנגינה. ' +
      'מונח מהרשימה נכתב רק באיות העברי שלו, בלי האנגלית ובלי סוגריים. מונח שלא ברשימה: כתבו אותו כפי שהמורה אומר אותו, ואם הוא באנגלית הוסיפו את המקור באנגלית בסוגריים בפעם הראשונה בלבד.\n' +
      'אל תמציאו תוכן שלא נשמע בהקלטה.' + tagsText(tags, 'he');
    return 'נתחו את סרטון סיכום שיעור הריקוד הזה. ענו בעברית.\n' +
      'החזירו: כותרת קצרה (עד 12 מילים) שמונה את הפיגורות או הנושאים שנלמדו; תיאור מלא ומסודר של כל מה שנאמר בשיעור, לפי סדר הדברים, מחולק לנושאים עם כותרת משנה קצרה לכל נושא: ' +
      'ההסברים, התיקונים, הטיפים להובלה ולמובלים, התרגילים והכללים, במילים של המורה. לא תקציר קצר: כל נקודה שנאמרה נכנסת. ' +
      'בלי פרשנות, בלי מושגים או מילים שלא נאמרו, ובלי להשלים ידע מבחוץ. ' +
      'פורמט התיאור: טקסט רגיל בלבד, בלי סימני Markdown (בלי #, בלי כוכביות, בלי מקפים בתחילת שורה): לכל נושא שורת כותרת משנה קצרה, מתחתיה הפסקה שלו, ושורה ריקה בין נושא לנושא; 3 עד 8 פרקים כלליים, ' +
      'לכל אחד זמן התחלה בפורמט MM:SS וכותרת נושא קצרה; ותגיות.\n' +
      'הכותרת מתארת את תוכן השיעור עצמו, למשל „האמרלוק, שדו רגיל ושדו נגדי”, בלי קידומות כמו „סיכום שיעור” או „שיעור ריקוד”.\n' +
      'מונחי ריקוד: מורים בישראל אומרים את שמות הפיגורות באנגלית במבטא ישראלי. השתמשו אך ורק באיות הבא כשמונח מהרשימה נשמע בסרטון, ' +
      'גם אם ההגייה לא ברורה, ואל תמציאו תעתיק אחר: ' + lex + '.\n' +
      (track ? 'זה פסקול השיעור בלבד (השמע של הסרטון, בלי תמונה): זהו את הפיגורות והנושאים לפי מה שהמורה אומר, לפי הספירות ולפי המוזיקה. '
        : 'הסתמכו גם על מה שרואים בסרטון כדי לזהות את הפיגורה (למשל יד מאחורי הגב = האמרלוק; המוביל מאחורי המובלת = שדו). ') +
      'מונח מהרשימה נכתב רק באיות העברי שלו, בלי האנגלית ובלי סוגריים. מונח שלא ברשימה: כתבו אותו כפי שהמורה אומר אותו, ואם הוא באנגלית הוסיפו את המקור באנגלית בסוגריים בפעם הראשונה בלבד.\n' +
      (track ? 'אל תמציאו תוכן שלא נשמע בהקלטה.' : 'אל תמציאו תוכן שלא מופיע בסרטון.') + tagsText(tags, 'he');
  }
  if (audio) return 'Analyze this audio recording of a dance lesson (sound only, no picture: the instructor explaining or recapping, sometimes over music). Answer in English.\n' +
    'Return: a short title (max 12 words) naming the figures or topics taught; a full, ordered write-up of everything said in the lesson, split into topics with a short subheading each: ' +
    'the explanations, corrections, leading and following tips, exercises and rules, in the instructor\'s own words. Not a short summary: every point made goes in. ' +
    'No interpretation, no terms or words that were not said, no outside knowledge. ' +
    'Description format: plain text only, no Markdown (no #, no asterisks, no leading dashes): for each topic a short subheading line, its paragraph below it, and a blank line between topics; ' +
    '3 to 8 broad chapters, each with a start time in MM:SS and a short topic title; and tags.\n' +
    'The title names the content itself, for example "Musicality: counts, accents and instruments", with no prefix such as "Lesson summary" or "Dance lesson".\n' +
    'Dance vocabulary: use exactly these spellings whenever one of these terms is heard, even with an accent, and never invent another transcription: ' + lex + '.\n' +
    'This is sound only: identify the topics from what is said and from the counts, rhythm and music that can be heard. When the instructor talks about the music, note what is said about the count, the accents and the instruments. ' +
    'A listed term is written in its listed English form only, without extra brackets. A term not in the list: write it as the instructor says it.\n' +
    'Do not invent content that is not in the recording.' + tagsText(tags, 'en');
  return 'Analyze this dance lesson recap video. Answer in English.\n' +
    'Return: a short title (max 12 words) naming the figures or topics taught; a full, ordered write-up of everything said in the lesson, split into topics with a short subheading each: ' +
    'the explanations, corrections, leading and following tips, exercises and rules, in the instructor\'s own words. Not a short summary: every point made goes in. ' +
    'No interpretation, no terms or words that were not said, no outside knowledge. ' +
    'Description format: plain text only, no Markdown (no #, no asterisks, no leading dashes): for each topic a short subheading line, its paragraph below it, and a blank line between topics; ' +
    '3 to 8 broad chapters, each with a start time in MM:SS and a short topic title; and tags.\n' +
    'The title names the content itself, for example "Hammerlock, shadow and counter shadow", with no prefix such as "Lesson summary" or "Dance lesson".\n' +
    'Dance vocabulary: use exactly these spellings whenever one of these terms is heard, even with an accent, and never invent another transcription: ' + lex + '.\n' +
    (track ? 'This is only the soundtrack of the lesson video (no picture): identify the figures and topics from what the instructor says, the counts and the music. '
      : 'Use what is visible in the video to confirm the figure (an arm folded behind the back = hammerlock; the lead behind the follow = shadow position). ') +
    'A listed term is written in its listed English form only, without extra brackets. A term not in the list: write it as the instructor says it.\n' +
    (track ? 'Do not invent content that is not in the recording.' : 'Do not invent content that is not in the video.') + tagsText(tags, 'en');
}

function buildSchema(tags) {
  const schema = {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING', description: 'Short lesson title, at most 12 words, naming the figures or topics' },
      description: { type: 'STRING', description: 'Full, ordered write-up of everything said in the lesson, split into topics with short subheadings, in the instructor\'s words' },
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
// Browsers report m4a as audio/x-m4a and similar vendor names; Gemini's file service wants the canonical types.
const MIME_ALIASES = { 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/x-aiff': 'audio/aiff', 'audio/x-flac': 'audio/flac', 'video/x-m4v': 'video/mp4' };
function geminiMime(type) { const t = String(type || '').toLowerCase() || 'video/mp4'; return MIME_ALIASES[t] || t; }
const isAudio = mime => /^audio\//i.test(mime || '');

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
async function uploadSource(source, key, onProgress, name) {
  const size = source.size;
  if (!size) throw new GeminiError('File size unknown', 0, 'other');
  const mime = geminiMime(source.type);
  const uploadUrl = await startUploadSession(size, mime, name || source.name, key);
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
    if (f.state === 'FAILED') throw new GeminiError('Gemini could not process this file', 0, 'other');
    await sleep(PROCESS_POLL_MS);
  }
  throw new GeminiError('Processing timed out', 0, 'other');
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

// Models still slip in Markdown now and then; the app stores plain text.
function plainText(text) {
  return String(text == null ? '' : text).replace(/\r/g, '').split('\n')
    .map(l => l.replace(/^\s*#{1,6}\s*/, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^\s*[-*]\s+/, '• ').trimEnd())
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function parseTime(s) {
  const parts = String(s || '').trim().split(':').map(x => parseInt(x, 10));
  if (!parts.length || parts.some(isNaN)) return null;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

async function generate(fileUri, mime, key, model, lang, tags, mode) {
  const body = {
    contents: [{ role: 'user', parts: [{ fileData: { fileUri, mimeType: mime } }, { text: buildPrompt(lang, tags, mode) }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: buildSchema(tags), temperature: 0.1, maxOutputTokens: 8192 }
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
    desc: normalizeTerms(plainText(data.description)),
    tags: [...new Set((Array.isArray(data.tags) ? data.tags : []).map(String).filter(t => allowed.has(t)))],
    chapters: (Array.isArray(data.chapters) ? data.chapters : [])
      .map(c => ({ name: normalizeTerms(String(c.title || '').trim()), t: parseTime(c.start) }))
      .filter(c => c.name && c.t != null)
      .sort((a, b) => a.t - b.t)
  };
}

async function generateWithRetries(fileUri, mime, key, model, lang, tags, mode, report) {
  const models = [model].concat(FALLBACK_MODELS.filter(m => m !== model));
  let lastErr = null;
  for (let mi = 0; mi < models.length; mi++) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        return await generate(fileUri, mime, key, models[mi], lang, tags, mode);
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

// ---- Audio track extraction (MP4/MOV → ADTS AAC), no decoding ----
// A phone recording carries a small AAC track interleaved with a large video track. The sample
// tables in the moov box give the byte range of every audio frame; each one is copied out with a
// 7-byte ADTS header in front. Nothing is decoded, so an hour of video becomes a ~30 MB file in
// seconds from a local file (a Drive file still has to be read through once).
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be64 = (b, o) => be32(b, o) * 4294967296 + be32(b, o + 4);
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
function boxes(b, start, end) {
  const out = []; let p = start;
  while (p + 8 <= end) {
    let size = be32(b, p), hdr = 8;
    if (size === 1) { size = be64(b, p + 8); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type: fourcc(b, p + 4), start: p + hdr, end: p + size });
    p += size;
  }
  return out;
}
const box = (list, type) => list.find(x => x.type === type);
async function findMoov(read, fileSize) {
  let p = 0;
  while (p + 8 <= fileSize) {
    const h = await read(p, Math.min(16, fileSize - p));
    let size = be32(h, 0), hdr = 8;
    if (size === 1) { if (h.length < 16) return null; size = be64(h, 8); hdr = 16; } else if (size === 0) size = fileSize - p;
    if (size < hdr) return null;
    if (fourcc(h, 4) === 'moov') { if (size > 96 * 1024 * 1024) return null; return { data: await read(p, size), start: hdr }; }
    p += size;
  }
  return null;
}
// The MPEG-4 AudioSpecificConfig sits in the esds descriptor chain of the mp4a sample entry.
function findAsc(m, from, to) {
  for (let q = from; q + 4 <= to; q++) {
    if (m[q] !== 0x65 || m[q + 1] !== 0x73 || m[q + 2] !== 0x64 || m[q + 3] !== 0x73) continue;
    let p = q + 8;
    const len = () => { let n = 0; for (let i = 0; i < 4; i++) { const c = m[p++]; n = (n << 7) | (c & 0x7f); if (!(c & 0x80)) break; } return n; };
    if (m[p++] !== 0x03) return null; len(); p += 2; const flags = m[p++];
    if (flags & 0x80) p += 2; if (flags & 0x40) p += m[p] + 1; if (flags & 0x20) p += 2;
    if (m[p++] !== 0x04) return null; len(); p += 13;
    if (m[p++] !== 0x05) return null; if (len() < 2) return null;
    return { aot: m[p] >> 3, freqIdx: ((m[p] & 7) << 1) | (m[p + 1] >> 7), chan: (m[p + 1] >> 3) & 0x0f };
  }
  return null;
}
function parseAudioTrack(m, start) {
  for (const trak of boxes(m, start, m.length).filter(x => x.type === 'trak')) {
    const mdia = box(boxes(m, trak.start, trak.end), 'mdia'); if (!mdia) continue;
    const md = boxes(m, mdia.start, mdia.end);
    const hdlr = box(md, 'hdlr'); if (!hdlr || fourcc(m, hdlr.start + 8) !== 'soun') continue;
    const mdhd = box(md, 'mdhd'); let duration = 0;
    if (mdhd) duration = m[mdhd.start] === 1 ? be64(m, mdhd.start + 24) / be32(m, mdhd.start + 20) : be32(m, mdhd.start + 16) / be32(m, mdhd.start + 12);
    const minf = box(md, 'minf'); if (!minf) continue;
    const stbl = box(boxes(m, minf.start, minf.end), 'stbl'); if (!stbl) continue;
    const st = boxes(m, stbl.start, stbl.end);
    const stsd = box(st, 'stsd'), stsz = box(st, 'stsz'), stsc = box(st, 'stsc'), stco = box(st, 'stco') || box(st, 'co64');
    if (!stsd || !stsz || !stsc || !stco) continue;
    if (fourcc(m, stsd.start + 12) !== 'mp4a') continue;
    const asc = findAsc(m, stsd.start + 16, stsd.end);
    if (!asc || asc.aot !== 2 || asc.freqIdx > 12 || asc.chan < 1 || asc.chan > 7) continue; // AAC-LC only
    const fixed = be32(m, stsz.start + 4), count = be32(m, stsz.start + 8);
    if (!count) continue;
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || be32(m, stsz.start + 12 + i * 4);
    const nsc = be32(m, stsc.start + 4), sc = [];
    for (let i = 0; i < nsc; i++) { const o = stsc.start + 8 + i * 12; sc.push({ first: be32(m, o), per: be32(m, o + 4) }); }
    const nco = be32(m, stco.start + 4), is64 = stco.type === 'co64';
    const offs = new Float64Array(count); let idx = 0;
    for (let c = 0; c < nco && idx < count; c++) {
      let off = is64 ? be64(m, stco.start + 8 + c * 8) : be32(m, stco.start + 8 + c * 4);
      let per = 0; for (const e of sc) { if (e.first <= c + 1) per = e.per; else break; }
      for (let j = 0; j < per && idx < count; j++) { offs[idx] = off; off += sizes[idx]; idx++; }
    }
    return { offs, sizes, count: idx, asc, duration, sampleRate: [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][asc.freqIdx] };
  }
  return null;
}
async function extractAudio(source, onProgress) {
  const local = typeof source.slice === 'function';
  const size = source.size; if (!size) return null;
  const read = async (off, len) => { const b = local ? source.slice(off, off + len) : await source.fetchRange(off, off + len - 1); return new Uint8Array(await b.arrayBuffer()); };
  const moov = await findMoov(read, size); if (!moov) return null;
  const tr = parseAudioTrack(moov.data, moov.start); if (!tr || !tr.count) return null;
  const { offs, sizes, count, asc } = tr;
  // Frames are copied window by window: a local file is read only around the audio chunks, a
  // remote one in long contiguous runs so it takes few requests.
  const MAXWIN = 8 * 1024 * 1024, GAP = local ? 64 * 1024 : MAXWIN;
  const parts = []; let i = 0;
  while (i < count) {
    const wStart = offs[i]; let j = i, wEnd = offs[i] + sizes[i], bytes = 7 + sizes[i];
    while (j + 1 < count) {
      const nStart = offs[j + 1], nEnd = nStart + sizes[j + 1];
      if (nStart < wEnd || nEnd - wStart > MAXWIN || nStart - wEnd > GAP) break;
      wEnd = nEnd; bytes += 7 + sizes[j + 1]; j++;
    }
    const buf = await read(wStart, wEnd - wStart);
    const out = new Uint8Array(bytes); let o = 0;
    for (let k = i; k <= j; k++) {
      const n = sizes[k], len = n + 7, at = offs[k] - wStart;
      out[o] = 0xFF; out[o + 1] = 0xF1;
      out[o + 2] = ((asc.aot - 1) << 6) | (asc.freqIdx << 2) | (asc.chan >> 2);
      out[o + 3] = ((asc.chan & 3) << 6) | ((len >> 11) & 3);
      out[o + 4] = (len >> 3) & 0xFF; out[o + 5] = ((len & 7) << 5) | 0x1F; out[o + 6] = 0xFC;
      out.set(buf.subarray(at, at + n), o + 7); o += len;
    }
    parts.push(out); i = j + 1;
    if (onProgress) onProgress(Math.min(1, wEnd / size));
  }
  const blob = new Blob(parts, { type: 'audio/aac' });
  blob.duration = tr.duration || (count * 1024 / tr.sampleRate);
  return blob;
}

async function analyzeVideo(source, { key, model, lang, tags, onProgress, audioOnly = true } = {}) {
  if (!key) throw new GeminiError('Missing API key', 0, 'key');
  const report = (stage, frac, detail) => { if (onProgress) onProgress({ stage, frac, detail }); };
  let src = source, name = source.name, mode = isAudio(geminiMime(source.type)) ? 'audio' : 'video';
  if (mode === 'video' && audioOnly) {
    try {
      report('extract', 0);
      const a = await extractAudio(source, frac => report('extract', frac));
      if (a && a.size > 4096) { src = a; name = String(name || 'lesson').replace(/\.[a-z0-9]+$/i, '') + '.aac'; mode = 'track'; }
    } catch (e) { /* not a plain phone recording: send the whole video */ }
  }
  report('upload', 0);
  const uploaded = await uploadSource(src, key, frac => report('upload', frac), name);
  try {
    report('process');
    const active = await waitUntilActive(uploaded.name, key);
    report('analyze');
    return await generateWithRetries(active.uri, active.mimeType || geminiMime(src.type), key, (model || DEFAULT_MODEL).trim(), lang, tags, mode, report);
  } finally {
    deleteFile(uploaded.name, key);
  }
}

window.GeminiClient = { analyzeVideo, extractAudio, cleanTitle, normalizeTerms, LEXICON, DEFAULT_MODEL, GeminiError };
})();
