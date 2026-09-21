'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { remainingFrom } = require('../lib/balance.js');

test('credit held is a negative ledger total, so what remains is the total negated', () => {
  const r = remainingFrom({ total: { val: '-5000' } }, { coreInvoice: { prepaidCreditsUsed: { val: '0' } } });
  assert.deepEqual(r, { ledger: 50, cycleSpend: 0, remaining: 50, exact: true });
});

test('this cycle\'s prepaid use is taken off, because the ledger has not posted it yet', () => {
  const r = remainingFrom({ total: { val: '-5000' } }, { coreInvoice: { prepaidCreditsUsed: { val: '873' } } });
  assert.equal(r.remaining, 41.27);
  assert.equal(r.cycleSpend, 8.73);
  // The sign of the used figure does not matter; it is an amount consumed.
  assert.equal(remainingFrom({ total: { val: '-5000' } }, { coreInvoice: { prepaidCreditsUsed: { val: '-873' } } }).remaining, 41.27);
});

test('without a readable preview the ledger is reported and flagged as inexact', () => {
  const r = remainingFrom({ total: { val: '-1234' } }, null);
  assert.deepEqual(r, { ledger: 12.34, cycleSpend: null, remaining: 12.34, exact: false });
  assert.equal(remainingFrom({ total: { val: '-1234' } }, { coreInvoice: {} }).exact, false);
});

test('an overdrawn or exhausted balance reads as nothing left, never negative', () => {
  assert.equal(remainingFrom({ total: { val: '250' } }, null).remaining, 0);
  assert.equal(remainingFrom({ total: { val: '-100' } }, { coreInvoice: { prepaidCreditsUsed: { val: '400' } } }).remaining, 0);
});

test('an unreadable balance is null, not a guess', () => {
  assert.equal(remainingFrom({}, null), null);
  assert.equal(remainingFrom({ total: { val: 'abc' } }, null), null);
  assert.equal(remainingFrom(null, null), null);
});
