# Cloudflare Worker — DriveTranslate API proxy

This is the server-side half of DriveTranslate. It runs on Cloudflare's edge and
acts as a secure proxy between the PWA (`../docs/`) and external services.

The PWA talks only to this Worker; the Worker holds the secrets so they never
reach the browser.

## Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/` (root) | POST | Translate `{ text }` EN→HE via Google, returns `{ translatedText }` |
| `/warmup` | GET | No-op that returns `ok` instantly, to pre-establish the connection |
| `/log` | POST | Forward `{ message }` to a Discord channel via webhook (chunked to 1900 chars) |

## Secrets (set in the Cloudflare dashboard, encrypted)

| Name | Purpose |
|------|---------|
| `GOOGLE_API_KEY` | Google Cloud Translation API key |
| `DISCORD_WEBHOOK_URL` | Discord webhook URL for debug reports |

## Deployment

This file mirrors what runs in the Cloudflare Worker. To update the live Worker:

1. Cloudflare dashboard → Workers & Pages → `en-he-translator` → Edit code
2. Replace the contents with `worker.js`
3. Save and Deploy

(The secrets are configured once under the Worker's Settings → Variables and
Secrets and are not stored in this repo.)
