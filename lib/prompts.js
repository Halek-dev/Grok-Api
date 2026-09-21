'use strict';

/**
 * The prompt library — every prompt the team has used, kept so a good one can
 * be found, copied and used again. Pure functions over a plain list; server.js
 * does the reading and writing.
 *
 * A prompt is identified by its text, tidied: the same words used twice are one
 * entry used twice, not two entries. An entry:
 *
 *   { id, text, mode, user, createdAt, lastUsedAt, uses, lastRunId, favourite }
 */
const crypto = require('node:crypto');

const MAX_TEXT = 1000;
const MAX_PROMPTS = 500;

function tidy(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function promptId(text) {
  return crypto.createHash('sha256').update(tidy(text).toLowerCase()).digest('hex').slice(0, 16);
}

function validPromptId(id) {
  return typeof id === 'string' && /^[0-9a-f]{16}$/.test(id);
}

// Records one use. A run asks for its frames one request at a time, so the same
// run reports the same prompt several times: the runId makes that one use.
function recordUse(list, use) {
  const text = tidy(use && use.text);
  if (!text) return { list: list, changed: false, entry: null };
  const id = promptId(text);
  const at = (use && use.at) || new Date().toISOString();
  const found = list.find((p) => p.id === id);
  if (found) {
    if (use.runId && found.lastRunId === use.runId) return { list: list, changed: false, entry: found };
    found.uses = (found.uses || 0) + 1;
    found.lastUsedAt = at;
    found.lastRunId = use.runId || null;
    if (use.user) found.user = use.user;
    if (use.mode) found.mode = use.mode;
    return { list: list, changed: true, entry: found };
  }
  const entry = {
    id: id, text: text, mode: use.mode === 'edit' ? 'edit' : 'generate', user: use.user || null,
    createdAt: at, lastUsedAt: at, uses: 1, lastRunId: use.runId || null, favourite: false
  };
  list.push(entry);
  return { list: trim(list), changed: true, entry: entry };
}

// Past the ceiling the least recently used go first — but never a favourite.
function trim(list) {
  if (list.length <= MAX_PROMPTS) return list;
  const keep = list.filter((p) => p.favourite);
  const rest = list.filter((p) => !p.favourite)
    .sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)))
    .slice(0, Math.max(0, MAX_PROMPTS - keep.length));
  return keep.concat(rest);
}

function setFavourite(list, id, on) {
  const found = list.find((p) => p.id === id);
  if (!found || found.favourite === Boolean(on)) return { list: list, changed: false, entry: found || null };
  found.favourite = Boolean(on);
  return { list: list, changed: true, entry: found };
}

function remove(list, id) {
  const found = list.find((p) => p.id === id);
  if (!found) return { list: list, changed: false, entry: null };
  return { list: list.filter((p) => p.id !== id), changed: true, entry: found };
}

// Puts back an entry that was deleted a moment ago, exactly as it was. Only the
// fields this module writes are taken, and the id is recomputed from the text,
// so nothing arbitrary can be planted through the undo.
function restore(list, entry) {
  const text = tidy(entry && entry.text);
  if (!text) return { list: list, changed: false, entry: null };
  const id = promptId(text);
  if (list.some((p) => p.id === id)) return { list: list, changed: false, entry: null };
  const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : new Date().toISOString());
  const back = {
    id: id, text: text, mode: entry.mode === 'edit' ? 'edit' : 'generate',
    user: typeof entry.user === 'string' ? entry.user.slice(0, 80) : null,
    createdAt: iso(entry.createdAt), lastUsedAt: iso(entry.lastUsedAt),
    uses: Math.max(1, Math.min(1e6, Math.floor(Number(entry.uses) || 1))), lastRunId: null,
    favourite: Boolean(entry.favourite)
  };
  list.push(back);
  return { list: trim(list), changed: true, entry: back };
}

// Favourites first, then most recently used.
function sorted(list) {
  return list.slice().sort((a, b) =>
    (Number(b.favourite) - Number(a.favourite)) || String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)));
}

// Builds the library from the usage log, for a studio that was in use before
// the library existed. The log keeps only the first 300 characters of a prompt.
function fromUsage(rows) {
  let list = [];
  for (const r of rows) {
    if (!r || !r.prompt) continue;
    list = recordUse(list, { text: r.prompt, mode: r.mode, user: r.user, runId: r.runId || r.timestamp, at: r.timestamp }).list;
  }
  return list;
}

module.exports = {
  MAX_PROMPTS: MAX_PROMPTS,
  tidy: tidy, promptId: promptId, validPromptId: validPromptId,
  recordUse: recordUse, setFavourite: setFavourite, remove: remove, restore: restore,
  sorted: sorted, fromUsage: fromUsage
};
