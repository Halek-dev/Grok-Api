'use strict';

// The gallery is paged from the usage log. These tests boot the real server
// on a scratch data folder and check that a page is a page of pictures that
// still exist — deleting the newest runs must never hide the older ones.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const SERVER = path.join(__dirname, '..', 'server.js');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// Eighty one-picture runs, oldest first, then the pictures of most of the
// newest forty deleted — the way a team clears what it does not like.
function makeData(dir) {
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  const ids = [];
  const lines = [];
  for (let i = 0; i < 80; i++) {
    const id = crypto.randomBytes(16).toString('hex') + '.png';
    ids.push(id);
    fs.writeFileSync(path.join(dir, 'images', id), PNG);
    lines.push(JSON.stringify({
      timestamp: new Date(Date.UTC(2026, 9, 4, 8, 0, i)).toISOString(), runId: 'run-' + i, user: 'A',
      mode: 'generate', model: 'grok-imagine-image-2.0', prompt: 'picture ' + i, cost: 0.04, images: 1,
      files: [{ id: id, frame: 1 }]
    }));
  }
  fs.writeFileSync(path.join(dir, 'usage.jsonl'), lines.join('\n') + '\n');
  let kept = 80;
  for (let i = 40; i < 80; i++) if (i % 8 !== 0) { fs.unlinkSync(path.join(dir, 'images', ids[i])); kept--; }
  return kept;
}

function start(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: Object.assign({}, process.env, {
        XAI_API_KEY: 'test', TEAM_PASSWORD: '', HOST: '127.0.0.1', PORT: '0', DATA_DIR: dir, MAX_STORED_IMAGES: '0'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const onData = (c) => {
      out += c;
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve({ child: child, base: 'http://127.0.0.1:' + m[1] });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error('server exited ' + code + '\n' + out)));
    setTimeout(() => reject(new Error('server did not start\n' + out)), 10000).unref();
  });
}

async function page(base, query) {
  const res = await fetch(base + '/api/runs?' + query);
  assert.equal(res.status, 200);
  return res.json();
}

test('a page of the gallery is a page of pictures that exist, and older ones stay reachable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagine-gallery-'));
  const onDisk = makeData(dir);
  const { child, base } = await start(dir);
  try {
    const first = await page(base, 'limit=40');
    // Forty living runs, not the forty newest log lines with the dead ones removed.
    assert.equal(first.runs.length, 40);
    assert.equal(first.more, true);
    for (const run of first.runs) assert.equal(run.images.length, 1);

    const oldest = first.runs[first.runs.length - 1].timestamp;
    const second = await page(base, 'limit=40&before=' + encodeURIComponent(oldest));
    assert.equal(second.runs.length, onDisk - 40);
    assert.equal(second.more, false);

    // Every picture on disk is reachable through the two pages, none twice.
    const seen = new Set(first.runs.concat(second.runs).map((r) => r.images[0].id));
    assert.equal(seen.size, onDisk);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
