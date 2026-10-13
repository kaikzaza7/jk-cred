// Manual integration check: consumes attempts in a disposable staging account.
// Never part of npm test; never print credentials or session tokens.
const { TEST_BASE: base, TEST_PHONE: phone, TEST_PASSWORD: password, TEST_ANON_KEY: key } = process.env;
if (!base || !phone || !password) throw new Error('Configure TEST_BASE, TEST_PHONE e TEST_PASSWORD com uma conta descartável de homologação.');
const endpoint = new URL(base);
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)))) throw new Error('Endpoint de teste inválido.');
const post = async body => {
  const response = await fetch(endpoint, {
    method:'POST', signal:AbortSignal.timeout(15000),
    headers:{'Content-Type':'application/json', ...(key ? {apikey:key,Authorization:`Bearer ${key}`} : {})},
    body:JSON.stringify(body),
  });
  return { status:response.status, body:await response.json().catch(()=>({})) };
};
const assert = (condition,message) => { if(!condition) throw new Error(message); };
const invalid = await post({action:'login',phone:'1',password});
assert(invalid.status === 400,'Validação de telefone não retornou 400.');
console.log('Validação de telefone: OK');
let limited = false;
for(let i=0;i<6;i++) {
  const result = await post({action:'login',phone,password});
  assert([200,401,403,429].includes(result.status),`Falha no acesso de homologação: HTTP ${result.status}.`);
  if(result.status === 200) assert(result.body.session?.access_token && result.body.session?.refresh_token,'Sessão incompleta.');
  if(result.status === 429) { limited = true; break; }
}
assert(limited,'O limite por telefone não foi aplicado em até seis chamadas.');
console.log('Bloqueio de tentativas: OK');
if(process.env.TEST_RECOVERY === '1') {
  const recovery = await post({action:'recuperar',phone});
  assert([200,429].includes(recovery.status),'Recuperação indisponível.');
  if(recovery.status === 200) assert(recovery.body.ok === true,'Resposta de recuperação inválida.');
  console.log('Recuperação: OK (a função pode enviar e-mail ao cadastro de homologação).');
}
