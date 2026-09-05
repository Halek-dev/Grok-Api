'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createThrottle } = require('../lib/throttle.js');

function clock(start) {
  let t = start || 1000000;
  const fn = () => t;
  fn.advance = (ms) => { t += ms; };
  return fn;
}

test('a few failures are free, then the address is locked out', () => {
  const now = clock();
  const th = createThrottle({ now: now, freeFailures: 3, baseMs: 1000 });
  assert.equal(th.fail('1.1.1.1').delayMs, 0);
  assert.equal(th.fail('1.1.1.1').delayMs, 0);
  assert.equal(th.isBlocked('1.1.1.1'), false);
  const third = th.fail('1.1.1.1');
  assert.equal(third.failures, 3);
  assert.equal(third.delayMs, 1000);
  assert.equal(th.isBlocked('1.1.1.1'), true);
});

test('the delay doubles on every further failure and is capped', () => {
  const now = clock();
  const th = createThrottle({ now: now, freeFailures: 1, baseMs: 1000, maxMs: 5000 });
  assert.equal(th.fail('a').delayMs, 1000);
  assert.equal(th.fail('a').delayMs, 2000);
  assert.equal(th.fail('a').delayMs, 4000);
  assert.equal(th.fail('a').delayMs, 5000);
  assert.equal(th.fail('a').delayMs, 5000);
});

test('the lockout ends when the time has passed', () => {
  const now = clock();
  const th = createThrottle({ now: now, freeFailures: 1, baseMs: 1000 });
  th.fail('a');
  assert.equal(th.isBlocked('a'), true);
  now.advance(999);
  assert.equal(th.isBlocked('a'), true);
  now.advance(1);
  assert.equal(th.isBlocked('a'), false);
});

test('a correct password clears the address; other addresses are unaffected', () => {
  const now = clock();
  const th = createThrottle({ now: now, freeFailures: 1, baseMs: 1000 });
  th.fail('a');
  th.fail('b');
  th.clear('a');
  assert.equal(th.isBlocked('a'), false);
  assert.equal(th.isBlocked('b'), true);
  // The count starts again from zero, not from where it was.
  assert.equal(th.fail('a').failures, 1);
});

test('quiet addresses are forgotten by prune, active or locked ones are kept', () => {
  const now = clock();
  const th = createThrottle({ now: now, freeFailures: 2, baseMs: 60000, forgetMs: 1000 });
  th.fail('quiet');          // one free failure, no lockout
  th.fail('locked'); th.fail('locked'); // locked for 60s
  now.advance(1500);
  th.prune();
  assert.equal(th.size(), 1);
  assert.equal(th.isBlocked('locked'), true);
});
