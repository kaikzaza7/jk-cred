# JK CRED

Aplicação estática para cadastro, autenticação e controle de solicitações de crédito.
Vanilla JavaScript, Supabase Auth/PostgreSQL/Edge Function e hospedagem Netlify.

## Executar localmente

Requer Node.js 20 ou superior.

```sh
npm ci
npm run dev
```

Abra http://127.0.0.1:4173. O servidor entrega somente `public/`, em loopback.
A prévia usa o projeto Supabase configurado em `public/config.js`; não é um banco
local. Configure ali apenas URL e chave pública `anon`/publishable, nunca segredo
ou `service_role`. Variáveis do painel Netlify não alteram automaticamente esse
arquivo estático. O `netlify.toml` publica a pasta `public`.

## Organização

- `public/app.js`: rotas, telas, eventos e carregamento, com controle de respostas atrasadas.
- `public/auth.js`: sessão, identidade verificada, papel admin por RPC, login/cadastro/recuperação.
- `public/repository.js`: consultas e gravações reais por API/RPC.
- `public/errors.js`: mensagens seguras, timeout, bloqueio de envio duplicado e recuperação de erros.
- `public/loan-rules.js`: cálculo em centavos com regras recebidas do servidor.
- `supabase/functions/acesso-cliente/`: login/recuperação por telefone, limite de tentativas e respostas HTTP.
- `supabase/migrations/`: fontes SQL para schema, RLS e operações atômicas.
- `tests/`: testes de módulos e PostgreSQL descartável com PGlite.

## Preparar o Supabase

Para um projeto novo, execute no SQL Editor, em ordem:

1. `001_schema.sql`
2. `003_loans.sql` (substitui a regra antiga de `002`)
3. `004_update_trigger_and_admin.sql`
4. `005_payments_and_control.sql`
5. `20261013103750_atomic_loan_operations.sql`

Em um projeto existente com 001/003/004/005 aplicadas, revise e aplique somente a
nova migration incremental. Ela preserva registros e adiciona checagem de
idempotência, transições de status, auditoria e validação atômica de pagamentos.
Os nomes antigos são scripts legados, não uma instalação nova validada pelo
histórico da CLI. A migration nova foi criada como fonte porque a CLI não estava
disponível. Não foi aplicada ao projeto remoto.

Crie administradores explicitamente pelo backend/SQL depois de cadastrar a conta
no Supabase Auth. O script não promove automaticamente um email. Uma conta admin
pode não ter perfil de cliente; seu login é por email. Cliente entra por telefone.
O papel sempre vem de `is_admin()`, nunca dos metadados editáveis do usuário.

Deploy da função, com Supabase CLI configurada:

```sh
supabase functions deploy acesso-cliente --project-ref SEU_PROJECT_REF
```

O endpoint de login/recuperação deve aceitar requests antes da autenticação,
conforme a configuração de verificação JWT do ambiente. Configure `SITE_URL` na
função para o endereço permitido da aplicação e permita esse endereço nos
redirects do Supabase Auth. O backend define a rota de recuperação; não encaminha
um redirect arbitrário vindo do navegador. A chave de serviço fica só no backend.

## Sessão e persistência

O SDK guarda a sessão em `sessionStorage`: sobrevive ao recarregamento da aba,
mas não se destina a permanecer após fechá-la. Os dados de empréstimos e pagamentos
ficam no PostgreSQL. O frontend não cria protocolo ou confirmação fictícios.

Solicitações, pagamentos e mudanças de status usam chave de envio. O navegador
preserva a chave pendente para repetir a mesma operação após uma resposta incerta;
a checagem definitiva acontece no servidor. Gravações não têm retry automático.

O dashboard exibe uma amostra recente de até 100 solicitações e informa esse
limite; ainda não há paginação completa ou relatório financeiro consolidado.
Formalização, transferência bancária e cobrança/WhatsApp permanecem pendentes.
Marcar um empréstimo como liberado é um registro de controle, não uma transferência.
Os textos de consentimento continuam em rascunho e precisam de documentos finais
antes do uso público.

## Verificar

```sh
npm test
npm run lint
npm run test:db
```

`npm test` inclui autenticação simulada, rotas, repositório, tratamento de falhas,
backend, cálculo, servidor estático e SQL. O teste SQL usa PostgreSQL/PGlite
isolado, com identidades e dados sintéticos, e reabre o armazenamento para
verificar persistência. Não escreve no Supabase remoto.

`npm run test:auth` é um teste legado de integração que depende de endpoint real;
não faz parte da suíte offline. Foi movido de `public/` para `scripts/test-auth.mjs` e exige `TEST_BASE`, `TEST_PHONE` e `TEST_PASSWORD` de uma conta descartável de homologação. Ele consome tentativas; `TEST_ANON_KEY` permite informar a chave pública do gateway e `TEST_RECOVERY=1` inclui recuperação por e-mail. Não o execute com contas de produção para teste.
Veja [ERROR-HANDLING.md](ERROR-HANDLING.md) para os padrões de novas funcionalidades.

## Segurança adicional e visual

O CSS foi extraído para `public/styles.css` e os componentes foram refinados com a identidade azul da JK CRED, contrastes dark/light e grids responsivos. O SDK agora é local, em `public/vendor/`.

Consulte [SECURITY.md](SECURITY.md) para as camadas implementadas, limites e sequência de deploy. A migração `20261013180000_auth_rate_limit.sql` deve entrar antes da Edge Function atualizada; configurar as origens permitidas antes de publicar.

## Teste de amarração local

`npm test` inclui `tests/request-flow.test.mjs`: repositório do aplicativo → HTTP local → SQL/RLS reais → leitura administrativa → aprovação → nova leitura do cliente → pagamento → repetição sem duplicação. Também verifica que outro cliente não lê o pedido e que cliente comum não aprova.

Para repetir no navegador, execute `npm run lab` e abra os links de cliente/administrador impressos no terminal. Esse laboratório escuta apenas em loopback, aplica as migrações em um PostgreSQL/PGlite temporário e usa identidades fictícias. O adaptador substitui o Supabase SDK/servidor de autenticação nesse teste; não valida Supabase Auth, PostgREST nem deploy remoto. O laboratório não envia dinheiro ou solicitações para o Supabase. Encerre com Ctrl+C; o banco de teste é descartado. Os arquivos de laboratório ficam em `scripts/`, fora da pasta publicada.

A lista de parcelas é construída a partir de `loan_settings.max_installments`, sem exibir opções desabilitadas além do limite. Leituras por renderização e atualização da estimativa não compartilham o bloqueio das escritas: uma resposta antiga não deixa a nova tela presa em carregamento. Estados da solicitação aparecem com nomes legíveis e badges.
