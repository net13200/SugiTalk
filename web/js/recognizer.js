// Wraps webkitSpeechRecognition and keeps it alive.
// iOS Safari ends recognition on its own (silence, ~1 min cap, audio-session
// changes, app switching). We restart in onend whenever the user hasn't pressed
// Stop, with a short delay and exponential backoff for rapid failure loops.

const FATAL = new Set(['not-allowed', 'service-not-allowed', 'language-not-supported']);

export class Recognizer {
  constructor({ cfg, onResults, onSessionEnd, onState, log }) {
    this.cfg = cfg;
    this.onResults = onResults;       // (results[], sessionId) => void
    this.onSessionEnd = onSessionEnd; // (sessionId) => void
    this.onState = onState;           // ('listening'|'restarting'|'paused'|'idle'|'error', msg?)
    this.log = log;
    this.rec = null;
    this.wanted = false;   // user pressed Start and not Stop
    this.paused = false;   // temporarily stopped (e.g. while TTS speaks)
    this.session = 0;
    this.restarts = 0;
    this.fails = 0;
    this.timer = null;
  }

  static get supported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /** Must be called from a user tap the first time (iOS). */
  start() {
    this.wanted = true;
    this.paused = false;
    this.fails = 0;
    clearTimeout(this.timer);
    if (!this.rec) this._open();
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.timer);
    if (this.rec) this.rec.stop(); // onend fires → onSessionEnd flushes the chunker
    else this.onState('idle');
  }

  /** Stop listening without leaving "running" state (used while TTS speaks). */
  pause() {
    if (!this.wanted || this.paused) return;
    this.paused = true;
    clearTimeout(this.timer);
    if (this.rec) this.rec.stop();
  }

  resume() {
    if (!this.wanted || !this.paused) return;
    this.paused = false;
    if (!this.rec) this._open();
  }

  /** If we should be listening but aren't (e.g. after returning to the tab), start now. */
  kick() {
    if (this.wanted && !this.paused && !this.rec) { clearTimeout(this.timer); this._open(); }
  }

  get active() { return !!this.rec; }

  _open() {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new R(); // fresh instance per session is more reliable on iOS
    rec.lang = 'ja-JP';
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    const id = ++this.session;
    const t0 = performance.now();
    let gotResult = false;
    let lastError = '';
    this.rec = rec;

    // Timing of each startup stage, so slow starts can be diagnosed in 🐞.
    const since = () => Math.round(performance.now() - t0);
    rec.onstart = () => { this.log(`rec#${id} start +${since()}ms`); this.onState('listening'); };
    rec.onaudiostart = () => this.log(`rec#${id} audio on +${since()}ms`);
    rec.onspeechstart = () => this.log(`rec#${id} speech heard +${since()}ms`);

    rec.onresult = (e) => {
      if (!gotResult) this.log(`rec#${id} first result +${since()}ms`);
      gotResult = true;
      this.fails = 0;
      const out = [];
      for (let i = 0; i < e.results.length; i++) {
        out.push({ text: e.results[i][0].transcript, isFinal: e.results[i].isFinal });
      }
      this.onResults(out, id);
    };

    rec.onerror = (e) => {
      lastError = e.error;
      this.log(`rec#${id} error: ${e.error}${e.message ? ' ' + e.message : ''}`);
      if (FATAL.has(e.error)) {
        this.wanted = false;
        this.onState('error', e.error === 'not-allowed'
          ? 'Mic / speech recognition not allowed. Check Settings › Safari, then tap Start.'
          : `Recognition unavailable (${e.error}).`);
      }
    };

    rec.onend = () => {
      if (this.rec !== rec) return;
      this.rec = null;
      const ms = Math.round(performance.now() - t0);
      this.log(`rec#${id} end after ${ms}ms${lastError ? ' (' + lastError + ')' : ''}`);
      this.onSessionEnd(id);
      if (!this.wanted) { if (!FATAL.has(lastError)) this.onState('idle'); return; }
      if (this.paused) { this.onState('paused'); return; }
      // Rapid failure (ended fast with nothing heard, or a hard error) → back off.
      const rapid = (ms < 1000 && !gotResult) || ['network', 'audio-capture'].includes(lastError);
      this.fails = rapid ? this.fails + 1 : 0;
      this._scheduleRestart(lastError || (gotResult ? 'ended' : 'ended-empty'));
    };

    try {
      rec.start();
    } catch (err) {
      this.rec = null;
      this.log(`rec#${id} start() threw: ${err.message}`);
      this.fails++;
      this._scheduleRestart('start-threw');
    }
  }

  _scheduleRestart(reason) {
    const { baseMs, maxMs } = this.cfg.restart;
    const delay = this.fails ? Math.min(maxMs, baseMs * 2 ** this.fails) : baseMs;
    this.restarts++;
    this.log(`restart #${this.restarts} in ${delay}ms (${reason}${this.fails ? `, fails=${this.fails}` : ''})`);
    this.onState('restarting');
    this.timer = setTimeout(() => { if (this.wanted && !this.paused && !this.rec) this._open(); }, delay);
  }
}
