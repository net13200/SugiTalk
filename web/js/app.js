// Wires everything together:
//   Recognizer → Chunker → Translator (parallel) → in-order UI + Speaker
import { loadSettings, saveSettings, DEFAULTS, SLIDERS, getPath, setPath } from './config.js';
import { Chunker } from './chunker.js';
import { Recognizer } from './recognizer.js';
import { createTranslator } from './translator.js';
import { Speaker } from './speaker.js';

const $ = (id) => document.getElementById(id);
const cfg = loadSettings();

// ---------------------------------------------------------------- debug log
const stats = {
  sessions: 0, restarts: 0, commits: 0, translated: 0, errors: 0,
  lastMs: 0, avgMs: 0, queue: 0, drops: 0, ttsKills: 0, chars: 0, listening: 0, firstText: 0,
};
const logLines = [];
const t0 = performance.now();
function log(msg) {
  const t = ((performance.now() - t0) / 1000).toFixed(1).padStart(6);
  logLines.push(`${t}  ${msg}`);
  if (logLines.length > 300) logLines.shift();
  if (!$('debug').hidden) renderDebug();
}
function renderDebug() {
  stats.restarts = recognizer.restarts;
  stats.queue = speaker.queue.length;
  $('stats').innerHTML = Object.entries({
    sessions: stats.sessions, restarts: stats.restarts, commits: stats.commits,
    'tr ok': stats.translated, 'tr err': stats.errors, 'last ms': stats.lastMs,
    'avg ms': stats.avgMs, 'tts queue': stats.queue, drops: stats.drops,
    'rec end in tts': stats.ttsKills, 'tap→listen ms': stats.listening || '–', 'tap→text ms': stats.firstText || '–', 'chars/mo': usage.chars, provider: translator?.name || 'none',
  }).map(([k, v]) => `<div>${k} <b>${v}</b></div>`).join('');
  $('log').textContent = logLines.slice(-120).reverse().join('\n');
}

// Monthly character counter (DeepL Free = 500k chars/month).
const month = new Date().toISOString().slice(0, 7);
let usage = { month, chars: 0 };
try { const u = JSON.parse(localStorage.getItem('sugitalk.usage') || '{}'); if (u.month === month) usage = u; } catch {}
function addUsage(n) { usage.chars += n; try { localStorage.setItem('sugitalk.usage', JSON.stringify(usage)); } catch {} }

// ---------------------------------------------------------------- transcript
const chunks = [];  // {id, ja, en, state:'wait'|'ok'|'err', el, ...}
let nextSpeak = 0;  // index of the next chunk to hand to the speaker (keeps order)
const main = $('transcript');
let stickToBottom = true;

main.addEventListener('scroll', () => {
  stickToBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 60;
  $('jump').hidden = stickToBottom;
});
$('jump').onclick = () => { stickToBottom = true; scrollDown(); $('jump').hidden = true; };
function scrollDown() { if (stickToBottom) main.scrollTop = main.scrollHeight; }

function addEntry(ja) {
  $('empty').hidden = true;
  const el = document.createElement('div');
  el.className = 'entry';
  el.innerHTML = '<div class="ja"></div><div class="en wait"></div>';
  el.firstChild.textContent = ja;
  el.lastChild.textContent = translator ? '…' : '';
  $('entries').appendChild(el);
  scrollDown();
  return el;
}

function setInterim(text) {
  $('interim').textContent = text;
  scrollDown();
}

// ---------------------------------------------------------------- pipeline
let translator = createTranslator(cfg, log);
let lastCommitAt = 0;

const chunker = new Chunker(cfg, onCommit, log);

function onCommit({ text, reason }) {
  const now = performance.now();
  const id = chunks.length;
  const chunk = { id, ja: text, en: '', state: translator ? 'wait' : 'ok', committedAt: now };
  chunk.el = addEntry(text);
  chunks.push(chunk);
  stats.commits++;
  log(`commit #${id} [${reason}] +${Math.round(now - (lastCommitAt || now))}ms "${text}"`);
  lastCommitAt = now;

  if (!translator) { nextSpeak = chunks.length; return; }

  // Context = previous 1–2 committed JA chunks, so fragments translate coherently.
  const context = chunks.slice(Math.max(0, id - cfg.contextChunks), id).map(c => c.ja).join('');
  addUsage(text.length + context.length);
  translator.translate(text, context).then(en => {
    chunk.ms = Math.round(performance.now() - now);
    stats.translated++;
    stats.lastMs = chunk.ms;
    stats.avgMs = Math.round(stats.avgMs + (chunk.ms - stats.avgMs) / stats.translated);
    log(`tr #${id} ${chunk.ms}ms "${en}"`);
    chunk.en = en;
    chunk.state = 'ok';
  }, err => {
    stats.errors++;
    log(`tr #${id} failed: ${err.message}`);
    chunk.state = 'err';
    chunk.en = `⚠ ${err.message}`;
  }).finally(releaseInOrder);
}

// Requests run in parallel; results are shown and spoken strictly in chunk order.
function releaseInOrder() {
  while (nextSpeak < chunks.length && chunks[nextSpeak].state !== 'wait') {
    const c = chunks[nextSpeak++];
    const en = c.el.lastChild;
    en.textContent = c.en;
    en.className = c.state === 'err' ? 'en err' : 'en';
    if (c.state === 'ok' && cfg.speak && running) speaker.enqueue(c);
  }
  scrollDown();
}

// ---------------------------------------------------------------- speech out
let ttsStartedAt = 0;
const speaker = new Speaker({
  cfg, log,
  onStart: (c) => {
    ttsStartedAt = performance.now();
    c.el.classList.add('speaking');
    if (cfg.recDuringSpeech === 'pause') recognizer.pause();
  },
  onEnd: (c) => c.el.classList.remove('speaking'),
  onDrop: (c) => {
    stats.drops++;
    c.el.querySelector('.en').insertAdjacentHTML('beforeend', '<span class="tag">not spoken</span>');
  },
  onIdle: () => { ttsStartedAt = 0; if (cfg.recDuringSpeech === 'pause') recognizer.resume(); },
});

// ---------------------------------------------------------------- recognition
let running = false;
let tapAt = 0;              // when Start was tapped (for start-up timing)
let firstResultLogged = false;
let liveSession = 0;

const recognizer = new Recognizer({
  cfg, log,
  onResults(results, session) {
    if (!firstResultLogged) {
      firstResultLogged = true;
      stats.firstText = Math.round(performance.now() - tapAt);
      log(`⏱ tap → first text ${stats.firstText}ms`);
    }
    if (session !== liveSession) { liveSession = session; chunker.reset(); stats.sessions++; }
    chunker.update(results, performance.now());
    setInterim(chunker.pending);
  },
  onSessionEnd(session) {
    // Did TTS knock recognition over? (the key iOS risk – see README)
    if (speaker.current || (ttsStartedAt && performance.now() - ttsStartedAt < 1500)) {
      stats.ttsKills++;
      log('⚠ recognition ended while TTS was speaking');
    }
    if (session === liveSession) { chunker.flush(performance.now()); chunker.reset(); }
    setInterim('');
  },
  onState(state, msg) {
    if (state === 'listening' && tapAt && !stats.listening) {
      stats.listening = Math.round(performance.now() - tapAt);
      log(`⏱ tap → listening ${stats.listening}ms`);
    }
    $('dot').className = `dot ${state}`;
    $('status').textContent = msg || {
      listening: 'Listening', restarting: 'Restarting…', paused: 'Paused (speaking)',
      idle: 'Ready', error: 'Error',
    }[state];
    if (state === 'error' || (state === 'idle' && !recognizer.wanted)) setRunning(false);
  },
});

// Drive pause/stability commits even when no new recognition events arrive.
setInterval(() => {
  if (!chunker.pending) return;
  chunker.tick(performance.now());
  setInterim(chunker.pending);
}, 50);

// ---------------------------------------------------------------- wake lock
let wakeLock = null;
async function lockScreen() {
  if (!('wakeLock' in navigator)) { log('wake lock not supported'); return; }
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => log('wake lock released'));
    log('wake lock on');
  } catch (e) { log(`wake lock failed: ${e.message}`); }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !running) return;
  lockScreen();
  recognizer.kick(); // iOS stops recognition when the tab is hidden
});

// ---------------------------------------------------------------- controls
function setRunning(on) {
  running = on;
  $('startBtn').textContent = on ? 'Stop' : 'Start';
  $('startBtn').classList.toggle('running', on);
}

$('startBtn').onclick = () => {
  if (running) {
    setRunning(false);
    recognizer.stop();
    speaker.clear();
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    return;
  }
  if (!Recognizer.supported) {
    alert('Speech recognition is not available in this browser. Use Safari on iOS 14.5+ (and enable Siri & Dictation).');
    return;
  }
  // Everything below runs synchronously inside the tap, as iOS requires.
  // Recognition first: if TTS grabs the audio session first, iOS can delay the mic.
  tapAt = performance.now();
  firstResultLogged = false;
  stats.listening = 0;
  stats.firstText = 0;
  $('dot').className = 'dot restarting';
  $('status').textContent = 'Starting…';
  recognizer.start();
  if (cfg.speak) speaker.unlock();
  setRunning(true);
  lockScreen();
  translator?.warm();
};

function bindToggle(btn, key, apply) {
  const sync = () => { btn.setAttribute('aria-pressed', String(cfg[key])); apply?.(); };
  btn.onclick = () => {
    cfg[key] = !cfg[key];
    saveSettings(cfg);
    sync();
  };
  sync();
}
bindToggle($('speakToggle'), 'speak', () => {
  if (!cfg.speak) speaker.clear();
  else if (running) speaker.unlock(); // this is a tap, so it counts as a gesture
});
bindToggle($('jaToggle'), 'showJa', () => document.body.classList.toggle('hide-ja', !cfg.showJa));

$('debugBtn').onclick = () => { $('debug').hidden = !$('debug').hidden; renderDebug(); };
setInterval(() => { if (!$('debug').hidden) renderDebug(); }, 1000);

// ---------------------------------------------------------------- settings
function buildSettings() {
  $('endpoint').value = cfg.endpoint;
  $('recDuringSpeech').value = cfg.recDuringSpeech;

  const sel = $('voice');
  sel.innerHTML = '<option value="">Automatic (best en-US)</option>' + speaker.voices
    .map(v => `<option value="${v.voiceURI}">${v.name} (${v.lang})</option>`).join('');
  sel.value = cfg.voiceURI;

  $('sliders').innerHTML = '';
  for (const [path, label, min, max, step] of SLIDERS) {
    const wrap = document.createElement('label');
    wrap.className = 'slider';
    wrap.innerHTML = `${label} <span></span><input type="range" min="${min}" max="${max}" step="${step}">`;
    const input = wrap.querySelector('input');
    const out = wrap.querySelector('span');
    input.value = getPath(cfg, path);
    out.textContent = input.value;
    input.oninput = () => {
      setPath(cfg, path, Number(input.value));
      out.textContent = input.value;
      saveSettings(cfg);
    };
    $('sliders').appendChild(wrap);
  }
}

$('settingsBtn').onclick = () => { buildSettings(); $('settings').showModal(); };
$('endpoint').onchange = () => {
  cfg.endpoint = $('endpoint').value.trim();
  saveSettings(cfg);
  translator = createTranslator(cfg, log);
  log(`translator: ${translator?.name || 'none'}`);
  translator?.warm();
};
$('voice').onchange = () => { cfg.voiceURI = $('voice').value; saveSettings(cfg); };
$('recDuringSpeech').onchange = () => {
  cfg.recDuringSpeech = $('recDuringSpeech').value;
  saveSettings(cfg);
  recognizer.resume();
};
$('resetBtn').onclick = () => {
  const keepEndpoint = cfg.endpoint;
  Object.assign(cfg, structuredClone(DEFAULTS), { endpoint: keepEndpoint });
  saveSettings(cfg);
  buildSettings();
};
$('clearBtn').onclick = () => {
  speaker.clear();
  chunks.length = 0;
  nextSpeak = 0;
  $('entries').innerHTML = '';
  $('empty').hidden = false;
};
$('copyBtn').onclick = async () => {
  const text = chunks.map(c => (cfg.showJa ? c.ja + '\n' : '') + c.en).join('\n\n');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  toast(`Copied ${chunks.length} lines`);
};

function toast(msg) {
  const el = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

document.body.classList.toggle('hide-ja', !cfg.showJa);
log(`ready. recognition=${Recognizer.supported} tts=${speaker.supported} translator=${translator?.name || 'none'}`);

// Exposed for the automated smoke test only.
window.__sugitalk = { chunks, stats, cfg, logLines };
