# Imagine studio

An internal tool for generating and editing images with xAI's Imagine models.
One shared team key, prepaid credits, and the price of every action shown before
and after you spend it.

Node 18 or newer. No npm dependencies, no build step.

---

## Setup, in four steps

1. **Get the files onto the machine that will host it.**

   ```bash
   git clone <your-repo-url> imagine-studio && cd imagine-studio
   ```

2. **Make your own `.env` from the example.**

   ```bash
   cp .env.example .env
   ```

3. **Put the team key in `.env`.** Get it from <https://console.x.ai>.

   ```
   XAI_API_KEY=xai-...
   TEAM_PASSWORD=something-the-team-shares
   ```

   `TEAM_PASSWORD` is optional but strongly recommended — see *Letting the team
   in* below.

4. **Start it.**

   ```bash
   node server.js
   ```

   Open <http://localhost:8787>. The console prints whether the key loaded and
   whether a password is required.

---

## Why there is a server at all

The obvious way to build this would be a single HTML file that calls
`api.x.ai` from the browser. That does not work, for two separate reasons, and
each one on its own is fatal.

**The key would be public.** Anything the browser can send, a person can read.
Open dev tools, look at the network tab or the page source, and there is the
team key. Whoever has it can spend the team's prepaid credits from anywhere,
and the only way to stop them is to revoke the key and re-issue it to everyone.

**The request would be blocked anyway.** `api.x.ai` does not send CORS headers
for browser origins. A browser refuses to hand a page the response from a
cross-origin server that has not opted in, so the fetch fails before the key
even matters.

So there is a small server. It holds the key, it is the only thing that talks
to xAI, and the browser only ever talks to it. The key never leaves the
machine running `server.js` — `/api/config` deliberately reports only *whether*
a key is present, never the key itself.

---

## Letting the team in over the LAN

`HOST` defaults to `0.0.0.0`, so the server already listens on every interface.
Colleagues on the same network reach it at your machine's LAN address:

```bash
# find your address
ipconfig      # Windows
ifconfig      # macOS / Linux
```

Then share `http://<your-lan-ip>:8787`. You may need to allow the port through
your firewall the first time.

> **Do not put this on the open internet without protecting it.**
>
> There is no user accounts system here. Every click on Generate spends real
> money from the team's prepaid balance, and the server will happily serve
> anyone who can reach the port. Exposed publicly — port-forwarded, on a cloud
> VM with an open security group, or behind a tunnel like ngrok — it is an open
> invitation to drain the credits, and you will find out from the bill.
>
> At minimum set `TEAM_PASSWORD`. Better: keep it on the LAN or behind a VPN. If
> it genuinely has to be public, put a real authenticating reverse proxy in
> front of it.

`TEAM_PASSWORD` is a shared secret, not an accounts system. It stops a passer-by,
not a determined attacker, and it is compared in constant time so it cannot be
guessed a character at a time. The browser keeps it in `localStorage` so nobody
has to retype it every morning.

---

## Models and prices

| Model | Shown as | 1k | 2k | Per source image on edits |
|---|---|---|---|---|
| `grok-imagine-image-quality` | Imagine 1.5 Quality *(default)* | $0.05 | $0.07 | $0.01 |
| `grok-imagine-image-2.0` — low | Imagine 2.0 | $0.04 | $0.06 | $0.01 |
| `grok-imagine-image-2.0` — medium | Imagine 2.0 | $0.06 | $0.08 | $0.01 |
| `grok-imagine-image` | Imagine 1.0 | $0.02 | $0.02 | $0.002 |

All figures USD, per image.

**Verify these against <https://docs.x.ai/developers/pricing>.** They live in one
constant at the top of `server.js` and are used *only* for the local estimate
and the usage log — they are never sent to xAI, and nothing here reads your real
balance. If xAI changes its prices, this file is what goes stale.

A few things worth knowing:

- **Quality only exists on Imagine 2.0.** Sending a `quality` parameter to any
  other model is a 400, so the control only appears when 2.0 is selected.
- **On 2.0, "Auto" is not one price.** It bills *low* for generation and *medium*
  for editing. The estimate reflects that.
- **Edits are priced at the 1k rate plus one input charge.** The edits endpoint
  takes no resolution parameter, so the output size is not something you choose.
- **Sizes are shown in pixels, not as `1k`/`2k`.** They come from a table measured
  against the live API — see below.

### Output sizes

xAI holds the shape you ask for exactly, but the pixel sizes are its own and are
not derivable from a formula: 1:1 doubles between 1k and 2k while 16:9 grows by
2.2×. These were measured, one image per combination, on 4 September 2026.

| Shape | 1k | 2k |
|---|---|---|
| 1:1 | 1024×1024 | 2048×2048 |
| 16:9 | 1280×720 | 2816×1584 |
| 9:16 | 720×1280 | 1584×2816 |
| 4:3 | 1152×864 | 2368×1776 |
| 3:4 | 864×1152 | 1776×2368 |
| 3:2 | 1248×832 | 2496×1664 |
| 2:3 | 832×1248 | 1664×2496 |
| 2:1 | 1408×704 | 2912×1456 |
| 21:9 | 1568×672 | 3136×1344 |

On **Auto** the model picks the shape, so the size depends on what it chooses;
the rail quotes the budget (≈1 MP or ≈4 MP) instead of inventing a pair. Results
and the lightbox always report the dimensions of the image that actually arrived,
so if xAI changes this table you will see it there first — and the table in
`public/app.js` should then be re-measured, not recalculated.

**Formats differ too:** 1k comes back as JPEG and 2k as PNG, and nothing in the
request says which. The app reads it off the returned bytes, so downloads get the
right extension.

### How frames are requested

Asking for six frames sends **six separate requests, one image each**, three at a
time, rather than one request for six.

This is deliberate, and measured. Inside a single request xAI generates images one
after another: one frame took 10.6s, four took 105s. So a batch showed nothing
until the last frame finished, and at 2k a batch of seven or more ran past the
server's timeout — losing work that had almost certainly already been billed.

Separate requests **do** run in parallel. Three at once completed in 5.3s against
14.9s if run one after another, with no rate limiting. So this is roughly a
2.8× speed-up as well as a usability fix.

The cost is identical either way: xAI bills per image, not per request.

To change how many run at once, edit `FRAME_CONCURRENCY` near the run section in
`public/app.js`. Three is tested and safe; higher is untested and may trip the
shared key's rate limit.

### Saved images

Every generated image is written to `DATA_DIR/images` under a random name like
`bdeda2c1ad4a2315d7e295be4a6786bb.png`. The spend log records which files belong
to which run, so opening the app rebuilds the recent runs into the results column
exactly as they looked.

The endpoints behind it:

| | |
|---|---|
| `GET /api/runs?limit=20` | recent runs and their image ids — **password required** |
| `GET /api/image/<id>` | the bytes — **no password**, see below |
| `DELETE /api/image/<id>` | delete one — **password required** |
| `POST /api/images/delete` | `{ids:[…]}`, up to 200 — **password required** |
| `POST /api/favourite` | `{id, favourite:true\|false}` — **password required** |

Reading an image needs no password because a browser cannot attach a header to
an `<img src>`. The id is a 128-bit random value and the password-protected
listing is the only way to learn one, so **the id is the access grant — treat an
image URL as shareable with anyone.** Everything that *changes* something does
require the password.

Ids whose file has been pruned or deleted are filtered out of the listing, so the
page is never handed a link that will 404.

### Favourites and deleting

Each image has a **Favourite** toggle and a **Delete** action, and a checkbox for
selecting several at once. With anything selected, a bar appears above the runs
offering Download, Delete and Clear selection.

Deleting cannot be undone, so the button asks a second time in place — it becomes
"Delete for good?" (or "Delete 3 permanently?") for four seconds. There is no
modal and no toast, which is consistent with the rest of the product.

Two things worth knowing:

- **Favourites are never pruned**, and they are not counted against
  `MAX_STORED_IMAGES` either — so marking a lot of images cannot quietly stop new
  ones being kept. That is what favouriting is *for*: protecting something from
  the automatic clear-out.
- **Deleting removes the picture, not the spend record.** The money was spent
  whether or not you kept the result, so `usage.jsonl` and "Spent today" are
  unchanged by a delete. Generate six and delete three and the ledger still says
  you paid for six — which is the honest answer.

Storage is capped by `MAX_STORED_IMAGES` (default 400) and the oldest
non-favourites are deleted first. A 2k PNG is around 6 MB, so the default ceiling
is roughly 2.5 GB; most 1k output is 200–400 KB, so realistically far less.

To turn the whole thing off, set `SAVE_IMAGES=false`; the app then behaves as it
originally did, with results living in the browser tab only.

> **On Railway, Fly, or any container host, the filesystem is wiped on every
> redeploy.** Mount a volume and set `DATA_DIR` to it, or the images and the
> spend log disappear each time you deploy.

### Editing several photos at once

Drop up to ten photos into edit mode and the same instruction is applied to each,
one image back per photo — ten photos, ten separate requests, ten results. The
cost line shows the total before you commit, and each photo carries its own input
charge.

**The endpoint takes one source image per request, and that is a real limit.**
It will accept an array without complaint, but testing showed only the first
image is used: sending a green photo and a magenta one with the instruction
"return the SECOND photo" returned the green one. So edit mode edits photos *in
a batch*; it does not merge them. For that, use Combine.

### Combine — one image from several references

Drop reference photos, say what you want made from them, and Combine produces a
single new image. It runs in two stages:

1. **The photos are read.** They go to a chat model that accepts image input
   (`VISION_MODEL`, default `grok-4.20-non-reasoning`), which sees all of them at
   once and writes one detailed generation prompt.
2. **That prompt is generated normally.** Same models, shapes, sizes, quality and
   frame counts as any other run — Combine is a generation, not an edit.

The written prompt appears under your instruction on the run card, so a poor
result can be traced to a poor prompt and reworded rather than guessed at.

#### Telling it exactly what you want

Three things make the reading step precise rather than a guess.

**Photos are numbered, and the model is told the numbers.** Each one is
announced — *"Photo 1 — use this for the subject."* — before it is shown. Without
that, "photo 1" in your instruction is something the model has to infer from
message order, and an instruction naming a photo can land on the wrong one.

**Each photo has a role.** A dropdown on every reference says what to take from
it: Subject, Setting, Style, Pose, Clothing, Lighting, or *Any part of it*. This
is what removes the ambiguity in something like "swap A with B". Tested with two
portraits — a dark-haired woman and a blonde one:

| Roles | Result |
|---|---|
| photo 1 = Subject, photo 2 = Clothing | dark hair, white collared shirt |
| photo 1 = Clothing, photo 2 = Subject | blonde curls, black long-sleeved top |

Swapping the roles swapped the output, which is the point.

**Your wording is kept.** This is the default and it matters: what you type is
used *exactly as typed*, and the photos only add detail after it.

```
A moody low-key portrait, hard rim light from behind, deep shadows,
shot on 85mm, film grain.                          ← your words, verbatim
Woman with long straight dark brown hair, fair
skin, dark eyes, wearing black top.                ← from photo 1 (Subject)
White collared button-up shirt, crisp cotton
fabric, structured collar.                         ← from photo 2 (Clothing)
```

The reading model is told your prompt already exists and that anything it
describes outside a photo's stated role will fight your wording — so with a
Subject role it describes the person and *not* the lighting, framing or
background, which are yours to set. Without that rule it kept appending "soft
even studio lighting" to prompts that asked for hard rim light.

**Let it rewrite** is the other option, one tap away. The model authors the whole
prompt from your photos. It reads better and is more evocative, but your wording
is replaced — which is why it is not the default.

**The prompt is editable either way.** If it is nearly right, fix it in the rail
and run again — it uses your version and does **not** pay to read the photos a
second time. "Read the photos again" clears it. Changing the photos, or switching
between Keep and Rewrite, clears it too, since the old text no longer matches.

One thing the reading model is told explicitly: the image model cannot see the
photos and cannot follow instructions, so the prompt must describe the finished
picture rather than say "swap" or "replace". That alone fixes a lot of the
confusing results.

Reading costs about **$0.003** — a fraction of a cent beside an image — and
happens once per run however many frames you ask for. "Again" re-uses the prompt
already written rather than paying to read the photos twice.

#### Why it works this way

The image endpoints cannot take more than one reference. This was measured, not
assumed:

- **`/images/edits` takes exactly one source image.** Passing an array does not
  give it several: `image` deserialises as a single two-field struct, so
  `[a, b]` means `{url: a, type: b}`. The error for a one-element array says it
  outright — *"invalid length 1, expected struct ImageUrl with 2 elements"*.
- **`/images/generations` ignores an `image` field entirely.** It accepts one
  without complaint and generates from the prompt alone.

An earlier version composited the photos into one picture and sent that through
the edits endpoint. It produced poor results for a reason obvious in hindsight:
an edit endpoint edits the picture it is given, so a side-by-side went in and an
edited side-by-side came out. Reading the references and generating fresh is what
actually works.

#### What it will not do

**It does not copy likeness.** There is no reference-image input on the
generation endpoint, so the output is a new image *described from* your
references, not a composite of them. A specific person's face will not survive
the round trip. For identity-preserving face swaps you need a tool built for
that — this API cannot do it, and no wording of the prompt changes that.

What it is good at is compositional: a subject in a different setting, an object
in a new scene, one photo's styling applied to another's content.

### Imagine 1.5 Quality retires on 2 November 2026

After that date, calls to `grok-imagine-image-quality` are served by
`grok-imagine-image-2.0` at low quality — same request, different picture. Whenever
that model is selected the rail shows a live day count, switching to hours inside
the last two days, and to a "retired" notice after the date. The count is computed
from the current date each time the page loads or regains focus; nothing is
hardcoded, so it stays honest without anyone editing it.

If you have approved images made with 1.5 Quality, re-check them before the date.

---

## Where the money is tracked

Two separate things, and they count differently.

**"Spent today" in the top bar** is this browser's runs, from `localStorage`,
reset at local midnight. It is not the shared balance — a colleague's spending
never shows up there. It increments only when a run completes, never on a
failure.

**`usage.jsonl`** sits next to `server.js` and records every image generated by
everyone, one JSON object per line:

```json
{"timestamp":"2026-09-04T16:55:26.213Z","runId":"run-3-mtniakty","user":"Nadia R.","mode":"generate","model":"grok-imagine-image","quality":null,"resolution":"1k","aspect_ratio":"4:3","images":1,"cost":0.02,"degraded":false,"prompt":"a ceramic vase on a plaster shelf"}
```

The `mode` field is `generate`, `edit` or `combine`, so the log says what was
actually done rather than lumping the two photo modes together.

**One line per image, not per run.** Because each frame is its own request, a
six-frame run writes six lines. They all carry the same `runId`, which is what
groups them back into one press of the button — `/api/usage` counts distinct run
ids, so it reports runs rather than lines.

Reading it:

```bash
# today's total
grep "$(date +%Y-%m-%d)" usage.jsonl | node -e "let t=0;require('readline').createInterface({input:process.stdin}).on('line',l=>t+=JSON.parse(l).cost).on('close',()=>console.log('$'+t.toFixed(2)))"

# spend per person, all time
node -e "const fs=require('fs');const b={};for(const l of fs.readFileSync('usage.jsonl','utf8').split('\n').filter(Boolean)){const r=JSON.parse(l);b[r.user||'(no name)']=(b[r.user||'(no name)']||0)+r.cost}console.table(b)"

# group the last few lines back into runs
node -e "const fs=require('fs');const g={};for(const l of fs.readFileSync('usage.jsonl','utf8').split('\n').filter(Boolean)){const r=JSON.parse(l);const k=r.runId||r.timestamp;(g[k]=g[k]||{frames:0,cost:0,prompt:r.prompt,user:r.user})&&(g[k].frames++,g[k].cost+=r.cost)}console.table(Object.values(g).slice(-10))"

# the last ten images
tail -n 10 usage.jsonl
```

`GET /api/usage` returns the same data aggregated: `{ runs, images, total, today, recent }`.

> **The `user` field is self-reported.** It is whatever someone typed in the
> "Working as" box, saved in their browser, with nothing checking it. Treat it as
> attribution among colleagues who are trying to be helpful — "who made this
> one?" — and never as an audit trail. Anyone can type anyone's name, or leave it
> blank.

`usage.jsonl` is gitignored, along with `.env`. Neither should ever be committed.

---

## Things that are deliberate

- **Runs survive a refresh.** Every generated image is written to disk on the
  server, and the twenty most recent runs are restored into the results column
  when the page loads — the same cards, not a separate history screen. Older runs
  fall off the list once `MAX_STORED_IMAGES` is reached.
- **Images come back as base64, not links.** xAI's hosted URLs are temporary, so
  a page full of them would quietly rot into broken images. The server asks for
  bytes and hands those to the browser. It still understands a URL response if
  xAI sends one.
- **A run that returns nothing charges nothing and leaves no card.** Errors sit
  under the action button until the next successful action — no toasts anywhere.
- **A partly successful run keeps what arrived.** Frames that failed show a card
  offering to retry just that one, and you are charged only for what came back.
- **Cancel keeps the frames already returned** and charges for them, because that
  money is genuinely spent. It says so in the run header and in the notice.
- **If one optional setting is rejected, the run is retried without it.** You get
  a warning saying the settings were dropped, and the run is priced at what was
  actually billed, not what you asked for.

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `XAI_API_KEY` | *(none)* | Required. Without it the UI loads but generating is switched off. |
| `TEAM_PASSWORD` | *(none)* | Optional. When set, every `/api` route except `/api/config` needs it. |
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | All interfaces. Use `127.0.0.1` to restrict to this machine. |
| `UPSTREAM_TIMEOUT_MS` | `180000` | How long to wait for xAI before giving up. |
| `DATA_DIR` | project folder | Where saved images and `usage.jsonl` live. Point at a mounted volume on any host with an ephemeral disk. |
| `SAVE_IMAGES` | `true` | Set `false` to keep results in the browser tab only. |
| `MAX_STORED_IMAGES` | `400` | Oldest images are pruned past this count. |
| `VISION_MODEL` | `grok-4.20-non-reasoning` | Chat model that reads reference photos in Combine mode. Must accept image input. |
| `USD_PER_TICK` | `1e-10` | Converts xAI chat usage ticks to dollars for the running total. Verify against the pricing page. |
| `XAI_BASE_URL` | `https://api.x.ai/v1` | Only for a gateway, or a stub while testing. |

Real environment variables win over `.env`.

---

## Troubleshooting

Keyed to the messages the app actually shows.

**"No API key on the server"**
`XAI_API_KEY` is missing or empty. Add it to `.env` and restart — the server
reads `.env` once at boot. Nothing you change in the browser will fix this. Check
the startup log: it prints `API key loaded` or `API key MISSING`.

**"Password not recognised"**
The password does not match `TEAM_PASSWORD`. The usual cause is a trailing space
or a smart quote pasted from chat. Check `.env` for quotes around the value —
they are stripped, but only matched pairs.

**"xAI rejected the team key"**
The key reached xAI and was refused. It is wrong, revoked, or from a different
account. Note that xAI answers a bad key with a 400, not a 401. Re-issue at
<https://console.x.ai>.

**"The prompt was blocked, no images returned"**
Moderation filtered it. xAI returned success with an empty list — most often over
a named person, a brand, or violence. Rewrite the subject plainly. Nothing was
charged.

**"Too many runs in a row"**
Rate limited on the shared key, often because someone else is generating at the
same time. The button unlocks on the countdown, which comes from xAI's own
`retry-after`. Nothing was charged.

**"The prepaid credits ran out"**
The account balance is empty. Top it up in the xAI console. Images already on the
page still download.

**"Add a photo to edit"**
Edit mode needs at least one photo. Drop up to ten and the same instruction is
applied to each. If you were hoping to combine two photos into one, that is not
something the API supports — see *Editing several photos at once* above.

**"Some frames did not arrive"**
Part of a run failed while the rest succeeded. The images that came back are kept
and charged; the ones that did not show a card with an Again button that retries
just that frame. If it keeps happening on a whole batch, the shared key is
probably rate limited — wait a moment and retry.

**"Run cancelled"**
You pressed Cancel. Frames already returned are kept and charged, because xAI had
finished making them. Frames not yet started cost nothing.

**"Timed out after 180 seconds"**
xAI accepted the request and never answered. Large sizes and high frame counts
are the usual cause — try 1k, or fewer frames. Nothing came back, so nothing was
charged. Raise `UPSTREAM_TIMEOUT_MS` if your runs are legitimately slow.

**"Could not reach xAI"**
The *server* could not open a connection — DNS, proxy, or no internet on the host
machine. This is not the user's network. From the host, try
`curl https://api.x.ai/v1`.

**"Could not reach the studio server"**
The browser could not reach `server.js`. It has stopped, or the machine went to
sleep, or you are on the wrong LAN address.

**"Run completed with fewer settings"**
xAI refused one optional parameter, so it was retried with just the essentials.
The images are real and charged, but shape, size and quality did not apply. If it
keeps happening on one model, that model probably does not accept that parameter.

**"xAI returned 5xx"** *(or any unmapped code)*
Upstream trouble. Retry, then post the code in #design-ops. The message shown is
xAI's own, not a substitute.

**"Port 8787 is already in use"**
Almost always because the studio is already running — open
<http://localhost:8787> before starting a second copy. If something else has the
port, either stop it or set a different `PORT` in `.env`. To see what is holding
it, run `netstat -ano | findstr :8787` on Windows, or `lsof -i :8787` on
macOS and Linux.

**The page loads but nothing is styled, or the console 404s**
`server.js` serves from `public/`. Run it from the project root — `node server.js`,
not `node ../server.js`.

---

## Layout

```
server.js          the proxy, key handling, price table, usage log
public/index.html
public/styles.css
public/app.js      vanilla JS, no framework
.env.example
.gitignore         excludes .env and usage.jsonl
usage.jsonl        created on the first successful run
```
