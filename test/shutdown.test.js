'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createShutdown } = require('../lib/shutdown.js');

function listen(handler) {
  return new Promise(function (resolve) {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', function () { resolve({ server: server, port: server.address().port }); });
  });
}

function get(port, path) {
  return new Promise(function (resolve, reject) {
    http.get({ host: '127.0.0.1', port: port, path: path, agent: false }, function (res) {
      let body = '';
      res.on('data', function (c) { body += c; });
      res.on('end', function () { resolve({ status: res.statusCode, body: body }); });
    }).on('error', reject);
  });
}

test('a request in flight finishes, new ones are refused, and the exit code is 0', async () => {
  const { server, port } = await listen(function (req, res) {
    // A slow request, like a picture being made.
    setTimeout(function () { res.end('picture'); }, 250);
  });
  const codes = [];
  const lines = [];
  const stopped = new Promise(function (resolve) {
    const shutdown = createShutdown(server, { graceMs: 5000, log: (l) => lines.push(l), exit: (c) => { codes.push(c); resolve(); } });
    const slow = get(port, '/slow');
    setTimeout(async function () {
      shutdown('SIGTERM');
      shutdown('SIGTERM');   // a second signal must not start a second shutdown
      await assert.rejects(get(port, '/late'));
      const done = await slow;
      assert.equal(done.body, 'picture');
    }, 60);
  });
  await stopped;
  assert.deepEqual(codes, [0]);
  assert.match(lines[lines.length - 1], /stopped cleanly/);
});

test('a request that never ends cannot hold the process past the grace period', async () => {
  const { server } = await listen(function () { /* never answers */ });
  const port = server.address().port;
  const started = Date.now();
  const code = await new Promise(function (resolve) {
    const shutdown = createShutdown(server, { graceMs: 150, exit: resolve });
    const req = http.get({ host: '127.0.0.1', port: port, path: '/hang', agent: false });
    req.on('error', function () { /* torn down below */ });
    setTimeout(function () { shutdown('SIGTERM'); }, 40);
    setTimeout(function () { req.destroy(); }, 600);
  });
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 550, 'it stopped at the grace period, not when the request ended');
  server.closeAllConnections();
});

test('an idle keep-alive connection does not delay stopping', async () => {
  const { server, port } = await listen(function (req, res) { res.end('ok'); });
  const agent = new http.Agent({ keepAlive: true });
  await new Promise(function (resolve, reject) {
    http.get({ host: '127.0.0.1', port: port, path: '/', agent: agent }, function (res) { res.resume(); res.on('end', resolve); }).on('error', reject);
  });
  const started = Date.now();
  const code = await new Promise(function (resolve) { createShutdown(server, { graceMs: 5000, exit: resolve })('SIGTERM'); });
  agent.destroy();
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 1500, 'the idle connection was dropped rather than waited for');
});
