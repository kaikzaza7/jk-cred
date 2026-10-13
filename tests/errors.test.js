const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const E = require('../public/errors.js');

test('database/auth errors become safe messages without raw SQL or credentials', () => {
  for (const [error, code] of [
    [{ code: '23505', message: 'secret@example.test SQL' }, 'CONFLICT'],
    [{ code: '42501' }, 'FORBIDDEN'], [{ status: 401 }, 'SESSION'],
    [{ status: 429 }, 'RATE_LIMIT'], [{ status: 503 }, 'UNAVAILABLE'],
    [{ code: '23514' }, 'VALIDATION'], [{ code: 'PGRST116' }, 'NOT_FOUND'],
    [new Error('<script>secret</script>'), 'UNEXPECTED']
  ]) {
    const safe = E.normalize(error);
    assert.equal(safe.code, code);
    assert.doesNotMatch(safe.message, /secret|script|SQL/);
  }
});
test('deadline aborts reads and warns about unconfirmed writes without retries', async () => {
  let calls = 0;
  const fetch = E.createFetch((url, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  }, 5);
  await assert.rejects(fetch('https://example.test'), { code: 'TIMEOUT' });
  await assert.rejects(fetch('https://example.test', { method: 'POST' }), { code: 'WRITE_UNCONFIRMED' });
  assert.equal(calls, 2);
});
test('response body is also subject to deadline; empty 204 is preserved', async () => {
  const fetch = E.createFetch(async (url, { signal }) => ({
    arrayBuffer: () => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
  }), 5);
  await assert.rejects(fetch('https://example.test'), { code: 'TIMEOUT' });
  assert.equal((await E.createFetch(async () => new Response(null, { status: 204 }))('https://example.test')).status, 204);
});
test('network failure in PostgREST error wrapper retains ambiguous-write message', () => {
  const error = E.normalize({ message: 'AppError: ' + new E.AppError('WRITE_UNCONFIRMED').message });
  assert.equal(error.code, 'WRITE_UNCONFIRMED');
});
test('JSON request preserves safe backend codes and rejects malformed responses', async () => {
  const original = E.fetch;
  try {
    E.fetch = async () => new Response(JSON.stringify({ code: 'INVALID_CREDENTIALS', error: 'private' }), { status: 401 });
    await assert.rejects(E.requestJson('https://example.test'), { code: 'INVALID_CREDENTIALS' });
    E.fetch = async () => new Response('<html>private</html>');
    await assert.rejects(E.requestJson('https://example.test'), { code: 'INVALID_RESPONSE' });
    E.fetch = async () => new Response('<html>private</html>', { status: 503 });
    await assert.rejects(E.requestJson('https://example.test'), { code: 'UNAVAILABLE' });
  } finally { E.fetch = original; }
});
test('duplicate submit is blocked; form state is restored after failure', async () => {
  let release, calls = 0;
  const attributes = new Map();
  const buttons = [{ disabled: false }, { disabled: true }];
  const form = { querySelectorAll: () => buttons, getAttribute: key => attributes.get(key), setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key) };
  const first = E.run('test-submit', async () => { calls++; await new Promise(resolve => { release = resolve; }); throw new Error('private'); }, { form });
  assert.equal(attributes.get('aria-busy'), 'true');
  assert.ok(buttons.every(button => button.disabled));
  await E.run('test-submit', () => { calls++; }, { form });
  release(); await first;
  assert.equal(calls, 1);
  assert.deepEqual(buttons.map(button => button.disabled), [false, true]);
  assert.equal(attributes.has('aria-busy'), false);
});
test('external script order and modules parse after extraction', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.indexOf('auth.js') < scripts.indexOf('app.js'));
  assert.ok(scripts.indexOf('repository.js') < scripts.indexOf('app.js'));
  assert.ok(scripts.indexOf('loan-rules.js') < scripts.indexOf('app.js'));
  for (const file of scripts.filter(file => !file.startsWith('https:'))) new vm.Script(fs.readFileSync('public/' + file, 'utf8'));
});
test('safe business errors preserve authorization and conflict categories', () => {
  assert.equal(E.normalize({ status: 400, message: 'JK:permissao_negada' }).code, 'FORBIDDEN');
  assert.equal(E.normalize({ status: 400, message: 'JK:status_conflitante' }).code, 'CONFLICT');
  assert.equal(E.normalize({ code: 'PGRST202' }).code, 'CONFIG');
});
