'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const google = require('../lib/google.js');
const imagine = require('../lib/imagine.js');

const M = 'gemini-3-pro-image';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z';

const gen = (extra, style) => google.buildImageRequest(Object.assign({ mode: 'generate', model: M, prompt: 'a red chair' }, extra || {}), style);
const edit = (extra, style) => google.buildImageRequest(Object.assign({ mode: 'edit', model: M, prompt: 'make it blue', sources: [PNG] }, extra || {}), style);

// ---- builders

test('a generation, the documented way: one text block, the size in upper-case K, no shape on auto', () => {
  const r = gen();
  assert.equal(r.error, undefined);
  assert.equal(r.style, 'interactions');
  assert.equal(r.endpoint, '/v1beta/interactions');
  assert.equal(r.headers['Api-Revision'], google.API_REVISION);
  assert.deepEqual(r.payload, {
    model: M,
    input: [{ type: 'text', text: 'a red chair' }],
    response_format: { type: 'image', image_size: '1K' }
  });
  assert.deepEqual(r.minimalPayload.response_format, { type: 'image' });
  assert.equal(r.acceptsQuality, false);
  assert.equal(r.sources, 0);
});

test('shape and size go through in Google\'s words; 4k is offered; 2:1 is not Google\'s and falls back to auto', () => {
  assert.deepEqual(gen({ aspect_ratio: '16:9', resolution: '4k' }).payload.response_format, { type: 'image', image_size: '4K', aspect_ratio: '16:9' });
  assert.equal(gen({ resolution: '2k' }).payload.response_format.image_size, '2K');
  assert.equal(gen({ aspect_ratio: '2:1' }).payload.response_format.aspect_ratio, undefined);
  assert.equal(gen({ aspect_ratio: '2:1' }).aspect, 'auto');
  assert.equal(gen({ resolution: '8k' }).resolution, '1k');
});

test('the older call: contents with parts, IMAGE modality, imageConfig', () => {
  const r = gen({ aspect_ratio: '3:4', resolution: '2k' }, 'generateContent');
  assert.equal(r.style, 'generateContent');
  assert.equal(r.endpoint, '/v1beta/models/' + M + ':generateContent');
  assert.deepEqual(r.payload, {
    contents: [{ role: 'user', parts: [{ text: 'a red chair' }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { imageSize: '2K', aspectRatio: '3:4' } }
  });
  assert.deepEqual(r.minimalPayload.generationConfig, { responseModalities: ['IMAGE'] });
});

test('an edit sends the photos as bare base64 with their type, in order, after the prompt', () => {
  const r = edit({ sources: [PNG, JPG], consent: true });
  assert.equal(r.error, undefined);
  const blocks = r.payload.input;
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[1].type, 'image');
  assert.equal(blocks[1].mime_type, 'image/png');
  assert.equal(blocks[1].data, PNG.split(',')[1]);
  assert.equal(blocks[2].mime_type, 'image/jpeg');
  assert.equal(r.sources, 2);
  assert.equal(r.reference, true);
  assert.deepEqual(r.sourceUris, [PNG, JPG]);

  const g = edit({ sources: [JPG, PNG], consent: true }, 'generateContent');
  const parts = g.payload.contents[0].parts;
  assert.deepEqual(parts[1].inlineData, { mimeType: 'image/jpeg', data: JPG.split(',')[1] });
  assert.equal(parts[2].inlineData.mimeType, 'image/png');
});

test('the same rules as xAI: at most five photos, consent for two or more, the likeness rule, no URLs', () => {
  assert.equal(edit({ sources: [PNG, PNG, PNG, PNG, PNG, PNG], consent: true }).code, 'bad_request');
  assert.equal(edit({ sources: [PNG, JPG] }).code, 'consent_required');
  assert.equal(edit({ sources: [PNG, JPG], consent: true, prompt: 'put her in lingerie' }).code, 'likeness_policy');
  assert.equal(edit({ sources: [PNG] }).error, undefined, 'one photo needs no consent');
  assert.equal(edit({ sources: ['https://example.com/a.jpg'] }).code, 'bad_request');
  assert.equal(edit({ sources: [] }).code, 'bad_request');
  assert.equal(gen({ prompt: '  ' }).code, 'bad_request');
});

test('each builder refuses the other engine\'s model', () => {
  assert.equal(google.buildImageRequest({ mode: 'generate', model: 'grok-imagine-image-2.0', prompt: 'x' }).code, 'bad_request');
  assert.equal(imagine.buildImageRequest({ mode: 'generate', model: M, prompt: 'x' }).code, 'bad_request');
  assert.equal(imagine.providerOf(M), 'google');
  assert.equal(imagine.providerOf('grok-imagine-image-2.0'), 'xai');
  assert.equal(imagine.QUALITY_MODELS.indexOf(M), -1, 'no quality pill for Google');
});

// ---- readers

test('the documented answer: pictures from model_output steps, thought drafts ignored, text kept', () => {
  const json = {
    steps: [
      { type: 'thought', content: [{ type: 'image', data: 'DRAFT' }, { type: 'text', text: 'planning' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'Here is your chair.' }, { type: 'image', data: 'FINAL', mime_type: 'image/png' }] }
    ],
    output_image: { data: 'FINAL' }
  };
  const r = google.imagesFromResponse(json, 'interactions');
  assert.deepEqual(r.images, [{ b64: 'FINAL', mime: 'image/png' }]);
  assert.equal(r.text, 'Here is your chair.');
  assert.equal(r.blocked, null);
  // Only the convenience field.
  assert.deepEqual(google.imagesFromResponse({ output_image: { data: 'X', mime_type: 'image/jpeg' } }, 'interactions').images, [{ b64: 'X', mime: 'image/jpeg' }]);
  // Nothing at all.
  assert.deepEqual(google.imagesFromResponse({ steps: [] }, 'interactions').images, []);
});

test('the older answer: inlineData parts, and a refusal is named', () => {
  const ok = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Sure.' }, { inlineData: { mimeType: 'image/png', data: 'PIC' } }] } }] };
  const r = google.imagesFromResponse(ok, 'generateContent');
  assert.deepEqual(r.images, [{ b64: 'PIC', mime: 'image/png' }]);
  assert.equal(r.text, 'Sure.');

  const refused = { candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] };
  assert.equal(google.imagesFromResponse(refused, 'generateContent').blocked, 'IMAGE_SAFETY');
  const blockedPrompt = { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, candidates: [] };
  assert.equal(google.imagesFromResponse(blockedPrompt, 'generateContent').blocked, 'PROHIBITED_CONTENT');
});

// ---- money

test('cost from token counts: input at $2/M, image output at $120/M, text and thinking at $12/M', () => {
  const json = { usageMetadata: {
    promptTokenCount: 600, candidatesTokenCount: 1150, thoughtsTokenCount: 900,
    promptTokensDetails: [{ modality: 'TEXT', tokenCount: 40 }, { modality: 'IMAGE', tokenCount: 560 }],
    candidatesTokensDetails: [{ modality: 'IMAGE', tokenCount: 1120 }, { modality: 'TEXT', tokenCount: 30 }]
  } };
  const r = google.costFromResponse(json, 'generateContent', { model: M, resolution: '1k', mode: 'edit', count: 1, sources: 1 });
  assert.equal(r.estimated, false);
  // 600*2 + 1120*120 + (30+900)*12 = 1200 + 134400 + 11160 = 146760 µ$
  assert.equal(r.cost, 0.14676);
  assert.deepEqual(r.tokens, { input: 600, outputImage: 1120, outputText: 30, thoughts: 900 });
});

test('without a modality split every output token is billed as image, never less', () => {
  const r = google.costFromResponse({ usage: { input_tokens: 20, output_tokens: 1120 } }, 'interactions', { model: M, resolution: '1k' });
  assert.equal(r.estimated, false);
  assert.equal(r.cost, 0.13444);
});

test('no token counts: the table, flagged as an estimate — 1k/2k $0.134, 4k $0.24, plus $0.0011 a photo on edits', () => {
  const at = (res, mode, sources) => google.costFromResponse({}, 'interactions', { model: M, resolution: res, mode: mode, count: 1, sources: sources });
  assert.deepEqual(at('1k', 'generate'), { cost: 0.134, estimated: true, tokens: null });
  assert.equal(at('2k', 'generate').cost, 0.134);
  assert.equal(at('4k', 'generate').cost, 0.24);
  assert.equal(at('4k', 'edit', 3).cost, 0.2433);
  // The shared estimator knows the Google entry's 4k too.
  assert.equal(imagine.estimateCost({ model: M, resolution: '4k', mode: 'generate', count: 2 }), 0.48);
  assert.equal(imagine.estimateCost({ model: M, resolution: '4k', mode: 'edit', count: 1, sources: 2 }), 0.2422);
});

// ---- failures

test('Google\'s errors are named by their status string as much as the HTTP code', () => {
  const body = (code, status, message) => JSON.stringify({ error: { code: code, status: status, message: message } });
  assert.equal(google.classify(429, body(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for quota metric')).code, 'rate_limited');
  assert.equal(google.classify(429, body(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota, please enable billing')).code, 'no_credits');
  assert.equal(google.classify(400, body(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.')).code, 'key_rejected');
  assert.equal(google.classify(403, body(403, 'PERMISSION_DENIED', 'Permission denied')).code, 'key_rejected');
  assert.equal(google.classify(404, body(404, 'NOT_FOUND', 'models/gemini-x is not found')).code, 'model_unavailable');
  assert.equal(google.classify(400, body(400, 'INVALID_ARGUMENT', 'The response was blocked by safety filters')).code, 'moderation');
  const plain = google.classify(502, '<html>Bad Gateway</html>');
  assert.equal(plain.code, 'upstream');
  assert.equal(plain.message, '<html>Bad Gateway</html>');
  assert.equal(google.classify(500, '').message, 'Google returned status 500 with an empty body.');
  assert.equal(google.classify(429, body(429, 'RESOURCE_EXHAUSTED', 'x')).googleStatus, 'RESOURCE_EXHAUSTED');
});

// The real refusals from a free-tier key on 5 November 2026, both styles.
// Both calls accepted the request shape (no 400) and turned it away for want of
// billing. The documented call answers with a string `code` and no `status`;
// the older one with the gRPC status string. Both must read as "not billing",
// never as a rate limit — the retry-after on the first was 73,665 seconds.
test('a free-tier key is "not billing", not "rate limited", whichever call answered', () => {
  const documented = JSON.stringify({ error: { message: 'Rate limit exceeded for model gemini-3-pro-image (limit: 0 input tokens per minute on Free Tier). Please upgrade your tier at https://ai.dev/rate-limit.', code: 'too_many_requests' } });
  const older = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3-pro-image, description: Generate content input tokens per minute limit exceeded on Free Tier. Please retry in 20h27m45.552861161s.' } });
  const a = google.classify(429, documented);
  assert.equal(a.code, 'no_credits');
  assert.equal(a.googleStatus, null);
  assert.match(a.message, /Free Tier/);
  const b = google.classify(429, older);
  assert.equal(b.code, 'no_credits');
  assert.equal(b.googleStatus, 'RESOURCE_EXHAUSTED');
  // A genuine per-minute limit on a billed key stays a rate limit.
  assert.equal(google.classify(429, JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for metric: generate_content_paid_tier_requests, limit: 20, model: gemini-3-pro-image. Please retry in 12s.' } })).code, 'rate_limited');
});

test('a data URI is split into type and bare base64; anything else is refused', () => {
  assert.deepEqual(google.parseDataUri('data:image/webp;base64,AAAA'), { mime: 'image/webp', data: 'AAAA' });
  assert.equal(google.parseDataUri('https://x/y.png'), null);
  assert.equal(google.parseDataUri('data:text/plain;base64,AAAA'), null);
  assert.equal(google.parseDataUri(''), null);
});
