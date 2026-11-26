// Every tunable lives here. The settings panel edits a copy of this object
// and saves it to localStorage, so you can tune things on the phone.

export const DEFAULTS = {
  // Translation proxy (your Cloudflare Worker URL, e.g. https://sugitalk-translate.you.workers.dev).
  //   ''     → Japanese transcript only (build step 1)
  //   'demo' → fake translator, no network (handy for testing speech output)
  endpoint: '',

  speak: true,            // speak English translations
  showJa: true,           // show the Japanese line above each translation
  rate: 1.15,             // speechSynthesis rate
  voiceURI: '',           // '' = best available en-US voice

  // What to do with recognition while TTS is speaking (see README "iOS limitations").
  //   'keep'  → leave recognition running; auto-restart covers any interruption
  //   'pause' → stop recognition while speaking, restart as soon as the queue is empty
  recDuringSpeech: 'keep',

  chunk: {
    stableUpdates: 2,     // boundary prefix must survive this many further interim updates…
    stableMs: 300,        // …or stay unchanged for this long
    pauseMs: 700,         // no change for this long → commit everything pending
    maxChars: 25,         // pending longer than this → force a cut
    minChars: 4,          // never cut a chunk shorter than this at a boundary
  },

  contextChunks: 2,       // previous committed JA chunks sent as DeepL `context`
  maxSpeakQueue: 2,       // more than this many waiting → drop the oldest unspoken
  translateTimeoutMs: 5000,

  restart: { baseMs: 150, maxMs: 4000 }, // recognition auto-restart backoff
};

// Sliders shown in the settings panel: [path, label, min, max, step]
export const SLIDERS = [
  ['rate', 'Speech rate', 0.6, 2, 0.05],
  ['chunk.stableUpdates', 'Boundary: stable updates', 1, 6, 1],
  ['chunk.stableMs', 'Boundary: stable ms', 100, 1500, 50],
  ['chunk.pauseMs', 'Pause commit ms', 300, 2500, 50],
  ['chunk.maxChars', 'Max chunk chars', 8, 60, 1],
  ['chunk.minChars', 'Min chunk chars', 1, 12, 1],
  ['contextChunks', 'Context chunks', 0, 3, 1],
  ['maxSpeakQueue', 'Max waiting to speak', 0, 6, 1],
];

const KEY = 'sugitalk.settings.v1';

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  const cfg = merge(structuredClone(DEFAULTS), saved);
  // ?endpoint=https://... in the URL overrides (handy for first setup)
  const ep = new URLSearchParams(location.search).get('endpoint');
  if (ep) { cfg.endpoint = ep; saveSettings(cfg); }
  return cfg;
}

export function saveSettings(cfg) {
  try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch {}
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o[k], obj);
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}

function merge(base, over) {
  for (const k of Object.keys(over || {})) {
    if (!(k in base)) continue;
    if (base[k] && typeof base[k] === 'object') merge(base[k], over[k]);
    else base[k] = over[k];
  }
  return base;
}
