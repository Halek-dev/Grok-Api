# Imagine studio — status report

Read-only report on the state of the codebase as of commit `a5de492` (13 commits, branch `main`, pushed to `github.com/Halek-dev/Grok-Api`). Nothing was changed to produce it. Where a claim comes from reading code rather than running it, that is said. Where something is unknown, it says unknown.

Scope of the product: a small web app for a creative team to generate and edit images with xAI's Imagine API through a Node proxy that holds the shared API key. Zero npm dependencies, no build step.

---

## 1. What exists

### Files (all tracked in git)

| File | Lines | Bytes | Purpose |
|---|---:|---:|---|
| `server.js` | 1,349 | 53,674 | The proxy. Reads config, holds the key, price table, all `/api/*` routes, static file serving, image saving, favourites, pruning, usage log. |
| `public/app.js` | 2,414 | 90,752 | The whole client. Vanilla JS, no framework. Rail, runs, per-frame requests, lightbox, edit/combine modes, selection/delete/favourite, gate. |
| `public/index.html` | 280 | 14,301 | Page skeleton: gate, top bar, rail, results column, lightbox. |
| `public/styles.css` | 1,139 | 33,035 | All styling from the design tokens. |
| `README.md` | 549 | 24,802 | Setup, why the server exists, LAN/Railway deployment, prices, sizes, endpoints, troubleshooting. |
| `.env.example` | 44 | 1,788 | Every config variable with a comment. |
| `.gitignore` | 14 | 284 | Excludes `.env`, `.env.*` (except `.env.example`), `usage.jsonl`, `images/`, `favourites.json`. |
| `package.json` | 14 | 364 | `engines: node >= 18`, `start: node server.js`. No dependencies. |

Present on disk but ignored: `.env` (389 bytes, holds the real key and team password). There is **no test directory**; every verification described in §8 was an ad-hoc script in a scratch folder outside the repo.

### Against the original design brief

**Implemented as specified**
- Proxy with hand-parsed `.env`; key never sent to the browser (§6).
- `GET /api/config`, `GET /api/usage`, `POST /api/images` with the specified shapes, plus `code` fields on errors.
- Password gate with `crypto.timingSafeEqual` and a length guard; password held in `localStorage`.
- Upstream `AbortSignal.timeout` (default 180 s, env-overridable); network vs HTTP failures distinguished; single minimal-field retry on 400 with `degraded: true`; empty `data` reported as moderation; xAI's own error text surfaced; ~40 MB body cap; path-traversal guard on static files.
- `usage.jsonl`, one JSON line per image, with the fields the brief listed plus `runId`, `files`, `degraded`.
- Client cost estimate from `/api/config` prices, recomputed on every change; "unknown" when a tier is missing.
- Edit mode: drag-drop/click, FileReader data URI, non-image rejection copy from the design, frame count hidden, `n` never sent on edits.
- "Edit this" chains from an edited image; "Again" uses the run's stored settings, not the rail.
- Placeholders per expected frame; button disabled for the request and restored in `finally`.
- Cmd/Ctrl+Enter submits; Escape closes lightbox; arrows move within a run; focus trap and restore.
- Keyboard-operable throughout including the dropzone; pine `:focus-visible` ring only; `prefers-reduced-motion`; 375 px layout with pinned action bar; `aria-live` on results; alt text = prompt.
- Retirement notice for `grok-imagine-image-quality` with live day count, hours under 48 h, retired variant with the model disabled in the list.
- README with the required sections.

**Deviations from the brief / design, deliberate**
- **Frames are requested one per call** (`n: 1`, up to 3 concurrent) instead of one call with `n`. The brief's contract still works (`n` is accepted and clamped 1–10) but the UI never sends more than 1. Reason and measurements in §8.
- **Results persist server-side.** The brief said nothing is stored and a refresh empties the sheet. That was true until the user asked for saved, viewable images; now images are written to disk and the last 20 runs are restored on load. `SAVE_IMAGES=false` restores the original behaviour.
- The design's open-select mockup (prices on each row, pine highlight) is not reproduced; a native `<select>` is used with prices in the option text.
- Shape `4:5` from the design is absent because the API's `aspect_ratio` enum does not include it.
- Run grid follows the design's prose (`auto-fill, minmax(240px)`, 3 columns at 1392 px) rather than its mockup image (4 columns).
- The design's "Timed out — partial batch kept / Try the missing 2 frames" card was never built; with one frame per request a timeout affects one frame and shows as the per-frame failure card instead.
- Design copy "Imagine v0.9 / v1.0" replaced by the brief's model names.

**Added beyond the brief** (all at the user's request during the session)
- Batch edit: several photos, same instruction, one request each.
- Combine mode: reference photos → vision model writes/extends the prompt → normal generation. Roles per photo. Keep-my-wording (default) vs rewrite.
- Saved images, favourites (exempt from pruning), single and batch delete with two-step in-place confirm, `DATA_DIR` for a mounted volume, `MAX_STORED_IMAGES` pruning.
- Password reveal (eye) on the gate.
- Cancel run; per-frame failure card with single-frame retry.
- Friendly messages for port clash, `EACCES`, Node < 18, unwritable storage; process-level unhandled-rejection/uncaught-exception handlers.
- Node version guard and `package.json`.

**Never started:** nothing from the brief is unstarted. The brute-force protection on the password (not in the brief, repeatedly flagged) is not built.

---

## 2. The exact request bodies

Captured on the wire by running `server.js` against a stub that records every upstream request, with the key overridden to `REDACTED_TEST_KEY` via environment variable (the real `.env` was not read for the key). Data URIs are shortened for display only; on the wire they are the full string. These are literal — not reconstructed from code.

**All image requests carry** `Authorization: Bearer <XAI_API_KEY>` and `Content-Type: application/json`.

### Generate — exactly as the UI sends it

`POST https://api.x.ai/v1/images/generations`

```json
{
  "model": "grok-imagine-image-2.0",
  "prompt": "A single ceramic vase on a pale plaster shelf, hard morning light from the left",
  "n": 1,
  "aspect_ratio": "9:16",
  "resolution": "2k",
  "response_format": "b64_json",
  "quality": "medium"
}
```

`n` is always `1` from the UI. `quality` is present only because the model is `grok-imagine-image-2.0` and the user chose something other than Auto.

### Single-image edit — exactly as the UI sends it

`POST https://api.x.ai/v1/images/edits`

```json
{
  "model": "grok-imagine-image",
  "prompt": "Make the background a plain warm grey",
  "image": {
    "url": "data:image/png;base64,iVBORw0KGgoAAAANSU…[full data URI]",
    "type": "image_url"
  },
  "response_format": "b64_json"
}
```

The field is **`image`, a singular object** `{ url, type }`. There is no `n`. The client sent `"quality": "medium"` on this request; the server dropped it because `grok-imagine-image` is not in `qualityModels` (see §5). No `aspect_ratio` or `resolution` is sent on edits.

### Multi-image edit

**Does not exist as a single request.** When the user drops N photos into Edit mode, the client makes **N separate requests** to `/images/edits`, each identical in shape to the one above with its own `image`. The plural key `images` is never sent to xAI anywhere in the codebase.

The earlier "Combine" implementation that tried to do this (composite several photos into one `image`) was removed in commit `2649568`. What replaced it is two requests to two different endpoints:

### Combine, stage 1 — reading the references

`POST https://api.x.ai/v1/chat/completions`

```json
{
  "model": "grok-4.20-non-reasoning",
  "messages": [
    {
      "role": "system",
      "content": "You describe reference photographs for someone who is writing a text-to-image prompt. You are shown numbered photographs and told what each one is being used for. For each photo, describe ONLY what its stated role calls for, and ignore everything else in that photo. This matters: the person has already written their own prompt, and your description is appended to it. Anything you describe outside the stated role will fight their wording. So unless it IS the stated role, never describe lighting, mood, camera, lens, framing, composition or background. A subject role means the person or object only. A clothing role means the garments only. If a photo has no stated role, describe its most visually distinctive content. Be concrete and visual: colour, material, shape, hair, features, garment, texture. Each description is one comma-separated phrase of at most 25 words. Not a sentence. No verbs of instruction. Never restate, rephrase, interpret or answer the request. You are only describing what is in the photographs. Output one line per photo, in order, formatted exactly as: N| description No preamble, no commentary, no quotation marks, nothing else."
    },
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Photo 1 — use this for the subject — the person, animal or object the picture is about." },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,…[full data URI]" } },
        { "type": "text", "text": "Photo 2 — use this for the clothing — the garments, fabric and styling." },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,…[full data URI]" } },
        { "type": "text", "text": "The photos above are photo 1, photo 2. What is wanted: A moody low-key portrait, hard rim light from behind" }
      ]
    }
  ],
  "max_tokens": 400,
  "temperature": 0.7
}
```

This is the only place several images reach xAI in one request, and it goes to the chat endpoint, not an image endpoint. With `style: "rewrite"` the system message is the other constant (`COMBINE_SYSTEM`); the user content is identical.

### Combine, stage 2 — the generation

`POST https://api.x.ai/v1/images/generations`

```json
{
  "model": "grok-imagine-image-quality",
  "prompt": "A moody low-key portrait, hard rim light from behind. Woman with long straight dark brown hair, wearing black top. White collared button-up shirt.",
  "n": 1,
  "aspect_ratio": "9:16",
  "resolution": "1k",
  "response_format": "b64_json"
}
```

Identical in shape to a generate. The prompt is the user's text verbatim followed by the stage-1 detail lines. The server receives `mode: "combine"` and logs it under that name, but sends a plain generation upstream.

---

## 3. Multi-image handling

**How many the UI accepts:** up to `MAX_SOURCES = 10` in both Edit and Combine modes (`app.js`). The describe endpoint on the server caps at 6 (`.slice(0, 6)`), so in Combine, photos 7–10 would be accepted by the UI and silently dropped by the server. That mismatch is listed in §9.

**Two photos in Edit mode:** the client builds a run with `frames.length = sources.length` and issues **one request per photo**, up to `FRAME_CONCURRENCY = 3` at a time. Each request carries exactly one `image`. The results come back as N separate frames in one run card. The same instruction is applied to each independently; nothing merges them.

**Two photos in Combine mode:** one `/api/describe` request carrying both, then one (or N, per the frames slider) `/images/generations` request carrying neither.

**Order:** preserved by array index in the order the files were dropped or chosen. In Combine the labels "Photo 1", "Photo 2" follow that index and the same numbering is what the vision model is told. The user can **Remove** a photo (which renumbers the rest) but there is **no way to reorder** them other than removing and re-adding.

**The function that builds an image request, quoted in full** (`public/app.js`; this is the only caller of `/api/images` in the client):

```js
  function requestOneFrame(run, index) {
    var body = {
      mode: run.mode,
      model: run.model,
      prompt: run.prompt,
      user: state.name || '',
      runId: run.id
    };
    if (run.mode === 'edit') {
      // The server wraps this into xAI's { url, type } shape; send the plain URI.
      body.image = run.sources[index];
    } else {
      body.n = 1;
      body.aspect_ratio = run.shape;
      body.resolution = run.resolution;
    }
    if (run.quality) body.quality = run.quality;

    var headers = { 'content-type': 'application/json' };
    if (password) headers['x-team-password'] = password;

    var controller = new AbortController();
    run.controllers.push(controller);

    return fetch('/api/images', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: controller.signal
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (payload) {
        return { ok: res.ok, status: res.status, payload: payload };
      });
    });
  }
```

Note `body.image` is the plain data-URI string; the server (§2) wraps it into `{ url, type: "image_url" }`. The server's edit branch:

```js
  if (usesEditEndpoint) {
    const image = input.image;
    if (!image || typeof image !== 'string' || !image.trim()) {
      return fail(res, 400, 'Add a photo to edit — the edit endpoint needs one source image.', { code: 'bad_request' });
    }
    // One source image in, one image out. Never send n here.
    const imageField = { url: image, type: 'image_url' };
    payload = { model: model, prompt: prompt, image: imageField, response_format: 'b64_json' };
    minimalPayload = { model: model, prompt: prompt, image: imageField, response_format: 'b64_json' };
    if (acceptsQuality && quality !== 'auto') payload.quality = quality;
  }
```

An array or object for `image` is rejected with 400 (`typeof image !== 'string'`).

---

## 4. The `n` parameter

**Full path from control to wire:**

1. `index.html:194` — `<input type="range" id="frames" min="1" max="10" step="1" value="1">`. Present in Generate and Combine; the whole field is `hidden` (not disabled) in Edit.
2. `app.js` `framesEl` `input` handler → `state.frames = Number(framesEl.value)`; Shift+arrow steps by 5, clamped 1–10. Persisted to `localStorage` and restored on load, clamped 1–10.
3. `currentSettings()` → `n: state.mode === 'edit' ? 1 : state.frames`.
4. `submitRun(settings)` → `total = settings.mode === 'edit' ? Math.max(1, settings.sources.length) : settings.n`. `total` becomes the number of frame slots and the number of `requestOneFrame` calls.
5. `requestOneFrame` → sets `body.n = 1` **only in the non-edit branch**. The edit branch never touches `n`.
6. `server.js` `handleImages` → the edit branch never reads `input.n`. The generate branch: `count = Math.min(10, Math.max(1, Math.floor(Number(input.n) || 1)))`, sent as `n: count`.

**Can `n` reach the edits endpoint?** No. Verified on the wire (§2, capture *e*): a raw client sending `{"mode":"edit", …, "n": 6}` produced an upstream body with no `n` key. The server's edit payload is built from a literal object with four keys and `n` is not one of them.

**Can Edit inherit a value from Generate?** No. `state.frames` persists across mode switches (the slider keeps its position), but the edit path derives its request count from `sources.length` and never reads `state.frames` or `settings.n`. The one place `settings.n` is consulted in `submitRun` is guarded by `mode === 'edit' ? … : settings.n`.

**Can the UI send `n > 1` to the server?** No — `body.n = 1` is a literal. The server still accepts and clamps `n` 1–10 for a raw client (capture *b* shows `n: 4` passed through), so the brief's contract holds even though the UI does not use it.

---

## 5. Parameter handling

**model** — client: dropdown built from `/api/config` `prices` keys; a retired model is disabled at the bottom and a saved selection of a retired model falls back to the default with a notice. Server: rejected with 400 unless it is a key of `PRICES`. Always sent.

**quality** — client: control shown only when `qualityModels.includes(model)`; `currentSettings` sets `quality: null` otherwise. Server: `acceptsQuality = QUALITY_MODELS.includes(model)`; `quality` is added to the upstream payload **only if** `acceptsQuality && quality !== 'auto'`. So:
- Never sent to a model that does not accept it, even if a raw client supplies it — verified on the wire (captures *c* and *d*: `"quality":"medium"` in, no `quality` out).
- Never sent when it is `auto` (the API default is used instead).
- Anything not in `['low','medium','auto']` is treated as `auto`.
- `QUALITY_MODELS` is derived: every price entry whose `tiers` lacks a `default` key. Today that is exactly `['grok-imagine-image-2.0']`.

**aspect_ratio** — generate and combine: always sent; invalid or missing → `'auto'`. Edits: **never sent**; the field does not exist in the edit payload, so the API default applies. The minimal retry payload also omits it.

**resolution** — generate and combine: always sent; invalid or missing → `'1k'`. Edits: never sent. For pricing, edits are assumed to bill at the 1k tier (`EDIT_RESOLUTION = '1k'`); this is an assumption, see §10.

**Degraded retry** — on a 400 that is not classified `key_rejected`, the server re-sends `minimalPayload` (model, prompt, response_format, plus `n` or `image`). If that succeeds, cost and log use `quality: 'auto'`, `resolution: '1k'`, `aspect_ratio: 'auto'` — what the API defaulted to — not what was requested.

---

## 6. Key safety

**Where the key is read** — `server.js:127`:
```js
const XAI_API_KEY = String(env('XAI_API_KEY', '')).trim();
```
`env()` prefers `process.env`, then the hand-parsed `.env`. It is a module-level `const`, never reassigned.

**Where it is used** — three places, all server-side, all in an `Authorization` header on an outbound request to `XAI_BASE`:
- `server.js:694` — `callXai()`, used by `/images/generations` and `/images/edits`.
- `server.js:809` — `handleDescribe()`, `/chat/completions`.
- `server.js:758/880` — truthiness checks to return a 503 `no_key` error.
- `server.js:1139` — `/api/config` sends `hasKey: Boolean(XAI_API_KEY)`. A boolean, not the value.
- `server.js:1342` — startup log prints `loaded` / `MISSING`, never the value.

**What the browser can obtain** — `/api/config` (unauthenticated) returns `hasKey`, `requiresPassword`, `prices`, `qualityModels`, `savesImages`. No other route echoes configuration. Verified at runtime in §8: fetching `/api/config` while the key was set to a known test string and grepping the response for it found nothing.

**Client references** — `grep -rn "XAI_API_KEY\|api_key\|apiKey\|Bearer\|authorization" public/` returns exactly one line, `public/app.js:770`, inside an error message shown when the server reports `key_rejected`: *"Someone needs to check XAI_API_KEY on the server."* That is the variable's **name** in user-facing copy, not a value and not a code path that reads it. No client file sends an `Authorization` header anywhere.

**Wire confirmation** — in the capture (§2), every upstream request carried `Authorization: Bearer REDACTED_TEST_KEY`. Requests from the browser to `/api/*` carry only `x-team-password` (the team password), never the key.

**Residual exposure** — `XAI_BASE_URL` is env-configurable. Whoever can set environment variables on the host can redirect the key to another host. This is inherent to the design and is documented in `.env.example`; it was flagged to the user when they had the variable set on Railway.

---

## 7. Error handling

**Timeout** — yes. `callXai` and `handleDescribe` both pass `signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)`; default `180000`, env-overridable. On timeout the error's `name` is `TimeoutError`, mapped to `code: 'timeout'`, HTTP 504, message *"xAI did not answer within N seconds, so the request was given up on."*

**Network failure** (DNS, refused, reset) — caught separately from HTTP errors by the `try/catch` around `fetch`; `code: 'network'`, HTTP 504, message *"Could not reach api.x.ai — the connection failed before xAI answered (<err.message>)."*

**HTTP 400** — the body is parsed for a message (see below). If `classify()` does not label it `key_rejected`, the server retries once with `minimalPayload`. If the retry succeeds the response carries `degraded: true` and the client shows a warning that settings were dropped. If it fails too, the **original** 400 is returned to the client (the retry's failure is not reported).

**HTTP 429** — `code: 'rate_limited'`, `retryAfter` parsed from the `Retry-After` header (seconds or HTTP-date). The client disables the action button and counts down (`startRateLimit`); default 30 s if no header.

**HTTP 402 / 401 / 403** — 402 → `no_credits`. 401/403 → `key_rejected`. Message text matching `credit|balance|quota|insufficient fund|billing` → `no_credits` regardless of status. Message text matching `api key|apikey|authentication|unauthori[sz]ed` → `key_rejected` regardless of status — added because xAI answers a bad key with **400**, observed in §8.

**Empty `data` array on a 2xx** — returns HTTP 422, `code: 'moderation'`, message *"xAI accepted the request but returned no images, which means moderation filtered this prompt."* Never an empty success.

**2xx with `data` entries lacking both `b64_json` and `url`** — 502 `upstream`.

**Non-JSON body on 2xx** — 502 `upstream` with the first 300 chars of the body.

**Are xAI's messages surfaced verbatim?** Yes, by `extractError()`: it tries `error` (string), `error.message`, `error.detail`, `message`, `detail`, `detail.message`, in that order; if none, the raw body truncated to 300 chars; if that is empty, *"xAI returned status N with an empty body."* The client's `describeFailure()` wraps known codes in the design's two-line copy and, for unmapped codes, shows `"xAI returned <status>"` plus the verbatim message plus *"Retry, then post the code in #design-ops"*. Observed verbatim passthrough in §8 (*"Incorrect API key provided. You can obtain an API key from https://console.x.ai."*).

**Process-level** — `unhandledRejection` is logged and the server keeps running; `uncaughtException` is logged and the process exits 1 so the host restarts it. Three `return <async>()` calls inside the router's `try` were missing `await` (rejections escaped the catch) and were fixed in `26d1686`.

**Client** — every run's `finally` restores the button; a run whose every frame failed is removed and shows the rail error; a partially failed run keeps what arrived and shows a warning naming the counts and the charge.

---

## 8. What I actually tested

Strictly separated. "Verified" means I ran it in this session and observed the output. Costs are from xAI's returned `cost` field or `cost_in_usd_ticks`. Total real-API spend across the session: **≈ $0.96**.

### Verified

**Server routes against a local stub upstream** (stub in a scratch folder; server pointed at it via `XAI_BASE_URL`). Run repeatedly as a shell loop of `curl` calls checking status codes and JSON fields; the last full pass was 17/17 and a later pass 11/11 after Combine was added. Individual observed results:

| Check | Observed |
|---|---|
| `GET /api/config` unauthenticated | 200; response did not contain the key string |
| `GET /api/usage` no password / wrong / **wrong-length** / correct | 401 / 401 / 401 / 200 (no 500 from `timingSafeEqual`) |
| Static `/`, `/styles.css`, `/app.js`, missing file | 200, 200, 200, 404 |
| Traversal `/../.env`, `/..%2f..%2fserver.js`, `/%2e%2e/%2e%2e/.env`, `/..\server.js` and on `/api/image/…` | 403/404/400; grep of each body for `XAI_API_KEY` and `use strict` found nothing |
| Empty prompt, edit without image, unknown model, malformed JSON, wrong method, unknown `/api` path | 400, 400, 400, 400, 405, 404 |
| Stalled upstream with `UPSTREAM_TIMEOUT_MS=5000` | `code: timeout`, 504, returned in 5,245 ms |
| Upstream connection refused (`XAI_BASE_URL=http://127.0.0.1:9`) | `code: network`, 504, in 215–327 ms |
| Upstream 200 with `data: []` | 422 `moderation` |
| Upstream 429 with `Retry-After: 24` | 429, `retryAfter: 24` |
| Upstream 403 with "insufficient credit balance" | `code: no_credits` |
| Upstream 500 with an HTML body | 502 `upstream`, HTML surfaced as the message |
| Upstream 400 on an optional param | second request had only `model,prompt,n,response_format` (stub logged keys); response `degraded: true`; cost priced at 1k/auto |
| Upstream returning `url` instead of `b64_json` | handled, cost computed |
| Cost arithmetic: 1.0@1k×3, 1.5Q@2k×2, 2.0@1k auto, 2.0@2k medium, edit 2.0 auto, edit 1.0, degraded 2k | 0.06, 0.14, 0.04, 0.16, 0.07, 0.022, 0.08 — all matched the table |
| 45 MB request body | 413 `too_large` JSON, four consecutive attempts, 179–227 ms |
| Torn last line in `usage.jsonl` | `/api/usage` still 200, torn line skipped |
| Pruning with `MAX_STORED_IMAGES=5` then 8 more images | never more than 5 non-favourite files; `/api/runs` returned no id that was missing on disk |
| Favourite then flood past the cap | favourite file survived; 6 non-favourites + 1 favourite = 7 on disk |
| Delete single / batch; delete without password | files removed / 401, file count unchanged |
| `/api/runs` without password; `GET /api/image/<id>` without password | 401 / 200 (by design) |
| Delete leaves `usage.jsonl` untouched | log still 6 images / $0.12 after deleting 3 |
| Unhandled-rejection exits Node | `node -e` reproduction exited code 1 |
| Boot with no `.env`, config from env vars only | booted; `/api/usage` gated by the env password |
| `DATA_DIR` pointing at a path where `images` is a file | warning printed at boot; server kept serving 200; `savesImages: false` |
| Port already in use; second start | friendly "Port 8787 is already in use" text, exit 1 |
| Node version guard | not executed on a Node < 18 (none available); only the branch for ≥ 18 was exercised |

**Literal wire capture** (§2) — seven upstream bodies recorded by a dump stub, including proof that `quality` is stripped for non-quality models and that `n` never reaches `/images/edits`.

**Against the real xAI API** (real key, real charges):

| Test | Observed | Cost |
|---|---|---|
| 1 frame, Imagine 1.0, 1k, 16:9 | JPEG, 1280×720, `revised_prompt: null` | $0.02 |
| 1 frame, Imagine 2.0, 1k, quality low, 1:1 | JPEG, 1024×1024, `quality` accepted | $0.04 |
| 4 frames in one call, Imagine 1.0, 2k, 16:9 | PNG, 2816×1584 each, **105.7 s** for the call | $0.08 |
| Edit of the first frame, Imagine 1.0 | JPEG 1280×720 | $0.022 |
| Bad key (deliberate) | HTTP **400** with *"Incorrect API key provided…"* — not 401 | $0 |
| 15 remaining shape×resolution combinations, Imagine 1.0 | every one exact ratio; table in README | $0.30 |
| 3 concurrent single-frame calls | 5.25 s wall clock vs 14.9 s summed; no 429 | $0.06 |
| `image: [obj, obj]` to edits | 422 *"image[0]: invalid type: map, expected a string"* | $0 |
| `image: [str]` (one element) | 422 *"invalid length 1, expected struct ImageUrl with 2 elements"* | $0 |
| `image: [str, str]` to edits, green + magenta, "return the SECOND photo" | 200, returned **green** | $0.022 |
| `image: [str,str,str]` | 400 *"Cannot set both 'url' and 'file_id'"* | $0 |
| `image`/`reference_images`/string `image` on **generations** | all accepted (200) | $0.06 |
| Two images to `grok-4.20-non-reasoning` chat, "how many?" | *"2 images: green, magenta."*, `image_tokens: 128` | ≈ $0.0003 |
| `/api/describe`, two flat colours, rewrite | coherent 80-word prompt | $0.0007 |
| `/api/describe`, chair + loft photos, rewrite | prompt naming crimson velvet, walnut, arched windows | $0.003 |
| Generation from that prompt, 3:2 | chair in the loft (image inspected) | $0.02 |
| Two synthetic portraits + "swap girl in image 1 with girl from image 2" | prompt described the blonde; output a different blonde (inspected) | $0.063 |
| Roles subject/clothing then reversed, same photos | dark hair + white shirt; blonde + black top | $0.006 |
| `style: keep` with a lighting-heavy user prompt | user text verbatim at index 0; before the prompt fix the tail contained "soft even studio lighting"; after it, none of `studio lighting/background/composition/bokeh/camera` | $0.006 |

**In the browser** (Chromium pane, 1392×900 and 375×812): empty state; cost line updates on every control; retirement day count (59 days on 4 Sept 2026); lightbox open/arrows/Escape/focus-restore; "Edit this" chaining from an edit result, prompt cleared from generate and preserved from edit; "Again" used the run's stored settings while the rail was set differently; dropzone rejection copy for PDF and 24.6 MB; keyboard tab order and pine ring on `:focus-visible`; 375 px pinned bar, 44 px targets, no horizontal overflow; in-flight placeholders 3 rendering + 3 queued; Cancel at 3 of 6 keeping 3 and charging $0.15; 2-of-6 failed frames with per-frame retry filling the gap; lightbox skipping a failed slot; batch edit of 3 photos → 3 images → `$0.18`; persistence after `localStorage.clear()` + hard reload; delete two-step confirm; favourite flag round trip; password eye (type/aria/icon `display` measured); retirement in all four simulated states; the wording toggle; a second Combine run making **zero** `/api/describe` calls; stubbed spend arithmetic `$0.00 → $0.10` for 2 × $0.05.

### Assumed (never executed)

- That a Railway volume mounted at `DATA_DIR` actually persists across a redeploy. I only tested the failure path locally.
- The actual cause of the two Railway "deployment crashed" events. I never saw the Deploy logs; I found and fixed an unrelated-or-related crash vector by code reading.
- `USD_PER_TICK = 1e-10`. The tick arithmetic (`ticks = Σ tokens × price`) matched xAI's reported total exactly; the dollar value of a tick is a guess.
- That edits bill at the 1k tier. Nothing in the API response states the billed tier.
- That `/images/generations` **ignores** an `image` field. It accepted one; that the picture was unaffected by it is inferred from a string-form `image` also being accepted (which edits reject).
- Behaviour above `FRAME_CONCURRENCY = 3` — untested for rate limits.
- Real `Retry-After` header format from xAI; only a stub's was parsed.
- Any browser other than the Chromium pane. Firefox/Safari untested (CSS uses `:has()`).
- Pressing **Enter** in the gate with a real keypress. The automation harness could not deliver a native Return; an explicit keydown handler was added and exercised with a synthetic event only.
- Node < 18 exit message (no such Node on the machine).
- Retirement on the real date; only simulated by shifting `retiresAt`.
- Restored-run frame numbering (see §9 item 1).
- Concurrent writers to `favourites.json` or the log from several team members at once.
- Memory/behaviour with 10 × 2k frames (≈ 60 MB of base64) in one browser tab.
- Photos 7–10 in Combine mode (server cap is 6; UI cap is 10).
- That `temperature: 0.7` produces acceptably stable prompts run to run.
- The design's "Timed out — partial batch kept" copy was never produced by any path.

---

## 9. Known problems

Blunt list. Numbered for reference; none are fixed.

1. **Every saved image is recorded as frame 1** (traced, not observed). `requestOneFrame` sends no `frame` field; the server does `frame: typeof input.frame === 'number' ? input.frame : i + 1` where `i` is the index within that request's `images` — always 0 for a one-frame request. `readRuns` then does `frame: f.frame || …` → 1 for all. After a reload a 6-frame run will label every image "Frame 1" in the lightbox ("Frame 1 of 6" six times) and download every file as `…-frame-1.jpg`, overwriting on save. Live runs are unaffected because the client sets `frame: index + 1` on its own in-memory object. Fix is trivial (send `frame: index + 1` in the body) but is not done.
2. **No limit on password attempts.** A public URL allows unlimited guesses at `/api/usage`. The password compare is constant-time, but that only prevents timing attacks, not brute force. Flagged to the user repeatedly; not built. It now guards `DELETE` as well.
3. **Combine photo cap mismatch.** UI accepts 10, `/api/describe` silently keeps the first 6.
4. **Stale comment** in `handleImages`: *"'combine' is several photos composited into one picture by the client and sent as a single source. It uses the edits endpoint…"* — directly contradicted by the next comment and by the code (`usesEditEndpoint = mode === 'edit'`).
5. **Dead server path**: `input.frame` is read but never sent (item 1). Harmless in itself.
6. **Prices are hardcoded and unverified** against `docs.x.ai/developers/pricing`. They came from the brief. The README says to verify them; nobody has.
7. **`USD_PER_TICK` is a guess** (see §8 Assumed). The running total for Combine's reading step could be wrong by orders of magnitude, though it is always small.
8. **Size table hardcoded** from one measurement per combination on one day. If xAI changes output sizes the rail labels go stale; results and lightbox self-correct from the real image, the dropdown does not.
9. **Edit priced at 1k** — assumption, not fact.
10. **`classify()` is regex heuristics.** `violat` matches "violation" but would also match unrelated text; `credit` would classify a message like "credit card declined" as `no_credits` (probably right) and "credited your account" (wrong). Only the codes seen in testing were exercised.
11. **`favourites.json` is read-modify-write with no locking.** Two people favouriting at the same moment can lose one write. `usage.jsonl` uses `appendFile` per line and is fine in practice; not proven under contention.
12. **Local spend counter and server log diverge by design** and there is no reconciliation. "Spent today" is this browser only; a colleague's runs are not in it. Documented, but it confused me once during testing (I cleared one and not the other).
13. **`FRAME_CONCURRENCY = 3` is a client constant**, not configurable without editing `app.js`.
14. **Password is stored in `localStorage` in plain text**, per the design. On a shared machine it is readable in DevTools.
15. **`GET /api/image/<id>` is unauthenticated by design** (capability URL, 128-bit random id). Documented. Anyone holding a URL can fetch that image forever until it is pruned or deleted.
16. **Combine cannot preserve likeness** — inherent to the API (no reference-image input). It works for objects/scenes/styling; for people it produces someone matching the description, except public figures whose *name* the vision model emits into the prompt. The README says so. This was the user's original goal and it is not achievable with this provider.
17. **Combine `keep` mode depends on the model honouring `N| description`.** `parseDetailLines` tolerates missing numbers but if the model returns prose, that prose is appended whole to the user's prompt.
18. **`temperature: 0.7` on the describe call** — the same photos and instruction produce different appended detail on each run.
19. **The 400 retry hides the retry's own error.** If the minimal payload also fails, the client sees the first 400's message, not the second's.
20. **Native `<select>` for the open dropdown** — the design's styled open list (pine highlight, right-aligned prices) is not reproduced; prices are in the option text instead.
21. **Design mockup vs prose conflict on grid columns** resolved in favour of prose (3 columns at 1392 px). If the mockup was authoritative, this is wrong.
22. **No automated tests in the repo.** All verification was ad-hoc scripts in a scratch folder that is not committed. A future change has nothing to run.
23. **`.env` on the user's machine has `HOST=127.0.0.1`** from local testing. Railway is unaffected (env override), but a LAN deployment from that file would be reachable only from that machine until edited.
24. **Repo is public on GitHub.** No secrets in it (verified by grepping every commit for the real key and password), but the endpoint surface is documented for anyone.
25. **`savesImages: false` on `/api/config` when storage is unwritable** means the client will not restore runs, but the server still tries `saveImage` on every generation and logs a failure each time. Noisy, not harmful.
26. **The describe endpoint's `roles` array is trusted by position.** A client sending more roles than images, or unknown role strings, is tolerated (unknown → unlabelled) — but there is no validation that `roles.length === images.length`.
27. A backup of the real `.env` was briefly **staged** (not committed) during the session because `.gitignore` only covered the exact name `.env`. Caught before commit; `.gitignore` widened to `.env.*`. History verified clean.

---

## 10. Open questions

Things I had to guess at, and what I guessed.

- **What one `cost_in_usd_tick` is worth.** Guessed `1e-10` USD. Could be verified from `docs.x.ai` pricing against the per-token tick prices returned by `/language-models` (`prompt_text_token_price: 12500`, etc.).
- **Whether xAI bills for a request the client aborts** (Cancel, or the server's timeout). Guessed yes — the generation has been done — and built the money story on that guess. Never confirmed against a bill.
- **Whether `/images/generations` uses or ignores an `image` field.** It accepts one. Guessed "ignores".
- **Why Railway crashed twice.** Never saw the Deploy logs. Guessed either the unhandled-rejection path (fixed) or `DATA_DIR` pointing at an unmounted volume (now warned about at boot). Unknown.
- **What xAI's real `Retry-After` looks like**, and how it behaves at concurrency above 3. Guessed a small integer of seconds; guessed 3 is safe because 3 produced no 429.
- **Which tier edits are billed at.** Guessed 1k.
- **Whether the design's grid mockup (4 columns) or its prose (240 px minimum → 3 columns) is authoritative.** Went with the prose.
- **Whether image order inside a chat `content` array is honoured by the model as "photo 1, photo 2".** The labelled test (roles reversed → output reversed) suggests yes; not proven for more than two.
- **Whether `image_url` parts in chat accept data URIs at production sizes** (10 MB photo → ~13 MB base64 each, up to 6). Tested only with tiny images and two ~200 KB photos.
- **The team's intended use of Combine.** The user's tests were all identity/face transfers, which the API cannot do; the feature was validated on objects and scenes. If face transfer is the actual requirement, this provider is the wrong one and no further work here changes that.
