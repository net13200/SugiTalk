// Client side of translation. Talks to the Cloudflare Worker, which holds the
// DeepL key. The provider (DeepL / Google) is chosen inside the Worker, so the
// browser only knows "POST {text, context} → {text}".

export function createTranslator(cfg, log) {
  const ep = (cfg.endpoint || '').trim().replace(/\/+$/, '');
  if (!ep) return null;

  if (ep === 'demo') {
    // Offline fake: lets you test the UI and speech without a Worker.
    return {
      name: 'demo',
      warm() {},
      async translate(text) {
        await new Promise(r => setTimeout(r, 150 + Math.random() * 250));
        return `(demo) ${text.length} characters of Japanese`;
      },
    };
  }

  return {
    name: 'worker',
    // Open the TLS connection early so the first real request is fast.
    warm() { fetch(`${ep}/health`, { mode: 'cors' }).catch(e => log(`warm-up failed: ${e.message}`)); },
    async translate(text, context) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), cfg.translateTimeoutMs);
      try {
        const res = await fetch(`${ep}/translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, context }),
          signal: ctl.signal,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        return body.text;
      } catch (e) {
        throw new Error(e.name === 'AbortError' ? 'timeout' : e.message);
      } finally {
        clearTimeout(t);
      }
    },
  };
}
