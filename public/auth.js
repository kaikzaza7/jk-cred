/* JK CRED — auth.js: cadastro, login, recuperação e sessão (Supabase). Carregado depois do app. */
(() => {
const C = window.JK_CONFIG || {};
const TERMS = 'rascunho-1';
const d = v => String(v || '').replace(/\D/g, '');
const S = { user: null, profile: null, admin: false, ready: false };

let sb;
try { sb = JKErrors.getClient(); }
catch (error) { JKErrors.report(error, 'auth-startup'); return; }

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const field = (name, label, type = 'text', attrs = '', required = true) => `<div class="field"><label for="${esc(name)}">${esc(label)}</label><input id="${esc(name)}" name="${esc(name)}" type="${esc(type)}" ${attrs} ${required ? 'required' : ''}></div>`;
const actionLabel = title => ({'Entrar':'Entrar','Área do cliente':'Entrar','Área administrativa':'Entrar','Criar conta de cliente':'Criar conta','Recuperar senha':'Enviar instruções','Definir nova senha':'Salvar nova senha'}[title]);
const shell = (title, body, links = '', wide = false) => `<main class="auth-page"><header class="auth-topbar"><a class="logo" href="#/" aria-label="JK CRED, página inicial">JK <em>CRED</em></a><a class="btn btn-ghost" href="#/">← Voltar ao início</a></header><section class="card auth-card${wide ? ' auth-card-wide' : ''}"><h1>${esc(title)}</h1><p class="auth-intro">Use os dados associados à sua conta JK CRED.</p><form class="auth-form" data-jk-auth>${body}<p class="auth-message" data-auth-message role="status" aria-live="polite"></p>${actionLabel(title) ? `<button class="btn btn-primary btn-block" type="submit">${esc(actionLabel(title))}</button>` : ''}</form><nav class="auth-links">${links}</nav></section></main>`;
const views = {
  '#/login': shell('Entrar', field('phone','Telefone com DDD','tel','autocomplete="username" inputmode="tel" placeholder="(11) 99999-9999"') + '<p class="hint">Use o celular com DDD informado no cadastro.</p>' + field('password','Senha','password','autocomplete="current-password"'), '<a href="#/cadastro">Criar conta</a> · <a href="#/recuperar">Esqueci minha senha</a>'),
  '#/cliente/login': shell('Área do cliente', field('phone','Telefone com DDD','tel','autocomplete="username" inputmode="tel" placeholder="(11) 99999-9999"') + '<p class="hint">Use o celular com DDD informado no cadastro.</p>' + field('password','Senha','password','autocomplete="current-password"'), '<a href="#/cadastro">Criar conta</a> · <a href="#/recuperar">Esqueci minha senha</a>'),
  '#/admin/login': shell('Área administrativa', field('email','E-mail administrativo','email','autocomplete="username"') + field('password','Senha','password','autocomplete="current-password"'), '<a href="#/cliente/login">Área do cliente</a>'),
  '#/cadastro': shell('Criar conta de cliente',
    field('full_name','Nome completo','text','autocomplete="name" minlength="5" maxlength="120"') +
    field('email','E-mail','email','autocomplete="email"') + field('password','Senha','password','autocomplete="new-password" minlength="8"') +
    field('cpf','CPF','text','inputmode="numeric" minlength="11" maxlength="14"') + field('phone','Telefone com DDD','tel','autocomplete="tel" inputmode="tel"') +
    field('cep','CEP','text','inputmode="numeric"') + field('street','Rua','text','autocomplete="address-line1"') + field('number','Número') +
    field('complement','Complemento','text','',false) + field('district','Bairro') + field('city','Cidade','text','autocomplete="address-level2"') +
    field('state','UF','text','minlength="2" maxlength="2" autocomplete="address-level1"') + field('card_limit','Limite do cartão','number','min="0" step="0.01"') +
    `<div class="field"><label for="card_brand">Bandeira do cartão</label><select id="card_brand" name="card_brand" required><option value="">Selecione</option>${['visa','mastercard','elo','amex','hipercard','diners','outra','nao_informado'].map(x=>`<option value="${x}">${x === 'nao_informado' ? 'Não informado' : x}</option>`).join('')}</select></div>` +
    `<div class="field chk"><label><input type="checkbox" name="terms" required> Aceito os termos de uso e a política de privacidade, ambos identificados no cadastro como versões em rascunho.</label></div>`, '<a href="#/login">Já tenho conta</a>', true),
  '#/recuperar': shell('Recuperar senha', field('phone','Telefone cadastrado','tel','autocomplete="tel" inputmode="tel"'), '<a href="#/login">Voltar ao login</a>'),
  '#/redefinir-senha': shell('Definir nova senha', field('password','Nova senha','password','autocomplete="new-password" minlength="8"') + field('password_confirm','Confirme a nova senha','password','autocomplete="new-password" minlength="8"'), '<a href="#/login">Voltar ao login</a>'),
  '#/conta-indisponivel': shell('Conta indisponível', '<p>Não foi possível liberar a área do cliente para esta conta. Verifique seu cadastro ou fale com o suporte da JK CRED.</p>', '<a href="#/login">Voltar ao login</a>')
};
const aliases = { '#/cliente/login':'#/login' };
const protectedAdmin = path => path === '#/admin' || path.startsWith('#/admin/');
const protectedClient = path => path === '#/cliente' || path.startsWith('#/cliente/');
const publish = () => {
  if (window.dispatchEvent && typeof window.CustomEvent === 'function') window.dispatchEvent(new window.CustomEvent('jk:authchange', { detail: { user: S.user, profile: S.profile, admin: S.admin, ready: S.ready } }));
};
S.ready = false;
let queue = Promise.resolve();
const RECOVERY_KEY = 'jk-auth-recovery';
function readRecoveryMode() {
  try { return window.sessionStorage?.getItem(RECOVERY_KEY) === '1'; }
  catch { return false; }
}
let recoveryMode = readRecoveryMode();
function setRecoveryMode(active) {
  recoveryMode = Boolean(active);
  try {
    if (recoveryMode) window.sessionStorage?.setItem(RECOVERY_KEY, '1');
    else window.sessionStorage?.removeItem(RECOVERY_KEY);
  } catch { /* Optional flow hint falls back to this page's memory. */ }
}
function schedule(event, session) {
  queue = queue.then(() => sync(event, session)).catch(error => {
    // A stale admin/profile snapshot must never survive a failed identity refresh.
    S.user = null; S.profile = null; S.admin = false; S.ready = true;
    publish();
    JKErrors.report(error, 'auth-session');
  });
  return queue;
}
async function sync(event, session) {
  if (event === 'PASSWORD_RECOVERY') {
    setRecoveryMode(true);
    if (location.hash !== '#/redefinir-senha') location.hash = '#/redefinir-senha';
  }
  if (!session?.user) {
    S.user = null; S.profile = null; S.admin = false;
    setRecoveryMode(false);
  } else {
    const { data, error } = await sb.auth.getUser();
    if (error) throw error;
    S.user = data?.user || null;
    S.profile = null; S.admin = false;
    if (S.user?.id) {
      const profileResult = await sb.from('profiles').select('*').eq('id', S.user.id).maybeSingle();
      if (profileResult.error && profileResult.error.code !== 'PGRST116') throw profileResult.error;
      S.profile = profileResult.data || null;
      // admin_users is intentionally inaccessible to frontend roles. The existing
      // SECURITY DEFINER RPC checks auth.uid() and returns only this user's role.
      const result = await sb.rpc('is_admin');
      if (result.error) throw result.error;
      S.admin = result.data === true;
    }
  }
  S.ready = true;
  publish();
}
function redirectFor(path) {
  if (!S.ready) return path;
  const clientEnabled = S.profile?.status === 'ativo';
  if (protectedAdmin(path)) return S.user && S.admin ? path : (S.user ? (clientEnabled ? '#/cliente' : '#/conta-indisponivel') : '#/admin/login');
  if (protectedClient(path)) return S.user && clientEnabled ? path : (S.user && S.admin ? '#/admin' : S.user ? '#/conta-indisponivel' : '#/login');
  if ((path === '#/login' || path === '#/cliente/login' || path === '#/admin/login') && S.user) return S.admin ? '#/admin' : clientEnabled ? '#/cliente' : '#/conta-indisponivel';
  if (path === '#/redefinir-senha' && (!S.user || !recoveryMode)) return '#/login';
  return path;
}
function message(form, text) { const el = form?.querySelector('[data-auth-message]'); if (el) el.textContent = text; }
function read(form, name) { return form.elements?.namedItem(name)?.value ?? ''; }
function bind(path) {
  const form = document.querySelector('form[data-jk-auth]');
  if (!form || form.dataset?.jkBound === path) return;
  if (form.dataset) form.dataset.jkBound = path;
  form.addEventListener('submit', event => {
    event.preventDefault();
    const op = aliases[path] || path;
    const key = `auth:${op}`;
    return JKErrors.run(key, async () => {
      const execute = async () => {
      message(form, '');
      if (op === '#/admin/login') {
        const { data, error } = await sb.auth.signInWithPassword({ email:read(form,'email').trim().toLowerCase(), password:read(form,'password') });
        if (error) throw error;
        await schedule('SIGNED_IN', data?.session);
        // Only the database role loaded by is_admin() may enter admin routes.
        location.hash = S.admin ? '#/admin' : S.profile?.status === 'ativo' ? '#/cliente' : '#/conta-indisponivel';
        return;
      }
      if (op === '#/login') {
        const phone = d(read(form,'phone'));
        if (!/^[1-9][1-9](9[0-9]{8}|[2-9][0-9]{7})$/.test(phone)) throw new JKErrors.AppError('VALIDATION');
        const response = await JKErrors.requestJson(`${C.SUPABASE_URL}/functions/v1/acesso-cliente`, { method:'POST', headers:{'Content-Type':'application/json', apikey:C.SUPABASE_ANON_KEY, Authorization:`Bearer ${C.SUPABASE_ANON_KEY}`}, body:JSON.stringify({ action:'login', phone, password:read(form,'password') }) }, { writing:false });
        if (!response?.session?.access_token || !response?.session?.refresh_token) throw new JKErrors.AppError('INVALID_RESPONSE');
        const result = await sb.auth.setSession(response.session);
        if (result.error) throw result.error;
        await schedule('SIGNED_IN', result.data?.session);
        location.hash = S.admin ? '#/admin' : S.profile?.status === 'ativo' ? '#/cliente' : '#/conta-indisponivel';
        return;
      }
      if (op === '#/cadastro') {
        const email = read(form,'email').trim().toLowerCase();
        const meta = { signup_type:'cliente', full_name:read(form,'full_name').trim(), cpf:d(read(form,'cpf')), phone:d(read(form,'phone')), cep:d(read(form,'cep')), street:read(form,'street').trim(), number:read(form,'number').trim(), complement:read(form,'complement').trim(), district:read(form,'district').trim(), city:read(form,'city').trim(), state:read(form,'state').trim().toUpperCase(), card_limit:Number(read(form,'card_limit')), card_brand:read(form,'card_brand'), terms_version:TERMS, privacy_version:TERMS };
        setRecoveryMode(false);
        const { error } = await sb.auth.signUp({ email, password:read(form,'password'), options:{ emailRedirectTo:`${location.origin}${location.pathname}#/login`, data:meta } });
        if (error) throw error;
        message(form, 'Cadastro enviado. Verifique seu e-mail para confirmar a conta.');
        return;
      }
      if (op === '#/recuperar') {
        const phone = d(read(form,'phone'));
        if (!/^[1-9][1-9](9[0-9]{8}|[2-9][0-9]{7})$/.test(phone)) throw new JKErrors.AppError('VALIDATION');
        const response = await JKErrors.requestJson(`${C.SUPABASE_URL}/functions/v1/acesso-cliente`, { method:'POST', headers:{'Content-Type':'application/json', apikey:C.SUPABASE_ANON_KEY, Authorization:`Bearer ${C.SUPABASE_ANON_KEY}`}, body:JSON.stringify({ action:'recuperar', phone }) }, { writing:false });
        message(form, response.message || 'Se houver uma conta com esse telefone, você receberá instruções no e-mail cadastrado.');
        return;
      }
      if (op === '#/redefinir-senha') {
        if (!S.user || !recoveryMode) throw new JKErrors.AppError('SESSION');
        const password = read(form,'password');
        if (password !== read(form,'password_confirm')) throw new JKErrors.AppError('VALIDATION');
        const { error } = await sb.auth.updateUser({ password });
        if (error) throw error;
        setRecoveryMode(false);
        message(form, 'Senha alterada. Você já pode entrar com a nova senha.');
        location.hash = '#/login';
      }
      };
      try { return await execute(); }
      catch (error) { throw JKErrors.normalize(error); }
    }, { form, target:form.querySelector('[data-auth-message]'), writing: ['#/cadastro','#/redefinir-senha'].includes(op) });
  });
}
const api = {
  views,
  bind,
  redirectFor,
  logout: () => JKErrors.run('logout', async () => {
    const { error } = await sb.auth.signOut();
    if (error) throw error;
    await schedule('SIGNED_OUT', null);
    location.hash = '#/login';
  }),
  get ready() { return S.ready; },
  get user() { return S.user; },
  get profile() { return S.profile; },
  get admin() { return S.admin; }
};
window.JKAuth = api;
try {
  sb.auth.onAuthStateChange((event, session) => {
    // Supabase auth callbacks must stay synchronous; profile/RPC calls run afterward.
    setTimeout(() => schedule(event, session), 0);
  });
  JKErrors.run('auth-bootstrap', async () => {
    // detectSessionInUrl is disabled in the shared client; exchange the one-time
    // recovery callback explicitly before reading the persisted session.
    const originalHash = location.hash;
    const hashParams = originalHash.replace(/^#(?:\/[^?&#]*)?[?&#]?/, '');
    const callbackHash = new URLSearchParams(hashParams);
    const callbackQuery = new URLSearchParams(location.search || '');
    const hashRoute = originalHash.split('#').map(part => part.split('?')[0]).find(part => part.startsWith('/')) || '';
    const recoveryRoute = hashRoute === '/redefinir-senha';
    let callbackSession = null;
    if (callbackHash.get('access_token') && callbackHash.get('refresh_token')) {
      const isRecovery = callbackHash.get('type') === 'recovery' || recoveryRoute;
      setRecoveryMode(isRecovery);
      history.replaceState(null, '', `${location.pathname}${isRecovery ? '#/redefinir-senha' : '#/login'}`);
      let result;
      try { result = await sb.auth.setSession({ access_token:callbackHash.get('access_token'), refresh_token:callbackHash.get('refresh_token') }); }
      catch (error) { setRecoveryMode(false); throw error; }
      if (result.error) { setRecoveryMode(false); throw result.error; }
      callbackSession = result.data?.session || null;
    } else if (callbackQuery.get('code')) {
      const isRecovery = callbackQuery.get('type') === 'recovery' || recoveryRoute;
      setRecoveryMode(isRecovery);
      history.replaceState(null, '', `${location.pathname}${isRecovery ? '#/redefinir-senha' : '#/login'}`);
      let result;
      try { result = await sb.auth.exchangeCodeForSession(callbackQuery.get('code')); }
      catch (error) { setRecoveryMode(false); throw error; }
      if (result.error) { setRecoveryMode(false); throw result.error; }
      callbackSession = result.data?.session || null;
      // PKCE callback is used by password recovery; Supabase uses the same code
      // exchange for email confirmation, which should return to the login page.
    }
    const { data, error } = callbackSession ? { data:{ session:callbackSession }, error:null } : await sb.auth.getSession();
    if (error) throw error;
    await sync('INITIAL_SESSION', data?.session || null);
  }).then(() => { if (!S.ready) { S.ready = true; publish(); } });
} catch (error) {
  JKErrors.report(error, 'auth-startup');
  S.ready = true;
  publish();
}
})();
