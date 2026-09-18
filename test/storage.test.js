'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveStorage } = require('../lib/storage.js');

const ROOT = path.resolve('/app');
const env = (vars) => (name) => vars[name];

test('on a laptop the project folder is used and nothing is flagged', () => {
  const s = resolveStorage(env({}), ROOT);
  assert.equal(s.dir, ROOT);
  assert.equal(s.source, 'project folder');
  assert.equal(s.ephemeral, false);
});

test('an attached Railway volume is used without setting any variable', () => {
  const s = resolveStorage(env({ RAILWAY_ENVIRONMENT: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/data' }), ROOT);
  assert.equal(s.dir, path.resolve('/data'));
  assert.equal(s.source, 'Railway volume');
  assert.equal(s.ephemeral, false);
});

test('on Railway with no volume the history is flagged as lost on every deploy', () => {
  const s = resolveStorage(env({ RAILWAY_PROJECT_ID: 'abc' }), ROOT);
  assert.equal(s.dir, ROOT);
  assert.equal(s.ephemeral, true);
  assert.match(s.why, /no volume/);
});

test('an explicit DATA_DIR wins, and is fine when it sits inside the volume', () => {
  const s = resolveStorage(env({ RAILWAY_ENVIRONMENT: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/data', DATA_DIR: '/data/studio' }), ROOT);
  assert.equal(s.dir, path.resolve('/data/studio'));
  assert.equal(s.source, 'DATA_DIR');
  assert.equal(s.ephemeral, false);
});

test('a DATA_DIR outside the attached volume is flagged: the volume is going unused', () => {
  const s = resolveStorage(env({ RAILWAY_ENVIRONMENT: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/data', DATA_DIR: '/app/storage' }), ROOT);
  assert.equal(s.ephemeral, true);
  assert.match(s.why, /not inside the attached volume/);
  // A sibling folder that merely shares a prefix is not "inside".
  const t = resolveStorage(env({ RAILWAY_ENVIRONMENT: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/data', DATA_DIR: '/database' }), ROOT);
  assert.equal(t.ephemeral, true);
});

test('blank variables count as unset', () => {
  const s = resolveStorage(env({ DATA_DIR: '  ', RAILWAY_VOLUME_MOUNT_PATH: '' }), ROOT);
  assert.equal(s.source, 'project folder');
});
