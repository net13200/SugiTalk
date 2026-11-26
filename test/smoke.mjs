// Browser smoke test: fake SpeechRecognition + demo translator, real UI.
// Run: node test/smoke.mjs   (needs Playwright + Chromium)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const root = new URL('../web/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const p = join(root, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  try { res.writeHead(200, { 'Content-Type': types[extname(p)] || 'text/plain' }); res.end(await readFile(p)); }
  catch { res.writeHead(404); res.end(); }
}).listen(0);
const url = `http://localhost:${server.address().port}/?endpoint=demo`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', e => { console.error('PAGE ERROR', e); process.exitCode = 1; });

await page.addInitScript(() => {
  // Fake recognizer that replays a scripted interim stream, then ends (like iOS does).
  const script = ['昨日', '昨日駅に', '昨日駅に行ったけど', '昨日駅に行ったけど人が', '昨日駅に行ったけど人が多くて',
    '昨日駅に行ったけど人が多くて大変だった', '昨日駅に行ったけど人が多くて大変だった'];
  window.__ends = 0;
  const Fake = class {
    start() {
      setTimeout(() => this.onstart?.(), 10);
      if (window.__ends > 0) return; // later sessions: silent
      script.forEach((text, i) => setTimeout(() => {
        const r = [{ transcript: text }]; r.isFinal = i === script.length - 1;
        this.onresult?.({ results: [r] });
        if (r.isFinal) setTimeout(() => this.stop(), 50);
      }, 100 + i * 150));
    }
    stop() { window.__ends++; setTimeout(() => this.onend?.(), 10); }
  };
  for (const k of ['SpeechRecognition', 'webkitSpeechRecognition'])
    Object.defineProperty(window, k, { value: Fake, configurable: true, writable: true });
});

await page.goto(url);
await page.click('#startBtn');
await page.waitForTimeout(2500);
const result = await page.evaluate(() => ({
  chunks: window.__sugitalk.chunks.map(c => [c.ja, c.en, c.state]),
  stats: window.__sugitalk.stats,
  status: document.getElementById('status').textContent,
  log: window.__sugitalk.logLines.join('\n'),
}));
console.log(JSON.stringify(result.chunks, null, 1));
console.log(result.log);
console.log('status:', result.status, 'commits:', result.stats.commits, 'translated:', result.stats.translated);
await page.click('#debugBtn');
await page.screenshot({ path: process.argv[2] || 'smoke.png' });
const ja = result.chunks.map(c => c[0]).join('');
if (ja !== '昨日駅に行ったけど人が多くて大変だった') { console.error('FAIL: joined chunks =', ja); process.exitCode = 1; }
else console.log('PASS');
await browser.close();
server.close();
