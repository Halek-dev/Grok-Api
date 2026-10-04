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

// The same account on 4 October 2026, two days into the cycle: the opening
// credit is unchanged and the cycle's spend sits in prepaidCreditsUsed, which
// equals the sum of the invoice lines (1176 cents). The console at that moment
// read $39.94. Reading prepaidCredits alone showed $51.70 while money was going.
const REAL_PREVIEW_MID_CYCLE = {
  coreInvoice: {
    lines: [
      { description: 'API grok-imagine-image-2.0', unitType: 'Generated image', numUnits: '9', amount: '72' },
      { description: 'API grok-imagine-image-2.0', unitType: 'Image edit input images', numUnits: '9', amount: '9' },
      { description: 'API grok-imagine-image-quality', unitType: 'Generated image', numUnits: '1', amount: '5' },
      { description: 'API grok-imagine-image-quality', unitType: 'Generated image', numUnits: '23', amount: '161' },
      { description: 'API grok-imagine-image-quality', unitType: 'Image edit input images', numUnits: '27', amount: '27' },
      { description: 'API grok-imagine-image-2.0', unitType: 'Generated image', numUnits: '43', amount: '344' },
      { description: 'API grok-imagine-image-2.0', unitType: 'Image edit input images', numUnits: '46', amount: '46' },
      { description: 'API grok-imagine-image-quality', unitType: 'Generated image', numUnits: '5', amount: '25' },
      { description: 'API grok-imagine-image-quality', unitType: 'Generated image', numUnits: '59', amount: '413' },
      { description: 'API grok-imagine-image-quality', unitType: 'Image edit input images', numUnits: '74', amount: '74' }
    ],
    totalWithCorr: { val: '1176' },
    prepaidCredits: { val: '-5170' },
    prepaidCreditsUsed: { val: '-1176' }
  },
  billingCycle: { year: 2026, month: 10 }
};

test('mid-cycle: the spend so far this cycle comes off the opening credit — $39.94, not $51.70', () => {
  const lines = REAL_PREVIEW_MID_CYCLE.coreInvoice.lines.reduce((n, l) => n + Number(l.amount), 0);
  assert.equal(lines, 1176);
  assert.deepEqual(remainingFrom(REAL_PREVIEW_MID_CYCLE, REAL_LEDGER), { remaining: 39.94, purchased: 75, used: 35.06 });
  // The sign of prepaidCreditsUsed is not trusted: a positive one means the same.
  const flipped = JSON.parse(JSON.stringify(REAL_PREVIEW_MID_CYCLE));
  flipped.coreInvoice.prepaidCreditsUsed = { val: '1176' };
  assert.equal(remainingFrom(flipped, null).remaining, 39.94);
  // More used than held: nothing left, never negative.
  flipped.coreInvoice.prepaidCreditsUsed = { val: '-9999' };
  assert.equal(remainingFrom(flipped, null).remaining, 0);
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

test('at the start of a cycle nothing has been used yet, so the opening credit is the live figure', () => {
  // 2 October: prepaidCreditsUsed 0. A missing field reads the same way.
  const p = JSON.parse(JSON.stringify(REAL_PREVIEW));
  delete p.coreInvoice.prepaidCreditsUsed;
  assert.equal(remainingFrom(p, REAL_LEDGER).remaining, 51.7);
  p.coreInvoice.prepaidCreditsUsed = { val: '' };
  assert.equal(remainingFrom(p, REAL_LEDGER).remaining, 51.7);
});
