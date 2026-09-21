'use strict';

/**
 * Reading xAI's prepaid credit balance. Pure: no I/O.
 *
 * The figures come from xAI's Management API, which is a different service
 * from the one that makes images and needs its own key:
 *
 *   GET /v1/billing/teams/{team}/prepaid/balance          the ledger
 *   GET /v1/billing/teams/{team}/postpaid/invoice/preview  this billing cycle
 *
 * Every amount is a string of USD cents inside { val }. Two things are not
 * obvious and both matter:
 *
 *   The ledger is kept from xAI's side, so credit you hold is NEGATIVE: a $10
 *   top-up reads "-1000". What remains is the total, negated.
 *
 *   Spend is posted to the ledger when a billing cycle closes, not as it
 *   happens. Mid-cycle the ledger still shows credit that has already been
 *   used, so this cycle's prepaid use (from the invoice preview) is taken off
 *   to get the figure the console shows.
 */
function cents(node) {
  const raw = node && typeof node === 'object' ? node.val : node;
  // Number(null) and Number('') are 0, and a missing balance must never read
  // as "nothing left" — it is unknown.
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function usd(c) {
  return Math.round(c) / 100;
}

function remainingFrom(balanceJson, previewJson) {
  const total = cents(balanceJson && balanceJson.total);
  if (total === null) return null;
  const ledger = -total;

  // Absent or unreadable preview: report the ledger alone and say so, rather
  // than presenting a figure that may be too generous as if it were exact.
  const core = previewJson && previewJson.coreInvoice;
  const used = core ? cents(core.prepaidCreditsUsed) : null;
  const cycleSpend = used === null ? null : Math.abs(used);

  return {
    ledger: usd(ledger),
    cycleSpend: cycleSpend === null ? null : usd(cycleSpend),
    remaining: usd(Math.max(0, ledger - (cycleSpend || 0))),
    // False when this cycle's spend could not be read, so the amount may be
    // higher than what is really left.
    exact: cycleSpend !== null
  };
}

module.exports = { remainingFrom: remainingFrom };
