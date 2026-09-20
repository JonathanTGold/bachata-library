# Bachata Library

A lightweight progressive web app (PWA) to organize, browse, and watch Bachata lesson recap videos.
Everything lives in **your own Google Drive**. The app is only the front end. There is no backend
and no server that ever sees your videos.

**Live app:** https://jonathantgold.github.io/bachata-library/
**UI mockup (fake data):** https://jonathantgold.github.io/bachata-library/mockup/

## What it does

- Hebrew, right-to-left interface by default, with English available in Settings. Dark theme, Rubik typeface, icon-only actions.
- Each lesson carries a dance style (Bachata, Salsa, or your own). A style switch appears at the top once more than one style is in use.

- **Library** grouped by month, filter chips per school and per private teacher, plus an Untagged inbox.
- **Add lesson**: pick a clip from Photos or Files, date auto-filled from the file, choose Group class
  (school) or Private (teacher name), type the figures covered, optional notes. Uploads to Drive in
  resumable chunks with a progress bar.
- **Lesson player**: custom controls streaming straight from Drive. Speed 1x / 0.75x / 0.5x / 0.25x,
  mirror flip, fullscreen, picture-in-picture, and a section repeat: tap once to mark A, again to
  mark B, and the section loops with both marks drawn on the scrubber. Tap a figure to jump to its
  timestamp, mark a figure at the current time.
- **Schools** list with counts; private teachers listed alongside.
- **Settings**: open the Drive folder, rescan and repair the index, sign out.
- Installable on iPhone via Add to Home Screen. Works on Android and desktop Chrome too.

## How the data is laid out in Drive

```
Bachata Library/
  library.json          # index: schools/teachers, lessons, figures, timestamps, notes
  .thumbnails/          # small JPEG posters
  <School name>/        # one folder per school
    2026-09-14 <School name>.mov
  <Teacher name>/       # one folder per private teacher
    2026-09-17 <Teacher name>.mov
```

Files carry Drive `appProperties` so the app can find them again and rebuild the index if needed
(Settings > Rescan).

## Architecture

- Plain HTML, CSS, and JavaScript. No build step, no framework, no dependencies.
- Google sign-in uses the OAuth 2.0 implicit flow via full-page redirect, which works inside iOS
  home-screen web apps where popups do not. Scope is `drive.file` only (files this app creates). The account email
  is read via Drive's `about.get`; requesting `openid email` alongside `drive.file` made Google's
  sign-in flow drop the Drive scope from the token.
- Video playback: the browser's video element cannot send an Authorization header, and Google
  rejects the access token as a URL parameter for media downloads. The app therefore points the
  video element at a same-origin virtual URL (`./media?id=…`) that the service worker turns into
  an authenticated Drive request, preserving Range headers so seeking works. If the service worker
  is not in control or that request fails, the app downloads the file with `fetch()` and plays it
  from a blob, showing progress.
- Service worker caches the app shell, network-first so updates arrive on the next open.
- Hosted as static files on GitHub Pages.

## One-time Google setup (about 10 minutes)

The app needs an OAuth client ID. It is public by design; Google only issues tokens for it to the
origins you register.

1. Go to https://console.cloud.google.com/ and create a project (for example "Bachata Library").
2. **APIs & Services > Library**: enable **Google Drive API**.
3. **Google Auth Platform > Branding**: app name, support email, developer contact.
   **Audience**: External, then **Publish app**. (Testing mode expires sessions every 7 days.)
   **Data access**: add the scope `https://www.googleapis.com/auth/drive.file`. It is non-sensitive,
   so no verification review is required.
4. **Clients > Create client**, type **Web application**:
   - Authorized JavaScript origins: `https://jonathantgold.github.io`
     (add `http://localhost:8787` for local development)
   - Authorized redirect URIs: `https://jonathantgold.github.io/bachata-library/`
     (add `http://localhost:8787/` for local development)
5. Copy the client ID into `config.js`, or paste it into the app's setup screen.

## Run locally

```
python3 -m http.server 8787
```

Then open http://localhost:8787/ . Sign-in only works if that origin is registered on the OAuth client.

## Repository layout

```
index.html   app shell
app.js       all application logic (auth, Drive API, upload, player, screens)
styles.css   styles
sw.js        service worker
config.js    Google client ID
manifest.webmanifest, icons/
mockup/      the original clickable UI mockup with fake data
```
