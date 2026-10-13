/* Shared error boundary. Never log request bodies, tokens or raw database errors. */
(function (root) {
  'use strict';
  const messages = {
    OFFLINE: 'Você está sem conexão. Confira sua internet.',
    NETWORK: 'Não foi possível conectar ao serviço. Tente novamente em alguns instantes.',
    TIMEOUT: 'O serviço demorou para responder. Tente novamente em alguns instantes.',
    WRITE_UNCONFIRMED: 'Não foi possível confirmar a operação. Consulte o histórico antes de enviar novamente.',
    SESSION: 'Sua sessão expirou ou não está disponível. Entre novamente.',
    INVALID_CREDENTIALS: 'Login ou senha incorretos.',
    EMAIL_NOT_CONFIRMED: 'Confirme seu e-mail antes de entrar. Verifique sua caixa de entrada.',
    FORBIDDEN: 'Você não tem permissão para realizar esta ação.',
    RATE_LIMIT: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
    NOT_FOUND: 'O registro solicitado não foi encontrado.',
    CONFLICT: 'Já existe um registro com esses dados. Confira antes de continuar.',
    VALIDATION: 'Confira os campos informados antes de continuar.',
    CONFIG: 'O serviço não está configurado corretamente. Contate o suporte.',
    ACCOUNT_INACTIVE: 'Sua conta está indisponível. Contate a JK CRED para verificar seu cadastro.',
    UNAVAILABLE: 'O serviço está indisponível no momento. Tente novamente mais tarde.',
    INVALID_RESPONSE: 'O serviço retornou uma resposta inesperada.',
    UNEXPECTED: 'Não foi possível concluir esta ação. Tente novamente ou contate o suporte.'
  };
  class AppError extends Error {
    constructor(code, options = {}) {
      super(messages[code] || messages.UNEXPECTED);
      this.name = 'AppError';
      this.code = code;
      this.status = Number(options.status) || 0;
    }
  }
  function normalize(error) {
    if (error instanceof AppError) return error;
    const status = Number(error?.status || error?.context?.status) || 0;
    const code = error?.code;
    if (Object.hasOwn(messages, code)) return new AppError(code, { status });
    const businessErrors = {
      nao_autenticado: 'SESSION', permissao_negada: 'FORBIDDEN', conta_inativa: 'ACCOUNT_INACTIVE',
      solicitacao_nao_encontrada: 'NOT_FOUND', chave_reutilizada: 'CONFLICT', status_conflitante: 'CONFLICT',
      valor_acima_do_saldo: 'VALIDATION', pagamento_invalido: 'VALIDATION', parcela_invalida: 'VALIDATION',
      transicao_invalida: 'VALIDATION', emprestimo_nao_liberado: 'VALIDATION',
      valor_fora_do_limite: 'VALIDATION', parcelas_fora_do_limite: 'VALIDATION', data_fora_do_limite: 'VALIDATION',
      valor_invalido: 'VALIDATION', parcelas_invalidas: 'VALIDATION', entrada_invalida: 'VALIDATION', chave_invalida: 'VALIDATION'
    };
    const business = /\bJK:([a-z_]+)/.exec(String(error?.message || ''))?.[1];
    if (businessErrors[business]) return new AppError(businessErrors[business], { status });
    if (code === 'PGRST202' || code === '42P01') return new AppError('CONFIG');
    // PostgREST wraps thrown fetch errors in a plain result.error object.
    for (const [key, message] of Object.entries(messages)) {
      if (String(error?.message || '').includes(message)) return new AppError(key, { status });
    }
    if (code === 'invalid_credentials') return new AppError('INVALID_CREDENTIALS', { status });
    if (code === 'email_not_confirmed') return new AppError('EMAIL_NOT_CONFIRMED', { status });
    if (code === '23505') return new AppError('CONFLICT');
    if (code === '42501' || status === 403) return new AppError('FORBIDDEN');
    if (code === 'PGRST116' || status === 404) return new AppError('NOT_FOUND');
    if (status === 401 || ['session_not_found', 'refresh_token_not_found', 'refresh_token_already_used'].includes(code)) return new AppError('SESSION');
    if (status === 429) return new AppError('RATE_LIMIT');
    if (status >= 500) return new AppError('UNAVAILABLE', { status });
    if (status === 400 || status === 422 || ['23502', '23503', '23514', '22P02'].includes(code)) return new AppError('VALIDATION');
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return new AppError('TIMEOUT');
    if (/failed to fetch|fetch failed|network|load failed/i.test(String(error?.message || ''))) return new AppError('NETWORK');
    return new AppError('UNEXPECTED');
  }
  function show(error, target) {
    const message = normalize(error).message;
    const el = typeof target === 'string' ? root.document?.getElementById(target) : target;
    if (el) {
      el.textContent = message;
      if (el.tagName === 'TBODY') {
        const row = root.document.createElement('tr');
        const cell = root.document.createElement('td');
        cell.colSpan = 10;
        cell.textContent = message;
        row.append(cell);
        el.replaceChildren(row);
      }
      el.setAttribute('role', 'alert');
    } else if (root.document) {
      let notice = root.document.getElementById('jk-error-notice');
      if (!notice) {
        notice = root.document.createElement('div');
        notice.id = 'jk-error-notice';
        notice.setAttribute('role', 'alert');
        notice.className = 'jk-error-notice';
        const text = root.document.createElement('span');
        const close = root.document.createElement('button');
        close.type = 'button';
        close.textContent = 'Fechar';
        close.onclick = () => notice.remove();
        notice.append(text, close);
        root.document.body.append(notice);
      }
      notice.firstChild.textContent = message;
    }
    return message;
  }
  function report(error, context = 'app', target) {
    const safe = normalize(error);
    // Use static operation names as context, never a customer ID/URL/payload.
    root.console?.error('[JK CRED]', { context, code: safe.code, status: safe.status });
    show(safe, target);
    return safe;
  }
  function createFetch(fetchImpl, timeoutMs = 15000) {
    return async function (input, init = {}) {
      const method = String(init.method || input?.method || 'GET').toUpperCase();
      const { jkReadOnly = false, ...fetchOptions } = init;
      const writing = !jkReadOnly && !['GET', 'HEAD', 'OPTIONS'].includes(method);
      if (root.navigator?.onLine === false) throw new AppError('OFFLINE');
      const controller = new AbortController();
      const callerSignal = init.signal || input?.signal;
      const cancel = () => controller.abort();
      if (callerSignal?.aborted) cancel();
      callerSignal?.addEventListener('abort', cancel, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      try {
        const response = await fetchImpl(input, { ...fetchOptions, signal: controller.signal });
        // Include response-body consumption in the deadline (Supabase parses it later).
        const bytes = await response.arrayBuffer();
        return new Response([204, 205, 304].includes(response.status) ? null : bytes, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) {
        if (writing) throw new AppError('WRITE_UNCONFIRMED');
        if (timedOut) throw new AppError('TIMEOUT');
        throw normalize(error);
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', cancel);
      }
    };
  }
  async function requestJson(url, init = {}, { writing = true } = {}) {
    const response = await api.fetch(url, { ...init, jkReadOnly: !writing });
    let body;
    try { body = await response.json(); }
    catch {
      if (!response.ok) throw normalize({ status: response.status });
      throw new AppError('INVALID_RESPONSE');
    }
    if (!response.ok) throw normalize({ status: response.status, code: body?.code });
    return body;
  }
  const pending = new Set();
  async function run(key, work, { form, target, writing = false } = {}) {
    if (pending.has(key)) return;
    pending.add(key);
    const buttons = Array.from(form?.querySelectorAll('button, input[type="submit"]') || []);
    const disabled = buttons.map(button => button.disabled);
    const busy = form?.getAttribute('aria-busy');
    buttons.forEach(button => { button.disabled = true; });
    form?.setAttribute('aria-busy', 'true');
    try { return await work(); }
    catch (error) {
      let safe = normalize(error);
      if (writing && ['NETWORK', 'TIMEOUT'].includes(safe.code)) safe = new AppError('WRITE_UNCONFIRMED');
      report(safe, key, target);
    } finally {
      pending.delete(key);
      buttons.forEach((button, index) => { button.disabled = disabled[index]; });
      if (busy == null) form?.removeAttribute('aria-busy');
      else form?.setAttribute('aria-busy', busy);
    }
  }
  let client;
  function getClient() {
    if (client) return client;
    const config = root.JK_CONFIG;
    if (!root.supabase?.createClient || !config?.SUPABASE_URL || !config?.SUPABASE_ANON_KEY) throw new AppError('CONFIG');
    try {
      const endpoint = new URL(config.SUPABASE_URL);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
      if (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) throw new Error('Unsafe endpoint');
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid endpoint');
      const key = String(config.SUPABASE_ANON_KEY);
      if (key.startsWith('sb_secret_')) throw new Error('Secret key in browser');
      if (key.split('.').length === 3) {
        const part = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const claims = JSON.parse(root.atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')));
        if (claims.role !== 'anon') throw new Error('Privileged key in browser');
      }
      client = root.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
        auth: { storage: root.sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
        global: { fetch: api.fetch }
      });
      return client;
    } catch { throw new AppError('CONFIG'); }
  }
  const api = { AppError, normalize, show, report, createFetch, requestJson, run, getClient };
  if (root.fetch) api.fetch = createFetch(root.fetch.bind(root));
  root.JKErrors = api;
  if (typeof module !== 'undefined') module.exports = api;
  if (root.addEventListener) {
    root.addEventListener('error', event => {
      report(event.error || new AppError('CONFIG'), 'global');
    }, true);
    root.addEventListener('unhandledrejection', event => {
      report(event.reason, 'async');
      event.preventDefault();
    });
  }
})(typeof window === 'undefined' ? globalThis : window);
