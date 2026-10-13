# Tratamento de erros e integração

A aplicação usa um cliente Supabase compartilhado, módulos separados de sessão,
rotas e persistência e mensagens seguras. Falhas técnicas/SQL, senhas, payloads e
tokens não são exibidos nem registrados pelo módulo de erros.

## Novas consultas

```js
await JKErrors.run('loan-history', async () => {
  const loans = await JKRepository.listLoans({ own: true });
  renderHistory(loans);
}, { target: document.getElementById('history-error') });
```

## Novas gravações

```js
await JKErrors.run('loan-create', async () => {
  const loan = await JKRepository.createLoanRequest({
    amount, installments, firstDueDate, requestKey
  });
  showConfirmation(loan); // só após retorno confirmado do servidor
}, { form, target: form.querySelector('[role="status"]'), writing: true });
```

Use nomes estáticos de operação, nunca CPF, telefone, email ou corpo da requisição.
A chave UUID de envio deve permanecer a mesma para o mesmo payload quando a
resposta for incerta. Não gere outra chave para repetir uma gravação sem primeiro
reconciliar o resultado. O servidor verifica chave, payload, ator, transição,
parcela e saldo. O bloqueio no navegador só impede duplo clique nesta aba; os
RPCs e locks no banco fazem a proteção definitiva.

`JKErrors.run()` captura falhas, bloqueia botões do formulário e restaura seu
estado em `finally`. `normalize()` entende HTTP, códigos Postgres/PostgREST/Auth e
os códigos de negócio `JK:` conhecidos. Mensagens são inseridas como texto.
`requestJson(url, init, {writing:false})` trata POST de login/recuperação como
operações sem lançamento financeiro. Gravações não têm retry automático.
Requisições têm limite de 15 segundos, incluindo leitura do corpo. Ao perder
conexão durante uma gravação, o usuário recebe instrução para conferir o histórico.

Capture o formulário e a versão da rota antes de aguardar uma resposta para não
substituir uma nova tela com dados antigos. Não exiba saldo zero se o histórico de
pagamentos não foi consultado com sucesso. A simulação usa `JKLoan.calcLoan()` e
as regras de `loan_settings`; o valor final sempre vem do cálculo do servidor.

## Autenticação

A aplicação aguarda o bootstrap da sessão e verifica a identidade com `getUser()`.
O papel administrativo vem de `is_admin()`, e as consultas/mutações seguem RLS.
Callbacks Auth agendam o trabalho fora do callback para evitar bloqueio do SDK.
Contas sem perfil ou suspensas têm tela própria, sem loop de redirecionamento.
Admin sem perfil de cliente pode entrar por email. A sessão fica no SDK em
sessionStorage; nenhum perfil/CPF é duplicado em armazenamento do navegador.

## Backend

`acesso-cliente` retorna JSON, CORS, HTTP adequado, `request_id` e `no-store`.
Leituras ou gravações essenciais do limitador/perfil falhando interrompem login.
A limpeza auxiliar não esconde um login já concluído. Recuperação de senha tem
resposta pública idêntica para conta presente/ausente ou erro de envio e registra
falhas de entrega por operação/ID. Ela não comprova entrega de email.

O limitador de login existente usa contagem e inserção separadas, ainda sem
limitação atômica sob concorrência intensa. Não o trate como proteção antifraude
completa. Referências oficiais:
https://supabase.com/docs/guides/functions/error-handling
https://supabase.com/docs/reference/javascript/auth-onauthstatechange
https://supabase.com/docs/guides/auth/passwords

## Estado verificado

A suíte local usa APIs simuladas e PostgreSQL/PGlite descartável para validar SQL,
autorização, replay, saldo, transições e persistência ao reabrir o banco.
O navegador local foi usado para conferir páginas públicas e validação local.
A migração ainda precisa ser aplicada ao Supabase real. Login com conta real,
email recebido, runtime Deno e fluxo financeiro completo não foram validados em
produção. Formalização/cobrança e documentos finais de consentimento permanecem
fora desta base.
