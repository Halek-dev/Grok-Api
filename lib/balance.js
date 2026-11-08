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

// ---------------------------------------------------------------------------
// Google has no balance to read: it is pay-as-you-go on the card behind the
// Google Cloud project, invoiced monthly. What the studio can know exactly is
// what it has sent, from its own usage log; what the team can decide is an
// allowance for the month. Together they give the one thing a balance is for:
// knowing when to stop.
// ---------------------------------------------------------------------------

// Dollars to the cent. (usd() above is for xAI's cents; these are dollars.)
function cents2(x) { return Math.round(x * 100) / 100; }

// The usage rows that were Google's. Lines from before `provider` was
// recorded are told by the model's name.
function isGoogleRow(r) {
  if (!r) return false;
  if (r.provider) return r.provider === 'google';
  return typeof r.model === 'string' && /^gemini-/.test(r.model);
}

// Spend by an engine this UTC month and this UTC day — the month is what the
// card is charged for.
function engineSpend(rows, provider, now) {
  const at = now instanceof Date ? now : new Date();
  const monthStart = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
  const dayStart = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  let month = 0, today = 0;
  for (const r of rows || []) {
    // A row with no provider is xAI's unless its model says Google.
    const mine = provider === 'google' ? isGoogleRow(r) : Boolean(r && !isGoogleRow(r) && (r.provider || 'xai') === provider);
    if (!mine) continue;
    const t = Date.parse(r.timestamp);
    const cost = typeof r.cost === 'number' ? r.cost : 0;
    if (Number.isNaN(t) || t < monthStart) continue;
    month += cost;
    if (t >= dayStart) today += cost;
  }
  return { month: cents2(month), today: cents2(today) };
}

// Where the month stands against the allowance. "Low" is the last fifth —
// or the last five dollars, for an allowance big enough that five dollars is
// less than a fifth; a small allowance is not low before a cent is spent.
// "Out" is the line reached.
function allowanceState(spentMonth, allowance) {
  if (!(allowance > 0)) return { allowance: null, left: null, fraction: null, low: false, out: false };
  const left = Math.max(0, cents2(allowance - spentMonth));
  const fraction = Math.min(1, spentMonth / allowance);
  const lowLine = Math.min(5, allowance * 0.2);
  return { allowance: cents2(allowance), left: left, fraction: Math.round(fraction * 1000) / 1000, low: left > 0 && (fraction >= 0.8 || left < lowLine), out: left <= 0 };
}

module.exports = { remainingFrom: remainingFrom, engineSpend: engineSpend, allowanceState: allowanceState, isGoogleRow: isGoogleRow };
