// SugiTalk translation proxy (Cloudflare Worker, free tier).
//
//   POST /translate  {text, context?}  →  {text, ms, provider}
//   GET  /health                       →  {ok: true}
//
// Holds the API key as a secret and only answers requests whose Origin is in
// ALLOWED_ORIGINS. Origin checks stop other websites from using your quota in a
// browser; they don't stop someone with curl who knows the URL. For a personal
// tool that's normally fine – see README.

const MAX_TEXT = 500;
const MAX_CONTEXT = 1000;

// ---- Providers: same interface, pick one with the PROVIDER variable ---------
const providers = {
  // DeepL API Free: https://developers.deepl.com/docs/api-reference/translate
  async deepl({ text, context }, env) {
    const key = env.DEEPL_API_KEY;
    if (!key) throw new HttpError(500, 'DEEPL_API_KEY secret is not set');
    // Free keys end in ":fx" and must use the api-free host.
    const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const body = {
      text: [text],
      source_lang: 'JA',
      target_lang: env.TARGET_LANG || 'EN-US',
      split_sentences: '0', // we already send clause-sized fragments
    };
    if (context) body.context = context; // not translated, not billed
    if (env.DEEPL_MODEL_TYPE) body.model_type = env.DEEPL_MODEL_TYPE; // e.g. latency_optimized
    const res = await fetch(`${host}/v2/translate`, {
      method: 'POST',
      headers: { 'Authorization': `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text();
      const msg = res.status === 456 ? 'DeepL monthly quota used up' : `DeepL ${res.status}: ${detail.slice(0, 200)}`;
      throw new HttpError(502, msg);
    }
    const data = await res.json();
    return data.translations[0].text;
  },

  // Google Cloud Translation (Basic v2). Set PROVIDER=google and the
  // GOOGLE_API_KEY secret. v2 has no context parameter, so context is ignored.
  async google({ text }, env) {
    const key = env.GOOGLE_API_KEY;
    if (!key) throw new HttpError(500, 'GOOGLE_API_KEY secret is not set');
    const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: 'ja', target: 'en', format: 'text' }),
    });
    if (!res.ok) throw new HttpError(502, `Google ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.data.translations[0].translatedText;
  },
};

// ---- Request handling -------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const originOk = allowed.includes(origin);
    const cors = originOk ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    } : { 'Vary': 'Origin' };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: { 'Content-Type': 'application/json', ...cors },
    });

    if (!originOk) return json({ error: `origin not allowed: ${origin || '(none)'}` }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/health') return json({ ok: true });
    if (request.method !== 'POST' || pathname !== '/translate') return json({ error: 'not found' }, 404);

    try {
      const body = await request.json().catch(() => { throw new HttpError(400, 'invalid JSON'); });
      const text = String(body.text || '').trim();
      const context = String(body.context || '').slice(-MAX_CONTEXT);
      if (!text) throw new HttpError(400, 'text is required');
      if (text.length > MAX_TEXT) throw new HttpError(413, `text longer than ${MAX_TEXT} chars`);

      const name = env.PROVIDER || 'deepl';
      const provider = providers[name];
      if (!provider) throw new HttpError(500, `unknown PROVIDER "${name}"`);

      const t0 = Date.now();
      const out = await provider({ text, context }, env);
      return json({ text: out, ms: Date.now() - t0, provider: name });
    } catch (e) {
      return json({ error: e.message }, e.status || 500);
    }
  },
};
