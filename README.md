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

### Password guessing is throttled

Failed password attempts are counted per address: five are free, then every
further failure locks that address out for a delay that doubles from two
seconds up to fifteen minutes. During a lockout every request from the address
gets the same "Password not recognised" as a wrong password, so the response
never says whether the address is being throttled. A correct password, when not
locked out, clears the count. Lockouts are printed to stderr, which on Railway
is the deploy log. The counts are in memory and a restart forgets them.

This protects against guessing, and only that. It does nothing against someone
who already has the password, and it will not stop a patient attacker forever.
The real boundary is not putting the URL anywhere public: no link in a shared
document, no post, no screenshot with the address in it.

## Using the studio

The page is a gallery with one composer docked at the bottom. Everything you
type or attach lives there.

- **No modes.** With nothing attached it generates. Attach a photo and it
  edits. Attach two or more and a switch asks: *Combine into one* or *Edit each*.
- **Attaching photos.** The **+** tile, a drop anywhere on the page, or a paste
  from the clipboard. Each photo becomes a chip; the first is the *Base*.
  Drag chips to reorder, or focus one and press Alt with the left or right
  arrow. Click a chip for its menu: make it the base, move it, crop it,
  remove it.
- **Referring to a photo.** Type `@` in the prompt and pick one. It inserts the
  plain words "photo 2", which is what the model reads.
- **Settings are pills** under the prompt: model, shape, size, quality, and a
  stepper for frames (variants on an edit). Each opens a small menu above it
  with the price on every row; shape is a grid of little frames drawn to each
  ratio. The estimated cost sits by the button. Ctrl + Enter submits.
- **Tags in the prompt.** With photos attached, "photo 2" in the prompt gets a
  tinted ground so a reference reads as a tag. Name a photo that is not there —
  "photo 5" with three attached — and the tag turns amber.
- **Recent prompts.** Press the up arrow in an empty prompt for the last few,
  kept in this browser.
- **It rests.** With nothing typed or attached and the focus elsewhere, the
  composer folds to a slim bar so the gallery has the screen. Click it, or
  press `/`, and it opens.
- **The gallery** is one wall of pictures under each date, packed so that tall
  and wide frames sit together uncropped. The slider in the top bar sets how
  large they are drawn. Point at a picture and the others from the same run
  outline themselves. Older history loads as you scroll.
- **The viewer.** Click a picture: the page blurs behind it and a card on the
  right holds the prompt, the photos it was made from, model, size, cost, when
  and by whom — and every action. Scroll or pinch to zoom, drag to move,
  double-click to zoom in and out. For an edit, *Before / after* lays the
  original over the result with a divider to drag. A filmstrip along the bottom
  jumps between the pictures of the run. Hide the card for the whole window. On
  a phone, swipe sideways between pictures, swipe down to close, and pull the
  sheet up for the details.
- **Deleting can be undone** for ten seconds. The server moves the file aside
  rather than destroying it, so Undo brings back the same picture, in the same
  place, with its star. After ten minutes it is gone for good.
- **Small confirmations** — added to library, prompt copied, picture restored —
  appear briefly at the bottom left. Errors never do: they stay above the
  composer until dealt with.
- **Yours alone**, from the round button at the top right: your *Working as*
  name, dark or light, an accent colour, a desktop notification when a run
  finishes in a background tab (off unless you switch it on), and the list of
  keyboard shortcuts, which `?` also opens. While a run is going the browser
  tab shows its progress, "(2/4)".
- **Prompts — `/asset`.** Every prompt anyone uses is saved on the server for the
  whole team, a card each, at its own address so it can be bookmarked. *Use
  this prompt* puts it in the box; the icons copy it, star it (favourites come
  first and are never cleared) and delete it, with an Undo. Search by words or
  by person. It is filled from your existing history the first time it opens.
- **What's new.** A few seconds after signing in, anyone who has not yet seen
  the latest update is shown a short card describing it — once. It can be
  reopened from the round button at the top right.
- **History keeps the photos.** The photos attached to an edit are saved with
  it and shown on its card in the viewer. *Reuse photos and prompt* puts
  them back in the composer, in their original order; *Run this again* repeats
  the edit as it was. Neither needs the files found and attached again, and
  both still work after a reload.
- **Library.** Star a frame and it goes in the *Library*: one wall of every
  favourite, loaded from the whole history rather than only the recent runs.
  Favourites are never cleared to make room.
- **Top bar.** *All / Mine / Library* chooses what the gallery shows. Beside
  *Spent today* it shows what is left of the prepaid credit, when the server has
  been given a management key (below). The round button holds your *Working as*
  name and the dark or light theme.
- **Permission.** The first combined edit of a session asks you to confirm you
  have permission to use the likenesses involved.

## Models and prices

| Model | Shown as | 1k | 2k | Per source image on edits |
|---|---|---|---|---|
| `grok-imagine-image-quality` | Imagine 1.5 Quality | $0.05 | $0.07 | $0.01 |
| `grok-imagine-image-2.0` — low | Imagine 2.0 *(default)* | $0.04 | $0.06 | $0.01 |
| `grok-imagine-image-2.0` — medium | Imagine 2.0 | $0.06 | $0.08 | $0.01 |
| `grok-imagine-image` | Imagine 1.0 | $0.02 | $0.02 | $0.002 |

All figures USD, per image.

**Imagine 2.0 is the default.** It is the model xAI is keeping: 1.5 Quality
retires on 2 November 2026 and is served by 2.0 from then on. Anyone who has
already picked a model keeps their choice; only people who never chose one start
on 2.0. With quality left on Auto, 2.0 bills the low tier for generation and the
medium tier for edits.

**Verify these against <https://docs.x.ai/developers/pricing>.** They live in one
constant at the top of `server.js` and are used *only* for the local estimate
and the usage log — they are never sent to xAI, and nothing here reads your real
balance. If xAI changes its prices, this file is what goes stale.

A few things worth knowing:

- **Quality only exists on Imagine 2.0.** Sending a `quality` parameter to any
  other model is a 400, so the control only appears when 2.0 is selected.
- **On 2.0, "Auto" is not one price.** It bills *low* for generation and *medium*
  for editing. The estimate reflects that.
- **An edit costs the output price at the size you choose, plus an input charge
  for every photo sent.** Three photos combined at 2K is one output and three
  inputs. What is actually charged comes from xAI's own figure on each response.
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
the size pill's list quotes the budget (about 1 MP or about 4 MP) instead of inventing a pair. Results
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

#### Keeping the history across deploys (Railway)

On Railway, Fly, or any container host, the service's own disk is replaced on
every deploy. Without a volume, every push to GitHub empties the results column,
the favourites and the spend log. The saving code is not at fault: the files
were written, and then the disk they were on was thrown away.

The fix is a volume, done once in the Railway dashboard:

1. Open the project, right-click the service, choose **Attach Volume**.
2. Mount path: `/data`. Create it. Railway redeploys the service.
3. Leave `DATA_DIR` unset. The server uses an attached Railway volume on its
   own. If `DATA_DIR` is already set, either delete it or make it a folder
   inside the volume, such as `/data`.

Check the deploy log after it restarts. It should say
`Data folder       /data  (from Railway volume)`. If it instead prints
`[storage] WARNING: saved images and the usage log will be LOST on the next
deploy`, the line under it says why: no volume attached, or `DATA_DIR` pointing
somewhere outside it.

Anything generated *before* the volume existed is on the old disk and goes with
it. Download what matters before attaching the volume; nothing after that point
is lost to a deploy. A volume has a size limit set by your Railway plan, and
`MAX_STORED_IMAGES` is what keeps the app under it.

### Editing several photos at once

Attach two or more photos and a switch appears in the composer asking which of two
different things you want, because it cannot guess:

- **Combine into one** *(the default)* — one image out. The first photo is the
  base and everything in it is kept; the others contribute only what the prompt
  asks for. This is the reference edit described below.
- **Edit each** — the same instruction applied to every photo, one image back
  per photo. Ten photos, ten separate requests, ten results, each carrying its
  own input charge.

### Combining photos into one

xAI's edit endpoint takes **up to five source images in one request**, through
the plural `images` field, and it transfers identity from them. This was
measured, not assumed: in a seven-run experiment the base photo kept its pose,
clothing, backdrop and framing while the face, hair and eye colour came from
the second photo, recognisably the same person. The singular `image` field —
the only one the studio used to send — transfers nothing, which is why the
earlier "Combine" mode existed and why it has now been retired.

**Order is the result.** The first photo is the base, marked with a *Base*
badge. Reversing the order reversed the transfer in testing. Drag a row, or use
its arrows, to change which photo is the base.

**Crop the references, not the base.** Each non-base photo has a *Crop*
button. Draw a box around what should carry over — head and shoulders for a
face, nothing else. The crop is cut from the untouched original and upscaled so
its short side is at least 1536 px with smoothing off (nearest neighbour), the
treatment that gave the closest likeness in testing. It costs nothing extra.

**Imagine 2.0 at 2k, by default.** The moment a second photo lands, the model
switches to Imagine 2.0 and the size to 2k. Resolution made the widest
difference in the experiment — 1k was the weakest transfer of the four — so the
size pill turns amber, and the hint line says why, if you drop back to 1K. A choice you make after that stands.

**Variants.** The count slider becomes *Variants* on an edit, one to four, so
one run gives several draws to choose from. Each variant is its own request and
re-sends every source photo, which is why the cap is lower than generation's
ten and why the estimate grows with the number of photos.

**Shape and size are sent on edits now.** Left on *Same as the base photo*, the
output follows the first photo; pick a shape and it is honoured instead.

#### The pattern that works: name each photo and say what to take from it

This is the core skill for the tool and nothing in the UI teaches it. The
model does not guess which photo is for what; the prompt says so, by number,
in the order the photos sit in the list. The live run that verified the
feature used three photos:

1. **Photo 1, the base** — a woman with long dark hair in a black top on a
   grey backdrop. Everything about it is kept.
2. **Photo 2, cropped to head and shoulders** — a different woman: blonde
   curls, green eyes.
3. **Photo 3, the whole picture** — the second woman again, in a white
   collared shirt. Used only for the shirt.

The prompt, as sent:

> Photo 1 is the base: keep its pose, framing, grey background and lighting
> exactly. Replace only the head with the person in photo 2 — her exact face,
> bone structure, eye colour, skin tone, hairstyle, hair length and hair
> colour, adapted to photo 1's head angle and light. Replace the black top
> with the white collared shirt worn in photo 3, fitted to photo 1's body.
> Change nothing else. No other people.

All five images that came back had photo 1's pose, framing and backdrop,
photo 2's face, hair and eyes — recognisably her — and photo 3's shirt. The
shape of the prompt is what carries it:

- **Say what the base keeps**, in a list, before saying what changes. "Keep
  its pose, framing, background and lighting exactly."
- **Name the photo for each element by number**, and say exactly which part
  of it to take: "the head from photo 2", "the shirt from photo 3". A photo
  named with no part named lends whatever the model finds most salient.
- **Say what to adapt**, so the transplanted part fits: head angle, light
  direction, skin tone at the neck.
- **Close with "change nothing else"**, which is what stops the background
  and clothing drifting.
- **Crop the reference to the part you want.** Photo 2 was cropped to the
  head; photo 3 was left whole because the shirt needed the whole frame.

Reversing the photo order reverses the result, so the badge marked *Base*
is the one being kept.

#### Variants come back very similar

Four variants from one request differed only in individual curls and the exact
eyebrow line — same face, same shirt, same framing. If a result is wrong,
change the prompt or the crop and run once. Do not spend on four variants
expecting four different options. The hint line under the composer says the same whenever
variants is above one.

#### Permission and the likeness rule

Combining photos puts a real person's face into a new picture. Two things are
required, in code, not left to whoever is at the keyboard:

1. **Confirmation, once a session.** Before the first combined edit, a notice
   asks you to confirm you have permission from everyone shown. The server
   refuses a combined edit that does not carry that confirmation
   (`consent_required`).
2. **No sexualised material.** A combined edit whose instruction sexualises the
   result is refused outright (`likeness_policy`), and nothing is charged.

The second rule reads the instruction, not the photographs. Judging what is in
a source image would need a vision pass on every run; that is not done, so xAI's
own moderation remains the backstop for the pictures themselves.

#### Cost comes from the API

Every image response carries `usage.cost_in_usd_ticks`, at 10⁻¹⁰ USD a tick
(a $0.02 generation reports 200000000). The running total, the run card and
`usage.jsonl` all use that figure. The price table is now only the estimate
shown before a run, and a fallback if a response ever arrives without a usage
block — in which case the run is marked `costEstimated` and the card shows
the amount with a tilde.

#### What became of Combine mode

The old mode sent the reference photos to a chat model (`/api/describe`),
had it write a prompt, and generated from that. It was built to work around a
limitation the edit endpoint does not have. The tab is gone and the client code
with it. The endpoint stays, unchanged, to be repurposed as a
preservation-inventory extractor.

### Imagine 1.5 Quality retires on 2 November 2026

After that date, calls to `grok-imagine-image-quality` are served by
`grok-imagine-image-2.0` at low quality — same request, different picture. Whenever
that model is selected a notice above the composer shows a live day count, switching to hours inside
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

The `mode` field is `generate` or `edit`. An edit line also records `sources`
(how many photos went in) and `reference` (whether they were combined into one
image or edited apart), and every line carries `costEstimated` — `false` when
the amount is what xAI reported, `true` on the rare response with no usage
block.

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

### Telling the team what changed

`public/whats-new.json` is a list of updates, newest first. Each has an `id`, a
`date`, a `title` and a few `items` (a short `title` and a sentence of `body`).
When the first entry's `id` is one a person's browser has not seen, the card is
shown to them after sign-in, along with any others they missed. **Add an entry
at the top with every change people will notice** — a new `id` is what makes the
card appear. Nothing else needs touching.

### The prompt library

Prompts are kept in `DATA_DIR/prompts.json`: the full text (the usage log keeps
only the first 300 characters), who used it last, how often, and when. The same
words used again count as another use of one entry, and the several frames of
one run count once. Past 500 entries the least recently used go first, never a
favourite. The file is in `.gitignore`. Like everything else it needs
`DATA_DIR` to be on a mounted volume to survive a deploy.

### Showing what is left of the credit

*Spent today* is this app's own count. What is actually left on the xAI account
can only be read from xAI's **Management API**, a separate service with its own
key. It is optional:

1. In the xAI console open **Settings → Management Keys** and create a key.
2. Set it on the server as `XAI_MANAGEMENT_KEY` (on Railway, in Variables).
3. Restart. The top bar now reads `Spent today $2.40 · $41.27 left`.

The server makes two read-only billing calls, caches the answer for a minute,
and never sends the key to the browser. The figure is the prepaid ledger less
what has been used in the current billing cycle, because xAI only posts spend
to the ledger when a cycle closes. **Compare it once against the console's
Billing page** after setting it up. A `≈` before the amount means this cycle's
spend could not be read, so the real figure may be lower. Under $5 it turns
amber. If the key is missing, wrong, or xAI is not answering, the amount is
simply not shown — nothing about generating depends on it — and the reason is
printed once in the deploy log as `[balance]`.

### The photos attached to edits are kept

So that a past edit can be repeated, the photos sent with it are saved in
`DATA_DIR/sources`, named by a hash of their contents, so the same photo is
stored once however often it is used. They follow the same rule as generated
images: fetched by an unguessable name, listed only behind the password, and
the oldest are cleared past `MAX_STORED_IMAGES` (counted separately from the
images). These are often pictures of real people. `sources/` is in
`.gitignore`; treat the data folder and any backup of it accordingly. Setting
`SAVE_IMAGES=false` stops them being kept, along with everything else.

### Reading failures in the deploy log

Every request xAI refuses, and every one that times out or cannot connect,
writes one line to stderr. On Railway that is the service's deploy log; search
it for `xai-fail`.

```
[xai-fail] 2026-09-18T05:59:20.534Z status=404 code=model_unavailable mode=edit model=grok-imagine-image-quality photos=2 size=2k shape=auto n=1 user="Nadia R." x-request-id=… msg="The model grok-imagine-image-quality does not exist or your team …"
```

The line says when, who (the *Working as* name), generate or edit, which model,
how many photos, the size and shape asked for, the status, this app's name for
the failure, any request-id or region header xAI sent, and xAI's own message.
It never contains the prompt, image data, the password or anyone's address.

**Temporary or real?** Successes are in `usage.jsonl`, failures are here. A
short cluster of `xai-fail` lines for one model, with successes on that model
before and after, is a blip at xAI. Lines that keep coming and never stop are a
real fault. The `x-request-id` is what xAI support will ask for.

A line starting `[xai-retry]` means a request was refused once, then succeeded
when retried without the optional settings. The person got an image, but not at
the shape, size or quality they chose; the line says what xAI objected to.

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
| `DATA_DIR` | an attached Railway volume if there is one, else the project folder | Where saved images, favourites and `usage.jsonl` live. Must be on a mounted volume on any host that replaces its disk on deploy. |
| `SAVE_IMAGES` | `true` | Set `false` to keep results in the browser tab only. |
| `MAX_STORED_IMAGES` | `400` | Oldest images are pruned past this count. |
| `SHUTDOWN_GRACE_MS` | `8000` | How long requests in flight are given to finish when the server is told to stop. |
| `STUDIO_NAME` | `Imagine studio` | What the studio calls itself in the top bar, on the password screen and in the browser tab. |
| `XAI_MANAGEMENT_KEY` | *(none)* | Optional. An xAI **management** key. When set, the top bar shows the prepaid credit that is left. Read-only billing calls; never sent to the browser. |
| `XAI_TEAM_ID` | looked up from the API key | Only needed if that lookup fails. |
| `VISION_MODEL` | `grok-4.20-non-reasoning` | Chat model behind `/api/describe`, which reads photographs and answers in text. Must accept image input. |
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

**The button did nothing**
It is never disabled without a word: press it and the line under the composer
says what is missing — a prompt, three words, or too many photos to combine.

**"Confirm permission first"**
A combined edit was sent without the once-a-session confirmation. Tick the box
under the photos and run it again. Nothing was charged.

**"This studio will not make that"**
The instruction for a combined edit was sexualised. That is refused in code, for
every person, every session. Nothing was charged.

**"Imagine 1.5 Quality is not answering right now"** (or any model's name)
xAI answered with *"The model … does not exist or your team … does not have
access to it"*. That wording reads like a permissions or billing problem and,
so far, has been neither. On 18 September 2026 it appeared three times in two
minutes against a model the team had access to, with credit in the account, and
the same model worked again later that day: xAI stopped serving it to our
server for a few minutes. Nothing is charged for a request turned away like
this. Switch model, or wait a few minutes. If it never recovers — see the next
section for how to tell — then it is real: check the model still exists in the
xAI console and that the key on the server can use it.

**Railway says "Deployment crashed" after every redeploy**
If the deploy log ends with `Stopping Container` and `npm error signal SIGTERM`,
nothing crashed: Railway stopped the old container to start the new one, the
process died abruptly, and the abrupt exit was filed as a crash. The server now
handles that signal — it stops taking requests, lets the ones in flight finish,
and exits cleanly — and `railway.json` starts it with `node server.js` directly
so the signal reaches it rather than `npm`. A healthy stop reads
`[server] SIGTERM received` then `[server] stopped cleanly`. To protect a
picture that is mid-render during a deploy, set
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60` and `SHUTDOWN_GRACE_MS=55000`.

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
server.js              the proxy, key handling, usage log, saved images
lib/imagine.js         price table, limits, the request builder and cost reading
public/index.html
public/styles.css
public/app.js          vanilla JS, no framework
public/request-body.js the body the page sends per frame; shared with the tests
test/request.test.js   node --test; run with npm test
.env.example
.gitignore             excludes .env and usage.jsonl
usage.jsonl            created on the first successful run
```

`npm test` runs the request-builder tests: one source uses `image`, two to five
use `images`, never both; order is preserved; `n`, `aspect_ratio` and
`resolution` are sent on edits; consent and the likeness rule are enforced;
cost is read from ticks. No dependencies — Node's built-in runner.
