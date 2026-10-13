const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('development preview serves public files only and forbids HTTP writes', async () => {
  const child = spawn(process.execPath, ['scripts/dev-server.js'], { env: { ...process.env, JK_DEV_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [chunk] = await once(child.stdout, 'data');
    const base = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
    const page = await fetch(base);
    assert.match(await page.text(), /app\.js/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    for (const [name,value] of Object.entries(require('../scripts/security-headers'))) assert.equal(page.headers.get(name),value);
    assert.equal(page.headers.get('x-frame-options'),'DENY');
    const head = await fetch(base, { method: 'HEAD' });
    assert.equal(await head.text(), '');
    assert.equal((await fetch(base, { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/.env.local')).status, 404);
    assert.equal((await fetch(base + '/%2e%2e%5cpackage.json')).status, 403);
  } finally { child.kill(); await once(child, 'exit'); }
});
