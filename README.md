# SugiTalk: live Japanese → English in iOS Safari

SugiTalk is a single-page web app. Open it in Safari on your iPhone, tap **Start**, and it:

1. shows a scrolling transcript, with the Japanese in small grey text and the English in large text under it, updating mid-sentence;
2. speaks each English chunk into your AirPods as soon as it's translated.

```
iPhone mic → Web Speech API (ja-JP, interim results)          web/js/recognizer.js
           → Chunker (cuts stable text at clause boundaries)  web/js/chunker.js
           → Cloudflare Worker → DeepL API Free               worker/src/index.js
           → Transcript UI + speechSynthesis (en) → AirPods   web/js/app.js, web/js/speaker.js
```

It's plain HTML, CSS and ES modules with no build step and no dependencies. All settings live in `web/js/config.js`, and you can change them on the phone from the ⚙︎ panel.

```
web/            the site (deploy this folder)
  index.html, style.css
  js/config.js      every threshold and default + localStorage persistence
  js/recognizer.js  SpeechRecognition with auto-restart and backoff
  js/chunker.js     interim text → committed chunks (the core logic, well commented)
  js/translator.js  client for the Worker (+ "demo" fake)
  js/speaker.js     TTS queue with the drop-oldest policy and the iOS unlock
  js/app.js         wiring, UI, wake lock, settings, debug panel
worker/         Cloudflare Worker translation proxy (DeepL, or Google)
test/           chunker + worker unit tests, browser smoke test
```

---

## Setup (one time)

You need a computer with **Node.js 18+**, plus free accounts at **Cloudflare** and **DeepL**.

### A. Get a DeepL API Free key

1. Go to <https://www.deepl.com/pro-api> and choose **DeepL API Free**. Don't pick "DeepL Pro" or "API Pro".
2. Sign up. DeepL asks for a credit card to verify your identity. The Free plan isn't charged, and it stops at 500,000 characters a month instead of billing you.
3. Open **Account → API Keys** (<https://www.deepl.com/your-account/keys>) and copy the key. Free keys end in `:fx`.

### B. Deploy the site (GitHub Pages via Actions)

The site deploys automatically. `.github/workflows/pages.yml` publishes the `web/` folder to GitHub Pages on every push that changes `web/`, and you can also run it by hand from the **Actions** tab.

- Site: **https://net13200.github.io/SugiTalk/**
- Origin (used by the Worker): `https://net13200.github.io`

If the workflow fails with a Pages error, open the repo's **Settings → Pages** and set **Source: GitHub Actions**.

<details><summary>Alternative: Cloudflare Pages</summary>

```bash
npx wrangler login
npx wrangler pages project create sugitalk --production-branch main
npx wrangler pages deploy web --project-name sugitalk --branch main
```
Then use `https://sugitalk.pages.dev` as the origin in step C.
</details>

### C. Deploy the translation Worker

1. `worker/wrangler.toml` already allows the site's origin:
   ```toml
   ALLOWED_ORIGINS = "https://net13200.github.io,http://localhost:8000"
   ```
   It's the scheme and host only, with no path. If you host the site somewhere else, change it.
2. Deploy it and store the key as a secret. The key is never written to a file:
   ```bash
   cd worker
   npx wrangler deploy                        # prints https://sugitalk-translator.<you>.workers.dev
   npx wrangler secret put DEEPL_API_KEY      # paste the key when asked
   ```
3. Check it:
   ```bash
   curl -s -X POST https://sugitalk-translator.<you>.workers.dev/translate \
     -H 'Origin: https://net13200.github.io' -H 'Content-Type: application/json' \
     -d '{"text":"駅に行ったけど","context":""}'
   # → {"text":"I went to the station, but","ms":180,"provider":"deepl"}
   ```

### D. Point the app at the Worker

On the phone, open ⚙︎ and paste the Worker URL into **Translation endpoint**. You can also open the site once with it in the address:

```
https://net13200.github.io/SugiTalk/?endpoint=https://sugitalk-translator.<you>.workers.dev
```

The app saves it in localStorage. To make it the default for everyone who opens the site, set `endpoint` in `web/js/config.js` and redeploy.

---

## Build order: what to test at each step

Every feature is in the code from the start, and the settings let you turn them on one at a time. Use a second device playing a Japanese conversation video (a vlog, a drama or a street interview) at normal volume about 50 cm from the iPhone.

**Before you start:** Settings › General › Keyboard › **Enable Dictation** must be on. Safari's speech recognition uses Apple's dictation service and needs an internet connection.

### Step 1: live Japanese transcript only
- Deploy the site (B). Leave **Translation endpoint** empty.
- Open the site in Safari, tap **Start**, and allow microphone and speech recognition access.
- ✅ Grey Japanese text appears at the bottom and updates as people speak. Committed pieces move up into the transcript.
- ✅ Leave it running for 3 minutes or more. Open 🐞: **restarts** goes up when iOS stops recognition, and the dot turns amber briefly, then green again. The transcript keeps going.
- ✅ Scroll up: auto-scroll stops and **↓ Latest** appears.

### Step 2: chunker + translation
- Deploy the Worker (C), then set the endpoint (D). `demo` works as an endpoint if you want to check the UI first.
- ✅ Each Japanese chunk shows `…`, then its English replaces it.
- ✅ In 🐞, check that `commit #n [reason]` lines show cuts at clause boundaries (`boundary@ms` / `boundary@updates`) rather than only `pause`, and that `tr #n ###ms` latency is around 150–500 ms.
- ✅ Chunk English always appears in order, even when a later request finishes first.

### Step 3: speech output
- Connect AirPods and turn **🔊 Speak** on. Tap Start, which also unlocks TTS.
- ✅ You hear each English chunk once, and never a correction.
- ✅ When the speaker talks quickly, older chunks get a "not spoken" tag and **drops** goes up. Speech stays close to live.
- ⚠ **The key test:** watch **rec end in tts** in 🐞. If it climbs whenever English is spoken, iOS is stopping recognition when TTS plays (see [the TTS section below](#tts-vs-recognition-the-big-ios-risk)). Check whether the transcript keeps up anyway. If it doesn't, switch **Recognition while speaking** to *Pause while speaking*, or turn Speak off and use the app as text only.

### Step 4: tuning and polish
- ⚙︎ sliders (below), the wake lock (the screen shouldn't dim while listening), **Copy transcript**, **Clear**, and the 🐞 panel.

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| Speech rate | 1.15 | `speechSynthesis` rate. Higher keeps up better. |
| Boundary: stable updates | 2 | Text up to a clause boundary is committed once it survives this many more interim updates unchanged… |
| Boundary: stable ms | 300 | …or stays unchanged for this long. Lower is faster but cuts more often in the wrong place. |
| Pause commit ms | 700 | If nothing changes for this long, everything pending is committed. |
| Max chunk chars | 25 | Above this, a cut is forced: at the last boundary if there is one, otherwise a hard cut. |
| Min chunk chars | 4 | A boundary is only used after this many characters, which avoids tiny fragments like `私が`. |
| Context chunks | 2 | This many previous Japanese chunks are sent as DeepL `context`. Context is free and doesn't count toward your quota. |
| Max waiting to speak | 2 | If more chunks than this are waiting, the oldest unspoken ones are dropped. They stay on screen. |
| Recognition while speaking | Keep | *Keep* lets recognition run, with auto-restart covering any interruption. *Pause* stops it while English plays. |
| English voice | auto | Picks the best en-US voice. For better quality, download an "Enhanced" voice in iOS Settings › Accessibility › Spoken Content › Voices. |

**Tuning tips:** if translations feel choppy or wrong, raise *stable ms* and *min chars*. If they lag, lower *pause ms* and *max chars*. **Reset settings** restores the defaults and keeps your endpoint.

### How the chunker decides (summary; full comments in `chunker.js`)
For each recognition result, the chunker remembers what it has **committed** and where that text ends in the current transcript. Only the text after that point is *pending*. Pending text is committed when one of these happens:
1. it's longer than *max chars*;
2. it contains a clause boundary (て/で, けど, けれど, から, ので, が, たら, ば, と, し, 、, 。) after *min chars*, and the text up to that boundary has stayed the same long enough. A list of "glue" characters stops false cuts such as し**て**いる, **で**す and あり**が**とう. A one-kana boundary at the very end of the text, like `…して`, must be stable for *stable ms*, because it could still become `している`;
3. nothing has changed for *pause ms*;
4. the result is final, or recognition ended.

When the recognizer rewrites text that was already committed (kana → kanji, for example), the chunker keeps its own committed version and only looks at what comes after it, so **nothing is translated twice**.

---

## Known iOS limitations (please read)

- **The screen must stay on, and Safari must stay in front.** iOS stops web speech recognition when you lock the phone, switch apps, or switch tabs. The app holds a **Screen Wake Lock** while listening (iOS 16.4+) so the phone won't auto-lock. When you come back to the tab it tries to resume. If it doesn't, tap Start.
- **Use it in a Safari tab, not "Add to Home Screen".** Speech recognition has historically been unavailable or unreliable in home-screen web apps.
- **iOS chooses the microphone, not the app.** A web page can't pick the input. With AirPods connected, iOS may use the **AirPods microphone**, which picks up you better than the person across the table, and may switch the AirPods to the lower-quality headset audio mode. If recognition of other people is poor with AirPods in, compare it with the AirPods out (phone mic + phone speaker, or text only). This can't be fixed from a web page.
- **There are small gaps at restarts.** iOS stops recognition after silence, after about a minute, and on audio-session changes. The app restarts it in `onend` after 150 ms, with exponential backoff if it fails repeatedly, and logs every restart. A few hundred milliseconds of speech can be lost at each restart.
- **Recognition needs a network connection** (Apple's servers), and so does translation.
- **The first Start must be a tap**, because iOS requires a gesture for both the microphone and speech. Auto-restarts after that don't need a tap. If iOS ever refuses one, the status shows an error and tapping Start resumes.

### TTS vs recognition: the big iOS risk
On iOS, the microphone and speech output share one audio session, so playing TTS **may stop or interrupt speech recognition**. I couldn't test this on a real iPhone while building the app, so it's designed to measure and work around the problem rather than assume either way:

- 🐞 **rec end in tts** counts recognition sessions that ended while English was playing or within 1.5 s after it started. If that number climbs with every utterance, you're affected.
- **Keep listening** (default): auto-restart brings recognition back right after it's interrupted, which is the "restart recognition immediately" workaround. You may lose a little Japanese while English plays.
- **Pause while speaking**: stops recognition cleanly while English plays and restarts it as soon as the queue is empty. This is more predictable, but you never hear and transcribe at the same time.
- **Text only**: turn 🔊 Speak off. You get the full transcript with no audio conflicts.

If neither speaking mode is usable on your phone and iOS version, Safari can't do simultaneous listening and speaking. The closest alternatives are text only, or reading on an Apple Watch or second screen.

---

## Swapping the translation provider
The Worker has a provider table (`worker/src/index.js`). To use Google Cloud Translation (Basic v2, which has its own monthly free allowance), set `PROVIDER = "google"` in `wrangler.toml`, run `npx wrangler secret put GOOGLE_API_KEY`, and redeploy. Google v2 has no `context` parameter, so fragments translate a little less coherently.

Optional: DeepL offers a `model_type` parameter (`latency_optimized` / `quality_optimized`). Uncomment `DEEPL_MODEL_TYPE` in `wrangler.toml` to try it. If your plan doesn't support it, the Worker returns DeepL's error, which shows up in the transcript.

## Security note
The Worker answers only browsers whose `Origin` is in `ALLOWED_ORIGINS`, and the key never leaves Cloudflare. Origin checks stop other websites from using your quota, but they don't stop someone who knows the Worker URL and uses `curl`. The worst case is that your free quota runs out (DeepL Free stops rather than charges). If that ever matters, add a Cloudflare rate-limiting rule or a shared secret header.

## Development
```bash
npm test                      # chunker + worker unit tests (Node 18+)
npm run serve                 # http://localhost:8000 (desktop Chrome has webkitSpeechRecognition too)
node test/smoke.mjs out.png   # headless browser run with a fake recognizer (needs Playwright)
cd worker && npx wrangler dev # run the Worker locally
```
The 🐞 counter **chars/mo** is a local estimate of the characters sent to DeepL this month, including context. Your DeepL account page shows the real usage.
