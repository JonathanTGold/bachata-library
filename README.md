# Bachata Library

A lightweight web app (PWA) to organize, browse, and watch Bachata lesson recap videos.
Videos live in your own Google Drive. The app is only the front end; nothing is stored on a server.

## Status

**Mockup stage.** `index.html` is a clickable UI mockup with fake data: library, lesson player
(speed, mirror, A-B loop), add/tag form, and schools list. No Google sign-in or Drive upload yet.

## Planned architecture

- Storage: a `Bachata Library` folder in the user's Google Drive, one subfolder per school
  (or per teacher for private lessons), plus a single `library.json` index.
- Auth: Google Sign-In with the `drive.file` scope (non-sensitive, no verification needed).
- Playback: the browser's native video element streaming straight from Drive with Range requests.
- Hosting: static files on GitHub Pages. No backend.

## Run locally

Open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8080
```

## Install on iPhone

Open the hosted URL in Safari or Chrome, tap Share, then **Add to Home Screen**.
