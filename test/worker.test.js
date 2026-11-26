// Worker tests with a mocked DeepL: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';

const env = { ALLOWED_ORIGINS: 'https://me.example', DEEPL_API_KEY: 'abc:fx', PROVIDER: 'deepl' };
const req = (body, origin = 'https://me.example', path = '/translate') => new Request(`https://w.example${path}`, {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('rejects other origins', async () => {
  const res = await worker.fetch(req({ text: 'こんにちは' }, 'https://evil.example'), env);
  assert.equal(res.status, 403);
});

test('calls DeepL Free with context and returns English', async () => {
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ translations: [{ text: 'Hello' }] }), { status: 200 });
  };
  const res = await worker.fetch(req({ text: 'こんにちは', context: '前の文' }), env);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.text, 'Hello');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://me.example');
  assert.equal(sent.url, 'https://api-free.deepl.com/v2/translate');
  assert.equal(sent.init.headers.Authorization, 'DeepL-Auth-Key abc:fx');
  assert.deepEqual(sent.body.text, ['こんにちは']);
  assert.equal(sent.body.context, '前の文');
  assert.equal(sent.body.source_lang, 'JA');
  assert.equal(sent.body.target_lang, 'EN-US');
});

test('maps DeepL quota error', async () => {
  globalThis.fetch = async () => new Response('quota', { status: 456 });
  const res = await worker.fetch(req({ text: 'こんにちは' }), env);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /quota/);
});
