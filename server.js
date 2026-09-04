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

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const USAGE_LOG = path.join(ROOT, 'usage.jsonl');

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
// Only override this to route through a gateway, or to point the proxy at a
// stub while testing. It must speak the same API as api.x.ai.
const XAI_BASE = String(env('XAI_BASE_URL', 'https://api.x.ai/v1')).replace(/\/+$/, '');

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
  for (const r of rows) {
    const cost = typeof r.cost === 'number' ? r.cost : 0;
    total += cost;
    images += typeof r.images === 'number' ? r.images : 0;
    const t = Date.parse(r.timestamp);
    if (!Number.isNaN(t) && t >= startOfDay.getTime()) today += cost;
  }
  return {
    runs: rows.length,
    images: images,
    total: Math.round(total * 1e6) / 1e6,
    today: Math.round(today * 1e6) / 1e6,
    recent: rows.slice(-25).reverse()
  };
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

  const mode = input.mode === 'edit' ? 'edit' : 'generate';
  const model = String(input.model || '');
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  const user = typeof input.user === 'string' ? input.user.trim().slice(0, 80) : '';

  if (!PRICES[model]) {
    return fail(res, 400,
      'Unknown model "' + model + '". Pick one of: ' + Object.keys(PRICES).join(', ') + '.',
      { code: 'bad_request' });
  }
  if (!prompt) {
    return fail(res, 400, mode === 'edit'
      ? 'Describe the change you want before applying an edit.'
      : 'Write a prompt before generating.', { code: 'bad_request' });
  }

  const acceptsQuality = QUALITY_MODELS.indexOf(model) !== -1;
  const quality = QUALITIES.indexOf(input.quality) === -1 ? 'auto' : input.quality;

  const endpoint = mode === 'edit' ? '/images/edits' : '/images/generations';
  let payload;
  let minimalPayload;

  if (mode === 'edit') {
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
      revised_prompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : null
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

  await appendUsage({
    timestamp: new Date().toISOString(),
    user: user || null,
    mode: mode,
    model: model,
    quality: acceptsQuality ? effectiveQuality : null,
    resolution: mode === 'edit' ? null : effectiveResolution,
    aspect_ratio: mode === 'edit' ? null : effectiveAspect,
    images: images.length,
    cost: cost,
    degraded: degraded,
    prompt: prompt.slice(0, PROMPT_LOG_CHARS)
  });

  sendJson(res, 200, { images: images, cost: cost, degraded: degraded });
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
        qualityModels: QUALITY_MODELS
      });
    }

    if (urlPath.startsWith('/api/')) {
      if (TEAM_PASSWORD && !passwordMatches(req.headers['x-team-password'])) {
        return fail(res, 401, 'Password not recognised.', { code: 'unauthorized' });
      }

      if (urlPath === '/api/usage') {
        if (req.method !== 'GET') return fail(res, 405, 'Use GET for /api/usage.');
        return sendJson(res, 200, await readUsage());
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
        return handleImages(req, res, body);
      }

      return fail(res, 404, 'No such endpoint: ' + urlPath);
    }

    if (req.method !== 'GET') return fail(res, 405, 'Method not allowed.');
    return serveStatic(req, res, urlPath);
  } catch (err) {
    console.error('[server] unhandled error on ' + urlPath + ':', err);
    if (!res.headersSent) fail(res, 500, 'The server hit an unexpected error: ' + err.message);
    else res.end();
  }
});

server.listen(PORT, HOST, function () {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('Imagine studio on http://' + shown + ':' + PORT);
  console.log('  API key           ' + (XAI_API_KEY ? 'loaded' : 'MISSING — add XAI_API_KEY to .env'));
  console.log('  Team password     ' + (TEAM_PASSWORD ? 'required' : 'not set (anyone who can reach this port can spend credits)'));
  console.log('  Upstream timeout  ' + Math.round(UPSTREAM_TIMEOUT_MS / 1000) + 's');
  console.log('  Usage log         ' + USAGE_LOG);
});
