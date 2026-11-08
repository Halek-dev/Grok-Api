'use strict';

// A project's budget is a ceiling the server holds, whatever the page asked.
// Boots the real server on a scratch data folder holding a project with a
// budget and a usage log that has spent most of it; nothing upstream is
// reachable, so a request that passes the budget fails later as a network
// error — which is the proof that it was let through.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');
const PROJECT = 'p-0123456789ab';
const OTHER = 'p-fedcba987654';

function makeData(dir) {
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({
    projects: [
      { id: PROJECT, name: 'Tight', slug: 'tight', createdAt: '2026-11-01T00:00:00Z', archived: false, defaults: null, references: [], budget: 0.1 },
      { id: OTHER, name: 'Loose', slug: 'loose', createdAt: '2026-11-01T00:00:00Z', archived: false, defaults: null, references: [], budget: null }
    ],
    placements: {}
  }));
  // $0.08 already spent in Tight: one more $0.04 picture would pass $0.10.
  const id = 'a'.repeat(32) + '.png';
  fs.writeFileSync(path.join(dir, 'images', id), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(dir, 'usage.jsonl'), JSON.stringify({
    timestamp: '2026-11-05T10:00:00.000Z', runId: 'r1', user: 'A', mode: 'generate', model: 'grok-imagine-image-2.0',
    project: PROJECT, cost: 0.08, images: 2, files: [{ id: id, frame: 1 }]
  }) + '\n');
}

function start(dir, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: Object.assign({}, process.env, {
        XAI_API_KEY: 'test', TEAM_PASSWORD: '', HOST: '127.0.0.1', PORT: '0', DATA_DIR: dir,
        XAI_BASE_URL: 'http://127.0.0.1:9/v1', UPSTREAM_TIMEOUT_MS: '3000', MAX_STORED_IMAGES: '0'
      }, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const onData = (c) => {
      out += c;
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve({ child: child, base: 'http://127.0.0.1:' + m[1], log: () => out });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error('server exited ' + code + '\n' + out)));
    setTimeout(() => reject(new Error('server did not start\n' + out)), 10000).unref();
  });
}

async function picture(base, project, extra) {
  const res = await fetch(base + '/api/images', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ mode: 'generate', model: 'grok-imagine-image-2.0', prompt: 'a quiet harbour', resolution: '1k', n: 1, project: project }, extra || {}))
  });
  return { status: res.status, body: await res.json() };
}

test('a picture that would pass the budget is refused before anything is sent; another project is let through', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagine-budget-'));
  makeData(dir);
  const { child, base, log } = await start(dir);
  try {
    const refused = await picture(base, PROJECT);
    assert.equal(refused.status, 402);
    assert.equal(refused.body.code, 'budget_reached');
    assert.equal(refused.body.budget, 0.1);
    assert.equal(refused.body.spent, 0.08);
    assert.match(refused.body.error, /Tight/);
    assert.match(refused.body.error, /\$0\.10/);
    assert.match(log(), /\[xai-fail\].*code=budget_reached/);

    // The card's figures.
    const projects = await fetch(base + '/api/projects').then((r) => r.json());
    const tight = projects.projects.find((p) => p.id === PROJECT);
    assert.equal(tight.budget, 0.1);
    assert.equal(tight.spent, 0.08);

    // Same picture, a project with no budget: reaches upstream (which is not
    // there), so a network failure, not a budget refusal.
    const passed = await picture(base, OTHER);
    assert.equal(passed.status, 504);
    assert.equal(passed.body.code, 'network');

    // Raise the budget and the same picture goes through.
    const raised = await fetch(base + '/api/projects/budget', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: PROJECT, budget: 1 })
    }).then((r) => r.json());
    assert.equal(raised.project.budget, 1);
    const after = await picture(base, PROJECT);
    assert.equal(after.body.code, 'network');

    // Remove it: nonsense reads as none.
    const removed = await fetch(base + '/api/projects/budget', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: PROJECT, budget: 'lots' })
    }).then((r) => r.json());
    assert.equal(removed.project.budget, null);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Google\'s monthly allowance: a picture past it is refused, the money card says where the month stands', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imagine-allowance-'));
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  const month = new Date().toISOString().slice(0, 7);
  fs.writeFileSync(path.join(dir, 'usage.jsonl'), JSON.stringify({
    timestamp: month + '-01T00:10:00.000Z', runId: 'g1', mode: 'generate', model: 'gemini-3-pro-image', provider: 'google',
    cost: 0.17, images: 1, files: []
  }) + '\n');
  const { child, base } = await start(dir, { GOOGLE_API_KEY: 'test-google', GOOGLE_BASE_URL: 'http://127.0.0.1:9', GOOGLE_MONTHLY_ALLOWANCE: '0.2' });
  try {
    const money = await fetch(base + '/api/balance').then((r) => r.json());
    assert.equal(money.google.enabled, true);
    assert.equal(money.google.spentMonth, 0.17);
    assert.equal(money.google.allowance, 0.2);
    assert.equal(money.google.left, 0.03);
    assert.equal(money.google.low, true);

    // $0.17 + a $0.134 picture passes $0.20.
    const refused = await fetch(base + '/api/images', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'generate', model: 'gemini-3-pro-image', prompt: 'a quiet harbour', resolution: '1k', n: 1 })
    });
    assert.equal(refused.status, 402);
    const body = await refused.json();
    assert.equal(body.code, 'allowance_reached');
    assert.equal(body.engine, 'google');
    assert.match(body.error, /\$0\.17 of \$0\.20/);

    // xAI is untouched by Google's line: it reaches upstream (not there).
    const xai = await fetch(base + '/api/images', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'generate', model: 'grok-imagine-image-2.0', prompt: 'a quiet harbour', resolution: '1k', n: 1 })
    }).then((r) => r.json());
    assert.equal(xai.code, 'network');
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
