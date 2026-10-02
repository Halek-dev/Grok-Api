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
 * What is left is `coreInvoice.prepaidCredits` in the invoice preview. That
 * is the live figure, the one the console shows as "Credits remaining".
 *
 * It is NOT the prepaid ledger's `total`. The first version of this file used
 * that, on the strength of the documentation, and showed $75.00 while the
 * console said $51.70. Measured against the real account on 2 October 2026:
 *
 *   prepaid/balance   total -7500, two PURCHASE entries (-2000, -5500), no
 *                     SPEND entries at all — a month of use had not been
 *                     posted to it. It is the sum of what was bought.
 *   invoice/preview   prepaidCredits -5170 (the console's figure, to the cent),
 *                     prepaidCreditsUsed 0 even with spend in the cycle.
 *
 * So the ledger is used only to say how much was bought, and from that how
 * much has been used. If the preview cannot be read there is no trustworthy
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
  // Negative means credit in hand. Zero or above means none is left.
  const remaining = Math.max(0, -held);

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
