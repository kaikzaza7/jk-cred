import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../supabase/functions/acesso-cliente/handler.mjs';

function fixture(overrides = {}) {
  const logs = [], calls = [], delivery = {};
  const config = { SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'public-test', SUPABASE_SERVICE_ROLE_KEY: 'secret-test', SITE_URL: 'https://app.test' };
  const results = { rate: { data: true }, profile: { data: { email: 'private@example.test', status: 'ativo' } }, delete: {}, ...overrides };
  const admin = { rpc: async (name, params) => { calls.push('rate'); delivery.rate = { name, params }; return results.rate; }, from(table) {
    let operation;
    const query = {};
    for (const method of ['select', 'eq', 'gte', 'lt', 'insert', 'delete', 'maybeSingle']) query[method] = (...args) => {
      if (method === 'select') operation = table === 'profiles' ? 'profile' : 'count';
      if (method === 'insert' || method === 'delete') operation = method;
      calls.push(method);
      return query;
    };
    query.then = (resolve, reject) => Promise.resolve(results[operation]).then(resolve, reject);
    return query;
  } };
  const auth = {
    signInWithPassword: async () => { calls.push('login'); if (results.throwAuth) throw new Error('private password'); return results.auth || { data: { session: { access_token: 'access-test', refresh_token: 'refresh-test' } } }; },
    resetPasswordForEmail: async (email, options) => { calls.push('recover'); delivery.options = options; return results.recovery || {}; }
  };
  const handler = createHandler({ env: name => overrides.noConfig ? undefined : config[name], createClient: (url, key) => key === 'secret-test' ? admin : { auth }, logger: { error: (...args) => logs.push(args) }, uuid: () => 'request-test' });
  return { handler, logs, calls, delivery };
}
const request = (body = { action: 'login', phone: '79999999999', password: 'synthetic-test' }) => new Request('https://example.test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('invalid JSON shape, unknown action, phone and method return controlled errors', async () => {
  const { handler, calls } = fixture();
  for (const body of [null, [], 1, { action: 'delete', phone: '79999999999' }, { phone: '1' }, { phone: 79999999999 }]) assert.equal((await handler(request(body))).status, 400);
  assert.equal((await handler(new Request('https://example.test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }))).status, 400);
  assert.equal((await handler(new Request('https://example.test'))).status, 405);
  assert.equal((await handler(new Request('https://example.test', { method: 'OPTIONS' }))).status, 200);
  assert.equal(calls.length, 0);
});
test('configuration, atomic rate-limit and profile errors fail closed', async () => {
  for (const override of [{ noConfig: true }, { rate: { error: { message: 'private SQL' } } }, { rate: { data: null } }, { profile: { error: {} } }, { throwAuth: true }]) {
    const { handler, logs } = fixture(override);
    const response = await handler(request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), override.noConfig ? null : 'https://app.test');
    assert.equal(response.headers.get('x-request-id'), 'request-test');
    assert.doesNotMatch(await response.text(), /private|SQL|secret-test/);
    assert.doesNotMatch(JSON.stringify(logs), /private|79999999999|synthetic-test|secret-test/);
  }
});
test('rate limited request never attempts auth', async () => {
  const { handler, calls } = fixture({ rate: { data: false } });
  assert.equal((await handler(request())).status, 429);
  assert.ok(!calls.includes('login'));
});
test('upstream auth failure differs from incorrect credentials', async () => {
  for (const [auth, status] of [[{ error: { status: 503 } }, 503], [{ error: { status: 400, code: 'invalid_credentials' } }, 401], [{ error: { status: 403, code: 'email_not_confirmed' } }, 403], [{ error: { status: 429 } }, 429]]) {
    const { handler } = fixture({ auth });
    assert.equal((await handler(request())).status, status);
  }
});
test('recovery response does not disclose existence or delivery failure', async () => {
  const responses = [];
  for (const override of [{ profile: { data: null } }, {}, { recovery: { error: { message: 'SMTP private' } } }]) {
    const { handler, logs } = fixture(override);
    const response = await handler(request({ action: 'recuperar', phone: '79999999999' }));
    assert.equal(response.status, 200);
    responses.push(await response.json());
    if (override.recovery) assert.ok(logs.length > 0);
  }
  assert.deepEqual(responses[0], responses[1]);
  assert.deepEqual(responses[1], responses[2]);
});
test('recovery redirects only to server-configured site, ignoring caller-supplied destination', async () => {
  const { handler, delivery } = fixture();
  const response = await handler(request({ action: 'recuperar', phone: '79999999999', redirect_to: 'https://untrusted.example' }));
  assert.equal(response.status, 200);
  assert.equal(delivery.options.redirectTo, 'https://app.test/#/redefinir-senha');
});


test('rejects unapproved origins, wrong content type and oversized bodies before touching auth', async () => {
  const { handler, calls } = fixture();
  const badOrigin = new Request('https://example.test', { method:'OPTIONS', headers:{ Origin:'https://evil.test' } });
  const blocked = await handler(badOrigin);
  assert.equal(blocked.status,403);
  assert.equal(blocked.headers.get('Access-Control-Allow-Origin'),null);
  const allowed = await handler(new Request('https://example.test',{method:'OPTIONS',headers:{Origin:'https://app.test'}}));
  assert.equal(allowed.status,200);
  assert.equal(allowed.headers.get('Vary'),'Origin');
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'),'https://app.test');
  assert.equal((await handler(new Request('https://example.test',{method:'POST',body:'{}'}))).status,415);
  const oversized = new Request('https://example.test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:'79999999999',password:'x'.repeat(5000)})});
  assert.equal((await handler(oversized)).status,413);
  assert.equal((await handler(request({phone:'79999999999',password:'x'.repeat(257)}))).status,401);
  assert.equal(calls.length,0);
});

test('uses one atomic RPC with keyed hashes and never resets the bucket on successful login', async () => {
  const { handler, calls, delivery } = fixture();
  assert.equal((await handler(request())).status,200);
  assert.equal(delivery.rate.name,'consume_auth_attempt');
  assert.match(delivery.rate.params.p_phone_hash,/^[a-f0-9]{64}$/);
  const plain = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('tel:79999999999')))).map(x=>x.toString(16).padStart(2,'0')).join('');
  assert.notEqual(delivery.rate.params.p_phone_hash,plain);
  assert.equal(calls.filter(x=>x==='rate').length,1);
  assert.equal(calls.filter(x=>x==='delete').length,0); // Retention runs inside the atomic RPC.
});
