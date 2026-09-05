#!/usr/bin/env node
'use strict';

/**
 * Imagine studio — proxy server.
 *
 * The xAI API key lives here and only here. The browser never sees it, for two
 * independent reasons: anyone with dev tools could read it and spend the team's
 * prepaid credits, and api.x.ai sends no CORS headers for browser origins, so a
 * direct fetch from a page would fail even if the key were public.
 *
 * Node 18+. No dependencies.
 */

// Global fetch and AbortSignal.timeout, both load-bearing here, do not exist
// before Node 18. Say so plainly rather than failing later with a confusing
// "fetch is not defined" in the middle of someone's first run.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 18) {
  console.error('');
  console.error('Imagine studio needs Node 18 or newer. This is Node ' + process.versions.node + '.');
  console.error('');
  console.error('Install a current version from https://nodejs.org, then run it again.');
  console.error('');
  process.exit(1);
}

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

// DATA_DIR, USAGE_LOG and IMAGE_DIR are set once the .env parser exists, below.
let DATA_DIR, USAGE_LOG, IMAGE_DIR;

const MAX_BODY_BYTES = 40 * 1024 * 1024; // base64 source images are large
const PROMPT_LOG_CHARS = 300;

// ---------------------------------------------------------------------------
// Prices, in USD.
//
// VERIFY THESE against https://docs.x.ai/developers/pricing before trusting the
// running total — xAI can change them without changing the API, and nothing here
// reads back a real balance. These numbers are used ONLY for the local estimate
// and the usage log. They are never sent to xAI.
//
//   input   charged once per source image, so it applies to edits only.
//   tiers   output price per image, by resolution.
//
// grok-imagine-image-2.0 is the only model that accepts a quality parameter.
// Leaving quality on auto bills low for generation and medium for editing, which
// is what autoQuality records.
// ---------------------------------------------------------------------------
const PRICES = {
  'grok-imagine-image-quality': {
    label: 'Imagine 1.5 Quality',
    isDefault: true,
    retiresAt: '2026-11-02T00:00:00Z',
    input: 0.01,
    tiers: { default: { '1k': 0.05, '2k': 0.07 } }
  },
  'grok-imagine-image-2.0': {
    label: 'Imagine 2.0',
    input: 0.01,
    tiers: {
      low: { '1k': 0.04, '2k': 0.06 },
      medium: { '1k': 0.06, '2k': 0.08 }
    },
    autoQuality: { generate: 'low', edit: 'medium' }
  },
  'grok-imagine-image': {
    label: 'Imagine 1.0',
    input: 0.002,
    tiers: { default: { '1k': 0.02, '2k': 0.02 } }
  }
};

// Models that accept `quality`. Sending it to any other model is a 400, so the
// client reads this array rather than hardcoding the condition.
const QUALITY_MODELS = Object.keys(PRICES).filter(function (id) {
  return !PRICES[id].tiers.default;
});

// The edits endpoint takes no resolution, so its output is priced at the 1k tier.
const EDIT_RESOLUTION = '1k';

const ASPECT_RATIOS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '21:9'];
const RESOLUTIONS = ['1k', '2k'];
const QUALITIES = ['low', 'medium', 'auto'];

// ---------------------------------------------------------------------------
// Config — a hand-parsed .env, because a dozen lines is not worth a dependency.
// ---------------------------------------------------------------------------
function loadEnvFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const quoted = value.length > 1 &&
      ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    if (key) out[key] = value;
  }
  return out;
}

const fileEnv = loadEnvFile(path.join(ROOT, '.env'));
function env(name, fallback) {
  const v = process.env[name] !== undefined ? process.env[name] : fileEnv[name];
  return v === undefined || v === '' ? fallback : v;
}

const XAI_API_KEY = String(env('XAI_API_KEY', '')).trim();
const TEAM_PASSWORD = String(env('TEAM_PASSWORD', '')).trim();
const PORT = Number(env('PORT', 8787));
const HOST = String(env('HOST', '0.0.0.0'));
const UPSTREAM_TIMEOUT_MS = Number(env('UPSTREAM_TIMEOUT_MS', 180000));

// Where generated images and the spend log are kept. On a host with an ephemeral
// filesystem — Railway, Fly, most container platforms — point DATA_DIR at a
// mounted volume, or every redeploy silently throws both away.
DATA_DIR = path.resolve(String(env('DATA_DIR', ROOT)));
USAGE_LOG = path.join(DATA_DIR, 'usage.jsonl');
IMAGE_DIR = path.join(DATA_DIR, 'images');

// Saving is what makes a run survive a refresh. Turn it off and the app behaves
// as it did before: results live in the browser tab only.
const SAVE_IMAGES = String(env('SAVE_IMAGES', 'true')).toLowerCase() !== 'false';

// Oldest images are pruned past this, so a volume cannot fill up unattended.
// A 2k PNG is around 6 MB, so 400 images is roughly 2.5 GB at worst.
const MAX_STORED_IMAGES = Math.max(0, Number(env('MAX_STORED_IMAGES', 400)) || 0);

// Prove the data directory is usable at boot rather than discovering it on the
// first generation. On a container host this is almost always a volume that was
// not mounted, or was mounted somewhere other than DATA_DIR.
let STORAGE_READY = false;
let STORAGE_PROBLEM = '';
if (SAVE_IMAGES) {
  try {
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
    const probe = path.join(IMAGE_DIR, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    STORAGE_READY = true;
  } catch (err) {
    STORAGE_PROBLEM = err.message;
    console.error('');
    console.error('Cannot write to ' + IMAGE_DIR);
    console.error('  ' + err.message);
    console.error('');
    console.error('Generated images and the spend log cannot be saved. The app will');
    console.error('still run, but results will not survive a refresh.');
    console.error('');
    console.error('On Railway, Fly or similar: mount a volume and set DATA_DIR to its');
    console.error('mount path, or set SAVE_IMAGES=false to turn saving off deliberately.');
    console.error('');
  }
}
// Only override this to route through a gateway, or to point the proxy at a
// stub while testing. It must speak the same API as api.x.ai.
const XAI_BASE = String(env('XAI_BASE_URL', 'https://api.x.ai/v1')).replace(/\/+$/, '');

// Combine mode reads the reference photos with a chat model that accepts image
// input, and has it write the generation prompt. The image endpoints take one
// source image and no reference input at all, so this is the only way to put
// several references in front of the model at once.
const VISION_MODEL = String(env('VISION_MODEL', 'grok-4.20-non-reasoning'));

// xAI reports chat usage as cost_in_usd_ticks. VERIFY the tick value against
// https://docs.x.ai/developers/pricing — like the image prices it is used only
// for the local running total, never sent anywhere. A reading step is roughly
// 340 tokens, so this is fractions of a cent next to an image.
const USD_PER_TICK = Number(env('USD_PER_TICK', 1e-10));

// What a photo is being used for. The client offers these as a dropdown on each
// reference; the text is what the reading model is actually told.
const ROLE_BRIEF = {
  subject: 'subject — the person, animal or object the picture is about',
  setting: 'setting — the place, background and surroundings',
  style: 'style — the look, palette, grain and treatment, not the content',
  pose: 'pose — the body position, gesture and camera angle',
  clothing: 'clothing — the garments, fabric and styling',
  lighting: 'lighting — the light direction, quality and mood'
};

// How the reference photos get turned into a prompt. Kept here rather than in
// the client so it can be tuned without a redeploy of anything else.
const COMBINE_SYSTEM = [
  'You write prompts for a text-to-image model.',
  'You are shown numbered reference photographs, told what each one is for, and told what the user wants made from them.',
  'Take from each photo only what its stated role calls for, and ignore the rest of that photo.',
  'If a photo has no stated role, use your judgement about what it contributes.',
  'Reply with ONE prompt for a single image, between 40 and 120 words.',
  'Describe the subject, clothing, setting, lighting, camera angle, composition and mood concretely and visually.',
  'Write it as a direct description of the finished picture, in the present tense.',
  'The image model cannot see the photographs and cannot follow instructions — it only renders what you describe,',
  'so never write an instruction like "swap", "replace", "combine" or "keep": describe the finished result instead.',
  'Never mention that references exist. Never write "photo 1", "second image", "reference" or file names.',
  'No preamble, no commentary, no quotation marks, no lists. Output the prompt text and nothing else.'
].join(' ');

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------
function tierFor(model, quality, mode) {
  const p = PRICES[model];
  if (!p) return null;
  if (p.tiers.default) return p.tiers.default;
  const q = !quality || quality === 'auto'
    ? p.autoQuality[mode === 'edit' ? 'edit' : 'generate']
    : quality;
  return p.tiers[q] || null;
}

function costFor(opts) {
  const p = PRICES[opts.model];
  const tier = tierFor(opts.model, opts.quality, opts.mode);
  // Unknown model or tier: the caller must say the cost is unknown, not guess.
  if (!p || !tier) return null;
  const res = opts.mode === 'edit'
    ? EDIT_RESOLUTION
    : (RESOLUTIONS.indexOf(opts.resolution) === -1 ? '1k' : opts.resolution);
  const per = tier[res];
  if (typeof per !== 'number') return null;
  const n = Math.max(1, Math.floor(opts.count || 1));
  const input = opts.mode === 'edit' ? p.input : 0;
  return Math.round((per * n + input) * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, payload, extraHeaders) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const headers = Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  }, extraHeaders || {});
  res.writeHead(status, headers);
  res.end(body);
}

function fail(res, status, message, extra) {
  sendJson(res, status, Object.assign({ error: message }, extra || {}));
}

// Answer an oversized upload.
//
// The client will not read the reply until it has finished sending, so tearing
// the socket down first makes this surface as a network error rather than as
// this message. Drain the rest instead — resume() discards the data without
// buffering it, so nothing is held in memory — and the client reliably gets the
// 413 it can act on.
function tooLarge(req, res) {
  req.resume();
  sendJson(res, 413, {
    error: 'That request is over the 40 MB limit. A photo encodes about a third larger than the file on disk, so use a smaller one.',
    code: 'too_large'
  });
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', function (chunk) {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        const err = new Error('body too large');
        err.code = 'BODY_TOO_LARGE';
        // Stop accumulating, but do NOT destroy the socket here — the 413 still
        // has to reach the client. The response path closes the connection.
        req.pause();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', function (err) {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

// crypto.timingSafeEqual throws on mismatched buffer lengths rather than
// returning false, so the length has to be guarded first. That check leaks only
// the password length, which is not the secret.
function passwordMatches(supplied) {
  if (!TEAM_PASSWORD) return true;
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(TEAM_PASSWORD, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Usage log
// ---------------------------------------------------------------------------
async function appendUsage(entry) {
  try {
    await fsp.appendFile(USAGE_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error('[usage] could not write ' + USAGE_LOG + ': ' + err.message);
  }
}

async function readUsage() {
  let raw;
  try {
    raw = await fsp.readFile(USAGE_LOG, 'utf8');
  } catch {
    return { runs: 0, images: 0, total: 0, today: 0, recent: [] };
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // A torn final line from a crash mid-append. Skip it rather than 500.
    }
  }
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  let total = 0;
  let today = 0;
  let images = 0;
  // One press of the button can produce several lines, so count distinct runs
  // rather than lines. Lines from before run ids existed each count as one.
  const runIds = new Set();
  let unGrouped = 0;
  for (const r of rows) {
    const cost = typeof r.cost === 'number' ? r.cost : 0;
    total += cost;
    images += typeof r.images === 'number' ? r.images : 0;
    if (r.runId) runIds.add(r.runId); else unGrouped++;
    const t = Date.parse(r.timestamp);
    if (!Number.isNaN(t) && t >= startOfDay.getTime()) today += cost;
  }
  return {
    runs: runIds.size + unGrouped,
    images: images,
    total: Math.round(total * 1e6) / 1e6,
    today: Math.round(today * 1e6) / 1e6,
    recent: rows.slice(-25).reverse()
  };
}

// ---------------------------------------------------------------------------
// Saved images
//
// Each image is written under a random id, so the id itself is the capability
// that grants access. Listing them requires the team password; fetching one by
// id does not, because an <img src> cannot carry an auth header. A 128-bit
// random name is not guessable, and the list is the only way to learn one.
// ---------------------------------------------------------------------------
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

// Read the format from the bytes: xAI returns JPEG at 1k and PNG at 2k, and the
// request does not say which.
function sniffBuffer(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf.slice(1, 4).toString('latin1') === 'PNG') return 'png';
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8) return 'jpg';
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' &&
      buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return 'png';
}

async function saveImage(b64) {
  if (!SAVE_IMAGES || !b64) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    const ext = sniffBuffer(buf);
    const id = crypto.randomBytes(16).toString('hex') + '.' + ext;
    await fsp.writeFile(path.join(IMAGE_DIR, id), buf);
    return { id: id, bytes: buf.length };
  } catch (err) {
    console.error('[images] could not save: ' + err.message);
    return null;
  }
}

// Favourites are a flat set of image ids. Small enough to rewrite whole, and a
// team this size will not race on it meaningfully.
const FAV_FILE = () => path.join(DATA_DIR, 'favourites.json');

async function readFavourites() {
  try {
    const raw = await fsp.readFile(FAV_FILE(), 'utf8');
    const list = JSON.parse(raw);
    return new Set(Array.isArray(list) ? list.filter(validImageId) : []);
  } catch {
    return new Set();
  }
}

async function writeFavourites(set) {
  try {
    await fsp.writeFile(FAV_FILE(), JSON.stringify(Array.from(set)), 'utf8');
    return true;
  } catch (err) {
    console.error('[favourites] could not write: ' + err.message);
    return false;
  }
}

// Keep the newest MAX_STORED_IMAGES and delete the rest.
//
// Favourites are never pruned — that is what favouriting is for. They are also
// not counted against the cap, so marking a lot of images cannot quietly stop
// new ones being kept.
async function pruneImages() {
  if (!SAVE_IMAGES || !MAX_STORED_IMAGES) return;
  let names;
  try {
    names = await fsp.readdir(IMAGE_DIR);
  } catch {
    return;
  }
  const favourites = await readFavourites();
  const candidates = names.filter((n) => !favourites.has(n));
  if (candidates.length <= MAX_STORED_IMAGES) return;

  const stats = [];
  for (const name of candidates) {
    try {
      const st = await fsp.stat(path.join(IMAGE_DIR, name));
      if (st.isFile()) stats.push({ name: name, at: st.mtimeMs });
    } catch { /* vanished between readdir and stat */ }
  }
  stats.sort((a, b) => b.at - a.at);
  for (const old of stats.slice(MAX_STORED_IMAGES)) {
    try {
      await fsp.unlink(path.join(IMAGE_DIR, old.name));
    } catch { /* already gone */ }
  }
}

// Deleting removes the file and the favourite mark, but never the usage log
// line: the money was spent whether or not the picture is still here, and the
// spend record has to stay honest.
async function deleteImages(ids) {
  const wanted = (Array.isArray(ids) ? ids : []).filter(validImageId);
  const deleted = [];
  const missing = [];
  for (const id of wanted) {
    const resolved = path.resolve(path.join(IMAGE_DIR, id));
    if (!resolved.startsWith(IMAGE_DIR + path.sep)) continue;
    try {
      await fsp.unlink(resolved);
      deleted.push(id);
    } catch {
      missing.push(id);
    }
  }
  if (deleted.length) {
    const favourites = await readFavourites();
    let touched = false;
    for (const id of deleted) if (favourites.delete(id)) touched = true;
    if (touched) await writeFavourites(favourites);
  }
  return { deleted: deleted, missing: missing, rejected: wanted.length !== (Array.isArray(ids) ? ids.length : 0) };
}

// An id is exactly what saveImage produces: 32 hex characters, a dot, a known
// extension. Anything else never reaches the filesystem.
function validImageId(id) {
  return typeof id === 'string' && /^[0-9a-f]{32}\.(png|jpg|webp)$/.test(id);
}

async function serveSavedImage(res, id) {
  if (!validImageId(id)) return fail(res, 400, 'Not a valid image id.');
  const file = path.join(IMAGE_DIR, id);
  // Belt and braces: the pattern above already forbids separators, but resolve
  // and check anyway so the guard does not rest on one regex.
  const resolved = path.resolve(file);
  if (!resolved.startsWith(IMAGE_DIR + path.sep)) return fail(res, 403, 'Forbidden.');

  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    return fail(res, 404, 'That image is no longer stored.');
  }
  res.writeHead(200, {
    'content-type': EXT_MIME[id.split('.').pop()] || 'application/octet-stream',
    'content-length': stat.size,
    // Immutable: the id never points at different bytes.
    'cache-control': 'private, max-age=31536000, immutable'
  });
  fs.createReadStream(resolved).pipe(res);
}

// Rebuild recent runs from the log so the results survive a refresh. Lines from
// one press of the button share a runId and are folded back into one run.
async function readRuns(limit) {
  const favourites = await readFavourites();
  let raw;
  try {
    raw = await fsp.readFile(USAGE_LOG, 'utf8');
  } catch {
    return [];
  }
  const order = [];
  const byRun = new Map();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let r;
    try {
      r = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!Array.isArray(r.files) || !r.files.length) continue; // nothing to show
    const key = r.runId || r.timestamp;
    if (!byRun.has(key)) {
      byRun.set(key, {
        id: key,
        timestamp: r.timestamp,
        user: r.user || null,
        mode: r.mode,
        model: r.model,
        quality: r.quality,
        resolution: r.resolution,
        aspect_ratio: r.aspect_ratio,
        prompt: r.prompt,
        cost: 0,
        images: []
      });
      order.push(key);
    }
    const run = byRun.get(key);
    run.cost = Math.round((run.cost + (r.cost || 0)) * 1e6) / 1e6;
    if (r.timestamp > run.timestamp) run.timestamp = r.timestamp;
    for (const f of r.files) {
      if (f && validImageId(f.id)) {
        run.images.push({ id: f.id, frame: f.frame || run.images.length + 1, favourite: favourites.has(f.id) });
      }
    }
  }

  const runs = order.map((k) => byRun.get(k)).reverse().slice(0, limit);

  // Drop anything whose file has since been pruned, so the client is never sent
  // an id that will 404.
  const alive = [];
  for (const run of runs) {
    const kept = [];
    for (const img of run.images) {
      try {
        await fsp.access(path.join(IMAGE_DIR, img.id));
        kept.push(img);
      } catch { /* pruned */ }
    }
    if (kept.length) {
      run.images = kept.sort((a, b) => a.frame - b.frame);
      alive.push(run);
    }
  }
  return alive;
}

// ---------------------------------------------------------------------------
// Upstream error handling
// ---------------------------------------------------------------------------

// Surface the xAI message rather than replacing it with a generic string.
function extractError(bodyText, status) {
  let msg = '';
  try {
    const j = JSON.parse(bodyText);
    const e = j && j.error;
    if (typeof e === 'string') msg = e;
    else if (e && typeof e.message === 'string') msg = e.message;
    else if (e && typeof e.detail === 'string') msg = e.detail;
    else if (j && typeof j.message === 'string') msg = j.message;
    else if (j && typeof j.detail === 'string') msg = j.detail;
    else if (j && j.detail && typeof j.detail.message === 'string') msg = j.detail.message;
  } catch {
    // Not JSON. Fall through to the raw body.
  }
  if (!msg) msg = String(bodyText || '').trim().slice(0, 300);
  if (!msg) msg = 'xAI returned status ' + status + ' with an empty body.';
  return msg;
}

function classify(status, message) {
  const m = String(message || '').toLowerCase();
  if (status === 429) return 'rate_limited';
  if (status === 402) return 'no_credits';
  if (/credit|balance|quota|insufficient fund|billing/.test(m)) return 'no_credits';
  if (status === 401 || status === 403) return 'key_rejected';
  // xAI answers a bad key with 400, not 401, so the status alone is misleading.
  // Without this the user is told to rewrite their prompt over a server problem.
  if (/api key|apikey|authentication|unauthori[sz]ed/.test(m)) return 'key_rejected';
  if (/moderat|safety|blocked|content policy|violat/.test(m)) return 'moderation';
  return 'upstream';
}

function retryAfterSeconds(headers) {
  const raw = headers.get('retry-after');
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.max(0, Math.ceil((when - Date.now()) / 1000));
  return null;
}

async function callXai(endpoint, payload) {
  let response;
  try {
    response = await fetch(XAI_BASE + endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + XAI_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload),
      // Without this a stalled upstream hangs the browser indefinitely with no
      // way out.
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (err) {
    // A network failure, not an HTTP error. Name which of the two happened.
    const seconds = Math.round(UPSTREAM_TIMEOUT_MS / 1000);
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const detail = err && err.message ? err.message : 'unknown network error';
    return {
      ok: false,
      networkFailure: true,
      code: timedOut ? 'timeout' : 'network',
      status: 504,
      seconds: seconds,
      message: timedOut
        ? 'xAI did not answer within ' + seconds + ' seconds, so the request was given up on.'
        : 'Could not reach api.x.ai — the connection failed before xAI answered (' + detail + ').'
    };
  }

  const text = await response.text();
  if (!response.ok) {
    const message = extractError(text, response.status);
    return {
      ok: false,
      networkFailure: false,
      status: response.status,
      code: classify(response.status, message),
      message: message,
      retryAfter: retryAfterSeconds(response.headers)
    };
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      networkFailure: false,
      status: 502,
      code: 'upstream',
      message: 'xAI answered with a body that is not JSON: ' + text.slice(0, 300)
    };
  }
  return { ok: true, json: json };
}

// ---------------------------------------------------------------------------
// POST /api/describe
//
// Reads the reference photos and returns a generation prompt. This exists
// because the image endpoints cannot take more than one source image: `image`
// deserialises as a single two-field struct, so an array is not a list of
// pictures, and /images/generations ignores the field entirely. A chat model
// that accepts image input is the only place several references can be seen at
// once, so it looks at them and writes the prompt instead.
// ---------------------------------------------------------------------------
async function handleDescribe(req, res, body) {
  if (!XAI_API_KEY) {
    return fail(res, 503, 'No API key on the server. Add XAI_API_KEY to .env and restart.', { code: 'no_key' });
  }

  let input;
  try {
    input = JSON.parse(body || '{}');
  } catch {
    return fail(res, 400, 'The request body was not valid JSON.', { code: 'bad_request' });
  }

  const images = Array.isArray(input.images)
    ? input.images.filter((s) => typeof s === 'string' && s.trim()).slice(0, 6)
    : [];
  // What each photo is for. Same order as images; anything unrecognised is
  // treated as an unlabelled reference.
  const roles = Array.isArray(input.roles) ? input.roles : [];
  const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : '';

  if (!images.length) return fail(res, 400, 'Add at least one reference photo.', { code: 'bad_request' });
  if (!instruction) return fail(res, 400, 'Say what you want made from these photos.', { code: 'bad_request' });

  // Each photo is announced before it is shown, so "photo 1" in the instruction
  // refers to something the model was actually told the number of. Without this
  // the numbering is left to inference from message order, and an instruction
  // naming a photo can be applied to the wrong one.
  const content = [];
  images.forEach((url, i) => {
    const role = ROLE_BRIEF[roles[i]] || null;
    content.push({
      type: 'text',
      text: 'Photo ' + (i + 1) + (role ? ' — use this for the ' + role + '.' : ':')
    });
    content.push({ type: 'image_url', image_url: { url: url } });
  });

  // The instruction comes last so it reads as the request about the photos just
  // shown, rather than as a caption for the first one.
  const named = images.map((_, i) => 'photo ' + (i + 1)).join(', ');
  content.push({
    type: 'text',
    text: 'The photos above are ' + named + '. What is wanted: ' + instruction
  });

  let response;
  try {
    response = await fetch(XAI_BASE + '/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + XAI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [
          { role: 'system', content: COMBINE_SYSTEM },
          { role: 'user', content: content }
        ],
        max_tokens: 400,
        temperature: 0.7
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return fail(res, 504, timedOut
      ? 'Reading the photos took too long and was given up on.'
      : 'Could not reach api.x.ai to read the photos (' + (err && err.message ? err.message : 'network error') + ').',
      { code: timedOut ? 'timeout' : 'network' });
  }

  const text = await response.text();
  if (!response.ok) {
    const message = extractError(text, response.status);
    return fail(res, response.status >= 500 ? 502 : response.status, message, {
      code: classify(response.status, message),
      upstreamStatus: response.status,
      retryAfter: retryAfterSeconds(response.headers)
    });
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return fail(res, 502, 'xAI answered the reading step with a body that is not JSON.', { code: 'upstream' });
  }

  const choice = json.choices && json.choices[0];
  const prompt = choice && choice.message && typeof choice.message.content === 'string'
    ? choice.message.content.trim().replace(/^["'\s]+|["'\s]+$/g, '')
    : '';

  if (!prompt) {
    return fail(res, 422,
      'The model read the photos but returned no prompt. Try describing what you want more plainly.',
      { code: 'moderation' });
  }

  const ticks = json.usage && typeof json.usage.cost_in_usd_ticks === 'number'
    ? json.usage.cost_in_usd_ticks : 0;
  const cost = Math.round(ticks * USD_PER_TICK * 1e6) / 1e6;

  sendJson(res, 200, {
    prompt: prompt,
    cost: cost,
    tokens: (json.usage && json.usage.total_tokens) || 0,
    model: VISION_MODEL
  });
}

// ---------------------------------------------------------------------------
// POST /api/images
// ---------------------------------------------------------------------------
async function handleImages(req, res, body) {
  if (!XAI_API_KEY) {
    return fail(res, 503, 'No API key on the server. Add XAI_API_KEY to .env and restart.', { code: 'no_key' });
  }

  let input;
  try {
    input = JSON.parse(body || '{}');
  } catch {
    return fail(res, 400, 'The request body was not valid JSON.', { code: 'bad_request' });
  }

  // 'combine' is several photos composited into one picture by the client and
  // sent as a single source. It uses the edits endpoint and is priced like an
  // edit, but is logged under its own name so usage.jsonl stays truthful.
  const MODES = ['generate', 'edit', 'combine'];
  const mode = MODES.indexOf(input.mode) === -1 ? 'generate' : input.mode;
  // Combine used to composite photos into one source image and go through the
  // edits endpoint. It no longer does: the references are read by a vision model
  // which writes the prompt, and this is a plain generation from that prompt.
  const usesEditEndpoint = mode === 'edit';
  const model = String(input.model || '');
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const user = typeof input.user === 'string' ? input.user.trim().slice(0, 80) : '';
  // A run is one press of the button. The client asks for one image per request
  // so frames arrive as they finish, which means several log lines share a run —
  // this is what groups them back together when reading usage.jsonl.
  const runId = typeof input.runId === 'string' ? input.runId.trim().slice(0, 40) : null;

  if (!PRICES[model]) {
    return fail(res, 400,
      'Unknown model "' + model + '". Pick one of: ' + Object.keys(PRICES).join(', ') + '.',
      { code: 'bad_request' });
  }
  if (!prompt) {
    return fail(res, 400, usesEditEndpoint
      ? 'Describe the change you want before applying an edit.'
      : 'Write a prompt before generating.', { code: 'bad_request' });
  }

  const acceptsQuality = QUALITY_MODELS.indexOf(model) !== -1;
  const quality = QUALITIES.indexOf(input.quality) === -1 ? 'auto' : input.quality;

  const endpoint = usesEditEndpoint ? '/images/edits' : '/images/generations';
  let payload;
  let minimalPayload;

  if (usesEditEndpoint) {
    const image = input.image;
    if (!image || typeof image !== 'string' || !image.trim()) {
      return fail(res, 400, 'Add a photo to edit — the edit endpoint needs one source image.', { code: 'bad_request' });
    }
    // One source image in, one image out. Never send n here.
    const imageField = { url: image, type: 'image_url' };
    payload = {
      model: model,
      prompt: prompt,
      image: imageField,
      response_format: 'b64_json'
    };
    minimalPayload = {
      model: model,
      prompt: prompt,
      image: imageField,
      response_format: 'b64_json'
    };
    if (acceptsQuality && quality !== 'auto') payload.quality = quality;
  } else {
    const count = Math.min(10, Math.max(1, Math.floor(Number(input.n) || 1)));
    const aspect = ASPECT_RATIOS.indexOf(input.aspect_ratio) === -1 ? 'auto' : input.aspect_ratio;
    const resolution = RESOLUTIONS.indexOf(input.resolution) === -1 ? '1k' : input.resolution;
    payload = {
      model: model,
      prompt: prompt,
      n: count,
      aspect_ratio: aspect,
      resolution: resolution,
      response_format: 'b64_json'
    };
    minimalPayload = {
      model: model,
      prompt: prompt,
      n: count,
      response_format: 'b64_json'
    };
    // Sending quality to a model that does not accept it is a 400.
    if (acceptsQuality && quality !== 'auto') payload.quality = quality;
  }

  let result = await callXai(endpoint, payload);
  let degraded = false;

  // A 400 usually means one optional parameter was not accepted. Retry once with
  // only the required fields — an optional parameter the model did not want
  // should not cost the user the whole run.
  // A rejected key produces a 400 too, and retrying that just doubles the wait.
  if (!result.ok && !result.networkFailure && result.status === 400 && result.code !== 'key_rejected') {
    const retry = await callXai(endpoint, minimalPayload);
    if (retry.ok) {
      result = retry;
      degraded = true;
    }
  }

  if (!result.ok) {
    const status = result.networkFailure ? 504 : (result.status >= 500 ? 502 : result.status);
    return fail(res, status, result.message, {
      code: result.code,
      upstreamStatus: result.networkFailure ? null : result.status,
      retryAfter: result.retryAfter || null,
      seconds: result.seconds || null
    });
  }

  const data = Array.isArray(result.json && result.json.data) ? result.json.data : [];

  // A success with no data means moderation filtered the prompt. Say so — do not
  // return an empty success and let the page look broken.
  if (data.length === 0) {
    return fail(res, 422,
      'xAI accepted the request but returned no images, which means moderation filtered this prompt.',
      { code: 'moderation' });
  }

  // Handle both response shapes on the way back, even though b64_json was asked
  // for: the hosted URLs are temporary, so a URL-based flow silently rots.
  const images = data.map(function (item) {
    return {
      b64: typeof item.b64_json === 'string' ? item.b64_json : null,
      url: typeof item.url === 'string' ? item.url : null,
      revised_prompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : null,
      id: null
    };
  }).filter(function (img) {
    return img.b64 || img.url;
  });

  if (images.length === 0) {
    return fail(res, 502, 'xAI returned image records with neither b64_json nor url in them.', { code: 'upstream' });
  }

  // The minimal retry sends no aspect_ratio, resolution or quality, so those
  // revert to the API defaults. Price and log what was actually billed, not what
  // was asked for, or a degraded 2k run is charged at the 2k rate it never got.
  const effectiveQuality = degraded ? 'auto' : quality;
  const effectiveResolution = degraded ? '1k' : payload.resolution;
  const effectiveAspect = degraded ? 'auto' : payload.aspect_ratio;

  const cost = costFor({
    model: model,
    quality: effectiveQuality,
    resolution: effectiveResolution,
    mode: mode,
    count: images.length
  });

  // Save the bytes before answering, so a refresh can bring the run back. A
  // failure to write is logged but never fails the request — the user has
  // already paid for these images and must still receive them.
  const saved = [];
  for (let i = 0; i < images.length; i++) {
    const rec = await saveImage(images[i].b64);
    if (rec) {
      images[i].id = rec.id;
      saved.push({ id: rec.id, frame: typeof input.frame === 'number' ? input.frame : i + 1 });
    }
  }
  pruneImages().catch(function () { /* pruning is housekeeping, never fatal */ });

  await appendUsage({
    timestamp: new Date().toISOString(),
    runId: runId,
    files: saved,
    user: user || null,
    mode: mode,
    model: model,
    quality: acceptsQuality ? effectiveQuality : null,
    resolution: usesEditEndpoint ? null : effectiveResolution,
    aspect_ratio: usesEditEndpoint ? null : effectiveAspect,
    images: images.length,
    cost: cost,
    degraded: degraded,
    prompt: prompt.slice(0, PROMPT_LOG_CHARS)
  });

  sendJson(res, 200, {
    images: images.map(function (i) {
      return { b64: i.b64, url: i.url, revised_prompt: i.revised_prompt, id: i.id || null };
    }),
    cost: cost,
    degraded: degraded
  });
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

async function serveStatic(req, res, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return fail(res, 400, 'Malformed path.');
  }
  const rel = decoded === '/' ? '/index.html' : decoded;

  // Resolve first, then confirm the result is still inside public/. Scanning the
  // raw string for ".." is not enough — encodings and absolute paths get past it.
  const resolved = path.resolve(PUBLIC_DIR, '.' + rel);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return fail(res, 403, 'Forbidden.');
  }

  let stat;
  try {
    stat = await fsp.stat(resolved);
  } catch {
    return fail(res, 404, 'Not found.');
  }
  if (!stat.isFile()) return fail(res, 404, 'Not found.');

  const type = MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': 'no-cache'
  });
  fs.createReadStream(resolved).pipe(res);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const server = http.createServer(async function (req, res) {
  let urlPath;
  try {
    urlPath = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return fail(res, 400, 'Malformed request URL.');
  }

  try {
    // Public, no auth, so the password gate can render. Never leaks the key.
    if (urlPath === '/api/config') {
      if (req.method !== 'GET') return fail(res, 405, 'Use GET for /api/config.');
      return sendJson(res, 200, {
        hasKey: Boolean(XAI_API_KEY),
        requiresPassword: Boolean(TEAM_PASSWORD),
        prices: PRICES,
        qualityModels: QUALITY_MODELS,
        savesImages: SAVE_IMAGES && STORAGE_READY
      });
    }

    // Fetching one saved image by its random id needs no password, because an
    // <img src> cannot send a header. The id is the capability; the listing that
    // hands out ids is behind the password, just below.
    // Reading one saved image by its random id needs no password, because an
    // <img src> cannot send a header. Anything that CHANGES something falls
    // through to the authenticated block below.
    if (urlPath.startsWith('/api/image/') && req.method === 'GET') {
      if (!SAVE_IMAGES) return fail(res, 404, 'Image saving is switched off on this server.');
      return await serveSavedImage(res, decodeURIComponent(urlPath.slice('/api/image/'.length)));
    }

    if (urlPath.startsWith('/api/')) {
      if (TEAM_PASSWORD && !passwordMatches(req.headers['x-team-password'])) {
        return fail(res, 401, 'Password not recognised.', { code: 'unauthorized' });
      }

      if (urlPath === '/api/usage') {
        if (req.method !== 'GET') return fail(res, 405, 'Use GET for /api/usage.');
        return sendJson(res, 200, await readUsage());
      }

      // Delete one saved image. The usage log line stays: the money was spent
      // whether or not the picture is still here.
      if (urlPath.startsWith('/api/image/')) {
        if (req.method !== 'DELETE') return fail(res, 405, 'Use GET to read an image, or DELETE to remove it.');
        if (!SAVE_IMAGES) return fail(res, 404, 'Image saving is switched off on this server.');
        const id = decodeURIComponent(urlPath.slice('/api/image/'.length));
        if (!validImageId(id)) return fail(res, 400, 'Not a valid image id.');
        const result = await deleteImages([id]);
        if (!result.deleted.length) return fail(res, 404, 'That image is no longer stored.');
        return sendJson(res, 200, { deleted: result.deleted });
      }

      // Delete several at once, so a selection is one action and one undo-less
      // decision rather than a dozen.
      if (urlPath === '/api/images/delete') {
        if (req.method !== 'POST') return fail(res, 405, 'Use POST for /api/images/delete.');
        if (!SAVE_IMAGES) return fail(res, 404, 'Image saving is switched off on this server.');
        let body;
        try {
          body = JSON.parse(await readBody(req, 1024 * 1024) || '{}');
        } catch {
          return fail(res, 400, 'The request body was not valid JSON.');
        }
        if (!Array.isArray(body.ids) || !body.ids.length) {
          return fail(res, 400, 'Send an ids array naming the images to delete.');
        }
        if (body.ids.length > 200) return fail(res, 400, 'Delete at most 200 images at a time.');
        const result = await deleteImages(body.ids);
        return sendJson(res, 200, { deleted: result.deleted, missing: result.missing });
      }

      // Mark or unmark a favourite. Favourites are exempt from pruning, which is
      // the point of them.
      if (urlPath === '/api/favourite') {
        if (req.method !== 'POST') return fail(res, 405, 'Use POST for /api/favourite.');
        if (!SAVE_IMAGES) return fail(res, 404, 'Image saving is switched off on this server.');
        let body;
        try {
          body = JSON.parse(await readBody(req, 64 * 1024) || '{}');
        } catch {
          return fail(res, 400, 'The request body was not valid JSON.');
        }
        const ids = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
        const wanted = ids.filter(validImageId);
        if (!wanted.length) return fail(res, 400, 'Send an id, or an ids array.');
        const on = body.favourite !== false;
        const favourites = await readFavourites();
        for (const id of wanted) {
          if (on) {
            // Only mark something that is actually still on disk.
            try {
              await fsp.access(path.join(IMAGE_DIR, id));
              favourites.add(id);
            } catch { /* gone; nothing to favourite */ }
          } else {
            favourites.delete(id);
          }
        }
        if (!(await writeFavourites(favourites))) {
          return fail(res, 500, 'Could not save the favourite. The images folder may not be writable.');
        }
        return sendJson(res, 200, { favourites: wanted.filter((id) => favourites.has(id)) });
      }

      // Recent runs with the ids of their saved images, newest first. This is
      // what lets the results survive a refresh.
      if (urlPath === '/api/runs') {
        if (req.method !== 'GET') return fail(res, 405, 'Use GET for /api/runs.');
        if (!SAVE_IMAGES || !STORAGE_READY) return sendJson(res, 200, { runs: [], saving: false });
        let limit = 20;
        try {
          const q = new URL(req.url, 'http://localhost').searchParams.get('limit');
          if (q) limit = Math.min(100, Math.max(1, parseInt(q, 10) || 20));
        } catch { /* keep the default */ }
        return sendJson(res, 200, { runs: await readRuns(limit), saving: true });
      }

      if (urlPath === '/api/describe') {
        if (req.method !== 'POST') return fail(res, 405, 'Use POST for /api/describe.');
        let dbody;
        try {
          dbody = await readBody(req, MAX_BODY_BYTES);
        } catch (err) {
          if (err && err.code === 'BODY_TOO_LARGE') return tooLarge(req, res);
          return fail(res, 400, 'The request body could not be read.');
        }
        return await handleDescribe(req, res, dbody);
      }

      if (urlPath === '/api/images') {
        if (req.method !== 'POST') return fail(res, 405, 'Use POST for /api/images.');

        // Reject on the declared length before reading 40 MB into memory. The
        // streaming guard below stays as the backstop for chunked uploads that
        // declare no length.
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          return tooLarge(req, res);
        }

        let body;
        try {
          body = await readBody(req, MAX_BODY_BYTES);
        } catch (err) {
          if (err && err.code === 'BODY_TOO_LARGE') return tooLarge(req, res);
          return fail(res, 400, 'The request body could not be read.');
        }
        return await handleImages(req, res, body);
      }

      return fail(res, 404, 'No such endpoint: ' + urlPath);
    }

    if (req.method !== 'GET') return fail(res, 405, 'Method not allowed.');
    return await serveStatic(req, res, urlPath);
  } catch (err) {
    console.error('[server] unhandled error on ' + urlPath + ':', err);
    if (!res.headersSent) fail(res, 500, 'The server hit an unexpected error: ' + err.message);
    else res.end();
  }
});

// A team tool that dies must say why. Node exits on an unhandled rejection, and
// on a hosted platform that reads as "deployment crashed" with nothing to go on.
// One bad request should not take the studio down for everyone, so log it loudly
// and keep serving.
process.on('unhandledRejection', function (reason) {
  console.error('[server] unhandled promise rejection — the request that caused it failed,');
  console.error('[server] but the server is still running:');
  console.error(reason && reason.stack ? reason.stack : reason);
});

// An uncaught exception may have left state inconsistent, so exit and let the
// host restart cleanly — but print what happened first.
process.on('uncaughtException', function (err) {
  console.error('[server] uncaught exception, shutting down:');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

// Without this, a port clash or a blocked bind exits with a raw stack trace.
// Say what happened and what to do about it, like every other error here.
server.on('error', function (err) {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error('Port ' + PORT + ' is already in use.');
    console.error('');
    console.error('Imagine studio is most likely already running — open');
    console.error('  http://localhost:' + PORT);
    console.error('and check before starting a second copy.');
    console.error('');
    console.error('If it is something else on that port, either stop it or pick a');
    console.error('different port by setting PORT in .env, then start again.');
    console.error('');
    console.error('To find what is holding it:');
    console.error(process.platform === 'win32'
      ? '  netstat -ano | findstr :' + PORT
      : '  lsof -i :' + PORT);
  } else if (err.code === 'EACCES') {
    console.error('');
    console.error('Not allowed to listen on port ' + PORT + '.');
    console.error('Ports below 1024 need administrator rights — set PORT in .env');
    console.error('to something above 1024, such as 8787, and start again.');
  } else {
    console.error('');
    console.error('The server could not start: ' + err.message);
  }
  console.error('');
  process.exit(1);
});

server.listen(PORT, HOST, function () {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('Imagine studio on http://' + shown + ':' + PORT);
  console.log('  API key           ' + (XAI_API_KEY ? 'loaded' : 'MISSING — add XAI_API_KEY to .env'));
  console.log('  Team password     ' + (TEAM_PASSWORD ? 'required' : 'not set (anyone who can reach this port can spend credits)'));
  console.log('  Upstream timeout  ' + Math.round(UPSTREAM_TIMEOUT_MS / 1000) + 's');
  console.log('  Usage log         ' + USAGE_LOG);
  console.log('  Saved images      ' + (!SAVE_IMAGES ? 'off (SAVE_IMAGES=false)'
    : STORAGE_READY ? IMAGE_DIR + '  (keeping ' + MAX_STORED_IMAGES + ')'
    : 'NOT WRITABLE — ' + IMAGE_DIR + '  (' + STORAGE_PROBLEM + ')'));
});
