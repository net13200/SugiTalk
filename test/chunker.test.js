// Unit tests for the chunker: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chunker, findBoundaries } from '../web/js/chunker.js';
import { DEFAULTS } from '../web/js/config.js';

function setup(overrides = {}) {
  const cfg = structuredClone(DEFAULTS);
  Object.assign(cfg.chunk, overrides);
  const out = [];
  const c = new Chunker(cfg, x => out.push(x));
  return { c, out, texts: () => out.map(x => x.text) };
}

// Feed a sequence of interim transcripts for result 0, 100 ms apart.
function stream(c, list, start = 0, step = 100) {
  let t = start;
  for (const text of list) { c.update([{ text, isFinal: false }], t); t += step; }
  return t;
}

test('boundaries ignore verb glue (している, です, ありがとう)', () => {
  assert.deepEqual(findBoundaries('勉強している').map(b => b.cut), []);
  assert.deepEqual(findBoundaries('そうです').map(b => b.cut), []);
  assert.deepEqual(findBoundaries('ありがとう').map(b => b.cut), []);
  assert.deepEqual(findBoundaries('雨が降ったので').map(b => b.cut), [2, 7]);
  assert.deepEqual(findBoundaries('行ったけど').map(b => b.cut), [5]);
});

test('commits at a stable clause boundary while speech continues', () => {
  const { c, texts } = setup();
  stream(c, ['昨日', '昨日駅に行ったけど', '昨日駅に行ったけど人が', '昨日駅に行ったけど人が多くて', '昨日駅に行ったけど人が多くてびっくり']);
  assert.equal(texts()[0], '昨日駅に行ったけど');
  assert.ok(!c.pending.startsWith('昨日'));
});

test('pause commits everything pending', () => {
  const { c, texts } = setup();
  const t = stream(c, ['おはよう', 'おはようございます']);
  c.tick(t + 100);
  assert.deepEqual(texts(), []);
  c.tick(t + 800);
  assert.deepEqual(texts(), ['おはようございます']);
  assert.equal(c.pending, '');
});

test('long text without boundaries is hard-cut at maxChars', () => {
  const { c, texts } = setup({ maxChars: 10 });
  stream(c, ['一二三四五六七八九十十一十二']);
  assert.equal(texts()[0], '一二三四五六七八九十');
});

test('rewrites of committed text are never retranslated', () => {
  const { c, texts } = setup();
  let t = stream(c, ['きのうえきにいったけど', 'きのうえきにいったけど人が', 'きのうえきにいったけど人が多']);
  assert.equal(texts().length, 1);
  // Recognizer now rewrites the committed kana as kanji.
  t = stream(c, ['昨日駅に行ったけど人が多い', '昨日駅に行ったけど人が多いです'], t);
  c.tick(t + 1000);
  assert.equal(texts()[0], 'きのうえきにいったけど');
  assert.ok(texts().slice(1).every(x => !x.includes('行った')), texts().join('|'));
  assert.ok(texts().join('').endsWith('多いです'));
});

test('final result commits the rest exactly once', () => {
  const { c, texts } = setup();
  stream(c, ['そうなんだ']);
  c.update([{ text: 'そうなんだ。', isFinal: true }], 200);
  c.update([{ text: 'そうなんだ。', isFinal: true }, { text: 'へえ', isFinal: false }], 300);
  c.flush(400);
  assert.deepEqual(texts(), ['そうなんだ。', 'へえ']);
});

test('iOS duplicate-prefix results are not committed twice', () => {
  const { c, texts } = setup();
  c.update([{ text: 'こんにちは', isFinal: true }], 0);
  c.update([{ text: 'こんにちは', isFinal: true }, { text: 'こんにちは元気', isFinal: false }], 100);
  c.flush(200);
  assert.deepEqual(texts(), ['こんにちは', '元気']);
});

test('single-kana boundary at the end waits for time, not update count', () => {
  const { c, texts } = setup();
  // "…して" may still become "している"; identical repeated updates shouldn't cut it.
  c.update([{ text: '毎日日本語を勉強して' }], 0);
  c.update([{ text: '毎日日本語を勉強して' }], 50);
  c.update([{ text: '毎日日本語を勉強して' }], 100);
  assert.deepEqual(texts(), []);
  c.update([{ text: '毎日日本語を勉強している' }], 150);
  c.tick(400);
  assert.deepEqual(texts(), []);
});
