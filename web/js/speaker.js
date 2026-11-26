// English speech output with a small queue and a "stay current" drop policy.
// Only committed + translated chunks are ever enqueued, so you never hear
// corrections.

export class Speaker {
  constructor({ cfg, log, onStart, onEnd, onDrop, onIdle }) {
    this.cfg = cfg;
    this.log = log;
    this.onStart = onStart || (() => {});
    this.onEnd = onEnd || (() => {});
    this.onDrop = onDrop || (() => {});
    this.onIdle = onIdle || (() => {});
    this.queue = [];      // waiting, not yet speaking
    this.current = null;  // item being spoken
    this.voices = [];
    this.supported = 'speechSynthesis' in window;
    if (this.supported) {
      this._loadVoices();
      speechSynthesis.addEventListener?.('voiceschanged', () => this._loadVoices());
    }
  }

  _loadVoices() {
    this.voices = speechSynthesis.getVoices().filter(v => /^en[-_]/i.test(v.lang));
  }

  voice() {
    const v = this.voices;
    return v.find(x => x.voiceURI === this.cfg.voiceURI)
      || v.find(x => /en[-_]US/i.test(x.lang) && /enhanced|premium/i.test(x.name))
      || v.find(x => /en[-_]US/i.test(x.lang) && x.localService)
      || v.find(x => /en[-_]US/i.test(x.lang))
      || v[0] || null;
  }

  /** iOS only plays TTS after a user gesture: call this inside the Start tap. */
  unlock() {
    if (!this.supported) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
    this.log('tts unlocked');
  }

  enqueue(item) {
    if (!this.supported) return;
    this.queue.push(item);
    // Staying current beats being complete: drop the oldest *unspoken* chunks.
    while (this.queue.length > this.cfg.maxSpeakQueue) {
      const dropped = this.queue.shift();
      this.log(`tts drop #${dropped.id} (queue>${this.cfg.maxSpeakQueue})`);
      this.onDrop(dropped);
    }
    this._next();
  }

  clear() {
    for (const item of this.queue) this.onDrop(item);
    this.queue = [];
    this.current = null;
    clearTimeout(this.watchdog);
    if (this.supported) speechSynthesis.cancel();
  }

  get busy() { return !!this.current || this.queue.length > 0; }

  _next() {
    if (this.current) return;
    const item = this.queue.shift();
    if (!item) { this.onIdle(); return; }
    this.current = item;

    const u = new SpeechSynthesisUtterance(item.en);
    u.lang = 'en-US';
    const v = this.voice();
    if (v) u.voice = v;
    u.rate = this.cfg.rate;

    let finished = false;
    const done = (why) => {
      if (finished) return;
      finished = true;
      clearTimeout(this.watchdog);
      if (why !== 'end') this.log(`tts #${item.id} ${why}`);
      this.current = null;
      this.onEnd(item);
      this._next();
    };
    u.onstart = () => this.onStart(item);
    u.onend = () => done('end');
    u.onerror = (e) => done(`error: ${e.error}`);
    // iOS sometimes never fires onend; don't let that freeze the queue.
    const est = 2000 + (item.en.length * 85) / this.cfg.rate;
    this.watchdog = setTimeout(() => { speechSynthesis.cancel(); done('watchdog'); }, est);

    speechSynthesis.speak(u);
  }
}
