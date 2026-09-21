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
let DATA_DIR, USAGE_LOG, IMAGE_DIR, SOURCE_DIR, TRASH_DIR;

const MAX_BODY_BYTES = 40 * 1024 * 1024; // base64 source images are large
const PROMPT_LOG_CHARS = 300;

// ---------------------------------------------------------------------------
// Prices, limits and the request builders live in lib/imagine.js, where the
// tests can reach them without starting a server. Nothing about what is sent
// to xAI is decided in this file.
// ---------------------------------------------------------------------------
const imagine = require('./lib/imagine.js');
const PRICES = imagine.PRICES;
const QUALITY_MODELS = imagine.QUALITY_MODELS;
const { createThrottle } = require('./lib/throttle.js');
const { classify, pickTraceHeaders, failureLogLine } = require('./lib/failures.js');
const { remainingFrom } = require('./lib/balance.js');
const promptLib = require('./lib/prompts.js');

// A refused or failed upstream request, written to stderr — on Railway, the
// deploy log. The usage log records only successes and xAI's console does not
// record a request it turns away, so without this a failure leaves no trace.
// Never the prompt, never image data: see lib/failures.js.
function logFailure(info) {
  console.error(failureLogLine(info));
}

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

// Where generated images and the spend log are kept. On a host whose disk is
// replaced on every deploy — Railway, Fly, most container platforms — only a
// mounted volume survives, so an attached Railway volume is used automatically
// and a deployment without one is called out at boot. See lib/storage.js.
const STORAGE = require('./lib/storage.js').resolveStorage(function (name) { return env(name, ''); }, ROOT);
DATA_DIR = STORAGE.dir;
USAGE_LOG = path.join(DATA_DIR, 'usage.jsonl');
IMAGE_DIR = path.join(DATA_DIR, 'images');
// The photos people attach to an edit. Kept so a past edit can be run again, or
// loaded back into the composer, without finding and attaching them again.
SOURCE_DIR = path.join(DATA_DIR, 'sources');
// Deleted images wait here for a few minutes, so a delete can be undone.
TRASH_DIR = path.join(DATA_DIR, 'trash');

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
    fs.mkdirSync(SOURCE_DIR, { recursive: true });
    fs.mkdirSync(TRASH_DIR, { recursive: true });
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

// Optional. xAI's Management API is a separate service with its own key, and is
// the only place the remaining prepaid credit can be read. Without the key the
// top bar shows what was spent and nothing about what is left. The key is used
// for two read-only billing calls and, like the API key, never leaves here.
const XAI_MANAGEMENT_KEY = String(env('XAI_MANAGEMENT_KEY', '')).trim();
const XAI_MANAGEMENT_BASE = String(env('XAI_MANAGEMENT_BASE_URL', 'https://management-api.x.ai')).replace(/\/+$/, '');
const XAI_TEAM_ID = String(env('XAI_TEAM_ID', '')).trim();

// What the studio calls itself: the top bar, the password screen, the tab.
const STUDIO_NAME = String(env('STUDIO_NAME', 'Imagine studio')).trim().slice(0, 40) || 'Imagine studio';

// The chat model behind /api/describe, which reads photographs and answers in
// text. Combining pictures no longer goes through it — the edits endpoint takes
// up to five source images directly — but the endpoint stays, to be repurposed
// as a preservation-inventory extractor.
const VISION_MODEL = String(env('VISION_MODEL', 'grok-4.20-non-reasoning'));

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
// Default. The person's own wording is the prompt; the photos only supply the
// visual detail their words cannot carry. Nothing they typed is rephrased.
const COMBINE_DETAIL_SYSTEM = [
  'You describe reference photographs for someone who is writing a text-to-image prompt.',
  'You are shown numbered photographs and told what each one is being used for.',
  'For each photo, describe ONLY what its stated role calls for, and ignore everything else in that photo.',
  'This matters: the person has already written their own prompt, and your description is appended to it.',
  'Anything you describe outside the stated role will fight their wording.',
  'So unless it IS the stated role, never describe lighting, mood, camera, lens, framing, composition or background.',
  'A subject role means the person or object only. A clothing role means the garments only.',
  'If a photo has no stated role, describe its most visually distinctive content.',
  'Be concrete and visual: colour, material, shape, hair, features, garment, texture.',
  'Each description is one comma-separated phrase of at most 25 words. Not a sentence. No verbs of instruction.',
  'Never restate, rephrase, interpret or answer the request. You are only describing what is in the photographs.',
  'Output one line per photo, in order, formatted exactly as: N| description',
  'No preamble, no commentary, no quotation marks, nothing else.'
].join(' ');

// Opt-in. The model writes the whole prompt itself, which reads better but
// replaces the person's wording — the reason it is not the default.
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

// Joins the person's own prompt to the details read off the photos. Their text
// is never altered — it stays exactly as typed, at the front, and the reference
// detail follows it.
function composePrompt(instruction, details) {
  let head = instruction.trim();
  const tail = details
    .map((d) => d.trim().replace(/[.\s]+$/, ''))
    .filter(Boolean)
    .map((d) => d.charAt(0).toUpperCase() + d.slice(1));
  if (!tail.length) return head;
  if (!/[.!?,;:]$/.test(head)) head += '.';
  return head + ' ' + tail.join('. ') + '.';
}

// Parses "N| description" lines back into an ordered list, tolerating a model
// that drops the numbering.
function parseDetailLines(text, count) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s*[|.:)-]\s*(.+)$/);
    if (m) out[Math.max(0, Math.min(count - 1, parseInt(m[1], 10) - 1))] = m[2].trim();
    else out.push(line);
  }
  return out.filter(Boolean).slice(0, count);
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

// Failed password attempts are throttled per address: five free, then a delay
// that doubles from two seconds up to fifteen minutes. The comparison below
// defeats timing attacks; this defeats guessing. In memory, so a restart
// forgets it, which is fine for a team tool.
const loginThrottle = createThrottle();
setInterval(function () { loginThrottle.prune(); }, 10 * 60 * 1000).unref();

// Behind Railway or any proxy the socket address is the proxy's, and the real
// one is the first entry of x-forwarded-for. Trusting that header means a
// direct client could forge it, which only lets it dodge its own throttling —
// it cannot lock anyone else out, because the same 401 is returned either way.
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
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
// The prompt library — DATA_DIR/prompts.json
//
// Every prompt the team has used, so a good one can be found and used again.
// One small file rewritten whole. Requests arrive several at a time (a run asks
// for its frames concurrently), so every change goes through one queue: read,
// change, write, then the next — or two frames landing together would each
// read the old list and one would overwrite the other.
// ---------------------------------------------------------------------------
const PROMPTS_FILE = () => path.join(DATA_DIR, 'prompts.json');
let promptQueue = Promise.resolve();

async function readPrompts() {
  try {
    const list = JSON.parse(await fsp.readFile(PROMPTS_FILE(), 'utf8'));
    return Array.isArray(list) ? list.filter((p) => p && promptLib.validPromptId(p.id) && typeof p.text === 'string') : [];
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error('[prompts] could not read: ' + err.message);
    // First run with the library: build it from what the usage log remembers.
    if (err && err.code === 'ENOENT') {
      try {
        const rows = (await fsp.readFile(USAGE_LOG, 'utf8')).split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } });
        return promptLib.fromUsage(rows.filter(Boolean));
      } catch { /* no log either: an empty library */ }
    }
    return [];
  }
}

// Written to a temporary file and swapped into place, so a crash mid-write
// never leaves half a library. On Windows the swap is refused (EPERM, EBUSY)
// if anything has the old file open at that instant — a virus scanner, a backup
// — so it is tried a few times, and as a last resort written in place: a save
// that might be torn beats a save that is silently lost.
async function writePrompts(list) {
  const file = PROMPTS_FILE();
  const tmp = file + '.tmp';
  const body = JSON.stringify(list);
  await fsp.writeFile(tmp, body, 'utf8');
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      if (!err || (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES')) throw err;
      await new Promise(function (r) { setTimeout(r, 40 * (attempt + 1)); });
    }
  }
  await fsp.writeFile(file, body, 'utf8');
  await fsp.unlink(tmp).catch(function () { /* nothing to tidy */ });
}

// Reading goes through the same queue as writing. Besides never showing a list
// that is about to change, it means this server never has the file open for
// reading at the moment it is being swapped.
function listPrompts() {
  const job = promptQueue.then(readPrompts);
  promptQueue = job.catch(function () { /* a failed read must not stall the queue */ });
  return job;
}

// change(list) returns { list, changed, entry }. Resolves to that result.
function changePrompts(change) {
  const job = promptQueue.then(async function () {
    const out = change(await readPrompts());
    if (out.changed) await writePrompts(out.list);
    return out;
  });
  promptQueue = job.catch(function (err) { console.error('[prompts] could not save: ' + err.message); });
  return job;
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

// A photo attached to an edit, kept under the hash of its bytes. The same photo
// sent with ten variants, or reused next week, is written once; using it again
// refreshes its date so the ones in use are the last to be cleared. Only data
// URIs are kept — a public URL or a Files id is xAI's to store, not ours.
async function saveSource(uri) {
  if (!SAVE_IMAGES || !STORAGE_READY || typeof uri !== 'string') return null;
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(uri);
  if (!m) return null;
  try {
    const buf = Buffer.from(m[2], 'base64');
    const id = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32) + '.' + sniffBuffer(buf);
    const file = path.join(SOURCE_DIR, id);
    try {
      const now = new Date();
      await fsp.utimes(file, now, now);
    } catch {
      await fsp.writeFile(file, buf);
    }
    return id;
  } catch (err) {
    console.error('[sources] could not save: ' + err.message);
    return null;
  }
}

// Same ceiling as generated images, counted separately.
async function pruneSources() {
  if (!SAVE_IMAGES || !MAX_STORED_IMAGES) return;
  let names;
  try { names = await fsp.readdir(SOURCE_DIR); } catch { return; }
  if (names.length <= MAX_STORED_IMAGES) return;
  const stats = [];
  for (const name of names) {
    try {
      const st = await fsp.stat(path.join(SOURCE_DIR, name));
      if (st.isFile()) stats.push({ name: name, at: st.mtimeMs });
    } catch { /* vanished */ }
  }
  stats.sort((a, b) => b.at - a.at);
  for (const old of stats.slice(MAX_STORED_IMAGES)) {
    try { await fsp.unlink(path.join(SOURCE_DIR, old.name)); } catch { /* already gone */ }
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
      // Moved aside rather than destroyed, so the page can offer Undo. It is
      // gone from the gallery, the library and every listing at once; the
      // bytes themselves go a few minutes later (purgeTrash).
      await fsp.rename(resolved, path.join(TRASH_DIR, id));
      const now = new Date();
      await fsp.utimes(path.join(TRASH_DIR, id), now, now).catch(function () { /* the date is only for purging */ });
      deleted.push(id);
    } catch {
      missing.push(id);
    }
  }
  const wasFavourite = [];
  if (deleted.length) {
    const favourites = await readFavourites();
    for (const id of deleted) if (favourites.delete(id)) wasFavourite.push(id);
    if (wasFavourite.length) await writeFavourites(favourites);
  }
  purgeTrash().catch(function () { /* housekeeping */ });
  return { deleted: deleted, missing: missing, wasFavourite: wasFavourite };
}

// Puts back images deleted a moment ago, and their favourite marks.
async function restoreImages(ids, favouriteIds) {
  const restored = [];
  for (const id of (Array.isArray(ids) ? ids : []).filter(validImageId)) {
    try {
      await fsp.rename(path.join(TRASH_DIR, id), path.join(IMAGE_DIR, id));
      restored.push(id);
    } catch { /* already purged, or never there */ }
  }
  const marks = (Array.isArray(favouriteIds) ? favouriteIds : []).filter((id) => restored.indexOf(id) !== -1);
  if (marks.length) {
    const favourites = await readFavourites();
    marks.forEach((id) => favourites.add(id));
    await writeFavourites(favourites);
  }
  return restored;
}

// Undo is offered for ten seconds; the trash is kept for ten minutes, which is
// generous to a slow connection and still means "deleted" is soon true.
const TRASH_MS = 10 * 60 * 1000;
async function purgeTrash() {
  let names;
  try { names = await fsp.readdir(TRASH_DIR); } catch { return; }
  for (const name of names) {
    try {
      const st = await fsp.stat(path.join(TRASH_DIR, name));
      if (Date.now() - st.mtimeMs > TRASH_MS) await fsp.unlink(path.join(TRASH_DIR, name));
    } catch { /* vanished */ }
  }
}
setInterval(function () { purgeTrash().catch(function () {}); }, 5 * 60 * 1000).unref();

// An id is exactly what saveImage produces: 32 hex characters, a dot, a known
// extension. Anything else never reaches the filesystem.
function validImageId(id) {
  return typeof id === 'string' && /^[0-9a-f]{32}\.(png|jpg|webp)$/.test(id);
}

async function serveSavedImage(res, id, dir) {
  dir = dir || IMAGE_DIR;
  if (!validImageId(id)) return fail(res, 400, 'Not a valid image id.');
  const file = path.join(dir, id);
  // Belt and braces: the pattern above already forbids separators, but resolve
  // and check anyway so the guard does not rest on one regex.
  const resolved = path.resolve(file);
  if (!resolved.startsWith(dir + path.sep)) return fail(res, 403, 'Forbidden.');

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
async function readRuns(limit, favouritesOnly, before) {
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
        sources: typeof r.sources === 'number' ? r.sources : null,
        reference: Boolean(r.reference),
        prompt: r.prompt,
        cost: 0,
        images: [],
        sourceLines: []
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
    if (Array.isArray(r.sourceFiles)) {
      run.sourceLines.push({ frame: (r.files[0] && r.files[0].frame) || 0, ids: r.sourceFiles });
    }
  }

  let runs = order.map((k) => byRun.get(k)).reverse();
  // The library: every run that still has a favourite in it, however old.
  if (favouritesOnly) runs = runs.filter((run) => run.images.some((img) => img.favourite));
  // Paging for the endless gallery: only runs older than the last one shown.
  if (before) runs = runs.filter((run) => run.timestamp < before);
  runs = runs.slice(0, limit);

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
    // The photos this edit was made from. Combined: every line carries the same
    // list, so the first is the list. Edited apart: one photo per line, in
    // frame order. Offered only if every one of them is still on disk — a
    // partial set would re-run as a different edit.
    const lines = run.sourceLines.sort((a, b) => a.frame - b.frame);
    delete run.sourceLines;
    let ids = [];
    if (lines.length) {
      ids = run.reference || lines[0].ids.length > 1
        ? lines[0].ids
        : lines.reduce((all, l) => all.concat(l.ids), []);
    }
    let complete = ids.length > 0 && ids.every(validImageId);
    for (const id of complete ? ids : []) {
      try { await fsp.access(path.join(SOURCE_DIR, id)); } catch { complete = false; break; }
    }
    run.sourceFiles = complete ? ids : [];

    if (kept.length) {
      run.images = kept.sort((a, b) => a.frame - b.frame);
      alive.push(run);
    }
  }
  return alive;
}

// ---------------------------------------------------------------------------
// GET /api/balance — what is left of the prepaid credit
//
// Two read-only calls to xAI's Management API, cached for a minute so a busy
// page does not hammer it. Always answers 200: no key, a refused key or an
// outage each come back as available:false with a reason, because a missing
// balance must never stop anyone working.
// ---------------------------------------------------------------------------
let balanceCache = { at: 0, value: null };
let teamIdCache = XAI_TEAM_ID;
let lastBalanceProblem = '';

async function getJson(url, key) {
  const response = await fetch(url, {
    headers: { authorization: 'Bearer ' + key },
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(response.status + ' ' + extractError(text, response.status).slice(0, 160));
  return JSON.parse(text);
}

async function readBalance() {
  if (!XAI_MANAGEMENT_KEY) return { available: false, reason: 'no_management_key' };
  if (balanceCache.value && Date.now() - balanceCache.at < 60000) return balanceCache.value;
  let value;
  try {
    // The team the API key belongs to — asked once, from the ordinary API.
    if (!teamIdCache && XAI_API_KEY) {
      const who = await getJson(XAI_BASE + '/api-key', XAI_API_KEY);
      teamIdCache = String(who.team_id || '');
    }
    if (!teamIdCache) throw new Error('could not learn the team id; set XAI_TEAM_ID');
    const base = XAI_MANAGEMENT_BASE + '/v1/billing/teams/' + encodeURIComponent(teamIdCache);
    const ledger = await getJson(base + '/prepaid/balance', XAI_MANAGEMENT_KEY);
    // The preview is what makes the figure live. If it fails the ledger alone
    // is still worth showing, flagged as possibly generous.
    let preview = null;
    try { preview = await getJson(base + '/postpaid/invoice/preview', XAI_MANAGEMENT_KEY); } catch { /* inexact */ }
    const figures = remainingFrom(ledger, preview);
    if (!figures) throw new Error('the balance response had no readable total');
    value = Object.assign({ available: true, checkedAt: new Date().toISOString() }, figures);
    lastBalanceProblem = '';
  } catch (err) {
    const problem = err && err.message ? err.message : 'unknown error';
    // Said once per distinct problem, not once a minute for ever.
    if (problem !== lastBalanceProblem) console.error('[balance] could not read the prepaid balance: ' + problem);
    lastBalanceProblem = problem;
    value = { available: false, reason: 'unreachable', detail: problem };
  }
  balanceCache = { at: Date.now(), value: value };
  return value;
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
      retryAfter: retryAfterSeconds(response.headers),
      trace: pickTraceHeaders(response.headers)
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
// Reads photographs with a chat model and returns a generation prompt. It was
// built when the studio believed the edits endpoint could take only one source
// image; that turned out to be wrong (the plural `images` field takes five), so
// the Combine mode that called this is gone. The endpoint is kept, unchanged in
// behaviour, to be repurposed as a preservation-inventory extractor.
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
  // 'keep' leaves the person's wording untouched and only appends what the photos
  // show. 'rewrite' lets the model author the whole prompt instead.
  const style = input.style === 'rewrite' ? 'rewrite' : 'keep';

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
          { role: 'system', content: style === 'rewrite' ? COMBINE_SYSTEM : COMBINE_DETAIL_SYSTEM },
          { role: 'user', content: content }
        ],
        max_tokens: 400,
        temperature: 0.7
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    logFailure({ mode: 'describe', model: VISION_MODEL, sources: images.length, status: null,
      code: timedOut ? 'timeout' : 'network', message: err && err.message });
    return fail(res, 504, timedOut
      ? 'Reading the photos took too long and was given up on.'
      : 'Could not reach api.x.ai to read the photos (' + (err && err.message ? err.message : 'network error') + ').',
      { code: timedOut ? 'timeout' : 'network' });
  }

  const text = await response.text();
  if (!response.ok) {
    const message = extractError(text, response.status);
    logFailure({ mode: 'describe', model: VISION_MODEL, sources: images.length, status: response.status,
      code: classify(response.status, message), message: message, trace: pickTraceHeaders(response.headers) });
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
  const raw = choice && choice.message && typeof choice.message.content === 'string'
    ? choice.message.content.trim().replace(/^["'\s]+|["'\s]+$/g, '')
    : '';

  if (!raw) {
    return fail(res, 422,
      'The model read the photos but returned nothing. Try describing what you want more plainly.',
      { code: 'moderation' });
  }

  // In 'keep' the reply is per-photo detail and the prompt is the person's own
  // wording with that detail appended. In 'rewrite' the reply is the prompt.
  const details = style === 'keep' ? parseDetailLines(raw, images.length) : [];
  const prompt = style === 'keep' ? composePrompt(instruction, details) : raw;

  const cost = imagine.usdFromTicks(json.usage && json.usage.cost_in_usd_ticks) || 0;

  sendJson(res, 200, {
    prompt: prompt,
    details: details,
    style: style,
    cost: cost,
    tokens: (json.usage && json.usage.total_tokens) || 0,
    model: VISION_MODEL
  });
}

// ---------------------------------------------------------------------------
// POST /api/images
// ---------------------------------------------------------------------------

// Which frame a saved image is. The client asks for one image per request and
// says which frame it is; that number is used as sent. When a request returns
// several images at once (n > 1 on an edit) they are numbered by their place in
// that response instead, so no two share a number.
function frameNumber(sent, index, count) {
  const own = Number.isInteger(sent) && sent >= 1 ? sent : null;
  return count === 1 && own ? own : index + 1;
}

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

  // Which endpoint, the singular `image` or the plural `images`, which settings
  // are optional, the consent and likeness checks — all decided in
  // lib/imagine.js, where the tests can see it.
  const built = imagine.buildImageRequest(input);
  if (built.error) {
    return fail(res, built.code === 'likeness_policy' ? 422 : 400, built.error, { code: built.code });
  }

  const mode = built.mode;
  const model = built.model;
  const prompt = built.prompt;
  const user = typeof input.user === 'string' ? input.user.trim().slice(0, 80) : '';
  // A run is one press of the button. The client asks for one image per request
  // so frames arrive as they finish, which means several log lines share a run —
  // this is what groups them back together when reading usage.jsonl.
  const runId = typeof input.runId === 'string' ? input.runId.trim().slice(0, 40) : null;

  // What every log line about this request says about it.
  const about = {
    user: user, mode: mode, model: model, sources: mode === 'edit' ? built.sources : null,
    resolution: built.payload.resolution, aspect: built.payload.aspect_ratio, n: built.payload.n
  };

  let result = await callXai(built.endpoint, built.payload);
  let degraded = false;

  // A 400 usually means one optional parameter was not accepted. Retry once with
  // only the required fields — an optional parameter the model did not want
  // should not cost the user the whole run.
  // A rejected key produces a 400 too, and retrying that just doubles the wait.
  if (!result.ok && !result.networkFailure && result.status === 400 && result.code !== 'key_rejected') {
    const first = result;
    const retry = await callXai(built.endpoint, built.minimalPayload);
    if (retry.ok) {
      result = retry;
      degraded = true;
      // The person got their image, but not with the settings they chose. Say
      // what xAI objected to, or a setting that is always refused goes unnoticed.
      logFailure(Object.assign({}, about, { kind: 'xai-retry', status: first.status, code: first.code,
        message: 'rescued by retrying without optional settings; first answer: ' + first.message, trace: first.trace }));
    }
  }

  if (!result.ok) {
    const status = result.networkFailure ? 504 : (result.status >= 500 ? 502 : result.status);
    logFailure(Object.assign({}, about, { status: result.networkFailure ? null : result.status,
      code: result.code, message: result.message, trace: result.trace }));
    return fail(res, status, result.message, {
      code: result.code,
      // So the page can name the model that is not answering and offer another.
      model: model,
      upstreamStatus: result.networkFailure ? null : result.status,
      retryAfter: result.retryAfter || null,
      seconds: result.seconds || null
    });
  }

  const data = Array.isArray(result.json && result.json.data) ? result.json.data : [];

  // A success with no data means moderation filtered the prompt. Say so — do not
  // return an empty success and let the page look broken.
  if (data.length === 0) {
    logFailure(Object.assign({}, about, { status: 200, code: 'moderation', message: 'success with no images in it' }));
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
      // The edits endpoint sends revised_prompt back empty, so it is never read
      // on that path — the instruction the person typed is the truthful caption.
      revised_prompt: mode !== 'edit' && typeof item.revised_prompt === 'string' && item.revised_prompt
        ? item.revised_prompt : null,
      id: null
    };
  }).filter(function (img) {
    return img.b64 || img.url;
  });

  if (images.length === 0) {
    logFailure(Object.assign({}, about, { status: 200, code: 'upstream', message: 'image records with neither b64_json nor url' }));
    return fail(res, 502, 'xAI returned image records with neither b64_json nor url in them.', { code: 'upstream' });
  }

  // The minimal retry sends no aspect_ratio, resolution, n or quality, so those
  // revert to the API defaults. Log what actually applied, not what was asked
  // for, or a degraded 2k run is recorded at a size it never got.
  const effectiveQuality = degraded ? 'auto' : built.quality;
  const effectiveResolution = degraded ? '1k' : built.payload.resolution;
  const effectiveAspect = degraded ? 'auto' : built.payload.aspect_ratio;

  // What it cost. xAI's own figure whenever the response carries one; the price
  // table only when it does not, and then flagged as an estimate so the running
  // total never presents a guess as a bill.
  const billed = imagine.costFromResponse(result.json, {
    model: model,
    quality: effectiveQuality,
    resolution: effectiveResolution,
    mode: mode,
    count: images.length,
    sources: built.sources
  });
  const cost = billed.cost;

  // Save the bytes before answering, so a refresh can bring the run back. A
  // failure to write is logged but never fails the request — the user has
  // already paid for these images and must still receive them.
  const saved = [];
  for (let i = 0; i < images.length; i++) {
    const rec = await saveImage(images[i].b64);
    if (rec) {
      images[i].id = rec.id;
      saved.push({ id: rec.id, frame: frameNumber(input.frame, i, images.length) });
    }
  }
  pruneImages().catch(function () { /* pruning is housekeeping, never fatal */ });

  // Keep the photos this edit was made from, so it can be run again or loaded
  // back into the composer later. Same rule as the images: a failure to write
  // is logged and never fails the request.
  let sourceFiles = null;
  if (mode === 'edit' && saved.length) {
    const urls = built.payload.images ? built.payload.images.map(function (i) { return i.url; })
      : built.payload.image ? [built.payload.image.url] : [];
    const ids = [];
    for (const u of urls) ids.push(await saveSource(u));
    if (ids.length && ids.every(Boolean)) sourceFiles = ids;
    pruneSources().catch(function () { /* housekeeping */ });
  }

  // Into the prompt library. Never allowed to fail the request: the pictures
  // are paid for and must be delivered whatever happens to a bookkeeping file.
  if (SAVE_IMAGES && STORAGE_READY) {
    changePrompts(function (list) {
      return promptLib.recordUse(list, { text: prompt, mode: mode, user: user || null, runId: runId });
    }).catch(function () { /* logged in the queue */ });
  }

  await appendUsage({
    timestamp: new Date().toISOString(),
    runId: runId,
    files: saved,
    user: user || null,
    mode: mode,
    model: model,
    quality: built.acceptsQuality ? effectiveQuality : null,
    resolution: effectiveResolution,
    aspect_ratio: effectiveAspect,
    sources: built.sources,
    reference: built.reference,
    sourceFiles: sourceFiles,
    images: images.length,
    cost: cost,
    costEstimated: billed.estimated,
    degraded: degraded,
    prompt: prompt.slice(0, PROMPT_LOG_CHARS)
  });

  sendJson(res, 200, {
    images: images.map(function (i) {
      return { b64: i.b64, url: i.url, revised_prompt: i.revised_prompt, id: i.id || null };
    }),
    cost: cost,
    costEstimated: billed.estimated,
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
  // /asset is a view inside the app, not a file on disk: serve the same shell.
  const rel = decoded === '/' || /^\/assets?\/?$/.test(decoded) ? '/index.html' : decoded;

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
        studioName: STUDIO_NAME,
        hasKey: Boolean(XAI_API_KEY),
        requiresPassword: Boolean(TEAM_PASSWORD),
        prices: PRICES,
        qualityModels: QUALITY_MODELS,
        maxEditSources: imagine.MAX_EDIT_SOURCES,
        maxEditVariants: imagine.MAX_EDIT_VARIANTS,
        maxFrames: imagine.MAX_GENERATE_FRAMES,
        savesImages: SAVE_IMAGES && STORAGE_READY,
        // True when the history will not survive the next deploy.
        storageEphemeral: Boolean(STORAGE.ephemeral && SAVE_IMAGES)
      });
    }

    // Fetching one saved image by its random id needs no password, because an
    // <img src> cannot send a header. The id is the capability; the listing that
    // hands out ids is behind the password, just below.
    // Reading one saved image by its random id needs no password, because an
    // <img src> cannot send a header. Anything that CHANGES something falls
    // through to the authenticated block below.
    // The photos an edit was made from, under the same rule as the images: the
    // random-looking name is the capability, and only the password-protected
    // run list hands names out.
    if (urlPath.startsWith('/api/source/') && req.method === 'GET') {
      if (!SAVE_IMAGES) return fail(res, 404, 'Image saving is switched off on this server.');
      return await serveSavedImage(res, decodeURIComponent(urlPath.slice('/api/source/'.length)), SOURCE_DIR);
    }

    if (urlPath.startsWith('/api/image/') && req.method === 'GET') {
      if (!SAVE_IMAGES) return fail(res, 404, 'Image saving is switched off on this server.');
      return await serveSavedImage(res, decodeURIComponent(urlPath.slice('/api/image/'.length)));
    }

    if (urlPath.startsWith('/api/')) {
      if (TEAM_PASSWORD) {
        const ip = clientIp(req);
        // The same 401 for a wrong password and for a throttled address, so the
        // response never says which. A correct password during a lockout is
        // refused too; it counts as nothing and the lockout runs its course.
        if (loginThrottle.isBlocked(ip)) {
          return fail(res, 401, 'Password not recognised.', { code: 'unauthorized' });
        }
        if (!passwordMatches(req.headers['x-team-password'])) {
          const hit = loginThrottle.fail(ip);
          if (hit.delayMs > 0) {
            console.error('[auth] ' + ip + ' locked out for ' + Math.round(hit.delayMs / 1000) +
              's after ' + hit.failures + ' failed password attempts');
          }
          return fail(res, 401, 'Password not recognised.', { code: 'unauthorized' });
        }
        loginThrottle.clear(ip);
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
        return sendJson(res, 200, { deleted: result.deleted, missing: result.missing, wasFavourite: result.wasFavourite });
      }

      // Undo a delete made a moment ago.
      if (urlPath === '/api/images/restore') {
        if (req.method !== 'POST') return fail(res, 405, 'Use POST for /api/images/restore.');
        if (!SAVE_IMAGES) return fail(res, 404, 'Image saving is switched off on this server.');
        let body;
        try {
          body = JSON.parse(await readBody(req, 1024 * 1024) || '{}');
        } catch {
          return fail(res, 400, 'The request body was not valid JSON.');
        }
        if (!Array.isArray(body.ids) || !body.ids.length) return fail(res, 400, 'Send an ids array naming the images to restore.');
        return sendJson(res, 200, { restored: await restoreImages(body.ids.slice(0, 200), body.favourites) });
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
        let favouritesOnly = false;
        let before = null;
        try {
          const params = new URL(req.url, 'http://localhost').searchParams;
          favouritesOnly = params.get('favourites') === '1';
          const b = params.get('before');
          if (b && !Number.isNaN(Date.parse(b))) before = new Date(Date.parse(b)).toISOString();
          const q = params.get('limit');
          if (q) limit = Math.min(favouritesOnly ? 500 : 100, Math.max(1, parseInt(q, 10) || 20));
        } catch { /* keep the default */ }
        return sendJson(res, 200, { runs: await readRuns(limit, favouritesOnly, before), saving: true });
      }

      // The prompt library: list, favourite, delete, and put back.
      if (urlPath === '/api/prompts') {
        if (req.method !== 'GET') return fail(res, 405, 'Use GET for /api/prompts.');
        return sendJson(res, 200, { prompts: promptLib.sorted(await listPrompts()) });
      }
      if (urlPath === '/api/prompts/favourite' || urlPath === '/api/prompts/delete' || urlPath === '/api/prompts/restore') {
        if (req.method !== 'POST') return fail(res, 405, 'Use POST for ' + urlPath + '.');
        let body;
        try {
          body = JSON.parse(await readBody(req, 64 * 1024) || '{}');
        } catch {
          return fail(res, 400, 'The request body was not valid JSON.');
        }
        const action = urlPath.split('/').pop();
        if (action !== 'restore' && !promptLib.validPromptId(body.id)) return fail(res, 400, 'Not a valid prompt id.');
        const out = await changePrompts(function (list) {
          if (action === 'favourite') return promptLib.setFavourite(list, body.id, body.favourite !== false);
          if (action === 'delete') return promptLib.remove(list, body.id);
          return promptLib.restore(list, body.prompt || {});
        });
        if (!out.entry && action !== 'restore') return fail(res, 404, 'That prompt is no longer in the library.');
        return sendJson(res, 200, { prompt: out.entry, changed: out.changed });
      }

      if (urlPath === '/api/balance') {
        if (req.method !== 'GET') return fail(res, 405, 'Use GET for /api/balance.');
        return sendJson(res, 200, await readBalance());
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
  console.log(STUDIO_NAME + ' on http://' + shown + ':' + PORT);
  console.log('  API key           ' + (XAI_API_KEY ? 'loaded' : 'MISSING — add XAI_API_KEY to .env'));
  console.log('  Team password     ' + (TEAM_PASSWORD ? 'required, guesses throttled per address' : 'not set (anyone who can reach this port can spend credits)'));
  console.log('  Upstream timeout  ' + Math.round(UPSTREAM_TIMEOUT_MS / 1000) + 's');
  console.log('  Credit balance    ' + (XAI_MANAGEMENT_KEY ? 'shown (management key loaded)' : 'not shown — set XAI_MANAGEMENT_KEY to show what is left'));
  console.log('  Usage log         ' + USAGE_LOG);
  console.log('  Failures          one [xai-fail] line each, here on stderr');
  console.log('  Saved images      ' + (!SAVE_IMAGES ? 'off (SAVE_IMAGES=false)'
    : STORAGE_READY ? IMAGE_DIR + '  (keeping ' + MAX_STORED_IMAGES + ')'
    : 'NOT WRITABLE — ' + IMAGE_DIR + '  (' + STORAGE_PROBLEM + ')'));
  console.log('  Data folder       ' + DATA_DIR + '  (from ' + STORAGE.source + ')');
  if (STORAGE.ephemeral && SAVE_IMAGES) {
    console.error('');
    console.error('[storage] WARNING: saved images and the usage log will be LOST on the next deploy.');
    console.error('[storage] Reason: ' + STORAGE.why + '.');
    console.error('[storage] Fix: in Railway, right-click the service, Attach Volume, mount path /data.');
    console.error('[storage] Leave DATA_DIR unset (or set it to a folder inside the volume). See README.');
    console.error('');
  }
});
