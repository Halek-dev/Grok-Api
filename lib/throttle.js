'use strict';

/**
 * Per-address throttling of failed password attempts.
 *
 * The constant-time comparison in server.js stops timing attacks and nothing
 * else: without this, anyone who can reach the URL can guess without limit,
 * and every accepted guess spends prepaid credits. This is in memory — a
 * restart forgets everything, which is acceptable for a team tool — and has no
 * dependencies. Time is injectable so the tests do not have to wait.
 *
 * Shape: a few free failures, then a delay that doubles on every further
 * failure up to a cap. While an address is delayed every request from it is
 * refused, correct password or not, with the same 401 as a wrong password, so
 * the response never says whether the address is being throttled.
 */
function createThrottle(opts) {
  opts = opts || {};
  const freeFailures = opts.freeFailures == null ? 5 : opts.freeFailures;
  const baseMs = opts.baseMs == null ? 2000 : opts.baseMs;
  const maxMs = opts.maxMs == null ? 15 * 60 * 1000 : opts.maxMs;
  const forgetMs = opts.forgetMs == null ? 60 * 60 * 1000 : opts.forgetMs;
  const now = opts.now || Date.now;
  const entries = new Map();

  function entry(ip) {
    let e = entries.get(ip);
    if (!e) {
      e = { failures: 0, until: 0, last: now() };
      entries.set(ip, e);
    }
    return e;
  }

  return {
    // True while the address must be refused outright.
    isBlocked: function (ip) {
      const e = entries.get(ip);
      return Boolean(e && e.until > now());
    },

    // Record a failed attempt. Returns the failure count and, if this failure
    // starts a lockout, its length in ms (0 otherwise).
    fail: function (ip) {
      const e = entry(ip);
      e.failures += 1;
      e.last = now();
      let delayMs = 0;
      if (e.failures >= freeFailures) {
        delayMs = Math.min(maxMs, baseMs * Math.pow(2, e.failures - freeFailures));
        e.until = now() + delayMs;
      }
      return { failures: e.failures, delayMs: delayMs };
    },

    // A correct password wipes the slate for that address.
    clear: function (ip) {
      entries.delete(ip);
    },

    // Drop addresses that have been quiet long enough that their history no
    // longer matters. Keeps the map from growing forever on a public URL.
    prune: function () {
      const t = now();
      for (const [ip, e] of entries) {
        if (e.until <= t && t - e.last > forgetMs) entries.delete(ip);
      }
    },

    size: function () {
      return entries.size;
    }
  };
}

module.exports = { createThrottle: createThrottle };
