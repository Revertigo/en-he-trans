/**
 * DriveTranslate — Cloudflare Worker (secure API proxy)
 *
 * Runs on Cloudflare's edge, in front of the Google Cloud Translation API.
 * The PWA (docs/app.js) talks only to this Worker; the Worker holds the
 * secrets (GOOGLE_API_KEY, DISCORD_WEBHOOK_URL) so they never reach the browser.
 *
 * Routes:
 *   GET  /warmup  — cheap no-op to pre-establish the connection (fast first call)
 *   POST /log     — forward a debug report to a Discord channel (chunked)
 *   POST /         — translate { text } EN→HE via Google, returns { translatedText }
 *
 * Secrets (set in the Cloudflare dashboard, encrypted):
 *   env.GOOGLE_API_KEY       — Google Cloud Translation API key
 *   env.DISCORD_WEBHOOK_URL  — Discord webhook URL for debug logs
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ===== /warmup endpoint: cheap connection pre-warm =====
    // Accepts GET, does nothing, returns immediately.
    if (url.pathname === '/warmup') {
      return new Response('ok', {
        headers: {
          'Content-Type': 'text/plain',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        },
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // ===== /log endpoint: forward debug logs to Discord (chunked) =====
    if (url.pathname === '/log') {
      try {
        const { message } = await request.json();
        if (!message || typeof message !== 'string') {
          return new Response(JSON.stringify({ error: 'Missing "message"' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          });
        }

        const CHUNK = 1900;
        const chunks = [];
        for (let i = 0; i < message.length; i += CHUNK) {
          chunks.push(message.slice(i, i + CHUNK));
        }

        for (let i = 0; i < chunks.length; i++) {
          const prefix = chunks.length > 1 ? `[part ${i + 1}/${chunks.length}]\n` : '';
          const resp = await fetch(env.DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: prefix + chunks[i] }),
          });
          if (!resp.ok) {
            const errBody = await resp.text();
            return new Response(JSON.stringify({ error: 'Discord error', details: errBody, atChunk: i }), {
              status: 502,
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            });
          }
        }

        return new Response(JSON.stringify({ ok: true, chunks: chunks.length }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
    }

    // ===== Default: translation endpoint =====
    try {
      const { text } = await request.json();
      if (!text || typeof text !== 'string') {
        return new Response(JSON.stringify({ error: 'Missing or invalid "text" field' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }

      const googleUrl = `https://translation.googleapis.com/language/translate/v2?key=${env.GOOGLE_API_KEY}`;
      const googleResp = await fetch(googleUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, source: 'en', target: 'he', format: 'text' }),
      });

      if (!googleResp.ok) {
        const errBody = await googleResp.text();
        return new Response(JSON.stringify({ error: 'Google API error', details: errBody }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }

      const data = await googleResp.json();
      const translatedText = data.data.translations[0].translatedText;

      return new Response(JSON.stringify({ translatedText }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  },
};
