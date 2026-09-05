'use strict';

// Run with: npm test   (node --test, built into Node 18+; no dependencies)
//
// These cover the two request builders — what the browser sends to the proxy
// and what the proxy sends to xAI — because the edit path has now changed three
// times and each change was verified by eye against a paid request.

const test = require('node:test');
const assert = require('node:assert/strict');

const imagine = require('../lib/imagine.js');
const client = require('../public/request-body.js');

const M20 = 'grok-imagine-image-2.0';
const M15 = 'grok-imagine-image-quality';

function edit(extra) {
  return imagine.buildImageRequest(Object.assign({
    mode: 'edit', model: M20, prompt: 'replace the head with the one in image 2', consent: true
  }, extra));
}

// ---------------------------------------------------------------------------
// Server builder: which field carries the pictures
// ---------------------------------------------------------------------------
test('one source uses the singular image field and never images', () => {
  const r = edit({ sources: ['data:image/jpeg;base64,AAA'] });
  assert.equal(r.error, undefined);
  assert.equal(r.endpoint, '/images/edits');
  assert.deepEqual(r.payload.image, { type: 'image_url', url: 'data:image/jpeg;base64,AAA' });
  assert.equal('images' in r.payload, false);
  assert.equal(r.reference, false);
});

test('two to five sources use the plural images array and never image', () => {
  for (let n = 2; n <= 5; n++) {
    const list = Array.from({ length: n }, (_, i) => 'data:image/png;base64,' + i);
    const r = edit({ sources: list });
    assert.equal(r.error, undefined, 'n=' + n);
    assert.equal('image' in r.payload, false, 'n=' + n);
    assert.equal(r.payload.images.length, n);
    assert.equal(r.reference, true);
  }
});

test('image and images are mutually exclusive in both the full and the minimal payload', () => {
  const one = edit({ sources: ['a'] });
  const two = edit({ sources: ['a', 'b'] });
  for (const p of [one.payload, one.minimalPayload]) {
    assert.equal('image' in p && !('images' in p), true);
  }
  for (const p of [two.payload, two.minimalPayload]) {
    assert.equal('images' in p && !('image' in p), true);
  }
});

test('source order is preserved exactly — the first is the base', () => {
  const r = edit({ sources: ['base', 'ref-one', 'ref-two'] });
  assert.deepEqual(r.payload.images.map((i) => i.url), ['base', 'ref-one', 'ref-two']);
  const reversed = edit({ sources: ['ref-two', 'ref-one', 'base'] });
  assert.deepEqual(reversed.payload.images.map((i) => i.url), ['ref-two', 'ref-one', 'base']);
});

test('every source is wrapped as an image_url entry, whatever kind of reference it is', () => {
  const r = edit({ sources: ['https://example.com/a.jpg', 'data:image/png;base64,Zm9v', 'file-abc123'] });
  for (const item of r.payload.images) assert.equal(item.type, 'image_url');
  assert.equal(r.payload.images[2].url, 'file-abc123');
});

test('blank and non-string sources are dropped; six sources are refused', () => {
  const r = edit({ sources: ['a', '', null, 42, '  '] });
  assert.deepEqual(r.payload.image, { type: 'image_url', url: 'a' });
  const six = edit({ sources: ['1', '2', '3', '4', '5', '6'] });
  assert.equal(six.code, 'bad_request');
  assert.match(six.error, /at most 5/);
});

test('no source at all is a bad request, not a generation', () => {
  const r = edit({ sources: [] });
  assert.equal(r.code, 'bad_request');
  assert.equal(edit({}).code, 'bad_request');
});

test('the old single-string image field is still accepted', () => {
  const r = edit({ image: 'data:image/jpeg;base64,OLD' });
  assert.deepEqual(r.payload.image, { type: 'image_url', url: 'data:image/jpeg;base64,OLD' });
});

// ---------------------------------------------------------------------------
// Server builder: the settings that used to be omitted on edits
// ---------------------------------------------------------------------------
test('edits send aspect_ratio, resolution and n', () => {
  const r = edit({ sources: ['a', 'b'], aspect_ratio: '3:4', resolution: '2k', n: 3 });
  assert.equal(r.payload.aspect_ratio, '3:4');
  assert.equal(r.payload.resolution, '2k');
  assert.equal(r.payload.n, 3);
});

test('n on edits is clamped to 1-4 and defaults to 1', () => {
  assert.equal(edit({ sources: ['a'] }).payload.n, 1);
  assert.equal(edit({ sources: ['a'], n: 0 }).payload.n, 1);
  assert.equal(edit({ sources: ['a'], n: 9 }).payload.n, 4);
  assert.equal(edit({ sources: ['a'], n: 'x' }).payload.n, 1);
  assert.equal(edit({ sources: ['a'], n: 2.9 }).payload.n, 2);
});

test('generation keeps its own cap of ten', () => {
  const r = imagine.buildImageRequest({ mode: 'generate', model: M20, prompt: 'a chair', n: 25 });
  assert.equal(r.endpoint, '/images/generations');
  assert.equal(r.payload.n, 10);
  assert.equal('image' in r.payload || 'images' in r.payload, false);
});

test('unknown aspect ratio or resolution fall back rather than fail', () => {
  const r = edit({ sources: ['a'], aspect_ratio: '5:7', resolution: '4k' });
  assert.equal(r.payload.aspect_ratio, 'auto');
  assert.equal(r.payload.resolution, '1k');
});

test('the minimal retry payload keeps the pictures and drops every optional setting', () => {
  const r = edit({ sources: ['a', 'b'], aspect_ratio: '1:1', resolution: '2k', n: 2, quality: 'medium' });
  assert.deepEqual(Object.keys(r.minimalPayload).sort(), ['images', 'model', 'prompt', 'response_format']);
});

test('quality goes only to models that accept it', () => {
  assert.equal(edit({ sources: ['a'], quality: 'medium' }).payload.quality, 'medium');
  assert.equal('quality' in edit({ sources: ['a'], quality: 'auto' }).payload, false);
  assert.equal('quality' in edit({ model: M15, sources: ['a'], quality: 'medium' }).payload, false);
});

test('unknown model and empty prompt are refused before anything is built', () => {
  assert.equal(imagine.buildImageRequest({ mode: 'edit', model: 'nope', prompt: 'x', sources: ['a'] }).code, 'bad_request');
  assert.equal(edit({ sources: ['a'], prompt: '   ' }).code, 'bad_request');
});

// ---------------------------------------------------------------------------
// Server builder: the likeness rule
// ---------------------------------------------------------------------------
test('a reference edit without consent is refused; a single-photo edit needs none', () => {
  const r = edit({ sources: ['a', 'b'], consent: false });
  assert.equal(r.code, 'consent_required');
  assert.equal(edit({ sources: ['a', 'b'], consent: 'yes' }).code, 'consent_required');
  assert.equal(edit({ sources: ['a'], consent: undefined }).error, undefined);
});

test('a reference edit with a sexualised instruction is refused in code', () => {
  for (const p of ['put her face on the nude body in image 2', 'make him topless', 'swap in the bikini shot']) {
    const r = edit({ sources: ['a', 'b'], prompt: p });
    assert.equal(r.code, 'likeness_policy', p);
  }
  assert.equal(edit({ sources: ['a', 'b'], prompt: 'replace the head, keep the black top' }).error, undefined);
  // Ordinary words that merely contain a flagged one are not matched.
  assert.equal(edit({ sources: ['a', 'b'], prompt: 'brass lamp on a glass table, no assumptions' }).error, undefined);
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------
test('cost comes from usage.cost_in_usd_ticks at 1e-10 USD a tick', () => {
  const r = imagine.costFromResponse({ usage: { cost_in_usd_ticks: 200000000 } }, {});
  assert.deepEqual(r, { cost: 0.02, estimated: false });
  assert.equal(imagine.usdFromTicks(1000000000), 0.1);
});

test('without a usage block the price table is used and the result is marked as an estimate', () => {
  const r = imagine.costFromResponse({}, { model: M20, mode: 'edit', quality: 'auto', resolution: '2k', count: 1, sources: 2 });
  assert.equal(r.estimated, true);
  // medium 2k 0.08 + two inputs at 0.01
  assert.equal(r.cost, 0.1);
});

test('edit estimates use the requested resolution, not a fixed 1k tier', () => {
  const at1k = imagine.estimateCost({ model: M20, mode: 'edit', resolution: '1k', count: 1, sources: 1 });
  const at2k = imagine.estimateCost({ model: M20, mode: 'edit', resolution: '2k', count: 1, sources: 1 });
  assert.equal(at1k, 0.07);
  assert.equal(at2k, 0.09);
});

// ---------------------------------------------------------------------------
// Client builder: what the page sends to the proxy
// ---------------------------------------------------------------------------
function run(extra) {
  return Object.assign({
    id: 'run-1', mode: 'edit', model: M20, prompt: 'swap the head', quality: null,
    shape: '1:1', resolution: '2k', plan: 'reference', sources: ['base', 'ref-a', 'ref-b']
  }, extra);
}

test('reference plan sends every source in order on every frame, with consent', () => {
  for (const index of [0, 1, 2]) {
    const b = client.buildFrameBody(run(), index, { consent: true, user: 'Sam' });
    assert.deepEqual(b.sources, ['base', 'ref-a', 'ref-b']);
    assert.equal(b.consent, true);
    assert.equal(b.n, 1);
    assert.equal(b.aspect_ratio, '1:1');
    assert.equal(b.resolution, '2k');
    assert.equal(b.user, 'Sam');
  }
});

test('reference plan without consent sends consent:false, so the server refuses it', () => {
  assert.equal(client.buildFrameBody(run(), 0, {}).consent, false);
});

test('edit-each plan sends only this frame\'s own photo', () => {
  assert.deepEqual(client.buildFrameBody(run({ plan: 'each' }), 1, {}).sources, ['ref-a']);
  assert.equal('consent' in client.buildFrameBody(run({ plan: 'each' }), 1, {}), false);
});

test('the client body never carries the retired image field', () => {
  const b = client.buildFrameBody(run(), 0, { consent: true });
  assert.equal('image' in b, false);
  assert.equal('images' in b, false);
});

test('every frame carries its own 1-based frame number', () => {
  assert.equal(client.buildFrameBody(run(), 0, {}).frame, 1);
  assert.equal(client.buildFrameBody(run(), 2, {}).frame, 3);
  assert.equal(client.buildFrameBody(run({ mode: 'generate' }), 5, {}).frame, 6);
});

test('generation sends no sources and the shape and size chosen', () => {
  const b = client.buildFrameBody(run({ mode: 'generate', shape: '9:16', resolution: '1k' }), 0, {});
  assert.equal('sources' in b, false);
  assert.equal(b.aspect_ratio, '9:16');
  assert.equal(b.n, 1);
});

test('a copy of the sources is sent, not the run\'s own array', () => {
  const r = run();
  const b = client.buildFrameBody(r, 0, { consent: true });
  b.sources.reverse();
  assert.deepEqual(r.sources, ['base', 'ref-a', 'ref-b']);
});

// End to end through both builders: the client's body is what the server maps.
test('client body for a reference edit becomes a plural images payload upstream', () => {
  const body = client.buildFrameBody(run(), 0, { consent: true });
  const up = imagine.buildImageRequest(body);
  assert.equal(up.error, undefined);
  assert.deepEqual(up.payload.images.map((i) => i.url), ['base', 'ref-a', 'ref-b']);
  assert.equal('image' in up.payload, false);
});

test('client body for edit-each becomes a singular image payload upstream', () => {
  const body = client.buildFrameBody(run({ plan: 'each' }), 2, {});
  const up = imagine.buildImageRequest(body);
  assert.equal(up.error, undefined);
  assert.deepEqual(up.payload.image, { type: 'image_url', url: 'ref-b' });
  assert.equal('images' in up.payload, false);
});
