'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { remainingFrom } = require('../lib/balance.js');

// The real responses for this team on 2 October 2026, amounts only. The xAI
// console showed "Credits remaining $51.70" at the same moment. These are the
// shapes the first version of the formula got wrong: it read the ledger total
// and reported $75.00.
const REAL_PREVIEW = {
  coreInvoice: {
    lines: [],
    amountBeforeVat: '0', amountAfterVat: '0', vatCost: '0',
    amountBeforeVatLimited: { val: '0' }, amountBeforeVatUnlimited: { val: '0' },
    amountBeforeVatLimitedAndUnlimited: { val: '0' },
    autoCreditsIssued: '0', defaultCreditsIssued: '0',
    totalWithCorr: { val: '0' },
    prepaidCredits: { val: '-5170' },
    prepaidCreditsUsed: { val: '0' }
  },
  effectiveSpendingLimit: '0', defaultCredits: '0',
  billingCycle: { year: 2026, month: 10 }
};
const REAL_LEDGER = {
  changes: [
    { changeOrigin: 'PURCHASE', amount: { val: '-5500' }, topupStatus: 'SUCCEEDED' },
    { changeOrigin: 'PURCHASE', amount: { val: '-2000' }, topupStatus: 'SUCCEEDED' }
  ],
  total: { val: '-7500' }
};

test('the real account: $51.70 left, as the console says — not the ledger\'s $75', () => {
  assert.deepEqual(remainingFrom(REAL_PREVIEW, REAL_LEDGER), { remaining: 51.7, purchased: 75, used: 23.3 });
});

test('what is left comes from the preview alone; the ledger only adds context', () => {
  assert.deepEqual(remainingFrom(REAL_PREVIEW, null), { remaining: 51.7, purchased: null, used: null });
  assert.deepEqual(remainingFrom(REAL_PREVIEW, { total: { val: 'abc' } }), { remaining: 51.7, purchased: null, used: null });
});

test('without a readable preview there is no balance — never the ledger as a stand-in', () => {
  assert.equal(remainingFrom(null, REAL_LEDGER), null);
  assert.equal(remainingFrom({}, REAL_LEDGER), null);
  assert.equal(remainingFrom({ coreInvoice: {} }, REAL_LEDGER), null);
  assert.equal(remainingFrom({ coreInvoice: { prepaidCredits: { val: '' } } }, REAL_LEDGER), null);
  assert.equal(remainingFrom({ coreInvoice: { prepaidCredits: null } }, REAL_LEDGER), null);
});

test('credit is negative on xAI\'s side; zero or above means nothing is left', () => {
  const at = (v) => remainingFrom({ coreInvoice: { prepaidCredits: { val: v } } }, null).remaining;
  assert.equal(at('-1'), 0.01);
  assert.equal(at('0'), 0);
  assert.equal(at('250'), 0);
  // A bare string or number is read the same as { val }.
  assert.equal(remainingFrom({ coreInvoice: { prepaidCredits: '-999' } }, null).remaining, 9.99);
});

test('a ledger that says less was bought than is left is not believed', () => {
  const r = remainingFrom(REAL_PREVIEW, { total: { val: '-1000' } });
  assert.deepEqual(r, { remaining: 51.7, purchased: null, used: null });
});

test('prepaidCreditsUsed is not subtracted: prepaidCredits is already the live figure', () => {
  const p = JSON.parse(JSON.stringify(REAL_PREVIEW));
  p.coreInvoice.prepaidCreditsUsed = { val: '179' };
  assert.equal(remainingFrom(p, REAL_LEDGER).remaining, 51.7);
});
