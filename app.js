/* DanceLab · app.js
 * A single-user progressive web app. Everything lives in the user's own Google Drive
 * under the drive.file scope: one folder per school or teacher, the video files,
 * small thumbnails, and a library.json index. There is no backend.
 */
(function () {
'use strict';

const CFG = window.BACHATA_CONFIG || {};
const APP_VERSION = '2.10.0';
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
const LS = { token: 'bl_token', lib: 'bl_library', clientId: 'bl_client_id', hint: 'bl_login_hint', root: 'bl_root', lang: 'bl_lang', theme: 'bl_theme', filter: 'bl_filter' };
const THEMES = ['dark', 'light', 'auto'];
const SS = { state: 'bl_oauth_state', silent: 'bl_silent_tried', needConsent: 'bl_need_consent' };
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5];
const SKIP = 5;
const CHUNK = 8 * 1024 * 1024; // resumable upload chunk size, a multiple of 256 KiB
const STYLE_KEYS = ['bachata', 'salsa', 'kizomba', 'zouk'];
const BASE_STYLES = ['bachata', 'salsa'];
const DEFAULT_STYLE = 'bachata';
// General classification of what a lesson works on. Fixed list: shown as chips, editable by hand,
// and the auto-fill picks one or more of these keys.
const TAG_KEYS = ['basics', 'footwork', 'turns', 'elements', 'bodymove', 'isolations', 'leadfollow', 'technique', 'musicality', 'styling', 'sensual', 'tricks', 'choreo', 'drills'];

// ---------- strings ----------
const STR = {
  he: {
    dir: 'rtl', locale: 'he-IL',
    library: 'השיעורים שלי', schools: 'בתי ספר', settings: 'הגדרות', addLesson: 'שיעור חדש', editLesson: 'עריכת שיעור', tagLesson: 'תיוג הסיכום',
    tagline: 'סיכומי השיעורים שלך, מסודרים לפי בית ספר, ישירות מה‑Google Drive שלך. שום דבר לא נשמר במקום אחר.',
    signin: 'התחברות עם Google', signinHint: 'האפליקציה מבקשת גישה רק לקבצים שהיא עצמה יוצרת ב‑Drive שלך.',
    setupTitle: 'הגדרה חד‑פעמית', setupBody: 'לעותק הזה של האפליקציה אין עדיין מזהה לקוח של Google. יוצרים אחד ב‑Google Cloud Console ומדביקים למטה.',
    setupStep1: 'יוצרים פרויקט ומפעילים את Google Drive API.', setupStep2: 'ב‑Google Auth Platform מגדירים מיתוג, בוחרים קהל External, מוסיפים את ההרשאה drive.file ומפרסמים.', setupStep3: 'יוצרים לקוח OAuth מסוג Web application עם:', origin: 'מקור JavaScript מורשה', redirect: 'כתובת הפניה מורשית',
    pasteClient: 'הדבקת מזהה לקוח (מסתיים ב‑.apps.googleusercontent.com)', saveSignin: 'שמירה והתחברות',
    all: 'הכול', untagged: 'ללא תיוג', search: 'חיפוש פיגורה, בית ספר, הערה', allSchools: 'כל בתי הספר', allStylesLabel: 'כל הסגנונות', privateTeachers: 'מורים פרטיים', reset: 'איפוס', pickSource: 'צריך לבחור בית ספר או מורה.',
    noRecaps: 'אין עדיין סיכומים', emptyTitle: 'אין עדיין סיכומים.', emptyBody: 'לחיצה על + מוסיפה את הראשון. הוא עולה לתיקייה „Bachata Library” ב‑Google Drive שלך.', nothingMatches: 'אין תוצאות לסינון הזה.',
    group: 'קבוצתי', private: 'פרטי', groupLesson: 'שיעור קבוצתי', privateLesson: 'שיעור פרטי',
    untaggedRecap: 'סיכום ללא תיוג', tapToTag: 'לחיצה לתיוג', needsTag: 'חסרים בית ספר ופיגורות', recap: 'סיכום', recorded: 'הוקלט',
    figures: 'פרקים', notes: 'הערות', noNotes: 'אין הערות עדיין. אפשר להוסיף דרך העריכה.', figureName: 'שם הפרק', noTime: 'ללא זמן', noChapters: 'אין פרקים עדיין. מנגנים עד הרגע הרצוי ולוחצים על + כדי לסמן פרק בזמן הנוכחי.',
    title: 'כותרת', titlePh: 'למשל: האמרלוק ויציאה מסומבררו', desc: 'תיאור', descPh: 'מה היה בשיעור: פיגורות, תיקונים, דגשים', deleteArmToast: 'לחיצה נוספת על סל המחזור מוחקת את הסרטון מ‑Drive.',
    repeatA: a => `התחלה סומנה ב‑${a}. לחצו שוב בסוף הקטע.`, repeatOn: (a, b) => `חוזר על ${a}–${b}.`, repeatOff: 'החזרה בוטלה.',
    ai: 'ניתוח אוטומטי', aiIdle: 'מילוי כותרת, תיאור, תגיות ופרקים מהסרטון עם Gemini.', aiNeedKey: 'צריך מפתח Gemini API. מוסיפים אותו בהגדרות.', aiDownloading: p => `מוריד את הסרטון מ‑Drive… ${p}%`, aiUploading: p => `מעלה לניתוח… ${p}%`, aiRelay: p => `מעביר את הסרטון מ‑Drive לניתוח… ${p}%`, aiRefreshing: 'מרענן את ההתחברות ל‑Drive לפני הניתוח…', aiProcessing: 'Gemini מעבד את הסרטון…', aiAnalyzing: 'מנתח את השיעור…', aiRetry: 'המודל עמוס, מנסה שוב בעוד רגע…', aiFallback: m => `עובר למודל ${m}…`, aiBusy: 'Gemini עמוס כרגע. מנסים שוב בעוד כמה דקות.', aiDone: 'הכותרת, התיאור, התגיות והפרקים מולאו. בודקים ושומרים.', aiFailed: 'הניתוח נכשל. ', aiBadKey: 'המפתח לא תקין, או שהוא מוגבל לכתובת אחרת.', aiQuota: 'חרגתם ממכסת Gemini להיום. אפשר לנסות מאוחר יותר.', aiBadModel: 'שם המודל לא נמצא. בודקים את השם בהגדרות.',
    geminiKey: 'מפתח Gemini API', geminiHelp: 'המפתח נשמר בתיקייה שלך ב‑Drive ומסתנכרן בין המכשירים שלך. הסרטון נשלח ל‑Gemini לניתוח ונמחק משם מיד אחרי. בחבילה החינמית Google עשויה להשתמש בתוכן לשיפור המודלים.', geminiModelHint: 'שם המודל. ריק = ברירת המחדל', getKey: 'יצירת מפתח ב‑Google AI Studio', keySaved: 'הגדרות Gemini נשמרו.', badGeminiKey: 'זה לא נראה כמו מפתח Gemini API.',
    help: 'עזרה', helpItems: [['ai', 'ניתוח אוטומטי', 'עם מפתח Gemini API מההגדרות, הכפתור הנוצץ בטופס ממלא כותרת, תיאור, תגיות ופרקים מתוך הסרטון. בודקים את התוצאה לפני השמירה.'], ['back5', 'דילוג', 'החצים על הסרטון מדלגים 5 שניות אחורה או קדימה. לחיצה על הסרטון מציגה או מסתירה אותם.'], ['repeat', 'חזרה על קטע', 'לחיצה ראשונה מסמנת התחלה (A), שנייה מסמנת סוף (B), והקטע ינוגן שוב ושוב עד ללחיצה שלישית.'], ['mirror', 'מראה', 'הופך את הסרטון אופקית, כמו להסתכל במראה של הסטודיו. נוח כשעומדים מול המורה.'], ['plus', 'פרקים', 'בעמוד השיעור, מנגנים עד הרגע הרצוי ולוחצים על + כדי לסמן פרק בזמן הנוכחי. לחיצה על פרק קופצת אליו.'], ['pip', 'תמונה בתוך תמונה', 'ממשיך לנגן בחלון קטן מעל אפליקציות אחרות.'], ['fs', 'מסך מלא', 'פותח את הסרטון בנגן של המכשיר. מומלץ לסובב את המכשיר לסרטונים לרוחב.']],
    noPip: 'הדפדפן הזה לא תומך בתמונה‑בתוך‑תמונה.', playFirst: 'קודם מתחילים לנגן.',
    chooseVideo: 'בחירת סרטון או הקלטה', fromWhere: 'מהתמונות, מהקבצים, צילום או הקלטת קול', audioLesson: 'הקלטת שמע', alreadyInDrive: 'כבר ב‑Drive', reading: 'קורא…', previewNA: 'אין תצוגה מקדימה',
    style: 'סגנון', otherStyle: 'אחר…', styleName: 'שם הסגנון', lessonType: 'סוג שיעור', school: 'בית ספר', teacher: 'מורה', newSchool: '+ בית ספר חדש…', newTeacher: '+ מורה חדש…', leaveUntagged: 'להשאיר ללא תיוג בינתיים', name: 'שם',
    privateHint: 'שיעורים פרטיים נשמרים תחת שם המורה במקום בית ספר.', date: 'תאריך', figuresCovered: 'פיגורות שנלמדו', figuresPh: 'סומבררו, האמרלוק, בודי רול', notesOptional: 'הערות', notesPh: 'מה לתרגל, תיקונים, שיעורי בית',
    saveUpload: 'שמירה והעלאה ל‑Drive', saveChanges: 'שמירת שינויים', uploading: 'מעלה…', uploadingPct: p => `מעלה… ${p}% · להשאיר את האפליקציה פתוחה`, finishing: 'מסיים…', savedToIndex: 'השינויים נשמרים לאינדקס ב‑Drive שלך.', pickTagDone: 'בוחרים סרטון, מתייגים, וזה עולה ל‑Drive.', skipHint: 'אפשר לדלג על השדות והסרטון יופיע תחת „ללא תיוג”.',
    deleteArm: 'לחיצה נוספת מעבירה את הסרטון לסל המחזור של Drive.', deleteIdle: 'מחיקת הסיכום', deleted: 'הועבר לסל המחזור של Drive.', deleteFailed: 'המחיקה נכשלה. ',
    pickFirst: 'קודם בוחרים סרטון או הקלטה.', typeName: k => `צריך להקליד שם ${k}.`, typeStyle: 'צריך להקליד שם סגנון.', saved: 'נשמר.', uploaded: 'הועלה ל‑Drive.', uploadedUntagged: 'הועלה. מחכה תחת „ללא תיוג”.', saveFailed: 'השמירה נכשלה. ', nothingLost: 'משהו השתבש. שום דבר לא אבד, אפשר לנסות שוב.', waitUpload: 'ההעלאה עדיין רצה. מחכים שתסתיים.',
    couldNotReach: 'אין גישה ל‑Google Drive. ', couldNotLoadVideo: 'לא ניתן לטעון את הסרטון. ', couldNotPlay: 'לא ניתן לנגן את הסרטון. ייתכן שהפורמט לא נתמך בדפדפן הזה.', loadingVideo: 'טוען סרטון…', loadingPct: p => `טוען סרטון… ${p}%`, buffering: 'טוען…',
    marked: (n, t) => `„${n}” סומן ב‑${t}.`, removed: n => `„${n}” הוסר.`, couldNotSave: 'לא ניתן לשמור. ', typeFigure: 'צריך להקליד שם לפרק.',
    schoolsSub: 'מורים פרטיים מופיעים לצד בתי הספר. לחיצה מסננת את הרשימה.', noSchools: 'אין עדיין בתי ספר.', noTeachers: 'אין עדיין מורים פרטיים.', privateTeacher: 'מורה פרטי', groupClasses: 'שיעורים קבוצתיים', addSource: 'הוספה', schoolsAuto: 'בתי ספר ומורים נוספים אוטומטית גם כשמתייגים סיכום.', alreadyListed: 'כבר ברשימה.', added: n => `${n} נוסף.`, removedSource: n => `${n} הוסר.`, moveFirst: 'קודם מעבירים או מוחקים את הסיכומים שלו.', last: 'אחרון',
    signedInAs: e => `מחובר בתור ${e}`, signedIn: 'מחובר', storage: 'אחסון', storageBody: 'הכול נשמר בתיקייה בשם Bachata Library ב‑Google Drive שלך: תת‑תיקייה לכל בית ספר או מורה, הסרטונים, וקובץ אינדקס קטן.', openDrive: 'פתיחת התיקייה ב‑Drive', maintenance: 'תחזוקה', rescan: 'סריקת Drive ותיקון האינדקס', rescanHint: 'מוסיף סיכומים שהועלו ממכשיר אחר או חסרים ברשימה, ומסיר רשומות שהקבצים שלהן נמחקו.', scanning: 'סורק…', rescanDone: (a, r) => `הסתיים. ${a} נוספו, ${r} הוסרו.`, rescanFailed: 'הסריקה נכשלה. ',
    account: 'חשבון', signOut: 'התנתקות', signOutHint: 'מתנתק במכשיר הזה בלבד. שום דבר ב‑Drive לא נמחק.', language: 'שפה', appearance: 'מראה', themeDark: 'כהה', themeLight: 'בהיר', themeAuto: 'אוטומטי', advanced: 'מתקדם', clientId: 'מזהה לקוח Google OAuth', clientHint: 'נדרש רק אם מריצים עותק עצמאי של האפליקציה.', badClient: 'זה לא נראה כמו מזהה לקוח של Google.', clientSaved: 'המזהה נשמר.', addClientFirst: 'קודם מוסיפים מזהה לקוח.',
    signInAgain: 'צריך להתחבר שוב.', signinCheckFailed: 'בדיקת ההתחברות נכשלה. נסו שוב.', driveNotGranted: 'לא ניתנה גישה ל‑Drive. התחברו שוב והשאירו את תיבת Google Drive מסומנת.',
    recapsN: n => n === 1 ? 'סיכום אחד' : `${n} סיכומים`, schoolsN: n => n === 1 ? 'בית ספר אחד' : `${n} בתי ספר`, teachersN: n => n === 1 ? 'מורה פרטי אחד' : `${n} מורים פרטיים`,
    styles: { bachata: 'באצ׳טה', salsa: 'סלסה', kizomba: 'קיזומבה', zouk: 'זוק' },
    tagsLabel: 'תגיות',
    tags: { basics: 'בסיסים', footwork: 'עבודת רגליים', turns: 'סיבובים', elements: 'אלמנטים ווריאציות', bodymove: 'תנועת גוף', isolations: 'איזולציות', leadfollow: 'הובלה ומעקב', technique: 'טכניקה ויציבה', musicality: 'מוזיקליות וקצב', styling: 'סטיילינג', sensual: 'סנסואל', tricks: 'טריקים ודיפים', choreo: 'כוריאוגרפיה', drills: 'תרגילים' },
    tagHints: { basics: 'צעדי בסיס, טאפים וגיווני בסיס', footwork: 'עבודת רגליים, סינקופות, סגנון דומיניקני, שיינס', turns: 'סיבובים, הכנות לסיבוב, ספוטינג', elements: 'פיגורות ואלמנטים בזוג כמו האמרלוק, סומבררו, שדו, כריכה, קרוס בודי, ווריאציות שלהם וקומבינציות', bodymove: 'גלי גוף, בודי רול, קמברה, תנועות ראש', isolations: 'איזולציות של אגן, חזה, כתפיים', leadfollow: 'הובלה ומעקב, חיבור, קונטרה, אחיזות', technique: 'יציבה, מסגרת, העברת משקל, צעדים קטנים', musicality: 'מוזיקליות, קצב, ספירות, אינטרו, מבנה השיר', styling: 'סטיילינג ידיים, שיער וגוף למובילים ולמובלות', sensual: 'חיבוק צמוד, הטיות, גלים בזוג בסגנון סנסואל', tricks: 'טריקים, דיפים, הרמות', choreo: 'כוריאוגרפיה או רצף להופעה', drills: 'תרגילים לאימון אישי או זוגי' },
    aria: { ai: 'ניתוח אוטומטי עם Gemini', back: 'חזרה', settings: 'הגדרות', add: 'שיעור חדש', close: 'סגירה', edit: 'עריכה', drive: 'פתיחה ב‑Drive', remove: 'הסרה', addFigure: 'סימון פרק בזמן הנוכחי', mirror: 'מראה', repeat: 'חזרה על קטע', fullscreen: 'מסך מלא', pip: 'תמונה בתוך תמונה', play: 'נגן', pause: 'השהיה', back5: 'אחורה 5 שניות', fwd5: 'קדימה 5 שניות', speed: 'מהירות', delete: 'מחיקה', signout: 'התנתקות', rescan: 'סריקה', save: 'שמירה' }
  },
  en: {
    dir: 'ltr', locale: 'en-GB',
    library: 'My lessons', schools: 'Schools', settings: 'Settings', addLesson: 'New lesson', editLesson: 'Edit lesson', tagLesson: 'Tag this recap',
    tagline: 'Your lesson recaps, organized by school, streamed from your own Google Drive. Nothing is stored anywhere else.',
    signin: 'Sign in with Google', signinHint: 'Asks only for access to files this app creates in your Drive.',
    setupTitle: 'One-time setup', setupBody: 'This copy of the app has no Google client ID yet. Create one in the Google Cloud console, then paste it below.',
    setupStep1: 'Create a project and enable the Google Drive API.', setupStep2: 'Under Google Auth Platform set up branding, choose audience External, add the drive.file scope, and publish.', setupStep3: 'Create an OAuth client of type Web application with:', origin: 'Authorized JavaScript origin', redirect: 'Authorized redirect URI',
    pasteClient: 'Paste client ID (ends with .apps.googleusercontent.com)', saveSignin: 'Save and sign in',
    all: 'All', untagged: 'Untagged', search: 'Search figures, schools, notes', allSchools: 'All schools', allStylesLabel: 'All styles', privateTeachers: 'Private teachers', reset: 'Reset', pickSource: 'Choose a school or teacher.',
    noRecaps: 'No recaps yet', emptyTitle: 'No recaps yet.', emptyBody: 'Tap + to add the first one. It uploads to a “Bachata Library” folder in your Google Drive.', nothingMatches: 'Nothing matches this filter.',
    group: 'Group', private: 'Private', groupLesson: 'Group class', privateLesson: 'Private',
    untaggedRecap: 'Untagged recap', tapToTag: 'tap to tag', needsTag: 'Needs school & figures', recap: 'recap', recorded: 'Recorded',
    figures: 'Chapters', notes: 'Notes', noNotes: 'No notes yet. Add some via edit.', figureName: 'Chapter name', noTime: 'no time', noChapters: 'No chapters yet. Play to the moment you want and tap + to mark a chapter at the current time.',
    title: 'Title', titlePh: 'e.g. Hammerlock and sombrero exit', desc: 'Description', descPh: 'What the lesson covered: figures, corrections, focus points', deleteArmToast: 'Tap the trash icon again to delete the video from Drive.',
    repeatA: a => `Start marked at ${a}. Tap again at the end of the section.`, repeatOn: (a, b) => `Repeating ${a}–${b}.`, repeatOff: 'Repeat cleared.',
    ai: 'Auto-fill', aiIdle: 'Fill title, description, tags and chapters from the video with Gemini.', aiNeedKey: 'A Gemini API key is needed. Add it in Settings.', aiDownloading: p => `Downloading the video from Drive… ${p}%`, aiUploading: p => `Uploading for analysis… ${p}%`, aiRelay: p => `Relaying the video from Drive for analysis… ${p}%`, aiRefreshing: 'Refreshing the Drive sign-in before analysis…', aiProcessing: 'Gemini is processing the video…', aiAnalyzing: 'Analyzing the lesson…', aiRetry: 'The model is busy, retrying in a moment…', aiFallback: m => `Switching to ${m}…`, aiBusy: 'Gemini is overloaded right now. Try again in a few minutes.', aiDone: 'Title, description, tags and chapters filled in. Review and save.', aiFailed: 'Analysis failed. ', aiBadKey: 'The key is invalid, or restricted to another website.', aiQuota: 'Gemini quota exceeded for today. Try again later.', aiBadModel: 'Model name not found. Check it in Settings.',
    geminiKey: 'Gemini API key', geminiHelp: 'The key is stored in your Drive folder and syncs across your devices. The video is sent to Gemini for analysis and deleted there right after. On the free tier Google may use content to improve its models.', geminiModelHint: 'Model name. Empty = default', getKey: 'Create a key in Google AI Studio', keySaved: 'Gemini settings saved.', badGeminiKey: 'That does not look like a Gemini API key.',
    help: 'Help', helpItems: [['ai', 'Auto-fill', 'With a Gemini API key from Settings, the sparkle button in the form fills the title, description, tags and chapters from the video. Review before saving.'], ['back5', 'Skip', 'The arrows on the video skip 5 seconds back or forward. Tap the video to show or hide them.'], ['repeat', 'Repeat a section', 'First tap marks the start (A), second marks the end (B), and the section loops until a third tap.'], ['mirror', 'Mirror', 'Flips the video horizontally, like watching in the studio mirror. Handy when facing the teacher.'], ['plus', 'Chapters', 'On a lesson, play to the moment you want and tap + to mark a chapter at the current time. Tap a chapter to jump to it.'], ['pip', 'Picture in picture', 'Keeps playing in a small window over other apps.'], ['fs', 'Fullscreen', 'Opens the video in the device player. Rotate the phone for landscape clips.']],
    noPip: 'This browser does not support picture-in-picture.', playFirst: 'Start playing first.',
    chooseVideo: 'Choose a video or recording', fromWhere: 'Photo Library, Files, camera or voice recording', audioLesson: 'Audio recording', alreadyInDrive: 'already in Drive', reading: 'reading…', previewNA: 'preview unavailable',
    style: 'Style', otherStyle: 'Other…', styleName: 'Style name', lessonType: 'Lesson', school: 'School', teacher: 'Teacher', newSchool: '+ New school…', newTeacher: '+ New teacher…', leaveUntagged: 'Leave untagged for now', name: 'Name',
    privateHint: 'Private lessons are filed under the teacher’s name instead of a school.', date: 'Date', figuresCovered: 'Figures covered', figuresPh: 'Sombrero, hammerlock exit, body roll', notesOptional: 'Notes', notesPh: 'What to practice, corrections, homework',
    saveUpload: 'Save & upload to Drive', saveChanges: 'Save changes', uploading: 'Uploading…', uploadingPct: p => `Uploading… ${p}% · keep the app open`, finishing: 'Finishing…', savedToIndex: 'Changes are saved to the index in your Drive.', pickTagDone: 'Pick the recap, tag it, done.', skipHint: 'Skip the fields and it lands under “Untagged”.',
    deleteArm: 'Tap again to move the video to the Drive trash.', deleteIdle: 'Delete this recap', deleted: 'Moved to the Drive trash.', deleteFailed: 'Delete failed. ',
    pickFirst: 'Pick a video or recording first.', typeName: k => `Type the ${k} name.`, typeStyle: 'Type the style name.', saved: 'Saved.', uploaded: 'Uploaded to Drive.', uploadedUntagged: 'Uploaded. It is waiting under Untagged.', saveFailed: 'Save failed. ', nothingLost: 'Something went wrong. Nothing was lost; try again.', waitUpload: 'Upload in progress. Wait for it to finish.',
    couldNotReach: 'Could not reach Google Drive. ', couldNotLoadVideo: 'Could not load this video. ', couldNotPlay: 'Could not play this video. It may use a format this browser cannot decode.', loadingVideo: 'Loading video…', loadingPct: p => `Loading video… ${p}%`, buffering: 'Buffering…',
    marked: (n, t) => `“${n}” marked at ${t}.`, removed: n => `Removed “${n}”.`, couldNotSave: 'Could not save. ', typeFigure: 'Type the figure name.',
    schoolsSub: 'Private teachers listed alongside. Tap one to filter.', noSchools: 'No schools yet.', noTeachers: 'No private teachers yet.', privateTeacher: 'Private teacher', groupClasses: 'Group classes', addSource: 'Add', schoolsAuto: 'Schools and teachers also appear automatically when you tag a recap.', alreadyListed: 'Already in the list.', added: n => `Added ${n}.`, removedSource: n => `Removed ${n}.`, moveFirst: 'Move or delete its recaps first.', last: 'last',
    signedInAs: e => `Signed in as ${e}`, signedIn: 'Signed in', storage: 'Storage', storageBody: 'Everything lives in a folder called Bachata Library in your Google Drive: one subfolder per school or teacher, the videos, and a small index file.', openDrive: 'Open the folder in Drive', maintenance: 'Maintenance', rescan: 'Rescan Drive and repair the index', rescanHint: 'Adds recaps uploaded from another device or missing from this list, and removes entries whose files were deleted.', scanning: 'Scanning…', rescanDone: (a, r) => `Done. ${a} added, ${r} removed.`, rescanFailed: 'Rescan failed. ',
    account: 'Account', signOut: 'Sign out', signOutHint: 'Signs out on this device only. Nothing in Drive is touched.', language: 'Language', appearance: 'Appearance', themeDark: 'Dark', themeLight: 'Light', themeAuto: 'Automatic', advanced: 'Advanced', clientId: 'Google OAuth client ID', clientHint: 'Only needed if you run your own copy of this app.', badClient: 'That does not look like a Google client ID.', clientSaved: 'Client ID saved.', addClientFirst: 'Add the Google client ID first.',
    signInAgain: 'Please sign in again.', signinCheckFailed: 'Sign-in check failed. Please try again.', driveNotGranted: 'Drive access was not granted. Sign in again and keep the Google Drive box ticked.',
    recapsN: n => `${n} recap${n === 1 ? '' : 's'}`, schoolsN: n => `${n} school${n === 1 ? '' : 's'}`, teachersN: n => `${n} private teacher${n === 1 ? '' : 's'}`,
    styles: { bachata: 'Bachata', salsa: 'Salsa', kizomba: 'Kizomba', zouk: 'Zouk' },
    tagsLabel: 'Tags',
    tags: { basics: 'Basics', footwork: 'Footwork', turns: 'Turns', elements: 'Elements & variations', bodymove: 'Body movement', isolations: 'Isolations', leadfollow: 'Lead & follow', technique: 'Technique & posture', musicality: 'Musicality & rhythm', styling: 'Styling', sensual: 'Sensual', tricks: 'Tricks & dips', choreo: 'Choreography', drills: 'Drills' },
    tagHints: { basics: 'basic steps, taps and basic variations', footwork: 'footwork, syncopations, Dominican style, shines', turns: 'turns, spins, preps, spotting', elements: 'partner figures such as hammerlock, sombrero, shadow, wrap, cross body lead, their variations and combinations', bodymove: 'body waves, body rolls, cambré, head movement', isolations: 'hip, chest and shoulder isolations', leadfollow: 'leading and following, connection, tension, holds', technique: 'posture, frame, weight transfer, small steps', musicality: 'musicality, rhythm, counting, intros, song structure', styling: 'arm, hair and body styling for leads and follows', sensual: 'close embrace, tilts, partnered waves in sensual style', tricks: 'tricks, dips, lifts', choreo: 'a choreography or performance routine', drills: 'solo or partner practice exercises' },
    aria: { ai: 'Auto-fill with Gemini', back: 'Back', settings: 'Settings', add: 'New lesson', close: 'Close', edit: 'Edit', drive: 'Open in Drive', remove: 'Remove', addFigure: 'Mark a chapter at the current time', mirror: 'Mirror', repeat: 'Repeat a section', fullscreen: 'Fullscreen', pip: 'Picture in picture', play: 'Play', pause: 'Pause', back5: 'Back 5 seconds', fwd5: 'Forward 5 seconds', speed: 'Speed', delete: 'Delete', signout: 'Sign out', rescan: 'Rescan', save: 'Save' }
  }
};
let lang = localStorage.getItem(LS.lang) || 'he';
let T = STR[lang] || STR.he;
let theme = THEMES.includes(localStorage.getItem(LS.theme)) ? localStorage.getItem(LS.theme) : 'dark';

// ---------- state ----------
let token = null;            // { access_token, expires_at }
let root = null;             // { id, indexId, thumbsId }
let lib = emptyLib();
let filter = { kind: 'all', value: null, style: null };
let query = '';
let current = null;          // lesson shown on the detail screen
let thumbs = {};             // lessonId -> object URL
let thumbLinks = {};         // lessonId -> Drive thumbnailLink (fallback for imported files)
let pending = null;          // file picked in the add form
let editing = null;          // lesson being edited
let formType = 'group';
let formStyle = DEFAULT_STYLE;
let uploading = false;
let loopA = null, loopB = null;
let lastSync = 0;
let video, toastTimer;
let pendingAi = null;        // last Gemini result waiting to be saved with the form
let formChapters = [];       // chapters shown in the add/edit form; saved with it
let formTags = [];           // tag keys selected in the add/edit form
let aiBusy = false;
let blobUrl = null;          // object URL when a video was downloaded whole
let mediaTriedBlob = false;  // fallback already attempted for the current lesson

// ---------- helpers ----------
function emptyLib() { return { version: 2, updatedAt: null, sources: [], styles: [], lessons: [], settings: { geminiKey: '', geminiModel: '' } }; }
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const qesc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const nowIso = () => new Date().toISOString();
const dateOf = iso => { const d = new Date(iso + 'T12:00:00'); return isNaN(d) ? null : d; };
const fmtDate = iso => { const d = dateOf(iso); return d ? d.toLocaleDateString(T.locale, { day: 'numeric', month: 'short' }) : (iso || ''); };
const fmtDateLong = iso => { const d = dateOf(iso); return d ? d.toLocaleDateString(T.locale, { weekday: 'long', day: 'numeric', month: 'long' }) : (iso || ''); };
const monthOf = iso => { const d = dateOf(iso); return d ? d.toLocaleDateString(T.locale, { month: 'long', year: 'numeric' }) : '—'; };
const fmtDur = s => (s == null || !isFinite(s)) ? '' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const isoDate = d => { const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return x.toISOString().slice(0, 10); };
const shortErr = e => String((e && e.message) || e).slice(0, 160);
const hue = id => ['', 't2', 't3'][String(id || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 3];
const icon = (name, cls = 'i') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const styleName = s => (s && T.styles[s]) || s || '';
const tagLabel = k => (T.tags && T.tags[k]) || k;
const typeLabel = (t, long) => t === 'private' ? (long ? T.privateLesson : T.private) : (long ? T.groupLesson : T.group);

function toast(msg, ms = 3200) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function normalize(d) {
  const out = emptyLib();
  out.updatedAt = d.updatedAt || null;
  out.sources = (d.sources || []).filter(s => s && s.name).map(s => ({ name: String(s.name), kind: s.kind === 'private' ? 'private' : 'school', folderId: s.folderId || null }));
  out.styles = (d.styles || []).filter(s => typeof s === 'string' && s.trim()).map(s => s.trim());
  const st = d.settings || {};
  out.settings = { geminiKey: typeof st.geminiKey === 'string' ? st.geminiKey.trim() : '', geminiModel: typeof st.geminiModel === 'string' ? st.geminiModel.trim() : '' };
  out.lessons = (d.lessons || []).filter(l => l && l.id).map(l => {
    let figures = (l.figures || []).map(f => typeof f === 'string' ? { name: f, t: null } : { name: String(f.name || ''), t: (f.t == null ? null : +f.t) }).filter(f => f.name);
    let title = (l.title == null ? '' : String(l.title)).trim();
    // Older records had no title; the figures typed in the form served as one. Turn those
    // untimed entries into the title and keep only real chapters (entries with a time).
    if (!title && figures.some(f => f.t == null)) { title = figures.filter(f => f.t == null).map(f => f.name).join(' · '); figures = figures.filter(f => f.t != null); }
    return {
      id: String(l.id), thumbId: l.thumbId || null, name: l.name || '', date: l.date || '', source: l.source || null,
      type: l.type === 'private' ? 'private' : (l.type === 'group' ? 'group' : null),
      style: (l.style && String(l.style).trim()) || DEFAULT_STYLE, title, desc: (l.desc == null ? '' : String(l.desc)).trim(), figures,
      tags: [...new Set((Array.isArray(l.tags) ? l.tags : []).map(String).filter(t => TAG_KEYS.includes(t)))],
      note: l.note || '', duration: l.duration == null ? null : +l.duration, size: l.size == null ? null : +l.size,
      mimeType: l.mimeType || '', createdAt: l.createdAt || null, updatedAt: l.updatedAt || null
    };
  });
  return out;
}
function sortLessons() { lib.lessons.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || '')); }
function sortSources() { lib.sources.sort((a, b) => a.name.localeCompare(b.name, T.locale)); }
// The chosen filters survive a relaunch; anything that no longer exists falls back to "all".
function saveFilter() { try { localStorage.setItem(LS.filter, JSON.stringify(filter)); } catch (e) { /* ignore */ } }
function loadFilter() {
  try {
    const f = JSON.parse(localStorage.getItem(LS.filter)); if (!f || typeof f !== 'object') return;
    const style = f.style && allStyles().includes(f.style) ? f.style : null;
    const source = f.kind === 'source' && f.value && lib.sources.some(s => s.name === f.value) ? f.value : null;
    filter = { kind: source ? 'source' : 'all', value: source, style };
  } catch (e) { /* keep defaults */ }
}
function persistLocal() { try { localStorage.setItem(LS.lib, JSON.stringify(lib)); } catch (e) { /* storage full or disabled */ } }
function allStyles() {
  const set = new Set(BASE_STYLES);
  lib.styles.forEach(s => set.add(s));
  lib.lessons.forEach(l => { if (l.style) set.add(l.style); });
  return [...set];
}
function usedStyles() { const set = new Set(); lib.lessons.forEach(l => set.add(l.style || DEFAULT_STYLE)); return [...set]; }

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

// ---------- language ----------
function applyLanguage() {
  T = STR[lang] || STR.he;
  document.documentElement.lang = lang; document.documentElement.dir = T.dir;
  document.querySelectorAll('[data-t]').forEach(el => { const v = T[el.dataset.t]; if (typeof v === 'string') el.textContent = v; });
  document.querySelectorAll('[data-ph]').forEach(el => { const v = T[el.dataset.ph]; if (typeof v === 'string') el.placeholder = v; });
  document.querySelectorAll('[data-aria]').forEach(el => { const v = T.aria[el.dataset.aria]; if (v) { el.setAttribute('aria-label', v); el.title = v; } });
  if (video) setPlayIcon(!video.paused);
}
function setLanguage(l) { lang = STR[l] ? l : 'he'; localStorage.setItem(LS.lang, lang); applyLanguage(); render(); }

// ---------- appearance ----------
// Dark is the default; "auto" follows the system. The resolved theme goes on <html> so the
// stylesheet, form controls (color-scheme) and the status bar (theme-color) all agree.
const lightMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
function resolvedTheme() { return theme === 'auto' ? (lightMq && lightMq.matches ? 'light' : 'dark') : theme; }
function applyTheme() {
  const t = resolvedTheme();
  document.documentElement.dataset.theme = t;
  const tc = document.querySelector('meta[name=theme-color]'); if (tc) tc.content = t === 'light' ? '#f2f2f7' : '#000000';
  const cs = document.querySelector('meta[name=color-scheme]'); if (cs) cs.content = t;
}
function setTheme(v) { theme = THEMES.includes(v) ? v : 'dark'; localStorage.setItem(LS.theme, theme); applyTheme(); renderSettings(); }

// ---------- auth (OAuth 2.0 implicit flow via redirect; works inside iOS home-screen apps) ----------
function clientId() { return (localStorage.getItem(LS.clientId) || CFG.GOOGLE_CLIENT_ID || '').trim(); }
function redirectUri() { let p = location.pathname.replace(/index\.html$/, ''); if (!p.endsWith('/')) p += '/'; return location.origin + p; }
function tokenValid() { return !!(token && token.access_token && token.expires_at > Date.now()); }
function loadToken() { try { const t = JSON.parse(localStorage.getItem(LS.token)); if (t && t.expires_at > Date.now()) token = t; } catch (e) { token = null; } return token; }

function startAuth({ silent = false } = {}) {
  const id = clientId();
  if (!id) { show('auth'); toast(T.addClientFirst); return false; }
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
  if (expected && h.get('state') !== expected) { toast(T.signinCheckFailed); return 'error'; }
  // Google lets users untick individual permissions. Without Drive access the app cannot work.
  const granted = (h.get('scope') || '').split(/[\s+]+/);
  if (granted.length && !granted.some(s => s.endsWith('/auth/drive.file'))) {
    sessionStorage.setItem(SS.needConsent, '1');
    toast(T.driveNotGranted, 7000);
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
  if (!/\.apps\.googleusercontent\.com$/.test(v)) { toast(T.badClient); return; }
  localStorage.setItem(LS.clientId, v);
  toast(T.clientSaved);
  if (!tokenValid()) startAuth({});
  else renderSettings();
}

function signOut() {
  const t = token && token.access_token;
  token = null; root = null; lib = emptyLib(); thumbs = {}; thumbLinks = {}; current = null;
  [LS.token, LS.lib, LS.root, LS.hint, LS.filter].forEach(k => localStorage.removeItem(k)); filter = { kind: 'all', value: null, style: null };
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
      lib.lessons.push({ id: f.id, thumbId: null, name: f.name, date: ap.date || (f.createdTime || '').slice(0, 10), source, type, style: ap.style || DEFAULT_STYLE, title: '', desc: '', figures: [], tags: [], note: '',
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
  catch (e) { if (e.message !== 'signed out') { console.error(e); toast(T.couldNotReach + shortErr(e)); } }
}

async function rescan(btn) {
  if (btn) btn.disabled = true;
  try { const r = await syncFiles({ prune: true }); toast(T.rescanDone(r.added, r.removed)); }
  catch (e) { if (e.message !== 'signed out') toast(T.rescanFailed + shortErr(e)); }
  finally { if (btn) btn.disabled = false; }
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
const AUDIO_EXT = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', caf: 'audio/x-caf', aif: 'audio/aiff', aiff: 'audio/aiff', amr: 'audio/amr' };
function mimeOf(f) { if (f.type) return f.type; const ext = extOf(f.name); return AUDIO_EXT[ext] || { mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', mkv: 'video/x-matroska' }[ext] || 'video/mp4'; }
// A lesson recorded as sound only (voice memo, phone recording). Same player, shown with a waveform instead of a frame.
function isAudio(x) { const m = (x && (x.mimeType || x.type)) || ''; if (m) return /^audio\//i.test(m); return !!AUDIO_EXT[extOf(x && x.name)]; }

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
function lastStyle() { const l = lastLesson(); return (l && l.style) || DEFAULT_STYLE; }
function lastSource(kind) { const l = lib.lessons.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).find(x => x.source && x.type === (kind === 'private' ? 'private' : 'group')); return l ? l.source : null; }
function allFigureNames() { const set = new Set(); lib.lessons.forEach(l => l.figures.forEach(f => set.add(f.name))); return [...set].sort((a, b) => a.localeCompare(b, T.locale)); }
function lessonTitle(l) {
  if (l.title) return l.title;
  return l.source ? `${l.source} · ${T.recap}` : T.untaggedRecap;
}

// ---------- screens ----------
function show(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 's-' + name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.go === name));
  $('tabbar').style.display = (name === 'library' || name === 'schools') ? '' : 'none';
  if (name !== 'library') closeSheet();
  if (name !== 'detail' && video && !video.paused) video.pause();
  if (name === 'auth') renderAuth();
  if (name === 'library') renderLibrary();
  if (name === 'schools') renderSchools();
  if (name === 'settings') { renderSettings(); $('settings-body').scrollTop = 0; }
}
function render() {
  const active = document.querySelector('.screen.active'); const id = active ? active.id : '';
  if (id === 's-library') renderLibrary(); else if (id === 's-schools') renderSchools(); else if (id === 's-settings') renderSettings(); else if (id === 's-detail' && current) renderDetail(); else if (id === 's-auth') renderAuth();
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
// Two filter buttons (style, school/teacher). Each opens a bottom sheet listing the options with
// the number of lessons behind each one, counted with the other filter already applied.
function renderFilters() {
  const sb = $('flt-style'), ob = $('flt-source');
  const styleOn = !!filter.style, srcOn = filter.kind === 'source' && !!filter.value;
  sb.classList.toggle('on', styleOn); sb.innerHTML = `<span>${esc(styleOn ? styleName(filter.style) : T.style)}</span>${icon('down')}`;
  ob.classList.toggle('on', srcOn); ob.innerHTML = `<span>${esc(srcOn ? filter.value : T.school)}</span>${icon('down')}`;
}
let sheetKind = null;
function openSheet(kind) {
  sheetKind = kind;
  const byStyle = l => !filter.style || (l.style || DEFAULT_STYLE) === filter.style;
  const bySource = l => filter.kind !== 'source' || l.source === filter.value;
  const row = (label, value, on, count, cls = '') => `<button class="orow" data-value="${esc(value == null ? '' : value)}">${cls ? '<span class="dot"></span>' : ''}<span class="n">${esc(label)}</span><span class="c">${count}</span>${on ? icon('check', 'i ck') : ''}</button>`;
  let h = '';
  if (kind === 'style') {
    const base = lib.lessons.filter(bySource);
    $('sheet-title').textContent = T.style;
    h = `<div class="orows">${row(T.allStylesLabel, null, !filter.style, base.length)}${allStyles().map(s => row(styleName(s), s, filter.style === s, base.filter(l => (l.style || DEFAULT_STYLE) === s).length)).join('')}</div>`;
  } else {
    const base = lib.lessons.filter(byStyle);
    const cnt = name => base.filter(l => l.source === name).length;
    const schools = lib.sources.filter(s => s.kind === 'school'), priv = lib.sources.filter(s => s.kind === 'private');
    $('sheet-title').textContent = T.school;
    h = `<div class="orows">${row(T.allSchools, null, filter.kind !== 'source', base.length)}</div>`;
    if (schools.length) h += `<div class="shead">${esc(T.schools)}</div><div class="orows">${schools.map(s => row(s.name, s.name, filter.kind === 'source' && filter.value === s.name, cnt(s.name))).join('')}</div>`;
    if (priv.length) h += `<div class="shead">${esc(T.privateTeachers)}</div><div class="orows">${priv.map(s => row(s.name, s.name, filter.kind === 'source' && filter.value === s.name, cnt(s.name), 'priv')).join('')}</div>`;
  }
  $('sheet-body').innerHTML = h;
  const w = $('sheet'); w.hidden = false; w.querySelector('.sheet').scrollTop = 0;
  requestAnimationFrame(() => requestAnimationFrame(() => w.classList.add('open')));
}
function closeSheet() {
  const w = $('sheet'); if (w.hidden) return;
  w.classList.remove('open'); sheetKind = null;
  setTimeout(() => { if (!w.classList.contains('open')) w.hidden = true; }, 320);
}
function pickSheet(value) {
  if (sheetKind === 'style') filter.style = value || null;
  else filter = { kind: value ? 'source' : 'all', value: value || null, style: filter.style };
  saveFilter(); closeSheet(); renderLibrary();
}
function visibleLessons() {
  let items = lib.lessons.slice();
  if (filter.style) items = items.filter(l => (l.style || DEFAULT_STYLE) === filter.style);
  if (filter.kind === 'untagged') items = items.filter(l => !l.source);
  if (filter.kind === 'source') items = items.filter(l => l.source === filter.value);
  const q = query.trim().toLowerCase();
  if (q) items = items.filter(l => [l.title, l.desc, l.note, ...l.figures.map(f => f.name), ...l.tags.map(tagLabel)].filter(Boolean).some(v => String(v).toLowerCase().includes(q)));
  return items;
}
function renderLibrary() {
  renderFilters();
  $('lib-sub').textContent = lib.lessons.length ? T.recapsN(lib.lessons.length) : T.noRecaps;
  const items = visibleLessons();
  if (!items.length) {
    $('list').innerHTML = `<div class="empty">${lib.lessons.length ? esc(T.nothingMatches) : `<b>${esc(T.emptyTitle)}</b><br>${esc(T.emptyBody)}`}</div>`;
    return;
  }
  const showStyle = usedStyles().length > 1;
  let h = '', last = '';
  for (const l of items) {
    const m = monthOf(l.date); if (m !== last) { h += `<div class="month">${esc(m)}</div>`; last = m; }
    const who = l.source ? `${l.source} · ${typeLabel(l.type)} · ${fmtDate(l.date)}` : `${T.recorded} ${fmtDate(l.date)} · ${T.tapToTag}`;
    const badges = l.source
      ? (showStyle ? `<span class="stl">${esc(styleName(l.style))}</span>` : '') + l.tags.slice(0, 3).map(t => `<span class="tag">${esc(tagLabel(t))}</span>`).join('')
      : `<span class="tag">${esc(T.needsTag)}</span>`;
    const aud = isAudio(l);
    h += `<button class="card ${l.source ? '' : 'untagged'}" data-id="${esc(l.id)}">
      <div class="thumb ${hue(l.id)}${aud ? ' audio' : ''}">${aud ? icon('audio', 'i aud') : `<img data-thumb="${esc(l.id)}" alt="">`}<div class="play"></div>${l.duration ? `<div class="dur">${fmtDur(l.duration)}</div>` : ''}</div>
      <div class="meta"><div class="title">${esc(lessonTitle(l).replace(/\s*\n+\s*/g, ' '))}</div><div class="who">${esc(who)}</div><div class="badges">${badges}</div></div></button>`;
  }
  $('list').innerHTML = h;
  loadThumbs($('list'));
}

// Lesson detail
async function openDetail(id) {
  const l = lib.lessons.find(x => x.id === id); if (!l) return;
  current = l; loopReset(); setRate(1); toggleSpeedMenu(false); setPlayIcon(false); $('s-detail').classList.remove('hidectl');
  video.classList.remove('mirror'); $('btn-mirror').classList.remove('on');
  $('btn-drive').href = `https://drive.google.com/file/d/${encodeURIComponent(l.id)}/view`;
  const dd = $('detail-delete'); dd.dataset.armed = ''; dd.classList.remove('armed'); dd.disabled = false;
  $('s-detail').classList.toggle('audio', isAudio(l));
  show('detail'); renderDetail();
  $('detail-scroll').scrollTop = 0;
  loadMedia(l);
}
function renderDetail() {
  const l = current; if (!l) return;
  const figs = l.figures;
  const meta = [l.source || T.untagged, l.type ? typeLabel(l.type, true) : null, fmtDateLong(l.date)].filter(Boolean).map(esc).join(' <span class="dim">·</span> ');
  $('detail-body').innerHTML = `
    <div class="ttl2">${esc(lessonTitle(l).replace(/\s*\n+\s*/g, ' '))}</div>
    <div class="meta2"><span>${meta}</span><span class="stl">${esc(styleName(l.style))}</span></div>
    ${l.tags.length ? `<div class="tagrow">${l.tags.map(t => `<span class="tag">${esc(tagLabel(t))}</span>`).join('')}</div>` : ''}
    ${l.desc ? `<div class="desc">${esc(l.desc).replace(/\n/g, '<br>')}</div>` : ''}
    <h3>${esc(T.figures)}</h3>
    ${figs.length ? '' : `<div class="chapters-empty">${esc(T.noChapters)}</div>`}
    ${figs.map((f, i) => `<div class="fig" data-fig="${i}" role="button"><span class="fname">${esc(f.name)}</span><span class="tm">${f.t != null ? fmtDur(f.t) : '·'}</span><button class="x ib" data-remove="${i}" aria-label="${esc(T.aria.remove)}">${icon('close')}</button></div>`).join('')}
    <button class="fig add" id="mark-row" aria-label="${esc(T.aria.addFigure)}" title="${esc(T.aria.addFigure)}">${icon('plus')}</button>
    <div class="markwrap" id="mark-wrap" hidden><div class="input"><input id="mark-name" placeholder="${esc(T.figureName)}" list="fig-names" autocomplete="off"><button class="mini" id="mark-add" aria-label="${esc(T.aria.save)}">${icon('check')}</button></div><datalist id="fig-names">${allFigureNames().map(n => `<option value="${esc(n)}">`).join('')}</datalist></div>
    ${l.note ? `<h3>${esc(T.notes)}</h3><div class="note">${esc(l.note).replace(/\n/g, '<br>')}</div>` : ''}`;
}
function onDetailClick(e) {
  if (!current) return;
  const rm = e.target.closest('[data-remove]');
  if (rm) { e.stopPropagation(); const i = +rm.dataset.remove; const f = current.figures[i]; if (!f) return; current.figures.splice(i, 1); current.updatedAt = nowIso(); renderDetail(); saveLibrary().then(() => toast(T.removed(f.name))).catch(err => toast(T.couldNotSave + shortErr(err))); return; }
  if (e.target.closest('#mark-row')) { $('mark-wrap').hidden = false; $('mark-name').focus(); if (!video.paused) video.pause(); return; }
  if (e.target.closest('#mark-add')) { submitMark(); return; }
  const row = e.target.closest('[data-fig]');
  if (row) { const f = current.figures[+row.dataset.fig]; if (f && f.t != null) { video.currentTime = f.t; video.play().catch(() => {}); } }
}
function submitMark() {
  const name = ($('mark-name').value || '').trim(); if (!name) { toast(T.typeFigure); return; }
  const t = Math.round((video.currentTime || 0) * 10) / 10;
  const ex = current.figures.find(f => f.name.toLowerCase() === name.toLowerCase());
  if (ex) ex.t = t; else current.figures.push({ name, t });
  current.figures.sort((a, b) => (a.t == null ? 1e9 : a.t) - (b.t == null ? 1e9 : b.t));
  current.updatedAt = nowIso();
  renderDetail();
  saveLibrary().then(() => toast(T.marked(name, fmtDur(t)))).catch(err => toast(T.couldNotSave + shortErr(err)));
}

// ---------- player ----------
// A <video> element cannot send an Authorization header, and Google rejects the token as a URL
// parameter for media. Route 1: a same-origin virtual URL that the service worker turns into an
// authenticated, range-preserving Drive request (true streaming). Route 2, if the service worker
// is not controlling the page or the media request fails: download the file with fetch() and play
// it from a blob, showing progress. Recaps are short, so this stays practical.
async function loadMedia(l) {
  setVideoLoading('');
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  video.removeAttribute('src'); video.load();
  mediaTriedBlob = false;
  updateTime();
  let at;
  try { at = await ensureToken(); } catch (e) { return; }
  video.poster = thumbs[l.id] || '';
  const viaWorker = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;
  if (viaWorker) {
    const u = new URL('./media', location.href);
    u.searchParams.set('id', l.id); u.searchParams.set('t', at); if (l.size) u.searchParams.set('size', String(l.size));
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
    setVideoLoading(T.loadingVideo);
    const res = await fetch(`${API}/files/${encodeURIComponent(id)}?alt=media`, { headers: { Authorization: 'Bearer ' + at } });
    if (!res.ok) throw new Error('Drive error ' + res.status);
    const total = +res.headers.get('content-length') || l.size || 0;
    const reader = res.body.getReader(); const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!current || current.id !== id) { reader.cancel().catch(() => {}); setVideoLoading(''); return; }
      chunks.push(value); got += value.length;
      if (total) setVideoLoading(T.loadingPct(Math.min(99, Math.round(got / total * 100))));
    }
    if (!current || current.id !== id) return;
    const blob = new Blob(chunks, { type: res.headers.get('content-type') || l.mimeType || 'video/mp4' });
    blobUrl = URL.createObjectURL(blob);
    video.src = blobUrl; video.load();
    setVideoLoading('');
  } catch (e) {
    setVideoLoading('');
    if (e.message !== 'signed out') toast(T.couldNotLoadVideo + shortErr(e), 5000);
  }
}
function setVideoLoading(msg) { const el = $('vload'); el.textContent = msg; el.hidden = !msg; }
function setRate(r) {
  video.playbackRate = r;
  $('btn-speed').textContent = (r === 1 ? '1' : String(r)) + '×';
  $('speed-menu').innerHTML = SPEEDS.map(x => `<button type="button" class="${x === r ? 'on' : ''}" data-rate="${x}">${x}×</button>`).join('');
}
function toggleSpeedMenu(force) { const m = $('speed-menu'); m.hidden = force === undefined ? !m.hidden : !force; }
function skip(sec) { if (!video.duration) return; video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + sec)); updateTime(); }
function setPlayIcon(playing) { $('playicon').innerHTML = `<use href="#i-${playing ? 'pause' : 'play'}"/>`; $('bigplay').setAttribute('aria-label', playing ? T.aria.pause : T.aria.play); }
let fadeTimer;
function showControls() { $('s-detail').classList.remove('hidectl'); clearTimeout(fadeTimer); if (!video.paused && !(current && isAudio(current))) fadeTimer = setTimeout(() => { if (!video.paused && $('speed-menu').hidden) $('s-detail').classList.add('hidectl'); }, 4000); }
function controlsHidden() { return $('s-detail').classList.contains('hidectl'); }
function hideControls() { clearTimeout(fadeTimer); $('s-detail').classList.add('hidectl'); toggleSpeedMenu(false); }
function pct(t) { return video.duration ? (t / video.duration * 100) + '%' : '0%'; }
function updateTime() {
  const d = isFinite(video.duration) ? video.duration : 0;
  $('fill').style.width = $('knob').style.left = pct(video.currentTime || 0);
  $('time').textContent = `${fmtDur(video.currentTime || 0)} / ${fmtDur(d)}`;
  if (loopA !== null) $('mkA').style.left = pct(loopA);
  if (loopB !== null) { $('mkB').style.left = pct(loopB); $('ab').style.left = pct(loopA); $('ab').style.width = (d ? (loopB - loopA) / d * 100 : 0) + '%'; }
}
function seekFromPointer(x) {
  const r = $('scrub').getBoundingClientRect(); if (!video.duration) return;
  video.currentTime = Math.max(0, Math.min(1, (x - r.left) / r.width)) * video.duration;
}
function loopStep() {
  if (!video.duration) { toast(T.playFirst); return; }
  if (loopA === null) {
    loopA = video.currentTime; $('loop-bd').textContent = 'B'; $('loop-bd').hidden = false;
    $('mkA').hidden = false; toast(T.repeatA(fmtDur(loopA)));
    if (video.paused) video.play().catch(() => {});
  } else if (loopB === null) {
    loopB = Math.max(video.currentTime, loopA + 0.5);
    $('btn-loop').classList.add('on'); $('loop-bd').hidden = true; $('mkB').hidden = false; $('ab').hidden = false;
    toast(T.repeatOn(fmtDur(loopA), fmtDur(loopB)));
    video.currentTime = loopA; video.play().catch(() => {});
  } else { loopReset(); toast(T.repeatOff); }
  updateTime();
}
function loopReset() {
  loopA = loopB = null;
  $('btn-loop').classList.remove('on'); $('loop-bd').textContent = 'A'; $('loop-bd').hidden = false;
  ['mkA', 'mkB', 'ab'].forEach(i => { $(i).hidden = true; });
}
function enterFullscreen() {
  const player = $('player');
  if (video.webkitEnterFullscreen && /iPhone|iPad/.test(navigator.userAgent)) { video.webkitEnterFullscreen(); return; }
  if (player.requestFullscreen) player.requestFullscreen().catch(() => { if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); });
  else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
}
function pipSupported() {
  return !!(document.pictureInPictureEnabled || (typeof video.webkitSupportsPresentationMode === 'function' && video.webkitSupportsPresentationMode('picture-in-picture')) || typeof video.webkitSetPresentationMode === 'function');
}
async function togglePip() {
  try {
    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
    if (video.webkitPresentationMode === 'picture-in-picture') { video.webkitSetPresentationMode('inline'); return; }
    // iOS needs a playing video with media loaded before it will switch presentation mode.
    if (video.readyState < 1) await new Promise(res => { const h = () => { video.removeEventListener('loadedmetadata', h); res(); }; video.addEventListener('loadedmetadata', h); setTimeout(res, 3000); });
    if (video.paused) { try { await video.play(); } catch (e) { /* keep going */ } }
    if (typeof video.webkitSetPresentationMode === 'function' && (!video.webkitSupportsPresentationMode || video.webkitSupportsPresentationMode('picture-in-picture'))) { video.webkitSetPresentationMode('picture-in-picture'); return; }
    if (video.requestPictureInPicture) { await video.requestPictureInPicture(); return; }
    toast(T.noPip);
  } catch (e) { toast(T.noPip); }
}

// ---------- add / edit form ----------
function openAdd(id) {
  if (uploading) { toast(T.waitUpload); return; }
  editing = id ? (lib.lessons.find(l => l.id === id) || null) : null;
  if (pending && pending.url) URL.revokeObjectURL(pending.url);
  pending = null; $('f-file').value = ''; $('f-file').disabled = !!editing;
  const pick = $('pick');
  pick.classList.toggle('picked', !!editing); pick.classList.toggle('locked', !!editing);
  pick.querySelectorAll('img').forEach(i => i.remove());
  const editAudio = !!(editing && isAudio(editing));
  pick.classList.toggle('audio', editAudio);
  pick.querySelector('.txt').innerHTML = editing
    ? `${editAudio ? icon('audio', 'i aud') : ''}<b>${esc(editing.name)}</b><span>${editing.duration ? fmtDur(editing.duration) + ' · ' : ''}${editAudio ? esc(T.audioLesson) + ' · ' : ''}${esc(T.alreadyInDrive)}</span>`
    : `<b>${esc(T.chooseVideo)}</b><span>${esc(T.fromWhere)}</span>`;
  if (editing && !editAudio && thumbs[editing.id]) { const img = document.createElement('img'); img.src = thumbs[editing.id]; img.alt = ''; pick.prepend(img); }
  $('add-title').textContent = editing ? (editing.source ? T.editLesson : T.tagLesson) : T.addLesson;
  $('add-sub').textContent = editing ? T.savedToIndex : T.pickTagDone;
  $('f-date').value = editing && editing.date ? editing.date : isoDate(new Date());
  formType = (editing && editing.type) || lastType() || 'group';
  formStyle = (editing && editing.style) || lastStyle();
  setTypeUI(); renderStyleSeg();
  fillSources(editing ? editing.source : lastSource(formType));
  $('f-title').value = editing ? (editing.title || '') : '';
  $('f-desc').value = editing ? (editing.desc || '') : '';
  formChapters = editing ? editing.figures.map(f => ({ name: f.name, t: f.t })) : []; renderFormChapters();
  formTags = editing ? editing.tags.slice() : []; renderFormTags();
  $('f-note').value = editing ? editing.note : '';
  $('btn-save').textContent = editing ? T.saveChanges : T.saveUpload;
  $('btn-save').disabled = false;
  $('prog').style.display = 'none'; $('prog').querySelector('i').style.width = '0'; $('prog-hint').textContent = '';
  $('delete-row').hidden = !editing; disarmDelete();
  pendingAi = null; $('ai-row').hidden = !editing; setAiHint(T.aiIdle); setAiBusy(false);
  show('add');
  document.querySelector('#s-add .scroll').scrollTop = 0;
}
function setTypeUI() { document.querySelectorAll('#f-type button').forEach(b => b.classList.toggle('on', b.dataset.type === formType)); }
function renderStyleSeg() {
  const styles = allStyles();
  const isCustom = !styles.includes(formStyle) && formStyle !== '__new__';
  const seg = $('f-style');
  seg.innerHTML = styles.map(s => `<button type="button" class="${formStyle === s ? 'on' : ''}" data-style="${esc(s)}">${esc(styleName(s))}</button>`).join('')
    + `<button type="button" class="${(formStyle === '__new__' || isCustom) ? 'on' : ''}" data-style="__new__">${esc(T.otherStyle)}</button>`;
  $('f-style-new-wrap').hidden = !(formStyle === '__new__' || isCustom);
  if (isCustom) $('f-style-new').value = formStyle;
}
function fillSources(selected) {
  const kind = formType === 'private' ? 'private' : 'school';
  const opts = lib.sources.filter(s => s.kind === kind);
  const sel = $('f-source');
  sel.innerHTML = opts.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('')
    + `<option value="__new__">${esc(kind === 'private' ? T.newTeacher : T.newSchool)}</option>`;
  if (selected && opts.some(s => s.name === selected)) sel.value = selected;
  else if (opts.length) sel.value = opts[0].name;
  else sel.value = '__new__';
  $('f-source-label').textContent = kind === 'private' ? T.teacher : T.school;
  $('f-source-hint').textContent = kind === 'private' ? T.privateHint : '';
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
  const audio = isAudio(f), glyph = audio ? icon('audio', 'i aud') : '';
  const pick = $('pick'); pick.classList.add('picked'); pick.classList.toggle('audio', audio); pick.querySelectorAll('img').forEach(i => i.remove());
  pick.querySelector('.txt').innerHTML = `${glyph}<b>${esc(f.name)}</b><span dir="auto">${mb} MB · ${esc(T.reading)}</span>`;
  if (!editing) $('f-date').value = isoDate(when);
  pendingAi = null; $('ai-row').hidden = false; setAiHint(T.aiIdle);
  const v = document.createElement(audio ? 'audio' : 'video'); v.preload = 'metadata'; v.muted = true; if (!audio) v.playsInline = true; v.src = url;
  v.onloadedmetadata = () => {
    pending.duration = isFinite(v.duration) ? v.duration : null;
    pick.querySelector('.txt').innerHTML = `${glyph}<b>${esc(f.name)}</b><span dir="auto">${mb} MB${pending.duration ? ' · ' + fmtDur(pending.duration) : ''}</span>`;
    if (!audio) try { v.currentTime = Math.min(1, (v.duration || 2) / 2); } catch (e) { /* no seek */ }
  };
  v.onseeked = () => {
    if (audio) return;
    try {
      const max = 640, r = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * r); c.height = Math.round(v.videoHeight * r);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.toBlob(b => { if (b && pending && pending.file === f) { pending.poster = b; const img = document.createElement('img'); img.src = URL.createObjectURL(b); img.alt = ''; pick.prepend(img); } }, 'image/jpeg', 0.72);
    } catch (e) { /* no poster */ }
  };
  v.onerror = () => { pick.querySelector('.txt').innerHTML = `${glyph}<b>${esc(f.name)}</b><span dir="auto">${mb} MB · ${esc(T.previewNA)}</span>`; };
}

function readForm() {
  const date = $('f-date').value || isoDate(new Date());
  let source = $('f-source').value, isNew = false;
  if (source === '__new__') { source = $('f-new').value.trim(); isNew = true; }
  if (!source) source = null;
  let style = formStyle, styleNew = false;
  if (style === '__new__' || !allStyles().includes(style)) { style = $('f-style-new').value.trim(); styleNew = true; }
  return { date, source, isNew, style, styleNew, title: $('f-title').value.trim(), desc: $('f-desc').value.trim(), note: $('f-note').value.trim() };
}
function setProgress(frac) {
  const p = $('prog'); p.style.display = 'block'; p.querySelector('i').style.width = Math.round(frac * 100) + '%';
  $('prog-hint').textContent = frac < 1 ? T.uploadingPct(Math.round(frac * 100)) : T.finishing;
}
async function saveLesson() {
  if (uploading) return;
  const form = readForm();
  if (!editing && !pending) { toast(T.pickFirst); return; }
  if (form.isNew && !form.source) { toast(T.typeName(formType === 'private' ? T.teacher : T.school)); return; }
  if (!form.source) { toast(T.pickSource); return; }
  if (form.styleNew && !form.style) { toast(T.typeStyle); return; }
  uploading = true; $('btn-save').disabled = true; $('btn-delete').disabled = true;
  try {
    await ensureRoot();
    const type = form.source ? formType : null;
    if (form.styleNew && !lib.styles.includes(form.style) && !STYLE_KEYS.includes(form.style)) lib.styles.push(form.style);
    if (editing) {
      // Move or rename the file in Drive first; only touch the local record once that succeeded.
      const l = editing;
      const next = { date: form.date, source: form.source, type, style: form.style, title: form.title, desc: form.desc, note: form.note };
      next.figures = formChapters.map(c => ({ name: c.name, t: c.t })); next.tags = formTags.slice();
      const moved = l.source !== next.source || l.date !== next.date;
      if (moved) next.name = await moveLesson(Object.assign({}, l, next));
      if (form.source) ensureSource(form.source, formType);
      Object.assign(l, next, { updatedAt: nowIso() });
      await saveLibrary();
      toast(T.saved);
      const back = l; resetForm(); openDetail(back.id);
    } else {
      $('btn-save').textContent = T.uploading;
      const f = pending.file, mime = mimeOf(f);
      const parentId = form.source ? await ensureSourceFolder(form.source, formType) : root.id;
      const name = `${form.date} ${form.source || 'Untagged'}.${extOf(f.name)}`;
      const file = await resumableUpload(f, { name, parentId, mime, appProperties: { bachata: 'lesson', date: form.date, type: type || '', style: form.style }, onProgress: setProgress });
      const l = { id: file.id, thumbId: null, name: file.name || name, date: form.date, source: form.source, type, style: form.style, title: form.title, desc: form.desc, figures: formChapters.map(c => ({ name: c.name, t: c.t })), tags: formTags.slice(), note: form.note,
        duration: pending.duration != null ? Math.round(pending.duration) : (file.videoMediaMetadata && file.videoMediaMetadata.durationMillis ? Math.round(file.videoMediaMetadata.durationMillis / 1000) : null),
        size: +file.size || f.size, mimeType: file.mimeType || mime, createdAt: nowIso(), updatedAt: nowIso() };
      if (pending.poster) {
        try { const t = await uploadBlob(root.thumbsId, `${file.id}.jpg`, pending.poster, { bachata: 'thumb', lesson: file.id }); l.thumbId = t.id; thumbs[l.id] = URL.createObjectURL(pending.poster); idb.put(l.id, pending.poster); }
        catch (e) { console.warn('thumbnail upload failed', e); }
      }
      lib.lessons.unshift(l);
      await saveLibrary();
      toast(form.source ? T.uploaded : T.uploadedUntagged);
      resetForm(); show('library');
    }
  } catch (e) {
    console.error(e);
    if (e.message !== 'signed out') { toast(T.saveFailed + shortErr(e), 6000); $('prog-hint').textContent = T.nothingLost; }
  } finally {
    uploading = false; $('btn-save').disabled = false; $('btn-delete').disabled = false;
    $('btn-save').textContent = editing ? T.saveChanges : T.saveUpload;
  }
}
function resetForm() { if (pending && pending.url) URL.revokeObjectURL(pending.url); pending = null; editing = null; pendingAi = null; $('f-file').value = ''; }
async function moveLesson(l) {
  const newParent = l.source ? await ensureSourceFolder(l.source, l.type || 'group') : root.id;
  const cur = await api(`/files/${l.id}`, { query: { fields: 'parents,name' } });
  const oldParents = (cur.parents || []).filter(p => p !== newParent);
  const newName = `${l.date} ${l.source || 'Untagged'}.${extOf(l.name || cur.name)}`;
  const upd = await api(`/files/${l.id}`, { method: 'PATCH', query: { addParents: newParent, removeParents: oldParents.join(','), fields: 'id,name' }, body: { name: newName, appProperties: { bachata: 'lesson', date: l.date, type: l.type || '', style: l.style || DEFAULT_STYLE } } });
  return (upd && upd.name) || newName;
}
async function performDelete(l) {
  await api(`/files/${l.id}`, { method: 'PATCH', body: { trashed: true } });
  if (l.thumbId) api(`/files/${l.thumbId}`, { method: 'PATCH', body: { trashed: true } }).catch(() => {});
  lib.lessons = lib.lessons.filter(x => x.id !== l.id);
  await saveLibrary(); idb.del(l.id); delete thumbs[l.id];
}
let detailDeleteTimer;
async function deleteFromDetail(btn) {
  const l = current; if (!l || !btn) return;
  if (btn.dataset.armed === '1' && Date.now() - (+btn.dataset.armedAt || 0) < 400) return;
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1'; btn.dataset.armedAt = String(Date.now()); btn.classList.add('armed'); toast(T.deleteArmToast, 4000);
    clearTimeout(detailDeleteTimer); detailDeleteTimer = setTimeout(() => { btn.dataset.armed = ''; btn.classList.remove('armed'); }, 4000);
    return;
  }
  btn.disabled = true;
  try { video.pause(); await performDelete(l); toast(T.deleted); current = null; show('library'); }
  catch (e) { btn.disabled = false; btn.dataset.armed = ''; btn.classList.remove('armed'); if (e.message !== 'signed out') toast(T.deleteFailed + shortErr(e)); }
}
let deleteTimer;
function disarmDelete() { const b = $('btn-delete'); b.classList.remove('armed'); b.dataset.armed = ''; b.disabled = false; $('delete-hint').textContent = T.deleteIdle; clearTimeout(deleteTimer); }
async function deleteLesson() {
  const b = $('btn-delete'); const l = editing; if (!l || uploading) return;
  if (b.dataset.armed === '1' && Date.now() - (+b.dataset.armedAt || 0) < 400) return;
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1'; b.dataset.armedAt = String(Date.now()); b.classList.add('armed'); $('delete-hint').textContent = T.deleteArm;
    clearTimeout(deleteTimer); deleteTimer = setTimeout(() => { if (b.dataset.armed === '1') disarmDelete(); }, 4000);
    return;
  }
  b.disabled = true; $('btn-save').disabled = true;
  try {
    await performDelete(l);
    toast(T.deleted); resetForm(); current = null; show('library');
  } catch (e) { if (e.message !== 'signed out') toast(T.deleteFailed + shortErr(e)); }
  finally { disarmDelete(); $('btn-save').disabled = false; }
}

// ---------- Gemini auto-fill ----------
function setAiHint(msg) { $('ai-hint').textContent = msg || ''; }
function renderFormChapters() {
  const wrap = $('f-chapters-wrap');
  wrap.hidden = !formChapters.length;
  $('f-chapters').innerHTML = formChapters.map((c, i) => `<div class="fig"><span class="fname">${esc(c.name)}</span><span class="tm">${c.t != null ? fmtDur(c.t) : '·'}</span><button type="button" class="x ib" data-remove-chapter="${i}" aria-label="${esc(T.aria.remove)}">${icon('close')}</button></div>`).join('');
}
function renderFormTags() {
  $('f-tags').innerHTML = TAG_KEYS.map(k => `<button type="button" class="chip ${formTags.includes(k) ? 'on' : ''}" data-tag="${k}">${esc(tagLabel(k))}</button>`).join('');
}
function toggleFormTag(k) { formTags = formTags.includes(k) ? formTags.filter(t => t !== k) : TAG_KEYS.filter(t => t === k || formTags.includes(t)); renderFormTags(); }
function setAiBusy(b) { $('btn-ai').classList.toggle('busy', b); }
function mergeChapters(existing, incoming) {
  const out = existing.slice();
  incoming.forEach(c => { if (!out.some(f => f.name.toLowerCase() === c.name.toLowerCase())) out.push({ name: c.name, t: c.t }); });
  return out.sort((a, b) => (a.t == null ? 1e9 : a.t) - (b.t == null ? 1e9 : b.t));
}
// A lesson already in Drive is relayed to Gemini piece by piece with Range requests, so a long
// clip never has to fit in the phone's memory.
async function driveSource(l) {
  if (!l.size) { const meta = await api(`/files/${encodeURIComponent(l.id)}`, { query: { fields: 'size,mimeType' } }); l.size = +meta.size || 0; if (!l.mimeType && meta.mimeType) l.mimeType = meta.mimeType; }
  return {
    size: l.size, type: l.mimeType || mimeOf({ name: l.name }), name: l.name || 'lesson.mp4',
    async fetchRange(start, end) {
      const at = await ensureToken();
      const r = await fetch(`${API}/files/${encodeURIComponent(l.id)}?alt=media`, { headers: { Authorization: 'Bearer ' + at, Range: `bytes=${start}-${end}` } });
      if (!r.ok) throw new Error('Drive error ' + r.status);
      return r.blob();
    }
  };
}
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}
async function runAi() {
  if (aiBusy) return;
  const key = (lib.settings.geminiKey || '').trim();
  if (!key) { toast(T.aiNeedKey, 5000); show('settings'); return; }
  if (!window.GeminiClient) { toast(T.aiFailed); return; }
  let source = pending && pending.file;
  if (!source && !editing) { toast(T.pickFirst); return; }
  const remote = !source;
  // A relay from Drive can take minutes. If the Drive sign-in is about to expire, renew it first
  // instead of being thrown to the sign-in page halfway through.
  if (remote && token && token.expires_at - Date.now() < 15 * 60 * 1000 && localStorage.getItem(LS.hint)) { setAiHint(T.aiRefreshing); sessionStorage.setItem(SS.silent, '1'); if (startAuth({ silent: true })) return; }
  aiBusy = true; setAiBusy(true); keepAwake(true);
  try {
    if (remote) source = await driveSource(editing);
    const res = await window.GeminiClient.analyzeVideo(source, {
      key, model: lib.settings.geminiModel || window.GeminiClient.DEFAULT_MODEL, lang,
      tags: TAG_KEYS.map(k => ({ key: k, label: tagLabel(k), hint: (T.tagHints && T.tagHints[k]) || '' })),
      onProgress: p => { if (p.stage === 'upload') setAiHint((remote ? T.aiRelay : T.aiUploading)(Math.round((p.frac || 0) * 100))); else if (p.stage === 'process') setAiHint(T.aiProcessing); else if (p.stage === 'retry') setAiHint(T.aiRetry); else if (p.stage === 'fallback') setAiHint(T.aiFallback(p.detail || '')); else setAiHint(T.aiAnalyzing); }
    });
    if (res.title) $('f-title').value = res.title;
    if (res.desc) $('f-desc').value = res.desc;
    if (res.chapters.length) { formChapters = editing ? mergeChapters(formChapters, res.chapters) : res.chapters.map(c => ({ name: c.name, t: c.t })); renderFormChapters(); }
    if (res.tags && res.tags.length) { formTags = TAG_KEYS.filter(k => formTags.includes(k) || res.tags.includes(k)); renderFormTags(); }
    pendingAi = res;
    setAiHint(T.aiDone); toast(T.aiDone, 4000);
  } catch (e) {
    console.error(e);
    if (e.message === 'signed out') return;
    const kind = e && e.kind;
    setAiHint(kind === 'key' ? T.aiBadKey : kind === 'quota' ? T.aiQuota : kind === 'busy' ? T.aiBusy : kind === 'model' ? T.aiBadModel : T.aiFailed + shortErr(e));
  } finally { aiBusy = false; setAiBusy(false); keepAwake(false); }
}
function saveGeminiSettings() {
  const key = ($('set-gemini-key').value || '').trim();
  const model = ($('set-gemini-model').value || '').trim();
  if (key && !/^AIza[0-9A-Za-z_-]{20,}$/.test(key)) { toast(T.badGeminiKey); return; }
  lib.settings.geminiKey = key; lib.settings.geminiModel = model;
  saveLibrary().then(() => toast(T.keySaved)).catch(err => toast(T.couldNotSave + shortErr(err)));
}

// ---------- schools ----------
function renderSchools() {
  const row = s => {
    const ls = lib.lessons.filter(l => l.source === s.name); const last = ls.map(l => l.date).sort().pop();
    return `<button class="trow" data-source="${esc(s.name)}"><div><div class="n">${esc(s.name)}</div><div class="s">${esc(s.kind === 'private' ? T.privateTeacher : T.groupClasses)}</div></div>
      <div class="count">${esc(T.recapsN(ls.length))}${last ? `<br>${esc(T.last)} ${esc(fmtDate(last))}` : ''}</div>${ls.length ? '' : `<span class="ib" data-remove-source="${esc(s.name)}" role="button" aria-label="${esc(T.aria.remove)}">${icon('trash')}</span>`}</button>`;
  };
  const schools = lib.sources.filter(s => s.kind === 'school'), priv = lib.sources.filter(s => s.kind === 'private');
  $('schools').innerHTML = `<div class="month">${esc(T.schools)}</div>${schools.map(row).join('') || `<div class="empty small">${esc(T.noSchools)}</div>`}
    <div class="month">${esc(T.privateTeacher)}</div>${priv.map(row).join('') || `<div class="empty small">${esc(T.noTeachers)}</div>`}
    <div class="month">${esc(T.addSource)}</div>
    <div class="seg" id="src-kind"><button type="button" class="on" data-kind="school">${esc(T.school)}</button><button type="button" data-kind="private">${esc(T.privateTeacher)}</button></div>
    <div class="input" style="margin-top:8px"><input id="src-name" placeholder="${esc(T.name)}" autocomplete="off"><button class="mini" id="src-add" aria-label="${esc(T.aria.add)}">${icon('plus')}</button></div>
    <div class="hint">${esc(T.schoolsAuto)}</div>`;
}
function onSchoolsClick(e) {
  const rs = e.target.closest('[data-remove-source]');
  if (rs) { e.stopPropagation(); removeSource(rs.dataset.removeSource); return; }
  const kb = e.target.closest('#src-kind button');
  if (kb) { document.querySelectorAll('#src-kind button').forEach(b => b.classList.toggle('on', b === kb)); return; }
  if (e.target.closest('#src-add')) { addSource(); return; }
  const row = e.target.closest('.trow[data-source]');
  if (row) { filter = { kind: 'source', value: row.dataset.source, style: filter.style }; saveFilter(); show('library'); }
}
function addSource() {
  const name = ($('src-name').value || '').trim(); if (!name) { toast(T.typeName(T.school)); return; }
  const kindBtn = document.querySelector('#src-kind button.on'); const kind = kindBtn ? kindBtn.dataset.kind : 'school';
  if (lib.sources.some(s => s.name.toLowerCase() === name.toLowerCase())) { toast(T.alreadyListed); return; }
  ensureSource(name, kind === 'private' ? 'private' : 'group');
  renderSchools();
  saveLibrary().then(() => toast(T.added(name))).catch(err => toast(T.couldNotSave + shortErr(err)));
}
function removeSource(name) {
  if (lib.lessons.some(l => l.source === name)) { toast(T.moveFirst); return; }
  lib.sources = lib.sources.filter(s => s.name !== name);
  if (filter.kind === 'source' && filter.value === name) { filter = { kind: 'all', value: null, style: filter.style }; saveFilter(); }
  renderSchools();
  saveLibrary().then(() => toast(T.removedSource(name))).catch(err => toast(T.couldNotSave + shortErr(err)));
}

// ---------- settings ----------
function renderSettings() {
  const email = localStorage.getItem(LS.hint) || '';
  $('set-sub').textContent = email ? T.signedInAs(email) : T.signedIn;
  $('settings-body').innerHTML = `
    <div class="month">${esc(T.storage)}</div>
    <div class="srow"><div><div class="lbl2">${esc(T.openDrive)}</div><div class="sm">${esc(T.storageBody)}</div></div>${root ? `<a class="ib" href="https://drive.google.com/drive/folders/${encodeURIComponent(root.id)}" target="_blank" rel="noopener" aria-label="${esc(T.aria.drive)}">${icon('open')}</a>` : ''}</div>
    <div class="month">${esc(T.maintenance)}</div>
    <div class="srow"><div><div class="lbl2">${esc(T.rescan)}</div><div class="sm">${esc(T.rescanHint)}</div></div><button class="ib" id="btn-rescan" aria-label="${esc(T.aria.rescan)}">${icon('refresh')}</button></div>
    <div class="month">Gemini</div>
    <div class="srow"><div><div class="lbl2">${esc(T.geminiKey)}</div><div class="sm">${esc(T.geminiHelp)}</div></div><a class="ib" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" aria-label="${esc(T.getKey)}" title="${esc(T.getKey)}">${icon('open')}</a></div>
    <div class="input"><input id="set-gemini-key" type="password" value="${esc(lib.settings.geminiKey)}" placeholder="AIza…" dir="ltr" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off"><button class="mini" id="btn-save-gemini" aria-label="${esc(T.aria.save)}">${icon('check')}</button></div>
    <div class="input" style="margin-top:8px"><input id="set-gemini-model" value="${esc(lib.settings.geminiModel)}" placeholder="${esc(window.GeminiClient ? window.GeminiClient.DEFAULT_MODEL : 'gemini-2.5-flash')}" dir="ltr" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off"></div>
    <div class="hint">${esc(T.geminiModelHint)}</div>
    <div class="month">${esc(T.help)}</div>
    <div class="help">${T.helpItems.map(([ic, t, d]) => `<div>${icon(ic)}<span><b>${esc(t)}</b>${esc(d)}</span></div>`).join('')}</div>
    <div class="month">${esc(T.language)}</div>
    <div class="seg" id="lang-seg"><button type="button" class="${lang === 'he' ? 'on' : ''}" data-lang="he">עברית</button><button type="button" class="${lang === 'en' ? 'on' : ''}" data-lang="en">English</button></div>
    <div class="month">${esc(T.appearance)}</div>
    <div class="seg" id="theme-seg">${THEMES.map(t => `<button type="button" class="${theme === t ? 'on' : ''}" data-theme="${t}">${esc(t === 'dark' ? T.themeDark : t === 'light' ? T.themeLight : T.themeAuto)}</button>`).join('')}</div>
    <div class="month">${esc(T.account)}</div>
    <div class="srow"><div><div class="lbl2">${esc(T.signOut)}</div><div class="sm">${esc(T.signOutHint)}</div></div><button class="ib" id="btn-signout" aria-label="${esc(T.aria.signout)}">${icon('logout')}</button></div>
    <div class="month">${esc(T.advanced)}</div>
    <div class="input"><input id="set-client" value="${esc(clientId())}" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="…apps.googleusercontent.com" dir="ltr"><button class="mini" id="btn-save-client2" aria-label="${esc(T.aria.save)}">${icon('check')}</button></div>
    <div class="hint">${esc(T.clientId)} · ${esc(T.clientHint)}</div>
    <div class="hint" style="margin-top:18px;text-align:center">DanceLab ${APP_VERSION}</div>`;
}

// ---------- events and boot ----------
function bindEvents() {
  $('btn-signin').addEventListener('click', () => startAuth({}));
  $('btn-save-client').addEventListener('click', () => saveClientId($('setup-client').value));
  $('btn-settings').addEventListener('click', () => show('settings'));
  $('btn-settings-back').addEventListener('click', () => show('library'));
  $('btn-back').addEventListener('click', () => show('library'));
  $('btn-edit').addEventListener('click', () => { if (current) openAdd(current.id); });
  $('detail-delete').addEventListener('click', e => deleteFromDetail(e.currentTarget));
  $('btn-add').addEventListener('click', () => openAdd(null));
  $('btn-cancel').addEventListener('click', () => { if (uploading || aiBusy) { toast(T.waitUpload); return; } const back = editing; resetForm(); if (back && back.source) openDetail(back.id); else show('library'); });
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => show(t.dataset.go)));
  $('search').addEventListener('input', e => { query = e.target.value; renderLibrary(); });
  $('flt-style').addEventListener('click', () => openSheet('style'));
  $('flt-source').addEventListener('click', () => openSheet('source'));
  $('sheet-dim').addEventListener('click', closeSheet);
  $('sheet-reset').addEventListener('click', () => pickSheet(null));
  $('sheet-body').addEventListener('click', e => { const b = e.target.closest('.orow'); if (b) pickSheet(b.dataset.value || null); });
  $('list').addEventListener('click', e => { const card = e.target.closest('.card'); if (!card) return; const l = lib.lessons.find(x => x.id === card.dataset.id); if (!l) return; if (!l.source) openAdd(l.id); else openDetail(l.id); });

  // player
  $('bigplay').addEventListener('click', () => { if (video.paused) video.play().catch(() => {}); else video.pause(); showControls(); });
  $('btn-back5').addEventListener('click', () => { skip(-SKIP); showControls(); });
  $('btn-fwd5').addEventListener('click', () => { skip(SKIP); showControls(); });
  // Tap on the video: when the controls are hidden, the left and right thirds act as skip buttons
  // straight away (no second tap needed); the middle just brings the controls back.
  video.addEventListener('click', e => {
    if (controlsHidden()) {
      const r = video.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width;
      if (x < 0.34) skip(-SKIP); else if (x > 0.66) skip(SKIP);
      showControls(); return;
    }
    if (!video.paused) hideControls();
  });
  video.addEventListener('waiting', () => { if (video.getAttribute('src') && !mediaTriedBlob) setVideoLoading(T.buffering); else if (video.getAttribute('src') && $('vload').hidden) setVideoLoading(T.buffering); });
  video.addEventListener('playing', () => { if ($('vload').textContent === T.buffering) setVideoLoading(''); });
  video.addEventListener('canplay', () => { if ($('vload').textContent === T.buffering) setVideoLoading(''); });
  video.addEventListener('seeked', () => { if ($('vload').textContent === T.buffering && video.readyState >= 3) setVideoLoading(''); });
  ['btn-loop', 'btn-mirror', 'btn-speed', 'btn-pip', 'btn-fs', 'scrub'].forEach(id => $(id).addEventListener('pointerdown', () => showControls()));
  video.addEventListener('play', () => { setPlayIcon(true); showControls(); });
  video.addEventListener('pause', () => { setPlayIcon(false); showControls(); });
  video.addEventListener('ended', () => { setPlayIcon(false); showControls(); });
  $('btn-speed').addEventListener('click', e => { e.stopPropagation(); toggleSpeedMenu(); });
  $('speed-menu').addEventListener('click', e => { const b = e.target.closest('button[data-rate]'); if (!b) return; setRate(parseFloat(b.dataset.rate)); toggleSpeedMenu(false); });
  document.addEventListener('click', e => { if (!e.target.closest('.speedwrap')) toggleSpeedMenu(false); });
  video.addEventListener('timeupdate', () => { if (loopB !== null && video.currentTime >= loopB) video.currentTime = loopA; updateTime(); });
  video.addEventListener('loadedmetadata', updateTime);
  video.addEventListener('loadedmetadata', () => { if (current && !current.duration && isFinite(video.duration) && video.duration > 0) { current.duration = Math.round(video.duration); current.updatedAt = nowIso(); saveLibrary().catch(() => {}); } });
  video.addEventListener('durationchange', updateTime);
  video.addEventListener('error', () => {
    if (!current) return;
    const src = video.getAttribute('src') || '';
    if (src && !src.startsWith('blob:') && !mediaTriedBlob && tokenValid()) { loadViaBlob(current, token.access_token); return; }
    if (src) toast(T.couldNotPlay, 5000);
  });
  const scrub = $('scrub');
  scrub.addEventListener('pointerdown', e => { scrub.setPointerCapture(e.pointerId); seekFromPointer(e.clientX); scrub.dataset.drag = '1'; });
  scrub.addEventListener('pointermove', e => { if (scrub.dataset.drag === '1') seekFromPointer(e.clientX); });
  scrub.addEventListener('pointerup', () => { scrub.dataset.drag = ''; });
  scrub.addEventListener('pointercancel', () => { scrub.dataset.drag = ''; });
  $('btn-mirror').addEventListener('click', () => { video.classList.toggle('mirror'); $('btn-mirror').classList.toggle('on'); });
  $('btn-loop').addEventListener('click', loopStep);
  $('btn-fs').addEventListener('click', enterFullscreen);
  $('btn-pip').addEventListener('click', togglePip);
  if (!pipSupported()) $('btn-pip').style.display = 'none';
  $('detail-body').addEventListener('click', onDetailClick);
  $('detail-body').addEventListener('keydown', e => { if (e.target.id === 'mark-name' && e.key === 'Enter') { e.preventDefault(); submitMark(); } });

  // form
  $('f-file').addEventListener('change', e => fileChosen(e.target));
  $('f-type').addEventListener('click', e => { const b = e.target.closest('button[data-type]'); if (!b) return; formType = b.dataset.type; setTypeUI(); fillSources(lastSource(formType)); });
  $('f-style').addEventListener('click', e => { const b = e.target.closest('button[data-style]'); if (!b) return; formStyle = b.dataset.style; renderStyleSeg(); if (formStyle === '__new__') setTimeout(() => $('f-style-new').focus(), 50); });
  $('f-source').addEventListener('change', onSourceChange);
  $('f-tags').addEventListener('click', e => { const b = e.target.closest('[data-tag]'); if (b) toggleFormTag(b.dataset.tag); });
  $('f-chapters').addEventListener('click', e => { const b = e.target.closest('[data-remove-chapter]'); if (!b) return; formChapters.splice(+b.dataset.removeChapter, 1); renderFormChapters(); });
  $('btn-save').addEventListener('click', saveLesson);
  $('btn-ai').addEventListener('click', runAi);
  $('btn-delete').addEventListener('click', deleteLesson);

  $('schools').addEventListener('click', onSchoolsClick);
  $('schools').addEventListener('keydown', e => { if (e.target.id === 'src-name' && e.key === 'Enter') { e.preventDefault(); addSource(); } });
  $('settings-body').addEventListener('click', e => {
    const btn = e.target.closest('button'); const id = btn ? btn.id : '';
    if (id === 'btn-rescan') rescan(btn); else if (id === 'btn-signout') signOut(); else if (id === 'btn-save-client2') saveClientId($('set-client').value); else if (id === 'btn-save-gemini') saveGeminiSettings();
    const lb = e.target.closest('#lang-seg button'); if (lb) setLanguage(lb.dataset.lang);
    const tb = e.target.closest('#theme-seg button'); if (tb) setTheme(tb.dataset.theme);
  });
  if (lightMq) { const onChange = () => { if (theme === 'auto') applyTheme(); }; if (lightMq.addEventListener) lightMq.addEventListener('change', onChange); else if (lightMq.addListener) lightMq.addListener(onChange); }

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && tokenValid() && Date.now() - lastSync > 60000) refresh(); });
  window.addEventListener('beforeunload', e => { if (uploading) { e.preventDefault(); e.returnValue = ''; } });
}

async function boot() {
  video = $('video');
  applyTheme();
  applyLanguage();
  bindEvents();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
  const r = handleRedirect();
  loadToken();
  try { const cached = JSON.parse(localStorage.getItem(LS.lib)); if (cached && Array.isArray(cached.lessons)) { lib = normalize(cached); sortLessons(); sortSources(); } } catch (e) { /* no cache */ }
  try { root = JSON.parse(localStorage.getItem(LS.root)) || null; } catch (e) { root = null; }
  loadFilter();

  if (tokenValid()) {
    show('library');
    if (r === true || !localStorage.getItem(LS.hint)) await fetchUserInfo();
    refresh();
  } else if (r !== 'error' && clientId() && localStorage.getItem(LS.hint) && sessionStorage.getItem(SS.silent) !== '1') {
    sessionStorage.setItem(SS.silent, '1');
    if (!startAuth({ silent: true })) show('auth');
  } else {
    if (r === 'error' && localStorage.getItem(LS.hint)) toast(T.signInAgain);
    show('auth');
  }
}

document.addEventListener('DOMContentLoaded', boot);
})();
