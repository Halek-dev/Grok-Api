#!/usr/bin/env node
'use strict';

/**
 * One real call to Google, to see what the live service answers — run this
 * once billing is enabled on the Google project, and again whenever Google
 * changes something. It costs one picture (about $0.13 at 1K) per style
 * checked, and prints the SHAPE of the answer: status, field names, token
 * counts, the cost the studio would record, and any refusal — never the key,
 * never the picture's bytes.
 *
 *   node scripts/check-google.js                  the style GOOGLE_API picks
 *   node scripts/check-google.js both             both styles (two pictures)
 *   node scripts/check-google.js generateContent  that one
 *
 * Reads GOOGLE_API_KEY (and GOOGLE_API, GOOGLE_BASE_URL) from .env like the
 * server does. If the answer's shape differs from what lib/google.js reads,
 * the studio would show the cost as an estimate (≈): fix the reader there,
 * and pin the new shape in test/google.test.js.
 *
 * Each answer is also kept, with the picture's bytes replaced by their
 * length, at .local/google-<style>.json (gitignored) — the fixture to pin
 * from, with nothing in it but field names and numbers.
 */
const fs = require('node:fs');
const path = require('node:path');
const google = require('../lib/google.js');

const ROOT = path.join(__dirname, '..');
const env = {};
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
} catch { /* no .env: process.env only */ }
const get = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : env[k] || d);

const KEY = get('GOOGLE_API_KEY', '');
const BASE = String(get('GOOGLE_BASE_URL', 'https://generativelanguage.googleapis.com')).replace(/\/+$/, '');
const DEFAULT_STYLE = get('GOOGLE_API', 'interactions') === 'generateContent' ? 'generateContent' : 'interactions';
if (!KEY) {
  console.error('GOOGLE_API_KEY is not set — add it to .env first.');
  process.exit(1);
}

const arg = process.argv[2];
const styles = arg === 'both' ? ['interactions', 'generateContent']
  : arg === 'generateContent' || arg === 'interactions' ? [arg] : [DEFAULT_STYLE];

// A description of a value's shape: keys and types, long strings as lengths.
function shape(v, depth) {
  depth = depth || 0;
  if (Array.isArray(v)) return v.length ? '[' + shape(v[0], depth + 1) + ' ×' + v.length + ']' : '[]';
  if (v && typeof v === 'object') {
    if (depth > 4) return '{…}';
    return '{' + Object.keys(v).map((k) => k + ': ' + shape(v[k], depth + 1)).join(', ') + '}';
  }
  if (typeof v === 'string') return v.length > 60 ? 'str(' + v.length + ')' : JSON.stringify(v);
  return String(v);
}

// The answer with its pictures taken out: a base64 run longer than a line is
// replaced by a note of its length, so the file holds shape, not bytes.
function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = redact(v[k]);
    return out;
  }
  if (typeof v === 'string' && v.length > 200 && /^[A-Za-z0-9+/=_-]+$/.test(v)) return '<base64 ' + v.length + ' chars>';
  return v;
}
function keep(style, status, json) {
  const dir = path.join(ROOT, '.local');
  const file = path.join(dir, 'google-' + style + '.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ status: status, body: redact(json) }, null, 2) + '\n');
    console.log('  kept (redacted): ' + path.relative(ROOT, file));
  } catch (err) {
    console.log('  could not keep a copy: ' + err.message);
  }
}

async function check(style) {
  const input = { mode: 'generate', model: 'gemini-3-pro-image', prompt: 'A small red lighthouse on a rocky shore at dusk, soft light', aspect_ratio: '1:1', resolution: '1k' };
  const built = google.buildImageRequest(input, style);
  console.log('=== ' + style + '  POST ' + built.endpoint);
  let res;
  try {
    res = await fetch(BASE + built.endpoint, {
      method: 'POST',
      headers: Object.assign({ 'x-goog-api-key': KEY, 'content-type': 'application/json' }, built.headers),
      body: JSON.stringify(built.payload),
      signal: AbortSignal.timeout(180000)
    });
  } catch (err) {
    console.log('  network failure: ' + (err && err.message));
    return false;
  }
  const text = await res.text();
  console.log('  HTTP ' + res.status + (res.headers.get('retry-after') ? '  retry-after=' + res.headers.get('retry-after') : ''));
  let json;
  try { json = JSON.parse(text); } catch { console.log('  body is not JSON: ' + text.slice(0, 200)); return false; }
  console.log('  shape: ' + shape(json));
  keep(style, res.status, json);
  if (!res.ok) {
    const named = google.classify(res.status, text);
    console.log('  the studio would say: code=' + named.code + (named.googleStatus ? ' (' + named.googleStatus + ')' : ''));
    console.log('  message: ' + named.message.slice(0, 300));
    return false;
  }
  const read = google.imagesFromResponse(json, style);
  const tokens = google.usageFromResponse(json, style);
  const cost = google.costFromResponse(json, style, { model: input.model, resolution: '1k', mode: 'generate', count: 1, sources: 0 });
  console.log('  pictures: ' + read.images.length + (read.images.length ? '  (' + read.images.map((i) => i.mime + ', ' + Math.round(i.b64.length * 0.75 / 1024) + ' KB').join('; ') + ')' : ''));
  if (read.text) console.log('  text alongside: ' + JSON.stringify(read.text.slice(0, 120)));
  if (read.blocked) console.log('  refused: ' + read.blocked);
  console.log('  tokens: ' + (tokens ? JSON.stringify(tokens) : 'NONE READ — the cost below is the table estimate; fix usageFromResponse in lib/google.js'));
  console.log('  cost the studio would record: $' + cost.cost + (cost.estimated ? '  (ESTIMATE)' : '  (from token counts)'));
  const ok = read.images.length > 0 && !cost.estimated;
  console.log(ok ? '  OK — picture and cost both read.' : '  ATTENTION — see above.');
  return ok;
}

(async () => {
  let allOk = true;
  for (const style of styles) allOk = (await check(style)) && allOk;
  process.exit(allOk ? 0 : 2);
})();
