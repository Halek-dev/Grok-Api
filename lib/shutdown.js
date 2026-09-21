'use strict';

/**
 * Stopping cleanly.
 *
 * A host that redeploys — Railway on every push, every changed variable —
 * stops the old container by sending SIGTERM. With no handler the process dies
 * abruptly, npm reports "command failed", and the host files the deploy as
 * CRASHED although nothing went wrong. Worse, a picture that was being made at
 * that moment is cut off after it has been paid for.
 *
 * So: on the signal, stop taking new connections, let requests already in
 * flight finish, then exit 0. If they have not finished within the grace
 * period, exit anyway — the host will kill the process regardless, and a clean
 * code is still the truthful one: it was asked to stop, and it stopped.
 *
 * Takes the server and its surroundings as arguments so it can be tested
 * without sending real signals.
 */
function createShutdown(server, opts) {
  opts = opts || {};
  const graceMs = opts.graceMs == null ? 25000 : opts.graceMs;
  const log = opts.log || function () {};
  const exit = opts.exit || process.exit;
  let stopping = false;

  return function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    log('[server] ' + signal + ' received — finishing requests in flight, then stopping');

    const timer = setTimeout(function () {
      log('[server] still busy after ' + Math.round(graceMs / 1000) + 's — stopping now');
      exit(0);
    }, graceMs);
    if (timer.unref) timer.unref();

    // No new connections; the callback fires once every open one has ended.
    server.close(function () {
      clearTimeout(timer);
      log('[server] stopped cleanly');
      exit(0);
    });
    // Browsers hold idle keep-alive connections open for minutes, and close()
    // waits for those too. Drop the idle ones; the busy ones are left alone.
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  };
}

module.exports = { createShutdown: createShutdown };
