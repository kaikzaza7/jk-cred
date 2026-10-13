import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function harness({ session = null, profile = null, isAdmin = false, loginUser = { id:'user-1' }, request = { session: { access_token: 'access', refresh_token: 'refresh' } }, url = {}, sessionStore = new Map(), setSessionError = null, exchangeError = null } = {}) {
  const calls = { events: [], requests: [], signup: [], setSession: [], passwordLogin: [], updates: [], profileReads: 0, roleReads: 0 };
  let activeUser = session?.user || null;
  let authCallback;
  let submit;
  const form = {
    dataset: {}, elements: { namedItem(name) { return { value: values[name] ?? '', checked: values[name] === true }; } },
    addEventListener(type, fn) { if (type === 'submit') submit = fn; },
    querySelector() { return { textContent: '' }; },
    querySelectorAll() { return []; }, getAttribute() { return null; }, setAttribute() {}, removeAttribute() {}
  };
  const values = {};
  const document = { querySelector() { return form; } };
  const client = {
    auth: {
      onAuthStateChange(fn) { authCallback = fn; return { data: { subscription: { unsubscribe() {} } } }; },
      async getSession() { return { data: { session }, error: null }; },
      async getUser() { return { data: { user: activeUser }, error: null }; },
      async setSession(value) { calls.setSession.push(value); if (setSessionError) return { data:{ session:null }, error:setSessionError }; activeUser = { id: 'u1' }; return { data: { session: { user: activeUser, ...value } }, error: null }; },
      async signInWithPassword(value) { calls.passwordLogin.push(value); activeUser = loginUser; return { data: { session: { user: activeUser } }, error: null }; },
      async signOut() { return { error: null }; },
      async signUp(value) { calls.signup.push(value); return { error: null, data: {} }; },
      async updateUser(value) { calls.updates.push(value); return { error: null }; },
      async exchangeCodeForSession(code) { calls.code = code; return exchangeError ? { data:{ session:null }, error:exchangeError } : { data: { session }, error: null }; }
    },
    from(table) { return { select() { return { eq() { return { async maybeSingle() { calls.profileReads++; return { data: profile, error: null }; } }; } }; } }; },
    async rpc(name) { calls.roleReads++; assert.equal(name, 'is_admin'); return { data: isAdmin, error: null }; }
  };
  class AppError extends Error { constructor(code) { super(code); this.code = code; } }
  const errors = {
    AppError, normalize(error) { return error; }, report(error) { calls.report = error; },
    getClient() { return client; }, async run(_key, work, options) { try { return await work(); } catch (error) { calls.report = error; options?.target && (options.target.textContent = error.message); } },
    async requestJson(url, init, options) { calls.requests.push({ url, init, options }); return request; }
  };
  class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } }
  const storage = { getItem(key) { return sessionStore.get(key) ?? null; }, setItem(key, value) { sessionStore.set(key, String(value)); }, removeItem(key) { sessionStore.delete(key); } };
  const window = { JK_CONFIG: { SUPABASE_URL: 'https://project.example', SUPABASE_ANON_KEY:'anon-test-key' }, sessionStorage:storage, JKErrors: errors, CustomEvent, dispatchEvent(event) { calls.events.push(event); } };
  const location = { hash: '#/', origin: 'https://site.example', pathname: '/', search: '', ...url };
  const history = { replaceState(_state, _title, next) { calls.replacedUrl = next; } };
  const context = { window, JKErrors: errors, document, location, history, URLSearchParams, Promise, Number, String, Math, Date, AbortController, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(new URL('../public/auth.js', import.meta.url), 'utf8'), context);
  return { auth: window.JKAuth, calls, client, form, values, sessionStore, get submit() { return submit; }, get callback() { return authCallback; }, location };
}
async function tick() { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setImmediate(resolve)); }

test('bootstraps identity and authoritative admin role before ready event; admin may lack profile', async () => {
  const h = harness({ session: { user: { id: 'admin-1' } }, profile: null, isAdmin: true });
  await tick();
  assert.equal(h.auth.ready, true);
  assert.equal(h.auth.user.id, 'admin-1');
  assert.equal(h.auth.profile, null);
  assert.equal(h.auth.admin, true);
  assert.equal(h.calls.roleReads, 1);
  assert.equal(h.auth.redirectFor('#/admin'), '#/admin');
  assert.equal(h.auth.redirectFor('#/cliente'), '#/admin');
  assert.ok(h.calls.events.some(event => event.type === 'jk:authchange' && event.detail.ready));
});

test('guards client, admin, and protected subroutes using loaded database role/profile', async () => {
  const client = harness({ session: { user: { id: 'client-1' } }, profile: { id: 'client-1', full_name: 'Teste Cliente', status:'ativo' }, isAdmin: false });
  await tick();
  assert.equal(client.auth.redirectFor('#/cliente/solicitar'), '#/cliente/solicitar');
  assert.equal(client.auth.redirectFor('#/admin/emprestimos'), '#/cliente');
  const missingProfile = harness({ session: { user: { id:'missing' } }, profile:null });
  await tick();
  assert.equal(missingProfile.auth.redirectFor('#/cliente'), '#/conta-indisponivel');
  assert.equal(missingProfile.auth.redirectFor('#/login'), '#/conta-indisponivel');
  const suspended = harness({ session: { user: { id:'suspended' } }, profile: { id:'suspended', status:'suspenso' } });
  await tick();
  assert.equal(suspended.auth.redirectFor('#/cliente/solicitar'), '#/conta-indisponivel');
  const anonymous = harness();
  await tick();
  assert.equal(anonymous.auth.redirectFor('#/cliente'), '#/login');
  assert.equal(anonymous.auth.redirectFor('#/admin'), '#/admin/login');
});

test('Supabase auth callback returns synchronously and schedules profile/role work', async () => {
  const h = harness();
  await tick();
  h.client.auth.getUser = async () => ({ data: { user: { id: 'u1' } }, error: null });
  const before = h.calls.roleReads;
  const returned = h.callback('SIGNED_IN', { user: { id: 'u1' } });
  assert.equal(returned, undefined);
  await tick();
  assert.equal(h.calls.roleReads, before + 1);
});

test('phone login calls the rate-limited edge endpoint and installs only its returned SDK session', async () => {
  const h = harness({ profile: { id:'u1', status:'ativo' } });
  await tick();
  Object.assign(h.values, { phone: '(79) 99999-9999', password: 'sample-password' });
  h.auth.bind('#/cliente/login');
  await h.submit({ preventDefault() {} });
  assert.match(h.calls.requests[0].url, /\/functions\/v1\/acesso-cliente$/);
  assert.deepEqual(JSON.parse(h.calls.requests[0].init.body), { action: 'login', phone: '79999999999', password: 'sample-password' });
  assert.equal(h.calls.requests[0].options.writing, false);
  assert.equal(h.calls.requests[0].init.headers.apikey, 'anon-test-key');
  assert.equal(h.calls.requests[0].init.headers.Authorization, 'Bearer anon-test-key');
  assert.equal(h.calls.setSession[0].access_token, 'access');
  assert.equal(h.location.hash, '#/cliente');
});

test('admin login uses email auth and admits an admin with no profile based on database role', async () => {
  const h = harness({ profile:null, isAdmin:true, loginUser:{ id:'admin-1' } });
  await tick();
  Object.assign(h.values, { email:'ADMIN@example.com', password:'sample-password' });
  h.auth.bind('#/admin/login');
  await h.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.passwordLogin[0])), { email:'admin@example.com', password:'sample-password' });
  assert.equal(h.calls.requests.length, 0);
  assert.equal(h.location.hash, '#/admin');
});

test('ordinary user entering admin login is sent to client area and cannot get admin role from metadata', async () => {
  const h = harness({ profile:{ id:'client-1', status:'ativo' }, isAdmin:false, loginUser:{ id:'client-1', user_metadata:{ admin:true } } });
  await tick();
  Object.assign(h.values, { email:'client@example.com', password:'sample-password' });
  h.auth.bind('#/admin/login');
  await h.submit({ preventDefault() {} });
  assert.equal(h.auth.admin, false);
  assert.equal(h.location.hash, '#/cliente');
});

test('signup metadata matches trigger schema and never accepts a client supplied role', async () => {
  const h = harness();
  await tick();
  Object.assign(h.values, { full_name:'Pessoa Exemplo', email:'TESTE@example.com', password:'sample-password', cpf:'123.456.789-09', phone:'(79) 99999-9999', cep:'49000-000', street:'Rua A', number:'4', complement:'', district:'Centro', city:'Aracaju', state:'se', card_limit:'2500', card_brand:'visa' });
  h.auth.bind('#/cadastro');
  await h.submit({ preventDefault() {} });
  const signUp = h.calls.signup[0];
  assert.equal(signUp.email, 'teste@example.com');
  assert.deepEqual(Object.keys(signUp.options.data).sort(), ['card_brand','card_limit','cep','city','complement','cpf','district','full_name','number','phone','privacy_version','signup_type','state','street','terms_version'].sort());
  assert.equal(signUp.options.data.signup_type, 'cliente');
  assert.equal(signUp.options.data.state, 'SE');
  assert.equal(signUp.options.data.card_limit, 2500);
  assert.equal('admin' in signUp.options.data, false);
});

test('login view escapes markup and route aliases have dedicated string templates', () => {
  const h = harness();
  assert.equal(typeof h.auth.views['#/login'], 'string');
  assert.equal(typeof h.auth.views['#/admin/login'], 'string');
  assert.equal(typeof h.auth.views['#/cliente/login'], 'string');
  assert.equal(typeof h.auth.views['#/cadastro'], 'string');
  assert.equal(typeof h.auth.views['#/recuperar'], 'string');
  assert.equal(typeof h.auth.views['#/redefinir-senha'], 'string');
  assert.equal(typeof h.auth.views['#/conta-indisponivel'], 'string');
  assert.match(h.auth.views['#/cadastro'], /name="cpf"/);
  assert.match(h.auth.views['#/cadastro'], /versões em rascunho/);
  assert.match(h.auth.views['#/cadastro'], /class="field"/);
  assert.doesNotMatch(h.auth.views['#/cadastro'], /<script/i);
});


test('password recovery calls generic phone endpoint and password reset only updates the authenticated session', async () => {
  const recovery = harness({ request: { ok: true, message: 'Se houver uma conta, verifique seu e-mail.' } });
  await tick();
  Object.assign(recovery.values, { phone: '(79) 99999-9999' });
  recovery.auth.bind('#/recuperar');
  await recovery.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(recovery.calls.requests[0].init.body), { action: 'recuperar', phone: '79999999999' });
  assert.equal(recovery.calls.requests[0].options.writing, false);

  const reset = harness({ url:{ hash:'#/redefinir-senha#access_token=reset-access&refresh_token=reset-refresh&type=recovery' } });
  await tick();
  Object.assign(reset.values, { password: 'new-password-1', password_confirm: 'new-password-1' });
  reset.auth.bind('#/redefinir-senha');
  await reset.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(reset.calls.updates[0])), { password: 'new-password-1' });
  assert.equal(reset.location.hash, '#/login');
  assert.equal(reset.sessionStore.has('jk-auth-recovery'), false);
});

test('password recovery callback accepts token fragments after the hash route and removes callback secrets from the URL', async () => {
  const h = harness({ url: { hash:'#/redefinir-senha#access_token=access-once&refresh_token=refresh-once&type=recovery' } });
  await tick();
  assert.equal(h.calls.setSession[0].access_token, 'access-once');
  assert.equal(h.calls.setSession[0].refresh_token, 'refresh-once');
  assert.equal(h.auth.redirectFor('#/redefinir-senha'), '#/redefinir-senha');
  assert.equal(h.calls.replacedUrl, '/#/redefinir-senha');
  assert.doesNotMatch(h.calls.replacedUrl, /access-once|refresh-once/);
});
test('PKCE callback on reset route enables password update without requiring a query type', async () => {
  const h = harness({ session:{ user:{ id:'recovering-user' } }, url:{ search:'?code=one-time-code', hash:'#/redefinir-senha' } });
  await tick();
  assert.equal(h.calls.code, 'one-time-code');
  assert.equal(h.calls.replacedUrl, '/#/redefinir-senha');
  assert.equal(h.auth.redirectFor('#/redefinir-senha'), '#/redefinir-senha');
  Object.assign(h.values, { password:'new-password-2', password_confirm:'new-password-2' });
  h.auth.bind('#/redefinir-senha');
  await h.submit({ preventDefault() {} });
  assert.equal(h.calls.updates.length, 1);
});
test('implicit signup confirmation installs tokens but returns to login without enabling password reset', async () => {
  const h = harness({ url:{ hash:'#access_token=signup-access&refresh_token=signup-refresh&type=signup' } });
  await tick();
  assert.equal(h.calls.setSession[0].access_token, 'signup-access');
  assert.equal(h.calls.replacedUrl, '/#/login');
  assert.equal(h.auth.redirectFor('#/redefinir-senha'), '#/login');
  Object.assign(h.values, { password:'new-password-3', password_confirm:'new-password-3' });
  h.auth.bind('#/redefinir-senha');
  await h.submit({ preventDefault() {} });
  assert.equal(h.calls.updates.length, 0);
});
test('PKCE signup confirmation on login route never opens the password reset flow', async () => {
  const h = harness({ session:{ user:{ id:'confirmed-user' } }, url:{ search:'?code=signup-code', hash:'#/login' } });
  await tick();
  assert.equal(h.calls.code, 'signup-code');
  assert.equal(h.calls.replacedUrl, '/#/login');
  assert.equal(h.auth.redirectFor('#/redefinir-senha'), '#/login');
  Object.assign(h.values, { password:'new-password-4', password_confirm:'new-password-4' });
  h.auth.bind('#/redefinir-senha');
  await h.submit({ preventDefault() {} });
  assert.equal(h.calls.updates.length, 0);
});
test('recovery marker survives reload with SDK session and is removed after password update', async () => {
  const sessionStore = new Map();
  const first = harness({ sessionStore, url:{ hash:'#/redefinir-senha#access_token=first-access&refresh_token=first-refresh&type=recovery' } });
  await tick();
  assert.equal(sessionStore.get('jk-auth-recovery'), '1');

  const reloaded = harness({ sessionStore, session:{ user:{ id:'recovering-user' } }, url:{ hash:'#/redefinir-senha' } });
  await tick();
  assert.equal(reloaded.auth.redirectFor('#/redefinir-senha'), '#/redefinir-senha');
  Object.assign(reloaded.values, { password:'new-password-5', password_confirm:'new-password-5' });
  reloaded.auth.bind('#/redefinir-senha');
  await reloaded.submit({ preventDefault() {} });
  assert.equal(reloaded.calls.updates.length, 1);
  assert.equal(sessionStore.has('jk-auth-recovery'), false);
});
test('failed recovery token or PKCE exchange clears the URL before request and removes recovery marker', async () => {
  const implicitStore = new Map();
  const implicit = harness({ sessionStore:implicitStore, setSessionError:new Error('private auth failure'), url:{ hash:'#/redefinir-senha#access_token=one-time-access&refresh_token=one-time-refresh&type=recovery' } });
  await tick();
  assert.equal(implicit.calls.replacedUrl, '/#/redefinir-senha');
  assert.equal(implicit.sessionStore.has('jk-auth-recovery'), false);
  assert.ok(implicit.calls.report);

  const pkceStore = new Map();
  const pkce = harness({ sessionStore:pkceStore, exchangeError:new Error('private auth failure'), url:{ search:'?code=one-time-code', hash:'#/redefinir-senha' } });
  await tick();
  assert.equal(pkce.calls.replacedUrl, '/#/redefinir-senha');
  assert.equal(pkce.sessionStore.has('jk-auth-recovery'), false);
  assert.ok(pkce.calls.report);
});
test('failed identity refresh clears a stale admin snapshot and fails closed', async () => {
  const h = harness({ session: { user: { id: 'admin-1' } }, isAdmin: true });
  await tick();
  h.client.auth.getUser = async () => ({ data: { user: null }, error: new Error('private backend detail') });
  h.callback('TOKEN_REFRESHED', { user: { id: 'admin-1' } });
  await tick();
  assert.equal(h.auth.user, null);
  assert.equal(h.auth.profile, null);
  assert.equal(h.auth.admin, false);
  assert.equal(h.auth.ready, true);
});
