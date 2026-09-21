'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/prompts.js');

test('the same words are one prompt, whatever the spacing or case', () => {
  assert.equal(P.promptId('A  plain\nchair'), P.promptId('a plain chair '));
  assert.notEqual(P.promptId('a plain chair'), P.promptId('a plain stool'));
  assert.equal(P.validPromptId(P.promptId('x')), true);
  assert.equal(P.validPromptId('../etc/passwd'), false);
});

test('a first use makes an entry; another run of it counts a second use', () => {
  let r = P.recordUse([], { text: 'a plain chair', mode: 'generate', user: 'Nadia', runId: 'run-1', at: '2026-09-21T10:00:00.000Z' });
  assert.equal(r.changed, true);
  assert.equal(r.list.length, 1);
  assert.equal(r.entry.uses, 1);
  r = P.recordUse(r.list, { text: 'A plain chair', runId: 'run-2', at: '2026-09-21T11:00:00.000Z' });
  assert.equal(r.list.length, 1);
  assert.equal(r.entry.uses, 2);
  assert.equal(r.entry.lastUsedAt, '2026-09-21T11:00:00.000Z');
});

test('the frames of one run are one use, not one each', () => {
  let list = [];
  for (let frame = 1; frame <= 4; frame++) list = P.recordUse(list, { text: 'four frames', runId: 'run-9' }).list;
  assert.equal(list[0].uses, 1);
});

test('an empty prompt is not recorded', () => {
  assert.equal(P.recordUse([], { text: '   ' }).changed, false);
});

test('favourite, remove and restore', () => {
  let list = P.recordUse([], { text: 'keep me', runId: 'a' }).list;
  const id = list[0].id;
  assert.equal(P.setFavourite(list, id, true).changed, true);
  assert.equal(P.setFavourite(list, id, true).changed, false);
  assert.equal(P.setFavourite(list, 'ffffffffffffffff', true).changed, false);

  const gone = P.remove(list, id);
  assert.equal(gone.list.length, 0);
  const back = P.restore(gone.list, gone.entry);
  assert.equal(back.list.length, 1);
  assert.equal(back.entry.favourite, true);
  assert.equal(back.entry.id, id);
  // Restoring what is already there does nothing.
  assert.equal(P.restore(back.list, gone.entry).changed, false);
});

test('restore takes only known fields and recomputes the id', () => {
  const r = P.restore([], { id: 'planted', text: 'real words', uses: -5, evil: true, createdAt: 'nonsense', user: 'x'.repeat(200) });
  assert.equal(r.entry.id, P.promptId('real words'));
  assert.equal(r.entry.uses, 1);
  assert.equal('evil' in r.entry, false);
  assert.equal(r.entry.user.length, 80);
  assert.equal(Number.isNaN(Date.parse(r.entry.createdAt)), false);
});

test('past the ceiling the oldest go first, and a favourite never does', () => {
  let list = [];
  list = P.recordUse(list, { text: 'the favourite', runId: 'f', at: '2020-01-01T00:00:00.000Z' }).list;
  list = P.setFavourite(list, list[0].id, true).list;
  for (let i = 0; i < P.MAX_PROMPTS + 5; i++) {
    list = P.recordUse(list, { text: 'prompt number ' + i, runId: 'r' + i, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }).list;
  }
  assert.equal(list.length, P.MAX_PROMPTS);
  assert.equal(list.some((p) => p.text === 'the favourite'), true);
  assert.equal(list.some((p) => p.text === 'prompt number 0'), false);
});

test('sorted puts favourites first, then the most recently used', () => {
  let list = [];
  list = P.recordUse(list, { text: 'old', runId: '1', at: '2026-01-01T00:00:00.000Z' }).list;
  list = P.recordUse(list, { text: 'new', runId: '2', at: '2026-06-01T00:00:00.000Z' }).list;
  list = P.recordUse(list, { text: 'starred', runId: '3', at: '2025-01-01T00:00:00.000Z' }).list;
  list = P.setFavourite(list, P.promptId('starred'), true).list;
  assert.deepEqual(P.sorted(list).map((p) => p.text), ['starred', 'new', 'old']);
});

test('the library can be built from the usage log', () => {
  const list = P.fromUsage([
    { prompt: 'a chair', mode: 'generate', runId: 'r1', timestamp: '2026-09-01T00:00:00.000Z' },
    { prompt: 'a chair', mode: 'generate', runId: 'r1', timestamp: '2026-09-01T00:00:01.000Z' },
    { prompt: 'a chair', mode: 'generate', runId: 'r2', timestamp: '2026-09-02T00:00:00.000Z' },
    { prompt: 'warm grey background', mode: 'edit', runId: 'r3', user: 'Sam', timestamp: '2026-09-03T00:00:00.000Z' },
    { nothing: true }
  ]);
  assert.equal(list.length, 2);
  assert.equal(list.find((p) => p.text === 'a chair').uses, 2);
  assert.equal(list.find((p) => p.mode === 'edit').user, 'Sam');
});
