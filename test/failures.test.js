'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, pickTraceHeaders, failureLogLine } = require('../lib/failures.js');
const imagine = require('../lib/imagine.js');

// The exact wording xAI sent on 18 September 2026.
const XAI_404 = 'The model grok-imagine-image-quality does not exist or your team ' +
  'c0437d84-c844-442c-b8e6-5be97a65a160 does not have access to it. If you believe this is a mistake, ' +
  'please contact support and quote your team ID and the model name.';

test('xAI\'s model-not-found 404 gets its own code', () => {
  assert.equal(classify(404, XAI_404), 'model_unavailable');
  assert.equal(classify(404, 'The model foo does not exist'), 'model_unavailable');
});

test('a plain 404, or the same words on another status, stays unmapped', () => {
  assert.equal(classify(404, 'Not found'), 'upstream');
  assert.equal(classify(500, 'The model foo does not exist'), 'upstream');
});

test('the existing codes still win where they applied before', () => {
  assert.equal(classify(429, ''), 'rate_limited');
  assert.equal(classify(402, ''), 'no_credits');
  assert.equal(classify(404, 'Your team does not have access: insufficient credit balance'), 'no_credits');
  assert.equal(classify(400, 'Incorrect API key provided'), 'key_rejected');
  assert.equal(classify(403, 'nope'), 'key_rejected');
  assert.equal(classify(400, 'Rejected by content policy'), 'moderation');
  assert.equal(classify(400, 'aspect_ratio: unknown variant'), 'upstream');
});

test('trace headers are picked out and nothing else', () => {
  const h = new Headers({
    'x-request-id': 'abc-123', 'cf-ray': '8f00-IAD', 'x-served-by': 'us-east-1',
    'content-type': 'application/json', 'set-cookie': 'secret=1', 'authorization': 'Bearer nope'
  });
  assert.deepEqual(pickTraceHeaders(h), { 'cf-ray': '8f00-IAD', 'x-request-id': 'abc-123', 'x-served-by': 'us-east-1' });
  assert.deepEqual(pickTraceHeaders(null), {});
});

test('the log line carries who, what, which model and what xAI said', () => {
  const line = failureLogLine({
    at: new Date('2026-09-18T05:59:20.000Z'), user: 'Nadia R.', mode: 'edit',
    model: 'grok-imagine-image-quality', sources: 2, resolution: '2k', aspect: 'auto', n: 1,
    status: 404, code: 'model_unavailable', message: XAI_404, trace: { 'x-request-id': 'abc-123' }
  });
  assert.match(line, /^\[xai-fail\] 2026-09-18T05:59:20\.000Z status=404 code=model_unavailable mode=edit model=grok-imagine-image-quality photos=2 size=2k shape=auto n=1 user="Nadia R\." x-request-id=abc-123 msg="The model /);
  assert.equal(line.indexOf('\n'), -1);
});

test('the log line never carries a prompt, a picture, or a line break', () => {
  const line = failureLogLine({
    user: 'Eve"\nFAKE [xai-fail] line', mode: 'edit', model: 'grok-imagine-image-2.0', status: 400, code: 'upstream',
    prompt: 'a secret prompt', sourcesData: ['data:image/png;base64,AAAA'],
    message: 'could not fetch data:image/jpeg;base64,' + 'QUJD'.repeat(500) + ' for this request'
  });
  assert.equal(line.indexOf('secret prompt'), -1);
  assert.equal(line.indexOf('QUJDQUJD'), -1);
  assert.match(line, /\[data-uri\]/);
  assert.equal(/[\r\n]/.test(line), false);
  assert.match(line, /user="Eve' FAKE \[xai-fail\] line"/);
  assert.ok(line.length < 700);
});

test('a failure with no HTTP status says so', () => {
  const line = failureLogLine({ mode: 'generate', model: 'grok-imagine-image-2.0', status: null, code: 'timeout', message: 'xAI did not answer' });
  assert.match(line, /status=none code=timeout/);
  assert.match(line, /user="unnamed"/);
});

// Phase 1's guard: whatever the default is, it must not be on its way out.
test('the default model is not one with a retirement date', () => {
  const defaults = Object.keys(imagine.PRICES).filter((id) => imagine.PRICES[id].isDefault);
  assert.equal(defaults.length, 1);
  assert.equal(imagine.PRICES[defaults[0]].retiresAt, undefined);
  assert.equal(defaults[0], 'grok-imagine-image-2.0');
});
