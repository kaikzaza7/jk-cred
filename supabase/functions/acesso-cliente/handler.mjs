// Dependency injection allows offline tests without real accounts or secrets.
export function createHandler({ createClient, env, logger = console, uuid = () => crypto.randomUUID() }) {
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const hash = async (value, secret) => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
  };
  const readBody = async request => {
    const reader = request.body?.getReader();
    if (!reader) throw new Error('Invalid body');
    let size = 0;
    const decoder = new TextDecoder();
    let text = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) { await reader.cancel(); throw new RangeError('Body too large'); }
        text += decoder.decode(value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } finally { reader.releaseLock(); }
  };
  return async request => {
    const requestId = uuid();
    const origin = request.headers.get('origin');
    const allowedOrigins = new Set();
    for (const value of [env('SITE_URL'), ...(env('ALLOWED_ORIGINS') || '').split(',')]) {
      try {
        const url = new URL(value);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if ((url.protocol === 'https:' || (local && url.protocol === 'http:')) && !url.username && !url.password) allowedOrigins.add(url.origin);
      } catch { /* Missing/invalid origins are never converted to a wildcard. */ }
    }
    const cors = {
      ...(origin && allowedOrigins.has(origin) ? { 'Access-Control-Allow-Origin': origin } : !origin && allowedOrigins.size ? { 'Access-Control-Allow-Origin': [...allowedOrigins][0] } : {}),
      Vary: 'Origin', 'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Expose-Headers': 'x-request-id',
      'x-request-id': requestId, 'Cache-Control': 'no-store',
    };
    const json = (body, status = 200) => new Response(JSON.stringify({ ...body, request_id: requestId }), {
      status, headers: { ...cors, 'Content-Type': 'application/json' },
    });
    const log = operation => logger.error('[JK CRED]', { request_id: requestId, operation });
    const requireResult = (result, operation) => {
      if (result.error) { log(operation); throw new Error('Dependency unavailable'); }
      return result;
    };
    try {
      if (origin && !allowedOrigins.has(origin)) return json({ error: 'Origem não permitida.', code: 'FORBIDDEN' }, 403);
      if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
      if (request.method !== 'POST') return json({ error: 'Método não permitido.', code: 'METHOD_NOT_ALLOWED' }, 405);
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'Envie JSON.', code: 'VALIDATION' }, 415);
      if (Number(request.headers.get('content-length')) > 4096) return json({ error: 'Requisição muito grande.', code: 'VALIDATION' }, 413);
      let body;
      try { body = await readBody(request); }
      catch (error) { return json({ error: 'Requisição inválida.', code: 'VALIDATION' }, error instanceof RangeError ? 413 : 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Requisição inválida.', code: 'VALIDATION' }, 400);
      const action = body.action ?? 'login';
      if (!['login', 'recuperar'].includes(action)) return json({ error: 'Ação inválida.', code: 'VALIDATION' }, 400);
      if (typeof body.phone !== 'string' || body.phone.length > 32) return json({ error: 'Informe um telefone válido com DDD.', code: 'VALIDATION' }, 400);
      const phone = body.phone.replace(/\D/g, '');
      if (!/^[1-9][1-9](9[0-9]{8}|[2-9][0-9]{7})$/.test(phone)) return json({ error: 'Informe um telefone válido com DDD.', code: 'VALIDATION' }, 400);
      if (action === 'login' && (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 256)) return json({ error: 'Telefone ou senha incorretos.', code: 'INVALID_CREDENTIALS' }, 401);
      const url = env('SUPABASE_URL'), anon = env('SUPABASE_ANON_KEY'), service = env('SUPABASE_SERVICE_ROLE_KEY');
      if (!url || !anon || !service) {
        log('configuration');
        return json({ error: 'Serviço indisponível no momento.', code: 'UNAVAILABLE' }, 503);
      }
      const admin = createClient(url, service, options);
      const ip = (request.headers.get('x-forwarded-for') || 'desconhecido').split(',')[0].trim();
      // Keyed hashes resist offline enumeration of the small phone/IP space.
      const pepper = env('AUTH_RATE_LIMIT_SECRET') || service;
      const phoneHash = await hash('tel:' + phone, pepper), ipHash = await hash('ip:' + ip.slice(0, 128), pepper);
      const result = requireResult(await admin.rpc('consume_auth_attempt', {
        p_action: action, p_phone_hash: phoneHash, p_ip_hash: ipHash,
      }), 'rate-limit-atomic');
      if (result.data === false) return json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.', code: 'RATE_LIMIT' }, 429);
      if (result.data !== true) throw new Error('Invalid rate limit response');
      const { data: profile } = requireResult(await admin.from('profiles').select('email,status').eq('phone', phone).maybeSingle(), 'profile-read');
      const email = profile?.status === 'ativo' ? profile.email : null;
      if (action === 'recuperar') {
        // Identical public response even when email delivery fails; operators see the log.
        if (email) {
          try {
            // Redirect is server-configured; never forward an arbitrary request URL.
            const site = env('SITE_URL');
            let recoveryOptions;
            if (site && site !== '*') {
              const destination = new URL(site);
              if (!['https:', 'http:'].includes(destination.protocol)) throw new Error('Invalid site');
              destination.hash = '/redefinir-senha';
              recoveryOptions = { redirectTo: destination.toString() };
            }
            const result = await createClient(url, anon, options).auth.resetPasswordForEmail(email, recoveryOptions);
            if (result.error) log('password-recovery');
          } catch { log('password-recovery'); }
        }
        return json({ ok: true, message: 'Se houver uma conta com esse telefone, você receberá as instruções no e-mail cadastrado.' });
      }
      const invalidCredentials = () => json({ error: 'Telefone ou senha incorretos.', code: 'INVALID_CREDENTIALS' }, 401);
      if (!email || typeof body.password !== 'string' || !body.password) return invalidCredentials();
      const { data, error } = await createClient(url, anon, options).auth.signInWithPassword({ email, password: body.password });
      if (error) {
        if (error.status === 429) return json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.', code: 'RATE_LIMIT' }, 429);
        if (error.status >= 500 || error.name === 'AuthRetryableFetchError') throw new Error('Auth unavailable');
        if (error.code === 'email_not_confirmed') return json({ error: 'Confirme seu e-mail antes de entrar.', code: 'EMAIL_NOT_CONFIRMED' }, 403);
        return invalidCredentials();
      }
      if (!data?.session?.access_token || !data?.session?.refresh_token) throw new Error('Invalid auth response');
      // Successful requests keep their rate-limit footprint; a valid account cannot reset IP protection.
      return json({ session: { access_token: data.session.access_token, refresh_token: data.session.refresh_token } });
    } catch {
      log('request-failed');
      return json({ error: 'Serviço indisponível no momento. Tente novamente mais tarde.', code: 'UNAVAILABLE' }, 503);
    }
  };
}
