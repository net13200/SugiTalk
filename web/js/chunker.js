// The chunker turns a stream of constantly-rewritten interim recognition text
// into a sequence of *committed* chunks. Committed text is final for us: it is
// translated once, spoken once, and never revised, even if the recognizer later
// rewrites it.
//
// Model
// -----
// The recognizer gives us a list of results (one per phrase). Each result's
// transcript keeps changing until it goes isFinal. For each result index we keep
// a "slot":
//   committed – the exact text we already committed from this result
//   offset    – where the committed part ends inside the *current* transcript
// Everything after `offset` is "pending". We only ever cut pending text.
//
// When does pending text get committed?
//   1. length:   pending > maxChars → cut at the last clause boundary (or hard cut)
//   2. boundary: pending has a clause boundary (て/で, けど, から, ので, が, たら, ば,
//                と, し, 、, 。) after at least minChars, and the text up to it has
//                stayed identical for `stableUpdates` interim updates or `stableMs`
//   3. pause:    pending hasn't changed for pauseMs
//   4. final:    the result went isFinal → commit whatever is left
//
// The chunker has no timers. The app calls update() on every recognition event
// and tick() every ~50 ms, passing the current time. That keeps it testable.

// Longest first, so "ので" wins over "で" and "けれど" over "けど".
const BOUNDARIES = ['けれど', 'けど', 'から', 'ので', 'たら', '、', '。', '？', '！', '?', '!', 'て', 'で', 'が', 'と', 'し', 'ば'];

// If a boundary is directly followed by one of these characters it is almost
// certainly part of a word or verb form, not the end of a clause:
//   している / てる / ておく / です / でも / ありがとう / ところ / という / した / しまう …
const GLUE = {
  'て': 'いるおあくたしまみもはほ',
  'で': 'いるおあくたしまみもはほす',
  'が': 'っらるれとうい',
  'と': 'こもきかうい',
  'し': 'たてょゃまいかくっ',
  'ば': 'かりっ',
  'けど': 'も',
  'けれど': 'も',
  'ので': 'しす',
  'から': 'だ',
  'たら': 'い',
};

const PUNCT = '、。？！?!';

// Every place in `text` where a clause boundary ends (at index >= minChars).
// Returns [{cut, single, atEnd}] in order. `single` = ambiguous one-kana boundary.
export function findBoundaries(text, minChars = 1) {
  const out = [];
  for (let end = Math.max(1, minChars); end <= text.length; end++) {
    const head = text.slice(0, end);
    const b = BOUNDARIES.find(x => head.endsWith(x));
    if (!b) continue;
    const next = text[end];
    if (next && GLUE[b] && GLUE[b].includes(next)) continue;
    // "、、" or "。」" – keep punctuation runs together
    if (next && PUNCT.includes(next)) continue;
    out.push({ cut: end, single: b.length === 1 && !PUNCT.includes(b), atEnd: end === text.length });
  }
  return out;
}

export class Chunker {
  constructor(cfg, onCommit, log = () => {}) {
    this.cfg = cfg;           // the live settings object (read on every call)
    this.onCommit = onCommit; // ({text, reason, at}) => void
    this.log = log;
    this.reset();
  }

  /** Start a new recognition session (result indexes start over). */
  reset() {
    this.slots = [];
    this.active = -1;   // index of the result we're currently chunking
    this.pending = '';  // uncommitted text of the active result
    this.changedAt = 0; // last time `pending` changed
    this.cand = null;   // {text, since, updates} – boundary prefix being watched
  }

  /** @param results [{text, isFinal}] – the full results list of the session */
  update(results, now) {
    let active = -1;
    for (let i = 0; i < results.length; i++) {
      const slot = this._slot(i, results);
      if (slot.done) continue;
      const pending = this._pendingOf(slot, results[i].text);
      if (results[i].isFinal) {
        if (pending.trim()) this._commit(slot, pending, 'final', now);
        slot.done = true;
      } else {
        active = i; // the last non-final result is the live one
      }
    }

    if (active !== this.active) { this.cand = null; this.active = active; }
    const pending = active >= 0 ? this.slots[active].lastText.slice(this.slots[active].offset) : '';
    if (pending !== this.pending) { this.pending = pending; this.changedAt = now; }

    this._evaluate(now, true);
  }

  /** Called on a timer so pause/stability commits happen without new events. */
  tick(now) { this._evaluate(now, false); }

  /** Recognition session ended: commit everything still pending in any slot. */
  flush(now) {
    for (const slot of this.slots) {
      if (slot.done) continue;
      const rest = slot.lastText.slice(slot.offset);
      if (rest.trim()) this._commit(slot, rest, 'flush', now);
      slot.done = true;
    }
    this.pending = '';
    this.cand = null;
  }

  // ---- internals -----------------------------------------------------------

  _slot(i, results) {
    if (!this.slots[i]) {
      const slot = { committed: '', offset: 0, lastText: '', done: false };
      // Defensive: some iOS versions start a new result that repeats the whole
      // previous result. Treat that repeated prefix as already committed.
      const prev = i > 0 ? results[i - 1].text : '';
      if (prev && results[i].text.startsWith(prev)) {
        slot.committed = prev;
        slot.offset = prev.length;
        this.log(`chunker: result ${i} repeats result ${i - 1}, skipping prefix`);
      }
      this.slots[i] = slot;
    }
    return this.slots[i];
  }

  // Figure out where our committed text ends inside the (possibly rewritten)
  // transcript, and return what's after it.
  _pendingOf(slot, text) {
    slot.lastText = text;
    if (!slot.committed) return text.slice(slot.offset);
    if (text.startsWith(slot.committed)) {
      slot.offset = slot.committed.length;
    } else {
      // The recognizer rewrote text we already committed (e.g. kana → kanji).
      // We keep OUR committed version. To find where new text starts, look for
      // the last few committed characters near the old offset; if they're gone,
      // fall back to the old character offset.
      const tail = slot.committed.slice(-3);
      for (let d = 0; d <= 6; d++) {
        const hit = [slot.offset - tail.length + d, slot.offset - tail.length - d]
          .find(p => p >= 0 && text.startsWith(tail, p));
        if (hit !== undefined) { slot.offset = hit + tail.length; break; }
      }
    }
    return text.slice(slot.offset); // '' if the transcript got shorter than offset
  }

  _evaluate(now, fromUpdate) {
    const c = this.cfg.chunk;
    while (this.pending) {
      const p = this.pending;

      // 1. Too long: cut at the last boundary inside the limit, else hard cut.
      if (p.length > c.maxChars) {
        const inLimit = findBoundaries(p.slice(0, c.maxChars), c.minChars);
        const cut = inLimit.length ? inLimit[inLimit.length - 1].cut : c.maxChars;
        this._commitPending(cut, inLimit.length ? 'length@boundary' : 'length@hard', now);
        continue;
      }

      // 2. First boundary + stability.
      const b = findBoundaries(p, c.minChars)[0];
      if (b) {
        const prefix = p.slice(0, b.cut);
        if (!this.cand || this.cand.text !== prefix) {
          this.cand = { text: prefix, since: now, updates: 0 };
        } else if (fromUpdate) {
          this.cand.updates++;
        }
        const aged = now - this.cand.since >= c.stableMs;
        // A one-kana boundary at the very end (…て) may still grow into ている,
        // so for that case only trust time, not update count.
        const counted = this.cand.updates >= c.stableUpdates && !(b.single && b.atEnd);
        if (aged || counted) {
          this._commitPending(b.cut, aged ? 'boundary@ms' : 'boundary@updates', now);
          continue;
        }
      } else {
        this.cand = null;
      }

      // 3. Pause: nothing changed for a while → commit it all.
      if (now - this.changedAt >= c.pauseMs) {
        this._commitPending(p.length, 'pause', now);
        continue;
      }
      break;
    }
  }

  _commitPending(n, reason, now) {
    const slot = this.slots[this.active];
    this._commit(slot, this.pending.slice(0, n), reason, now);
    this.pending = this.pending.slice(n);
    this.cand = null;
  }

  _commit(slot, text, reason, now) {
    slot.committed += text;
    slot.offset += text.length;
    const t = text.trim();
    if (t) this.onCommit({ text: t, reason, at: now });
  }
}
