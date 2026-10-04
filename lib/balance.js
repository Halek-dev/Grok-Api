'use strict';

/**
 * Reading xAI's prepaid credit balance. Pure: no I/O.
 *
 * The figures come from xAI's Management API, which is a different service
 * from the one that makes images and needs its own key:
 *
 *   GET /v1/billing/teams/{team}/postpaid/invoice/preview   what is left
 *   GET /v1/billing/teams/{team}/prepaid/balance            what was bought
 *
 * Every amount is a string of USD cents inside { val }, kept from xAI's side
 * of the account, so credit the team holds is NEGATIVE: $51.70 reads "-5170".
 *
 * What is left is read from the invoice preview, from two fields:
 *
 *   coreInvoice.prepaidCredits      the credit held at the START of the
 *                                   current billing cycle
 *   coreInvoice.prepaidCreditsUsed  what this cycle has used of it so far —
 *                                   the sum of the invoice's lines
 *
 * left = -prepaidCredits - |prepaidCreditsUsed|. Both are negative on xAI's
 * side; the second is taken by magnitude in case that ever changes.
 *
 * Neither field alone is the answer, and the prepaid ledger's `total` is not
 * either. Measured against the real account:
 *
 *   2 October 2026, console "Credits remaining $51.70":
 *     prepaid/balance   total -7500, two PURCHASE entries, no SPEND entries —
 *                       a month of use never posted to it. Purchases only.
 *     invoice/preview   prepaidCredits -5170, prepaidCreditsUsed 0.
 *     The first version read the ledger and showed $75.00.
 *
 *   4 October 2026, after two days of work:
 *     invoice/preview   prepaidCredits still -5170, prepaidCreditsUsed -1176,
 *                       ten lines summing to 1176 cents.
 *     The second version read prepaidCredits alone and sat on $51.70 while
 *     $11.76 was being spent: on 2 October the cycle had no spend yet, so
 *     the opening credit and the live credit happened to agree.
 *
 * The ledger is used only to say how much was bought, and from that how much
 * has been used in all. If the preview cannot be read there is no trustworthy
 * "left" to show, and none is shown: a wrong balance is worse than no balance.
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

function remainingFrom(previewJson, ledgerJson) {
  const core = previewJson && previewJson.coreInvoice;
  const held = core ? cents(core.prepaidCredits) : null;
  if (held === null) return null;
  // Spent so far this cycle. Missing reads as nothing spent — the field is
  // absent only before the cycle has any lines.
  const usedCycle = core ? cents(core.prepaidCreditsUsed) : null;
  // Negative means credit in hand. Zero or above means none is left.
  const remaining = Math.max(0, -held - Math.abs(usedCycle === null ? 0 : usedCycle));

  // Optional, and only for context: the total ever bought, and so the total
  // ever used. Left out rather than guessed if the ledger cannot be read or
  // would give a nonsense answer (less bought than is left).
  const total = cents(ledgerJson && ledgerJson.total);
  const purchased = total === null ? null : -total;
  const sane = purchased !== null && purchased >= remaining;

  return {
    remaining: usd(remaining),
    purchased: sane ? usd(purchased) : null,
    used: sane ? usd(purchased - remaining) : null
  };
}

module.exports = { remainingFrom: remainingFrom };
