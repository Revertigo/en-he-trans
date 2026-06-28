# DriveTranslate Web App

A Progressive Web App (PWA) version of DriveTranslate that runs in mobile Safari/Chrome — no install required.

## Architecture

```
┌──────────────────────┐         ┌──────────────────────┐         ┌─────────────────────┐
│   iPhone Browser     │  HTTPS  │  Cloudflare Worker   │  HTTPS  │ Google Cloud        │
│                      │ ──────► │  (proxy + API key)   │ ──────► │ Translation API     │
│ Web Speech API (STT) │ ◄────── │                      │ ◄────── │                     │
│ Display Hebrew (RTL) │  JSON   │                      │  JSON   │                     │
└──────────────────────┘         └──────────────────────┘         └─────────────────────┘
```

- **Web Speech API** (in-browser) handles English speech-to-text
- **Cloudflare Worker** holds the Google API key and proxies translation requests
- **Google Cloud Translation API** does EN→HE translation

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page structure: tabs, status, controls |
| `app.js` | Main logic: speech recognition, translation, UI updates |
| `style.css` | Dark theme, RTL Hebrew styling |
| `manifest.json` | PWA installable metadata |
| `service-worker.js` | Caches app shell for offline access |
| `icon-192.png`, `icon-512.png` | App icons |

## Local testing

You can't test microphone features over `file://` — browsers require HTTPS or localhost. To test locally:

```bash
cd web_app
python3 -m http.server 8000
```

Then open `http://localhost:8000` on your computer. For mobile testing, deploy to GitHub Pages.

## Deployment

This is a static site. Push to GitHub and enable GitHub Pages:

1. Push the `web_app` branch to GitHub
2. In repo settings → Pages → enable Pages for the `web_app` branch (or for `master` if merged)
3. Wait ~1 minute for deployment
4. Open the GitHub Pages URL on your iPhone

## Configuration

The Cloudflare Worker URL is hardcoded in `app.js` as `TRANSLATE_WORKER_URL`. Change it there if you redeploy the Worker to a different URL.
